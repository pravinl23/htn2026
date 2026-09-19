import type { PastAnswer } from "@ghost/shared";

export interface DraftInput {
  fieldLabel: string;
  maxChars?: number;
  pageContext: { company?: string; role?: string; description?: string };
  facts: Record<string, string>;
  pastAnswers: PastAnswer[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MOTIVATION = /\bwhy\b|interest|motivat|excite|appeal|draws? you/i;
const PROJECT = /project|built|build|accomplish|proud|challeng|experience|technical/i;
const STOPWORDS = new Set(["a", "an", "the", "us", "you", "your", "about", "of", "to", "in", "on", "and", "or", "tell", "describe", "please", "what", "is", "are", "have", "that"]);
const MAX_WORDS = 120;

/** Deterministic no-key draft. Every concrete claim comes from the inputs; the rest is working-style phrasing. */
export function templateDraft(input: DraftInput, now: Date = new Date()): string {
  const reused = reusablePastAnswer(input);
  const sentences = reused ? [reused] : PROJECT.test(input.fieldLabel) && !MOTIVATION.test(input.fieldLabel) ? projectDraft(input, now) : motivationDraft(input, now);
  return clipToSentences(trimToWordBudget(sentences).join(" "), input.maxChars);
}

/** "2028-04" -> "April 2028". Anything else is returned unchanged. */
export function formatYearMonth(value: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(value.trim());
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${month} ${m[1]}` : value.trim();
}

/** Keeps whole sentences within maxChars; falls back to a word boundary when even the first sentence is too long. */
export function clipToSentences(text: string, maxChars?: number): string {
  const clean = text.trim();
  if (!maxChars || clean.length <= maxChars) return clean;
  let kept = "";
  // Split after sentence punctuation followed by whitespace, so dots inside URLs never end a sentence.
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    const next = kept ? `${kept} ${sentence}` : sentence;
    if (next.length > maxChars) break;
    kept = next;
  }
  if (kept) return kept;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

function motivationDraft(input: DraftInput, now: Date): string[] {
  const { company } = input.pageContext;
  const tail = MOTIVATION.test(input.fieldLabel) ? " because the work lines up with what I most want to get better at" : "";
  const skills = topSkills(input.facts);
  const link = input.facts.github ?? input.facts.website;
  return compact([
    `${joinClauses(whoAmI(input.facts, now), applying(input))}${tail}.`,
    `I learn fastest when I am building real things alongside people who care about the details, and that is the kind of environment I am looking for${company ? ` at ${company}` : ""}.`,
    `${skills ? `Most of my recent work has been in ${skills}, and ` : ""}I would bring curiosity, steady follow-through, and a habit of shipping small, well-tested pieces early.`,
    link ? `You can see what I have been building at ${link}.` : undefined,
  ]);
}

function projectDraft(input: DraftInput, now: Date): string[] {
  const { company, role } = input.pageContext;
  const link = input.facts.github ?? input.facts.website;
  const skills = topSkills(input.facts);
  const who = whoAmI(input.facts, now);
  const target = role && company ? `the ${role} role at ${company}` : company ? `my work at ${company}` : role ? `the ${role} role` : "this role";
  return compact([
    `${who ? `${who}, and most` : "Most"} of what I build starts as a small working version that I then improve based on how people actually use it.`,
    `${link ? `Much of my project work is public at ${link}, and I am` : "I am"} happy to walk through any of it in detail, from the first design decisions to the trade-offs I would revisit.`,
    skills ? `My recent work has mostly been in ${skills}.` : undefined,
    `I would bring the same approach to ${target}: own a piece end to end, test it properly, and keep improving it.`,
  ]);
}

function whoAmI(facts: Record<string, string>, now: Date): string {
  const field = facts.major ?? facts.degree;
  const school = facts.school ? (/^university of /i.test(facts.school) ? `the ${facts.school}` : facts.school) : undefined;
  const who = field && school ? `I am ${/^[aeiou]/i.test(field) ? "an" : "a"} ${field} student at ${school}` : school ? `I am a student at ${school}` : field ? `I study ${field}` : "";
  return who && facts.graduationDate ? `${who}, ${graduationClause(facts.graduationDate, now)}` : who;
}

function graduationClause(graduationDate: string, now: Date): string {
  const isPast = /^\d{4}-\d{2}$/.test(graduationDate) && graduationDate < now.toISOString().slice(0, 7);
  return `${isPast ? "graduated" : "graduating"} in ${formatYearMonth(graduationDate)}`;
}

function applying(input: DraftInput): string {
  const { company, role } = input.pageContext;
  if (role && company) return `I am applying for the ${role} role at ${company}`;
  if (company) return `I am applying to ${company}`;
  return role ? `I am applying for the ${role} role` : "I am excited to apply";
}

function joinClauses(who: string, applyingClause: string): string {
  return who ? `${who}, and ${applyingClause}` : applyingClause;
}

function topSkills(facts: Record<string, string>): string | undefined {
  const items = (facts["extra.skills"] ?? "").split(/[,;|]/).map((s) => s.replace(/^[^:]*:/, "").trim()).filter((s) => s && s.length <= 30).slice(0, 3);
  if (items.length < 2) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Essay answers transfer between applications; "why this company" answers name the old company, so they never do. */
function reusablePastAnswer(input: DraftInput): string | undefined {
  if (MOTIVATION.test(input.fieldLabel)) return undefined;
  const wanted = keywords(input.fieldLabel);
  const match = input.pastAnswers.find((p) => p.answer.trim().length >= 40 && overlap(wanted, keywords(p.question)) >= 0.5);
  return match?.answer.trim();
}

function keywords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w)));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared / (a.size + b.size - shared);
}

function trimToWordBudget(sentences: string[]): string[] {
  const kept = [...sentences];
  while (kept.length > 2 && wordCount(kept.join(" ")) > MAX_WORDS) kept.pop();
  return kept;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function compact(items: (string | undefined)[]): string[] {
  return items.filter((s): s is string => Boolean(s));
}
