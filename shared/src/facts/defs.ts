// Default definitions: how a fact key is phrased, what category it belongs to, and which field kinds can
// take it. These are DATA, not rules: a fact that is not listed here still works, it just describes itself
// with the label and aliases its source gave it. Nothing in the matcher reads a key name.
import type { FieldKind } from "../types";
import { normalizeText } from "./text";
import type { FactCategory } from "./types";

const TEXT: readonly FieldKind[] = ["text"];
const EMAIL: readonly FieldKind[] = ["text", "email"];
const PHONE: readonly FieldKind[] = ["text", "tel"];
const LINK: readonly FieldKind[] = ["text", "url"];
const TEXT_OR_SELECT: readonly FieldKind[] = ["text", "select"];
const YES_NO: readonly FieldKind[] = ["select", "radio", "checkbox"];
const ONE_OF: readonly FieldKind[] = ["text", "select", "radio"];
const WHEN: readonly FieldKind[] = ["text", "number", "month", "date", "select"];

export interface FactDef {
  category: FactCategory;
  label: string;
  aliases: string[];
  kinds?: readonly FieldKind[];
}

/**
 * The résumé keys Ghost shipped with, now just one corner of the graph. Their KEYS are unchanged on
 * purpose: stored profiles, per-site caches and learned answers all speak them, and renaming them would
 * throw that away for nothing. New facts use dotted keys.
 */
const RESUME_DEFS: Record<string, FactDef> = {
  firstName: { category: "identity", label: "first name", aliases: ["given name", "forename", "fname"], kinds: TEXT },
  lastName: { category: "identity", label: "last name", aliases: ["family name", "surname", "lname"], kinds: TEXT },
  fullName: { category: "identity", label: "full name", aliases: ["name", "legal name", "full legal name"], kinds: TEXT },
  email: { category: "contact", label: "email", aliases: ["email address", "e mail"], kinds: EMAIL },
  phone: { category: "contact", label: "phone", aliases: ["phone number", "telephone", "mobile", "cell"], kinds: PHONE },
  location: { category: "address", label: "current location", aliases: ["city and province", "where you are based"], kinds: TEXT },
  city: { category: "address", label: "city", aliases: ["town"], kinds: TEXT },
  province: { category: "address", label: "province", aliases: ["state", "region"], kinds: TEXT_OR_SELECT },
  country: { category: "address", label: "country", aliases: ["country of residence"], kinds: TEXT_OR_SELECT },
  school: { category: "education", label: "school", aliases: ["university", "college", "institution"], kinds: TEXT_OR_SELECT },
  degree: { category: "education", label: "degree", aliases: ["degree type", "qualification"], kinds: TEXT_OR_SELECT },
  major: { category: "education", label: "major", aliases: ["field of study", "concentration", "area of study"], kinds: TEXT_OR_SELECT },
  graduationDate: { category: "education", label: "graduation date", aliases: ["expected graduation", "grad year", "class year"], kinds: WHEN },
  github: { category: "links", label: "github", aliases: ["github profile", "github url"], kinds: LINK },
  linkedin: { category: "links", label: "linkedin", aliases: ["linkedin profile", "linkedin url"], kinds: LINK },
  website: { category: "links", label: "website", aliases: ["personal website", "portfolio", "home page"], kinds: LINK },
  workAuthorization: { category: "work", label: "work authorization", aliases: ["authorized to work", "right to work"], kinds: YES_NO },
  requiresSponsorship: { category: "work", label: "requires sponsorship", aliases: ["visa sponsorship", "sponsorship required"], kinds: YES_NO },
  referralSource: { category: "other", label: "how you heard about us", aliases: ["referral source", "how did you hear about us"], kinds: ONE_OF },
};

/**
 * Facts no job form ever asks for. They are here so an importer or the options page does not have to
 * invent phrasings, and so a shipping form works the moment the user types one address.
 */
const OPEN_DEFS: Record<string, FactDef> = {
  "address.home.street": {
    category: "address",
    label: "street address",
    aliases: [
      "address",
      "address line 1",
      "home address",
      "mailing address",
      "shipping address",
      "delivery address",
      "street",
      "where should we send this",
      "where do we send it",
    ],
    kinds: TEXT,
  },
  "address.home.unit": {
    category: "address",
    label: "apartment or suite",
    aliases: ["apt", "unit", "suite", "address line 2", "apartment suite etc", "apartment, suite, etc"],
    kinds: TEXT,
  },
  "address.home.city": { category: "address", label: "city", aliases: ["town"], kinds: TEXT },
  "address.home.province": { category: "address", label: "province", aliases: ["state", "region"], kinds: TEXT_OR_SELECT },
  "address.home.postalCode": { category: "address", label: "postal code", aliases: ["zip", "zip code", "postcode", "zip postal code"], kinds: TEXT },
  "address.home.country": { category: "address", label: "country", aliases: ["country of residence"], kinds: TEXT_OR_SELECT },
  "contact.email.work": { category: "contact", label: "work email", aliases: ["business email", "company email", "corporate email"], kinds: EMAIL },
  "contact.email.personal": { category: "contact", label: "personal email", aliases: ["home email"], kinds: EMAIL },
  "contact.phone.mobile": { category: "contact", label: "mobile phone", aliases: ["cell phone", "mobile number", "mobile"], kinds: PHONE },
  "work.employer.current": {
    category: "work",
    label: "employer",
    aliases: ["company", "company name", "organization", "organisation", "current employer", "employer name", "where you work"],
    kinds: TEXT_OR_SELECT,
  },
  "work.title": {
    category: "work",
    label: "job title",
    aliases: ["your title", "current title", "role", "position", "job role", "occupation"],
    kinds: TEXT_OR_SELECT,
  },
  "preferences.shirtSize": { category: "preferences", label: "t shirt size", aliases: ["shirt size", "tee size", "t shirt"], kinds: ONE_OF },
  "preferences.dietary": {
    category: "preferences",
    label: "dietary restrictions",
    aliases: ["dietary requirements", "dietary needs", "food allergies", "allergies or dietary restrictions"],
    kinds: ONE_OF,
  },
  "preferences.pronouns": { category: "preferences", label: "pronouns", aliases: [], kinds: ONE_OF },
  "links.twitter": { category: "links", label: "twitter", aliases: ["twitter handle", "x handle", "twitter profile"], kinds: LINK },
};

export const DEFAULT_FACT_DEFS: Record<string, FactDef> = { ...RESUME_DEFS, ...OPEN_DEFS };

/** The résumé keys, in the order the options page shows them. */
export const RESUME_FACT_KEYS: readonly string[] = Object.keys(RESUME_DEFS);

const COUNTRY_NAMES: Record<string, string> = {
  CA: "Canada",
  US: "the United States",
  UK: "the United Kingdom",
  GB: "the United Kingdom",
  AU: "Australia",
  NZ: "New Zealand",
  IE: "Ireland",
  DE: "Germany",
  FR: "France",
  NL: "the Netherlands",
  IN: "India",
  SG: "Singapore",
};

/** "Turn `addressHome` or `postalCode` into `postal code`" — the fallback when a source gives no label. */
export function labelFromKey(key: string): string {
  const last = key.split(".").filter(Boolean).pop() ?? key;
  return normalizeText(last);
}

/**
 * The definition for a key, including country-qualified declarations (`workAuthorization.US`), which read
 * as the base fact asked about one country. Null when the key describes itself.
 */
export function factDefFor(key: string): FactDef | null {
  const exact = DEFAULT_FACT_DEFS[key];
  if (exact) return exact;
  const dot = key.lastIndexOf(".");
  if (dot <= 0) return null;
  const base = DEFAULT_FACT_DEFS[key.slice(0, dot)];
  const code = key.slice(dot + 1);
  if (!base || !/^[A-Za-z]{2}$/.test(code)) return null;
  const country = COUNTRY_NAMES[code.toUpperCase()] ?? code.toUpperCase();
  return { ...base, label: `${base.label} in ${country}`, aliases: [...base.aliases, base.label] };
}

const YES_NO_VALUE = /^(y|n|yes|no|true|false)$/i;
const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?$/;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_VALUE = /^(https?:\/\/|www\.)\S+$/i;
const PHONE_VALUE = /^[+(]?[\d][\d\s()+.-]{6,}$/;

/** Which field kinds a fact can land in, read off its own value. A yes never goes into a url input. */
export function kindsForFact(value: string, category: FactCategory): readonly FieldKind[] {
  const v = value.trim();
  if (YES_NO_VALUE.test(v)) return YES_NO;
  if (ISO_DATE.test(v)) return WHEN;
  if (EMAIL_VALUE.test(v)) return EMAIL;
  if (URL_VALUE.test(v)) return LINK;
  if (PHONE_VALUE.test(v)) return PHONE;
  // Text by default, and a select too: a select is just a text field whose answers are listed, and
  // `resolveFieldValue` refuses the fact anyway when no option expresses it.
  return category === "identity" || category === "contact" ? TEXT : TEXT_OR_SELECT;
}
