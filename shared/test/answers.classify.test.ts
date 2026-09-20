import { describe, expect, it } from "vitest";
import {
  classifyQuestion,
  hasReadableQuestion,
  isDeclineOption,
  kindFamily,
  looksLikeEeoScale,
  normalizeQuestion,
  optionsFingerprint,
  parseCountry,
  questionSignature,
  questionTextSignature,
  type FieldKind,
  type FieldOption,
  type QuestionClass,
  type QuestionField,
  type QuestionTopic,
} from "../src";

function q(label: string, kind: FieldKind = "select", extra: Partial<QuestionField> = {}): QuestionField {
  return { label, kind, ...extra };
}

const YES_NO: FieldOption[] = [
  { value: "1", label: "Yes" },
  { value: "0", label: "No" },
];

// The option sets these forms really ship, word for word.
const GREENHOUSE_GENDER: FieldOption[] = [
  { value: "1", label: "Male" },
  { value: "2", label: "Female" },
  { value: "3", label: "Decline To Self Identify" },
];
const GREENHOUSE_HISPANIC: FieldOption[] = [
  { value: "1", label: "Yes" },
  { value: "2", label: "No" },
  { value: "3", label: "Decline To Self Identify" },
];
const GREENHOUSE_VETERAN: FieldOption[] = [
  { value: "1", label: "I am not a protected veteran" },
  { value: "2", label: "I identify as one or more of the classifications of a protected veteran" },
  { value: "3", label: "I don't wish to answer" },
];
const GREENHOUSE_DISABILITY: FieldOption[] = [
  { value: "1", label: "Yes, I have a disability, or have had one in the past" },
  { value: "2", label: "No, I don't have a disability and have not had one in the past" },
  { value: "3", label: "I do not want to answer" },
];
const REFERRAL_SOURCES: FieldOption[] = [
  { value: "", label: "Select..." },
  { value: "1", label: "LinkedIn" },
  { value: "2", label: "Indeed" },
  { value: "3", label: "Employee referral" },
  { value: "4", label: "University career fair" },
  { value: "5", label: "Other" },
];

interface Case {
  label: string;
  kind?: FieldKind;
  options?: FieldOption[];
  context?: string;
  class: QuestionClass;
  topic?: QuestionTopic;
  country?: string;
}

/**
 * How Greenhouse, Lever, Ashby, Workday and iCIMS really word their questions. The classifier sees only the
 * words, never the site: every one of these must land in the right class on any of those forms.
 */
const CORPUS: Case[] = [
  // --- ordinary -----------------------------------------------------------------------------------------
  { label: "How did you hear about this opportunity at Viam?", options: REFERRAL_SOURCES, class: "ordinary" },
  { label: "How did you hear about us?", options: REFERRAL_SOURCES, class: "ordinary" },
  { label: "Where did you first hear about this role?", class: "ordinary" },
  { label: "Preferred name", kind: "text", class: "ordinary" },
  { label: "What name do you go by?", kind: "text", class: "ordinary" },
  { label: "LinkedIn Profile", kind: "url", class: "ordinary" },
  { label: "GitHub", kind: "url", class: "ordinary" },
  { label: "Personal website or portfolio", kind: "url", class: "ordinary" },
  { label: "Are you willing to relocate to New York, NY?", options: YES_NO, class: "ordinary" },
  { label: "Are you able to commute to our Toronto office three days a week?", options: YES_NO, class: "ordinary" },
  { label: "What are your salary expectations?", kind: "text", class: "ordinary" },
  { label: "Desired base salary (USD)", kind: "number", class: "ordinary" },
  { label: "When can you start?", kind: "text", class: "ordinary" },
  { label: "What is your notice period?", class: "ordinary" },
  { label: "Which office would you prefer to work from?", class: "ordinary" },
  { label: "Have you previously worked for this company or one of its subsidiaries?", options: YES_NO, class: "ordinary" },
  { label: "Do you have any friends or family currently employed here?", options: YES_NO, class: "ordinary" },
  { label: "Why do you want to work here?", kind: "textarea", class: "ordinary" },
  { label: "Tell us about a project you are proud of", kind: "textarea", class: "ordinary" },
  { label: "Years of professional experience", class: "ordinary" },
  { label: "Which best describes your current employment status?", class: "ordinary" },
  { label: "Did someone refer you to this role?", options: YES_NO, class: "ordinary" },
  { label: "Referring employee name", kind: "text", class: "ordinary" },
  { label: "Are you comfortable working in a hybrid environment?", options: YES_NO, class: "ordinary" },
  { label: "Current company", kind: "text", class: "ordinary" },
  { label: "Current job title", kind: "text", class: "ordinary" },
  { label: "T-shirt size", class: "ordinary" },
  { label: "What is your highest level of education completed?", class: "ordinary" },
  { label: "Are you open to a contract-to-hire arrangement?", options: YES_NO, class: "ordinary" },
  { label: "Please provide a link to your portfolio", kind: "url", class: "ordinary" },
  { label: "How many years of experience do you have with Go?", class: "ordinary" },
  { label: "Which team are you most interested in?", class: "ordinary" },
  { label: "Have you ever applied to this company before?", options: YES_NO, class: "ordinary" },
  { label: "What time zone are you based in?", kind: "text", class: "ordinary" },
  { label: "Do you have reliable internet access for remote work?", options: YES_NO, class: "ordinary" },
  { label: "City", kind: "text", class: "ordinary" },
  { label: "Are you available to start on the posted start date?", options: YES_NO, class: "ordinary" },
  { label: "Were you referred by a current employee?", options: YES_NO, class: "ordinary" },
  { label: "Are you willing to travel up to 25% of the time?", options: YES_NO, class: "ordinary" },
  { label: "What interests you about this team?", kind: "textarea", class: "ordinary" },

  // --- protected ----------------------------------------------------------------------------------------
  { label: "Gender", options: GREENHOUSE_GENDER, class: "protected", topic: "gender" },
  { label: "Please indicate your gender", class: "protected", topic: "gender" },
  { label: "Gender identity", class: "protected", topic: "sexualOrientation" },
  { label: "Are you Hispanic/Latino?", options: GREENHOUSE_HISPANIC, class: "protected", topic: "hispanicLatino" },
  { label: "Are you Hispanic or Latino?", options: GREENHOUSE_HISPANIC, class: "protected", topic: "hispanicLatino" },
  { label: "Race", class: "protected", topic: "ethnicity" },
  { label: "Race/Ethnicity", class: "protected", topic: "ethnicity" },
  { label: "Which of the following best describes your ethnicity?", class: "protected", topic: "ethnicity" },
  { label: "National origin", class: "protected", topic: "ethnicity" },
  { label: "Veteran Status", options: GREENHOUSE_VETERAN, class: "protected", topic: "veteranStatus" },
  { label: "Are you a protected veteran?", class: "protected", topic: "veteranStatus" },
  { label: "Protected Veteran Status (US only)", class: "protected", topic: "veteranStatus", country: "US" },
  { label: "Have you served in the armed forces?", options: YES_NO, class: "protected", topic: "veteranStatus" },
  { label: "Disability Status", options: GREENHOUSE_DISABILITY, class: "protected", topic: "disabilityStatus" },
  { label: "Do you have a disability?", options: YES_NO, class: "protected", topic: "disabilityStatus" },
  { label: "Please check one of the boxes below", context: "Voluntary Self-Identification of Disability", class: "protected" },
  { label: "Which of the following describes you?", context: "Demographic Information (optional)", class: "protected" },
  { label: "Date of Birth", kind: "date", class: "protected", topic: "dateOfBirth" },
  { label: "What is your date of birth?", kind: "text", class: "protected", topic: "dateOfBirth" },
  { label: "Age range", class: "protected", topic: "age" },
  { label: "Are you 40 years of age or older?", options: YES_NO, class: "protected", topic: "age" },
  { label: "Sexual orientation", class: "protected", topic: "sexualOrientation" },
  { label: "Do you identify as LGBTQ+?", options: YES_NO, class: "protected", topic: "sexualOrientation" },
  { label: "I identify as transgender", kind: "checkbox", class: "protected", topic: "sexualOrientation" },
  { label: "Religion or belief", class: "protected", topic: "religion" },
  { label: "Marital status", class: "protected", topic: "maritalStatus" },
  { label: "Are you a member of a visible minority?", options: YES_NO, class: "protected", topic: "ethnicity" },
  { label: "Do you identify as Indigenous, First Nations, Metis or Inuit?", options: YES_NO, class: "protected", topic: "ethnicity" },
  { label: "Pronouns", class: "protected", topic: "pronouns" },
  { label: "What are your pronouns?", kind: "text", class: "protected", topic: "pronouns" },
  { label: "Do you require any accommodations during the interview process?", options: YES_NO, class: "protected", topic: "disabilityStatus" },
  { label: "EEO: Gender", class: "protected", topic: "gender" },
  { label: "Voluntary self-identification", class: "protected" },

  // --- declaration --------------------------------------------------------------------------------------
  {
    label: "Are you legally authorized to work in the United States for any employer?",
    options: YES_NO,
    class: "declaration",
    topic: "workAuthorization",
    country: "US",
  },
  { label: "Are you legally authorized to work in the U.S.?", options: YES_NO, class: "declaration", topic: "workAuthorization", country: "US" },
  { label: "Are you authorized to work in the United States?", options: YES_NO, class: "declaration", topic: "workAuthorization", country: "US" },
  { label: "Are you legally eligible to work in the United States?", options: YES_NO, class: "declaration", topic: "workAuthorization", country: "US" },
  { label: "Are you legally authorized to work in Canada?", options: YES_NO, class: "declaration", topic: "workAuthorization", country: "CA" },
  { label: "Do you have the right to work in the UK?", options: YES_NO, class: "declaration", topic: "workAuthorization", country: "GB" },
  { label: "Do you require a work permit to be employed in Australia?", options: YES_NO, class: "declaration", topic: "workAuthorization", country: "AU" },
  {
    label: "Are you legally authorized to work in the country where this position is located?",
    options: YES_NO,
    class: "declaration",
    topic: "workAuthorization",
  },
  {
    label: "Will you now or in the future require sponsorship for employment visa status?",
    options: YES_NO,
    class: "declaration",
    topic: "requiresSponsorship",
  },
  {
    label: "Do you now, or will you in the future, require sponsorship to work in the United States?",
    options: YES_NO,
    class: "declaration",
    topic: "requiresSponsorship",
    country: "US",
  },
  { label: "Will you require visa sponsorship?", options: YES_NO, class: "declaration", topic: "requiresSponsorship" },
  { label: "Are you able to work in the EU without sponsorship?", options: YES_NO, class: "declaration", topic: "requiresSponsorship", country: "EU" },
  { label: "What is your current visa status?", class: "declaration", topic: "immigrationStatus" },
  {
    label: "Are you a citizen or permanent resident of the United States?",
    options: YES_NO,
    class: "declaration",
    topic: "immigrationStatus",
    country: "US",
  },
  { label: "Are you at least 18 years of age?", options: YES_NO, class: "declaration", topic: "legalAge" },
  { label: "Are you 18 years or older?", options: YES_NO, class: "declaration", topic: "legalAge" },
  { label: "Have you ever been convicted of a felony?", options: YES_NO, class: "declaration", topic: "criminalRecord" },
  {
    label: "Have you ever been convicted of a crime, other than a minor traffic violation?",
    options: YES_NO,
    class: "declaration",
    topic: "criminalRecord",
  },
  { label: "Have you ever pled guilty to a misdemeanor?", options: YES_NO, class: "declaration", topic: "criminalRecord" },
  { label: "I consent to a background check", kind: "checkbox", class: "declaration", topic: "backgroundCheck" },
  { label: "Do you consent to a background check and drug screening?", options: YES_NO, class: "declaration", topic: "backgroundCheck" },
  { label: "Are you subject to ITAR export control restrictions?", options: YES_NO, class: "declaration", topic: "exportControl" },
  { label: "Do you hold an active security clearance?", options: YES_NO, class: "declaration", topic: "securityClearance" },
  { label: "What is your security clearance level?", class: "declaration", topic: "securityClearance" },
  { label: "Are you bound by a non-compete or non-solicitation agreement?", options: YES_NO, class: "declaration", topic: "nonCompete" },
  {
    label: "I certify that the information provided is true and complete to the best of my knowledge",
    kind: "checkbox",
    class: "declaration",
    topic: "certification",
  },
  { label: "I declare under penalty of perjury that the above is correct", kind: "checkbox", class: "declaration", topic: "certification" },
  {
    label: "Do you now or in the future require sponsorship to work in the country where you are applying?",
    options: YES_NO,
    class: "declaration",
    topic: "requiresSponsorship",
  },
];

describe("classifyQuestion over a real-world corpus", () => {
  it("covers at least 80 questions", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(80);
  });

  for (const c of CORPUS) {
    it(`${c.class}: ${c.label}`, () => {
      const extra: Partial<QuestionField> = {};
      if (c.options) extra.options = c.options;
      if (c.context) extra.context = c.context;
      const result = classifyQuestion(q(c.label, c.kind ?? "select", extra));
      expect(result.class).toBe(c.class);
      if (c.topic) expect(result.topic).toBe(c.topic);
      expect(result.country).toBe(c.country);
      expect(result.reason).not.toBe("");
    });
  }

  it("never guesses a protected characteristic just because a country is named", () => {
    const veteran = classifyQuestion(q("Protected Veteran Status (US only)"));
    expect(veteran.class).toBe("protected");
    expect(veteran.country).toBe("US");
  });

  it("reads a self-identification section, and an EEO answer scale, as protected", () => {
    expect(looksLikeEeoScale(GREENHOUSE_VETERAN)).toBe(true);
    expect(looksLikeEeoScale(GREENHOUSE_DISABILITY)).toBe(true);
    expect(looksLikeEeoScale(YES_NO)).toBe(false);
    expect(looksLikeEeoScale(REFERRAL_SOURCES)).toBe(false);
    // A declaration word inside a voluntary self-identification block does not make it a declaration.
    const inBlock = classifyQuestion(q("Gender", "select", { options: GREENHOUSE_GENDER, context: "Voluntary Self-Identification" }));
    expect(inBlock.class).toBe("protected");
  });

  it("knows a decline option from an answer", () => {
    expect(isDeclineOption("Decline To Self Identify")).toBe(true);
    expect(isDeclineOption("I don't wish to answer")).toBe(true);
    expect(isDeclineOption("I do not want to answer")).toBe(true);
    expect(isDeclineOption("Prefer not to say")).toBe(true);
    expect(isDeclineOption("Female")).toBe(false);
    expect(isDeclineOption("Other")).toBe(false);
  });

  it("does not read a sponsor, a race condition or an average as the vocabulary word", () => {
    expect(classifyQuestion(q("Which conference sponsor introduced you?", "text")).class).toBe("ordinary");
    expect(classifyQuestion(q("Describe a race condition you have debugged", "textarea")).class).toBe("ordinary");
    expect(classifyQuestion(q("What is your average weekly availability?", "text")).class).toBe("ordinary");
    expect(classifyQuestion(q("Are you able to work weekends?", "select", { options: YES_NO })).class).toBe("ordinary");
    expect(classifyQuestion(q("Do you need help with travel accommodations?", "select", { options: YES_NO })).class).toBe("ordinary");
  });

  it("parses the country out of a label, and only a real one", () => {
    expect(parseCountry("Are you authorized to work in the United States?")).toBe("US");
    expect(parseCountry("Are you authorized to work in the U.S. for any employer?")).toBe("US");
    expect(parseCountry("Do you have the right to work in the UK?")).toBe("GB");
    expect(parseCountry("Authorized to work in Canada")).toBe("CA");
    expect(parseCountry("Eligible to work in India?")).toBe("IN");
    expect(parseCountry("Tell us about yourself")).toBeUndefined();
    expect(parseCountry("How did you hear about us?")).toBeUndefined();
  });
});

describe("questionSignature", () => {
  const same = (a: QuestionField, b: QuestionField, opts?: { company?: string }): void => {
    expect(questionSignature(a, opts ?? {})).toBe(questionSignature(b, opts ?? {}));
  };
  const different = (a: QuestionField, b: QuestionField): void => {
    expect(questionSignature(a)).not.toBe(questionSignature(b));
  };

  it("is the same question on two different companies' forms", () => {
    same(q("How did you hear about this opportunity at Viam?", "select", { options: REFERRAL_SOURCES }), q("How did you hear about this opportunity at Stripe?", "select", { options: REFERRAL_SOURCES }));
    same(q("Why do you want to work at Viam?", "textarea"), q("Why do you want to work at Ashby?", "textarea"));
    same(q("How did you hear about us?"), q("Viam - How did you hear about us?"));
    same(q("How did you hear about us?"), q("Viam: How did you hear about us?"));
  });

  it("strips a company name wherever the client knows it", () => {
    same(q("Have you ever worked at Viam before?", "select", { options: YES_NO }), q("Have you ever worked at before?", "select", { options: YES_NO }), { company: "Viam" });
  });

  it("reads two spellings of the same country as the same question", () => {
    same(
      q("Are you legally authorized to work in the United States for any employer?", "select", { options: YES_NO }),
      q("Are you legally authorized to work in the U.S. for any employer?", "select", { options: YES_NO }),
    );
    same(
      q("Are you legally authorized to work in the USA for any employer?", "select", { options: YES_NO }),
      q("Are you legally authorized to work in the United States for any employer?", "select", { options: YES_NO }),
    );
  });

  it("ignores decoration: required markers, asterisks, case, quotes and whitespace", () => {
    same(q("Gender"), q("Gender *"));
    same(q("Gender"), q("  gender  "));
    same(q("Are you Hispanic/Latino? (required)", "select", { options: YES_NO }), q("Are you Hispanic/Latino?", "select", { options: YES_NO }));
    same(q("What's your preferred name?", "text"), q("What’s your preferred name?", "text"));
  });

  it("is the same when one site uses radios and another a select, and when the options are listed in another order", () => {
    same(q("Are you Hispanic/Latino?", "select", { options: GREENHOUSE_HISPANIC }), q("Are you Hispanic/Latino?", "radio", { options: GREENHOUSE_HISPANIC }));
    same(
      q("Gender", "select", { options: GREENHOUSE_GENDER }),
      q("Gender", "select", { options: [...GREENHOUSE_GENDER].reverse() }),
    );
    expect(kindFamily("select")).toBe(kindFamily("radio"));
  });

  it("does not collide two genuinely different questions", () => {
    different(
      q("Are you legally authorized to work in the United States?", "select", { options: YES_NO }),
      q("Are you legally authorized to work in Canada?", "select", { options: YES_NO }),
    );
    different(q("How did you hear about us?"), q("How did you hear about this role?"));
    different(q("Gender", "select", { options: GREENHOUSE_GENDER }), q("Race", "select", { options: GREENHOUSE_GENDER }));
    different(q("Why do you want to work here?", "textarea"), q("Why do you want to work here?", "select", { options: YES_NO }));
    different(q("Are you Hispanic/Latino?", "select", { options: YES_NO }), q("Are you Hispanic/Latino?", "select", { options: GREENHOUSE_HISPANIC }));
    different(q("Are you willing to relocate?", "select", { options: YES_NO }), q("Are you willing to travel?", "select", { options: YES_NO }));
  });

  it("keeps the option fingerprint out of the text signature, so differently worded options still match", () => {
    const greenhouse = q("Gender", "select", { options: GREENHOUSE_GENDER });
    const workday = q("Gender", "select", { options: [{ value: "m", label: "Man" }, { value: "w", label: "Woman" }, { value: "x", label: "Prefer not to answer" }] });
    expect(questionSignature(greenhouse)).not.toBe(questionSignature(workday));
    expect(questionTextSignature(greenhouse)).toBe(questionTextSignature(workday));
  });

  it("normalizes a question down to what it asks", () => {
    expect(normalizeQuestion("How did you hear about this opportunity at Viam?")).toBe("how did you hear about this opportunity");
    expect(normalizeQuestion("Are you legally authorized to work in the United States?")).toBe("are you legally authorized to work in the countryus");
    expect(optionsFingerprint(undefined)).toBe("");
    expect(optionsFingerprint([{ value: "", label: "Select..." }])).toBe("");
  });

  it("refuses to key a question with no readable text", () => {
    expect(hasReadableQuestion(q("", "text"))).toBe(false);
    expect(hasReadableQuestion(q("  *  ", "text"))).toBe(false);
    expect(hasReadableQuestion(q("Gender"))).toBe(true);
  });
});
