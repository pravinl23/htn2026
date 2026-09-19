// Adversarial corpus: labels as Greenhouse, Lever, Ashby, Workday, iCIMS, SmartRecruiters and Taleo phrase them,
// plus the look-alikes that used to produce confident wrong ghosts. "A wrong ghost is worse than no ghost."
import { describe, expect, it } from "vitest";
import { DEMO_PROFILE, NEEDS_TEXT, NONE, mapFieldToFact, mapFormHeuristically, type CapturedField, type FieldKind } from "../src";

const factKeys = Object.keys(DEMO_PROFILE.facts);
const rect = { x: 0, y: 0, width: 100, height: 20 };
const THRESHOLD = 0.7;

type Case = [label: string, kind: FieldKind, expected: string, extra?: Partial<CapturedField>];

function field(label: string, kind: FieldKind, extra: Partial<CapturedField> = {}): CapturedField {
  return { signature: `sig:${label}:${kind}`, label, kind, rect, ...extra };
}

function title([label, kind, expected, extra]: Case): string {
  const detail = extra ? ` ${JSON.stringify(extra)}` : "";
  return `${kind} "${label}"${detail} -> ${expected}`;
}

function run(cases: Case[], check: (confidence: number, c: Case) => void): void {
  for (const c of cases) {
    it(title(c), () => {
      const [label, kind, expected, extra] = c;
      const a = mapFieldToFact(field(label, kind, extra), factKeys);
      expect(a.factKey).toBe(expected);
      check(a.confidence, c);
    });
  }
}

const YES_NO = { options: [{ value: "", label: "Select..." }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }] };

const STANDARD: Case[] = [
  ["First Name", "text", "firstName"],
  ["First name *", "text", "firstName"],
  ["Legal first name", "text", "firstName"],
  ["Given name", "text", "firstName"],
  ["Given name(s)", "text", "firstName"],
  ["Forename", "text", "firstName"],
  ["Last Name", "text", "lastName"],
  ["Legal last name", "text", "lastName"],
  ["Surname", "text", "lastName"],
  ["Family name", "text", "lastName"],
  ["Last name (family name)", "text", "lastName"],
  ["Full name", "text", "fullName"],
  ["Full legal name", "text", "fullName"],
  ["Legal name", "text", "fullName"],
  ["Name", "text", "fullName"],
  ["Name *", "text", "fullName"],
  ["Name (first and last)", "text", "fullName"],
  ["First and last name", "text", "fullName"],
  ["Your name", "text", "fullName"],
  ["Candidate's full name", "text", "fullName"],
  ["Email", "email", "email"],
  ["E-mail", "email", "email"],
  ["Email address", "text", "email"],
  ["Email address (we'll never share it)", "email", "email"],
  ["Confirm email", "email", "email"],
  ["Re-enter email address", "email", "email"],
  ["Your email", "email", "email"],
  ["Phone", "tel", "phone"],
  ["Phone number", "tel", "phone"],
  ["Mobile number", "tel", "phone"],
  ["Mobile", "tel", "phone"],
  ["Cell phone", "text", "phone"],
  ["Telephone", "tel", "phone"],
  ["Contact number", "text", "phone"],
  ["Phone number (include country code)", "tel", "phone"],
  ["LinkedIn", "text", "linkedin"],
  ["LinkedIn URL", "url", "linkedin"],
  ["LinkedIn Profile", "text", "linkedin"],
  ["Linked In profile URL", "url", "linkedin"],
  ["GitHub", "url", "github"],
  ["GitHub URL", "text", "github"],
  ["Github profile", "url", "github"],
  ["Website", "url", "website"],
  ["Portfolio", "text", "website"],
  ["Link to portfolio", "url", "website"],
  ["Portfolio URL", "url", "website"],
  ["Personal website", "url", "website"],
  ["Website or portfolio", "text", "website"],
  ["School", "text", "school"],
  ["University", "text", "school"],
  ["School or University", "text", "school"],
  ["College/University", "text", "school"],
  ["School name", "text", "school"],
  ["Name of your school", "text", "school"],
  ["Institution", "select", "school"],
  ["Degree", "text", "degree"],
  ["Degree", "select", "degree"],
  ["Degree type", "select", "degree"],
  ["Discipline", "select", "major"],
  ["Major", "text", "major"],
  ["Field of study", "text", "major"],
  ["Area of study", "select", "major"],
  ["Expected graduation (MM/YYYY)", "text", "graduationDate"],
  ["Expected graduation date", "month", "graduationDate"],
  ["Graduation date", "date", "graduationDate"],
  ["Graduation year", "number", "graduationDate"],
  ["Year of graduation", "select", "graduationDate"],
  ["Anticipated graduation", "text", "graduationDate"],
  ["When do you expect to graduate?", "text", "graduationDate"],
  ["Are you legally authorized to work in the United States?", "select", "workAuthorization", YES_NO],
  ["Are you legally authorized to work in Canada?", "radio", "workAuthorization", YES_NO],
  ["Are you legally eligible to work in the country to which you are applying?", "select", "workAuthorization", YES_NO],
  ["Are you authorized to work for any employer in the US?", "radio", "workAuthorization", YES_NO],
  ["Work authorization", "select", "workAuthorization", YES_NO],
  ["Do you have the right to work in the UK?", "radio", "workAuthorization", YES_NO],
  ["I am authorized to work in the United States", "checkbox", "workAuthorization"],
  ["Will you now or in the future require sponsorship for employment visa status?", "select", "requiresSponsorship", YES_NO],
  ["Will you now, or in the future, require sponsorship for employment visa status (e.g. H-1B)?", "radio", "requiresSponsorship", YES_NO],
  ["Do you require visa sponsorship?", "radio", "requiresSponsorship", YES_NO],
  ["Do you need sponsorship to work in Canada?", "select", "requiresSponsorship", YES_NO],
  ["How did you hear about this job?", "select", "referralSource"],
  ["How did you hear about us?", "select", "referralSource"],
  ["How did you hear about this position?", "text", "referralSource"],
  ["How did you hear about our company?", "select", "referralSource"],
  ["How did you find out about this opportunity?", "radio", "referralSource"],
  ["How did you hear about us? (LinkedIn, Indeed, referral...)", "text", "referralSource"],
  ["Where did you hear about us?", "text", "referralSource"],
  ["Referral source", "select", "referralSource"],
  ["Country", "select", "country"],
  ["Country of residence", "select", "country"],
  ["Country/Region", "select", "country"],
  ["Country where you currently live", "text", "country"],
  ["State", "select", "province"],
  ["State/Province", "text", "province"],
  ["Province", "select", "province"],
  ["Province or Territory", "select", "province"],
  ["City", "text", "city"],
  ["City/Town", "text", "city"],
];

// Shown, but only just: looser phrasings, bare words, name/id hints and input types.
const LOOSE: Case[] = [
  ["Current location", "text", "location"],
  ["City, State", "text", "location"],
  ["City and Province", "text", "location"],
  ["Where are you currently based?", "text", "location"],
  ["Location", "text", "location"],
  ["Location (City)", "text", "location"],
  ["First", "text", "firstName"],
  ["Last", "text", "lastName"],
  ["Which university do you attend?", "text", "school"],
  ["Highest degree obtained", "text", "degree"],
  ["Program", "text", "degree"],
  ["What is your major?", "text", "major"],
  ["Class year", "select", "graduationDate"],
  ["What state do you live in?", "text", "province"],
  ["Country you are located in", "text", "country"],
  ["Link", "url", "website"],
  ["Blog", "url", "website"],
  ["Sponsorship", "select", "requiresSponsorship", YES_NO],
  ["Correo electrónico", "email", "email"],
  ["Numéro", "tel", "phone"],
  ["", "text", "lastName", { name: "applicant_last_name" }],
  ["", "text", "firstName", { name: "job_application[first_name]" }],
  ["", "text", "firstName", { name: "firstname" }],
  ["Contact", "text", "phone", { name: "phone" }],
  ["Profile", "url", "linkedin", { placeholder: "https://linkedin.com/in/you" }],
  ["", "text", "province", { id: "address_state" }],
];

const NEGATIVE: Case[] = [
  ["First language", "text", NONE],
  ["First choice of office", "text", NONE],
  ["Last employer", "text", NONE],
  ["Last day available", "text", NONE],
  ["Last day of employment", "date", NONE],
  ["Last four digits", "text", NONE],
  ["Name of reference", "text", NONE],
  ["Reference name", "text", NONE],
  ["Reference email", "email", NONE],
  ["Reference's LinkedIn", "url", NONE],
  ["Emergency contact name", "text", NONE],
  ["Emergency contact first name", "text", NONE],
  ["Emergency contact phone", "tel", NONE],
  ["Recruiter email", "email", NONE],
  ["Hiring manager's name", "text", NONE],
  ["Program manager name", "text", NONE],
  ["Supervisor phone number", "tel", NONE],
  ["Friend's email", "email", NONE],
  ["Phone type", "select", NONE],
  ["Phone type", "text", NONE],
  ["Phone extension", "text", NONE],
  ["Ext.", "text", NONE],
  ["Country code", "text", NONE],
  ["Country code", "select", NONE],
  ["Phone country code", "select", NONE],
  ["Zip code", "text", NONE],
  ["Postal code", "text", NONE],
  ["ZIP / Postal code", "text", NONE],
  ["Address line 1", "text", NONE],
  ["Street address", "text", NONE],
  ["Salary expectations", "text", NONE],
  ["Desired salary", "number", NONE],
  ["Start date", "date", NONE],
  ["Earliest start date", "text", NONE],
  ["Date of birth", "date", NONE],
  ["Preferred name", "text", NONE],
  ["Preferred first name", "text", NONE],
  ["Middle name", "text", NONE],
  ["Maiden name", "text", NONE],
  ["Nickname", "text", NONE],
  ["Username", "text", NONE],
  ["Email or username", "text", NONE],
  ["Email", "email", NONE, { autocomplete: "username" }],
  ["Current company", "text", NONE],
  ["Current employer", "text", NONE],
  ["Current title", "text", NONE],
  ["Company name", "text", NONE],
  ["Legal business name", "text", NONE],
  ["Company legal name", "text", NONE],
  ["Company website", "url", NONE],
  ["Company LinkedIn page", "url", NONE],
  ["Email me job alerts", "checkbox", NONE],
  ["Email me about future openings", "checkbox", NONE],
  ["Send me updates by email", "checkbox", NONE],
  ["Phone", "checkbox", NONE],
  ["Preferred contact method", "select", NONE, { options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] }],
  ["LinkedIn", "checkbox", NONE],
  ["LinkedIn", "radio", NONE],
  ["Apply with LinkedIn", "button", NONE],
  ["State your reason for leaving", "text", NONE],
  ["Reason for leaving", "text", NONE],
  ["Statement of purpose", "text", NONE],
  ["Answer to security question", "text", NONE],
  ["Captcha", "text", NONE],
  ["Enter the characters you see", "text", NONE],
  ["Coupon code", "text", NONE],
  ["Promo code", "text", NONE],
  ["Referral code", "text", NONE],
  ["Who referred you?", "text", NONE],
  ["Referred by", "text", NONE],
  ["Email address", "email", NONE, { context: "Subscribe to our newsletter" }],
  ["Enter your email to subscribe", "email", NONE],
  ["Email", "email", NONE, { name: "newsletter_email" }],
  ["Email Address", "email", NONE, { id: "mce-EMAIL", name: "EMAIL" }],
  ["Email", "email", NONE, { context: "Sign in to your account" }],
  ["Email", "email", NONE, { autocomplete: "email", context: "Stay in the loop" }],
  ["Cover letter", "file", NONE],
  ["Resume/CV", "file", NONE],
  ["Upload portfolio", "file", NONE],
  ["Years of experience", "number", NONE],
  ["GPA", "text", NONE],
  ["High school", "text", NONE],
  ["High school graduation year", "number", NONE],
  ["Did you graduate?", "select", NONE, YES_NO],
  ["Highest level of education completed", "select", NONE],
  ["School district", "text", NONE],
  ["Portfolio value", "text", NONE],
  ["Twitter handle", "text", NONE],
  ["Twitter URL", "url", NONE],
  ["GitHub username", "text", NONE],
  ["GitHub repository for your best project", "url", NONE],
  ["Country of birth", "select", NONE],
  ["Country of citizenship", "select", NONE],
  ["Nationality", "select", NONE],
  ["City of birth", "text", NONE],
  ["Are you willing to relocate?", "radio", NONE, YES_NO],
  ["Preferred location", "text", NONE],
  ["Job location", "text", NONE],
  ["Office location", "select", NONE],
  ["Type your full name to sign", "text", NONE],
  ["Signature", "text", NONE],
  ["Sponsor name", "text", NONE],
  ["Do you require sponsorship?", "text", NONE],
  ["Name", "text", NONE, { context: "References" }],
  ["Email", "email", NONE, { context: "Reference 1" }],
  ["Phone", "tel", NONE, { context: "Emergency contact", autocomplete: "tel" }],
  ["Name", "text", NONE, { context: "Education" }],
  ["Location", "text", NONE, { context: "Work experience" }],
  ["City", "text", NONE, { context: "Education" }],
  ["Subject", "text", NONE],
  ["Age", "number", NONE],
  ["Notice period", "text", NONE],
  ["Languages spoken", "text", NONE],
  ["T-shirt size", "select", NONE],
  ["Dietary restrictions", "text", NONE],
];

// The fact is plausible, but whose detail or which polarity is unclear: never shown at the default threshold.
const DOUBTFUL: Case[] = [
  ["Are you authorized to work without visa sponsorship?", "radio", "requiresSponsorship", YES_NO],
  ["Can you work in the US without requiring sponsorship?", "select", "requiresSponsorship", YES_NO],
  ["Do you have any restrictions on your right to work in the UK?", "radio", "workAuthorization", YES_NO],
  ["Work email", "email", "email"],
  ["School email", "email", "email"],
  ["Alternate email", "email", "email"],
  ["Work phone", "tel", "phone"],
  ["Alternate phone number", "tel", "phone"],
  ["Other website", "url", "website"],
];

const DEMOGRAPHIC: Case[] = [
  ["Gender", "select", NONE],
  ["Gender identity", "select", NONE],
  ["Race", "select", NONE],
  ["Race/Ethnicity", "select", NONE],
  ["Please select your ethnicity", "radio", NONE],
  ["Are you Hispanic/Latino?", "select", NONE, YES_NO],
  ["Veteran status", "select", NONE],
  ["Protected veteran status", "radio", NONE],
  ["Disability status", "select", NONE],
  ["Do you have a disability?", "radio", NONE, YES_NO],
  ["Pronouns", "text", NONE],
  ["Sexual orientation", "select", NONE],
  ["Select...", "select", NONE, { name: "gender" }],
  ["Name", "text", NONE, { context: "Voluntary Self-Identification of Disability" }],
  ["Please describe", "textarea", NONE, { context: "Equal Employment Opportunity" }],
];

const SEARCH: Case[] = [
  ["Search", "text", NONE],
  ["Search jobs", "text", NONE],
  ["Search for your school", "text", NONE],
  ["Find", "text", NONE, { inputType: "search" }],
  ["", "text", NONE, { placeholder: "Search by keyword" }],
  ["Name", "text", NONE, { name: "q" }],
  ["School", "text", NONE, { placeholder: "Search" }],
  ["City", "text", NONE, { id: "site-search" }],
  ["Filter results", "text", NONE],
];

const FREE_TEXT: Case[] = [
  ["Why do you want to work here?", "textarea", NEEDS_TEXT],
  ["Cover letter", "textarea", NEEDS_TEXT],
  ["Additional information", "textarea", NEEDS_TEXT],
  ["Describe a time when you disagreed with a teammate", "textarea", NEEDS_TEXT],
  ["Tell us why you are a good fit for this role", "text", NEEDS_TEXT],
  ["What are your salary expectations?", "textarea", NONE],
  ["What is your expected salary?", "text", NONE],
  ["When can you start?", "text", NONE],
  ["Address", "textarea", NONE],
  ["List your references", "textarea", NONE],
  ["How many years of experience do you have with React?", "text", NONE],
  ["Where can we see your work?", "text", NEEDS_TEXT],
  ["What is your current job title?", "text", NONE],
  ["Where do you currently work?", "text", NONE],
  ["Who referred you to this role?", "text", NONE],
  ["Are you comfortable working on site?", "text", NONE],
];

describe("real-world labels", () => {
  describe("standard phrasings map confidently", () => run(STANDARD, (c) => expect(c).toBeGreaterThanOrEqual(0.9)));

  describe("loose matches are shown with less certainty", () =>
    run(LOOSE, (c) => {
      expect(c).toBeGreaterThanOrEqual(0.72);
      expect(c).toBeLessThan(0.9);
    }));

  describe("look-alikes map to nothing", () => run(NEGATIVE, () => undefined));

  describe("ambiguous questions stay below the threshold", () => run(DOUBTFUL, (c) => expect(c).toBeLessThan(THRESHOLD)));

  describe("demographic questions are a confident none (no model is asked either)", () => run(DEMOGRAPHIC, (c) => expect(c).toBeGreaterThanOrEqual(0.9)));

  describe("search boxes are a confident none", () => run(SEARCH, (c) => expect(c).toBeGreaterThanOrEqual(0.9)));

  describe("free text is only for prose a model can write", () => run(FREE_TEXT, () => undefined));

  it("holds at least 120 labelled cases", () => {
    const total = [STANDARD, LOOSE, NEGATIVE, DOUBTFUL, DEMOGRAPHIC, SEARCH, FREE_TEXT].reduce((n, group) => n + group.length, 0);
    expect(total).toBeGreaterThanOrEqual(120);
  });
});

describe("kind-aware mapping", () => {
  const choiceKinds: FieldKind[] = ["checkbox", "radio"];
  const textFacts = ["First name", "Last name", "Full name", "Email", "Phone", "LinkedIn", "GitHub", "Website", "City", "Current location"];

  it("never puts a text fact onto a checkbox or radio", () => {
    for (const kind of choiceKinds) for (const label of textFacts) expect(mapFieldToFact(field(label, kind), factKeys).factKey, `${kind} ${label}`).toBe(NONE);
  });

  it("never puts a text fact onto a checkbox or radio through autocomplete or hints either", () => {
    expect(mapFieldToFact(field("Same as above", "checkbox", { autocomplete: "email" }), factKeys).factKey).toBe(NONE);
    expect(mapFieldToFact(field("Contact me", "radio", { name: "phone" }), factKeys).factKey).toBe(NONE);
  });

  it("keeps the email fact on text and email inputs only", () => {
    for (const kind of ["tel", "url", "number", "date", "month", "select", "checkbox", "radio"] as FieldKind[]) {
      expect(mapFieldToFact(field("Email", kind), factKeys).factKey, kind).toBe(NONE);
    }
  });

  it("keeps yes/no facts off text inputs", () => {
    expect(mapFieldToFact(field("Work authorization", "text"), factKeys).factKey).toBe(NONE);
    expect(mapFieldToFact(field("Visa sponsorship required", "text"), factKeys).factKey).toBe(NONE);
  });

  it("lets selects take the facts that come as lists", () => {
    for (const [label, key] of [["Country", "country"], ["State", "province"], ["Degree", "degree"], ["Graduation year", "graduationDate"], ["How did you hear about us?", "referralSource"]] as const) {
      expect(mapFieldToFact(field(label, "select"), factKeys).factKey).toBe(key);
    }
  });
});

describe("the demo application form (demo/src/pages/apply)", () => {
  const demo: Case[] = [
    ["First name", "text", "firstName", { name: "firstName", id: "first-name", autocomplete: "given-name", context: "Personal information" }],
    ["Last name", "text", "lastName", { name: "lastName", id: "last-name", autocomplete: "family-name", context: "Personal information" }],
    ["Email", "email", "email", { name: "email", id: "email", autocomplete: "email", context: "Personal information" }],
    ["Phone", "tel", "phone", { name: "phone", id: "phone", autocomplete: "tel", context: "Personal information" }],
    ["Current location", "text", "location", { name: "location", id: "location", autocomplete: "off", context: "Personal information" }],
    ["LinkedIn profile", "url", "linkedin", { name: "linkedin", id: "linkedin", autocomplete: "url", context: "Links" }],
    ["GitHub profile", "url", "github", { name: "github", id: "github", autocomplete: "url", context: "Links" }],
    ["Portfolio or website", "url", "website", { name: "website", id: "website", autocomplete: "url", context: "Links" }],
    ["School", "text", "school", { name: "school", id: "school", context: "Education" }],
    ["Degree", "text", "degree", { name: "degree", id: "degree", context: "Education" }],
    ["Expected graduation date", "month", "graduationDate", { name: "graduationDate", id: "graduation-date", context: "Education" }],
    ["Are you legally authorized to work in Canada?", "select", "workAuthorization", { name: "workAuthorization", id: "work-authorization", context: "Work eligibility" }],
    ["Will you now or in the future require sponsorship?", "radio", "requiresSponsorship", { name: "sponsorship", context: "Work eligibility" }],
    ["How did you hear about us?", "select", "referralSource", { name: "referralSource", id: "referral-source", context: "A few questions" }],
  ];

  describe("maps all 14 profile-backed fields at 0.85 or better", () => run(demo, (c) => expect(c).toBeGreaterThanOrEqual(0.85)));

  it("survives the form-level pass unchanged", () => {
    const fields = demo.map(([label, kind, , extra]) => field(label, kind, extra));
    expect(mapFormHeuristically(fields, factKeys).map((a) => a.factKey)).toEqual(demo.map(([, , expected]) => expected));
  });
});

describe("mapFormHeuristically", () => {
  it("leaves a page whose only mappable field is an email alone (newsletter box, login)", () => {
    const fields = [field("Email", "email"), field("Go", "button")];
    expect(mapFormHeuristically(fields, factKeys).map((a) => a.factKey)).toEqual([NONE, NONE]);
  });

  it("keeps the email of a real form", () => {
    const fields = [field("Name", "text"), field("Email", "email"), field("Message", "textarea")];
    expect(mapFormHeuristically(fields, factKeys).map((a) => a.factKey)).toEqual(["fullName", "email", NEEDS_TEXT]);
  });

  it("does not repeat a fact on a loosely matched second field", () => {
    const fields = [field("Website", "url"), field("Link", "url"), field("Email", "email"), field("Confirm email", "email")];
    expect(mapFormHeuristically(fields, factKeys).map((a) => a.factKey)).toEqual(["website", NONE, "email", "email"]);
  });
});
