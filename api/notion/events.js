// Vercel serverless endpoint: /api/notion/events
// Notion JA↔EN on-demand translation (works like the Slack bot: nothing is
// translated automatically, a person asks for it).
//
// Notion's API has no reaction events, so the "reaction" is a flag emoji
// typed by a person: 🇯🇵 = Japanese, 🇬🇧 / 🇺🇸 = English.
//
// IN THE PAGE BODY (page.content_updated) — e.g. under a "new Timestamp" entry:
//   • A text block ending with a flag ("Ami is not moving 🇯🇵"), or
//   • a block that is only a flag, right under the text block to translate
//   → the whole entry (every block from the "@Name : @Now" timestamp bar —
//     or the previous non-text block — down to the flag) is replaced by a tab
//     block 🇬🇧 English | 🇯🇵 日本語 holding the original and the translation,
//     translated in one call; the flag is removed. Headings inside the entry
//     are translated too. Indentation, checkboxes, bold / colour / highlight
//     and links are kept. A flag on an indented line takes its whole entry.
//   • Range: start a line with ▶ (NOTION_RANGE_START) → only the lines from
//     there down to the flag are translated. "▶ one line 🇯🇵" = just that line.
//   • Inside those tabs, edit one side and end a line with a flag → the
//     other tab is re-translated from the side you edited.
//   • Restore: a line that is only ↩️ / restore / 復元 brings back translation
//     tabs and lines deleted by accident on this page. "↩️ original" also
//     brings back the pre-translation blocks of the newest translation.
//     Needs NOTION_LOG_DATABASE_ID: a database shared with the integration,
//     with properties Name (title), Page ID, Tab ID, Created IDs, Original
//     IDs (all Text). Without it, translation works and restore is off.
//
// IN COMMENTS (comment.created) — the comment text can also be a keyword
// (ja / jp / japanese / 日本語, en / english / 英語):
//   • "some text 🇯🇵" → the bot replies with that comment translated.
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
// Insert content, Read comments, Insert comments; webhook subscription with
// `page.content_updated` and `comment.created`.

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
- Formatted text is wrapped like <s id="1">text</s>. Keep every such tag pair with its id, translate the text inside it, and wrap the words of the translation that correspond to it. Tags may move to fit the target word order, but never drop, merge, or nest them.
- Text may be split into blocks, each starting with a marker line like <b id="0"/>. Keep every marker exactly, in the same order, each on its own line, and put the translation of that block after it. Never merge or split blocks.
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

async function notionFetch(path, options = {}, attempt = 0) {
  const res = await fetch(`${NOTION}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  // Rate limited (~3 req/s): wait as told and retry a few times
  if (res.status === 429 && attempt < 4) {
    const wait = Number(res.headers.get("retry-after")) || 1;
    await new Promise((r) => setTimeout(r, wait * 1000));
    return notionFetch(path, options, attempt + 1);
  }
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

const isPlainStyle = (a) =>
  !a || (!a.bold && !a.italic && !a.strikethrough && !a.underline && !a.code &&
    (a.color || "default") === "default");

// Mentions, equations and inline code must survive translation untouched:
// swap them for <x id="n"/> placeholders, translate, then put them back.
// Styled text (bold, colour, highlight, link…) is translated but keeps its
// style: it is wrapped as <s id="n">text</s> and re-styled afterwards.
function richTextToTagged(richText, tokens = []) {
  const text = richText
    .map((rt) => {
      if (rt.type === "text" && !rt.annotations?.code) {
        if (!rt.text.link && isPlainStyle(rt.annotations)) return rt.text.content;
        tokens.push(rt);
        return `<s id="${tokens.length - 1}">${rt.text.content}</s>`;
      }
      tokens.push(rt);
      return `<x id="${tokens.length - 1}"/>`;
    })
    .join("");
  return { text, tokens };
}

// Tag leftovers the model mangled (unpaired <s>, </s>) → dropped, text kept
const stripStrayTags = (s) => s.replace(/<\/?s(?:\s+id="\d+")?\s*\/?>/g, "");
const untag = (text, tokens) =>
  stripStrayTags(
    text
      .replace(/<x id="(\d+)"\s*\/>/g, (_, i) => tokens[Number(i)]?.plain_text ?? "")
      .replace(/<s id="\d+">([\s\S]*?)<\/s>/g, "$1")
  );

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
  // Notion caps each text object at 2000 characters
  const pushText = (content, style) => {
    for (let p = 0; p < content.length; p += 2000) {
      const piece = content.slice(p, p + 2000);
      out.push(
        style
          ? { type: "text", text: { content: piece, link: style.text.link }, annotations: style.annotations }
          : textRT(piece)
      );
    }
  };
  const re = /<x id="(\d+)"\s*\/>|<s id="(\d+)">([\s\S]*?)<\/s>/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    pushText(stripStrayTags(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const tok = tokens[Number(m[1])];
      if (tok) out.push(toRequestRT(tok));
    } else {
      const tok = tokens[Number(m[2])];
      pushText(stripStrayTags(m[3]), tok?.type === "text" ? tok : null);
    }
    last = re.lastIndex;
  }
  pushText(stripStrayTags(text.slice(last)));
  return out.slice(0, 100); // and a block/comment at 100 rich text objects
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
    const plain = untag(translated, tokens);
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

// ─── page-body blocks ────────────────────────────────────────────────────────

const BLOCK_FLAGS = [["🇯🇵", "JA"], ["🇬🇧", "EN"], ["🇺🇸", "EN"]];
const CONTENT_TYPES = new Set([
  "paragraph", "bulleted_list_item", "numbered_list_item", "to_do",
  "quote", "callout", "toggle", "heading_1", "heading_2", "heading_3",
]);
const HAS_WORDS = /[a-zA-Z぀-ゟ゠-ヿ一-鿿]/;

// "▶ first line … last line 🇬🇧" → only that range is translated
const RANGE_STARTS = (process.env.NOTION_RANGE_START || "▶")
  .split(",").map((s) => s.trim()).filter(Boolean);

// A block that is only "↩️" / "restore" / "復元" brings back deleted translations
const noVS = (s) => s.replace(/️/g, "");
const RESTORE_TRIGGERS = triggerList(process.env.NOTION_TRIGGERS_RESTORE, ["↩️", "↩", "restore", "復元"]);
const RESTORE_SET = new Set([...RESTORE_TRIGGERS].map(noVS));
const ORIGINAL_WORDS = new Set(["original", "原文"]);

function parseRestore(text) {
  const words = noVS(text.trim().toLowerCase()).split(/\s+/);
  if (!words[0] || !RESTORE_SET.has(words[0])) return null;
  if (words.length === 1) return { originals: false };
  if (words.length === 2 && ORIGINAL_WORDS.has(words[1])) return { originals: true };
  return null;
}

function trailingFlag(text) {
  const t = text.trimEnd();
  for (const [flag, lang] of BLOCK_FLAGS) {
    if (t.endsWith(flag)) return { flag, lang, only: t.slice(0, -flag.length).trim() === "" };
  }
  return null;
}

// Copy of richText without the trailing flag (and trailing whitespace)
function stripTrailingFlag(richText, flag) {
  const rt = richText.map((r) => structuredClone(r));
  for (let i = rt.length - 1; i >= 0; i--) {
    const r = rt[i];
    if (r.type !== "text") break;
    const c = r.text.content.trimEnd();
    if (c.endsWith(flag)) r.text.content = c.slice(0, -flag.length).trimEnd();
    else r.text.content = c;
    r.plain_text = r.text.content;
    if (r.text.content) break;
    rt.splice(i, 1); // nothing left in this run, keep looking left
    if (c.endsWith(flag)) break;
  }
  return rt;
}

function rangeStart(richText) {
  const first = richText[0];
  if (!first || first.type !== "text") return null;
  const t = first.text.content.trimStart();
  return RANGE_STARTS.find((m) => t.startsWith(m)) || null;
}

// Copy of richText without the leading range marker
function stripRangeStart(richText, marker) {
  const rt = richText.map((r) => structuredClone(r));
  const c = rt[0].text.content.trimStart().slice(marker.length).trimStart();
  rt[0].text.content = c;
  rt[0].plain_text = c;
  if (!c) rt.shift();
  return rt;
}

const parentIdOf = (b) =>
  b.parent.type === "page_id" ? b.parent.page_id
  : b.parent.type === "block_id" ? b.parent.block_id
  : null;

async function listChildren(blockId) {
  const all = [];
  let cursor;
  do {
    const q = new URLSearchParams({ page_size: "100" });
    if (cursor) q.set("start_cursor", cursor);
    const data = await notionFetch(`/blocks/${blockId}/children?${q}`);
    all.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return all;
}

const deleteBlock = (id) => notionFetch(`/blocks/${id}`, { method: "DELETE" });
const richOf = (b) => b[b.type]?.rich_text || [];

// The "@Name : @Today 3:53 PM" bar that opens every entry
function isTimestampHeader(b) {
  const kinds = new Set(richOf(b).filter((r) => r.type === "mention").map((r) => r.mention.type));
  return kinds.has("user") && kinds.has("date");
}

// An entry runs from the block after its timestamp bar (or any non-text
// block: a tab block, divider, image…) down to the flag. Ordinary headings
// are part of the entry.
const isEntryBoundary = (b) => !CONTENT_TYPES.has(b.type) || isTimestampHeader(b);

// A request-shaped block of the same kind as src, with new rich text
function contentBlock(src, richText) {
  const type = CONTENT_TYPES.has(src.type) ? src.type : "paragraph";
  const body = { rich_text: richText, color: src[src.type]?.color || "default" };
  if (type === "to_do") body.checked = !!src.to_do.checked;
  if (type === "callout" && src.callout.icon?.type === "emoji") body.icon = src.callout.icon;
  if (type.startsWith("heading_") && src[type].is_toggleable) body.is_toggleable = true;
  return { type, [type]: body };
}

function tabItem(lang, children) {
  return {
    type: "paragraph",
    paragraph: {
      rich_text: [textRT(LABEL[lang])],
      icon: { type: "emoji", emoji: FLAG[lang] },
      children,
    },
  };
}

async function translateRich(richText, lang) {
  const { text, tokens } = richTextToTagged(richText);
  const result = await translate(text, lang, COMMENT_SYSTEM_PROMPT, 8192);
  let out = result.text;
  if (result.truncated) out += " (translation truncated / 翻訳が途中で切れています)";
  return taggedToRichText(out, tokens);
}

// Translate several blocks in ONE call (so the model sees the whole entry),
// returning request-shaped rich text per block. Blocks without words are
// copied as they are. Falls back to one call per block if the markers
// don't come back intact.
async function translateRichList(list, lang) {
  const out = list.map((rich) => rich.map(toRequestRT));
  const idx = list.map((rich, i) => i).filter((i) => HAS_WORDS.test(plainText(list[i])));
  if (!idx.length) return out;

  const tokens = [];
  const source = idx
    .map((i, n) => `<b id="${n}"/>\n${richTextToTagged(list[i], tokens).text}`)
    .join("\n\n");
  const result = await translate(source, lang, COMMENT_SYSTEM_PROMPT, 16000);
  const parts = result.text.split(/<b id="(\d+)"\s*\/>/);
  const got = {};
  for (let p = 1; p < parts.length; p += 2) got[Number(parts[p])] = parts[p + 1].trim();

  if (!result.truncated && idx.every((_, n) => n in got)) {
    idx.forEach((i, n) => (out[i] = taggedToRichText(got[n], tokens)));
    const styled = (source.match(/<s id="/g) || []).length;
    const kept = (result.text.match(/<s id="\d+">[\s\S]*?<\/s>/g) || []).length;
    if (kept < styled) console.warn(`formatting tags lost: ${kept}/${styled} kept`);
  } else {
    console.warn("block markers lost, translating block by block");
    for (const i of idx) out[i] = await translateRich(list[i], lang);
  }
  return out;
}

// ── block trees (nesting is kept, not flattened) ──
// node = { block, rich, children: [node] }; `edits` overrides a block's rich
// text by id (flag / range marker stripped), `skip` drops blocks by id.

async function loadTree(blocks, edits = {}, skip = new Set()) {
  const nodes = [];
  for (const b of blocks) {
    if (!CONTENT_TYPES.has(b.type) || skip.has(b.id)) continue;
    nodes.push({
      block: b,
      rich: edits[b.id] || richOf(b),
      children: b.has_children ? await loadTree(await listChildren(b.id), edits, skip) : [],
    });
  }
  return nodes;
}

const flattenTree = (nodes) => nodes.flatMap((n) => [n, ...flattenTree(n.children)]);

// Same shape, with each block's rich text replaced by richFor(node)
function mapTree(nodes, richFor) {
  return nodes.map((n) => ({ req: contentBlock(n.block, richFor(n)), children: mapTree(n.children, richFor) }));
}

// Append request trees under parentId, any depth: one level per request,
// recursing into the blocks Notion just created. Every created id is pushed
// to `created` (for the restore log). `after` = id to insert after.
async function appendTree(parentId, trees, created, after) {
  for (let i = 0; i < trees.length; i += 100) {
    const chunk = trees.slice(i, i + 100);
    const body = { children: chunk.map((t) => t.req) };
    if (after) body.position = { type: "after_block", after_block: { id: after } };
    const res = await notionFetch(`/blocks/${parentId}/children`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    const made = res.results.slice(-chunk.length);
    for (let k = 0; k < chunk.length; k++) {
      created.push(made[k].id);
      if (chunk[k].children.length) await appendTree(made[k].id, chunk[k].children, created);
    }
    if (after) after = made[made.length - 1].id;
  }
}

// Insert a 🇬🇧 | 🇯🇵 tab block after `afterId`, each tab holding its tree
async function insertTabs(parentId, afterId, content) {
  const created = [];
  const res = await notionFetch(`/blocks/${parentId}/children`, {
    method: "PATCH",
    body: JSON.stringify({
      position: { type: "after_block", after_block: { id: afterId } },
      children: [{
        type: "tab",
        // Tab + items + first level of content fit in one request (2 levels)
        tab: { children: ["EN", "JA"].map((l) => tabItem(l, content[l].slice(0, 100).map((t) => t.req))) },
      }],
    }),
  });
  const tab = res.results[res.results.length - 1];
  created.push(tab.id);
  const items = (await listChildren(tab.id)).filter(itemLang);
  for (const item of items) {
    created.push(item.id);
    const trees = content[itemLang(item)];
    const firstLevel = await listChildren(item.id);
    created.push(...firstLevel.map((b) => b.id));
    for (let k = 0; k < firstLevel.length && k < trees.length; k++) {
      if (trees[k].children.length) await appendTree(firstLevel[k].id, trees[k].children, created);
    }
    if (trees.length > 100) {
      await appendTree(item.id, trees.slice(100), created, firstLevel[firstLevel.length - 1]?.id);
    }
  }
  return { tabId: tab.id, created };
}

function itemLang(item) {
  if (item.type !== "paragraph") return null;
  const emoji = item.paragraph.icon?.emoji;
  const label = plainText(item.paragraph.rich_text).trim();
  if (emoji === FLAG.EN || /^english$/i.test(label)) return "EN";
  if (emoji === FLAG.JA || label === LABEL.JA) return "JA";
  return null;
}

// Walk up from a block to the one sitting directly in the entry's container
// (the page, a column…), so an indented line brings its whole entry along.
// If the block lives inside one of our EN/JA tabs, returns that tab instead.
async function locate(block) {
  let top = block;
  while (top.parent.type === "block_id") {
    const parent = await notionFetch(`/blocks/${top.parent.block_id}`);
    if (parent.type === "tab") {
      const from = itemLang(top);
      const items = {};
      for (const it of await listChildren(parent.id)) {
        const lang = itemLang(it);
        if (lang) items[lang] = it;
      }
      if (from && items.EN && items.JA) return { tab: { tabId: parent.id, items, from } };
      return { top };
    }
    if (!CONTENT_TYPES.has(parent.type) || isTimestampHeader(parent)) break;
    top = parent;
  }
  return { top };
}

// Re-translate the other tab from the whole tab the person edited
async function refreshTab(ctx, edits, skip) {
  const to = ctx.from === "JA" ? "EN" : "JA";
  const nodes = await loadTree(await listChildren(ctx.items[ctx.from].id), edits, skip);
  const flat = flattenTree(nodes);
  const rich = await translateRichList(flat.map((n) => n.rich), to);
  const byNode = new Map(flat.map((n, i) => [n, rich[i]]));
  const replaced = [];
  for (const old of await listChildren(ctx.items[to].id)) {
    await deleteBlock(old.id);
    replaced.push(old.id);
  }
  const created = [];
  await appendTree(ctx.items[to].id, mapTree(nodes, (n) => byNode.get(n)), created);
  return { created, replaced };
}

const REFRESH_TITLE = "(tab refresh)";

// ── restore log (a Notion database; off when NOTION_LOG_DATABASE_ID is unset) ──
// Properties: Name (title), Page ID, Tab ID, Created IDs, Original IDs (text)

const LOG_DB = process.env.NOTION_LOG_DATABASE_ID;
let cachedLogSource = null;

async function logSourceId() {
  if (!cachedLogSource) {
    const db = await notionFetch(`/databases/${LOG_DB}`);
    cachedLogSource = db.data_sources?.[0]?.id;
    if (!cachedLogSource) throw new Error("log database has no data source");
  }
  return cachedLogSource;
}

// Long id lists → several ≤2000-char rich text items
function idsRT(ids) {
  const s = ids.join(",");
  const out = [];
  for (let p = 0; p < s.length && out.length < 100; p += 2000) out.push(textRT(s.slice(p, p + 2000)));
  return out;
}
const idsOf = (prop) => plainText(prop?.rich_text).split(",").filter(Boolean);

async function logTranslation(pageId, title, tabId, created, originals) {
  if (!LOG_DB) return;
  try {
    await notionFetch("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: await logSourceId() },
        properties: {
          Name: { title: [textRT(title.slice(0, 50) || "(untitled)")] },
          "Page ID": { rich_text: [textRT(pageId)] },
          "Tab ID": { rich_text: [textRT(tabId)] },
          "Created IDs": { rich_text: idsRT(created) },
          "Original IDs": { rich_text: idsRT(originals) },
        },
      }),
    });
  } catch (err) {
    // The translation itself already succeeded — don't fail it over the log
    console.error("restore log write failed:", err.message);
  }
}

async function untrash(id) {
  try {
    const b = await notionFetch(`/blocks/${id}`);
    if (!b.in_trash) return 0;
    await notionFetch(`/blocks/${id}`, { method: "PATCH", body: JSON.stringify({ in_trash: false }) });
    return 1;
  } catch (err) {
    console.warn(`restore ${id} failed:`, err.message);
    return 0;
  }
}

// Bring back every logged translation block on this page that was deleted
// (tab first, then its tabs and lines, in creation order). With `originals`,
// also bring back the pre-translation text of the newest translation.
async function restore(pageId, trigger, originals) {
  if (!LOG_DB) return;
  const rows = await notionFetch(`/data_sources/${await logSourceId()}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: { property: "Page ID", rich_text: { equals: pageId } },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 10,
    }),
  });
  await deleteBlock(trigger.id);
  const title = (row) => plainText(row.properties.Name?.title);
  const isRefresh = (row) => title(row) === REFRESH_TITLE;
  // Lines a tab refresh replaced were deleted by the bot on purpose — skip them
  const replaced = new Set(rows.results.filter(isRefresh).flatMap((r) => idsOf(r.properties["Original IDs"])));
  let restored = 0;
  for (const row of rows.results) {
    for (const id of idsOf(row.properties["Created IDs"])) {
      if (!replaced.has(id)) restored += await untrash(id);
    }
  }
  const newest = rows.results.find((r) => !isRefresh(r));
  if (originals && newest) {
    for (const id of idsOf(newest.properties["Original IDs"])) restored += await untrash(id);
  }
  console.log(`restore on ${pageId}: ${restored} block(s) restored`);
}

// ── the flag ──

async function handleBlock(blockId, pageId, botId) {
  const block = await notionFetch(`/blocks/${blockId}`);
  if (!CONTENT_TYPES.has(block.type) || block.in_trash) return;
  if (block.last_edited_by?.id === botId) return; // our own edit → no loop

  const rich = richOf(block);
  const restoreCmd = parseRestore(plainText(rich));
  if (restoreCmd) return restore(pageId, block, restoreCmd.originals);

  const trig = trailingFlag(plainText(rich));
  if (!trig) return;
  if (isTimestampHeader(block)) return; // nothing to translate, leave the flag

  const edits = {};
  const skip = new Set();
  if (trig.only) skip.add(block.id);
  else edits[block.id] = stripTrailingFlag(rich, trig.flag);

  const removeFlag = () =>
    trig.only
      ? deleteBlock(block.id)
      : notionFetch(`/blocks/${block.id}`, {
          method: "PATCH",
          body: JSON.stringify({ [block.type]: { rich_text: edits[block.id].map(toRequestRT) } }),
        });

  const loc = await locate(block);
  if (loc.tab) {
    await removeFlag();
    const { created, replaced } = await refreshTab(loc.tab, edits, skip);
    // Original IDs of a refresh row = the old lines it replaced on purpose
    await logTranslation(pageId, REFRESH_TITLE, loc.tab.tabId, created, replaced);
    return;
  }

  // The entry, as top-level blocks of the container: from just after the
  // timestamp bar (or a ▶ range marker) down to the flagged block.
  const top = loc.top;
  const siblings = await listChildren(parentIdOf(top));
  let end = siblings.findIndex((b) => b.id === top.id);
  if (end === -1) return;
  if (top.id === block.id && trig.only) end--; // flag alone on its line → the block above
  if (end < 0 || isEntryBoundary(siblings[end])) return;
  let start = end;
  while (start > 0 && !isEntryBoundary(siblings[start - 1])) start--;

  let range = siblings.slice(start, end + 1);
  let nodes = await loadTree(range, edits, skip);

  // A ▶ marker (on any line, indented or not) narrows the range to start at
  // the top-level block holding it. The last marker before the flag wins.
  // (range and nodes are 1:1: every block in range is a content block.)
  const flat = flattenTree(nodes);
  for (let i = flat.length - 1; i >= 0; i--) {
    const marker = rangeStart(flat[i].rich);
    if (!marker) continue;
    flat[i].rich = stripRangeStart(flat[i].rich, marker);
    const owner = nodes.findIndex((n) => flattenTree([n]).includes(flat[i]));
    range = range.slice(owner);
    nodes = nodes.slice(owner);
    break;
  }
  // Leave empty lines at the start of the entry where they are
  while (nodes.length > 1 && !plainText(nodes[0].rich).trim() && !nodes[0].children.length) {
    nodes.shift();
    range.shift();
  }

  const lines = flattenTree(nodes);
  const sourceRich = lines.map((n) => n.rich);
  const allText = sourceRich.map(plainText).join("\n");
  if (!HAS_WORDS.test(allText)) return;

  await removeFlag(); // claim it first, so a repeated webhook finds nothing to do

  const srcLang = detectLang(allText);
  const dstLang = srcLang === "JA" ? "EN" : "JA";
  const translated = await translateRichList(sourceRich, dstLang);
  const byNode = new Map(lines.map((n, i) => [n, translated[i]]));
  const content = {
    [srcLang]: mapTree(nodes, (n) => n.rich.map(toRequestRT)),
    [dstLang]: mapTree(nodes, (n) => byNode.get(n)),
  };
  const last = range[range.length - 1];
  const { tabId, created } = await insertTabs(parentIdOf(top), last.id, content);

  // The originals now live in their tab. Trashed, not destroyed: the
  // restore log keeps their ids ("↩️ original").
  for (const b of range) if (!skip.has(b.id)) await deleteBlock(b.id);
  await logTranslation(pageId, plainText(sourceRich[0] || []), tabId, created, range.map((b) => b.id));
}

async function handlePageEvent(body) {
  const botId = await getBotId();
  if (body.authors?.length && body.authors.every((a) => a.id === botId)) return;
  const pageId = body.entity?.id;
  for (const { id } of body.data?.updated_blocks || []) {
    try {
      await handleBlock(id, pageId, botId);
    } catch (err) {
      console.error(`block ${id} failed:`, err.message);
    }
  }
}

// ─── comment events ──────────────────────────────────────────────────────────

async function handleComment(body) {
  const botId = await getBotId();
  if (body.authors?.some((a) => a.id === botId)) return; // our own comment

  const comment = await notionFetch(`/comments/${body.entity.id}`);
  if (comment.created_by?.id === botId) return;
  const text = plainText(comment.rich_text);
  const lang = parseTrigger(text);

  if (!lang) {
    // "some text 🇯🇵" → translate this comment itself
    const trig = trailingFlag(text);
    if (!trig || trig.only) return;
    const stripped = stripTrailingFlag(comment.rich_text, trig.flag);
    if (!HAS_WORDS.test(plainText(stripped))) return;
    try {
      await translateComment([{ ...comment, rich_text: stripped }, comment], 1, trig.lang, botId);
    } catch (err) {
      console.error("comment translation failed:", err);
    }
    return;
  }

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

  console.log("notion event:", body.type, body.entity?.id);
  // Nothing is auto-translated: both handlers only act on a flag a person typed.
  if (body.type === "comment.created") {
    waitUntil(
      handleComment(body).catch((err) => console.error("notion failed:", err))
    );
  } else if (body.type === "page.content_updated") {
    waitUntil(
      handlePageEvent(body).catch((err) => console.error("notion failed:", err))
    );
  }

  return res.status(200).end();
}
