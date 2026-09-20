# OpenAI in Shabang: the eyes

Shabang predicts your next action and shows it as a ghost you accept with Tab. To predict, it turns the screen into text: the DOM in the browser extension, the macOS accessibility (AX) tree in Shabang Desktop. Jev (TypeSafe) then picks the next action from that text in one batched call.

That works until a control has no text. An icon-only button, a canvas app (Figma, Google Docs, games), an image-only PDF form, a custom-drawn toolbar: the DOM or AX tree reports "a button" and nothing else. Jev cannot choose "the button that attaches a file" when every candidate is called `button`.

**Jev decides from text in about 500 ms. OpenAI sees what text can't describe.**

So the split is:

| | Jev (TypeSafe) | OpenAI (vision) |
| --- | --- | --- |
| Input | Text only | The pixels of a small crop, plus a little text |
| Job | Decide: which field gets which fact, which control is next | Describe: name an unlabeled control, or point at the element an instruction describes |
| Output | Typed choices with calibrated confidence | Short labels, roles and boxes, validated in code |
| When | Every form, every page | Only for the few controls text cannot name |
| Cost per call | One batched decision | One Responses API call, budgeted |

OpenAI never makes the decision and never acts. Its output becomes more text in the state Jev reads, or a ghost target the user still has to accept.

## The desktop flow (unlabeled button to Tab)

The server half (step 3) is built and tested. The desktop steps 1, 2 and 4 are the planned integration; see "Verified vs mocked".

```
AX tree: AXButton with no AXTitle / AXDescription / AXHelp / nearby static text
   │  Shabang Desktop crops the window region around it (1x or 2x, PNG, <= 1.5 MB)
   ▼
POST /v1/vision/label  { image, boxes: [{ id: "<AX signature>", x, y, width, height }], context: { app, nearbyText } }
   │  ONE Responses API call: input_text (image size + boxes) + input_image, strict JSON schema output
   ▼
{ labels: [{ id, label: "Attach file", role: "button", affordance: "unknown", irreversible: false, sensitive: false, confidence: 0.92 }] }
   │  code validated: ids, role enum, 40-char labels, locks and sensitivity re-derived from the FULL label
   ▼
Desktop writes the label into its captured element ("Attach file", source: vision), caches it per AX signature
   │  the element now has text like every other candidate
   ▼
Jev: ONE decision over the page's candidates (+ "none")  →  "Attach file" at 0.91
   ▼
Shabang cursor glides to the paperclip  →  Tab accepts (a locked target still needs Enter or a click)
```

1. **Capture.** `GHCapture` already walks the AX tree and computes a label from `AXTitleUIElement`, `AXTitle`, `AXDescription`, `AXPlaceholderValue`, `AXHelp` or the nearest static text (`docs/desktop.md`). An enabled, visible `AXButton` / `AXLink` / `AXCheckBox` whose label comes out empty is a vision candidate. Sensitive elements (`AXSecureTextField`, anything `isSensitive` flags) are never cropped.
2. **Crop.** Only the region around the unlabeled controls, never the whole screen. Box coordinates are relative to the crop, in the crop's pixels. Up to 40 boxes per call, so a whole icon toolbar is ONE call.
3. **Label.** `POST /v1/vision/label` (contract in `docs/server-api.md`, "Vision fallback"). The server validates the image by its magic bytes, forwards it once, and drops it.
4. **Merge.** The returned label is stored on the element exactly like an AX label, marked `source: vision`, and cached by the element's AX signature, so the same toolbar never costs a second call. Low-confidence labels (below the 0.7 gate) are not used.
5. **Decide.** Jev gets the page's candidates, now including "Attach file", in its usual ONE batched call. It picks; it never sees the image.
6. **Shabang.** The ghost cursor goes to the chosen element. Tab accepts. If the label or the model says the control is irreversible (send, submit, pay, delete, confirm, publish), the ghost shows a lock and needs Enter or a click, whatever the model said: code can lock, the model can never unlock.

When the AX tree has no element at all for what Shabang wants (a canvas app draws everything itself), `POST /v1/vision/locate` answers "where is *the attach resume button*?" with a box in image pixels. That is the computer-use-style fallback, reduced to pointing: the result is only ever a ghost suggestion, and nothing clicks.

The browser extension can use the same routes for icon-only buttons with no `aria-label`, `title` or text, and for `<canvas>` regions.

## What the server does (and does not) send to OpenAI

- **One call per request, one request per crop.** `POST /v1/responses` with `instructions`, one user message holding `input_text` (a small JSON state: image size, boxes renamed `b1..bN` with their centers, `context.app`, filtered `context.nearbyText`) and `input_image` (the base64 data URL), and `text.format: { type: "json_schema", strict: true }`.
- **Fixed schemas.** The label and locate schemas never change per request, because OpenAI documents extra latency the first time it sees a schema. Box ids and length limits are therefore enforced in code, not in the schema.
- **Pick-style output, checked by code.** The model returns short labels, a role from a closed enum, a lock flag and a confidence. Code drops entries with unknown or repeated ids, wrong types or roles outside the enum, trims and clips labels to 40 characters, and throws away a label that looks like personal data (an email address, 7 or more digits). `irreversible` is the model's flag OR the shared `isLockedAction` on the model's full label, read before clipping and scrubbing (and on the instruction for locate). `sensitive` is the shared `isSensitive` on that full label. Locate never returns a target whose label is sensitive, null, or scrubbed. All text is NFKC-folded and stripped of invisible characters (soft hyphens, zero-width characters, Unicode tags, variation selectors) before any rule reads it, and text with bidi overrides is refused or dropped, so hidden characters cannot hide a lock, a sensitive field or an instruction.
- **Who may call.** Vision spends the user's paid quota and carries screen pixels, so it uses the loop routes' caller rules: no web page (not even on localhost), only the pinned extension (`SHABANG_EXTENSION_ID`) or a caller with `X-Shabang-Token`, or a local process without an `Origin` (Shabang Desktop).
- **Privacy.** Client ids never reach the model (an AX signature can contain a label). `context.windowTitle` is refused with 400: window titles name documents, threads and people. `nearbyText` lines that look sensitive are dropped before the prompt. `store: false` asks OpenAI not to keep the response for later retrieval (OpenAI's own abuse-monitoring retention is governed by its data controls, not by this flag). The server keeps no image, ever; its log line has sizes, counts, token counts and latency only. It keeps validated LABELS for a page a client asked it to remember ("The per-page cache" below), never the image and never the client's box ids.
- **Cost.** A per-process budget (`SHABANG_VISION_BUDGET`, default 200 billed calls, retries included) returns 429 when spent. The deadline scales with the batch, because one call answers every box: 8 s plus 400 ms per box, capped at 24 s (9.2 s for 3 boxes, 16 s for 20, 24 s for 40). Measured calls come in at a quarter of that. No retries on 4xx (429 included); one retry on a 5xx only if time remains and a budget unit can be taken, taken before the backoff so a concurrent request cannot spend it. Images over 1.5 MB, or over OpenAI's 30,000-patch limit, are refused before any call.

## Model choice and where it came from

Default `OPENAI_VISION_MODEL=gpt-5.6-luna`, confirmed live on 2026-09-19: the id is in `GET /v1/models` on this account, and it answered every call below. Sources, read on 2026-09-19:

- Model catalog, `https://developers.openai.com/api/docs/models`: gpt-5.6-luna is the cost-optimized tier ($0.20 / $1.20 per 1M input / output tokens) with image input.
- Model page, `https://developers.openai.com/api/docs/models/gpt-5.6-luna`: text and image input, Responses API supported, Structured Outputs supported, `reasoning.effort` supports `none, low, medium (default), high, xhigh, max`.
- Vision guide, `https://developers.openai.com/api/docs/guides/images-vision`: `input_image` with `image_url` (a data URL) and `detail` (`low | high | auto | original`); the gpt-5.6 family supports `original`; use `original` for coordinate-sensitive and computer-use images; 32 px patches and a 30,000-patch rejection limit; PNG and JPEG are supported types.
- Responses API reference, `https://developers.openai.com/api/reference/resources/responses/methods/create`: `instructions`, `input`, `text.format` (`json_schema`, `name`, `schema`, `strict`), `reasoning.effort`, `max_output_tokens` (includes reasoning tokens), `store` (defaults to true). The raw HTTP response has no `output_text`: that is an SDK convenience, so the server reads the `output_text` parts of `message` items and treats a `refusal` part, `status: "incomplete"` or an `error` object as a failure.
- Structured Outputs guide, `https://developers.openai.com/api/docs/guides/structured-outputs`: strict mode needs every property required and `additionalProperties: false`; nullable fields use `["string", "null"]`; `minimum` / `maximum` and `maxItems` are supported; the first request with a new schema is slower.
- Computer use guide, `https://developers.openai.com/api/docs/guides/tools-computer-use`: screenshots are sent with `detail: "original"`; if an image is downscaled, remap coordinates back. Locate follows that advice: the default model keeps the image's own pixels; on a model whose detail level downscales the image, the server computes the size the model sees (the guide's sizing table and patch-budget algorithm), states that size and the boxes in that grid, and maps the returned point back before clamping it.

Per model, the server sends only what that model documents: `reasoning: { effort: "none" }` and `detail: "original"` for the gpt-5.6 family; `effort: "low"` and `original` for gpt-6-astra (its lowest effort); `original` without `reasoning` for gpt-5.5 / gpt-5.4; `detail: "high"` and no `reasoning` for anything else (gpt-4.1-mini, gpt-4o, ...). Sizing as the model sees it (vision guide table): gpt-5.6 / gpt-6 `original` keeps the size (over 30,000 patches is rejected, so the server refuses it first); gpt-5.5 / gpt-5.4 `original` fits 6000 px and 10,000 patches; gpt-5.2 / gpt-4.1-mini `high` fits 2048 px and 6,144 patches; gpt-4.1, gpt-4o and unknown models use the tile rules (fit 2048 x 2048, shortest side 768). A model that reasons gets 4,000 extra `max_output_tokens` so reasoning cannot cut the JSON short.

## Anywhere, not just forms (docs/anywhere.md section 4)

Vision exists because "Shabang anywhere" needs names for controls that have none. A player bar, a cart glyph, a kebab menu: the DOM and the AX tree say "a button". So the label route is shaped for a whole page, not for one field:

- **One call per page view, up to 40 boxes.** A whole icon toolbar, or a player bar plus a grid of buttons, is ONE request. Asking about 20 boxes instead of 3 costs about 1.7 s more and less than a tenth of a cent (numbers below). Never one call per control.
- **Every entry carries an affordance role.** Each label comes back as `{ id, label, role, affordance, irreversible, sensitive, confidence }`. `affordance` is one of the roles in `docs/anywhere.md` section 2 (`play`, `fullscreen`, `next`, `search`, `cart`, `checkout`, `compose`, `reply`, `send`, `save`, `download`, `share`, `more`, `menu`, `settings`, `close`, `back`, `forward`, `scroll-more`, `field`, `submit`, `unknown`, ...). It is derived **in code**, never asked of the model, which never sees the taxonomy. That is what turns a row of pixels into `play`, then `fullscreen`, on a site nobody wrote a rule for.
  - **The same classifier as everything else.** `server/src/vision/affordance.ts` is an ADAPTER over `classifyAffordance` in `shared/src/affordance/roles.ts`, the one the extension ranker and the native agent use. Same module, not a second copy of the vocabulary: a role learned from a DOM label and the same role read off pixels must be the same string, scored the same way, or role-keyed memory cannot transfer between them.
  - **Classified as a batch, not one at a time.** The shared classifier deliberately discounts player vocabulary outside a player ("Play squash", "Next step"), so a lone "Play" is `unknown` and should be. But "Fullscreen" is not discounted: nothing else on a page is called that. A crop the client grouped that holds a fullscreen control IS a media-controls cluster, so the batch is classified a second time with that context and the rest of the bar (`play`, `next`, `mute`, `captions`) resolves. The evidence is a control in the same crop: never a site, a URL or an app name. A client that already knows can say so with `context.mediaControls: true`, which is never sent to the model.
  - `primary-item` is never produced here: which item is "the first one" comes from layout, which one crop cannot show.
  - The role is a HINT. The client's ranker still decides, with the page kind, the priors and its role-keyed memory.
- **Code still owns the lock.** `irreversible` is the model's flag OR `isLockedAction` on the model's full label; `sensitive` is `isSensitive` on it. A model can lock a control and can never unlock one. Live proof: the model returned `irreversible: false` for nothing it should have locked, and code independently locked "Checkout" and "Send" in the 20-box run below.

## The per-page cache

`docs/anywhere.md` section 4 asks for "cached by a hash of the box geometry plus the page's path pattern", so a second visit costs nothing. `server/src/vision/cache.ts`:

- **Opt-in.** A client sends `page: { pathPattern: "/watch" }`. Without it nothing is cached and every request is a call, exactly as before.
- **The key** is `sha256(pathPattern | model | crop size | every box rectangle, in order)`, truncated to 32 hex characters. The client's box ids are NOT in it (an AX signature or a DOM id can carry a person's name), and neither the pattern nor any id is stored: the key is a hash and the entry holds labels only.
- **A hit costs nothing**: no HTTP call, no budget unit, `cached: true` in the response, `cache=hit` in the log, 0 ms measured. A hit is answered even once the budget is spent, because the money was already paid.
- **A control that moved is a miss.** Any change to the geometry, the crop size, the box count, the order or the model changes the key. A stale label is a wrong ghost, so the cache errs towards paying again.
- **Bounded and short-lived**: 200 pages (`SHABANG_VISION_CACHE`, `0` disables), 30 minutes, oldest evicted first, in memory only.
- **`pathPattern` is validated like everything else**: at most 200 characters, no query string or fragment (those carry tokens and ids), nothing that looks like personal data (an email address, 7 or more digits), no bidi controls. A client that sends a raw URL is told to send a pattern.

## Live numbers (measured 2026-09-19, gpt-5.6-luna, from the development machine)

`pnpm test:live vision` (`server/test/live/vision.live.test.ts`), three real calls per run. Every image is drawn in code by `server/src/vision/png.ts`: no binary fixture, no screenshot of anyone's screen, nothing from a real site.

| Call | Image | Boxes | Latency | Tokens in / out | Cost |
| --- | --- | --- | --- | --- | --- |
| `label`, icon row | 288 x 96 PNG, 889 bytes | 3 icon-only | **1,984 ms** (2,407 ms on a second run, 2,352 ms on the first probe) | 629 / 87, 0 reasoning | **$0.00023** |
| `label`, mixed page | 640 x 448 PNG, 6,375 bytes | 20 (7 icon-only + 13 text) | **3,671 ms** (3,528 ms on a second run) | 1,447 / 497, 0 reasoning | **$0.00089** |
| `label`, cache hit | same request again | 3 | **0 ms** | none: no call | **$0** |
| `locate`, toolbar | 480 x 120 PNG | 3 | **1,226 ms** | not recorded | about $0.0002 |

Cost is the measured token counts at the catalog's published $0.20 / $1.20 per 1M input / output tokens; the token counts are measured, the price is quoted from the model catalog and not independently verified. A page of 20 controls costs under a tenth of a cent, so 1,000 pages is about **$0.89** — and a repeat visit to any of them is free.

Seventeen more boxes cost about 1.7 s and 0.0007 dollars: batching is overwhelmingly the right call, and one call per control would be 20 times the money and 20 times the wait.

**What the model actually returned**, from the 20-box call, with the affordance role code derived from each label:

```
previous="Previous"/previous   play="Play"/play         next="Next"/next        mute="Volume"/mute
captions="Closed captions"/captions   settings="Playback settings"/settings     fullscreen="Fullscreen"/fullscreen
btn-search="Search"/search     btn-cart="Cart"/cart      btn-checkout="Checkout"/checkout/LOCKED
btn-save="Save"/save           btn-share="Share"/share   btn-download="Download"/download
btn-reply="Reply"/reply        btn-send="Send"/send/LOCKED         btn-menu="Menu"/menu
btn-settings="Settings"/settings    btn-more="More"/unknown   btn-close="Close"/close   btn-back="Back"/unknown
```

20 of 20 named and 18 of 20 given a role, both irreversible controls locked by code, confidence 0.95 to 0.99 throughout. The two `unknown`s are honest: the shared vocabulary wants "More options" rather than a bare "More", and `back` is suppressed because this artificial whole-page batch reads as a media cluster. A real client crops the player bar on its own, which is what the flow above already says to do. The seven icon-only controls carry no text anywhere in the image: an accessibility tree would have nothing to offer for any of them. This is the YouTube case from the product brief, with no site-specific rule anywhere in the codebase.

## The request that actually worked

Verbatim shape of the body that returned `200` on `POST https://api.openai.com/v1/responses` (`server/src/vision/prompts.ts`), with the image elided:

```json
{
  "model": "gpt-5.6-luna",
  "instructions": "You are the eyes of Shabang, an accessibility helper ...",
  "input": [{ "role": "user", "content": [
    { "type": "input_text", "text": "{\"image\":{\"width\":288,\"height\":96},\"boxes\":[{\"id\":\"b1\",\"x\":24,...}],\"context\":{\"app\":\"Video player\"}}" },
    { "type": "input_image", "image_url": "data:image/png;base64,...", "detail": "original" }
  ]}],
  "text": { "format": { "type": "json_schema", "name": "ghost_vision_labels", "strict": true, "schema": { ... } } },
  "reasoning": { "effort": "none" },
  "max_output_tokens": 380,
  "store": false
}
```

Confirmed against the real API, first try, nothing rejected:

- `gpt-5.6-luna` is a real model id (it is in `GET /v1/models` on this account) and accepts `reasoning: { effort: "none" }`: the replies came back with `output_tokens_details.reasoning_tokens: 0`, so nothing was billed for thinking and no headroom was wasted.
- `detail: "original"` on an `input_image` data URL is accepted, and the coordinates the model answers in are the image's own pixels.
- `text.format` with `type: "json_schema"`, `strict: true` and a fixed schema is accepted with `maxItems`, `minimum`, `maximum`, `["string","null"]` unions and `additionalProperties: false`, every property required. Nothing had to be removed from the schema.
- The raw HTTP reply really has no `output_text` field: the answer is the `output_text` PART of a `message` item in `output`. `usage` carries `input_tokens`, `output_tokens` and `output_tokens_details.reasoning_tokens`.
- `store: false` is accepted.
- The first call in a process took about 2.4 s and later ones about 2.0 s, consistent with the documented first-request-per-schema penalty being small here.

## Which model, and what is still unmeasured

`OPENAI_VISION_MODEL` (default `gpt-5.6-luna`) picks the model; `server/src/vision/prompts.ts` sends only what each model documents. The default is the cost-optimized tier and it labelled 20 controls, 7 of them icon-only, at 0.99 confidence and a tenth of a cent, in under 4 s. No cheaper or faster model was benchmarked against it: that comparison is still open, and the variable exists so it can be made without a code change.

## Verified vs mocked

| What | Status |
| --- | --- |
| Request shape: ONE `/responses` call, `input_image` data URL + `detail: "original"`, strict `json_schema`, `store: false`, `reasoning.effort: "none"`, `max_output_tokens` | **LIVE, verified 2026-09-19.** Accepted by the real API on the first attempt; nothing had to be changed. Also unit-tested against a mocked `fetch` (`server/test/vision.test.ts`). |
| Labelling icon-only controls (no text anywhere in the image) | **LIVE.** 3 of 3 and 20 of 20 named, 0.90 to 0.99 confidence, in one call each. |
| Affordance roles derived in code from the returned labels | **LIVE.** Every one of the 20 roles correct (`play`, `fullscreen`, `captions`, `cart`, `checkout`, `search`, ...). Mapping unit-tested on its own (`server/test/visionAffordance.test.ts`). |
| Locks re-derived in code from the FULL label; the model cannot unlock | **LIVE** for "Checkout" and "Send" in the 20-box run; the keyword and clipping edge cases stay unit-tested. |
| Per-page cache (key, hit, miss on moved geometry, id re-attachment, budget interaction, `pathPattern` validation) | **LIVE** for the hit path (`cached: true`, 0 ms, no billed call); everything else unit-tested (`server/test/visionCache.test.ts`, 16 tests). |
| `locate` pointing at a supplied box | **LIVE.** Returned the exact expected rectangle for "the cancel button" in 1,226 ms. |
| Reply validation (ids, roles, label cleaning, sensitivity, point-to-box mapping and clamping) | Unit-tested with mocked replies. The downscale mapping follows the documented algorithm but is still NOT confirmed against a real model that downscales (the default does not). |
| Caller rules, image validation, budget 429, timeout, 4xx/5xx retry policy, 503 without a key, `windowTitle` refused, logs free of values | Unit-tested (`server/test/vision.test.ts`, `server/test/visionImage.test.ts`). |
| Every other vision-capable model (`gpt-5.6-sol`, `gpt-6-astra`, `gpt-4.1-mini`, `gpt-4o`, ...) | **Not measured.** Only the per-model request shape is unit-tested; no latency, cost or accuracy comparison has been run. |
| Desktop crop and merge (steps 1, 2 and 4 of the flow above) | **Not built.** Shabang Desktop does not call `/v1/vision/*` yet. Cropping needs macOS Screen Recording permission in addition to Accessibility. |
| Extension use for icon-only buttons / canvas | **Not built.** The extension's next-action ranker does not call the route yet. |
| The affordance vocabulary itself | Owned and unit-tested in `shared/src/affordance/roles.ts` (another agent's work, landed during this run). `server/src/vision/affordance.ts` is a thin adapter over it and holds no vocabulary of its own. |

## Codex in the product (proposal, not implemented)

"Do it twice, Shabang does the rest" already learns a loop: two demonstrations become a `LoopProgram` (iterator, extract / fill / click steps, irreversible steps), previewed in a grid and run after ONE confirmation. That program lives inside Shabang. The second OpenAI feature would make it **durable**: Codex turns a learned loop into a small, tested script the user owns, can read, can put in cron, and can run without Shabang.

Why Codex and not a plain LLM call: writing the script is the easy part. Codex runs it against the local demo copy, reads the failure, fixes it and runs it again, inside a sandbox, until the test passes. That is the difference between "generated code" and "a script that works".

Sketch, using the documented TypeScript SDK (`@openai/codex-sdk`: `new Codex()`, `startThread({ workingDirectory, skipGitRepoCheck, sandboxMode, networkAccessEnabled, model })`, `thread.run(input, { outputSchema })`, `result.finalResponse`):

```ts
// server/src/codify/codex.ts (proposal)
import { Codex } from "@openai/codex-sdk";

const RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entry", "testCommand", "passed", "irreversibleSteps"],
  properties: {
    entry: { type: "string" },                                  // e.g. "invoice-loop.ts"
    testCommand: { type: "string" },                            // e.g. "npx playwright test invoice-loop.spec.ts"
    passed: { type: "boolean" },
    irreversibleSteps: { type: "array", items: { type: "integer" } },
  },
} as const;

export async function codifyLoop(program: LoopProgram, sampleRows: PreviewRow[], workspace: string) {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: workspace,       // a fresh temp dir: the LoopProgram JSON, 3 fictional rows, the local demo URL
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",    // may only write inside the workspace
    networkAccessEnabled: false,       // the test runs against the local demo copy; never a real site
  });
  const turn = await thread.run(
    "Write a Playwright script that performs program.json for every row of rows.json against http://localhost:5173, " +
      "plus a test that runs it on the 3 sample rows and checks every written cell. Every step listed in " +
      "program.irreversible must stop and require --confirm. Run the test until it passes.",
    { outputSchema: RESULT_SCHEMA },
  );
  return JSON.parse(turn.finalResponse);   // then Shabang re-runs testCommand ITSELF before trusting `passed`
}
```

The same job from the CLI, for CI or a cron: `codex exec --sandbox workspace-write --skip-git-repo-check --output-schema result.schema.json -o result.json "<same prompt>"` (documented `codex exec` flags).

Proposed route: `POST /v1/loop/codify { program, sampleRows } -> { runId }`, streaming progress, ending with `{ files, testCommand, passed }`. Guardrails, same as the loop executor: same caller rules as `/v1/loop/execute` (pinned extension or `X-Shabang-Token`); fictional sample rows only (no profile values, secrets masked by the existing `loop/secrets.ts`); Shabang re-runs the test itself before showing "Saved as a script"; the generated script keeps every locked step behind an explicit `--confirm`, and running it for real still goes through `/v1/loop/preview` and its single-use `confirmToken`.
