/**
 * HTML to readable text. Not a parser and not a renderer: a scan needs the words a person would see on
 * the one page they pointed Ghost at, with the machinery removed. Scripts and styles are dropped whole,
 * so nothing a page hid in them can reach an extractor or a prompt.
 */

/** Elements whose CONTENT is never text a reader sees. */
const INVISIBLE = /<(script|style|noscript|template|svg|iframe|object|canvas|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** Elements that end a line of prose. */
const BLOCK = /<\/?(address|article|aside|blockquote|br|div|dd|dl|dt|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|th|tr|ul)\b[^>]*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const TAG = /<[^>]*>/g;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  middot: "·",
  bull: "•",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // Control characters and lone surrogates are dropped rather than decoded: they only ever hide text.
      return Number.isFinite(code) && code >= 32 && code !== 127 && (code < 0xd800 || code > 0xdfff) && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** The page's `<title>`, which is often the only place a personal site writes the owner's name. */
export function htmlTitle(html: string): string | undefined {
  const raw = /<title\b[^>]*>([\s\S]{0,300}?)<\/title\s*>/i.exec(html)?.[1];
  const title = raw ? decodeEntities(raw).replace(/\s+/g, " ").trim() : "";
  return title === "" ? undefined : title;
}

/** `<meta name="description">` / `og:description`: a one-line bio on most personal sites. */
export function htmlDescription(html: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\b(name|property)\s*=\s*["']?(og:)?description["']?/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    const text = decodeEntities(content?.[1] ?? content?.[2] ?? "").replace(/\s+/g, " ").trim();
    if (text !== "") return text.slice(0, 300);
  }
  return undefined;
}

const ANCHOR = /<a\b[^>]*\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi;
const MAX_LINKS = 60;

/**
 * The addresses behind the links, which stripping tags would otherwise throw away: a personal site writes
 * "GitHub" and puts the profile in the href. Only http(s) and mailto survive, resolved against the page.
 */
export function htmlLinks(html: string, base: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(ANCHOR)) {
    const raw = (match[1] ?? "").replace(/^["']|["']$/g, "").trim();
    if (raw === "") continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(raw), base);
    } catch {
      continue;
    }
    const link = url.protocol === "mailto:" ? url.pathname.trim() : url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
    if (link !== "" && !out.includes(link)) out.push(link);
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/**
 * Visible text, one line per block, collapsed and clipped. The title and the description lead, because a
 * personal site's name and role live there far more often than in the body.
 */
export function htmlToText(html: string, maxChars: number): string {
  const body = html.replace(COMMENT, " ").replace(INVISIBLE, " ").replace(BLOCK, "\n").replace(TAG, " ");
  const lines = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v ​-‍﻿]+/g, " ").trim())
    .filter((line) => line !== "");
  const head = [htmlTitle(html), htmlDescription(html)].filter((part): part is string => part !== undefined);
  return [...head, ...lines].join("\n").slice(0, maxChars);
}
