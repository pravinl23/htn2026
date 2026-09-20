import { profileToGraph } from "./facts/migrate";
import type { FactGraph } from "./facts/types";
import type { Profile } from "./types";

/** Fictional demo profile. Never put real personal data in the repo. */
export const DEMO_PROFILE: Profile = {
  facts: {
    firstName: "Alex",
    lastName: "Chen",
    fullName: "Alex Chen",
    email: "alex.chen.dev@example.com",
    phone: "+1 519 555 0142",
    location: "Waterloo, ON",
    city: "Waterloo",
    province: "Ontario",
    country: "Canada",
    school: "University of Waterloo",
    degree: "BCS Computer Science",
    major: "Computer Science",
    graduationDate: "2028-04",
    github: "https://github.com/alexchen-dev",
    linkedin: "https://linkedin.com/in/alexchen-dev",
    website: "https://alexchen.dev",
    // Work authorization is per country: Alex is Canadian, and says nothing at all about the US.
    // A US question is therefore answered by the conservative guess (not authorized, sponsorship needed)
    // until the user corrects it once. The unqualified keys stay for older profiles and for a question
    // that names no country. See docs/answers.md section 2.
    "workAuthorization.CA": "yes",
    "requiresSponsorship.CA": "no",
    workAuthorization: "yes",
    requiresSponsorship: "no",
    referralSource: "Hack the North",
  },
  pastAnswers: [],
};

/** Human descriptions of fact keys; used as choice-option hints for model providers. */
export const FACT_DESCRIPTIONS: Record<string, string> = {
  firstName: "first / given name",
  lastName: "last / family name / surname",
  fullName: "full legal name",
  email: "email address",
  phone: "phone number",
  location: "current location as city and province/state",
  city: "city",
  province: "province or state",
  country: "country",
  school: "university / college / school name",
  degree: "degree or program",
  major: "major / field of study",
  graduationDate: "expected graduation date",
  github: "GitHub profile URL",
  linkedin: "LinkedIn profile URL",
  website: "personal website or portfolio URL",
  workAuthorization: "legally authorized to work in the country (yes/no)",
  requiresSponsorship: "requires visa sponsorship (yes/no)",
  "workAuthorization.CA": "legally authorized to work in Canada (yes/no)",
  "requiresSponsorship.CA": "requires visa sponsorship in Canada (yes/no)",
  referralSource: "how the applicant heard about the company",
};

/**
 * The same demo profile as a fact graph: the résumé keys keep their names and gain a category, a label
 * and the phrasings a form might use, so the mapper can match them the way it matches any other fact.
 * The 19 keys are now one corner of an open graph, not the whole of what Shabang knows.
 */
export const DEMO_FACT_GRAPH: FactGraph = profileToGraph(DEMO_PROFILE, { kind: "user" }, "2026-01-01T00:00:00.000Z");
