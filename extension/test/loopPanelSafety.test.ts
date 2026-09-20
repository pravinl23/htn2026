// The preview sheet in approach B's safety vocabulary (read / reversible / high-impact -> tab / review /
// explicit approval), and the sheet yielding Tab to a page that declared it owns the key (tabSurface.ts).
import type { LoopProgram } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopPanel } from "../src/content/loopPanel";
import type { DryRunRow } from "../src/content/dryRun";

const ORIGIN = "http://localhost:3000";

const PROGRAM: LoopProgram = {
  id: "loop-test",
  name: 'Copy 2 fields from /invoices/:id to /sheet and click "Reply: received"',
  iterator: { origin: ORIGIN, pathPattern: "/invoices", listSignature: "list:invoice-list", stride: 1, nextIndex: 2, itemPathPattern: "/invoices/:id" },
  steps: [
    { op: "open-item" },
    { op: "extract", var: "vendor", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "vendor" } } },
    { op: "click", target: { label: "Reply: received", kind: "button" }, locked: true },
    { op: "fill", target: { label: "B3", kind: "text", cell: { row: "next-empty", colHeader: "Vendor" } }, value: { var: "vendor" } },
  ],
  irreversible: [{ stepIndex: 2, description: "Reply: received" }],
  confidence: 0.95,
};

/** The same program with nothing irreversible left in it. */
const TAME: LoopProgram = {
  ...PROGRAM,
  irreversible: [],
  steps: PROGRAM.steps.filter((step) => step.op !== "click"),
};

function ready(index: number): DryRunRow {
  return { index, url: `${ORIGIN}/invoices/INV-${1001 + index}`, vars: { vendor: `Vendor ${index}` }, confidence: 1, missing: [] };
}

let panel: LoopPanel;

function open(program: LoopProgram): { onConfirm: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn();
  panel.show(
    { program, remaining: [2, 3], itemLabel: (i) => `Invoice ${i}`, initialRows: [ready(2), ready(3)] },
    { onConfirm, onDismiss: vi.fn(), onCancel: vi.fn(), onClose: vi.fn(), isUserEvent: () => true }, // jsdom cannot mint trusted events
  );
  return { onConfirm };
}

function host(): HTMLElement {
  const el = panel.host;
  if (!el) throw new Error("the sheet was never mounted");
  return el;
}

function chip(): string {
  return panel.shadow?.querySelector(".safety")?.textContent ?? "";
}

function tab(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-ghost-tab");
  panel = new LoopPanel(document);
});

afterEach(() => {
  panel.destroy();
  document.documentElement.removeAttribute("data-ghost-tab");
});

describe("the sheet's safety class", () => {
  it("names the class and the confirmation it demands, in approach B's words", () => {
    open(PROGRAM);
    expect(chip()).toBe("high-impact · explicit approval");
    expect(host().getAttribute("data-loop-safety")).toBe("high-impact");
    expect(host().getAttribute("data-loop-confirmation")).toBe("explicit");
    // Rule 2: the confirm control stays locked, so Tab can only ever focus it.
    expect(panel.shadow?.querySelector(".confirm")?.hasAttribute("data-ghost-lock")).toBe(true);
  });

  it("grades a batch with nothing irreversible in it as reversible", () => {
    open(TAME);
    expect(chip()).toBe("reversible · review approval");
    expect(host().getAttribute("data-loop-confirmation")).toBe("review");
  });
});

describe("the sheet and a page that owns Tab", () => {
  it("does not move focus onto the confirm button while the page's own surface is active", () => {
    open(PROGRAM);
    document.documentElement.setAttribute("data-ghost-tab", "active");
    expect(tab().defaultPrevented).toBe(false);
    expect(panel.shadow?.activeElement).toBeNull();
  });

  it("takes Tab to the confirm button again once the page gives it back", () => {
    open(PROGRAM);
    document.documentElement.removeAttribute("data-ghost-tab");
    expect(tab().defaultPrevented).toBe(true);
    expect(panel.shadow?.activeElement).toBe(panel.shadow?.querySelector(".confirm"));
  });
});
