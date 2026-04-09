// gmail-auth-start — Supabase Edge Function (Deno)
//
// Builds a Google OAuth authorization URL for connecting an additional Gmail
// account. The user's KeepTrack JWT is verified to extract user_id, and a
// label is accepted to distinguish multiple accounts.
//
// The frontend opens the returned URL in a popup; Google redirects back to
// gmail-auth-callback after the user grants consent.
//
// Required env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected)
//   GOOGLE_CLIENT_ID

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;

const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/gmail-auth-callback`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  // Handle CORS preflight.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    // Verify the user's JWT to get their user_id.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing auth header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use the service role client to verify the user's JWT.
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const jwt = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(jwt);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse the label from the request body.
    const body = await req.json().catch(() => ({}));
    const label = body.label?.trim() || "Default";

    // Encode state so the callback can associate the tokens with the right user.
    const state = btoa(JSON.stringify({ user_id: user.id, label }));

    // Build the Google OAuth URL.
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      access_type: "offline",
      prompt: "select_account consent", // Force account picker + consent for refresh token.
      state,
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return new Response(JSON.stringify({ url }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("gmail-auth-start error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
