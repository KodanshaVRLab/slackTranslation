// Vercel serverless endpoint: /api/notion/events
// Notion JA↔EN on-demand translation (works like the Slack bot: nothing is
// translated automatically, a person asks for it).
//
// Notion's API has no reaction events, so the trigger is a comment whose
// whole text is a flag (or keyword):
//   🇯🇵 / ja / jp / japanese / 日本語  → Japanese
//   🇬🇧 / 🇺🇸 / en / english / 英語     → English
//
// Where the trigger comment is posted decides what gets translated:
//
//   • New page comment (first comment of a discussion) → the PAGE.
//     The page body is wrapped in a bilingual tab block at the top:
//       <tabs> 🇬🇧 English | 🇯🇵 日本語 </tabs>
//     The original stays in the tab of its own language, the translation
//     fills the other. If the page already has these tabs, the requested
//     language's tab is re-translated from the other tab (edit one side,
//     then comment the flag of the side you want refreshed).
//     Child pages / databases stay below the tabs, untouched.
//
//   • Reply inside an existing comment thread → the COMMENT just before it.
//     Comments can only hold rich text (no tabs/toggles), so the translation
//     is posted as a reply prefixed with the flag.
//
// Notion setup: integration capabilities Read content, Update content,
// Read comments, Insert comments; webhook subscription with `comment.created`
// (page.content_updated is no longer used and can be unsubscribed).

import crypto from "crypto";
import { waitUntil } from "@vercel/functions";

export const config = { api: { bodyParser: false } };

const NOTION = "https://api.notion.com/v1";
// 2026-03-11 is required for the page markdown endpoints.
const NOTION_VERSION = "2026-03-11";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

const FLAG = { EN: "🇬🇧", JA: "🇯🇵" };
const LABEL = { EN: "English", JA: "日本語" };

function triggerList(envValue, defaults) {
  const list = envValue
    ? envValue.split(",").map((s) => s.trim()).filter(Boolean)
    : defaults;
  return new Set(list.map((s) => s.toLowerCase()));
}
const TRIGGERS_EN = triggerList(process.env.NOTION_TRIGGERS_EN, [
  "🇬🇧", "🇺🇸", "en", "english", "英語", ":gb:", ":us:", ":english:",
]);
const TRIGGERS_JA = triggerList(process.env.NOTION_TRIGGERS_JA, [
  "🇯🇵", "ja", "jp", "japanese", "日本語", ":jp:", ":japanese:",
]);

const COMMENT_SYSTEM_PROMPT = `You are a translation engine embedded in a Notion workspace for a Japanese/English game development team (Kodansha VR Lab). Translate comment text between Japanese and English.

Rules:
- Output ONLY the translated text. No preamble, no explanation, no quotes around it.
- Preserve placeholder tokens exactly as they appear, e.g. <x id="0"/> — never translate, remove, or reorder their content, but do place them naturally in the translated sentence.
- Use natural, professional-but-casual workplace tone. For Japanese output, prefer plain/casual form over formal keigo unless the source is clearly formal.
- Preserve technical terms, product names, and code identifiers (e.g. Unity, PICO, NGO, Timeline, variable names) unchanged.
- If the text is already entirely in the target language, or has no translatable content, output it unchanged.`;

const PAGE_SYSTEM_PROMPT = `You are a translation engine embedded in a Notion workspace for a Japanese/English game development team (Kodansha VR Lab). You translate whole Notion pages written in Notion-flavored Markdown between Japanese and English.

Rules:
- Output ONLY the translated Markdown. No preamble, no explanation, no surrounding code fence.
- Keep the document structure byte-for-byte where it is not prose: every Markdown marker (#, -, 1., |, >, **, \`, [ ](...)), every blank line and line break, and every XML-like tag (<callout>, <toggle>, <tabs>, <tab>, <columns>, <column>, <table>, <tr>, <td>, <th>, <span>, <mention>, <date>, <image>, <page>, <database>, <todo>, <equation>, etc.) with all its attributes unchanged.
- Translate only human-readable text: paragraphs, headings, list items, table cells, callout/toggle text, image captions, link text.
- Never translate: code blocks, inline code, URLs, attribute values, equations, <mention> labels, <page>/<database> titles.
- Preserve technical terms, product names, and code identifiers (e.g. Unity, PICO, NGO, Timeline, variable names) unchanged.
- For Japanese output use polite form (です・ます). For English output use clear professional English.
- Text that is already in the target language stays as it is.`;

// Cached across invocations while the lambda is warm
let cachedBotId = null;

// ─── plumbing ────────────────────────────────────────────────────────────────

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

async function translate(text, targetLang, systemPrompt, maxTokens) {
  const res = await fetch(CLAUDE_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      // Japanese is token-dense (~1-2 tokens per character). Only generated
      // tokens are billed, so a high cap costs nothing on short inputs.
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Translate the following into ${targetLang === "JA" ? "Japanese" : "English"}:\n\n${text}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude returned no text block");
  return { text: textBlock.text.trim(), truncated: data.stop_reason === "max_tokens" };
}

// ─── language detection ──────────────────────────────────────────────────────

function detectLang(text) {
  const plain = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\(https?:[^)]*\)/g, "");
  const ja = (plain.match(/[぀-ゟ゠-ヿ一-鿿]/g) || []).length;
  const latin = (plain.match(/[A-Za-z]/g) || []).length;
  // One Japanese character carries roughly as much as a 4-letter word, and
  // Japanese notes are full of English technical terms — weigh accordingly.
  return ja * 4 >= latin ? "JA" : "EN";
}

function parseTrigger(text) {
  const t = text.trim().toLowerCase();
  if (TRIGGERS_JA.has(t)) return "JA";
  if (TRIGGERS_EN.has(t)) return "EN";
  return null;
}

// ─── comments ────────────────────────────────────────────────────────────────

const plainText = (richText = []) => richText.map((rt) => rt.plain_text).join("");

async function listDiscussion(parentId, discussionId) {
  const all = [];
  let cursor;
  do {
    const q = new URLSearchParams({ block_id: parentId, page_size: "100" });
    if (cursor) q.set("start_cursor", cursor);
    const data = await notionFetch(`/comments?${q}`);
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return all
    .filter((c) => c.discussion_id === discussionId)
    .sort((a, b) => a.created_time.localeCompare(b.created_time));
}

async function reply(discussionId, richText) {
  await notionFetch("/comments", {
    method: "POST",
    body: JSON.stringify({ discussion_id: discussionId, rich_text: richText }),
  });
}

const textRT = (content) => ({ type: "text", text: { content } });

// Mentions, equations and links must survive translation untouched: swap them
// for <x id="n"/> placeholders, translate, then put the originals back.
function richTextToTagged(richText) {
  const tokens = [];
  const text = richText
    .map((rt) => {
      if (rt.type === "text" && !rt.text.link) return rt.text.content;
      tokens.push(rt);
      return `<x id="${tokens.length - 1}"/>`;
    })
    .join("");
  return { text, tokens };
}

// Response-shaped rich text → request-shaped rich text
function toRequestRT(rt) {
  const annotations = rt.annotations;
  if (rt.type === "text") {
    return { type: "text", text: { content: rt.text.content, link: rt.text.link }, annotations };
  }
  if (rt.type === "equation") {
    return { type: "equation", equation: { expression: rt.equation.expression }, annotations };
  }
  if (rt.type === "mention") {
    const m = rt.mention;
    if (["user", "page", "database"].includes(m.type) && m[m.type]?.id) {
      return { type: "mention", mention: { [m.type]: { id: m[m.type].id } }, annotations };
    }
    if (m.type === "date") return { type: "mention", mention: { date: m.date }, annotations };
  }
  // Anything else (link previews, template mentions…) → plain text, keep the link
  return {
    type: "text",
    text: { content: rt.plain_text, link: rt.href ? { url: rt.href } : null },
    annotations,
  };
}

function taggedToRichText(text, tokens) {
  const out = [];
  const parts = text.split(/<x id="(\d+)"\s*\/>/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const tok = tokens[Number(part)];
      if (tok) out.push(toRequestRT(tok));
      return;
    }
    // Notion caps each text object at 2000 characters
    for (let p = 0; p < part.length; p += 2000) out.push(textRT(part.slice(p, p + 2000)));
  });
  return out.slice(0, 100); // and a comment at 100 rich text objects
}

async function translateComment(thread, triggerIdx, lang, botId) {
  const isTrigger = (c) => parseTrigger(plainText(c.rich_text)) !== null;
  let targetIdx = -1;
  for (let i = triggerIdx - 1; i >= 0; i--) {
    const c = thread[i];
    if (c.created_by?.id !== botId && !isTrigger(c)) { targetIdx = i; break; }
  }
  if (targetIdx === -1) return; // nothing a person wrote before the trigger

  // Already translated into this language? (bot reply with this flag after it)
  const done = thread
    .slice(targetIdx + 1, triggerIdx)
    .some((c) => c.created_by?.id === botId && plainText(c.rich_text).startsWith(FLAG[lang]));
  if (done) return;

  const source = thread[targetIdx];
  if (!/[a-zA-Z぀-ゟ゠-ヿ一-鿿]/.test(plainText(source.rich_text))) return;

  const { text, tokens } = richTextToTagged(source.rich_text);
  const result = await translate(text, lang, COMMENT_SYSTEM_PROMPT, 8192);
  let translated = result.text;
  if (result.truncated) {
    translated += "\n\n(翻訳が長すぎるため途中で切れています / translation truncated — comment too long)";
  }

  const rich = [textRT(`${FLAG[lang]} `), ...taggedToRichText(translated, tokens)].slice(0, 100);
  try {
    await reply(source.discussion_id, rich);
  } catch (err) {
    // Fall back to plain text if a mention couldn't be re-created
    console.warn("rich reply failed, retrying as plain text:", err.message);
    const plain = translated.replace(/<x id="(\d+)"\s*\/>/g, (_, i) => tokens[Number(i)]?.plain_text ?? "");
    await reply(source.discussion_id, taggedToRichText(`${FLAG[lang]} ${plain}`, []));
  }
}

// ─── pages ───────────────────────────────────────────────────────────────────

async function resolvePageId(parent) {
  if (parent.type === "page_id") return parent.page_id;
  let blockId = parent.block_id;
  for (let depth = 0; depth < 25 && blockId; depth++) {
    const block = await notionFetch(`/blocks/${blockId}`);
    if (block.parent.type === "page_id") return block.parent.page_id;
    if (block.parent.type !== "block_id") break;
    blockId = block.parent.block_id;
  }
  throw new Error("could not find the page this comment belongs to");
}

// Index just past the tag that closes the <name …> opened at openIdx.
// Counts nesting; `<tab` never matches `<tabs` because of the lookahead.
function findClose(md, openIdx, name) {
  const re = new RegExp(`<${name}(?=[\\s>/])[^>]*?(/?)>|</${name}>`, "g");
  re.lastIndex = openIdx;
  let depth = 0;
  let m;
  while ((m = re.exec(md))) {
    if (m[0].startsWith("</")) depth--;
    else if (m[1] !== "/") depth++;
    if (depth === 0) return re.lastIndex;
  }
  return -1;
}

// Finds the bilingual tab block this bot creates.
// Returns { before, after, EN, JA } (EN/JA = tab content markdown) or null.
function parseBilingual(md) {
  const tabsRe = /^<tabs(?=[\s>])[^>]*>/gm;
  let m;
  while ((m = tabsRe.exec(md))) {
    const end = findClose(md, m.index, "tabs");
    if (end === -1) return null;
    const inner = md.slice(m.index + m[0].length, end - "</tabs>".length);

    const tabs = {};
    const tabRe = /<tab(?=[\s>])([^>]*)>/g;
    let t;
    while ((t = tabRe.exec(inner))) {
      const close = findClose(inner, t.index, "tab");
      if (close === -1) break;
      const body = inner.slice(t.index + t[0].length, close - "</tab>".length).replace(/^\n/, "");
      const [label, ...rest] = body.split(/\n\s*\n/);
      const attrs = t[1];
      const lang =
        attrs.includes(FLAG.EN) || /^\s*english\s*$/i.test(label) ? "EN"
        : attrs.includes(FLAG.JA) || /^\s*日本語\s*$/.test(label) ? "JA"
        : null;
      if (lang) tabs[lang] = rest.join("\n\n").trim();
      tabRe.lastIndex = close; // skip nested tabs inside this tab
    }
    if ("EN" in tabs && "JA" in tabs) {
      return { before: md.slice(0, m.index), after: md.slice(end), EN: tabs.EN, JA: tabs.JA };
    }
    tabsRe.lastIndex = end;
  }
  return null;
}

function buildBilingual(content) {
  const tab = (lang) => {
    const body = content[lang].trim();
    return `<tab icon="${FLAG[lang]}">\n${LABEL[lang]}${body ? `\n\n${body}` : ""}\n</tab>`;
  };
  return `<tabs>\n${tab("EN")}\n${tab("JA")}\n</tabs>`;
}

// Child pages, databases and folders are real objects, not text: they can't
// be duplicated into both tabs, so they live below the tab block.
const OBJECT_LINE = /^<(page|database|folder)(?=[\s>])[^>]*>.*<\/\1>\s*$/;

async function translateMarkdown(md, lang) {
  // Discussion anchors belong to the original blocks only
  const source = md.replace(/\sdiscussion-urls="[^"]*"/g, "");
  const result = await translate(source, lang, PAGE_SYSTEM_PROMPT, 32000);
  if (result.truncated) {
    throw new Error("the page is too long to translate in one go (output limit reached) — nothing was changed");
  }
  return result.text.replace(/^```(?:markdown|md)?\n([\s\S]*)\n```$/, "$1");
}

async function translatePage(pageId, lang) {
  const page = await notionFetch(`/pages/${pageId}/markdown?markdown_version=v2`);
  if (page.truncated || page.unknown_block_ids?.length) {
    // Writing back <unknown> placeholders would destroy those blocks
    throw new Error("this page has blocks the API can't read (too large or unsupported) — nothing was changed");
  }
  const md = page.markdown || "";
  const existing = parseBilingual(md);

  let newMd;
  if (existing) {
    const from = lang === "JA" ? "EN" : "JA";
    if (!existing[from].trim()) throw new Error(`the ${LABEL[from]} tab is empty — nothing to translate from`);
    const content = { EN: existing.EN, JA: existing.JA };
    content[lang] = await translateMarkdown(existing[from], lang);
    newMd = existing.before + buildBilingual(content) + existing.after;
  } else {
    const lines = md.split("\n");
    const objects = lines.filter((l) => OBJECT_LINE.test(l));
    const body = lines.filter((l) => !OBJECT_LINE.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!body) throw new Error("the page has no text to translate");
    const srcLang = detectLang(body);
    const dstLang = srcLang === "JA" ? "EN" : "JA";
    const content = { [srcLang]: body, [dstLang]: await translateMarkdown(body, dstLang) };
    newMd = buildBilingual(content) + (objects.length ? `\n\n${objects.join("\n\n")}` : "");
    lang = dstLang;
  }

  await notionFetch(`/pages/${pageId}/markdown`, {
    method: "PATCH",
    body: JSON.stringify({
      markdown_version: "v2",
      type: "replace_content",
      replace_content: { new_str: newMd },
    }),
  });
  return lang;
}

// ─── event handling ──────────────────────────────────────────────────────────

async function handleComment(body) {
  const botId = await getBotId();
  if (body.authors?.some((a) => a.id === botId)) return; // our own comment

  const comment = await notionFetch(`/comments/${body.entity.id}`);
  if (comment.created_by?.id === botId) return;
  const lang = parseTrigger(plainText(comment.rich_text));
  if (!lang) return;

  try {
    const parentId = comment.parent.page_id || comment.parent.block_id;
    const thread = await listDiscussion(parentId, comment.discussion_id);
    const idx = thread.findIndex((c) => c.id === comment.id);

    if (idx > 0) {
      await translateComment(thread, idx, lang, botId);
      return;
    }

    // First comment of a discussion → translate the whole page
    const pageId = body.data?.page_id || (await resolvePageId(comment.parent));
    const updated = await translatePage(pageId, lang);
    await reply(comment.discussion_id, [
      textRT(`${FLAG[updated]} ${LABEL[updated]} tab updated / ${LABEL[updated]}タブを更新しました`),
    ]);
  } catch (err) {
    console.error("notion translation failed:", err);
    await reply(comment.discussion_id, [
      textRT(`⚠️ Translation failed / 翻訳に失敗しました: ${err.message}`.slice(0, 2000)),
    ]).catch(() => {});
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

  // Only comments trigger work now; page edits are no longer auto-translated.
  if (body.type === "comment.created") {
    waitUntil(
      handleComment(body).catch((err) => console.error("notion failed:", err))
    );
  }

  return res.status(200).end();
}
