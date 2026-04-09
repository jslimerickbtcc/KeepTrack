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
): Promise<string | null> {
  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  const data = await res.json();
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

async function listMessages(
  accessToken: string,
  labelId: string,
  maxResults = 20,
): Promise<{ id: string }[]> {
  const url = new URL(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  );
  url.searchParams.set("labelIds", labelId);
  url.searchParams.set("maxResults", String(maxResults));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.messages ?? [];
}

async function getMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessage | null> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) return null;
  return res.json();
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

    for (const row of integrations as TokenRow[]) {
      try {
        // Refresh the access token each run.
        const refreshed = await refreshAccessToken(row.refresh_token);
        if (!refreshed) {
          console.warn(`Skipping ${row.label} (user ${row.user_id}): token refresh failed`);
          continue;
        }
        const accessToken = refreshed.access_token;

        // Persist the new access token.
        await admin
          .from("integrations")
          .update({ access_token: accessToken })
          .eq("id", row.id);

        // Find the "todo" label.
        const labelId = await getLabelId(accessToken);
        if (!labelId) {
          console.warn(`Skipping ${row.label} (user ${row.user_id}): no "todo" label found`);
          continue;
        }

        // List recent messages with that label.
        const messageStubs = await listMessages(accessToken, labelId);

        for (const stub of messageStubs) {
          // Check if we already imported this message.
          const { data: existing } = await admin
            .from("tasks")
            .select("id")
            .eq("user_id", row.user_id)
            .eq("gmail_message_id", stub.id)
            .maybeSingle();

          if (existing) continue; // Already imported.

          // Fetch the message details for the subject line.
          const msg = await getMessage(accessToken, stub.id);
          const subject =
            msg?.payload?.headers?.find((h) => h.name === "Subject")?.value ??
            msg?.snippet ??
            "Gmail task";

          const sourceUrl = `https://mail.google.com/mail/u/0/#inbox/${stub.id}`;

          const { error: insertErr } = await admin.from("tasks").insert({
            user_id: row.user_id,
            title: subject,
            gmail_message_id: stub.id,
            source_url: sourceUrl,
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
      JSON.stringify({ ok: true, inserted: totalInserted }),
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
