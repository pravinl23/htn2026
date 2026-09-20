// The text primitives the mapper and the fact graph share. They used to live in heuristic.ts; they moved
// here so `shared/src/facts/**` can use the SAME normalizer without importing the heuristic (which imports
// the facts module back). heuristic.ts re-exports `normalizeText` as `normalize`, so nothing else changed.

/** "firstName", "first_name", "First Name" and "FIRST-NAME" all read as "first name". */
export function normalizeText(text: string | undefined): string {
  return (text ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[_\-./:*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Name (first and last) - required" reads as "name", so anchored patterns can match a decorated label. */
export function bareText(text: string): string {
  return text
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(required|optional)\b/g, " ")
    .replace(/[^a-z0-9&' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words of already-normalized text. */
export function wordsOf(text: string): string[] {
  return bareText(text).split(" ").filter((word) => word !== "");
}

/** Whole words in order, never substrings: "zip" is not inside "zipline". */
export function containsWords(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((word, j) => haystack[i + j] === word)) return true;
  }
  return false;
}

/** The haystack words that the needle phrase does not account for. */
export function leftoverWords(haystack: readonly string[], needle: readonly string[]): string[] {
  const used = new Set(needle);
  return haystack.filter((word) => !used.has(word));
}

// Labels about someone or something other than the user. Shared with the heuristic's rule table.
export const OTHER_PARTY =
  /\b(references?|referees?|referrer|referred|emergency|next of kin|manager|supervisor|recruiter|interviewer|parent|guardian|spouse|partner|mother|father|sibling|child|dependent|beneficiary|friend|colleague|co ?worker|employer|company|organi[sz]ation|business|vendor|landlord|doctor|physician|attorney|contact person|recipient|their|his|her)('?s)?\b/;
// Section headings are matched from their start: the nearest heading is often a job title, which may say anything.
export const OTHER_PARTY_SECTION =
  /^(your |add |my |\d+ )?((professional|personal|character|employment|work) )?(references?|referees?|emergency contacts?|next of kin|referrals?|referred by|employee referral|parents?|guardians?|spouse|dependents?|beneficiar(y|ies)|co ?applicant)\b/;
