// docs/answers.md section 7: "Ghost never sends a learned answer, a protected value or a declaration to any
// server." Every case here is a route that used to carry one off the machine. `isSensitive` guards none of
// them: it knows passwords, cards and government IDs and has no protected or declaration vocabulary at all.
import { DEFAULT_SETTINGS, DEMO_PROFILE, NEEDS_TEXT } from "@ghost/shared";
import type { CapturedField, GhostSettings, Profile } from "@ghost/shared";
import { describe, expect, it } from "vitest";
import { buildTextRequest, similarPastAnswers } from "../src/content/freeText";
import { decideLearning } from "../src/content/learning";
import { draftableFields, predictableFields } from "../src/content/predict";
import type { PredictDeps } from "../src/content/predict";

const RECT = { x: 0, y: 0, width: 200, height: 32 };

function field(partial: Partial<CapturedField> & { signature: string; label: string }): CapturedField {
  return { kind: "text", value: "", rect: RECT, ...partial };
}

function deps(settings: Partial<GhostSettings> = {}, extra: Partial<PredictDeps> = {}): PredictDeps {
  return { profile: DEMO_PROFILE, settings: { ...DEFAULT_SETTINGS, ...settings }, ...extra };
}

const PAGE_CONTEXT = { company: "Northwind", role: "Robotics Engineer" };

/** The real Greenhouse "Voluntary Self-Identification" block, as capture reports it. */
const EEO: CapturedField[] = [
  field({
    signature: "gender", label: "Gender", kind: "select", context: "Voluntary Self-Identification",
    options: [{ value: "1", label: "Male" }, { value: "2", label: "Female" }, { value: "3", label: "Decline To Self Identify" }],
  }),
  field({
    signature: "hispanic", label: "Are you Hispanic/Latino?", kind: "select", context: "Voluntary Self-Identification",
    options: [{ value: "1", label: "Yes" }, { value: "2", label: "No" }, { value: "3", label: "Decline To Self Identify" }],
  }),
  field({
    signature: "veteran", label: "Veteran Status", kind: "select", context: "Voluntary Self-Identification",
    options: [
      { value: "1", label: "I am not a protected veteran" },
      { value: "2", label: "I identify as one or more of the classifications of a protected veteran" },
      { value: "3", label: "I don't wish to answer" },
    ],
  }),
];

describe("predictableFields never puts a protected question on the wire", () => {
  it("drops the whole self-identification block, label, section and options", () => {
    const wire = predictableFields([field({ signature: "first", label: "First name" }), ...EEO]);
    expect(wire.map((f) => f.signature)).toEqual(["first"]);
    const body = JSON.stringify(wire);
    for (const leak of ["Gender", "Hispanic", "Veteran", "Self-Identification", "Decline To Self Identify", "Male"]) {
      expect(body, leak).not.toContain(leak);
    }
  });

  it("agrees with the desktop client, which has refused these since it shipped", () => {
    // desktop/core/predict.ts forces a protected field to NONE rather than naming it to a server.
    expect(predictableFields(EEO)).toEqual([]);
  });

  it("still sends the ordinary questions, including a country-scoped declaration the server can map", () => {
    const fields = [
      field({ signature: "auth", label: "Are you legally authorized to work in the United States?", kind: "select" }),
      field({ signature: "how", label: "How did you hear about this opportunity?", kind: "select" }),
    ];
    expect(predictableFields(fields).map((f) => f.signature)).toEqual(["auth", "how"]);
  });
});

describe("no server drafts a protected or declaration free-text answer", () => {
  const prompts = [
    field({ signature: "accom", label: "Please describe any accommodations you need for the interview process", kind: "textarea" }),
    field({ signature: "conv", label: "Explain the circumstances of any conviction", kind: "textarea" }),
  ];

  it("buildTextRequest refuses to ask for the draft at all", () => {
    for (const prompt of prompts) {
      expect(buildTextRequest(prompt, DEMO_PROFILE, PAGE_CONTEXT), prompt.signature).toBeNull();
    }
    // An ordinary essay question is unaffected.
    const essay = field({ signature: "why", label: "Why do you want to work here?", kind: "textarea" });
    expect(buildTextRequest(essay, DEMO_PROFILE, PAGE_CONTEXT)).not.toBeNull();
  });

  it("draftableFields leaves them out, so the stream is never opened for one", () => {
    const facts = [
      field({ signature: "first", label: "First name", autocomplete: "given-name" }),
      field({ signature: "email", label: "Email", kind: "email" }),
    ];
    const assignments = [
      { signature: "first", factKey: "firstName", confidence: 0.97, source: "test", calibrated: true },
      { signature: "email", factKey: "email", confidence: 0.97, source: "test", calibrated: true },
      { signature: "accom", factKey: NEEDS_TEXT, confidence: 0.95, source: "test", calibrated: true },
      { signature: "conv", factKey: NEEDS_TEXT, confidence: 0.95, source: "test", calibrated: true },
      { signature: "why", factKey: NEEDS_TEXT, confidence: 0.95, source: "test", calibrated: true },
    ];
    const why = field({ signature: "why", label: "Why do you want to work here?", kind: "textarea" });
    const drafted = draftableFields([...facts, ...prompts, why], assignments, deps());
    expect(drafted.map((f) => f.signature)).toEqual(["why"]);
  });
});

describe("a protected or declaration answer never becomes a past answer", () => {
  const profile: Profile = { facts: {}, pastAnswers: [] };
  const mapping = { signature: "x", factKey: NEEDS_TEXT, confidence: 0.95 };
  const ANSWER = "I use a screen reader and would like extra time for the take-home exercise.";

  const decide = (label: string, value = ANSWER) =>
    decideLearning({
      field: field({ signature: "x", label, kind: "textarea" }),
      value,
      mapping: { ...mapping },
      profile,
      enabled: true,
    });

  it("keeps a disability, conviction or work-authorization answer out of profile.pastAnswers", () => {
    // `pastAnswers` is the one learned thing that leaves the machine: it rides in the /v1/ghost-text body.
    expect(decide("Please describe any accommodations you need for the interview process")).toBeNull();
    expect(decide("Explain the circumstances of any conviction")).toBeNull();
    expect(decide("Describe your current work authorization status")).toBeNull();
  });

  it("still learns an ordinary essay answer", () => {
    expect(decide("Why do you want to work here?")).toEqual({
      kind: "answer",
      question: "Why do you want to work here?",
      answer: ANSWER,
    });
  });
});

describe("an already-stored past answer is still not sent", () => {
  it("filters a protected or declaration question out of the request body", () => {
    const stored = [
      { question: "Please describe any accommodations you need for the interview process", answer: "I use a screen reader and need extra time." },
      { question: "Explain the circumstances of any conviction", answer: "A dismissed charge from 2019 with no conviction." },
      { question: "Describe the accommodations you need for the interview", answer: "Extra time, please, for the same reason." },
    ];
    const similar = similarPastAnswers("Please describe any accommodations you need for the interview process", stored);
    expect(similar).toEqual([]);
  });

  it("still carries an ordinary past answer through", () => {
    const stored = [{ question: "Why do you want to work here?", answer: "Because the robots are interesting and the team ships." }];
    const similar = similarPastAnswers("Why do you want to work here?", stored);
    expect(similar.map((p) => p.question)).toEqual(["Why do you want to work here?"]);
  });
});
