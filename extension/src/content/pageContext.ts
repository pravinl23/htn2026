// What a draft may know about the page: who is hiring, for what, and what the posting says. All of it is
// text a stranger wrote. It is carried as plain data, clipped hard, and never read for instructions.
import { TEXT_LIMITS } from "../lib/messages";
import type { TextPageContext } from "../lib/messages";

const DESCRIPTION_ROOTS = ['[data-testid="job-description"]', '[itemprop="description"]', "main article", "article", "main", '[role="main"]'];
/** Never part of a description: controls (a textarea's text is the user's), chrome around the content, and anything marked private. */
const SKIPPED = [
  "script", "style", "noscript", "template", "svg", "form", "nav", "footer", "aside", "button", "input", "select", "textarea",
  "[hidden]", '[aria-hidden="true"]', "[contenteditable]", "[data-ghost-sensitive]", "[data-sensitive]", "#ghost-overlay-host",
].join(", ");
const MAX_NODES = 1500;
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;
/** Addresses and phone numbers on the page (a recruiter's, or the user's own on an account page) stay on the page. */
const CONTACT = /[^\s@]+@[^\s@]+\.[^\s@]+|(?:\+?\d[\s().-]{0,3}){9,}/g;
const TITLE_SEPARATOR = /\s+[|·•–—-]\s+/;
const ROLE_AT_COMPANY = /^(.{2,120}?)\s+(?:at|@)\s+(.{2,120})$/i;
const ABOUT_COMPANY = /^about\s+(?!(?:the|us|you|your|this|our|me|my|it)\b)([^?!]{2,80})$/i;
const NAME_START = /^[\p{Lu}\p{N}]/u;

export function extractPageContext(doc: Document = document): TextPageContext {
  const posting = jobPosting(doc);
  const heading = firstShownText(doc, "h1");
  const title = meta(doc, "og:title") ?? cleanText(doc.title, TEXT_LIMITS.name);
  const split = [heading, title].map(splitRoleAtCompany).find((parts) => parts !== null) ?? null;
  const context: TextPageContext = {};
  const company = posting.company ?? meta(doc, "og:site_name") ?? aboutCompany(doc) ?? split?.company;
  const role = posting.role ?? split?.role ?? heading ?? firstSegment(title);
  const description = describe(doc);
  if (company) context.company = company;
  if (role) context.role = role;
  if (description) context.description = description;
  return context;
}

/** One line of page text made safe to carry: no control, zero-width or bidi characters, no contact details, clipped at a word. */
export function cleanText(raw: string | null | undefined, max: number): string | undefined {
  const text = (raw ?? "").replace(UNSAFE_CHARS, " ").replace(CONTACT, " ").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text || undefined;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim() || undefined;
}

function meta(doc: Document, property: string): string | undefined {
  const el = doc.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
  return cleanText(el?.getAttribute("content"), TEXT_LIMITS.name);
}

function firstShownText(doc: Document, selector: string): string | undefined {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(selector)).slice(0, 5)) {
    const text = isShown(el) ? cleanText(el.textContent, TEXT_LIMITS.name) : undefined;
    if (text) return text;
  }
  return undefined;
}

/** "Software Engineer at Northwind | Careers" -> role and company. */
function splitRoleAtCompany(text: string | undefined): { role: string; company: string } | null {
  const match = ROLE_AT_COMPANY.exec(firstSegment(text) ?? "");
  const role = match?.[1]?.trim();
  const company = match?.[2]?.trim();
  return role && company ? { role, company } : null;
}

function firstSegment(text: string | undefined): string | undefined {
  return text?.split(TITLE_SEPARATOR)[0]?.trim() || undefined;
}

/** Postings introduce the employer under "About <Company>"; "About the role" and "About you" are not names. */
function aboutCompany(doc: Document): string | undefined {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("h2, h3")).slice(0, 40)) {
    const match = ABOUT_COMPANY.exec(cleanText(el.textContent, TEXT_LIMITS.name) ?? "");
    if (match?.[1] && NAME_START.test(match[1]) && isShown(el)) return match[1].trim();
  }
  return undefined;
}

/** schema.org JobPosting, which most job boards embed. Parsed as data; anything that is not a plain string is ignored. */
function jobPosting(doc: Document): { role?: string; company?: string } {
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).slice(0, 10)) {
    const posting = findPosting(parseJson(script.textContent));
    if (!posting) continue;
    const org = posting.hiringOrganization;
    const name = isRecord(org) ? org.name : org;
    return {
      role: typeof posting.title === "string" ? cleanText(posting.title, TEXT_LIMITS.name) : undefined,
      company: typeof name === "string" ? cleanText(name, TEXT_LIMITS.name) : undefined,
    };
  }
  return {};
}

function findPosting(data: unknown): Record<string, unknown> | null {
  const items = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data["@graph"]) ? data["@graph"] : [data];
  return items.find((item): item is Record<string, unknown> => isRecord(item) && item["@type"] === "JobPosting") ?? null;
}

function parseJson(text: string | null): unknown {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return null;
  }
}

function describe(doc: Document): string | undefined {
  for (const selector of DESCRIPTION_ROOTS) {
    const root = doc.querySelector<HTMLElement>(selector);
    const text = root && isShown(root) ? cleanText(visibleText(root), TEXT_LIMITS.description) : undefined;
    if (text && text.length >= 40) return text;
  }
  return undefined;
}

/** Text a reader can see, in document order. Stops early: only the first 2000 characters are ever used. */
function visibleText(root: HTMLElement): string {
  const doc = root.ownerDocument;
  const filter = doc.defaultView?.NodeFilter ?? NodeFilter;
  const walker = doc.createTreeWalker(root, filter.SHOW_ELEMENT | filter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === 3) return filter.FILTER_ACCEPT;
      const el = node as HTMLElement;
      return el.matches(SKIPPED) || !isShown(el) ? filter.FILTER_REJECT : filter.FILTER_SKIP;
    },
  });
  const parts: string[] = [];
  let length = 0;
  for (let visited = 0; visited < MAX_NODES && length < TEXT_LIMITS.description * 2 && walker.nextNode(); visited++) {
    const text = walker.currentNode.nodeValue ?? "";
    parts.push(text);
    length += text.length;
  }
  return parts.join(" ");
}

function isShown(el: HTMLElement): boolean {
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true });
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return style?.display !== "none" && style?.visibility !== "hidden";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
