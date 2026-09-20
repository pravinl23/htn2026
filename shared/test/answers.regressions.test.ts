// Ways the answer engine broke its own promises (docs/answers.md section 7). Each case here produced a
// proposal Shabang must never make: a flattering legal declaration, a claim about a protected characteristic,
// or a learned answer replayed onto the opposite question.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  LearnedAnswerStore,
  classifyQuestion,
  normalizeQuestion,
  proposeAnswer,
  questionSignature,
  type AnswerContext,
  type FieldKind,
  type FieldOption,
  type Profile,
  type QuestionField,
} from "../src";

function q(label: string, kind: FieldKind = "select", extra: Partial<QuestionField> = {}): QuestionField {
  return { label, kind, ...extra };
}

const YES_NO: FieldOption[] = [
  { value: "1", label: "Yes" },
  { value: "0", label: "No" },
];

/** The demo shape the finding was reproduced with: authorized in Canada, silent about everywhere else. */
const CANADIAN: Profile = {
  facts: { country: "Canada", "workAuthorization.CA": "yes", "requiresSponsorship.CA": "no" },
  pastAnswers: [],
};

function ctx(profile: Profile = CANADIAN, over: Partial<AnswerContext> = {}): AnswerContext {
  return { profile, settings: DEFAULT_SETTINGS, ...over };
}

function answer(label: string, kind: FieldKind = "select", extra: Partial<QuestionField> = {}, c: AnswerContext = ctx()) {
  return proposeAnswer(q(label, kind, { options: YES_NO, ...extra }), c);
}

describe("a declaration is never read as the flattering one because of a word in a subordinate clause", () => {
  it("does not let 'without restriction' turn a US authorization question into a Yes", () => {
    // "without restriction" qualifies the SCOPE of the authorization; it does not negate it.
    for (const label of [
      "Are you legally authorized to work in the United States without restriction?",
      "Are you eligible to work in the US without restriction?",
      "Are you legally authorized to work in the United States without any restrictions?",
      "Are you authorized to work in the U.S. without limitation?",
    ]) {
      const proposal = answer(label);
      expect(proposal.class).toBe("declaration");
      expect(proposal.country).toBe("US");
      expect(proposal.optionLabel).toBe("No");
      expect(proposal.source).toBe("guess");
      expect(proposal.needsReview).toBe(true);
    }
  });

  it("answers the control the same way, with and without the qualifier", () => {
    expect(answer("Are you legally authorized to work in the United States?").optionLabel).toBe("No");
    expect(answer("Are you legally entitled to work in the US with no restrictions?").optionLabel).toBe("No");
  });

  it("does not propose a self-incriminating Yes when the negation belongs to a relative clause", () => {
    for (const label of [
      "Have you been convicted of a felony that has not been expunged?",
      "Have you ever been convicted of a crime which has not been pardoned?",
      "Have you ever been convicted of a crime other than a minor traffic violation?",
    ]) {
      const proposal = answer(label);
      expect(proposal.topic).toBe("criminalRecord");
      expect(proposal.optionLabel).toBe("No");
    }
  });

  it("still reads a negation that IS the question's own predicate", () => {
    // "without sponsorship" negates the thing being asked about, so the conservative answer flips with it.
    expect(answer("Can you work in the US without sponsorship?").optionLabel).toBe("No");
    // "Do you REQUIRE a work permit?" is "are you authorized" the other way round.
    expect(answer("Do you require a work permit to work in the United States?").optionLabel).toBe("Yes");
    const box = answer("I have not been convicted of a felony", "checkbox", { options: [] });
    expect(box.value).toBe("true");
  });
});

describe("an unscoped declaration is never answered from a country-qualified fact", () => {
  it("does not answer 'will you require sponsorship' from requiresSponsorship.CA", () => {
    const proposal = answer("Will you now or in the future require sponsorship for employment visa status?");
    expect(proposal.source).not.toBe("fact");
    expect(proposal.source).toBe("guess");
    expect(proposal.needsReview).toBe(true);
    expect(proposal.optionLabel).toBe("Yes"); // sponsorship needed: the side that claims the less
    expect(proposal.confidence).toBeLessThan(0.85);
  });

  it("does not answer an unscoped authorization question from workAuthorization.CA", () => {
    const proposal = answer("Are you legally authorized to work for any employer?");
    expect(proposal.source).toBe("guess");
    expect(proposal.optionLabel).toBe("No");
  });

  it("still answers the country the profile actually states, as a fact", () => {
    const proposal = answer("Are you legally authorized to work in Canada for any employer?");
    expect(proposal.source).toBe("fact");
    expect(proposal.factKey).toBe("workAuthorization.CA");
    expect(proposal.optionLabel).toBe("Yes");
  });

  it("still honours an unqualified key as the fallback for a question that names no country", () => {
    const plain: Profile = { facts: { country: "Canada", workAuthorization: "yes" }, pastAnswers: [] };
    const proposal = answer("Are you legally authorized to work for any employer?", "select", {}, ctx(plain));
    expect(proposal.source).toBe("fact");
    expect(proposal.factKey).toBe("workAuthorization");
  });
});

describe("a protected characteristic is never stated as a bare Yes or No", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["Do you identify as a member of an underrepresented group?", "ethnicity"],
    ["Are you a member of an under-represented minority group?", "ethnicity"],
    ["Do you identify as BIPOC?", "ethnicity"],
    ["Are you a first-generation college student?", "ethnicity"],
    ["Are you currently pregnant or planning to start a family?", "familyStatus"],
    ["Do you have any children?", "familyStatus"],
    ["Which generation do you belong to?", "age"],
    ["Are you a millennial?", "age"],
  ];

  it("classifies them protected even with a bare Yes/No answer set and no decline option", () => {
    for (const [label, topic] of cases) {
      const classification = classifyQuestion(q(label, "select", { options: YES_NO }));
      expect(classification.class, label).toBe("protected");
      expect(classification.topic, label).toBe(topic);
    }
  });

  it("never returns the ordinary guess for them, which would state the claim", () => {
    for (const [label] of cases) {
      const proposal = answer(label);
      expect(proposal.class, label).toBe("protected");
      // Nothing above the guess floor, and always flagged: it is never presented as an answer the user gave.
      expect(proposal.needsReview || proposal.source === "none", label).toBe(true);
      expect(proposal.confidence, label).toBeLessThanOrEqual(0.7);
    }
  });

  it("takes the form's own way of declining when it offers one", () => {
    const withDecline: FieldOption[] = [...YES_NO, { value: "9", label: "I don't wish to answer" }];
    const proposal = answer("Do you identify as a member of an underrepresented group?", "select", { options: withDecline });
    expect(proposal.optionLabel).toBe("I don't wish to answer");
  });

  it("leaves an ordinary question ordinary", () => {
    expect(classifyQuestion(q("Are you willing to relocate?", "select", { options: YES_NO })).class).toBe("ordinary");
    expect(classifyQuestion(q("What is the average age of your users?", "text")).class).toBe("ordinary");
    expect(classifyQuestion(q("Do you need travel accommodations?", "select", { options: YES_NO })).class).toBe("ordinary");
  });
});

describe("'required' and 'optional' inside a question are part of the question", () => {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["Travel required?", "Travel optional?"],
    ["Is relocation required?", "Is relocation optional?"],
    ["Overtime required", "Overtime optional"],
    ["Weekend availability required", "Weekend availability optional"],
  ];

  it("does not hash opposite questions alike", () => {
    for (const [a, b] of pairs) {
      const first = questionSignature(q(a, "select", { options: YES_NO }));
      const second = questionSignature(q(b, "select", { options: YES_NO }));
      expect(first, `${a} vs ${b}`).not.toBe(second);
    }
  });

  it("does not replay an answer learned on one onto the other", () => {
    const store = new LearnedAnswerStore();
    store.add({ field: q("Travel required?", "select", { options: YES_NO }), value: "0", optionLabel: "No", class: "ordinary" });
    const other = proposeAnswer(q("Travel optional?", "select", { options: YES_NO }), ctx(CANADIAN, { answers: store }));
    expect(other.source).not.toBe("learned");
    const same = proposeAnswer(q("Travel required?", "select", { options: YES_NO }), ctx(CANADIAN, { answers: store }));
    expect(same.source).toBe("learned");
  });

  it("still strips a required MARKER, the way the requiredness rules read one", () => {
    expect(normalizeQuestion("Gender *")).toBe(normalizeQuestion("Gender"));
    expect(normalizeQuestion("Are you Hispanic/Latino? (required)")).toBe(normalizeQuestion("Are you Hispanic/Latino?"));
    expect(normalizeQuestion("First name - required")).toBe(normalizeQuestion("First name"));
    expect(normalizeQuestion("Required")).toBe("");
  });
});

describe("consenting to be screened is the user's to do", () => {
  it("does not tick a background, credit or drug screening consent box", () => {
    for (const label of [
      "I consent to a background check",
      "I consent to a credit check",
      "I agree to a drug screen",
    ]) {
      const proposal = answer(label, "checkbox", { options: [] });
      expect(proposal.class, label).toBe("declaration");
      expect(proposal.topic, label).toBe("backgroundCheck");
      expect(proposal.source, label).toBe("none");
      expect(proposal.value, label).toBe("");
    }
  });

  it("still answers a background-check question that is a control with no unanswered state", () => {
    const proposal = answer("Are you willing to complete a background check?");
    expect(proposal.source).toBe("guess");
    expect(proposal.needsReview).toBe(true);
    expect(proposal.optionLabel).toBe("Yes");
  });

  it("still proposes an attestation checkbox, flagged, as docs/answers.md section 1 asks", () => {
    const proposal = answer("I certify that the information provided is true and complete", "checkbox", { options: [] });
    expect(proposal.source).toBe("guess");
    expect(proposal.needsReview).toBe(true);
    expect(proposal.value).toBe("true");
  });
});
