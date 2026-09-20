import { isSensitive } from "@shabang/shared";
import type { ServerLoopProgram as LoopProgram, ServerLoopStep as LoopStep } from "../loop/transforms";
import { runPool } from "./pool";
import { assertConfirmed, isIrreversibleStep, ownVar, report, skippedResult, stopReasonOf, stoppedMessage, type FillStep } from "./steps";
import { ExecutorRefusal, ExecutorUpstreamError, type ExecuteItem, type ExecuteJob, type ItemResult, type LoopExecutor } from "./types";

/**
 * MUST be confirmed against the live docs before the first real run. Read from https://docs.composio.dev/reference on 2026-09-19:
 * POST {base}/tools/execute/{tool_slug}, header `x-api-key`, body { user_id, connected_account_id?, arguments, version? },
 * answer { data, error, successful, log_id }. The HTTP call lives in executeTool() only.
 */
export const COMPOSIO_EXECUTE_URL = "https://backend.composio.dev/api/v3.1/tools/execute";
const COMPOSIO_TOOLKIT_VERSION = "latest";
const HTTP_TIMEOUT_MS = 20_000;

/** Tool slugs and argument names as listed on docs.composio.dev/toolkits/{gmail,googlesheets} (same caveat as above). */
export const TOOLS = {
  replyEmail: "GMAIL_REPLY_TO_THREAD",
  sendEmail: "GMAIL_SEND_EMAIL",
  appendRow: "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND",
} as const;

export interface CompiledTool {
  tool: string;
  /**
   * Tool arguments with item vars written as {{var}}. `values` is JSON text (a 2-D array) and is parsed BEFORE vars are substituted.
   * A literal "{{" (from text the user typed, or from a button label) is written "{{{{", so constants are never expanded.
   */
  argsTemplate: Record<string, string>;
  /** Program steps this one call replaces. */
  steps: number[];
  /** True when it replaces a locked step: it runs only after the batch confirmation. */
  irreversible: boolean;
  /** Append-row only: the column headers, in the order of `values`. */
  columns?: string[];
}

export interface CompileResult {
  tools: CompiledTool[];
  /** Indexes of fill/click steps no tool covers. open-item, extract and goto need no API call and are never listed. */
  uncovered: number[];
}

const JSON_ARGS = new Set(["values"]);
const EMAIL_CONTEXT = /mail|inbox|message|thread|compose/i;
const REPLY = /\b(reply|respond)\b/i;
const SEND = /\bsend\b/i;
const SHEET_URL = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/;
const FIELD = { to: /^(to|recipients?)\b/i, subject: /subject/i, body: /body|message|reply|response/i };

/** Constants are data, not templates: their "{{" is escaped so substitute() writes it back literally. */
function literal(text: string): string {
  return text.replace(/\{\{/g, "{{{{");
}

function template(step: FillStep): string {
  return "var" in step.value ? `{{${step.value.var}}}` : literal(step.value.const);
}

function samePage(a: LoopStep, b: LoopStep): boolean {
  const [pa, pb] = [("at" in a && a.at) || undefined, ("at" in b && b.at) || undefined];
  return pa?.origin === pb?.origin && pa?.pathPattern === pb?.pathPattern;
}

function hasEmailContext(program: LoopProgram, step: LoopStep): boolean {
  const { iterator } = program;
  const at = "at" in step ? step.at?.pathPattern : undefined;
  return [iterator.pathPattern, iterator.itemPathPattern, iterator.listSignature, program.name, at].some((text) => text !== undefined && EMAIL_CONTEXT.test(text));
}

/** "Reply: received" carries its own message. */
function bodyFromLabel(label: string): string | undefined {
  const text = label.split(":").slice(1).join(":").trim();
  return text ? literal(text.charAt(0).toUpperCase() + text.slice(1)) : undefined;
}

/** Maps known step patterns to API tool calls: grid-cell fills to one append-row call, a locked reply/send click in an email context to an email tool. */
export function compile(program: LoopProgram): CompileResult {
  const { steps } = program;
  const covered = new Set<number>();
  const tools: Array<CompiledTool & { order: number }> = [];
  let sheetId: string | undefined;

  const plainFill = (i: number): FillStep | undefined => {
    const step = steps[i];
    return step?.op === "fill" && !step.target.cell && !covered.has(i) && !isSensitive({ label: step.target.label }) ? step : undefined;
  };

  steps.forEach((step, i) => {
    if (step.op === "goto") sheetId = SHEET_URL.exec(step.url)?.[1];
    if (step.op !== "fill" || !step.target.cell || covered.has(i) || isSensitive({ label: step.target.label })) return;
    // One row: the run of cell fills on the same page, in the order the user typed them.
    const row: number[] = [];
    for (let j = i; j < steps.length; j++) {
      const next = steps[j] as LoopStep;
      if (next.op !== "fill" || !next.target.cell || !samePage(step, next) || isSensitive({ label: next.target.label })) break;
      row.push(j);
    }
    const fills = row.map((j) => steps[j] as FillStep);
    row.forEach((j) => covered.add(j));
    tools.push({
      order: i,
      tool: TOOLS.appendRow,
      argsTemplate: { spreadsheet_id: sheetId ?? "{{spreadsheetId}}", range: "{{sheetRange}}", value_input_option: "USER_ENTERED", values: JSON.stringify([fills.map(template)]) },
      steps: row,
      irreversible: fills.some(isIrreversibleStep),
      columns: fills.map((fill) => fill.target.cell?.colHeader ?? fill.target.label),
    });
  });

  steps.forEach((step, i) => {
    if (step.op !== "click" || !isIrreversibleStep(step) || !hasEmailContext(program, step)) return;
    const label = step.target.label;
    const isReply = REPLY.test(label);
    if (!isReply && !SEND.test(label)) return;
    // Fields the user filled on the same page just before pressing the button become the tool's arguments.
    const written: Partial<Record<keyof typeof FIELD, string>> = {};
    const used = [i];
    for (let j = i - 1; j >= 0; j--) {
      const fill = plainFill(j);
      if (!fill || !samePage(step, fill)) break;
      const slot = (Object.keys(FIELD) as Array<keyof typeof FIELD>).find((key) => FIELD[key].test(fill.target.label) && written[key] === undefined);
      if (!slot) break;
      written[slot] = template(fill);
      used.unshift(j);
    }
    used.forEach((j) => covered.add(j));
    const argsTemplate: Record<string, string> = isReply
      ? { thread_id: "{{threadId}}", recipient_email: written.to ?? "{{senderEmail}}", message_body: written.body ?? bodyFromLabel(label) ?? "{{replyBody}}" }
      : { recipient_email: written.to ?? "{{recipientEmail}}", subject: written.subject ?? "{{subject}}", body: written.body ?? "{{body}}" };
    tools.push({ order: i, tool: isReply ? TOOLS.replyEmail : TOOLS.sendEmail, argsTemplate, steps: used, irreversible: true });
  });

  const uncovered = steps.flatMap((step, i) => ((step.op === "fill" || step.op === "click") && !covered.has(i) ? [i] : []));
  return { tools: tools.sort((a, b) => a.order - b.order).map(({ order: _order, ...tool }) => tool), uncovered };
}

class MissingVar extends Error {}

function substitute(text: string, lookup: (name: string) => string | undefined): string {
  // "{{{{" is tried first at every position, so an escaped constant can never be read as a placeholder.
  return text.replace(/\{\{\{\{|\{\{([\w.-]+)\}\}/g, (match, name: string | undefined) => {
    if (name === undefined) return match === "{{{{" ? "{{" : match;
    const value = lookup(name);
    if (value === undefined) throw new MissingVar(`no value for {{${name}}}`);
    return value;
  });
}

function substituteDeep(node: unknown, lookup: (name: string) => string | undefined): unknown {
  if (typeof node === "string") return substitute(node, lookup);
  return Array.isArray(node) ? node.map((child) => substituteDeep(child, lookup)) : node;
}

/** Item vars win over the configured defaults. JSON arguments are parsed first, so a value can never break out of its string. */
export function renderArgs(tool: CompiledTool, vars: Record<string, string>, defaults: Record<string, string> = {}): Record<string, unknown> {
  // Own properties only: "constructor" or "toString" must read as missing, never as something inherited from Object.prototype.
  const lookup = (name: string): string | undefined => ownVar(vars, name) ?? ownVar(defaults, name);
  return Object.fromEntries(Object.entries(tool.argsTemplate).map(([key, text]) => [key, JSON_ARGS.has(key) ? substituteDeep(JSON.parse(text), lookup) : substitute(text, lookup)]));
}

export interface ComposioSettings {
  apiKey: string;
  userId: string;
  /** Connected account per toolkit ("gmail", "googlesheets"). Omitted: Composio picks the user's account for that toolkit. */
  connectedAccounts?: Record<string, string | undefined>;
  /** Fallback values for template vars no item carries, e.g. spreadsheetId and sheetRange. */
  defaults?: Record<string, string>;
}

export interface ComposioExecutorOptions {
  settings: ComposioSettings;
  /** Rows must land in item order, so calls are sequential unless told otherwise. */
  concurrency?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/** The only place that talks to Composio. Upstream error text can echo arguments, so only the tool name and a status leave it. */
async function executeTool(doFetch: typeof fetch, settings: ComposioSettings, tool: string, args: Record<string, unknown>): Promise<void> {
  const toolkit = tool.split("_")[0]?.toLowerCase() ?? "";
  const connected = settings.connectedAccounts?.[toolkit];
  const res = await doFetch(`${COMPOSIO_EXECUTE_URL}/${encodeURIComponent(tool)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": settings.apiKey },
    body: JSON.stringify({ user_id: settings.userId, ...(connected ? { connected_account_id: connected } : {}), version: COMPOSIO_TOOLKIT_VERSION, arguments: args }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new ExecutorUpstreamError("composio", `${tool} responded ${res.status}`, res.status);
  }
  const body = (await res.json()) as { successful?: unknown } | null;
  if (body?.successful !== true) throw new ExecutorUpstreamError("composio", `${tool} reported a failure`);
}

export function createComposioExecutor(options: ComposioExecutorOptions): LoopExecutor {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const { settings } = options;

  async function runItem(item: ExecuteItem, tools: CompiledTool[], confirmed: boolean, signal: AbortSignal | undefined): Promise<ItemResult> {
    let completed = 0;
    let touched = false;
    try {
      // Render everything first: an item with a missing value must fail before its first call, not between the row and the reply.
      const calls = tools.map((tool) => ({ tool, args: renderArgs(tool, item.vars, settings.defaults) }));
      for (const { tool, args } of calls) {
        if (tool.irreversible && !confirmed) throw new ExecutorRefusal("locked step needs the batch confirmation");
        // A call in flight is never aborted (its effect would be unknown); a stopped run just never starts the next one.
        const stopped = stopReasonOf(signal);
        if (stopped) throw new ExecutorRefusal(stoppedMessage(stopped));
        touched = true;
        await executeTool(doFetch, settings, tool.tool, args); // never retried: a repeated send or append is worse than a stopped run
        completed++;
      }
      return { index: item.index, ok: true, steps: completed, touched };
    } catch (err) {
      const known = err instanceof MissingVar || err instanceof ExecutorUpstreamError || err instanceof ExecutorRefusal;
      return { index: item.index, ok: false, steps: completed, error: known ? err.message : "composio: request failed", ...(touched ? { touched } : {}) };
    }
  }

  function coverage(job: ExecuteJob): CompiledTool[] {
    const { tools, uncovered } = compile(job.program);
    if (uncovered.length > 0) throw new ExecutorRefusal("API mode cannot cover every step of this loop. Run it in visible or background mode.", { uncovered });
    if (tools.length === 0) throw new ExecutorRefusal("This loop has no step that maps to an API call.");
    return tools;
  }

  return {
    mode: "api",
    available: true,
    async check(job) {
      coverage(job);
    },
    async run(job, { onProgress, signal } = {}) {
      assertConfirmed(job);
      const tools = coverage(job);
      const startedAt = now();
      let done = 0;
      let failedIndex: number | undefined;
      const results = await runPool<ExecuteItem, ItemResult>(
        job.items,
        { limit: options.concurrency ?? 1, stopOn: (r) => !r.ok, signal, skipped: (item) => skippedResult(item.index, failedIndex, signal) },
        async (item) => {
          const result = await runItem(item, tools, job.confirmIrreversible, signal);
          if (!result.ok && !signal?.aborted) failedIndex ??= item.index;
          onProgress?.({ index: item.index, ok: result.ok, done: ++done, total: job.items.length });
          return result;
        },
      );
      return report("api", results, startedAt, false, now, signal);
    },
  };
}
