import { describe, expect, it } from "vitest";
import {
  ANSWER_COUNTER_NAMES,
  DEFAULT_SETTINGS,
  DEMO_PROFILE,
  LONG_SHOT_CONFIDENCE,
  LearnedAnswerStore,
  NEEDS_TEXT,
  answerCounterName,
  answerProposedEvent,
  confidenceBucket,
  neutralOption,
  proposeAnswer,
  recordCorrection,
  type AnswerContext,
  type AnswerProposal,
  type FieldKind,
  type FieldOption,
  type Profile,
  type QuestionField,
} from "../src";

function q(label: string, kind: FieldKind = "select", extra: Partial<QuestionField> = {}): QuestionField {
  return { label, kind, ...extra };
}

const EMPTY: Profile = { facts: {}, pastAnswers: [] };
const AT = Date.parse("2026-09-19T12:00:00.000Z");

const YES_NO: FieldOption[] = [
  { value: "1", label: "Yes" },
  { value: "0", label: "No" },
];
// Another site's wording of the same two answers: same question, different values.
const LEVER_YES_NO: FieldOption[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];
const GREENHOUSE_GENDER: FieldOption[] = [
  { value: "1", label: "Male" },
  { value: "2", label: "Female" },
  { value: "3", label: "Decline To Self Identify" },
];
const WORKDAY_GENDER: FieldOption[] = [
  { value: "m", label: "Man" },
  { value: "w", label: "Woman" },
  { value: "x", label: "Prefer not to answer" },
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

// The six questions Shabang used to leave empty on the real Viam application, worded exactly as the live
// Safari capture recorded them (desktop/tests/fixtures/greenhouse-safari-viam.json).
const VIAM_AUTH = q("Are you legally authorized to work in the United States for any employer?", "select", { options: YES_NO });
const VIAM_SOURCE = q("How did you hear about this opportunity at Viam?", "select", { options: REFERRAL_SOURCES });
const VIAM_GENDER = q("Gender", "select", { options: GREENHOUSE_GENDER });
const VIAM_HISPANIC = q("Are you Hispanic/Latino?", "select", { options: GREENHOUSE_HISPANIC });
const VIAM_VETERAN = q("Veteran Status", "select", { options: GREENHOUSE_VETERAN });
const VIAM_DISABILITY = q("Disability Status", "select", { options: GREENHOUSE_DISABILITY });
const VIAM_FORM = [VIAM_AUTH, VIAM_SOURCE, VIAM_GENDER, VIAM_HISPANIC, VIAM_VETERAN, VIAM_DISABILITY];

function propose(field: QuestionField, ctx: Partial<AnswerContext> = {}): AnswerProposal {
  return proposeAnswer(field, { profile: EMPTY, ...ctx });
}

const withDemo = (extra: Partial<AnswerContext> = {}): Partial<AnswerContext> => ({ profile: DEMO_PROFILE, ...extra });
const DECLINING: Partial<AnswerContext> = { settings: { answerProtectedWithDecline: true } };

describe("proposeAnswer: the Viam application, finished", () => {
  it("guesses No for US work authorization the Canadian profile does not claim", () => {
    const p = propose(VIAM_AUTH, withDemo());
    expect(p.class).toBe("declaration");
    expect(p.country).toBe("US");
    expect(p.source).toBe("guess");
    expect(p.optionLabel).toBe("No");
    expect(p.value).toBe("0");
    expect(p.confidence).toBe(0.7);
    expect(p.needsReview).toBe(true);
    expect(p.reason).toContain("check this");
  });

  it("answers the referral question with the most neutral option when the profile's own answer is not offered", () => {
    const p = propose(VIAM_SOURCE, withDemo());
    expect(p.source).toBe("guess");
    expect(p.optionLabel).toBe("Other");
    expect(p.confidence).toBe(0.72);
    expect(p.class).toBe("ordinary");
  });

  it("uses the profile's own referral source when the form offers it", () => {
    const offered = q("How did you hear about this opportunity at Viam?", "select", {
      options: [...REFERRAL_SOURCES, { value: "6", label: "Hack the North" }],
    });
    const p = propose(offered, withDemo());
    expect(p.source).toBe("fact");
    expect(p.factKey).toBe("referralSource");
    expect(p.optionLabel).toBe("Hack the North");
    expect(p.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("proposes nothing at all for the four EEO questions by default", () => {
    for (const field of [VIAM_GENDER, VIAM_HISPANIC, VIAM_VETERAN, VIAM_DISABILITY]) {
      const p = propose(field, withDemo());
      expect(p.class).toBe("protected");
      expect(p.source).toBe("none");
      expect(p.value).toBe("");
      expect(p.reason).toContain("only you can answer");
    }
  });

  it("declines them, in the form's own words, once the user turns that setting on", () => {
    const declined: Array<[QuestionField, string]> = [
      [VIAM_GENDER, "Decline To Self Identify"],
      [VIAM_HISPANIC, "Decline To Self Identify"],
      [VIAM_VETERAN, "I don't wish to answer"],
      [VIAM_DISABILITY, "I do not want to answer"],
    ];
    for (const [field, label] of declined) {
      const p = propose(field, withDemo(DECLINING));
      expect(p.source).toBe("fact");
      expect(p.optionLabel).toBe(label);
      expect(p.confidence).toBe(0.8);
      expect(p.reason).toBe("declined by setting");
      expect(p.needsReview).toBe(false);
    }
  });

  it("leaves no question of the form unanswered", () => {
    for (const field of VIAM_FORM) {
      const p = propose(field, withDemo(DECLINING));
      expect(p.source, field.label).not.toBe("none");
      expect(p.value, field.label).not.toBe("");
      expect(p.confidence, field.label).toBeGreaterThanOrEqual(0.7);
    }
  });
});

describe("proposeAnswer: declarations", () => {
  const cases: Array<[string, FieldOption[], string, Partial<Profile["facts"]>?]> = [
    ["Are you legally authorized to work in the United States for any employer?", YES_NO, "No"],
    ["Are you authorized to work in the United States?", YES_NO, "No"],
    ["Are you legally authorized to work in Canada?", YES_NO, "No"],
    ["Do you have the right to work in the UK?", YES_NO, "No"],
    ["Will you now or in the future require sponsorship for employment visa status?", YES_NO, "Yes"],
    ["Do you now, or will you in the future, require sponsorship to work in the United States?", YES_NO, "Yes"],
    ["Do you require a work permit to be employed in Australia?", YES_NO, "Yes"],
    ["Are you able to work in the EU without sponsorship?", YES_NO, "No"],
    ["Are you at least 18 years of age?", YES_NO, "Yes"],
    ["Have you ever been convicted of a felony?", YES_NO, "No"],
    ["Have you ever been convicted of a crime, other than a minor traffic violation?", YES_NO, "No"],
    ["Do you hold an active security clearance?", YES_NO, "No"],
    ["Are you bound by a non-compete or non-solicitation agreement?", YES_NO, "No"],
    ["Are you subject to ITAR export control restrictions?", YES_NO, "No"],
  ];

  for (const [label, options, expected] of cases) {
    it(`an empty profile answers "${label}" with ${expected}, flagged`, () => {
      const p = propose(q(label, "select", { options }));
      expect(p.class).toBe("declaration");
      expect(p.source).toBe("guess");
      expect(p.optionLabel).toBe(expected);
      expect(p.confidence).toBe(0.7);
      expect(p.needsReview).toBe(true);
    });
  }

  it("answers the profile's own country from the country-qualified fact, not from a guess", () => {
    const p = propose(q("Are you legally authorized to work in Canada?", "select", { options: YES_NO }), withDemo());
    expect(p.source).toBe("fact");
    expect(p.factKey).toBe("workAuthorization.CA");
    expect(p.optionLabel).toBe("Yes");
    expect(p.confidence).toBe(0.95);
    expect(p.needsReview).toBe(false);
  });

  it("falls back to the unqualified fact only when the question names no country", () => {
    const anywhere = propose(q("Will you now or in the future require sponsorship for employment visa status?", "select", { options: YES_NO }), withDemo());
    expect(anywhere.source).toBe("fact");
    expect(anywhere.factKey).toBe("requiresSponsorship");
    expect(anywhere.optionLabel).toBe("No");
    // The same question, scoped to a country the profile says nothing about, is a guess again.
    const inTheUs = propose(q("Will you now or in the future require sponsorship to work in the United States?", "select", { options: YES_NO }), withDemo());
    expect(inTheUs.source).toBe("guess");
    expect(inTheUs.optionLabel).toBe("Yes");
  });

  it("uses an old unqualified profile as a fallback when the question names the profile's own country", () => {
    const legacy: Profile = { facts: { country: "Canada", workAuthorization: "yes" }, pastAnswers: [] };
    const p = propose(q("Are you legally authorized to work in Canada?", "select", { options: YES_NO }), { profile: legacy });
    expect(p.source).toBe("fact");
    expect(p.factKey).toBe("workAuthorization");
    expect(p.optionLabel).toBe("Yes");
    expect(p.confidence).toBe(0.85);
    // ...and never for another country.
    const us = propose(q("Are you legally authorized to work in the United States?", "select", { options: YES_NO }), { profile: legacy });
    expect(us.source).toBe("guess");
    expect(us.optionLabel).toBe("No");
  });

  it("reads a US fact the user taught it earlier as a fact, not a guess", () => {
    const taught: Profile = { ...DEMO_PROFILE, facts: { ...DEMO_PROFILE.facts, "workAuthorization.US": "yes" } };
    const p = propose(VIAM_AUTH, { profile: taught });
    expect(p.source).toBe("fact");
    expect(p.factKey).toBe("workAuthorization.US");
    expect(p.optionLabel).toBe("Yes");
  });

  it("proposes an attestation, flagged, and a category question's least committal option", () => {
    const certify = propose(q("I certify that the information provided is true and complete to the best of my knowledge", "checkbox"));
    expect(certify.source).toBe("guess");
    expect(certify.action).toBe("check");
    expect(certify.value).toBe("true");
    expect(certify.needsReview).toBe(true);

    const clearance = propose(q("What is your security clearance level?", "select", {
      options: [{ value: "1", label: "None" }, { value: "2", label: "Secret" }, { value: "3", label: "Top Secret" }],
    }));
    expect(clearance.source).toBe("guess");
    expect(clearance.optionLabel).toBe("None");

    const visa = propose(q("What is your current visa status?", "select", {
      options: [{ value: "1", label: "US Citizen" }, { value: "2", label: "Permanent Resident" }, { value: "3", label: "H-1B" }, { value: "4", label: "Other" }],
    }));
    expect(visa.source).toBe("guess");
    expect(visa.optionLabel).toBe("Other");
  });

  it("never proposes the flattering side of a declaration", () => {
    for (const [label, options] of cases) {
      const p = propose(q(label, "select", { options }), withDemo());
      if (p.source !== "guess") continue;
      const flattering = /authorized|right to work|eligible/i.test(label) && !/require|need/i.test(label) ? "Yes" : null;
      if (flattering) expect(p.optionLabel).not.toBe(flattering);
    }
  });
});

describe("proposeAnswer: protected questions decline, or say so as a long shot", () => {
  const protectedQuestions: QuestionField[] = [
    VIAM_GENDER,
    VIAM_HISPANIC,
    VIAM_VETERAN,
    VIAM_DISABILITY,
    q("Race/Ethnicity", "select", { options: [{ value: "1", label: "Asian" }, { value: "2", label: "White" }, { value: "3", label: "Two or more races" }] }),
    q("Do you have a disability?", "select", { options: YES_NO }),
    q("Do you identify as LGBTQ+?", "select", { options: YES_NO }),
    q("Are you a member of a visible minority?", "select", { options: YES_NO }),
    q("Do you require any accommodations during the interview process?", "select", { options: YES_NO }),
    q("What are your pronouns?", "text"),
    q("Marital status", "select", { options: [{ value: "1", label: "Single" }, { value: "2", label: "Married" }] }),
    q("Age range", "select", { options: [{ value: "1", label: "18-24" }, { value: "2", label: "25-34" }] }),
  ];

  for (const field of protectedQuestions) {
    it(`never invents a characteristic for "${field.label}"`, () => {
      for (const ctx of [{}, withDemo()]) {
        const p = propose(field, ctx);
        expect(p.class, field.label).toBe("protected");
        // With the decline setting off, Shabang says nothing at all: the user opted out of these.
        expect(p.source, field.label).toBe("none");
      }
      // With it on, a guess is never dressed up as a fact and never passes hold-Tab unseen.
      const asked = propose(field, withDemo(DECLINING));
      expect(asked.class, field.label).toBe("protected");
      if (asked.source === "guess") {
        expect(asked.needsReview, field.label).toBe(true);
        expect(asked.confidence, field.label).toBeLessThan(DEFAULT_SETTINGS.confidenceThreshold);
        expect(asked.reason, field.label).toContain("check this");
      } else {
        expect(["fact", "none"], field.label).toContain(asked.source);
      }
    });
  }

  it("declines where the form offers a way to, and proposes a flagged long shot where it does not", () => {
    const withDecline = propose(VIAM_VETERAN, withDemo(DECLINING));
    expect(withDecline.source).toBe("fact");
    // docs/always-propose.md: not being able to decline is not a reason to leave the field empty.
    const withoutDecline = propose(q("Do you have a disability?", "select", { options: YES_NO }), withDemo(DECLINING));
    expect(withoutDecline.source).toBe("guess");
    expect(withoutDecline.optionLabel).toBe("No"); // the answer that claims the least, exactly as a declaration
    expect(withoutDecline.needsReview).toBe(true);
    expect(withoutDecline.confidence).toBe(LONG_SHOT_CONFIDENCE);
    expect(withoutDecline.reason).toContain("no way to decline");

    // A question that is not yes/no gets the least specific option it offers.
    const race = propose(
      q("Race/Ethnicity", "select", { options: [{ value: "1", label: "Asian" }, { value: "2", label: "White" }, { value: "3", label: "Two or more races" }] }),
      withDemo(DECLINING),
    );
    expect(race.source).toBe("guess");
    expect(race.optionLabel).toBe("Two or more races");

    // Nothing to choose from at all is the one case that legitimately proposes nothing.
    const open = propose(q("What are your pronouns?", "text"), withDemo(DECLINING));
    expect(open.source).toBe("none");
  });

  it("answers a protected question from an explicit profile fact", () => {
    const stated: Profile = { facts: { gender: "Female" }, pastAnswers: [] };
    const p = propose(VIAM_GENDER, { profile: stated });
    expect(p.source).toBe("fact");
    expect(p.factKey).toBe("gender");
    expect(p.optionLabel).toBe("Female");
  });
});

describe("proposeAnswer: ordinary questions", () => {
  it("says yes to a willingness question and claims the least on anything else", () => {
    const willing = propose(q("Are you willing to relocate to New York, NY?", "select", { options: YES_NO }));
    expect(willing.source).toBe("guess");
    expect(willing.optionLabel).toBe("Yes");
    expect(willing.confidence).toBe(0.72);

    const referred = propose(q("Did someone refer you to this role?", "select", { options: YES_NO }));
    expect(referred.optionLabel).toBe("No");
    expect(referred.confidence).toBe(0.72);
  });

  it("prefers an option that answers the question over one that ends it", () => {
    const options: FieldOption[] = [
      { value: "1", label: "LinkedIn" },
      { value: "2", label: "Prefer not to say" },
      { value: "3", label: "Other" },
    ];
    expect(neutralOption(options)?.label).toBe("Other");
    expect(neutralOption([{ value: "1", label: "Remote" }, { value: "2", label: "Hybrid" }])).toBeNull();
    // Never an option that signs something.
    expect(neutralOption([{ value: "1", label: "I certify that the above is true" }, { value: "2", label: "Yes" }])).toBeNull();
  });

  it("hands free text to the draft path and leaves a values-only field alone", () => {
    const prose = propose(q("Why do you want to work here?", "textarea"), withDemo());
    expect(prose.source).toBe("none");
    expect(prose.factKey).toBe(NEEDS_TEXT);

    // No neutral option and no yes/no side: still a proposal, as a flagged long shot (docs/always-propose.md).
    const size = propose(q("T-shirt size", "select", { options: [{ value: "1", label: "S" }, { value: "2", label: "M" }] }), withDemo());
    expect(size.source).toBe("guess");
    expect(size.confidence).toBe(LONG_SHOT_CONFIDENCE);
    expect(size.needsReview).toBe(true);
    expect(size.reason).toContain("claims the least");

    const consent = propose(q("I agree to receive occasional emails about other roles", "checkbox"), withDemo());
    expect(consent.source).toBe("none");
  });

  it("fills an ordinary field from the profile", () => {
    const p = propose(q("First name", "text"), withDemo());
    expect(p.source).toBe("fact");
    expect(p.factKey).toBe("firstName");
    expect(p.value).toBe("Alex");
    expect(p.action).toBe("fill");
  });

  it("never touches a sensitive field, or one that carries no answer", () => {
    for (const field of [q("Card number", "text"), q("Date of Birth", "date"), q("Social Insurance Number", "text")]) {
      const p = propose(field, withDemo(DECLINING));
      expect(p.source, field.label).toBe("none");
      expect(p.reason, field.label).toContain("sensitive");
    }
    expect(propose(q("Submit application", "button"), withDemo()).source).toBe("none");
    expect(propose(q("Attach resume", "file"), withDemo()).source).toBe("none");
  });
});

describe("learning from a correction", () => {
  const origin = "https://job-boards.greenhouse.io/viam";

  it("beats the guess after one correction, and is surer after two", () => {
    const store = new LearnedAnswerStore();
    const guess = propose(VIAM_AUTH, withDemo());
    const first = recordCorrection(VIAM_AUTH, "1", store, { now: AT, optionLabel: "Yes", origin, previous: guess });
    expect(first.changed).toBe("added");
    expect(first.event).toEqual({ event: "answer.corrected", class: "declaration", hadGhost: true, wasGuess: true });

    const once = propose(VIAM_AUTH, withDemo({ answers: store }));
    expect(once.source).toBe("learned");
    expect(once.optionLabel).toBe("Yes");
    expect(once.confidence).toBe(0.86);
    expect(once.needsReview).toBe(false);

    const second = recordCorrection(VIAM_AUTH, "1", store, { now: AT + 1000, optionLabel: "Yes", origin, previous: once });
    expect(second.changed).toBe("repeated");
    expect(second.learned?.count).toBe(2);
    expect(second.event.wasGuess).toBe(false);

    const twice = propose(VIAM_AUTH, withDemo({ answers: store }));
    expect(twice.confidence).toBe(0.94);
  });

  it("carries the answer to another company's form, in that form's own values", () => {
    const store = new LearnedAnswerStore();
    recordCorrection(VIAM_AUTH, "1", store, { now: AT, optionLabel: "Yes", origin });
    const lever = q("Are you legally authorized to work in the U.S. for any employer?", "select", { options: LEVER_YES_NO });
    const p = propose(lever, withDemo({ answers: store }));
    expect(p.source).toBe("learned");
    expect(p.value).toBe("yes");
    expect(p.optionLabel).toBe("Yes");
  });

  it("carries a decline to a site that words declining differently", () => {
    const store = new LearnedAnswerStore();
    recordCorrection(VIAM_GENDER, "3", store, { now: AT, optionLabel: "Decline To Self Identify", origin });
    const workday = q("Gender", "select", { options: WORKDAY_GENDER });
    const p = propose(workday, withDemo({ answers: store }));
    expect(p.source).toBe("learned");
    expect(p.optionLabel).toBe("Prefer not to answer");
    expect(p.value).toBe("x");
  });

  it("never turns a disclosed characteristic into a guess on a form that words its options differently", () => {
    const store = new LearnedAnswerStore();
    recordCorrection(VIAM_GENDER, "2", store, { now: AT, optionLabel: "Female", origin });
    expect(propose(VIAM_GENDER, withDemo({ answers: store })).optionLabel).toBe("Female");
    const workday = propose(q("Gender", "select", { options: WORKDAY_GENDER }), withDemo({ answers: store }));
    expect(workday.source).toBe("none");
  });

  it("learns what the user typed over ghost text, and reuses it on the next site", () => {
    const store = new LearnedAnswerStore();
    const field = q("How did you hear about this opportunity at Viam?", "text");
    recordCorrection(field, "Hack the North 2026", store, { now: AT, origin });
    const elsewhere = propose(q("How did you hear about this opportunity at Ashby?", "text"), withDemo({ answers: store }));
    expect(elsewhere.source).toBe("learned");
    expect(elsewhere.value).toBe("Hack the North 2026");
  });

  it("refuses to learn a secret, whatever the question looks like", () => {
    const store = new LearnedAnswerStore();
    const sensitiveField = recordCorrection(q("Card number", "text"), "4111 1111 1111 1111", store, { now: AT });
    expect(sensitiveField.changed).toBe("refused");
    expect(sensitiveField.refusal).toBe("sensitive-field");

    const secretValue = recordCorrection(q("Employee reference", "text"), "4111111111111111", store, { now: AT });
    expect(secretValue.refusal).toBe("secret-value");

    const nineDigits = recordCorrection(q("Membership id", "text"), "123 456 789", store, { now: AT });
    expect(nineDigits.refusal).toBe("secret-value");

    expect(store.size).toBe(0);
  });

  it("takes a bare timestamp as its fourth argument", () => {
    const store = new LearnedAnswerStore();
    const result = recordCorrection(q("What is your notice period?", "text"), "Two weeks", store, AT);
    expect(result.learned?.updatedAt).toBe(new Date(AT).toISOString());
    expect(result.event).toEqual({ event: "answer.corrected", class: "ordinary", hadGhost: false, wasGuess: false });
  });
});

describe("counters (docs/answers.md section 6)", () => {
  it("counts a proposal without carrying anything from the page", () => {
    const store = new LearnedAnswerStore();
    const guess = propose(VIAM_AUTH, withDemo());
    const proposed = answerProposedEvent(guess, false);
    expect(proposed).toEqual({ event: "answer.proposed", class: "declaration", source: "guess", accepted: false, confidenceBucket: 0.7 });
    expect(answerCounterName(proposed!)).toBe("answer.proposed.declaration.guess");

    const accepted = answerProposedEvent({ ...guess, source: "learned", confidence: 0.94 }, true);
    expect(answerCounterName(accepted!)).toBe("answer.accepted.declaration.learned");
    expect(accepted?.confidenceBucket).toBe(0.9);

    const corrected = recordCorrection(VIAM_AUTH, "1", store, { now: AT, optionLabel: "Yes", origin: "https://example.com", previous: guess });
    expect(answerCounterName(corrected.event)).toBe("answer.corrected.declaration");

    const raw = JSON.stringify([proposed, accepted, corrected.event]);
    for (const leak of ["Viam", "United States", "Yes", "example.com", "Alex", "authorized"]) expect(raw).not.toContain(leak);
  });

  it("nothing is counted for a question Shabang deliberately left alone", () => {
    expect(answerProposedEvent(propose(VIAM_GENDER, withDemo()), false)).toBeNull();
  });

  it("names every counter it can produce, so both clients can allow exactly these", () => {
    expect(ANSWER_COUNTER_NAMES).toHaveLength(21);
    expect(ANSWER_COUNTER_NAMES).toContain("answer.proposed.ordinary.guess");
    expect(ANSWER_COUNTER_NAMES).toContain("answer.accepted.protected.learned");
    expect(ANSWER_COUNTER_NAMES).toContain("answer.corrected.declaration");
    expect(new Set(ANSWER_COUNTER_NAMES).size).toBe(ANSWER_COUNTER_NAMES.length);
    expect(confidenceBucket(0.86)).toBe(0.8);
    expect(confidenceBucket(1)).toBe(1);
    expect(confidenceBucket(-1)).toBe(0);
  });
});

describe("a proposal never carries a value or a label in its reason", () => {
  it("explains itself in words that came from the code", () => {
    for (const field of VIAM_FORM) {
      for (const ctx of [{}, withDemo(), withDemo(DECLINING)]) {
        const p = propose(field, ctx);
        expect(p.reason).not.toContain(field.label);
        for (const option of field.options ?? []) expect(p.reason).not.toContain(option.label);
        expect(p.signature).not.toContain("Viam");
      }
    }
  });
});
