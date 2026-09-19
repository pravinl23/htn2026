import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_FOR, classifyProgram, classifyStep, detectLoop, highImpactSteps, meetsConfirmation,
  requiredConfirmation, safetyChip, stricterSafety, synthesizeProgram,
} from "../src";
import type { LoopProgram, LoopStep } from "../src";
import { invoiceFactsByUrl, invoiceSession } from "./helpers/traceBuilder";

function invoiceProgram(): LoopProgram {
  const tb = invoiceSession(2);
  const candidate = detectLoop(tb.events(), tb.now);
  const program = candidate ? synthesizeProgram(candidate, invoiceFactsByUrl(), { total: 50 }) : null;
  if (!program) throw new Error("expected the canonical invoice program");
  return program;
}

const fill = (label: string, locked?: true): LoopStep => ({
  op: "fill",
  target: { label, kind: "text" },
  value: { const: "x" },
  ...(locked ? { locked } : {}),
});

describe("classifyStep", () => {
  it("grades navigation and extraction as read-only", () => {
    expect(classifyStep({ op: "open-item" })).toBe("read");
    expect(classifyStep({ op: "goto", origin: "https://x.test", pathPattern: "/a", url: "https://x.test/a" })).toBe("read");
    expect(classifyStep({ op: "extract", var: "total", from: { pathPattern: "/i/:id", locator: { by: "data-field", value: "total" } } })).toBe("read");
  });

  it("grades an ordinary fill or click reversible", () => {
    expect(classifyStep(fill("Total"))).toBe("reversible");
    expect(classifyStep({ op: "click", target: { label: "Next page", kind: "button" }, locked: false })).toBe("reversible");
  });

  it("grades a locked step, a listed effect and an irreversible LABEL as high-impact", () => {
    expect(classifyStep({ op: "click", target: { label: "Reply: received", kind: "button" }, locked: true })).toBe("high-impact");
    expect(classifyStep({ op: "click", target: { label: "Next page", kind: "button" }, locked: false }, true)).toBe("high-impact");
    // The flag is missing, but the words are not: a program cannot lower its own grade by omitting `locked`.
    expect(classifyStep({ op: "click", target: { label: "Send invoice", kind: "button" }, locked: false })).toBe("high-impact");
    expect(classifyStep(fill("Confirm payment"))).toBe("high-impact");
  });
});

describe("classifyProgram", () => {
  it("takes the strictest class in the program and maps it to a confirmation mode", () => {
    const program = invoiceProgram();
    expect(classifyProgram(program)).toBe("high-impact");
    expect(requiredConfirmation(program)).toBe("explicit");
    expect(safetyChip(program)).toBe("high-impact · explicit approval");
  });

  it("falls back to reversible when nothing irreversible is left, and to read when nothing acts", () => {
    const program = invoiceProgram();
    const tame: LoopProgram = {
      ...program,
      irreversible: [],
      steps: program.steps.filter((s) => s.op !== "click").map((s) => (s.op === "fill" ? { ...s, locked: undefined } : s)),
    };
    expect(classifyProgram(tame)).toBe("reversible");
    expect(requiredConfirmation(tame)).toBe("review");
    expect(safetyChip(tame)).toBe("reversible · review approval");

    const readOnly: LoopProgram = { ...tame, steps: tame.steps.filter((s) => s.op === "extract" || s.op === "open-item") };
    expect(classifyProgram(readOnly)).toBe("read");
    expect(requiredConfirmation(readOnly)).toBe("tab");
  });

  it("reports every high-impact step index, including ones the program did not list", () => {
    const program = invoiceProgram();
    const listed = program.irreversible.map((effect) => effect.stepIndex);
    expect(highImpactSteps(program)).toEqual(expect.arrayContaining(listed));
    const sneaky: LoopProgram = { ...program, irreversible: [], steps: [...program.steps, { op: "click", target: { label: "Submit", kind: "button" }, locked: false }] };
    expect(highImpactSteps(sneaky)).toContain(sneaky.steps.length - 1);
  });
});

describe("confirmation modes", () => {
  it("never accepts a weaker mode than the one required", () => {
    expect(CONFIRMATION_FOR).toEqual({ read: "tab", reversible: "review", "high-impact": "explicit" });
    expect(meetsConfirmation("explicit", "explicit")).toBe(true);
    expect(meetsConfirmation("review", "explicit")).toBe(false);
    expect(meetsConfirmation("tab", "review")).toBe(false);
    expect(meetsConfirmation(undefined, "tab")).toBe(false);
    // Asking for more than required is always allowed.
    expect(meetsConfirmation("explicit", "tab")).toBe(true);
    expect(meetsConfirmation("review", "review")).toBe(true);
  });

  it("stricterSafety is a max over the three classes", () => {
    expect(stricterSafety("read", "reversible")).toBe("reversible");
    expect(stricterSafety("high-impact", "reversible")).toBe("high-impact");
    expect(stricterSafety("read", "read")).toBe("read");
  });
});
