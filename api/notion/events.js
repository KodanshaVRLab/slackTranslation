// Vercel serverless endpoint: /api/notion/events
// Notion JA↔EN auto-translation.
// Listens for page.content_updated webhooks, fetches the edited blocks,
// and inserts a translation as an indented gray child block under each one.

import crypto from "crypto";
import { waitUntil } from "@vercel/functions";

export const config = { api: { bodyParser: false } };

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const JAPANESE_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;
const FLAG_PREFIXES = ["🇬🇧", "🇯🇵"];
const DEEPL_URL =
  process.env.DEEPL_URL || "https://api-free.deepl.com/v2/translate";

// Block types whose rich_text we translate
const TEXT_BLOCK_TYPES = new Set([
  "paragraph",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "quote",
  "callout",
  "toggle",
]);

// Cached across invocations while the lambda is warm
let cachedBotId = null;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// Notion signs payloads with the verification_token from subscription setup:
// X-Notion-Signature: sha256=HMAC_SHA256(verification_token, rawBody)
function verifyNotionSignature(req, rawBody) {
  const token = process.env.NOTION_VERIFICATION_TOKEN;
  if (!token) return true; // not set yet (initial verification phase)
  const signature = req.headers["x-notion-signature"];
  if (!signature) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", token).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

async function notionFetch(path, options = {}) {
  const res = await fetch(`${NOTION}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getBotId() {
  if (!cachedBotId) {
    const me = await notionFetch("/users/me");
    cachedBotId = me.id;
  }
  return cachedBotId;
}

async function translate(text, targetLang) {
  const res = await fetch(DEEPL_URL, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: [text],
      target_lang: targetLang,
      formality: targetLang === "JA" ? "less" : "default",
    }),
  });
  if (!res.ok) throw new Error(`DeepL ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.translations[0].text;
}

async function handleBlock(blockId, botId) {
  const block = await notionFetch(`/blocks/${blockId}`);

  if (!TEXT_BLOCK_TYPES.has(block.type)) return;
  if (block.last_edited_by?.id === botId) return; // our own edit → no loop

  const richText = block[block.type]?.rich_text || [];

  // Only translate actual typed text — mentions (@person) and dates (@Now)
  // don't count. This makes the timestamp button block (@Me : @Now) a no-op.
  const typedText = richText
    .filter((rt) => rt.type === "text")
    .map((rt) => rt.plain_text)
    .join("")
    .trim();
  if (!typedText || !/[a-zA-Z\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(typedText))
    return;

  const fullText = richText.map((rt) => rt.plain_text).join("").trim();
  if (FLAG_PREFIXES.some((f) => fullText.startsWith(f))) return; // is a translation

  const isJapanese = JAPANESE_REGEX.test(typedText);
  const targetLang = isJapanese ? "EN-US" : "JA";
  const flag = isJapanese ? "🇬🇧" : "🇯🇵";

  const translated = await translate(fullText, targetLang);
  const translationText = `${flag} ${translated}`;

  const translationBlock = {
    paragraph: {
      rich_text: [{ type: "text", text: { content: translationText } }],
      color: "gray",
    },
  };

  // If the block already has a translation child, update it instead of
  // stacking duplicates (aggregated events can re-fire for the same block,
  // and people edit their messages).
  if (block.has_children) {
    const children = await notionFetch(
      `/blocks/${blockId}/children?page_size=5`
    );
    const existing = children.results.find((c) => {
      const t = c[c.type]?.rich_text?.map((rt) => rt.plain_text).join("") || "";
      return FLAG_PREFIXES.some((f) => t.startsWith(f));
    });
    if (existing) {
      await notionFetch(`/blocks/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify(translationBlock),
      });
      return;
    }
  }

  await notionFetch(`/blocks/${blockId}/children`, {
    method: "PATCH",
    body: JSON.stringify({ children: [translationBlock] }),
  });
}

async function handleEvent(body) {
  const botId = await getBotId();
  const updatedBlocks = body.data?.updated_blocks || [];
  for (const { id } of updatedBlocks) {
    try {
      await handleBlock(id, botId);
      // Notion rate limit is ~3 req/s — pace ourselves between blocks
      await new Promise((r) => setTimeout(r, 350));
    } catch (err) {
      console.error(`block ${id} failed:`, err.message);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await readRawBody(req);
  const body = JSON.parse(rawBody);

  // One-time subscription verification: Notion POSTs a verification_token.
  // Read it from Vercel Runtime Logs, then paste it into Notion's Verify form
  // AND set it as NOTION_VERIFICATION_TOKEN in Vercel env vars.
  if (body.verification_token) {
    console.log("NOTION VERIFICATION TOKEN:", body.verification_token);
    return res.status(200).end();
  }

  if (!verifyNotionSignature(req, rawBody)) {
    return res.status(401).json({ error: "invalid signature" });
  }

  if (body.type === "page.content_updated") {
    waitUntil(
      handleEvent(body).catch((err) => console.error("notion failed:", err))
    );
  }

  return res.status(200).end();
}
