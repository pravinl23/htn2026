# Ghost prediction server API (`server/`, http://localhost:8787)

Keys stay on the server. This file documents implemented server contracts; it does **not** imply that every client is connected. As of the 2026-09-19 audit, Ghost Desktop calls the form/free-text/health endpoints, while the Chrome extension calls none of them and still predicts forms locally. The extension also has no loop panel or executor client yet. All non-SSE bodies are JSON. CORS allows `chrome-extension://*` and `http://localhost:*` only.

Browserbase and Composio paths are unit/mock-tested and fall back to simulated executors without credentials. They have not been live-verified in the current checkout. There is no `.env` at the audited revision.

## Access rules (the API is unauthenticated and spends paid model quota)

- The server listens on `127.0.0.1` only (`GHOST_HOST` overrides it; never expose it on shared Wi-Fi).
- Every `POST` MUST send `Content-Type: application/json`, otherwise `415`. This forces a CORS preflight, so no web page can reach a handler with a "simple" request.
- A request whose `Origin` header is present and is not `chrome-extension://*` or `http://localhost:*` / `http://127.0.0.1:*` gets `403` (not just missing CORS headers).
- A request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` gets `403` (DNS rebinding).
- Body limits count streamed bytes too: form 512 KB, next 128 KB, metrics 32 KB, ghost-text 64 KB, extract 128 KB, loop synthesize / preview / execute 1 MB, loop compile 256 KB (`413`).
- The loop execution routes (`/v1/loop/compile`, `/v1/loop/preview`, `/v1/loop/execute`, `DELETE /v1/loop/execute/:runId`) are stricter, because they send mail, write sheets and open billed cloud browsers from the user's own accounts. See "Loop execution: access and confirmation" below.
- Limits on `/v1/predict/form`: at most 100 fields and 64 fact keys (`400` above that).

## Configuration (`server/src/config.ts`)

Decision provider precedence (first match wins), reported by `/v1/health`:

1. `TYPESAFE_API_KEY`: `typesafe` (TypeSafe direct, `@typesafe-ai/sdk`, `POST https://api.typesafe.ai/v1/systemone`)
2. `AI_GATEWAY_API_KEY`: `jev-gateway` (Vercel AI SDK `experimental_evaluate`, model `typesafe-ai/jev`)
3. `OPENAI_API_KEY` or `XAI_API_KEY`: `llm` (OpenAI-compatible structured-output adapter; confidence NOT calibrated)
4. nothing: `heuristic`

Text provider: `openai` if `OPENAI_API_KEY`, else `xai` if `XAI_API_KEY` (OpenAI-compatible, base `https://api.x.ai/v1`, default model `grok-4.20-non-reasoning`), else `template`.

Loop execution (Stage 8):

| Variable | Meaning |
| --- | --- |
| `GHOST_EXTENSION_ID` | The Ghost extension's id from `chrome://extensions` (32 letters a to p, anything else is ignored). Only `chrome-extension://<this id>` may run REAL batches. |
| `GHOST_EXECUTE_TOKEN` | Per-install secret, at least 16 characters (shorter is ignored). A caller without an `Origin` (the desktop daemon, a script) sends it as `X-Ghost-Token`. Never logged. |
| `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` | Enable `parallel` mode. Both are required. |
| `BROWSERBASE_CONCURRENCY` | Cloud browsers open at once, default 5, clamped to 10. The cap is process-wide, not per request. |
| `BROWSERBASE_CONTEXT_ID` | A Browserbase context the user logged in to once. Loaded read-only (`persist: false`) so every cloud browser starts logged in. Without it they start logged out. |
| `GHOST_PUBLIC_DEMO_URL` | Public URL serving the same site as a PRIVATE `baseUrl` (localhost demo behind a tunnel). Never applied to a public `baseUrl`. Use the final `https://` URL: a redirect to another origin fails the step. |
| `COMPOSIO_API_KEY`, `COMPOSIO_USER_ID`, `COMPOSIO_GMAIL_ACCOUNT_ID`, `COMPOSIO_GOOGLESHEETS_ACCOUNT_ID`, `COMPOSIO_SPREADSHEET_ID`, `COMPOSIO_SHEET_RANGE` | Enable and configure `api` mode. |

With `GHOST_PROVIDER=heuristic` (e2e) both server executors stay simulated even when their keys exist.

Overrides used by tests and e2e so they never need keys: `GHOST_DECISION_PROVIDER=heuristic`, `GHOST_TEXT_PROVIDER=template`. `GHOST_PROVIDER=heuristic` is shorthand for both. `GHOST_FAST_PATH=0` disables the heuristic fast path.

## Jev wire format (do not invent fields)

Request: `{ "model": "jev-latest", "state": <string|object|array>, "questions": { "<name>": Question } }`, header `Authorization: Bearer <key>`.

- `{ "type": "choice", "instructions": string, "criteria": { "<option>": string | null } }` (max 255 options; include `none`)
- `{ "type": "noul", "instructions": string, "criteria"?: { "true": string, "false": string } }`
- `{ "type": "score", "instructions": string, "criteria": string[] }` (2 to 10 levels, low to high)

Response: `{ "model": string, "answers": { "<name>": Answer }, "usage": { "input_tokens": n, "output_tokens": n } }`

- choice: `{ type, choice, probabilities, confidence }`
- noul: `{ type, noul }` (probability of true; no separate confidence)
- score: `{ type, score, probabilities, legend, confidence }`

HTTP 401 bad key, 422 validation, 429 rate limited, 529 overloaded (retry 429/529 with exponential backoff: 200 ms then 400 ms, inside the 2.5 s deadline. The gateway provider passes `maxRetries: 0` to the AI SDK and retries itself, because the SDK's backoff starts at 2000 ms).

Through the Vercel AI SDK (`import { experimental_evaluate as evaluate } from "ai"`, `model: "typesafe-ai/jev"`, auth from `AI_GATEWAY_API_KEY`), the yes/no type is called `boolean` and its answer is `{ type: "boolean", probability }`; choice answers carry `choice` and `probabilities`; TypeSafe's confidence is in `result.providerMetadata.typesafe.confidence` (fall back to the max probability when it is absent). Usage is `result.usage.{inputTokens,outputTokens}`.

The shared TypeScript mirror of this lives in `shared/src/decision.ts` (`DecisionProvider.decide(state, questions)`).

## Routes

### `GET /v1/health`
`{ ok: true, provider: "typesafe"|"jev-gateway"|"llm"|"heuristic", calibrated: boolean, textProvider: "openai"|"xai"|"template", model?: string, version: string }`

### `POST /v1/predict/form`
Request: `FormPredictRequest` from `@ghost/shared` (`origin`, `formSignature`, `fields: CapturedField[]`, `factKeys: string[]`). The server never receives profile VALUES for this route, only fact KEYS.

Behavior:
- Build ONE decision call: state `{ page: { origin }, fields: [{ label, kind, name, placeholder, autocomplete, options (labels only, max 12), context }] }`, and one `choice` question per field named `f0..fN` whose criteria are `{ ...factKeys with FACT_DESCRIPTIONS, needs_text: "free-text answer the applicant must write", none: "no profile fact fits" }`. Instructions refer to the state with backticked paths, e.g. "Which profile fact should fill `fields[3]`?".
- Fast path: run the shared heuristic first. A field skips the model only on structural evidence: a standard `autocomplete` token that maps to the fact on its own, or a confident `none` (consent checkbox). Label-regex matches are NEVER trusted, whatever their confidence ("First language" scores 0.95 for `firstName`): they go to the model in the same ONE call. A form with structural evidence for every field makes zero model calls (`fastPath: true`).
- Buttons, links, file inputs and sensitive fields are never sent to the model (filter candidates in code first) and are forced to `none` on every response, cached or not.
- Server-side cache keyed by `origin + formSignature + sorted factKeys + a hash of the field descriptors` (signature, kind, inputType, label, name, id, autocomplete, placeholder, context, option labels), in-memory LRU, 500 entries. Response says `cache: "hit" | "miss"`. Identical concurrent requests share one model call (single flight). Fallbacks and outcomes where the model left an asked field unanswered are not cached.
- On provider error or timeout (2.5 s), fall back to the heuristic and say so: `provider: "heuristic"`, `fallbackFrom: "<provider>"`. The same happens, with no model call, when the serialized decision would exceed 200 KB.
- The LLM adapter omits an answer it cannot use (an option that was not offered, a skipped question) instead of inventing `none`; the heuristic assignment is kept for that field.

Response: `FormPredictResponse` plus `cache` and optional `fallbackFrom` / `fastPath`: `{ assignments: [{ signature, factKey, confidence, source, calibrated }], provider, calibrated, latencyMs, cache }`.

- `assignments[].source` is `"heuristic"` or the model provider's name; `assignments[].calibrated` is true only when that confidence is a calibrated probability. Report calibration pairs only for calibrated assignments.
- The response-level `calibrated` is true only when every assignment that can produce a ghost (`factKey != "none"`) is calibrated, so a mixed heuristic + Jev response is `calibrated: false`.

### `POST /v1/predict/next`
Request: `{ origin, url, recentActions: TraceEvent[] (max 20), candidates: NextCandidate[] (max 60), memory?: EpisodicPair[] (max 5) }` where `NextCandidate = { id: string, kind: "button"|"link"|"field", label: string, locked: boolean, context?: string }`.
One `choice` question over candidate ids plus `none`. Heuristic provider: prefer the candidate that followed the same previous action in `memory`, else `none`.
Sensitive candidates (password, card, government ID labels), and recent actions or memories that touch one, are dropped on the server before the heuristic or any model sees them, so they can never be the prediction.
Response: `{ candidateId: string | "none", confidence, provider, calibrated, latencyMs }`.

### `POST /v1/ghost-text`
Request: `{ fieldLabel, fieldSignature, maxChars?, pageContext: { company?, role?, description? (<= 2000 chars) }, facts: Record<string,string> (only the relevant, non-sensitive ones), pastAnswers: PastAnswer[] (<= 3) }`.
Response: `text/event-stream` with events `data: {"delta":"..."}` and a final `data: {"done":true,"text":"<full>","provider":"xai","latencyMs":1234,"firstTokenMs":210}`. With `?stream=0` returns JSON `{ text, provider, latencyMs }`.
Safety: page text (`fieldLabel`, `pageContext.*`) only ever appears as JSON string values in the prompt and the model is told it is untrusted data. Contact facts (keys matching email, phone, address, postal) are never put in the prompt. A draft that contains an email address, a phone number, a contact fact value or a URL that is not in `facts`/`pastAnswers` is discarded: the template answers instead (`provider: "template"`, `fallbackFrom`) and nothing is cached. Control, zero-width and bidi characters are stripped.
Cache: keyed by the exact prompt (label, company, role, description, facts, past answers) plus `maxChars`, so a draft is only replayed for an identical prompt. `fieldSignature` is accepted and ignored.
Template fallback (no key): a deterministic 2 to 4 sentence draft built from facts + company/role. Drafts are first person, concrete, 60 to 120 words, no placeholders like "[Company]", and never invent employers, numbers or awards not present in facts/pastAnswers.

### `POST /v1/profile/extract`
Request: `{ resumeText: string (<= 20000 chars) }`. Response: `{ facts: Record<string,string>, pastAnswers: [], provider, latencyMs }` using the canonical fact keys in `shared/src/profile.ts` (`FACT_DESCRIPTIONS`). LLM path: JSON-mode chat completion, validated and filtered to known keys plus `extra.*`. No key: regex extraction (email, phone, URLs for github/linkedin/website, first line as name, school and degree keywords, graduation date parsed in code into `YYYY-MM`).

### `POST /v1/loop/synthesize`
Stage 6 server contract. The intended extension coordinator will run the shared heuristic (`synthesizeProgram`) itself and call this route only for fills left `unresolved`. No extension loop coordinator calls this route yet.

Request (1 MB; at most 200 events per run, 40 urls, 80 facts per url; typed values over 500 chars are rejected, page text is clipped to 200):
```json
{ "candidate": { "runA": [TraceEvent], "runB": [TraceEvent] }, "factsByUrl": { "<origin + path>": [{ "locator": { "by": "data-field", "value": "vendor" }, "label": "Vendor", "text": "Thistledown Textiles" }] }, "unresolved": [] }
```
`runA` and `runB` must have the same length. Query strings and fragments are stripped from every url. `unresolved` is a hint only: the server recomputes it with the same shared code.

Response:
```json
{ "program": LoopProgram | null, "provider": "heuristic" | "llm", "resolvedByModel": 0, "unresolved": [UnresolvedStep], "latencyMs": 3, "modelCalls": 0, "model": "…", "cache": "hit" | "miss", "fallbackFrom": "llm" }
```
- The server first runs the shared `synthesizeProgram` that the planned extension loop coordinator will also use. With nothing unresolved, or no LLM configured, that result is returned (`provider: "heuristic"`, `modelCalls: 0`). `program: null` means the two runs do not generalize.
- Otherwise ONE chat call asks, for all open fills at once, which labeled page value explains both typed values. The model may only pick a candidate index and one transform from the closed list `trim | number | date-iso | lowercase | uppercase | first-word | last-word | digits-only`. Code then verifies that the pick reproduces BOTH typed values; anything else is dropped. A verified pick becomes an `extract` step, so `extract.from.transform` can be any of those eight (wider than the shared `ValueTransform`).
- Prompt hygiene: page text only appears as JSON string values inside `<untrusted_page_data>`; no urls, locators, constants, resolved values or profile data are sent. Sensitive-looking facts (by label or locator name) are dropped at validation. Page text shaped like an SSN, or a SIN / 13 to 19 digit number with a valid Luhn check digit, is dropped at validation too (the heuristic never sees it, so Ghost never copies it). In front of the prompt the broader shape test applies to typed values AND candidate text: any SSN shape, SIN shape or 13 to 19 digit run is left out, whatever its label says, before the prompt and the cache key are built.
- Identical questions are answered from an LRU cache (100 entries). Model timeout 8 s; on any model failure the heuristic program is returned with `fallbackFrom: "llm"`.

### Loop execution: access and confirmation

Applies to `/v1/loop/compile`, `/v1/loop/preview`, `/v1/loop/execute` and `DELETE /v1/loop/execute/:runId`, on top of the global access rules.

1. **Who may call.** An `Origin` that is not `chrome-extension://<id>` gets `403`, `http://localhost:*` included: a web page never reaches these routes. With `GHOST_EXTENSION_ID` set, any other extension id gets `403`. An `X-Ghost-Token` header that does not equal `GHOST_EXECUTE_TOKEN` gets `401`.
2. **Trusted callers.** A caller is trusted when its origin is the pinned extension, or when it sent the right `X-Ghost-Token`. REAL executors (keys configured) only run for trusted callers; everyone else gets `403` with the variable to set. The SIMULATED executors (no keys, touch nothing) run for any extension and for a local caller without an `Origin`, so the demo works unconfigured.
3. **Confirmation is a server-issued ticket, not a field.** `confirmIrreversible` in a body is ignored. `POST /v1/loop/preview` returns the list the UI must show plus a random single-use `confirmToken` bound to a SHA-256 of the parsed `(mode, program, items, baseUrl)`. `POST /v1/loop/execute` needs that token with the same job. A changed program or item list, a second use, and a token older than 5 minutes are refused with `409`. At most 50 tokens are outstanding. EVERY execute needs a token, also for programs with no irreversible step. The ticket binds what runs to what was previewed; it cannot prove a human looked, which is why rule 1 and 2 exist.
4. **Every click is irreversible here.** The server only sees a label, not the button type, the form or `data-ghost-lock`, so in a server-run batch every `click` step (and every `fill` with `locked: true`) is listed in `irreversible` and needs the confirmation, whatever the client's `locked` flag says. `open-item` is navigation and stays free.
5. **One run at a time, no repeats.** A second execute while a run is active gets `409 { error, runId }` (its token is not consumed). Items that reached a writing step in a REAL run are remembered per `(program.id, item.index)` for the lifetime of the process and refused with `409 { error, alreadyRun: [index] }` at preview and at execute. A failed or cancelled item is never retried by the server.
6. **A run can always be stopped.** `DELETE /v1/loop/execute/:runId`, a client that disconnects, and the 15 minute job deadline all stop the run: no new item starts and an item in flight stops before its next step (an API call already in flight is not aborted, because its effect would be unknown).

### `GET /v1/executors`
```json
[
  { "mode": "visible", "available": true },
  { "mode": "background", "available": true },
  { "mode": "parallel", "available": false, "reason": "Add BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID to enable parallel cloud execution", "simulated": true, "authorized": true },
  { "mode": "api", "available": false, "reason": "Add COMPOSIO_API_KEY to enable API execution", "simulated": true, "authorized": true }
]
```
`visible` and `background` run inside the extension. `simulated: true` means the mode answers with a fake all-ok report and touches nothing. `authorized` tells THIS caller whether preview/execute would accept it for that mode (false for a real executor until the caller is trusted).

### `POST /v1/loop/compile`
Request `{ "program": LoopProgram }` (256 KB). Pure: nothing is called. Response:
```json
{
  "tools": [
    { "tool": "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", "argsTemplate": { "spreadsheet_id": "{{spreadsheetId}}", "range": "{{sheetRange}}", "value_input_option": "USER_ENTERED", "values": "[[\"{{vendor}}\",\"{{invoiceNumber}}\",\"{{date}}\",\"{{total}}\"]]" }, "steps": [6, 7, 8, 9], "irreversible": false, "columns": ["Vendor", "Invoice #", "Date", "Total"] },
    { "tool": "GMAIL_REPLY_TO_THREAD", "argsTemplate": { "thread_id": "{{threadId}}", "recipient_email": "{{senderEmail}}", "message_body": "Received" }, "steps": [10], "irreversible": true }
  ],
  "uncovered": []
}
```
- Consecutive grid-cell fills on one page become one append-row call; a reply/send click in an email context, plus the To / Subject / Message fills right before it, becomes `GMAIL_REPLY_TO_THREAD` or `GMAIL_SEND_EMAIL`. `uncovered` lists fill/click steps no tool covers; `api` mode refuses a job with any.
- `{{var}}` is an item var, or a configured default (`spreadsheetId`, `sheetRange`). Only own properties count: a var nobody supplied is "no value", never something inherited. Text the user typed (`const` values) and button labels are data, not templates: a literal `{{` in them is written `{{{{` in `argsTemplate` and rendered back as `{{`, so it is never expanded. `values` is JSON text that is parsed BEFORE substitution.

### `POST /v1/loop/preview` and `POST /v1/loop/execute`
Both take the same job (1 MB). `execute` adds `confirmToken`:
```json
{
  "mode": "parallel" | "api",
  "baseUrl": "https://billing.example.com",
  "program": LoopProgram,
  "items": [{ "index": 2, "url": "https://billing.example.com/invoices/INV-1003", "vars": { "vendor": "…", "total": "1003.50" } }],
  "confirmToken": "<from preview; execute only>"
}
```
Validation (`400`, messages name the path, never a value): at most 200 items and 100 steps; item `index` unique; item urls on `baseUrl`; `program.iterator.origin` must be `baseUrl`; a fill/click `at.origin` must be `baseUrl` or the origin of one of the program's `goto` steps; urls are http(s) and lose their query string and fragment; at most 50 vars per item, 2000 chars each; var names match `^[A-Za-z][\w.-]{0,63}$` and must not be a name every object inherits (`constructor`, `toString`, `valueOf`, `hasOwnProperty`, ...); sensitive-looking var names are dropped; a fill on a sensitive-looking label, or on a button / link / file input, is rejected; `extract.from.transform` is one of the eight transforms above.

`preview` response (`200`):
```json
{ "runId": "<uuid>", "confirmToken": "<43 chars>", "expiresAt": 1800000300000, "mode": "parallel", "simulated": false, "items": 48, "irreversible": [{ "stepIndex": 10, "description": "Reply: received", "count": 48 }], "origins": ["https://billing.example.com", "https://docs.google.com"] }
```
The UI shows `irreversible` (with counts) and `origins` (every site the run may touch) next to its ONE confirmation control, and sends `confirmToken` only after the user pressed it. `runId` is known before the run starts, so Esc can cancel it. Everything that can be refused without side effects is refused here with `400`: a site a cloud browser cannot or must not reach, steps `api` mode does not cover.

`execute` response (`200`): `{ "runId": "<uuid>", "report": ExecuteReport }`
```json
{ "mode": "parallel", "simulated": false, "startedAt": 1800000000000, "finishedAt": 1800000042000, "durability": "verified", "stopped": "cancelled",
  "results": [{ "index": 2, "ok": true, "steps": 11, "touched": true }, { "index": 3, "ok": false, "steps": 7, "touched": true, "error": "step 7 (fill): the value did not stick" }, { "index": 4, "ok": false, "steps": 0, "error": "skipped: the run stopped after item 3 failed" }] }
```
- The run stops at the first failed item: items in flight finish, the rest are `skipped`. `error` names the step and the reason, never a value. `touched` means the item reached a writing step (it may be half done) and will not be run again by the server.
- `stopped` is `"cancelled" | "disconnected" | "deadline"` when the run was stopped from outside; absent otherwise.
- With `?stream=1` the answer is `text/event-stream`: `data: {"runId","total"}`, then one `data: {"progress":{"index","ok","done","total"}}` per item, then `data: {"done":true,"runId","report"}` (or `{"done":true,"runId","error"}`).
- Status codes: `400` validation, missing `confirmToken` (the body then carries `items`, `irreversible`, `origins`), executor refusal; `401` wrong `X-Ghost-Token`; `403` caller not allowed or not trusted; `409` token unknown / used / expired / for another job, another run active, items already run; `413`; `415`.
- Log line, counts only: `[ghost] browserbase /v1/loop/execute 42000ms mode=parallel items=48 failed=0 irreversible=1 [stopped=cancelled]`.

`parallel` mode (Browserbase, one cloud browser per item):
- SSRF guard. A cloud browser is only ever sent to public addresses. Hosts are canonicalised by the URL parser (`2130706433`, `0x7f.1`, `127.1`) and IP literals are parsed numerically: loopback, RFC 1918, link-local incl. `169.254.169.254`, CGNAT `100.64/10`, `0/8`, multicast and reserved ranges, and for IPv6 `::`, `::1`, IPv4-mapped / compatible / NAT64 / 6to4 forms of those, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`. Names: a trailing dot is ignored; single-label names, `.localhost`, `.local`, `.internal`, `.intranet`, `.lan`, `.home`, `.corp`, `.private`, `.home.arpa` and wildcard-DNS services (`nip.io`, `sslip.io`, `xip.io`, `localtest.me`, `lvh.me`, `vcap.me`) are private. Every remaining hostname is resolved once: a private address in the answer, or no answer, refuses the job. All item urls, `goto` urls and `at` pages are checked before the first session is created.
- A private `baseUrl` is moved onto `GHOST_PUBLIC_DEMO_URL` or refused; a public `baseUrl` is never rewritten.
- After every navigation the landing page must have the target's origin AND path pattern ("landed on a different site" otherwise). Before every extract, fill and click the current page must be on one of the confirmed `origins`.
- Durability check. The first item runs alone. Before its first irreversible step, the grid cells it wrote are read back from a SECOND cloud browser (3 attempts, 500 ms apart). If they are not there, the run stops with no irreversible step executed: the site keeps its state inside the browser (the bundled localStorage demo does), or the session is logged out. `durability` is `"verified"` then, `"unverified"` when the program writes no grid cell the server can read back.
- Extracts apply the closed transform list exactly as it was verified at synthesis time; an unknown transform yields no value, never a guess.

`api` mode (Composio): compiles the program as above, renders every call of an item first (a missing value fails the item before its first call), then executes sequentially in item order. No call is ever retried.

### `DELETE /v1/loop/execute/:runId`
`200 { "runId": "…", "cancelled": true }` for the active run, `404 { "error": "no active run with this id" }` otherwise. Same caller rules as execute.

### `GET /v1/metrics` and `POST /v1/metrics/event`
In-memory latency log per route/provider with `count, failures, p50, p95, last`, cache hit rate, plus client-reported counters (`ghostsShown`, `ghostsAccepted`, `keystrokesSaved`, calibration pairs `(confidence, accepted)`).

Latency attribution: each model call is recorded under the provider that made it, failures and timeouts included (`failures` counts them, and their latency stays in the percentiles). Cache hits are recorded under the pseudo-provider `cache`, never under the model. A request that fell back is charged to the provider that failed, not to `heuristic`/`template`. `heuristic`, `template` and `regex` series only contain requests answered purely in code.

## Logging

Every model call logs one line: `provider route latencyMs questions=<n> calibrated=<bool> cache=<hit|miss>`. Never log field values, profile values, or keys.
