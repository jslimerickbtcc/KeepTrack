// gmail-auth-callback — Supabase Edge Function (Deno)
//
// Google redirects here after the user grants Gmail access in the popup.
// Exchanges the authorization code for tokens, stores them in the
// integrations table, and returns a self-closing HTML page that notifies
// the opener window via postMessage.
//
// Required env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gmail-auth-callback`;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// The frontend site URL — the callback redirects here after success/failure.
const SITE_URL = "https://jslimerickbtcc.github.io/KeepTrack";

function successRedirect(): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: `${SITE_URL}/gmail-connected.html` },
  });
}

function errorRedirect(message: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${SITE_URL}/gmail-connected.html?error=${encodeURIComponent(message)}`,
    },
  });
}

serve(async (req: Request) => {
  // Google redirects here with ?code=...&state=...
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return errorRedirect(`Google returned an error: ${error}`);
  }

  if (!code || !stateRaw) {
    return errorRedirect("Missing authorization code or state.");
  }

  let state: { user_id: string; label: string };
  try {
    state = JSON.parse(atob(stateRaw));
  } catch {
    return errorRedirect("Invalid state parameter.");
  }

  if (!state.user_id) {
    return errorRedirect("Missing user_id in state.");
  }

  try {
    // Exchange the authorization code for tokens.
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error("Token exchange failed:", errText);
      return errorRedirect("Token exchange failed. Please try again.");
    }

    const tokens = await tokenRes.json();

    // Fetch the Gmail profile to get the email for display.
    let gmailEmail = "";
    try {
      const profileRes = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      );
      if (profileRes.ok) {
        const profile = await profileRes.json();
        gmailEmail = profile.emailAddress ?? "";
      }
    } catch {
      // Non-critical — continue without the email.
    }

    const label = state.label || "Default";

    // Insert into integrations (service role bypasses RLS).
    const { error: insertErr } = await admin.from("integrations").insert({
      user_id: state.user_id,
      provider: "gmail",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      scope: "gmail.readonly",
      label,
      metadata: { email: gmailEmail },
    });

    if (insertErr) {
      if (insertErr.code === "23505") {
        return errorRedirect(`A Gmail connection labeled "${label}" already exists.`);
      }
      console.error("Insert failed:", insertErr);
      return errorRedirect("Database error. Please try again.");
    }

    return successRedirect();
  } catch (err) {
    console.error("gmail-auth-callback error:", err);
    return errorRedirect("Unexpected error. Please try again.");
  }
});
