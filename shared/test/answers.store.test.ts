import { describe, expect, it } from "vitest";
import {
  LearnedAnswerStore,
  MAX_LEARNED_ANSWERS,
  MAX_LEARNED_VALUE_CHARS,
  learnedConfidence,
  looksSecretValue,
  questionSignature,
  refuseLearning,
  type FieldOption,
  type LearnedAnswersSnapshot,
  type QuestionField,
} from "../src";

function q(label: string, kind: QuestionField["kind"] = "text", extra: Partial<QuestionField> = {}): QuestionField {
  return { label, kind, ...extra };
}

const YES_NO: FieldOption[] = [
  { value: "1", label: "Yes" },
  { value: "0", label: "No" },
];
const AT = Date.parse("2026-09-19T12:00:00.000Z");

describe("LearnedAnswerStore", () => {
  it("keeps what the user answered, keyed by the question rather than the site", () => {
    const store = new LearnedAnswerStore();
    const field = q("Are you legally authorized to work in the United States for any employer?", "select", { options: YES_NO });
    const added = store.add({ field, value: "1", optionLabel: "Yes", origin: "https://a.example", now: AT });
    expect(added.changed).toBe("added");
    expect(added.answer?.signature).toBe(questionSignature(field));
    expect(added.answer?.class).toBe("declaration");
    expect(added.answer?.count).toBe(1);

    // The same question on another site, with that site's own option values.
    const elsewhere = q("Are you legally authorized to work in the U.S. for any employer?", "radio", {
      options: [{ value: "y", label: "Yes" }, { value: "n", label: "No" }],
    });
    expect(store.get(elsewhere)?.optionLabel).toBe("Yes");
  });

  it("counts a repeat, replaces a change of mind, and never mixes the two up", () => {
    const store = new LearnedAnswerStore();
    const field = q("What is your notice period?", "text");
    expect(store.add({ field, value: "Two weeks", now: AT }).changed).toBe("added");
    expect(store.add({ field, value: "two weeks", now: AT + 1 }).changed).toBe("repeated");
    expect(store.get(field)?.count).toBe(2);
    const changed = store.add({ field, value: "One month", now: AT + 2 });
    expect(changed.changed).toBe("replaced");
    expect(changed.answer?.count).toBe(1);
    expect(store.size).toBe(1);
  });

  it("falls back to the question without its options when another site words them differently", () => {
    const store = new LearnedAnswerStore();
    store.add({ field: q("Gender", "select", { options: [{ value: "1", label: "Female" }] }), value: "1", optionLabel: "Female", now: AT });
    const other = q("Gender", "select", { options: [{ value: "w", label: "Woman" }, { value: "m", label: "Man" }] });
    expect(store.get(other)?.optionLabel).toBe("Female");
    // A different question is still a different question.
    expect(store.get(q("Race", "select"))).toBeNull();
  });

  it("forgets one answer, and everything learned on one site", () => {
    const store = new LearnedAnswerStore();
    const kept = q("What is your notice period?", "text");
    const dropped = q("Are you willing to relocate?", "select", { options: YES_NO });
    store.add({ field: kept, value: "Two weeks", origin: "https://a.example", now: AT });
    store.add({ field: dropped, value: "1", optionLabel: "Yes", origin: "https://b.example", now: AT });
    expect(store.forget(questionSignature(dropped))).toBe(true);
    expect(store.forget("nothing like this")).toBe(false);
    expect(store.size).toBe(1);

    store.add({ field: dropped, value: "1", optionLabel: "Yes", origin: "https://b.example", now: AT });
    expect(store.forgetOrigin("https://b.example")).toBe(1);
    expect(store.size).toBe(1);
    expect(store.get(kept)).not.toBeNull();
  });

  it("keeps at most 500 answers, dropping the least recently used", () => {
    const store = new LearnedAnswerStore();
    for (let i = 0; i < MAX_LEARNED_ANSWERS + 20; i++) {
      store.add({ field: q(`Custom question number ${i}`, "text"), value: `answer ${i}`, now: AT + i });
    }
    expect(store.size).toBe(MAX_LEARNED_ANSWERS);
    expect(store.get(q("Custom question number 0", "text"))).toBeNull();
    expect(store.get(q("Custom question number 519", "text"))?.value).toBe("answer 519");
    // Answering an old question again moves it back to the top of the list.
    const revived = q("Custom question number 100", "text");
    store.add({ field: revived, value: "answer 100", now: AT });
    expect(store.list().at(-1)?.signature).toBe(questionSignature(revived));
  });

  it("caps a value at 2000 characters and keeps at most three origins", () => {
    const store = new LearnedAnswerStore();
    const field = q("Tell us about a project you are proud of", "textarea");
    const long = "x".repeat(MAX_LEARNED_VALUE_CHARS + 500);
    for (const [i, origin] of ["a", "b", "c", "d"].entries()) {
      store.add({ field, value: long, origin: `https://${origin}.example`, now: AT + i });
    }
    const learned = store.get(field);
    expect(learned?.value).toHaveLength(MAX_LEARNED_VALUE_CHARS);
    expect(learned?.origins).toEqual(["https://b.example", "https://c.example", "https://d.example"]);
  });

  it("survives a JSON round trip and drops anything malformed on the way back", () => {
    const store = new LearnedAnswerStore();
    const field = q("What is your notice period?", "text");
    store.add({ field, value: "Two weeks", now: AT });
    const snapshot = JSON.parse(JSON.stringify(store.toJSON())) as LearnedAnswersSnapshot;
    expect(LearnedAnswerStore.fromJSON(snapshot).get(field)?.value).toBe("Two weeks");

    const tampered = { max: 500, answers: [...snapshot.answers, { signature: "x" }, null, "nope"] } as unknown as LearnedAnswersSnapshot;
    expect(LearnedAnswerStore.fromJSON(tampered).size).toBe(1);
    expect(LearnedAnswerStore.fromJSON(null).size).toBe(0);
    expect(LearnedAnswerStore.fromJSON({ max: 10, answers: "not an array" } as unknown as LearnedAnswersSnapshot).size).toBe(0);
  });

  it("hands out copies, never the answers it holds", () => {
    const store = new LearnedAnswerStore();
    const field = q("What is your notice period?", "text");
    store.add({ field, value: "Two weeks", origin: "https://a.example", now: AT });
    const mine = store.get(field);
    mine!.value = "tampered";
    mine!.origins.push("https://evil.example");
    expect(store.get(field)?.value).toBe("Two weeks");
    expect(store.get(field)?.origins).toEqual(["https://a.example"]);
  });

  it("refuses what it must never keep", () => {
    expect(refuseLearning(q("What is your notice period?", "text"), "")).toBe("empty");
    expect(refuseLearning(q("Password", "text"), "hunter2")).toBe("sensitive-field");
    expect(refuseLearning(q("Social Insurance Number", "text"), "hello")).toBe("sensitive-field");
    expect(refuseLearning(q("Employee reference", "text"), "4111 1111 1111 1111")).toBe("secret-value");
    expect(refuseLearning(q("Membership id", "text"), "123456789")).toBe("secret-value");
    expect(refuseLearning(q("  ", "text"), "something")).toBe("unreadable-question");
    expect(refuseLearning(q("Submit", "button"), "clicked")).toBe("not-answerable");
    expect(refuseLearning(q("What is your notice period?", "text"), "Two weeks")).toBeNull();
    // Not every long number is a secret: a year, a salary, a phone extension.
    expect(looksSecretValue("2026")).toBe(false);
    expect(looksSecretValue("Two weeks")).toBe(false);
    expect(looksSecretValue("4111111111111111")).toBe(true);
  });

  it("is surer the second time the user says the same thing", () => {
    expect(learnedConfidence(1)).toBe(0.86);
    expect(learnedConfidence(2)).toBe(0.94);
    expect(learnedConfidence(9)).toBe(0.94);
  });
});
