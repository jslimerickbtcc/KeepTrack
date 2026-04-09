// slack-events — Supabase Edge Function (Deno)
//
// HTTP endpoint registered as a Slack Event Subscription URL.
// Handles:
//   - url_verification (Slack challenge handshake)
//   - reaction_added events: when someone reacts with :todo:, creates a task
//
// Required env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   SLACK_SIGNING_SECRET

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SLACK_SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET")!;
const TRIGGER_EMOJI = "todo";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// ---------- Slack request verification ----------

async function verifySlackRequest(
  req: Request,
  body: string,
): Promise<boolean> {
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes to prevent replay attacks.
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(sigBasestring),
  );
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expected = `v0=${hex}`;

  return expected === signature;
}

// ---------- Slack API helpers ----------

async function getMessagePermalink(
  botToken: string,
  channel: string,
  messageTs: string,
): Promise<string | null> {
  const url = new URL("https://slack.com/api/chat.getPermalink");
  url.searchParams.set("channel", channel);
  url.searchParams.set("message_ts", messageTs);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.ok ? data.permalink : null;
}

async function getMessageText(
  botToken: string,
  channel: string,
  messageTs: string,
): Promise<string> {
  const url = new URL("https://slack.com/api/conversations.history");
  url.searchParams.set("channel", channel);
  url.searchParams.set("latest", messageTs);
  url.searchParams.set("inclusive", "true");
  url.searchParams.set("limit", "1");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) return "Slack task";
  const data = await res.json();
  if (!data.ok || !data.messages?.length) return "Slack task";

  const text = data.messages[0].text ?? "";
  // Truncate to a reasonable task title length.
  return text.length > 200 ? text.slice(0, 200) + "..." : text || "Slack task";
}

// ---------- Main handler ----------

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await req.text();

  // Verify Slack signature.
  const valid = await verifySlackRequest(req, body);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const payload = JSON.parse(body);

  // Handle Slack URL verification challenge.
  if (payload.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // We only care about event callbacks.
  if (payload.type !== "event_callback") {
    return new Response("ok", { status: 200 });
  }

  const event = payload.event;

  // Only process reaction_added events with the trigger emoji.
  if (event?.type !== "reaction_added" || event.reaction !== TRIGGER_EMOJI) {
    return new Response("ok", { status: 200 });
  }

  const slackUserId = event.user; // Person who reacted.
  const channel = event.item?.channel;
  const messageTs = event.item?.ts;
  const teamId = payload.team_id;

  if (!channel || !messageTs || !teamId) {
    return new Response("ok", { status: 200 });
  }

  try {
    // Look up the KeepTrack user via the integrations table.
    // A user may have multiple Slack integrations (different workspaces).
    const { data: integrations } = await admin
      .from("integrations")
      .select("id, user_id, access_token, label, metadata")
      .eq("provider", "slack");

    // Find the integration whose metadata matches this Slack workspace + user.
    const match = integrations?.find((i: { metadata: Record<string, string> }) => {
      return (
        i.metadata?.team_id === teamId &&
        i.metadata?.slack_user_id === slackUserId
      );
    });

    if (!match) {
      console.warn(
        `No KeepTrack user found for Slack user ${slackUserId} in team ${teamId}`,
      );
      return new Response("ok", { status: 200 });
    }

    const userId = match.user_id;
    const botToken = match.access_token;

    // Deduplicate: check if this message was already imported.
    const dedupeKey = `${channel}:${messageTs}`;
    const { data: existing } = await admin
      .from("tasks")
      .select("id")
      .eq("user_id", userId)
      .eq("slack_message_ts", dedupeKey)
      .maybeSingle();

    if (existing) {
      return new Response("ok", { status: 200 }); // Already imported.
    }

    // Fetch message text and permalink.
    const [title, permalink] = await Promise.all([
      getMessageText(botToken, channel, messageTs),
      getMessagePermalink(botToken, channel, messageTs),
    ]);

    const { error: insertErr } = await admin.from("tasks").insert({
      user_id: userId,
      title,
      slack_message_ts: dedupeKey,
      source_url: permalink,
      priority: "med",
    });

    if (insertErr) {
      // 23505 = unique constraint violation (already imported, race condition).
      if (insertErr.code !== "23505") {
        console.error("Task insert failed:", insertErr.message);
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("slack-events error:", err);
    return new Response("ok", { status: 200 }); // Always 200 to Slack.
  }
});
