// The gate (docs/incremental.md): Ghost never proposes a step the page would reject.
// Every case here is a way the first implementation let Submit through while the form was still incomplete.
import { describe, expect, it } from "vitest";
import {
  applyGate,
  filledState,
  gateWalk,
  isDefinitelyEmpty,
  isFilled,
  isTerminalAction,
  reconcileAccepted,
  type CapturedField,
  type FieldKind,
  type Ghost,
} from "../src";

const RECT = { x: 0, y: 0, width: 100, height: 20 };

function f(signature: string, label: string, kind: FieldKind, extra: Partial<CapturedField> = {}): CapturedField {
  return { signature, label, kind, rect: RECT, ...extra };
}

function submit(extra: Partial<CapturedField> = {}): CapturedField {
  return f("submit", "Submit application", "button", { locked: true, ...extra });
}

function ghost(signature: string, extra: Partial<Ghost> = {}): Ghost {
  return { signature, action: "fill", value: "x", confidence: 0.9, rect: RECT, ...extra } as Ghost;
}

describe("gateWalk: a terminal action is withheld by every required field it could submit", () => {
  const country = f("country", "Country *", "select", { required: true, value: "", options: [{ value: "", label: "Select..." }, { value: "ca", label: "Canada" }] });

  it("withholds a submit button DECLARED BEFORE the field it submits (a sticky bar, a header action)", () => {
    // Capture order is document order, not visual order. The first implementation only counted the required
    // fields it had already walked past, so a submit bar at the top of the DOM was always allowed.
    const gate = gateWalk([submit(), country], []);
    expect(gate.unmetRequired).toEqual(["country"]);
    expect(gate.terminalAllowed).toBe(false);
    expect(gate.blockedTerminals).toEqual(["submit"]);
    expect(gate.allowedTerminals).toEqual([]);
    expect(gate.reason).toBe("1 required field still empty");
    expect(gate.firstUnmetLabel).toBe("Country");
  });

  it("never reports a reason and an allowed terminal in the same breath", () => {
    for (const fields of [[submit(), country], [country, submit()]]) {
      const gate = gateWalk(fields, []);
      expect(gate.reason).toBeDefined();
      expect(gate.allowedTerminals).toEqual([]);
      expect(applyGate([ghost("country"), ghost("submit")], gate).map((g) => g.signature)).toEqual(["country"]);
    }
  });

  it("proposes the terminal once the required field holds an answer, wherever it sits", () => {
    const answered = { ...country, value: "ca" };
    const gate = gateWalk([submit(), answered], []);
    expect(gate.unmetRequired).toEqual([]);
    expect(gate.terminalAllowed).toBe(true);
    expect(gate.allowedTerminals).toEqual(["submit"]);
    expect(applyGate([ghost("submit")], gate).map((g) => g.signature)).toEqual(["submit"]);
  });

  it("does not let one form's unmet field block another form's action, when capture says which form", () => {
    // A required search box in the site header must not withhold a newsletter Subscribe button.
    const search = f("search", "Search *", "text", { required: true, value: "", formId: "-" });
    const email = f("email", "Email *", "email", { required: true, value: "me@example.com", formId: "newsletter" });
    const subscribe = f("subscribe", "Subscribe", "button", { locked: true, formId: "newsletter" });
    const gate = gateWalk([search, email, subscribe], []);
    expect(gate.unmetRequired).toEqual(["search"]);
    expect(gate.allowedTerminals).toEqual(["subscribe"]);
    expect(gate.terminalAllowed).toBe(true);
  });

  it("blocks when membership is unknown: silence is never taken as 'a different form'", () => {
    const search = f("search", "Search *", "text", { required: true, value: "" });
    const subscribe = f("subscribe", "Subscribe", "button", { locked: true, formId: "newsletter" });
    expect(gateWalk([search, subscribe], []).blockedTerminals).toEqual(["subscribe"]);
  });

  it("blocks the step's own Continue and leaves another form's Submit alone", () => {
    const step1 = f("q1", "Full name *", "text", { required: true, value: "", formId: "step1" });
    const next = f("next", "Continue", "button", { formId: "step1" });
    const other = f("other-submit", "Send message", "button", { locked: true, formId: "contact" });
    const gate = gateWalk([step1, next, other], []);
    expect(gate.blockedTerminals).toEqual(["next"]);
    expect(gate.allowedTerminals).toEqual(["other-submit"]);
  });

  it("still lets an ACCEPTED ghost meet a required field, and a pending one still not", () => {
    const pending = gateWalk([country, submit()], [ghost("country")]);
    expect(pending.blockedTerminals).toEqual(["submit"]);
    const taken = gateWalk([country, submit()], [{ ...ghost("country"), accepted: true }]);
    expect(taken.allowedTerminals).toEqual(["submit"]);
    expect(gateWalk([country, submit()], [], { accepted: ["country"] }).allowedTerminals).toEqual(["submit"]);
  });

  it("leaves optional fields out of it", () => {
    const optional = f("why", "Why do you want this role? (optional)", "textarea", { value: "" });
    expect(gateWalk([optional, submit()], []).allowedTerminals).toEqual(["submit"]);
    expect(isTerminalAction(submit())).toBe(true);
  });
});

describe("reconcileAccepted: an acceptance stands only while the answer does", () => {
  it("retires the acceptance when the user clears the field, so Submit is withheld again", () => {
    const name = f("name", "First name *", "text", { required: true, value: "Alex" });
    let accepted = reconcileAccepted([name, submit()], ["name"]);
    expect([...accepted]).toEqual(["name"]);

    const cleared = { ...name, value: "" };
    accepted = reconcileAccepted([cleared, submit()], accepted);
    expect([...accepted]).toEqual([]);
    const gate = gateWalk([cleared, submit()], [], { accepted });
    expect(gate.unmetRequired).toEqual(["name"]);
    expect(gate.blockedTerminals).toEqual(["submit"]);
  });

  it("keeps an acceptance for a field that is no longer on the page at all", () => {
    expect([...reconcileAccepted([submit()], ["name"])]).toEqual(["name"]);
  });

  it("keeps an acceptance when capture cannot read the control: silence is not proof the answer went away", () => {
    // A react-select hides its chosen value in a child widget, and a file input rarely reports a filename.
    const combobox = f("how", "How did you hear about us? *", "other", { required: true, value: "" });
    const resume = f("resume", "Resume *", "file", { required: true, value: "" });
    const lazy = f("lazy", "Country *", "select", { required: true, value: "Canada" });
    expect([...reconcileAccepted([combobox, resume, lazy], ["how", "resume", "lazy"])].sort()).toEqual(["how", "lazy", "resume"]);
  });

  it("retires an unchecked consent box and an emptied select", () => {
    const box = f("agree", "I agree to the terms *", "checkbox", { required: true, value: "false" });
    const select = f("source", "How did you hear? *", "select", { required: true, value: "Select...", options: [{ value: "", label: "Select..." }, { value: "l", label: "LinkedIn" }] });
    expect([...reconcileAccepted([box, select], ["agree", "source"])]).toEqual([]);
  });
});

describe("filledState: unknown is not filled, and it is not empty either", () => {
  it("reads the placeholder wordings the canonical option filter reads, whitespace and all", () => {
    for (const value of ["Pick one", " Select...", "-- Choose one --", "Click to select", "Please choose", ""]) {
      expect(filledState(f("x", "Country *", "other", { value }))).toBe("empty");
    }
    expect(filledState(f("x", "Country *", "other", { value: "Canada" }))).toBe("filled");
    // "Selected" is a real answer, not a prompt: the prompt words only count as whole words.
    expect(filledState(f("x", "Status", "other", { value: "Selected" }))).toBe("filled");
  });

  it("calls a select with no captured options unknown, so it neither unlocks Submit nor retires an acceptance", () => {
    const lazy = f("lazy", "Country *", "select", { required: true, value: "Canada" });
    expect(filledState(lazy)).toBe("unknown");
    expect(isFilled(lazy)).toBe(false);
    expect(isDefinitelyEmpty(lazy)).toBe(false);
    expect(gateWalk([lazy, submit()], []).blockedTerminals).toEqual(["submit"]);
  });

  it("calls a radio group holding its own prompt text empty", () => {
    const radio = f("r", "Do you consent? *", "radio", { required: true, value: "Select one" });
    expect(filledState(radio)).toBe("empty");
  });

  it("still reads a genuinely chosen option as filled", () => {
    const select = f("s", "Country *", "select", {
      required: true,
      value: "ca",
      options: [{ value: "", label: "Select..." }, { value: "ca", label: "Canada" }],
    });
    expect(filledState(select)).toBe("filled");
    expect(gateWalk([select, submit()], []).allowedTerminals).toEqual(["submit"]);
  });
});
