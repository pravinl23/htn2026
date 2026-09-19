import type { LoopProgram } from "@ghost/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DryRunRow } from "../src/content/dryRun";
import { LoopPanel } from "../src/content/loopPanel";
import type { LoopPanelDeps, LoopPanelProposal, LoopRunRequest } from "../src/content/loopPanel";

const ORIGIN = "http://localhost:3000";

const PROGRAM: LoopProgram = {
  id: "loop-test",
  name: 'Copy 2 fields from /invoices/:id to /sheet and click "Reply: received"',
  iterator: { origin: ORIGIN, pathPattern: "/invoices", listSignature: "list:invoice-list", stride: 1, nextIndex: 2, itemPathPattern: "/invoices/:id" },
  steps: [
    { op: "open-item" },
    { op: "extract", var: "vendor", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "vendor" } } },
    { op: "extract", var: "total", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "total" } } },
    { op: "click", target: { label: "Reply: received", kind: "button" }, locked: true },
    { op: "goto", origin: ORIGIN, pathPattern: "/sheet", url: `${ORIGIN}/sheet` },
    { op: "fill", target: { label: "B3", kind: "text", cell: { row: "next-empty", colHeader: "Vendor" } }, value: { var: "vendor" } },
    { op: "fill", target: { label: "D3", kind: "text", cell: { row: "next-empty", colHeader: "Total" } }, value: { var: "total" } },
  ],
  irreversible: [{ stepIndex: 3, description: "Reply: received" }],
  confidence: 0.95,
};

/** An async iterable the test feeds by hand, like previewItems streaming rows in. */
function stream<T>(): { rows: AsyncIterable<T>; push(value: T): Promise<void>; end(): Promise<void> } {
  const queue: T[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const settle = async (): Promise<void> => {
    wake?.();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  async function* rows(): AsyncGenerator<T> {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) yield next;
      else if (closed) return;
      else await new Promise<void>((r) => (wake = r));
    }
  }
  return { rows: rows(), push: (value) => (queue.push(value), settle()), end: () => ((closed = true), settle()) };
}

function row(index: number, confidence: DryRunRow["confidence"] = 1, vars: Record<string, string> = { vendor: `Vendor ${index}`, total: `${index}.00` }): DryRunRow {
  const missing = confidence === 0 ? ["vendor", "total"].filter((name) => !(name in vars)) : [];
  return { index, url: `${ORIGIN}/invoices/INV-${1001 + index}`, vars, confidence, missing };
}

interface Harness {
  panel: LoopPanel;
  deps: { [K in "onConfirm" | "onDismiss" | "onCancel" | "onClose"]: ReturnType<typeof vi.fn> };
  feed: ReturnType<typeof stream<DryRunRow>>;
  abortPreview: ReturnType<typeof vi.fn>;
}

let panel: LoopPanel;

function open(extra: Partial<LoopPanelProposal> = {}, depsExtra: Partial<LoopPanelDeps> = {}, remaining = [2, 3, 4]): Harness {
  const feed = stream<DryRunRow>();
  const abortPreview = vi.fn();
  const deps = { onConfirm: vi.fn(), onDismiss: vi.fn(), onCancel: vi.fn(), onClose: vi.fn() };
  panel.show(
    { program: PROGRAM, remaining, itemLabel: (i) => `Invoice INV-${1001 + i}`, rows: feed.rows, abortPreview, ...extra },
    { ...deps, isUserEvent: () => true, ...depsExtra }, // jsdom cannot mint trusted events
  );
  return { panel, deps, feed, abortPreview };
}

async function openReady(extra: Partial<LoopPanelProposal> = {}, results: DryRunRow[] = [row(2), row(3), row(4)]): Promise<Harness> {
  const h = open(extra, {}, results.map((r) => r.index));
  for (const r of results) await h.feed.push(r);
  await h.feed.end();
  return h;
}

function host(): HTMLElement {
  const el = document.getElementById("ghost-loop-host");
  if (!el) throw new Error("loop host is missing");
  return el;
}

function part<T extends HTMLElement = HTMLElement>(selector: string): T {
  const el = panel.shadow?.querySelector<T>(selector);
  if (!el) throw new Error(`panel is missing ${selector}`);
  return el;
}

function gridRow(index: number): HTMLTableRowElement {
  return part<HTMLTableRowElement>(`tbody tr[data-index="${index}"]`);
}

function checkbox(index: number): HTMLInputElement {
  return part<HTMLInputElement>(`tbody tr[data-index="${index}"] input`);
}

function press(key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, composed: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = `<main><input id="page-field" /><button id="page-button">Page</button></main>`;
  panel = new LoopPanel(document);
});

afterEach(() => {
  panel.destroy();
});

describe("LoopPanel host", () => {
  it("mounts nothing until shown, then one host with a shadow root the page cannot open", async () => {
    expect(document.getElementById("ghost-loop-host")).toBeNull();
    expect(panel.state).toBe("hidden");
    await openReady();
    const hosts = document.querySelectorAll("#ghost-loop-host");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.parentElement).toBe(document.documentElement);
    expect(hosts[0]?.shadowRoot).toBeNull();
    expect(hosts[0]?.innerHTML).toBe("");
    expect(panel.host).toBe(hosts[0]);
    expect(host().style.pointerEvents).toBe("none"); // only the sheet inside takes pointer events
  });

  it("says what Ghost can do and which program it found", async () => {
    await openReady();
    expect(part(".headline").textContent).toBe("You did this twice. Ghost can do the remaining 3.");
    expect(part(".name").textContent).toBe(PROGRAM.name);
    expect([...part("thead tr").querySelectorAll("th")].map((th) => th.textContent)).toEqual(["", "#", "Item", "Vendor", "Total", ""]);
  });

  it("renders page strings as text, never as markup", async () => {
    const evil = `<img src=x onerror="window.__pwned = true">`;
    await openReady({ program: { ...PROGRAM, name: evil }, itemLabel: () => evil }, [row(2, 1, { vendor: evil, total: "1" })]);
    expect(panel.shadow?.querySelector("img")).toBeNull();
    expect(part(".name").textContent).toBe(evil);
    expect(gridRow(2).querySelector(".item")?.textContent).toBe(evil);
    expect(gridRow(2).querySelector('[data-var="vendor"]')?.textContent).toBe(evil);
  });

  it("destroy removes the host and stops listening", async () => {
    const h = await openReady();
    panel.destroy();
    expect(document.getElementById("ghost-loop-host")).toBeNull();
    expect(panel.host).toBeNull();
    expect(h.abortPreview).toHaveBeenCalled();
    expect(press("Escape").defaultPrevented).toBe(false);
    expect(h.deps.onDismiss).not.toHaveBeenCalled();
  });

  it("replaces a stale host left behind by an earlier instance", async () => {
    await openReady();
    const second = new LoopPanel(document);
    second.show({ program: PROGRAM, remaining: [2] }, { onConfirm: vi.fn(), onDismiss: vi.fn(), onCancel: vi.fn() });
    expect(document.querySelectorAll("#ghost-loop-host")).toHaveLength(1);
    second.destroy();
  });
});

describe("preview grid", () => {
  it("streams rows in as the dry run progresses", async () => {
    const h = open();
    expect(host().dataset.loopState).toBe("proposed");
    expect(host().dataset.loopRemaining).toBe("3");
    expect(host().dataset.loopPreview).toBe("streaming");
    expect(host().dataset.loopPreviewed).toBe("0");
    expect(panel.shadow?.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(gridRow(3).querySelector('[data-var="total"]')?.getAttribute("data-pending")).toBe("true");
    expect(checkbox(3).disabled).toBe(true);

    await h.feed.push(row(3)); // out of list order, as the pool finishes them
    expect(host().dataset.loopPreviewed).toBe("1");
    expect(gridRow(3).querySelector('[data-var="vendor"]')?.textContent).toBe("Vendor 3");
    expect(gridRow(3).querySelector('[data-var="total"]')?.hasAttribute("data-pending")).toBe(false);
    expect(gridRow(2).querySelector('[data-var="vendor"]')?.getAttribute("data-pending")).toBe("true");
    expect(part(".preview-note").textContent).toBe("Previewing 1 of 3");
    expect(part<HTMLButtonElement>(".confirm").disabled).toBe(true); // an exact count first, then the lock opens

    await h.feed.push(row(2));
    await h.feed.push(row(4));
    await h.feed.end();
    expect(host().dataset.loopPreview).toBe("ready");
    expect(host().dataset.loopChecked).toBe("3");
    expect(part<HTMLButtonElement>(".confirm").disabled).toBe(false);
    expect(part(".confirm-label").textContent).toBe("Run 3 items");
    expect(part(".preview-note").textContent).toBe("3 of 3 selected");
  });

  it("flags low-confidence rows amber and leaves them unchecked", async () => {
    await openReady({}, [row(2), row(3, 0.6), row(4, 0, { vendor: "Acme" })]);
    expect(checkbox(2).checked).toBe(true);
    expect(gridRow(2).dataset.flag).toBe("");
    expect(checkbox(3).checked).toBe(false);
    expect(checkbox(3).disabled).toBe(false);
    expect(gridRow(3).dataset.flag).toBe("low");
    expect(gridRow(3).querySelector(".note")?.textContent).toBe("Check values");
    expect(checkbox(4).checked).toBe(false);
    expect(checkbox(4).disabled).toBe(true); // nothing verifiable to run
    expect(gridRow(4).dataset.flag).toBe("missing");
    expect(gridRow(4).querySelector(".note")?.textContent).toBe("Missing: Total");
    expect(gridRow(4).querySelector('[data-var="total"]')?.getAttribute("data-missing")).toBe("true");
    expect(host().dataset.loopChecked).toBe("1");
    expect(part(".confirm-label").textContent).toBe("Run 1 item");
  });

  it("flags rows the dry run never reached", async () => {
    const h = open();
    await h.feed.push(row(2));
    await h.feed.end();
    expect(gridRow(3).dataset.flag).toBe("low");
    expect(checkbox(3).checked).toBe(false);
    expect(gridRow(3).querySelector(".note")?.textContent).toBe("Not previewed");
    expect(host().dataset.loopChecked).toBe("1");
  });

  it("without a dry run, a program with nothing to copy is ready at once and one with values is flagged", async () => {
    const clickOnly: LoopProgram = { ...PROGRAM, steps: [{ op: "open-item" }, { op: "click", target: { label: "Reply: received", kind: "button" }, locked: true }] };
    const deps = { onConfirm: vi.fn(), onDismiss: vi.fn(), onCancel: vi.fn() };
    panel.show({ program: clickOnly, remaining: [2, 3] }, deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(host().dataset.loopChecked).toBe("2");
    expect(part<HTMLButtonElement>(".confirm").disabled).toBe(false);
    expect(part(".effects-list").textContent).toBe("Reply: received x 2");

    panel.show({ program: PROGRAM, remaining: [2, 3] }, deps);
    await Promise.resolve();
    await Promise.resolve();
    expect(host().dataset.loopChecked).toBe("0");
    expect(gridRow(2).querySelector(".note")?.textContent).toBe("Not previewed");
    expect(part<HTMLButtonElement>(".confirm").disabled).toBe(true);
  });

  it("disables the confirm button when no row is checked", async () => {
    await openReady();
    for (const index of [2, 3, 4]) checkbox(index).click();
    expect(host().dataset.loopChecked).toBe("0");
    expect(part<HTMLButtonElement>(".confirm").disabled).toBe(true);
    expect(part<HTMLElement>(".effects").hidden).toBe(true);
    checkbox(3).click();
    expect(part<HTMLButtonElement>(".confirm").disabled).toBe(false);
    expect(part(".confirm-label").textContent).toBe("Run 1 item");
  });

  it("select-all toggles every row that can run", async () => {
    await openReady({}, [row(2), row(3, 0.6), row(4, 0, {})]);
    const all = part<HTMLInputElement>("thead input");
    expect(all.indeterminate).toBe(true);
    all.click();
    expect([checkbox(2).checked, checkbox(3).checked, checkbox(4).checked]).toEqual([true, true, false]);
    expect(host().dataset.loopChecked).toBe("2");
    all.click();
    expect(host().dataset.loopChecked).toBe("0");
  });

  it("lists every irreversible effect with the number of checked rows", async () => {
    const twoEffects: LoopProgram = { ...PROGRAM, irreversible: [...PROGRAM.irreversible, { stepIndex: 6, description: 'Set Status to "Paid"' }] };
    await openReady({ program: twoEffects });
    const lines = (): string[] => [...part(".effects-list").querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(part<HTMLElement>(".effects").hidden).toBe(false);
    expect(lines()).toEqual(["Reply: received x 3", 'Set Status to "Paid" x 3']);
    checkbox(4).click();
    expect(lines()).toEqual(["Reply: received x 2", 'Set Status to "Paid" x 2']);
  });

  it("has exactly one locked confirmation control, with a padlock", async () => {
    await openReady();
    const locked = panel.shadow?.querySelectorAll("[data-ghost-lock]") ?? [];
    expect(locked).toHaveLength(1);
    expect(locked[0]).toBe(part(".confirm"));
    expect(part(".confirm").querySelector("svg")).not.toBeNull();
    expect(part(".later").textContent).toBe("Not now");
  });
});

describe("execution mode", () => {
  it("offers four modes and disables the unavailable ones with the caller's reason", async () => {
    await openReady({ modes: [{ mode: "parallel", available: false, reason: "Add BROWSERBASE_API_KEY" }, { mode: "api", available: true }] });
    const modes = [...(panel.shadow?.querySelectorAll<HTMLButtonElement>(".mode") ?? [])];
    expect(modes.map((m) => m.querySelector(".mode-label")?.textContent)).toEqual(["Visible", "Background", "Parallel (Browserbase)", "API (Composio)"]);
    expect(modes.map((m) => m.disabled)).toEqual([false, false, true, false]);
    expect(modes[2]?.querySelector(".reason")?.textContent).toBe("Add BROWSERBASE_API_KEY");
    expect(modes[0]?.getAttribute("aria-checked")).toBe("true");
    expect(host().dataset.loopMode).toBe("visible");
    modes[3]?.click();
    expect(host().dataset.loopMode).toBe("api");
    modes[2]?.click();
    expect(host().dataset.loopMode).toBe("api");
  });

  it("defaults to background for more than ten items, unless the caller says otherwise", async () => {
    const many = Array.from({ length: 12 }, (_, i) => row(i + 2));
    await openReady({}, many);
    expect(host().dataset.loopMode).toBe("background");
    await openReady({ defaultMode: "visible" }, many);
    expect(host().dataset.loopMode).toBe("visible");
  });
});

describe("keyboard", () => {
  it("Tab moves focus to the confirm button and starts nothing", async () => {
    const h = await openReady();
    const event = press("Tab");
    expect(event.defaultPrevented).toBe(true);
    expect(panel.shadow?.activeElement).toBe(part(".confirm"));
    expect(document.activeElement).toBe(host());
    expect(h.deps.onConfirm).not.toHaveBeenCalled();
    expect(host().dataset.loopState).toBe("proposed");
  });

  it("leaves Tab alone once focus is inside the sheet, and with modifiers", async () => {
    await openReady();
    expect(press("Tab", document.body, { shiftKey: true }).defaultPrevented).toBe(false);
    press("Tab");
    expect(press("Tab", host()).defaultPrevented).toBe(false);
  });

  it("only an explicit Enter on the confirm button starts the run", async () => {
    const h = await openReady({}, [row(2), row(3, 0.6), row(4)]);
    press("Enter"); // Enter anywhere else is not a confirmation
    press("Tab");
    expect(h.deps.onConfirm).not.toHaveBeenCalled();
    press("Enter", part(".confirm"), { repeat: true }); // a held key is not explicit
    expect(h.deps.onConfirm).not.toHaveBeenCalled();
    const enter = press("Enter", part(".confirm"));
    expect(enter.defaultPrevented).toBe(true);
    expect(h.deps.onConfirm).toHaveBeenCalledTimes(1);
    const run = h.deps.onConfirm.mock.calls[0]?.[0] as LoopRunRequest;
    expect(run.items).toEqual([2, 4]);
    expect(run.mode).toBe("visible");
    expect(run.rows.map((r) => r.vars.vendor)).toEqual(["Vendor 2", "Vendor 4"]);
    expect(host().dataset.loopState).toBe("running");
    expect(host().dataset.loopProgress).toBe("0/2");
    press("Enter", part(".confirm"));
    part(".confirm").click();
    expect(h.deps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("a click on the confirm button starts the run", async () => {
    const h = await openReady();
    part(".confirm").click();
    expect(h.deps.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ items: [2, 3, 4], mode: "visible" }));
    expect(h.abortPreview).toHaveBeenCalled();
  });

  it("ignores scripted events: a page cannot confirm, dismiss or steal focus", async () => {
    const feed = stream<DryRunRow>();
    const deps = { onConfirm: vi.fn(), onDismiss: vi.fn(), onCancel: vi.fn() };
    panel.show({ program: PROGRAM, remaining: [2], rows: feed.rows }, deps); // default isUserEvent: event.isTrusted
    await feed.push(row(2));
    await feed.end();
    expect(part<HTMLButtonElement>(".confirm").disabled).toBe(false);
    part(".confirm").click();
    press("Enter", part(".confirm"));
    press("Escape");
    expect(press("Tab").defaultPrevented).toBe(false);
    expect(deps.onConfirm).not.toHaveBeenCalled();
    expect(deps.onDismiss).not.toHaveBeenCalled();
    expect(host().dataset.loopState).toBe("proposed");
  });

  it("Tab pressed during the preview lands on the confirm button once it unlocks", async () => {
    const h = open();
    await h.feed.push(row(2));
    press("Tab");
    expect(panel.shadow?.activeElement).toBe(part(".sheet"));
    await h.feed.push(row(3));
    await h.feed.push(row(4));
    await h.feed.end();
    expect(panel.shadow?.activeElement).toBe(part(".confirm"));
    expect(h.deps.onConfirm).not.toHaveBeenCalled();
  });

  it("Esc closes the proposal", async () => {
    const h = await openReady();
    const event = press("Escape");
    expect(event.defaultPrevented).toBe(true);
    expect(h.deps.onDismiss).toHaveBeenCalledTimes(1);
    expect(host().dataset.loopState).toBe("hidden");
    expect(part(".sheet").dataset.open).toBe("false");
    expect(panel.state).toBe("hidden");
    expect(press("Escape").defaultPrevented).toBe(false); // the page has its keys back
  });

  it("Not now closes the proposal and stops the dry run", async () => {
    const h = open();
    await h.feed.push(row(2));
    part(".later").click();
    expect(h.deps.onDismiss).toHaveBeenCalledTimes(1);
    expect(h.abortPreview).toHaveBeenCalled();
    expect(host().dataset.loopState).toBe("hidden");
    await h.feed.push(row(3)); // a late row after closing changes nothing
    expect(host().dataset.loopState).toBe("hidden");
  });
});

describe("run progress and report", () => {
  async function started(): Promise<Harness> {
    const h = await openReady({}, [row(2), row(3), row(4), row(5, 0.6)]);
    part(".confirm").click();
    return h;
  }

  it("shows per-row status and progress while running", async () => {
    await started();
    expect(gridRow(5).dataset.included).toBe("false");
    expect(part(".headline").textContent).toBe("Ghost is running 3 items");
    panel.update({ state: "running", items: [{ index: 2, status: "done" }, { index: 3, status: "running" }] });
    expect(host().dataset.loopState).toBe("running");
    expect(host().dataset.loopProgress).toBe("1/3");
    expect(gridRow(2).querySelector(".status")?.getAttribute("data-status")).toBe("done");
    expect(gridRow(3).dataset.status).toBe("running");
    expect(gridRow(4).dataset.status).toBe("pending");
    expect(part(".progress-text").textContent).toBe("1 / 3");
    expect(part(".fill").style.width).toBe("33%");
    expect(part(".sheet").dataset.view).toBe("running");
  });

  it("Cancel and Esc ask the caller to cancel, once", async () => {
    const h = await started();
    panel.update({ state: "running", items: [{ index: 2, status: "running" }] });
    part(".cancel").click();
    press("Escape");
    expect(h.deps.onCancel).toHaveBeenCalledTimes(1);
    expect(part<HTMLButtonElement>(".cancel").disabled).toBe(true);
    expect(host().dataset.loopState).toBe("running"); // stays up until the worker reports the final state
    panel.update({ state: "cancelled", items: [{ index: 2, status: "done" }, { index: 3, status: "skipped" }, { index: 4, status: "skipped" }] });
    expect(host().dataset.loopState).toBe("failed");
    expect(host().dataset.loopCancelled).toBe("true");
    expect(part(".headline").textContent).toBe("Run cancelled");
    expect(part(".summary").textContent).toBe("1 of 3 done, 2 not run.");
  });

  it("reports a finished run with the irreversible effects that ran", async () => {
    const h = await started();
    panel.update({ state: "done", items: [2, 3, 4].map((index) => ({ index, status: "done" as const })), irreversibleDone: 3 });
    expect(host().dataset.loopState).toBe("done");
    expect(host().dataset.loopProgress).toBe("3/3");
    expect(part(".headline").textContent).toBe("Done. Ghost finished 3 items.");
    expect(part(".summary").textContent).toBe("3 of 3 done.");
    expect(part(".failures").children).toHaveLength(0);
    expect(part(".effects-list").textContent).toBe("Reply: received x 3");
    expect(part(".fill").style.width).toBe("100%");
    part(".close").click();
    expect(h.deps.onClose).toHaveBeenCalledTimes(1);
    expect(host().dataset.loopState).toBe("hidden");
  });

  it("says which item failed and why", async () => {
    await started();
    panel.update({
      state: "failed",
      items: [{ index: 2, status: "done" }, { index: 3, status: "failed", error: "value-mismatch" }, { index: 4, status: "pending" }],
      irreversibleDone: 1,
    });
    expect(host().dataset.loopState).toBe("failed");
    expect(host().dataset.loopProgress).toBe("1/3");
    expect(part(".headline").textContent).toBe("Ghost stopped the run");
    expect(part(".summary").textContent).toBe("1 of 3 done, 1 failed, 1 not run.");
    expect([...part(".failures").children].map((li) => li.textContent)).toEqual(["Invoice INV-1004 failed: the value did not stick"]);
    expect(gridRow(3).dataset.status).toBe("failed");
    expect(press("Escape").defaultPrevented).toBe(true);
    expect(host().dataset.loopState).toBe("hidden");
  });

  it("rebuilds the run view after a page load: show, then update", () => {
    const deps = { onConfirm: vi.fn(), onDismiss: vi.fn(), onCancel: vi.fn(), isUserEvent: () => true };
    panel.show({ program: PROGRAM, remaining: [2, 3, 4, 5], initialRows: [row(2), row(3)] }, deps);
    panel.update({ state: "running", items: [{ index: 2, status: "done" }, { index: 3, status: "running" }, { index: 4, status: "pending" }] });
    expect(host().dataset.loopState).toBe("running");
    expect(host().dataset.loopProgress).toBe("1/3");
    expect(gridRow(5).dataset.included).toBe("false");
    expect(gridRow(2).querySelector('[data-var="vendor"]')?.textContent).toBe("Vendor 2");
    expect(deps.onConfirm).not.toHaveBeenCalled();
  });

  it("update without a session is a no-op", () => {
    panel.update({ state: "running", items: [] });
    expect(document.getElementById("ghost-loop-host")).toBeNull();
  });
});
