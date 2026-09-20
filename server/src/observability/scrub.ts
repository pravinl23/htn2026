/**
 * The one gate every byte passes before it leaves for Sentry.
 *
 * Shabang's telemetry is allowed to carry NAMES, COUNTS, DURATIONS, PROVIDER NAMES, CONFIDENCE BUCKETS and BOOLEANS.
 * It is never allowed to carry a field value, a page label, a profile fact, a learned answer, a URL with a query
 * string or a path on the user's disk. Everything in this folder is written so that it only ever builds the allowed
 * kinds; this module is the second line of defence, applied to EVERY event, transaction, log and metric, so a mistake
 * upstream (or a library attaching its own data) still cannot ship a value.
 *
 * The rule is whole-value: if any test fires, the entire string is replaced by a marker. Redacting only the matched
 * part would leak the text around it, which is usually the more identifying half.
 */

/** Why a string was dropped. Sent in its place, so a trace still shows that something was there. */
export type RedactionReason = "email" | "phone" | "card" | "gov-id" | "url" | "path" | "long" | "multiline" | "secret" | "key";

/** Above this, a string is prose or a value, not a name, a code or a short summary. */
export const MAX_ATTRIBUTE_CHARS = 120;
/** Attribute trees are shallow by construction; anything deeper is something we did not build. */
const MAX_DEPTH = 6;
const MAX_ARRAY = 32;

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
// 10+ digits with the usual separators, and the +1 (555) 010-4477 shape.
const PHONE = /(?<!\d)(\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/;
// Any long digit run survives separators: card numbers, SINs, account numbers, ids.
const LONG_DIGITS = /(?:\d[ -]?){12,}/;
// 123-45-6789 (SSN) and 123-456-789 (SIN).
const GOV_ID = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)|(?<!\d)\d{3}-\d{3}-\d{3}(?!\d)/;
const URL_WITH_QUERY = /[?&][\w.%+-]+=/;
const ANY_URL = /\b(?:https?|ftp|wss?|file|data|blob|chrome-extension|moz-extension):/i;
// Absolute paths on the user's machine. Route names ("/v1/predict/form") must survive, so only real roots count.
const FILE_PATH = /(?:^|\s)(?:\/(?:Users|home|root|var|etc|tmp|private|opt|Volumes|mnt|srv)\/|[A-Za-z]:[\\/]|~\/)|[\\/]node_modules[\\/]/;
// Anything that reads like a credential, wherever it sits.
const SECRET =
  /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xoxb|xoxp|AKIA|ASIA|AIza)[-_][A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+/i;

/** Key names whose VALUE is a value by definition, whatever it happens to look like today. */
const VALUE_WORD =
  /^(?:value|values|text|label|labels|answer|answers|draft|prompt|message|messages|content|body|input|output|query|q|url|href|uri|link|path|filename|file|dir|email|phone|address|postal|zip|name|firstname|lastname|username|login|user|password|passwd|pwd|secret|token|key|apikey|authorization|auth|cookie|cookies|session|dsn|signature|locator|selector|placeholder|title|description|snippet|evidence|resume|typed|vars|facts|profile|origin|host|hostname|referer|referrer|useragent|ip|search|fragment|hash)$/i;

/** Subtrees Sentry needs verbatim to be useful at all. They describe OUR code, never the user's data. */
const KEEP_SUBTREE = new Set(["stacktrace", "debug_meta", "sdk", "sdkProcessingMetadata", "_metadata", "modules", "frames"]);

/** Keys that are part of the Sentry envelope's own structure. Dropping them would make the event unreadable. */
const STRUCTURAL_KEY =
  /^(?:sentry\.|otel\.)|^(?:op|origin|type|level|unit|environment|release|platform|transaction|transaction_info|trace_id|span_id|parent_span_id|status|status_code|timestamp|start_timestamp|severity_number|severity_text|description|data|attributes|contexts|tags|extra|spans|breadcrumbs|exception|values|measurements|event_id|items|message|category|lineno|colno|in_app|fingerprint|logger|version)$/;

/**
 * THE allowlist: every attribute key this instrumentation emits, and nothing else.
 *
 * Inside a span's `data`, a log's `attributes` or a metric's `attributes`, a key that is not on this list is dropped
 * whatever it holds. That is deliberately strict: it means a new attribute has to be added here on purpose, and an
 * attribute someone attaches by accident (or a library attaches on its own) cannot ship a value. The end-to-end tests
 * assert the attributes each route produces, so forgetting to add a key here shows up as a failing test, not as
 * silent data loss in production.
 */
const EMITTED_KEYS = new Set([
  // request and route
  "ghost.route",
  "ghost.latency_ms",
  "http.request.method",
  "http.response.status_code",
  "server.address",
  // who answered
  "ghost.provider",
  "ghost.calibrated",
  "ghost.calibrated_provider",
  "ghost.cache",
  "ghost.fast_path",
  "ghost.fallback_from",
  "ghost.failure",
  "ghost.ok",
  "ghost.deadline_ms",
  // what the user ended up seeing
  "ghost.fields",
  "ghost.answered",
  "ghost.without_fact",
  "ghost.guesses",
  "ghost.confidence.high",
  "ghost.confidence.guess",
  "ghost.confidence.weak",
  "ghost.confidence.bucket",
  "ghost.from_model",
  "ghost.from_heuristic",
  "ghost.proposed",
  "ghost.accepted",
  "ghost.corrected",
  // The rejection counts. Every one is an integer count of ghosts in one walk, never anything about the page.
  "ghost.rejected",
  "ghost.dismissed",
  "ghost.skipped",
  "ghost.candidates",
  "ghost.class",
  "ghost.source",
  "ghost.surface",
  "ghost.decision_ms",
  "ghost.counters",
  // the shape of the request
  "ghost.request.fields",
  "ghost.request.fact_keys",
  "ghost.questions",
  "ghost.answers",
  "ghost.unanswered",
  // free text
  "ghost.draft_chars",
  "ghost.first_token_ms",
  "ghost.headers_ms",
  "ghost.stream_bytes",
  "ghost.total_ms",
  // loops
  "ghost.program",
  "ghost.steps",
  "ghost.unresolved",
  "ghost.resolved_by_model",
  "ghost.model_calls",
  // vision
  "ghost.boxes",
  "ghost.named",
  "ghost.locked",
  "ghost.sensitive",
  // the model call itself (OpenTelemetry GenAI names, so Sentry's AI views pick them up)
  "gen_ai.system",
  "gen_ai.operation.name",
  // The agent's own name ("decide.jev"), and our internal label for the call. Both are closed vocabularies.
  "gen_ai.agent.name",
  "ghost.operation",
  "gen_ai.request.model",
  "gen_ai.request.streaming",
  "gen_ai.request.messages",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.response.time_to_first_token_ms",
]);

function reasonFor(text: string): RedactionReason | null {
  if (text.includes("\n") || text.includes("\r")) return "multiline";
  if (SECRET.test(text)) return "secret";
  if (EMAIL.test(text)) return "email";
  if (GOV_ID.test(text)) return "gov-id";
  if (LONG_DIGITS.test(text)) return "card";
  if (PHONE.test(text)) return "phone";
  if (URL_WITH_QUERY.test(text) || ANY_URL.test(text)) return "url";
  if (FILE_PATH.test(text)) return "path";
  if (text.length > MAX_ATTRIBUTE_CHARS) return "long";
  return null;
}

/** The marker keeps the reason and the length, so a trace still says "something was here" without saying what. */
export function marker(reason: RedactionReason, length: number): string {
  return `[redacted:${reason}:${length}]`;
}

/** Returns the string unchanged, or a marker when it looks like a value. The only place that decision is made. */
export function scrubString(text: string): string {
  const reason = reasonFor(text);
  return reason ? marker(reason, text.length) : text;
}

/**
 * True when the VALUE under this key must be dropped without even looking at it.
 *
 * `strict` is the payload we build ourselves (span data, log and metric attributes): there, only keys on
 * `EMITTED_KEYS` survive. Everywhere else (the Sentry envelope around it) a key is dropped when any word in it names
 * a value, so `server_name`, `abs_path` and `ghost.field_label` all go, and `start_timestamp` stays.
 */
export function isValueKey(key: string, strict = false): boolean {
  if (EMITTED_KEYS.has(key)) return false;
  if (STRUCTURAL_KEY.test(key)) return false;
  if (strict) return true;
  if (VALUE_WORD.test(key)) return true;
  return key.split(/[._-]/).some((word) => VALUE_WORD.test(word));
}

/** Sentry's exception entries are `{ type, value, stacktrace }`; their `value` is the error message, not a field value. */
function isExceptionEntry(record: Record<string, unknown>, parentKey: string | undefined): boolean {
  return parentKey === "values" && typeof record.type === "string" && "value" in record;
}

function scrubUnknown(value: unknown, depth: number, key: string | undefined, strict: boolean): unknown {
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return marker("long", 0);
  // Array items inherit the key they sit under, so `exception.values[]` is still recognised as exception entries.
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => scrubUnknown(item, depth + 1, key, strict));
  if (typeof value === "object") return scrubRecord(value as Record<string, unknown>, depth + 1, key, strict);
  // A function, a symbol or a bigint is never something we meant to send.
  return marker("long", 0);
}

/** `data` and `attributes` are where OUR payload sits, so entering one switches the walk to the strict allowlist. */
function scrubRecord(record: Record<string, unknown>, depth: number, parentKey?: string, strict = false): Record<string, unknown> {
  const exception = isExceptionEntry(record, parentKey);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (KEEP_SUBTREE.has(key)) {
      out[key] = value;
      continue;
    }
    if (exception && key === "value") {
      out[key] = scrubUnknown(value, depth, key, strict);
      continue;
    }
    const inner = strict || key === "data" || key === "attributes";
    if (isValueKey(key, strict)) {
      // A key that promises a value is dropped whole: a number under `value` is still a value.
      out[key] = marker("key", typeof value === "string" ? value.length : 0);
      continue;
    }
    out[key] = scrubUnknown(value, depth, key, inner);
  }
  return out;
}

/** Span, log and metric attributes. Numbers, booleans and short names survive; everything else becomes a marker. */
export function scrubAttributes<T extends Record<string, unknown>>(attributes: T | undefined): T | undefined {
  return attributes === undefined ? undefined : (scrubRecord(attributes, 0, undefined, true) as T);
}

/** Every event: errors AND transactions, which is where span names and span attributes travel. */
export function scrubEvent<T extends object>(event: T): T {
  return scrubRecord(event as Record<string, unknown>, 0, undefined, false) as T;
}

/** A log is `{ level, message, attributes }`: the message is a summary we wrote, the attributes are the payload. */
export function scrubLog<T extends { message?: unknown; attributes?: Record<string, unknown> }>(log: T): T {
  const message = typeof log.message === "string" ? scrubString(log.message) : log.message;
  return { ...log, message, attributes: scrubAttributes(log.attributes) };
}

/** A metric is `{ name, value, type, unit, attributes }`: name and value are ours by construction, attributes are not. */
export function scrubMetric<T extends { attributes?: Record<string, unknown> }>(metric: T): T {
  return { ...metric, attributes: scrubAttributes(metric.attributes) };
}
