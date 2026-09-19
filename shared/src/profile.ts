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
  referralSource: "how the applicant heard about the company",
};
