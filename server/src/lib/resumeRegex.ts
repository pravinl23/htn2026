/** No-key resume extraction: regex and keyword rules only. Returns canonical fact keys plus `extra.*`. */

const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const SEASON_MONTH: Record<string, number> = { winter: 4, spring: 5, summer: 8, fall: 12, autumn: 12 };
const CA_PROVINCES: Record<string, string> = {
  ON: "Ontario", QC: "Quebec", BC: "British Columbia", AB: "Alberta", MB: "Manitoba", SK: "Saskatchewan", NS: "Nova Scotia",
  NB: "New Brunswick", NL: "Newfoundland and Labrador", PE: "Prince Edward Island", YT: "Yukon", NT: "Northwest Territories", NU: "Nunavut",
};
const US_STATES = new Set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "));

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Several rules backtrack quadratically on hostile input, and this runs synchronously on the event loop that also serves
// Tab predictions. Bounding what each regex sees keeps the worst case at a few milliseconds.
const MAX_LINE = 600;
const MAX_EMAIL_TOKEN = 254;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const DOMAIN = "(?:www\\.)?([a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:com|dev|io|me|net|org|ca|app|co|ai|tech|xyz|page|site))(\\/[^\\s|,;)]*)?";
const WHOLE_DOMAIN = new RegExp(`^(?:https?:\\/\\/)?${DOMAIN}$`);
const SCHEME_URL = new RegExp(`https?:\\/\\/${DOMAIN}`, "g");
const NOT_A_PERSONAL_SITE = /(^|\.)(github|linkedin|gitlab|devpost|twitter|x|medium)\.com$|(^|\.)example\.(com|org|net)$/;
const SCHOOL = /\b(University|College|Institute|Polytechnic|Academy)\b/;
const SCHOOL_NAME = /(?:The )?University of [A-Z][\w'.-]*(?: [A-Z][\w'.-]*){0,6}|[A-Z][\w'.&-]*(?: (?:of|[A-Z][\w'.&-]*)){0,6} (?:University|College|Institute of Technology|Institute|Polytechnic|Academy)\b/;
const DEGREE = /\b(Bachelor|Master|Doctor|Associate|B\.?Sc|BCS|BASc|B\.A\.Sc|BEng|B\.Eng|BMath|BBA|B\.?S\.?|B\.?A\.?|M\.?Sc|MEng|M\.Eng|MASc|MBA|M\.?S\.?|Ph\.?D)\b\.?/;
const BROAD_FIELD = /^(Science|Arts|Engineering|Applied Science|Mathematics|Technology)$/i;
const SEGMENT_SPLIT = /\s*(?:[|•·\t]|\s[—–-]\s|\s{2,})\s*/;
const GRADUATION_HINT = /expected|anticipated|graduat|class of|candidate/i;
const MONTH_NAME = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";

export interface YearMonth {
  year: number;
  month: number;
}

/** Finds every month+year mention: "April 2028", "Apr. 2028", "04/2028", "2028-04", "Spring 2028". Dates are parsed here, never by a model. */
export function findYearMonths(text: string): YearMonth[] {
  const found: YearMonth[] = [];
  const push = (year: number, month: number | undefined): void => {
    if (month && month >= 1 && month <= 12 && year >= 1950 && year <= 2100) found.push({ year, month });
  };
  for (const m of text.matchAll(new RegExp(`\\b${MONTH_NAME},?\\s+(\\d{4})\\b`, "gi"))) push(Number(m[2]), MONTH_INDEX[(m[1] ?? "").toLowerCase()]);
  for (const m of text.matchAll(/\b(winter|spring|summer|fall|autumn)\s+(\d{4})\b/gi)) push(Number(m[2]), SEASON_MONTH[(m[1] ?? "").toLowerCase()]);
  for (const m of text.matchAll(/(?<![\d/-])(\d{1,2})\/(\d{4})\b/g)) push(Number(m[2]), Number(m[1]));
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})(?![\d])/g)) push(Number(m[1]), Number(m[2]));
  return found;
}

export function toYearMonth(text: string): string | undefined {
  const latest = findYearMonths(text).sort((a, b) => b.year - a.year || b.month - a.month)[0];
  return latest ? `${latest.year}-${String(latest.month).padStart(2, "0")}` : undefined;
}

/** Whitespace runs shrink to one separator (a tab, or two spaces: both still split segments); long lines wrap at a space so nothing is lost. */
function tidyLine(line: string): string[] {
  let rest = line.replace(/\s{2,}/g, (run) => (run.includes("\t") ? "\t" : "  ")).trim();
  const out: string[] = [];
  while (rest.length > MAX_LINE) {
    const space = rest.lastIndexOf(" ", MAX_LINE);
    const cut = space > 0 ? space : MAX_LINE;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return rest ? [...out, rest] : out;
}

function emailOf(text: string): string | undefined {
  for (const token of text.split(/\s+/)) {
    const email = token.length <= MAX_EMAIL_TOKEN && token.includes("@") ? EMAIL.exec(token)?.[0] : undefined;
    if (email) return email;
  }
  return undefined;
}

export function extractFactsByRegex(resumeText: string): Record<string, string> {
  const lines = resumeText.split(/\r?\n/).flatMap(tidyLine).filter(Boolean);
  const header = lines.slice(0, 8).join("\n");
  const text = lines.join("\n");
  const facts: Record<string, string | undefined> = {
    ...nameFacts(lines),
    email: emailOf(text),
    phone: PHONE.exec(header)?.[0]?.trim() ?? PHONE.exec(text)?.[0]?.trim(),
    ...linkFacts(text, header),
    ...locationFacts(header),
    ...educationFacts(lines),
    "extra.skills": skillsOf(lines),
  };
  return Object.fromEntries(Object.entries(facts).filter((e): e is [string, string] => Boolean(e[1])));
}

function nameFacts(lines: string[]): Record<string, string> {
  const first = (lines[0] ?? "").replace(/\s*[|,(].*$/, "").trim();
  const words = first.split(/\s+/);
  const looksLikeName = words.length >= 2 && words.length <= 4 && words.every((w) => /^\p{Lu}[\p{L}.'-]*$/u.test(w));
  if (!looksLikeName) return {};
  const fullName = words.every((w) => w === w.toUpperCase()) ? words.map(titleCase).join(" ") : words.join(" ");
  const parts = fullName.split(" ");
  return { fullName, firstName: parts[0] ?? "", lastName: parts[parts.length - 1] ?? "" };
}

function titleCase(word: string): string {
  return word.charAt(0) + word.slice(1).toLowerCase();
}

function linkFacts(text: string, header: string): Record<string, string | undefined> {
  const github = /github\.com\/[A-Za-z0-9-]+/i.exec(text)?.[0];
  const linkedin = /linkedin\.com\/in\/[A-Za-z0-9-_%]+/i.exec(text)?.[0];
  return { github: github && `https://${github}`, linkedin: linkedin && `https://${linkedin}`, website: websiteOf(text, header) };
}

/** A bare domain only counts when it stands alone in a header segment ("a | b | alexchen.dev"); in prose it needs a scheme, so "socket.io" in a sentence is never a website. */
function websiteOf(text: string, header: string): string | undefined {
  const segments = header.split(/\n/).flatMap((line) => line.split(SEGMENT_SPLIT)).map((segment) => segment.replace(/^[A-Za-z ]{1,15}:\s+/, "").trim());
  const candidates = [...segments.map((segment) => WHOLE_DOMAIN.exec(segment)), ...text.matchAll(SCHEME_URL)];
  for (const m of candidates) {
    const host = m?.[1];
    if (host && !NOT_A_PERSONAL_SITE.test(host)) return `https://${host}${(m[2] ?? "").replace(/[/.]+$/, "")}`;
  }
  return undefined;
}

function locationFacts(header: string): Record<string, string | undefined> {
  const m = /(?:^|[|•·,]\s*|\s{2,})([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}),\s*([A-Z]{2})\b(?!\w)/m.exec(header);
  const city = m?.[1];
  const code = m?.[2];
  if (!city || !code) return {};
  const province = CA_PROVINCES[code] ?? (US_STATES.has(code) ? code : undefined);
  if (!province) return {};
  return { location: `${city}, ${code}`, city, province, country: CA_PROVINCES[code] ? "Canada" : "United States" };
}

function educationFacts(lines: string[]): Record<string, string | undefined> {
  const schoolIdx = schoolLineIndex(lines);
  const schoolLine = lines[schoolIdx] ?? "";
  const school = SCHOOL_NAME.exec(schoolLine)?.[0] ?? segmentWith(schoolLine, SCHOOL)?.replace(/,.*$/, "").trim();
  const degreeLine = lines.find((l, i) => DEGREE.test(l) && (schoolIdx < 0 || Math.abs(i - schoolIdx) <= 3));
  const degree = degreeLine ? segmentWith(degreeLine, DEGREE)?.replace(/^(degree|program)\s*:\s*/i, "") : undefined;
  return { school, degree, major: degree ? majorOf(degree) : undefined, graduationDate: graduationDate(lines, schoolIdx) };
}

/** A summary line can mention a school too, so look under the EDUCATION heading first. */
function schoolLineIndex(lines: string[]): number {
  const heading = lines.findIndex((l) => /^education\b/i.test(l));
  const inSection = heading < 0 ? -1 : lines.findIndex((l, i) => i > heading && SCHOOL.test(l));
  return inSection >= 0 ? inSection : lines.findIndex((l) => SCHOOL.test(l));
}

function segmentWith(line: string, pattern: RegExp): string | undefined {
  return line.split(SEGMENT_SPLIT).find((segment) => pattern.test(segment))?.trim();
}

function majorOf(degree: string): string | undefined {
  const [head = "", ...rest] = degree.split(/,\s*/);
  const named = (/\bin\s+(.+)$/i.exec(head) ?? /\bof\s+(.+)$/i.exec(head))?.[1]?.trim();
  if (named && !BROAD_FIELD.test(named)) return stripNotes(named);
  if (!named) {
    const afterAbbreviation = head.replace(DEGREE, "").replace(/^\W+/, "").trim();
    if (afterAbbreviation && afterAbbreviation !== head) return stripNotes(afterAbbreviation);
  }
  const next = rest[0]?.replace(/^(major(ing)? in|honou?rs)\s+/i, "").trim();
  return next ? stripNotes(next) : undefined;
}

function stripNotes(text: string): string {
  return text.replace(/\s*\([^)]*\)\s*/g, " ").trim();
}

/** Prefer an explicit "Expected April 2028"; otherwise the latest date near the school line (the end of "Sept 2023 - April 2028"). */
function graduationDate(lines: string[], schoolIdx: number): string | undefined {
  const hinted = lines.filter((l) => GRADUATION_HINT.test(l)).map(toYearMonth).find(Boolean);
  if (hinted || schoolIdx < 0) return hinted;
  return toYearMonth(lines.slice(schoolIdx, schoolIdx + 4).join("\n"));
}

function skillsOf(lines: string[]): string | undefined {
  const idx = lines.findIndex((l) => /^(technical )?skills\b/i.test(l));
  if (idx < 0) return undefined;
  const inline = (lines[idx] ?? "").replace(/^(technical )?skills\s*[:—–-]?\s*/i, "");
  const body = inline || sectionBody(lines, idx + 1, 3).map((l) => l.replace(/^[^:]{1,25}:\s*/, "")).join(", ");
  return body.replace(/\s+/g, " ").slice(0, 300).trim() || undefined;
}

function sectionBody(lines: string[], from: number, maxLines: number): string[] {
  const body: string[] = [];
  for (const line of lines.slice(from, from + maxLines)) {
    if (/^[A-Z][A-Z &]{3,}$/.test(line)) break;
    body.push(line);
  }
  return body;
}
