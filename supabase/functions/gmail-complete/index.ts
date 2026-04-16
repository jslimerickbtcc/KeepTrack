// gmail-complete — Supabase Edge Function (Deno)
//
// Two modes:
//   GET  — returns the user's Gmail labels (for the completion modal)
//   POST — removes "todo" label, optionally archives, optionally applies another label
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

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.access_token ?? null;
}

async function getLabels(
  accessToken: string,
): Promise<{ id: string; name: string; type: string }[]> {
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.labels ?? []).map((l: { id: string; name: string; type: string }) => ({
    id: l.id,
    name: l.name,
    type: l.type,
  }));
}

async function modifyThread(
  accessToken: string,
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<boolean> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    },
  );
  return res.ok;
}

async function verifyUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const jwt = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await supabase.auth.getUser(jwt);
  if (error || !user) return null;
  return user;
}

async function getAccessTokenForUser(userId: string): Promise<string | null> {
  const { data: integrations } = await admin
    .from("integrations")
    .select("refresh_token")
    .eq("user_id", userId)
    .eq("provider", "gmail");

  for (const integration of integrations ?? []) {
    const token = await refreshAccessToken(integration.refresh_token);
    if (token) return token;
  }
  return null;
}

// Check whether a given access token can see a specific thread.
// Used to route requests to the correct Gmail account when a user has
// multiple accounts connected.
async function canAccessThread(
  accessToken: string,
  threadId: string,
): Promise<boolean> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=minimal`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return res.ok;
}

// Find the access token for the Gmail account that owns the given thread.
async function getAccessTokenForThread(
  userId: string,
  threadId: string,
): Promise<string | null> {
  const { data: integrations } = await admin
    .from("integrations")
    .select("refresh_token")
    .eq("user_id", userId)
    .eq("provider", "gmail");

  for (const integration of integrations ?? []) {
    const token = await refreshAccessToken(integration.refresh_token);
    if (!token) continue;
    if (await canAccessThread(token, threadId)) return token;
  }
  return null;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ---------- GET: return user's Gmail labels ----------
  // Accepts ?thread_id=... to route to the correct Gmail account when the
  // user has multiple accounts connected.
  if (req.method === "GET") {
    const user = await verifyUser(req);
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    const threadId = url.searchParams.get("thread_id");

    const accessToken = threadId
      ? await getAccessTokenForThread(user.id, threadId)
      : await getAccessTokenForUser(user.id);

    if (!accessToken) return jsonResponse({ labels: [] });

    const allLabels = await getLabels(accessToken);
    // Return user-created labels only, sorted alphabetically.
    const userLabels = allLabels
      .filter((l) => l.type === "user")
      .sort((a, b) => a.name.localeCompare(b.name));

    return jsonResponse({ labels: userLabels });
  }

  // ---------- POST: complete a Gmail task ----------
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const user = await verifyUser(req);
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

    const body = await req.json();
    const threadId = body.thread_id;
    if (!threadId) return jsonResponse({ error: "Missing thread_id" }, 400);

    const archive = body.archive === true;
    const applyLabelId = body.apply_label_id ?? null; // Gmail label ID (belongs to the thread's account)

    // Find the specific account that owns this thread. Label IDs are
    // account-scoped, so we must operate on the right account.
    const accessToken = await getAccessTokenForThread(user.id, threadId);
    if (!accessToken) {
      return jsonResponse({ ok: false, reason: "Thread not found in any connected account" });
    }

    const allLabels = await getLabels(accessToken);
    const todoLabel = allLabels.find(
      (l) => l.name.toLowerCase() === "todo",
    );

    const removeLabelIds: string[] = [];
    if (todoLabel) removeLabelIds.push(todoLabel.id);
    if (archive) removeLabelIds.push("INBOX"); // Removing INBOX = archive.
    const addLabelIds: string[] = [];
    if (applyLabelId) addLabelIds.push(applyLabelId);

    const success = await modifyThread(accessToken, threadId, addLabelIds, removeLabelIds);

    return jsonResponse({ ok: true, success });
  } catch (err) {
    console.error("gmail-complete error:", err);
    return jsonResponse({ error: String(err) }, 500);
  }
});
