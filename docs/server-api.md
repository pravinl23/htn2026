# Ghost prediction server API (`server/`, http://localhost:8787)

Keys stay on the server. The extension only ever talks to this API. All bodies are JSON. CORS allows `chrome-extension://*` and `http://localhost:*` only.

## Access rules (the API is unauthenticated and spends paid model quota)

- The server listens on `127.0.0.1` only (`GHOST_HOST` overrides it; never expose it on shared Wi-Fi).
- Every `POST` MUST send `Content-Type: application/json`, otherwise `415`. This forces a CORS preflight, so no web page can reach a handler with a "simple" request.
- A request whose `Origin` header is present and is not `chrome-extension://*` or `http://localhost:*` / `http://127.0.0.1:*` gets `403` (not just missing CORS headers).
- A request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` gets `403` (DNS rebinding).
- Body limits count streamed bytes too: form 512 KB, next 128 KB, metrics 32 KB, ghost-text 64 KB, extract 128 KB (`413`).
- Limits on `/v1/predict/form`: at most 100 fields and 64 fact keys (`400` above that).

## Configuration (`server/src/config.ts`)

Decision provider precedence (first match wins), reported by `/v1/health`:

1. `TYPESAFE_API_KEY`: `typesafe` (TypeSafe direct, `@typesafe-ai/sdk`, `POST https://api.typesafe.ai/v1/systemone`)
2. `AI_GATEWAY_API_KEY`: `jev-gateway` (Vercel AI SDK `experimental_evaluate`, model `typesafe-ai/jev`)
3. `OPENAI_API_KEY` or `XAI_API_KEY`: `llm` (OpenAI-compatible structured-output adapter; confidence NOT calibrated)
4. nothing: `heuristic`

Text provider: `openai` if `OPENAI_API_KEY`, else `xai` if `XAI_API_KEY` (OpenAI-compatible, base `https://api.x.ai/v1`, default model `grok-4.20-non-reasoning`), else `template`.

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
Stage 6. Request `{ runs: TraceEvent[][] , pageSamples?: ... }`, response `{ program, provider }`. LLM is used only when heuristics fail. (Stub returning 501 until Stage 6.)

### `GET /v1/metrics` and `POST /v1/metrics/event`
In-memory latency log per route/provider with `count, failures, p50, p95, last`, cache hit rate, plus client-reported counters (`ghostsShown`, `ghostsAccepted`, `keystrokesSaved`, calibration pairs `(confidence, accepted)`).

Latency attribution: each model call is recorded under the provider that made it, failures and timeouts included (`failures` counts them, and their latency stays in the percentiles). Cache hits are recorded under the pseudo-provider `cache`, never under the model. A request that fell back is charged to the provider that failed, not to `heuristic`/`template`. `heuristic`, `template` and `regex` series only contain requests answered purely in code.

## Logging

Every model call logs one line: `provider route latencyMs questions=<n> calibrated=<bool> cache=<hit|miss>`. Never log field values, profile values, or keys.
