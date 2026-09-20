import type { FactLocator, LoopProgram, StepTarget } from "@shabang/shared";
import type { CdpConnector, RemotePage } from "../src/executors/browserbase";
import type { HostLookup } from "../src/executors/netguard";
import type { ExecuteItem, ExecuteJob } from "../src/executors/types";

export const DEMO = "http://localhost:5173";
export const PUBLIC_DEMO = "https://ghost-demo.example.com";
const SHEET_PAGE = { origin: DEMO, pathPattern: "/sheet" };
const COLUMNS: Array<[string, string]> = [["Vendor", "vendor"], ["Invoice #", "invoiceNumber"], ["Date", "date"], ["Total", "total"]];

/** The canonical "copy invoice fields into the sheet and reply" program, exactly as shared/src/loop/synthesize.ts emits it. */
export function invoiceProgram(origin: string = DEMO): LoopProgram {
  const sheet = { ...SHEET_PAGE, origin };
  return {
    id: "loop-aab04f10",
    name: 'Copy 4 fields from /invoices/:id to /sheet and click "Reply: received"',
    iterator: { origin, pathPattern: "/invoices", listSignature: "ul#inbox", stride: 1, nextIndex: 2, itemPathPattern: "/invoices/:id" },
    steps: [
      { op: "open-item" },
      { op: "extract", var: "vendor", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "vendor" } } },
      { op: "extract", var: "invoiceNumber", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "number" } } },
      { op: "extract", var: "date", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "date" }, transform: "date-iso" } },
      { op: "extract", var: "total", from: { pathPattern: "/invoices/:id", locator: { by: "data-field", value: "total" }, transform: "number" } },
      { op: "goto", origin, pathPattern: "/sheet", url: `${origin}/sheet` },
      ...COLUMNS.map(([colHeader, name]) => ({ op: "fill" as const, target: { label: colHeader, kind: "text" as const, cell: { row: "next-empty" as const, colHeader } }, value: { var: name }, at: sheet })),
      { op: "click", target: { label: "Reply: received", kind: "button", signature: "button:Reply: received" }, locked: true, at: { origin, pathPattern: "/invoices/:id" } },
    ],
    irreversible: [{ stepIndex: 10, description: "Reply: received" }],
    confidence: 0.9,
  };
}

export function invoiceItems(count: number, origin: string = DEMO, from = 2): ExecuteItem[] {
  return Array.from({ length: count }, (_, i) => {
    const n = 1001 + from + i;
    return { index: from + i, url: `${origin}/invoices/INV-${n}`, vars: { vendor: `Vendor ${n}`, invoiceNumber: `INV-${n}`, date: "2026-09-03", total: `${n}.50` } };
  });
}

export function invoiceJob(count = 3, overrides: Partial<ExecuteJob> = {}): ExecuteJob {
  return { program: invoiceProgram(), items: invoiceItems(count), confirmIrreversible: true, baseUrl: DEMO, ...overrides };
}

/** Stands in for DNS: every name is public unless the test says otherwise. No test ever resolves a real host. */
export const publicLookup: HostLookup = async () => ["93.184.216.34"];

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Records every request and answers from `respond`. No network is ever touched. */
export function fakeFetch(respond: (call: FetchCall, n: number) => { status: number; json?: unknown }): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fake = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    calls.push(call);
    const { status, json } = respond(call, calls.length);
    return new Response(JSON.stringify(json ?? {}), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch: fake as typeof fetch, calls };
}

export const isRelease = (call: FetchCall): boolean => call.body.status === "REQUEST_RELEASE";

/** Browserbase as the docs describe it: 201 with id + connectUrl on create, 200 on release. */
export function fakeBrowserbase(): { fetch: typeof fetch; calls: FetchCall[] } {
  let sessions = 0;
  return fakeFetch((call) => (isRelease(call) ? { status: 200, json: {} } : { status: 201, json: { id: `sess-${++sessions}`, connectUrl: `wss://connect.browserbase.test/sess-${sessions}`, status: "RUNNING" } }));
}

export interface CloudOptions {
  baseRow?: number;
  /** Simulates a field that ignores the write. */
  stick?: (label: string, value: string) => boolean;
  redirect?: (url: string) => string;
  texts?: Record<string, string>;
  failConnect?: (connectUrl: string) => boolean;
  stepDelayMs?: number;
  /** False simulates a site that keeps its state inside the browser (localStorage): every session sees only its own writes. */
  durable?: boolean;
}

/** A fake cloud: counts open browsers and records what every page did. */
export class FakeCloud {
  open = 0;
  maxOpen = 0;
  closed = 0;
  readonly visits: string[] = [];
  readonly fills: Array<{ label: string; value: string; row?: number; url: string }> = [];
  readonly clicks: Array<{ label: string; url: string }> = [];
  /** Cells as a server-backed sheet would keep them: visible to every session. */
  private readonly sheet = new Map<string, string>();

  constructor(private readonly opts: CloudOptions = {}) {}

  private tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.opts.stepDelayMs ?? 1));
  }

  readonly connect: CdpConnector = async (connectUrl) => {
    if (this.opts.failConnect?.(connectUrl)) throw new Error("connectOverCDP: websocket closed");
    this.open++;
    this.maxOpen = Math.max(this.maxOpen, this.open);
    let current = "about:blank";
    const cells = this.opts.durable === false ? new Map<string, string>() : this.sheet;
    const page: RemotePage = {
      goto: async (url) => {
        await this.tick();
        this.visits.push(url);
        current = this.opts.redirect?.(url) ?? url;
      },
      url: () => current,
      readText: async (locator: FactLocator) => this.opts.texts?.[locator.value] ?? null,
      nextEmptyRow: async () => this.opts.baseRow ?? 0,
      readCell: async (colHeader: string, row: number) => cells.get(`${colHeader}:${row}`) ?? "",
      fill: async (target: StepTarget, value: string, row?: number) => {
        await this.tick();
        this.fills.push({ label: target.label, value, row, url: current });
        if (this.opts.stick?.(target.label, value) === false) return "";
        if (target.cell && row !== undefined) cells.set(`${target.cell.colHeader}:${row}`, value);
        return value;
      },
      click: async (target: StepTarget) => {
        await this.tick();
        this.clicks.push({ label: target.label, url: current });
      },
    };
    return {
      page: async () => page,
      close: async () => {
        this.open--;
        this.closed++;
      },
    };
  };
}
