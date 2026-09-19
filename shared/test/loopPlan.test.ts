import { describe, expect, it } from "vitest";
import { describeIrreversible, detectLoop, planRemaining, synthesizeProgram } from "../src";
import type { LoopProgram } from "../src";
import { invoiceFactsByUrl, invoiceSession } from "./helpers/traceBuilder";

function invoiceProgram(): LoopProgram {
  const tb = invoiceSession(2);
  const program = synthesizeProgram(detectLoop(tb.events(), tb.now)!, invoiceFactsByUrl());
  if (!program) throw new Error("expected a program");
  return program;
}

describe("planRemaining", () => {
  it("lists every remaining item from nextIndex", () => {
    const plan = planRemaining(invoiceProgram(), 50);
    expect(plan).toHaveLength(48);
    expect(plan[0]).toBe(2);
    expect(plan[47]).toBe(49);
  });

  it("skips handled items and respects the stride and the list bounds", () => {
    const program = invoiceProgram();
    expect(planRemaining(program, 6, [3, 4])).toEqual([2, 5]);
    expect(planRemaining(program, 6, new Set([2, 3, 4, 5]))).toEqual([]);
    expect(planRemaining(program, 2)).toEqual([]);
    const strided = { ...program, iterator: { ...program.iterator, stride: 2, nextIndex: 4 } };
    expect(planRemaining(strided, 9)).toEqual([4, 6, 8]);
    const upward = { ...program, iterator: { ...program.iterator, stride: -1, nextIndex: 2 } };
    expect(planRemaining(upward, 9, [1])).toEqual([2, 0]);
    expect(planRemaining({ ...program, iterator: { ...program.iterator, stride: 0 } }, 9)).toEqual([]);
  });
});

describe("describeIrreversible", () => {
  it("lists every irreversible effect with its count", () => {
    expect(describeIrreversible(invoiceProgram(), 48)).toEqual(["Reply: received x 48"]);
  });

  it("is empty when nothing will run or nothing is locked", () => {
    const program = invoiceProgram();
    expect(describeIrreversible(program, 0)).toEqual([]);
    expect(describeIrreversible({ ...program, irreversible: [] }, 48)).toEqual([]);
  });
});
