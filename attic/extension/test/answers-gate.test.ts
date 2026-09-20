// The answer engine and the walk gate, wired into the extension (docs/answers.md, docs/incremental.md):
// every question gets a proposal, a guess says so, a protected question is never answered by a server,
// and no terminal action is proposed while a required field before it is still empty.
import { DEFAULT_SETTINGS, DEMO_PROFILE, LearnedAnswerStore, NONE } from "@ghost/shared";
import type { CapturedField, GhostSettings, Profile } from "@ghost/shared";
import { describe, expect, it } from "vitest";
import { ghostsFromAssignments, planForm } from "../src/content/predict";
import type { PredictDeps } from "../src/content/predict";
import type { ServedAssignment } from "../src/lib/messages";

const RECT = { x: 0, y: 0, width: 200, height: 32 };

function field(partial: Partial<CapturedField> & { signature: string; label: string }): CapturedField {
  return { kind: "text", value: "", rect: RECT, ...partial };
}

function deps(extra: Partial<PredictDeps> = {}, settings: Partial<GhostSettings> = {}): PredictDeps {
  return { profile: DEMO_PROFILE, settings: { ...DEFAULT_SETTINGS, ...settings }, ...extra };
}

const served = (signature: string, factKey: string, confidence = 0.95, calibrated = true): ServedAssignment =>
  ({ signature, factKey, confidence, calibrated });

const SUBMIT = field({ signature: "submit", label: "Submit application", kind: "button", inputType: "submit", locked: true, value: undefined });
const GENDER = field({
  signature: "gender", label: "Gender", kind: "select", context: "Voluntary self-identification",
  options: [{ value: "", label: "Select..." }, { value: "m", label: "Male" }, { value: "w", label: "Female" }, { value: "d", label: "I don't wish to answer" }],
});
const US_AUTH = field({
  signature: "us-auth", label: "Are you legally authorized to work in the United States?", kind: "select", required: true,
  options: [{ value: "", label: "Select..." }, { value: "yes", label: "Yes" }, { value: "no", label: "No" }],
});
const REFERRAL = field({
  signature: "referral", label: "How did you hear about us?", kind: "select",
  options: [{ value: "", label: "Select an option" }, { value: "Hack the North", label: "Hack the North" }, { value: "LinkedIn", label: "LinkedIn" }, { value: "Other", label: "Other" }],
});
/** Two fields Ghost answers from the profile: enough for it to believe the form is about the user. */
const OWN_FORM = [
  field({ signature: "first", label: "First name", autocomplete: "given-name" }),
  field({ signature: "email", label: "Email", kind: "email" }),
];

function ghostsOf(fields: CapturedField[], extra: Partial<PredictDeps> = {}): ReturnType<typeof ghostsFromAssignments> {
  return planForm(fields, [], deps(extra), "offline").ghosts;
}

describe("the answer engine inside the extension", () => {
  it("answers a protected question with the form's own decline option, as a fact and not a guessed one", () => {
    const ghost = ghostsOf([...OWN_FORM, GENDER]).find((g) => g.signature === "gender");
    expect(ghost).toMatchObject({ action: "select", value: "d", answerClass: "protected", answerSource: "fact" });
    // Declining is a true answer for anyone, so it is never SOURCED as a guess. At 0.8 it is still under the
    // confident tier, so it wears a "check this" chip and a held accept key stops on it (docs/always-propose.md).
    expect(ghost?.answerSource).toBe("fact");
    expect(ghost?.tier).toBe("guess");
    expect(ghost?.displayText).toBe("I don't wish to answer");
  });

  it("proposes nothing for a protected question when the user switched the decline setting off", () => {
    const off = ghostsOf([...OWN_FORM, GENDER], {}).length;
    const ghosts = planForm([...OWN_FORM, GENDER], [], deps({}, { answerProtectedWithDecline: false }), "offline").ghosts;
    expect(off).toBe(3);
    expect(ghosts.map((g) => g.signature)).toEqual(["first", "email"]);
  });

  it("never lets a server assignment answer a protected question", () => {
    const fields = [...OWN_FORM, GENDER];
    // The server claims the demographic select is the applicant's first name. The answer engine still owns it.
    const ghosts = planForm(fields, [served("gender", "firstName")], deps(), "server").ghosts;
    expect(ghosts.find((g) => g.signature === "gender")).toMatchObject({ value: "d", answerClass: "protected" });
  });

  it("guesses a declaration conservatively, marks it, and asks to be checked", () => {
    const ghost = ghostsOf([...OWN_FORM, US_AUTH]).find((g) => g.signature === "us-auth");
    // The demo profile is authorized in Canada and says nothing about the US: "No" claims the least.
    expect(ghost).toMatchObject({ value: "no", guess: true, answerClass: "declaration", answerSource: "guess" });
    expect(ghost?.confidence).toBeCloseTo(0.7, 5);
  });

  it("offers the most neutral option when no fact answers an ordinary question", () => {
    const withoutReferral: Profile = { ...DEMO_PROFILE, facts: { ...DEMO_PROFILE.facts } };
    delete withoutReferral.facts.referralSource;
    const ghost = ghostsOf([...OWN_FORM, REFERRAL], { profile: withoutReferral }).find((g) => g.signature === "referral");
    expect(ghost).toMatchObject({ value: "Other", guess: true, answerClass: "ordinary", answerSource: "guess" });
  });

  it("still proposes for an ordinary dropdown outside a form of the user's own details, as a long shot", () => {
    const lone = [REFERRAL, field({ signature: "search", label: "Search" })];
    const ghosts = ghostsOf(lone, { profile: { facts: {}, pastAnswers: [] } });
    // docs/always-propose.md: a page Ghost does not recognise is a reason to look unsure, never to go quiet.
    const referral = ghosts.find((g) => g.signature === "referral");
    expect(referral).toMatchObject({ value: "Other", guess: true, tier: "long-shot", answerSource: "guess" });
    expect(referral?.confidence).toBeLessThanOrEqual(0.5);
    expect(referral?.reason).toContain("does not look like a form about you");
  });

  it("lets an answer the user gave before beat the profile fact for the same question", () => {
    const answers = new LearnedAnswerStore();
    answers.add({ field: REFERRAL, value: "LinkedIn", optionLabel: "LinkedIn", origin: "https://jobs.example.com" });
    const ghosts = ghostsOf([...OWN_FORM, REFERRAL], { answers });
    // The profile says "Hack the North"; the user themselves said LinkedIn, and the user is the authority.
    expect(ghosts.find((g) => g.signature === "referral")).toMatchObject({ value: "LinkedIn", answerSource: "learned" });
    expect(ghosts.find((g) => g.signature === "referral")?.guess).toBeUndefined();
  });

  it("never proposes for a sensitive field, an already-answered one, or an action", () => {
    const fields = [
      ...OWN_FORM,
      field({ signature: "sin", label: "Social Insurance Number" }),
      field({ ...REFERRAL, signature: "answered", value: "LinkedIn" }),
      field({ signature: "resume", label: "Resume / CV", kind: "file", value: undefined }),
    ];
    expect(ghostsOf(fields).map((g) => g.signature)).toEqual(["first", "email"]);
  });

  it("leaves an ordinary field the server called 'not a fact' alone", () => {
    const fields = [...OWN_FORM, field({ signature: "note", label: "Anything else we should know?" })];
    const ghosts = planForm(fields, [served("note", NONE)], deps(), "server").ghosts;
    expect(ghosts.map((g) => g.signature)).toEqual(["first", "email"]);
  });
});

describe("the walk gate inside the extension", () => {
  const REQUIRED = field({ signature: "country", label: "Country", kind: "select", required: true, options: [{ value: "", label: "Select..." }, { value: "ca", label: "Canada" }] });

  it("withholds the Submit ghost while a required field before it is empty, and says why", () => {
    const plan = planForm([...OWN_FORM, REQUIRED, SUBMIT], [], deps(), "offline");
    // Country gets a ghost of its own from the profile, but a ghost nobody has accepted yet fills nothing.
    expect(plan.ghosts.map((g) => g.signature)).toEqual(["first", "email", "country"]);
    expect(plan.gate.terminalAllowed).toBe(false);
    expect(plan.gate.reason).toBe("1 required field still empty");
    expect(plan.gate.firstUnmetLabel).toBe("Country");
    // The walk still knows which button it is heading for, so the ghost can come back later.
    expect(plan.terminal).toBe("submit");
  });

  it("proposes the Submit ghost as soon as the required field holds an answer", () => {
    const answered = { ...REQUIRED, value: "ca" };
    const plan = planForm([...OWN_FORM, answered, SUBMIT], [], deps(), "offline");
    expect(plan.ghosts.map((g) => g.signature)).toContain("submit");
    expect(plan.gate.terminalAllowed).toBe(true);
    expect(plan.gate.reason).toBeUndefined();
  });

  it("counts a ghost the user has already accepted, but never one that is merely pending", () => {
    const fields = [...OWN_FORM, REQUIRED, SUBMIT];
    expect(planForm(fields, [], deps(), "offline").gate.terminalAllowed).toBe(false);
    const accepted = planForm(fields, [], deps({ accepted: ["country"] }), "offline");
    expect(accepted.gate.terminalAllowed).toBe(true);
    expect(accepted.ghosts.map((g) => g.signature)).toContain("submit");
  });

  it("lets an optional field stay empty without gating anything", () => {
    const optional = { ...REQUIRED, required: false };
    expect(planForm([...OWN_FORM, optional, SUBMIT], [], deps(), "offline").gate.terminalAllowed).toBe(true);
  });

  it("does not let a guess unlock the Submit on its own: the guess is still only pending", () => {
    const fields = [...OWN_FORM, US_AUTH, SUBMIT];
    const plan = planForm(fields, [], deps(), "offline");
    expect(plan.ghosts.find((g) => g.signature === "us-auth")?.guess).toBe(true);
    expect(plan.ghosts.map((g) => g.signature)).not.toContain("submit");
    expect(plan.gate.unmetRequired).toEqual(["us-auth"]);
  });
});
