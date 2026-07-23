// Vercel serverless endpoint: /api/slack/events
// Slack JA↔EN auto-translation bot (HTTP Events API version)
// JA messages → EN, EN messages → JA, posted as thread replies.

import crypto from "crypto";
import { waitUntil } from "@vercel/functions";

// We need the raw body for Slack signature verification
export const config = { api: { bodyParser: false } };

const JAPANESE_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

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

// Slack tokens like <@U123>, <#C123>, <https://…> are not valid XML,
// so they can't be sent to DeepL as-is with tag_handling: "xml".
// Instead, pull them out and replace with self-closing placeholder tags,
// then restore them after translation.
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

async function postToSlack(channel, threadTs, text) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API: ${data.error}`);
}

async function handleMessage(event) {
  // Ignore bots (incl. ourselves) and empty messages.
  // Subtypes are skipped (edits, joins, etc.) EXCEPT file_share —
  // a message with an attached image/file arrives as subtype "file_share"
  // and should still be translated if it has text.
  if (event.bot_id || !event.text) return;
  if (event.subtype && event.subtype !== "file_share") return;

  const text = event.text.trim();
  const stripped = text
    .replace(/<[^>]+>/g, "")
    .replace(/:[a-z0-9_+-]+:/gi, "")
    .trim();
  if (!stripped) return; // emoji/mention/link-only message

  const isJapanese = JAPANESE_REGEX.test(stripped);
  const targetLang = isJapanese ? "EN-US" : "JA";
  const flag = isJapanese ? "🇬🇧" : "🇯🇵";

  const { replaced, tokens } = extractSlackTokens(text);
  const translated = restoreSlackTokens(
    await translate(replaced, targetLang),
    tokens
  );

  await postToSlack(
    event.channel,
    event.thread_ts || event.ts,
    `${flag} ${translated}`
  );
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

  if (body.type === "event_callback" && body.event?.type === "message") {
    // Ack Slack immediately (3s deadline), translate in the background.
    // waitUntil keeps the function alive after the response is sent.
    waitUntil(
      handleMessage(body.event).catch((err) =>
        console.error("translation failed:", err)
      )
    );
  }

  return res.status(200).end();
}
