// Vercel serverless endpoint: /api/slack/events
// Slack on-demand translation bot (HTTP Events API version)
//
// Behavior: does NOT translate automatically. Translates only when someone
// reacts to a message with one of two configured emoji:
//   - REACTION_EN (default: "english")  → posts an English translation
//   - REACTION_JA (default: "japanese") → posts a Japanese translation
// Translation is posted as a thread reply under the reacted-to message.

import crypto from "crypto";
import { waitUntil } from "@vercel/functions";

// We need the raw body for Slack signature verification
export const config = { api: { bodyParser: false } };

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

// Emoji names (without colons) that trigger a translation.
// Defaults to custom workspace emoji :english: and :japanese: — these are
// NOT standard Slack emoji, so someone needs to upload them as custom emoji
// (Slack admin → Customize → Emoji) with exactly these names, or override
// via env vars to use standard emoji instead (e.g. "gb" / "jp").
const REACTION_EN = process.env.REACTION_EN || "english";
const REACTION_JA = process.env.REACTION_JA || "japanese";

const TRANSLATE_SYSTEM_PROMPT = `You are a translation engine embedded in a Slack bot for a Japanese/English game development team (Kodansha VR Lab). Translate the user's message between Japanese and English.

Rules:
- Output ONLY the translated text. No preamble, no explanation, no quotes around it.
- Preserve placeholder tokens exactly as they appear, e.g. <x id="0"/> — never translate, remove, or reorder their content, but do place them naturally in the translated sentence.
- Use natural, casual workplace tone — this is Slack chat, not a formal document. For Japanese output, prefer plain/casual form over formal keigo unless the source text is clearly formal.
- Preserve technical terms, product names, and code identifiers (e.g. Unity, PICO, NGO, variable names) unchanged.
- If the text is already entirely in the target language, or has no translatable content, output it unchanged.`;

async function translate(text, targetLang) {
  const targetName = targetLang === "JA" ? "Japanese" : "English";
  const res = await fetch(CLAUDE_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: TRANSLATE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Translate the following into ${targetName}:\n\n${text}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude returned no text block");
  return textBlock.text.trim();
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Verify the request really came from Slack (HMAC-SHA256)
function verifySlackSignature(req, rawBody) {
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;

  // Reject replays older than 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected =
    "v0=" +
    crypto
      .createHmac("sha256", process.env.SLACK_SIGNING_SECRET)
      .update(base)
      .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

// Slack tokens like <@U123>, <#C123>, <https://…> aren't meant to be
// translated. Extract them to placeholders before sending to Claude,
// then restore afterward.
function extractSlackTokens(text) {
  const tokens = [];
  const replaced = text.replace(
    /(<[@#!][^>]+>|<https?:[^>]+>|:[a-z0-9_+-]+:)/gi,
    (match) => {
      tokens.push(match);
      return `<x id="${tokens.length - 1}"/>`;
    }
  );
  return { replaced, tokens };
}

function restoreSlackTokens(text, tokens) {
  return text.replace(/<x id="(\d+)"\s*\/>/g, (_, i) => tokens[Number(i)] ?? "");
}

async function slackApi(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API ${method}: ${data.error}`);
  return data;
}

// Read methods (conversations.replies in particular) reject JSON POST
// bodies with invalid_arguments — JSON bodies are only officially supported
// for write methods. Read methods must be called as GET with query params.
async function slackApiGet(method, params) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}?${query}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API ${method}: ${data.error}`);
  return data;
}

// Fetch the exact message that was reacted to.
// Uses conversations.replies (not conversations.history) because history
// only returns channel-level messages — never thread replies — so reacting
// to a reply would fetch (and translate) the wrong message, usually the
// thread parent. conversations.replies with a reply's own ts returns that
// exact message; with a parent's ts it returns the parent first. Works for both.
async function getReactedMessage(channel, ts) {
  const data = await slackApiGet("conversations.replies", {
    channel,
    ts,
    limit: 1,
  });
  return data.messages?.[0] || null;
}

// Check the thread for a translation we already posted in this target
// language, so repeated/duplicate reactions (same or different users,
// toggling on/off while testing, etc.) don't spam a new reply every time.
//
// This is a best-effort convenience check, not a critical path: if it fails
// for any reason (API quirk, scope issue, rate limit), we fail OPEN — treat
// it as "not yet translated" and proceed, rather than blocking the actual
// translation a user is waiting on. A rare duplicate reply is a much smaller
// problem than the bot silently doing nothing.
// Dedup uses Slack message metadata: every translation we post carries
// { event_type: "translation_posted", event_payload: { source_ts, lang } }.
// Metadata is invisible to users but returned to apps, and lets us scope
// dedup to the exact source message — not the whole thread — so translating
// one reply doesn't block translating a different reply in the same thread.
//
// Best-effort check, not critical path: on any error we fail OPEN — treat as
// "not yet translated" and proceed. A rare duplicate reply is a much smaller
// problem than the bot silently doing nothing.
async function alreadyTranslated(channel, threadTs, sourceTs, targetLang) {
  try {
    const data = await slackApiGet("conversations.replies", {
      channel,
      ts: threadTs,
      include_all_metadata: true,
    });
    return (data.messages || []).some((m) => {
      const meta = m.metadata;
      return (
        meta?.event_type === "translation_posted" &&
        meta.event_payload?.source_ts === sourceTs &&
        meta.event_payload?.lang === targetLang
      );
    });
  } catch (err) {
    console.error("dedup check failed, proceeding without it:", err.message);
    return false;
  }
}

async function postToSlack(channel, threadTs, text, sourceTs, targetLang) {
  await slackApi("chat.postMessage", {
    channel,
    thread_ts: threadTs,
    text,
    metadata: {
      event_type: "translation_posted",
      event_payload: { source_ts: sourceTs, lang: targetLang },
    },
  });
}

async function handleReaction(event) {
  // Only care about reactions added to messages (not files, etc.)
  if (event.item?.type !== "message") return;

  const reaction = event.reaction;
  let targetLang;
  if (reaction === REACTION_EN) targetLang = "EN-US";
  else if (reaction === REACTION_JA) targetLang = "JA";
  else return; // not a translation-trigger emoji, ignore

  const { channel, ts } = event.item;
  const message = await getReactedMessage(channel, ts);
  if (!message || !message.text) return;
  if (message.bot_id) return; // don't translate other bot messages

  const threadTs = message.thread_ts || ts;
  if (await alreadyTranslated(channel, threadTs, ts, targetLang)) return;

  const text = message.text.trim();
  const stripped = text
    .replace(/<[^>]+>/g, "")
    .replace(/:[a-z0-9_+-]+:/gi, "")
    .trim();
  if (!stripped) return; // emoji/mention/link-only message, nothing to translate

  const { replaced, tokens } = extractSlackTokens(text);
  const translated = restoreSlackTokens(
    await translate(replaced, targetLang),
    tokens
  );

  await postToSlack(channel, threadTs, translated, ts, targetLang);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await readRawBody(req);

  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  const body = JSON.parse(rawBody);

  // One-time URL verification when you set the Request URL in Slack
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Slack retries if we're slow to ack — skip retries to avoid duplicate translations
  if (req.headers["x-slack-retry-num"]) {
    res.setHeader("x-slack-no-retry", "1");
    return res.status(200).end();
  }

  if (body.type === "event_callback" && body.event?.type === "reaction_added") {
    // Ack Slack immediately (3s deadline), translate in the background.
    waitUntil(
      handleReaction(body.event).catch((err) =>
        console.error("translation failed:", err)
      )
    );
  }

  return res.status(200).end();
}
