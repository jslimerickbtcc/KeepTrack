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

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function successPage(label: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>KeepTrack — Gmail Connected</title></head>
<body style="font-family:system-ui;text-align:center;padding:40px;background:#0b1220;color:#e5e7eb">
  <h2>✅ Gmail connected</h2>
  <p>"${label}" account linked. This window will close automatically.</p>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: "gmail-connected", ok: true }, "*");
    }
    setTimeout(() => window.close(), 1500);
  </script>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html>
<head><title>KeepTrack — Error</title></head>
<body style="font-family:system-ui;text-align:center;padding:40px;background:#0b1220;color:#e5e7eb">
  <h2>❌ Connection failed</h2>
  <p>${message}</p>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: "gmail-connected", ok: false, error: "${message}" }, "*");
    }
    setTimeout(() => window.close(), 3000);
  </script>
</body>
</html>`;
}

serve(async (req: Request) => {
  // Google redirects here with ?code=...&state=...
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return htmlResponse(errorPage(`Google returned an error: ${error}`));
  }

  if (!code || !stateRaw) {
    return htmlResponse(errorPage("Missing authorization code or state."), 400);
  }

  let state: { user_id: string; label: string };
  try {
    state = JSON.parse(atob(stateRaw));
  } catch {
    return htmlResponse(errorPage("Invalid state parameter."), 400);
  }

  if (!state.user_id) {
    return htmlResponse(errorPage("Missing user_id in state."), 400);
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
      return htmlResponse(errorPage("Token exchange failed. Please try again."));
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
        return htmlResponse(
          errorPage(`A Gmail connection labeled "${label}" already exists.`),
        );
      }
      console.error("Insert failed:", insertErr);
      return htmlResponse(errorPage("Database error. Please try again."));
    }

    return htmlResponse(successPage(label));
  } catch (err) {
    console.error("gmail-auth-callback error:", err);
    return htmlResponse(errorPage("Unexpected error. Please try again."));
  }
});
