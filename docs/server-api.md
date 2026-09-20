# Shabang prediction server API (`server/`, http://localhost:8787)

Keys stay on the server. The Chrome extension calls form prediction, next-action prediction, ghost text, profile extraction, metrics, presence, walk telemetry and loop/executor routes while retaining instant local fallback. Shabang Desktop calls form/free-text/health/presence. The atomic workflow lab calls `/v1/workflows/*` directly, while the tested native `GHWorkflowCoordinator` seam is not yet connected to the desktop pipeline. All non-SSE bodies are JSON. CORS allows `chrome-extension://*` and `http://localhost:*` only.

Browserbase and Composio paths are unit/mock-tested and fall back to simulated executors without credentials. On the audited developer machine, direct TypeSafe/Jev is configured: a live 12-field decision and the three-action atomic workflow passed with calibrated Jev choices. Browserbase and Composio keys are present, but their real executor/account effects have not been live-verified. Sentry has no DSN yet. The ignored `.env` must never be committed.

## Access rules (the API is unauthenticated and spends paid model quota)

- The server listens on `127.0.0.1` only (`GHOST_HOST` overrides it; never expose it on shared Wi-Fi).
- Every `POST` MUST send `Content-Type: application/json`, otherwise `415`. This forces a CORS preflight, so no web page can reach a handler with a "simple" request.
- A request whose `Origin` header is present and is not `chrome-extension://*` or `http://localhost:*` / `http://127.0.0.1:*` gets `403` (not just missing CORS headers).
- A request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` gets `403` (DNS rebinding).
- Body limits count streamed bytes too: form 512 KB, next 128 KB, walk outcomes 64 KB, metrics 32 KB, presence 2 KB, ghost-text 64 KB, extract 128 KB, loop synthesize / preview / execute 1 MB, loop compile 256 KB (`413`).
- The loop execution routes (`/v1/loop/compile`, `/v1/loop/preview`, `/v1/loop/execute`, `DELETE /v1/loop/execute/:runId`) are stricter, because they send mail, write sheets and open billed cloud browsers from the user's own accounts. See "Loop execution: access and confirmation" below.
- Limits on `/v1/predict/form`: at most 100 fields and 64 fact keys (`400` above that).

## Configuration (`server/src/config.ts`)

Decision provider precedence (first match wins), reported by `/v1/health`:

1. `TYPESAFE_API_KEY`: `typesafe` (TypeSafe direct, `@typesafe-ai/sdk`, `POST https://api.typesafe.ai/v1/systemone`)
2. `AI_GATEWAY_API_KEY`: `jev-gateway` (Vercel AI SDK `experimental_evaluate`, model `typesafe-ai/jev`)
3. `BASETEN_API_KEY`: `baseten` (Baseten Model APIs, hedged self-consistency over structured outputs; confidence is a vote, NOT calibrated; see "Baseten provider" below and `docs/baseten.md`)
4. `OPENAI_API_KEY` or `XAI_API_KEY`: `llm` (OpenAI-compatible structured-output adapter; confidence NOT calibrated)
5. nothing: `heuristic`

Text provider: `baseten` if `BASETEN_API_KEY` (OpenAI-compatible, base `https://inference.baseten.co/v1`, default model `zai-org/GLM-5.3-Flash`, thinking switched off, reasoning stripped), else `openai` if `OPENAI_API_KEY`, else `xai` if `XAI_API_KEY` (base `https://api.x.ai/v1`, default model `grok-4.20-non-reasoning`), else `template`. `/v1/profile/extract` uses the same client. `/v1/loop/synthesize` still uses OpenAI / xAI only.

Baseten:

| Variable | Meaning |
| --- | --- |
| `BASETEN_API_KEY` | Enables decision provider `baseten` and text provider `baseten`. Sent as `Authorization: Bearer`. Never logged. |
| `BASETEN_BASE_URL` | Default `https://inference.baseten.co/v1`. |
| `BASETEN_DECISION_MODEL` | Default `zai-org/GLM-5.3-Flash`. Pick a model whose thinking can be switched off (`pnpm --filter @ghost/server baseten:models` lists the live catalog with the switch the server would use). |
| `BASETEN_TEXT_MODEL` | Default `zai-org/GLM-5.3-Flash`. |
| `BASETEN_SAMPLES` | K, valid samples a decision waits for. Default 3, clamped to 1..8. Below 3, no answer can reach the 0.7 gate (2 of 2 scores 0.69). |
| `BASETEN_HEDGE` | H, extra identical requests fired with the K. Default 1, clamped to 0..4. ONE decision costs K + H requests. |
| `BASETEN_DECISION_MODEL_URL` | Optional OpenAI-compatible base URL of a dedicated deployment (our own Tab model). Decisions only. Unverified: no such deployment exists yet. |
| `BASETEN_LOGPROBS` | `1` asks for `logprobs` and, if a response ever carries them, uses token probabilities instead of the vote (`confidenceSource: "logprobs"`). Off by default: the Model APIs accept the flag and return none. |
| `GHOST_WARMUP` | `0` skips the ONE one-token warm-up request sent at server start when `baseten` is the active decision provider. Never sent under Vitest. |

Loop execution (Stage 8):

| Variable | Meaning |
| --- | --- |
| `GHOST_EXTENSION_ID` | The Shabang extension's id from `chrome://extensions` (32 letters a to p, anything else is ignored). Only `chrome-extension://<this id>` may run REAL batches. |
| `GHOST_EXECUTE_TOKEN` | Per-install secret, at least 16 characters (shorter is ignored). A caller without an `Origin` (the desktop daemon, a script) sends it as `X-Ghost-Token`. Never logged. |
| `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` | Enable `parallel` mode. Both are required. |
| `BROWSERBASE_CONCURRENCY` | Cloud browsers open at once, default 5, clamped to 10. The cap is process-wide, not per request. |
| `BROWSERBASE_CONTEXT_ID` | A Browserbase context the user logged in to once. Loaded read-only (`persist: false`) so every cloud browser starts logged in. Without it they start logged out. |
| `GHOST_PUBLIC_DEMO_URL` | Public URL serving the same site as a PRIVATE `baseUrl` (localhost demo behind a tunnel). Never applied to a public `baseUrl`. Use the final `https://` URL: a redirect to another origin fails the step. |
| `COMPOSIO_API_KEY`, `COMPOSIO_USER_ID`, `COMPOSIO_GMAIL_ACCOUNT_ID`, `COMPOSIO_GOOGLESHEETS_ACCOUNT_ID`, `COMPOSIO_SPREADSHEET_ID`, `COMPOSIO_SHEET_RANGE` | Enable and configure `api` mode. |

With `GHOST_PROVIDER=heuristic` (e2e) both server executors stay simulated even when their keys exist.

Sentry outcome capture:

| Variable | Meaning |
| --- | --- |
| `SENTRY_DSN` | Enables manual `ghost.walk.*` capture. Without it the sink is a no-op. A malformed DSN is ignored. |
| `SENTRY_ENVIRONMENT` | Optional safe label, default `development`. |
| `SENTRY_RELEASE` | Optional safe release label. |

Default Sentry integrations, request tracing and default PII are disabled. `beforeSend` rebuilds each event from the strict shared outcome schema. `GHOST_PROVIDER=heuristic` also disables the Sentry config to keep e2e fully offline.

Overrides used by tests and e2e so they never need keys: `GHOST_DECISION_PROVIDER=heuristic`, `GHOST_TEXT_PROVIDER=template`. `GHOST_PROVIDER=heuristic` is shorthand for both. `GHOST_FAST_PATH=0` disables the heuristic fast path. Both overrides also accept `baseten` (and the other provider names); a forced provider without credentials degrades to `heuristic` / `template`. Forcing `heuristic` + `template` removes the Baseten config from the server entirely: no client, no warm-up, zero network.

## Baseten provider (`server/src/providers/baseten.ts`, `consensus.ts`, `hedge.ts`)

Measured on the Model APIs: `logprobs` / `top_logprobs` are accepted but `choices[].logprobs` never comes back, and `n` must be 1. So confidence comes from self-consistency, and sampling means parallel requests.

- ONE logical decision per form. All questions go into one prompt; the option list shared by a form's questions is sent once (`optionSets`). The answer is a JSON object constrained by `response_format: { type: "json_schema", strict: true }` with one `enum` per question (choice: the option names, options longer than 24 characters or with unusual characters aliased to codes `o<i>` and mapped back; noul: `yes` / `no`; score: `"0".."N"`). Thinking is switched off per model (`chat_template_kwargs`), `temperature` 0.7 (0 when K = 1), `max_tokens` = 48 + 16 per question, header `x-session-affinity: ghost-<hash of model + schema>`.
- K + H identical requests are fired in parallel. The decision resolves with the first K valid samples and aborts the stragglers. No retries beyond the hedge.
- Deadline 2.3 s (inside the 2.5 s decision deadline). With at least 1 valid sample at the deadline, the answer comes from what arrived and every confidence is scaled by `votes / K`. With 0 samples the provider throws and the heuristic fallback answers (`fallbackFrom: "baseten"`).
- Consensus per question: `probabilities` = vote fractions with ONE pseudo-vote shared by the offered options, `(count + 1/n) / (votes + 1)`, so they sum to 1 and 3 of 3 is 0.77 on a 13-option question, never 1.0. `choice` = argmax; a tie answers `none` when offered, otherwise the first tied option at confidence 0. `confidence` = smoothed top fraction x `min(1, votes / K)`. Codes that were never offered are discarded per question. noul = smoothed fraction of yes, pulled toward 0.5 for partial votes. score = mean of the votes plus the smoothed distribution and the legend.
- `calibrated: false`. Internally every answer carries `confidenceSource: "consensus"`, `votes` and `expected`, and the result carries `sampling` (launched, received, failed, abandoned, partial, rateLimited, arrivalsMs); none of that reaches the wire.
- Rate budget: the provider reads `x-ratelimit-remaining-requests` and `x-ratelimit-limit-requests`, adds what the bucket refilled since (limit / 60 s, capped at the limit), and never fans out further than that estimate (hedge first, then samples; always at least one request). A 429 sets the remembered budget to 0; a budget older than 60 s is forgotten. Measured on a new account: limit 15 requests per minute, a bucket of about 8 after an idle stretch, one request back every 4 s. Aborted stragglers still count.
- `401` / `403`: the provider pauses for 60 s (zero network, the heuristic answers) and logs one line without the key.

- Measured (2026-09-19, GLM-5.3-Flash, K=3 + H=1, 12-field form, 8 decisions): p50 1052 ms, slowest 1150 ms, 0 failed, first sample at 604 ms p50. Full numbers, the ambiguous-form comparison and the limitations are in `docs/baseten.md` and `docs/media/bench-providers*.md` (`node scripts/bench-providers.mjs`, `--ambiguous` for the look-alike form; refuses more than 120 real calls).
- Text: `POST /v1/ghost-text` streams through the OpenAI-compatible client with `chat_template_kwargs` from the same per-model table, `max_tokens`, header `x-session-affinity: ghost-text`; `reasoning_content` deltas are ignored and `<think>` blocks are filtered out of the stream. `firstTokenMs` and `latencyMs` are reported like on the xAI path.

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
`{ ok: true, provider: "typesafe"|"jev-gateway"|"baseten"|"llm"|"heuristic", calibrated: boolean, textProvider: "baseten"|"openai"|"xai"|"template", model?: string, textModel?: string, sampling?: { samples, hedge, confidenceSource: "consensus" }, version: string }`. `model` is the decision model, `textModel` the ghost-text model; `sampling` is present only for `baseten`.

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

### `POST /v1/walk/outcomes`

Accepts the value-free `GhostWalkOutcome` contract from `@ghost/shared` (64 KB maximum): one redacted outcome per Tab walk. The extension and server both reconstruct this object from an allowlist. Unknown properties are dropped; invalid or widened actions, sources, verdicts, counts, buckets or IDs return `400`, as does a summary that contradicts the proposals it describes.

Response: `{ accepted: true, captured: boolean, replayId?: string }`. `captured` means a configured Sentry SDK accepted the event for delivery; telemetry failures never fail, delay or change a walk. `replayId` is present when the walk was reviewable (a locked proposal was accepted, a confident calibrated proposal was rejected, or the walk was abandoned) and was added to the review queue.

### `GET /v1/walk/replays`

Returns `{ schemaVersion, count, fixtures }` for the newest 100 reviewable walks in this server process. The queue is volatile and exists for immediate review/export; configured Sentry events and their redacted JSON attachments are the durable inbox. Use `pnpm eval:walk-replays export`, then review and commit appropriate cases under `evals/walk-replays/`. See [`learning-loop.md`](learning-loop.md).

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
- Prompt hygiene: page text only appears as JSON string values inside `<untrusted_page_data>`; no urls, locators, constants, resolved values or profile data are sent. Sensitive-looking facts (by label or locator name) are dropped at validation. Page text shaped like an SSN, or a SIN / 13 to 19 digit number with a valid Luhn check digit, is dropped at validation too (the heuristic never sees it, so Shabang never copies it). In front of the prompt the broader shape test applies to typed values AND candidate text: any SSN shape, SIN shape or 13 to 19 digit run is left out, whatever its label says, before the prompt and the cache key are built.
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

## `/v1/presence` (coexistence of the extension and Shabang Desktop)

Both clients can draw ghosts in a browser. The extension says "I am alive in this browser" with a heartbeat; Shabang Desktop reads the list and stays out of a browser whose extension heartbeat is younger than 90 s (`docs/desktop.md`, "Coexistence with the extension"). Code: `server/src/routes/presence.ts`. In memory only, nothing is logged, and no model is ever called.

Same access rules as every other route (`Content-Type: application/json` on `POST` or `415`, foreign `Origin` `403`, foreign `Host` `403`). Body limit 2 KB, streamed bytes included (`413`).

### `POST /v1/presence`
```json
{ "client": "extension" | "desktop", "browser": "chrome", "version": "0.1.0" }
```
- `client` is required. Anything else is `400`.
- `browser` is optional, 1 to 32 characters after trimming, stored lowercased, alphabet `a-z 0-9 space . _ -` starting with a letter or digit. The extension MUST send it (Desktop ignores an extension entry without one); Desktop omits it.
- `version` is optional, 1 to 32 characters of `0-9 A-Z a-z . + _ -`.
- `null` counts as absent. A wrong type, an empty or over-long string, or another character is `400`; error messages name the field, never the value. Unknown keys are ignored.
- Response `200 { "ok": true }`. One entry is kept per `(client, browser)`; a new heartbeat replaces it.

### `GET /v1/presence`
```json
{ "clients": [{ "client": "extension", "browser": "chrome", "version": "0.1.0", "lastSeenMs": 1800000000000, "ageMs": 12000 }] }
```
Newest first. `browser` and `version` are `null` when the client did not send them. `lastSeenMs` is the server clock (epoch ms) and `ageMs = now - lastSeenMs` on the same clock, never negative, so a reader needs no clock of its own: use `ageMs`. An entry is pruned 5 minutes after its last heartbeat. At most 32 entries are kept (the oldest goes first), so invented browser names cannot grow the list.

### The heartbeat the extension must send (every 30 s)
From the background worker, with the same base URL as the other server calls:
```ts
await fetch(`${serverUrl}/v1/presence`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client: "extension", browser: browserName(), version: chrome.runtime.getManifest().version }),
}).catch(() => undefined); // fire and forget: the server may be down, and that must never surface to the user
```
- Send one immediately when the worker starts, then every 30 s. Desktop's freshness window is 90 s, so two lost heartbeats in a row are tolerated. Send only while Shabang is enabled in the extension; to hand a browser back to Desktop just stop sending (there is no "leave" call, the entry ages out).
- An MV3 service worker is stopped after about 30 s of idleness and a `setInterval` dies with it. Drive the heartbeat with `chrome.alarms` (`periodInMinutes: 0.5`, the minimum since Chrome 120; needs the `"alarms"` permission in `manifest.json` AND `manifest.firefox.json`, the Firefox build fails when the two permission lists drift), or have each visible content script send a `ghost:presence` message every 30 s and let the background throttle to one POST per 25 s (no new permission).
- `browser` must be one of the names Shabang Desktop maps bundle ids to (`desktop/src/GHServerClient.m`): `chrome`, `chromium`, `arc`, `brave`, `edge`, `opera`, `vivaldi`, `firefox`, `safari`. Detection order: `chrome.runtime.getURL("")` starts with `moz-extension://` is `firefox`; else `navigator.userAgentData.brands` containing `Microsoft Edge` is `edge`, `Opera` is `opera`, `Brave` is `brave`, `Google Chrome` is `chrome`; else `chromium`. Arc and Vivaldi present themselves as Chrome, so they need a user override (an options setting) or Desktop will keep drawing in them.
- Firefox: the worker's `Origin` is `moz-extension://<uuid>`, which `ALLOWED_ORIGIN` in `server/src/lib/guard.ts` does not accept yet, so every server call from the Firefox build (this one included) gets `403` until that pattern allows `moz-extension://[0-9a-f-]+`.

Shabang Desktop may send `{ "client": "desktop", "version": "<CFBundleShortVersionString>" }` on the same schedule; nothing depends on it yet.

## Vision fallback (`/v1/vision/*`, OpenAI)

Jev reads text only. When the DOM or the macOS accessibility tree has a control with no text (an icon-only button, a canvas app, an image-only PDF, a custom-drawn widget), a client can ask OpenAI to SEE it. The answer is text that joins the state Jev decides over, or a ghost target. Nothing here clicks or types. Code: `server/src/routes/vision.ts`, `server/src/vision/**`. Why and how it fits: `docs/openai.md`.

Configuration: enabled only when the server's LLM config is OpenAI (`OPENAI_API_KEY`; `OPENAI_BASE_URL` is honored). Every offline switch that drops that config also disables vision: `GHOST_PROVIDER=heuristic` (e2e), `GHOST_DECISION_PROVIDER=heuristic` + `GHOST_TEXT_PROVIDER=template`. An xAI or Baseten key does not enable it. `OPENAI_VISION_MODEL` (default `gpt-5.6-luna`), `GHOST_VISION_BUDGET` (default 200 billed calls per process, retries included; `0` disables), `GHOST_VISION_CACHE` (default 200 remembered pages; `0` disables).

Access: the local-only guard of every route (JSON `Content-Type` or `415`, foreign `Origin` / `Host` `403`), PLUS the loop routes' caller rules (`executors/access.ts`), because vision spends paid quota and carries screen pixels: a web page is refused with `403` even on localhost; a browser extension must be the pinned one (`GHOST_EXTENSION_ID`) or send a valid `X-Ghost-Token` (`GHOST_EXECUTE_TOKEN`), else `403`; a caller without an `Origin` (Shabang Desktop, a script) is admitted; a wrong token is `401`. Checked before availability, so a refused caller never costs a budget unit. `GET /v1/vision` stays open (no call, no pixels). Body limit 2.1 MB (`413`).

### `GET /v1/vision`
`{ "available": true, "provider": "openai" | null, "model": "gpt-5.6-luna" | null, "budget": { "limit": 200, "used": 3, "remaining": 197 }, "cache": { "enabled": true, "entries": 4, "hits": 9, "misses": 4 } }`. No model call.

### `POST /v1/vision/label`
```json
{
  "image": "data:image/png;base64,...",
  "boxes": [{ "id": "ax-17", "x": 368, "y": 36, "width": 48, "height": 48 }],
  "context": { "app": "Mail", "nearbyText": ["To: team"] },
  "page": { "pathPattern": "/inbox/*" }
}
```
- `image`: a base64 data URL, PNG or JPEG only, at most 1,500,000 decoded bytes (`413`). The magic bytes decide the type and must match the data URL (`400`). Width and height are read from the PNG IHDR / JPEG frame header; an image that would need more than 30,000 patches of 32 x 32 px is refused with `413` (OpenAI rejects those rather than resizing them).
- `boxes`: 1 to 40, unique `id` (1 to 64 characters, never sent to the model: boxes are renamed `b1..bN`), pixel coordinates in the image. A box overhanging the edge is clipped; one entirely outside is `400`.
- `context` (optional): `app` (at most 64 characters), `mediaControls` (a boolean; the client says these boxes sit in a `<video>`'s controls or an AX group around a media element — used only by the affordance classifier in code, NEVER sent to the model), `nearbyText` (at most 20 strings of at most 80 characters; lines that look sensitive, contain an email address or 7 or more digits, or carry bidi overrides / isolates are dropped before the prompt). Every text field is NFKC-folded and stripped of invisible characters (format characters such as soft hyphens, zero-width characters and Unicode tags, variation selectors, the combining grapheme joiner) before any check, so `Pass<soft hyphen>word` is read as `Password`. A `context.app` with bidi overrides is `400`. `context.windowTitle` is REFUSED with `400`, whatever its value: window titles can be private.

ONE `POST {OPENAI_BASE_URL}/responses` call: `instructions`, one user message with `input_text` (the JSON state: image size, aliased boxes with centers, context) and `input_image` (`detail: "original"` on models that document it, else `"high"`; when that detail level makes OpenAI downscale the image, for example gpt-5.4 / gpt-5.5 above 10,000 patches or 6000 px, or gpt-4o by the tile rules, the state gives the model the size it sees and box coordinates in that grid), `text.format` = `json_schema` with `strict: true` and a FIXED schema (the first request with any new schema is slower), `reasoning: { effort: "none" }` on the gpt-5.6 family (`"low"` on gpt-6-astra, omitted otherwise), `max_output_tokens`, `store: false`.

Response `200`:
```json
{ "labels": [{ "id": "ax-17", "label": "Delete", "role": "button", "affordance": "unknown", "irreversible": true, "sensitive": false, "confidence": 0.81 }],
  "provider": "openai", "model": "gpt-5.6-luna", "calibrated": false, "cached": false, "latencyMs": 740 }
```
- Exactly one entry per request box, in request order, under the client's id. `role` is `button | link | field | checkbox | tab | menu | other`.
- `affordance` is the role from `docs/anywhere.md` section 2 that the label implies (`play`, `fullscreen`, `captions`, `search`, `cart`, `checkout`, `compose`, `reply`, `send`, `save`, `download`, `share`, `more`, `menu`, `settings`, `close`, `back`, `forward`, `scroll-more`, `field`, `submit`, `unknown`, ...), derived IN CODE by the SHARED classifier (`classifyAffordance` in `shared/src/affordance/roles.ts`, through the adapter `server/src/vision/affordance.ts`): the model is never asked for it and never sees the taxonomy. The whole batch is classified together, so a crop holding a fullscreen control is read as a media-controls cluster and the rest of that player bar resolves to `play` / `next` / `mute` / `captions`; a lone media word outside such a batch stays `unknown` on purpose. `primary-item` is never returned, because which item is first comes from layout, which one crop cannot show. The role is a hint: the client's ranker still decides with the page kind, its priors and its memory.
- Validated in code: an entry with an unknown or repeated id, a role outside the enum or wrong types is dropped, and that box comes back unanswered (`label: null`, `role: "other"`, `confidence: 0`). Labels are trimmed, invisible characters removed, clipped to 40 characters; a label that contains an email address or 7 or more digits, or a bidi override, becomes `null` with confidence `0` (name the control, not its content).
- `irreversible` = the model's flag OR the shared `isLockedAction` on the model's FULL label (before clipping and scrubbing): the model can lock a control, never unlock one ("Submit application" is locked even if the model says otherwise; so is "Save your changes to the shared folder and publish", clipped to 40 characters, and "Send to alex@example.com", scrubbed to `null`).
- `sensitive` = the shared `isSensitive` on the full label (password, card, government ID): never fill that control. A label with a bidi override cannot be read by these rules and comes back locked and sensitive.
- `confidence` is the model's self-report, NOT calibrated (`calibrated: false`).

### `POST /v1/vision/locate`
`{ "image": "data:image/png;base64,...", "instruction": "the attach resume button", "boxes"?: [...] }`. `instruction` is 1 to 200 characters; one that names a sensitive field ("the password field", hidden characters included) or contains a bidi override is refused with `400` before any call. `boxes` as above, 0 to 40.

Same call style (fixed `ghost_vision_locate` schema). The model prefers a supplied box id; otherwise it gives a center point and approximate size in image pixels.

Response `200`: `{ "box": { "x", "y", "width", "height" } | null, "boxId": "<client id>" | null, "label", "irreversible", "sensitive", "confidence", "provider", "model", "calibrated": false, "latencyMs" }`.
- A chosen supplied box returns that box's exact rectangle and id. An unknown box id falls back to the point. A point (and size) is mapped back from the model's grid to the image's pixels when OpenAI downscaled it, then becomes a box of the given size (24 x 24 px without one), clamped inside the image. Nothing found: `box: null`, `confidence: 0`. A target without a name code can check (the model's `label: null`, or a label scrubbed as personal data) is also `box: null`, `confidence: 0`.
- `irreversible` = model flag OR `isLockedAction` on the full label OR on the instruction. A located element whose full label is sensitive is never returned (`box: null`, `sensitive: true`).
- The result is only a ghost suggestion. The client still draws it, gates it on confidence, and requires an explicit Enter or click for a locked target.

### Errors, cost and privacy
- `503 { "error": "vision unavailable", "reason" }` without an OpenAI key (zero network). `400` / `413` validation (messages name the path, never a value). `429 { "error": "vision budget exhausted", "limit" }` once the process budget is spent (checked before building the request). `504 { "error": "vision timed out" }` after 8 s. `502 { "error": "vision provider failed", "reason": "upstream" | "network" | "malformed" | "refused" | "incomplete", "upstreamStatus"? }`.
- No retries on 4xx (429 included). A 5xx is retried once, after 200 ms, only if 2.5 s of the 8 s deadline remain and a budget unit can be taken; that unit is taken before the backoff, so a concurrent request cannot spend it meanwhile (it gets `429`), and every billed attempt is logged and measured.
- Images are validated, forwarded once and dropped; none is ever stored or logged. One log line per call, sizes, counts and token counts only: `[ghost] openai /v1/vision/label 740ms model=gpt-5.6-luna calibrated=false cache=miss image=png 480x120 bytes=1330 boxes=3 attempts=1 tokens=629/87 answered=3 locked=2 droppedText=0` (`tokens=in/out`, plus `+Nr` when the model billed reasoning tokens; absent if the reply carried no `usage`). Latency (failures included) is recorded in `/v1/metrics` under provider `openai`.
- The deadline scales with the batch, because ONE call answers every box: 8 s + 400 ms per box, capped at 24 s (9.2 s for 3 boxes, 16 s for 20, 24 s for 40).

### The per-page cache (`page.pathPattern`, label only)
Opt-in, per `docs/anywhere.md` section 4: a client that sends `page: { pathPattern }` gets the labels for that page remembered, so a second visit costs no call at all. Without it, nothing is cached.
- Key: `sha256(pathPattern | model | image size | every box rectangle, in order)`. The client's box ids are NOT part of it and are not stored (an AX signature can carry a name); the pattern itself is not stored either, only its hash. Entries hold the VALIDATED labels (already clipped, locked and sensitivity-checked) and nothing else: never an image.
- A hit returns `cached: true`, `latencyMs` near 0, logs `cache=hit ... attempts=0`, makes no HTTP call and takes no budget unit — and is served even when the budget is spent (that money was already paid). A miss on an unknown page with a spent budget is still `429`.
- Positional: cached labels come back under the CURRENT request's box ids.
- Any change to the geometry, the crop size, the box count, the box order or the model is a different key and costs a call: a stale label is a wrong ghost.
- Bounded: 200 pages (`GHOST_VISION_CACHE`), 30 minutes, oldest evicted first, in memory only, lost on restart.
- `page.pathPattern` is a PATTERN: 1 to 200 characters, no query string or fragment (`400`, they carry tokens and ids), nothing that looks like personal data (an email address, 7 or more digits: `400`, "replace them with *"), no bidi controls (`400`). It is NFKC-folded and stripped of invisible characters like every other text field, hashed locally, and never sent to the model or written to a log.

## Terminal (`POST /v1/predict/command`)

Predicts the next shell command for the zsh plugin `terminal/ghost.zsh` (setup and privacy: `terminal/README.md`). Code: `server/src/routes/command.ts`, `server/src/command/*`. Same global access rules as every route (`Content-Type: application/json` or `415`, foreign `Origin` / `Host` `403`); body limit 32 KB, streamed bytes included (`413`).

Request (unknown keys ignored, `null` counts as absent):
```json
{ "cwd": "northwind-app", "git": { "branch": "main", "dirty": true, "ahead": 0, "behind": 0, "untracked": 1 },
  "history": ["pnpm install", "pnpm build", "pnpm test", "git status", "git add -A"],
  "projectScripts": ["pnpm dev", "pnpm test", "make lib"], "prefix": "git c", "lastExitCode": 0 }
```
- `cwd` (string, max 255): the directory's basename. The server keeps only the last path segment of whatever arrives. `history` (required, max 30 strings, oldest first) is already filtered by the client. `projectScripts` max 40 strings of 200. `prefix` max 300 (what is typed). `git.dirty` is required inside `git`; counts are non-negative integers. `lastExitCode` 0 to 255. `400` messages name the path, never the value.

Behavior:
- Safety pass first, the same rules as the client (`server/src/command/filter.ts`, parity fixture `terminal/tests/filter-cases.tsv`): secret-looking history lines are dropped (exports / assignments of *KEY* *TOKEN* *SECRET* *PASS* *PWD*, `--password` / `--pass` / `--auth` flags, `Authorization:`, `Bearer `, `-p<password>`, `-p <password>` after `login` and for mysql / mongo clients, `redis-cli -a`, `openssl -pass`, `curl -u` / `--user` `user:pass`, `user:pass@` URLs, base64 / hex blobs of 24+, random-looking 30+ character runs split by `/`, private key headers, known token shapes, multi-line and 300+ character lines), and so is the command right after `ssh-keygen` / `gpg` / `sshpass` / `security find-generic-password`. A secret-looking `prefix`, or any non-empty `prefix` when the last `history` line is one of those commands, is answered `command: null` with no model call and no cache entry. A secret-looking branch name becomes `""`.
- Candidates are built IN CODE, at most 60, best first: commands that followed the last command earlier in the history (bigram, plus trigram agreement), context moves (after `git add` -> `git commit -m ""`; after `git commit` with `ahead > 0` -> `git push`; a failed test command -> rerun it; `git status` on a dirty tree -> `git add -A` / `git diff`; `git checkout -b X` -> `git push -u origin X`; `git clone` -> `cd <repo>`; `mkdir X` -> `cd X`; `behind > 0` -> `git pull`; ...), recent unique commands and project scripts. Only commands that extend `prefix` (and differ from it) survive. Destructive commands are NEVER candidates and never returned (`rm -rf`, `git push --force` / `-f` / `+ref`, remote-branch deleting pushes (`-d`, `--delete`, `:branch`, `--prune`), `git reset --hard`, `git clean -f`, `sudo`, `dd`, `mkfs`, `chmod -R 777`, `DROP` / `TRUNCATE`, `kubectl delete`, `terraform destroy`, `docker system prune`, `killall`, `curl | sh`, `npm publish`, ...); the response is checked again before it is sent.
- ONE Jev call: state `{ cwd, git?, lastCommands (the last 15 filtered commands, oldest first), lastExitCode? }` and one choice question `next_command` whose criteria are `c0..cN` plus `none`. Each option is the command followed by the evidence code found for it, in words (`git commit -m ""  (commits the changes that were just staged)`, `pnpm test  (ran right after the last command 2 times earlier in this session)`), because Jev reads text and does not count; no backticks in options (they refer to state paths). Instructions refer to `cwd`, `git`, `lastCommands` and `lastExitCode` with backticked paths. No candidates means no call.
- Only `typesafe` and `jev-gateway` answer this route. With `baseten` or `llm` configured the heuristic answers instead: a shell asks after every prompt and while typing, and those providers are rate-limited (Baseten fans one decision out to K + H requests) or slow.
- Deadline 1.5 s. On error, timeout or an unusable answer the heuristic answers with `fallbackFrom`: highest n-gram count, ties by recency, then context prior, then script order. Its confidence is uncalibrated: the share of the last command's prefix-matching followers, `count / (followers + 0.5)` (+0.05 per trigram agreement), so one observation stays under the 0.7 gate (0.67) and two consistent ones clear it (0.8); a context move uses its prior (0.8 for `git commit -m ""` after `git add`); a unique prefix match 0.75; a recency-only guess on an empty line 0.3.
- Cache: in-memory LRU of 500 keyed by a SHA-256 of `(cwd, git summary [branch, dirty, ahead > 0, behind > 0, untracked > 0], last 3 commands, prefix, lastExitCode)`. A hit is used only while its command is still one of the request's candidates. Identical concurrent requests share one call. Fallbacks are not cached.

Response:
```json
{ "command": "git commit -m \"\"", "confidence": 0.89, "provider": "typesafe", "calibrated": true, "candidates": 8, "latencyMs": 491, "cache": "miss" }
```
`command` is `null` when nothing fits (Jev answered `none`, no candidate, secret prefix). `fallbackFrom` is present after a fallback. The client shows the ghost only when `confidence >= GHOST_TERMINAL_MIN_CONFIDENCE` (default 0.7). Log line, numbers only: `[ghost] typesafe /v1/predict/command 488ms questions=1 calibrated=true cache=miss`; latency and cache hits are recorded in `/v1/metrics`.

Measured (2026-09-19, TypeSafe direct, a fictional session with history `pnpm install`, `pnpm build`, `pnpm test`, `git status`, `git add -A`, a dirty tree, four project scripts, no `prefix`, 8 candidates): `git commit -m ""` at confidence 0.89 in 491 ms server-side (560 ms client round trip); the repeat was a 0 ms cache hit. Before options carried their evidence the same session scored 0.69 (502 ms), under the gate.

## Fact sources (`GET /v1/facts`, `POST /v1/facts/scan`)

Builds the open fact graph from what the user already has (`docs/profile-sources.md`). The server reads the sources the request names, returns **proposals**, and forgets them. Code: `server/src/routes/facts.ts`, `server/src/facts/*`; the graph itself, the matcher and `applyProposals` live in `shared/src/facts/**` and run on the client.

**Nothing is persisted.** No document, fetched page, proposal or value is written to disk, cached between requests or logged. The response is the only place a value appears, and it goes back to the caller, which shows each proposal with its source and evidence and accepts them one by one. `/v1/predict/form` keeps receiving fact KEYS only.

**Access**: the loop and vision caller rules minus the pinning requirement — a web page never reaches this route, not even one on `http://localhost` (`403`, the proposals are the user's own details); with `GHOST_EXTENSION_ID` set only that extension's origin is admitted (`403` otherwise); a caller without an `Origin` (Shabang Desktop, a script) is local by the global guard, and a wrong `X-Ghost-Token` is `401`.

### `GET /v1/facts`
`{ "adapters": ["github","website","text","resume"], "model": { "provider": "xai", "model": "grok-…" } | null, "conflicts": { "provider": "typesafe", "calibrated": true } | null, "limits": { "sources": 5, "textChars": 20000, "proposals": 60 } }`. `model: null` means no text key: the code extractors answer alone. `conflicts: null` means no decision provider: conflicts are settled in code.

### `POST /v1/facts/scan`
```json
{ "sources": [
    { "kind": "github",  "login": "octocat", "etag": "W/\"abc\"" },
    { "kind": "website", "url": "https://alexchen.dev/about" },
    { "kind": "text",    "text": "...", "origin": "mail", "name": "gmail" },
    { "kind": "resume",  "text": "...", "name": "resume.pdf" } ],
  "hints": { "fullName": "Alex Chen", "workDomain": "northwind.test" }, "model": true }
```
1 to 5 sources; `text` at most 20 000 characters; body 256 KB (streamed bytes included, `413`). `origin` is `file` (default) / `mail` / `calendar` / `drive` and `name` is the file or connector name: together they become the fact's provenance (`file:resume.pdf`, `mail:gmail`), which is what a later "forget this source" matches on. `hints` are optional and never required. `model: false` runs the code extractors only, with zero model calls. `400` messages name the offending path and never echo a value.

Adapters:
- **github** — one unauthenticated `GET https://api.github.com/users/<login>` (5 s, 128 KB cap). **No token is ever sent**: this must work without a GitHub key, and a token would spend the user's rate limit on a scan. Reads `login`, `name`, `email`, `blog`, `company`, `location`, `twitter_username` and nothing else. ETag-friendly: the `etag` from a previous scan comes back as `If-None-Match`, and `304` is reported as `status: "unchanged"` with no proposals. A profile is structured already, so this adapter never costs a model call. `404` / `403` / `5xx` are a failed SOURCE, not a failed scan.
- **website** — ONE fetch of the URL the user typed. Not a crawler: no link on the page is followed. The address must be public before the socket opens (`400 … must be a public address` for a private or loopback host, credentials in the URL, or a non-http scheme) and again after DNS resolution (`reason: "blocked"`, and no request is made). Redirects are manual: at most 2 hops, only inside the same site (`www.` and an `http` → `https` upgrade allowed, never a downgrade), anything else is `blocked`. Only `text/html`, `text/plain` and `application/xhtml+xml` are read (`not text`), the read stops at 512 KB, and the HTML becomes text with `<script>`, `<style>`, `<noscript>`, `<svg>`, `<iframe>` and comments dropped whole — so nothing a page hid there can reach an extractor or a prompt — with the `<title>` and `<meta name="description">` first. The addresses behind links are kept only when they are a GitHub / LinkedIn / X profile or a `mailto:`; the page itself is proposed as the user's `website` (or `github` / `linkedin` / `links.twitter` when that is what it is).
- **text / resume** — the document the caller already has. A vCard (`BEGIN:VCARD`) is read exactly by code, which is what makes a shipping form fillable, and never costs a model call. `resume` also runs the résumé regex extractor (`graduationDate` is parsed into `YYYY-MM` in code).

Pipeline, in this order (`docs/profile-sources.md` section 3):
1. **Redact.** A line a person would read as sensitive (password, SSN / SIN, health or card number, date of birth) is dropped whole, and card-shaped (Luhn), SSN-shaped and IBAN-shaped values are scrubbed wherever they appear. This happens BEFORE any extractor or prompt, so sensitive material is never in the request to a model. Counted as `sensitiveDropped`, never kept.
2. **Code extractors** (`shared/src/facts/extract.ts`): emails, phone, links, vCard fields, the GitHub profile, the résumé regexes.
3. **ONE model call per prose document**, never one per fact, with the schema declared in the prompt and enforced in code (the shared OpenAI-compatible client speaks `response_format: json_object`). The model only picks text out of the document; it never decides what is sensitive and never writes a value of its own. The document is labelled untrusted in the prompt.
4. **Code validation.** Every model value must literally appear in the document or it is dropped and counted as `unverified`; the key must match the fact-key pattern; the label, aliases, category and field kinds are re-derived from the shared fact definitions; the evidence snippet is built in code from the line the value sits on. Anything sensitive is refused again here. Code extractors win a key the model also answered.
5. **ONE Jev call for genuine conflicts only.** Two sources that agree collapse to the more trusted one and are never asked about. Sources that disagree become one `choice` question each — `c0..cN` plus `none`, all in ONE call — over a state of `{ key, question, candidates: [{ option, value, from, evidence }] }`. Without a decision provider, with the heuristic one, on timeout (4 s), or when the answer is `none` or unusable, code picks the strongest candidate (confidence, then source trust), exactly as the graph would.

Response `200`:
```json
{ "proposals": [ { "key": "work.employer.current", "value": "Northwind Robotics", "category": "work", "label": "employer",
                   "aliases": ["company","current employer"], "confidence": 0.7, "source": { "kind": "github", "login": "octocat" },
                   "evidence": "company: @Northwind Robotics", "updatedAt": "2026-09-19T…", "kinds": ["text","select"] } ],
  "sources": [ { "kind": "github", "id": "github:octocat", "status": "ok", "proposals": 7, "sensitive": 0, "unverified": 0,
                 "modelCalls": 0, "latencyMs": 212, "etag": "W/\"abc\"" } ],
  "conflicts": [ { "key": "work.employer.current", "candidates": 2, "resolvedBy": "model", "confidence": 0.9 } ],
  "provider": "typesafe", "modelCalls": 1, "sensitiveDropped": 0, "latencyMs": 640 }
```
- A proposal carries everything the review list needs; the client turns an accepted one into a fact with `applyProposals` (`shared/src/facts/graph.ts`), which has the final say on conflicts, caps and sensitivity. At most 60 proposals, one per key.
- `sources[].status` is `ok` / `unchanged` / `failed`; `reason` is a fixed word (`timeout`, `network`, `not found`, `rate limited`, `blocked`, `too large`, `not text`, `malformed`, `upstream`), never a value. One failed source never fails the scan.
- Sensitive facts are never proposed, whatever a source or a model says; they are only counted.
- One log line per scan, counts and source KINDS only — never a login, a URL, a key or a value: `[ghost] facts /v1/facts/scan 640ms sources=2 [github:ok,website:failed(not found)] proposals=11 conflicts=1 sensitiveDropped=2 modelCalls=1`. Each model call is logged and measured on its own (`/v1/metrics`, route `/v1/facts/scan`).
