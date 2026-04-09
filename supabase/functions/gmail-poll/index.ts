// gmail-poll — Supabase Edge Function (Deno)
//
// Cron-triggered: iterates users with a Gmail integration, polls for messages
// with the "todo" label, and inserts one task per new message (deduped by
// gmail_message_id).
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

// ---------- Google OAuth helpers ----------

interface TokenRow {
  id: string;
  user_id: string;
  access_token: string;
  refresh_token: string;
  label: string;
  metadata: Record<string, unknown>;
}

async function refreshAccessToken(
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number } | null> {
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
  if (!res.ok) {
    console.error("Token refresh failed:", await res.text());
    return null;
  }
  return res.json();
}

// ---------- Gmail helpers ----------

async function getLabelId(
  accessToken: string,
  logs: string[],
): Promise<string | null> {
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    logs.push(`  Labels API error: ${res.status} ${await res.text()}`);
    return null;
  }
  const data = await res.json();
  const userLabels = (data.labels ?? [])
    .filter((l: { type: string }) => l.type === "user")
    .map((l: { name: string; id: string }) => `${l.name} (${l.id})`);
  logs.push(`  User labels: ${userLabels.join(", ") || "none"}`);
  const label = data.labels?.find(
    (l: { name: string }) => l.name.toLowerCase() === "todo",
  );
  return label?.id ?? null;
}

interface GmailMessage {
  id: string;
  snippet: string;
  payload?: {
    headers?: { name: string; value: string }[];
  };
}

async function listThreads(
  accessToken: string,
  labelId: string,
  maxResults = 20,
): Promise<{ id: string }[]> {
  const url = new URL(
    "https://gmail.googleapis.com/gmail/v1/users/me/threads",
  );
  url.searchParams.set("labelIds", labelId);
  url.searchParams.set("maxResults", String(maxResults));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.threads ?? [];
}

async function getThread(
  accessToken: string,
  threadId: string,
): Promise<GmailMessage | null> {
  // Fetch the thread — the first message has the subject.
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&metadataHeaders=Subject`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const firstMsg = data.messages?.[0];
  if (!firstMsg) return null;
  return { id: data.id, snippet: firstMsg.snippet, payload: firstMsg.payload };
}

// ---------- Main handler ----------

serve(async (_req: Request) => {
  try {
    // Fetch all Gmail integrations (a user may have multiple accounts).
    const { data: integrations, error: intErr } = await admin
      .from("integrations")
      .select("id, user_id, access_token, refresh_token, label, metadata")
      .eq("provider", "gmail");

    if (intErr) throw intErr;
    if (!integrations?.length) {
      return new Response(JSON.stringify({ ok: true, processed: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    let totalInserted = 0;

    const logs: string[] = [];

    for (const row of integrations as TokenRow[]) {
      try {
        logs.push(`Processing: ${row.label} (user ${row.user_id})`);

        // Refresh the access token each run.
        const refreshed = await refreshAccessToken(row.refresh_token);
        if (!refreshed) {
          logs.push(`  SKIP: token refresh failed`);
          continue;
        }
        const accessToken = refreshed.access_token;

        // Persist the new access token.
        await admin
          .from("integrations")
          .update({ access_token: accessToken })
          .eq("id", row.id);

        // Find the "todo" label.
        const labelId = await getLabelId(accessToken, logs);
        if (!labelId) {
          logs.push(`  SKIP: no "todo" label found`);
          continue;
        }
        logs.push(`  Found "todo" label: ${labelId}`);

        // List recent threads with that label (one per conversation).
        const threadStubs = await listThreads(accessToken, labelId);
        logs.push(`  Threads found: ${threadStubs.length}`);

        for (const stub of threadStubs) {
          // Deduplicate by thread ID (stored in gmail_message_id).
          const { data: existing } = await admin
            .from("tasks")
            .select("id")
            .eq("user_id", row.user_id)
            .eq("gmail_message_id", stub.id)
            .maybeSingle();

          if (existing) {
            logs.push(`  Skipping thread ${stub.id}: already imported`);
            continue;
          }

          // Fetch the thread to get the subject from the first message.
          const thread = await getThread(accessToken, stub.id);
          const subject =
            thread?.payload?.headers?.find((h) => h.name === "Subject")?.value ??
            thread?.snippet ??
            "Gmail task";

          logs.push(`  Importing: "${subject}" (thread ${stub.id})`);
          // Use #all instead of #inbox so the link works even if the message
          // has been archived. This URL opens in the Gmail app on mobile.
          const sourceUrl = `https://mail.google.com/mail/u/0/#all/${stub.id}`;

          const { error: insertErr } = await admin.from("tasks").insert({
            user_id: row.user_id,
            title: subject,
            gmail_message_id: stub.id,
            source_url: sourceUrl,
            notes: `📧 ${sourceUrl}`,
            priority: "med",
          });

          if (insertErr) {
            // Unique constraint means it was already imported (race condition).
            if (insertErr.code === "23505") continue;
            console.error(
              `Insert failed for user ${row.user_id}:`,
              insertErr.message,
            );
          } else {
            totalInserted++;
          }
        }
      } catch (userErr) {
        console.error(`Error processing user ${row.user_id}:`, userErr);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, inserted: totalInserted, logs }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("gmail-poll error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
