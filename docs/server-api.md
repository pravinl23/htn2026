# Ghost prediction server API (`server/`, http://localhost:8787)

Keys stay on the server. The extension only ever talks to this API. All bodies are JSON. CORS allows `chrome-extension://*` and `http://localhost:*` only.

## Configuration (`server/src/config.ts`)

Decision provider precedence (first match wins), reported by `/v1/health`:

1. `TYPESAFE_API_KEY`: `typesafe` (TypeSafe direct, `@typesafe-ai/sdk`, `POST https://api.typesafe.ai/v1/systemone`)
2. `AI_GATEWAY_API_KEY`: `jev-gateway` (Vercel AI SDK `experimental_evaluate`, model `typesafe-ai/jev`)
3. `OPENAI_API_KEY` or `XAI_API_KEY`: `llm` (OpenAI-compatible structured-output adapter; confidence NOT calibrated)
4. nothing: `heuristic`

Text provider: `openai` if `OPENAI_API_KEY`, else `xai` if `XAI_API_KEY` (OpenAI-compatible, base `https://api.x.ai/v1`, default model `grok-4.20-non-reasoning`), else `template`.

Overrides used by tests and e2e so they never need keys: `GHOST_DECISION_PROVIDER=heuristic`, `GHOST_TEXT_PROVIDER=template`. `GHOST_FAST_PATH=0` disables the heuristic fast path.

## Jev wire format (do not invent fields)

Request: `{ "model": "jev-latest", "state": <string|object|array>, "questions": { "<name>": Question } }`, header `Authorization: Bearer <key>`.

- `{ "type": "choice", "instructions": string, "criteria": { "<option>": string | null } }` (max 255 options; include `none`)
- `{ "type": "noul", "instructions": string, "criteria"?: { "true": string, "false": string } }`
- `{ "type": "score", "instructions": string, "criteria": string[] }` (2 to 10 levels, low to high)

Response: `{ "model": string, "answers": { "<name>": Answer }, "usage": { "input_tokens": n, "output_tokens": n } }`

- choice: `{ type, choice, probabilities, confidence }`
- noul: `{ type, noul }` (probability of true; no separate confidence)
- score: `{ type, score, probabilities, legend, confidence }`

HTTP 401 bad key, 422 validation, 429 rate limited, 529 overloaded (retry 429/529 with exponential backoff).

Through the Vercel AI SDK (`import { experimental_evaluate as evaluate } from "ai"`, `model: "typesafe-ai/jev"`, auth from `AI_GATEWAY_API_KEY`), the yes/no type is called `boolean` and its answer is `{ type: "boolean", probability }`; choice answers carry `choice` and `probabilities`; TypeSafe's confidence is in `result.providerMetadata.typesafe.confidence` (fall back to the max probability when it is absent). Usage is `result.usage.{inputTokens,outputTokens}`.

The shared TypeScript mirror of this lives in `shared/src/decision.ts` (`DecisionProvider.decide(state, questions)`).

## Routes

### `GET /v1/health`
`{ ok: true, provider: "typesafe"|"jev-gateway"|"llm"|"heuristic", calibrated: boolean, textProvider: "openai"|"xai"|"template", model?: string, version: string }`

### `POST /v1/predict/form`
Request: `FormPredictRequest` from `@ghost/shared` (`origin`, `formSignature`, `fields: CapturedField[]`, `factKeys: string[]`). The server never receives profile VALUES for this route, only fact KEYS.

Behavior:
- Build ONE decision call: state `{ page: { origin }, fields: [{ label, kind, name, placeholder, autocomplete, options (labels only, max 12), context }] }`, and one `choice` question per field named `f0..fN` whose criteria are `{ ...factKeys with FACT_DESCRIPTIONS, needs_text: "free-text answer the applicant must write", none: "no profile fact fits" }`. Instructions refer to the state with backticked paths, e.g. "Which profile fact should fill `fields[3]`?".
- Fast path: run the shared heuristic first. If every field is `none`/`needs_text`/mapped with confidence >= 0.9, answer from the heuristic with zero model calls. With a model provider, ask the model only when something is uncertain, still in ONE call covering all uncertain fields.
- Buttons, links and file inputs are never sent to the model (filter candidates in code first).
- Server-side cache keyed by `origin + formSignature + sorted factKeys` (in-memory LRU, 500 entries). Response says `cache: "hit" | "miss"`.
- On provider error or timeout (2.5 s), fall back to the heuristic and say so: `provider: "heuristic"`, `fallbackFrom: "<provider>"`.

Response: `FormPredictResponse` plus `cache` and optional `fallbackFrom`: `{ assignments: [{ signature, factKey, confidence }], provider, calibrated, latencyMs, cache }`.

### `POST /v1/predict/next`
Request: `{ origin, url, recentActions: TraceEvent[] (max 20), candidates: NextCandidate[] (max 60), memory?: EpisodicPair[] (max 5) }` where `NextCandidate = { id: string, kind: "button"|"link"|"field", label: string, locked: boolean, context?: string }`.
One `choice` question over candidate ids plus `none`. Heuristic provider: prefer the candidate that followed the same previous action in `memory`, else `none`.
Response: `{ candidateId: string | "none", confidence, provider, calibrated, latencyMs }`.

### `POST /v1/ghost-text`
Request: `{ fieldLabel, fieldSignature, maxChars?, pageContext: { company?, role?, description? (<= 2000 chars) }, facts: Record<string,string> (only the relevant, non-sensitive ones), pastAnswers: PastAnswer[] (<= 3) }`.
Response: `text/event-stream` with events `data: {"delta":"..."}` and a final `data: {"done":true,"text":"<full>","provider":"xai","latencyMs":1234,"firstTokenMs":210}`. With `?stream=0` returns JSON `{ text, provider, latencyMs }`.
Template fallback (no key): a deterministic 2 to 4 sentence draft built from facts + company/role. Drafts are first person, concrete, 60 to 120 words, no placeholders like "[Company]", and never invent employers, numbers or awards not present in facts/pastAnswers.

### `POST /v1/profile/extract`
Request: `{ resumeText: string (<= 20000 chars) }`. Response: `{ facts: Record<string,string>, pastAnswers: [], provider, latencyMs }` using the canonical fact keys in `shared/src/profile.ts` (`FACT_DESCRIPTIONS`). LLM path: JSON-mode chat completion, validated and filtered to known keys plus `extra.*`. No key: regex extraction (email, phone, URLs for github/linkedin/website, first line as name, school and degree keywords, graduation date parsed in code into `YYYY-MM`).

### `POST /v1/loop/synthesize`
Stage 6. Request `{ runs: TraceEvent[][] , pageSamples?: ... }`, response `{ program, provider }`. LLM is used only when heuristics fail. (Stub returning 501 until Stage 6.)

### `GET /v1/metrics` and `POST /v1/metrics/event`
In-memory latency log per route/provider with `count, p50, p95, last`, cache hit rate, plus client-reported counters (`ghostsShown`, `ghostsAccepted`, `keystrokesSaved`, calibration pairs `(confidence, accepted)`).

## Logging

Every model call logs one line: `provider route latencyMs questions=<n> calibrated=<bool> cache=<hit|miss>`. Never log field values, profile values, or keys.
