# OpenAI in Ghost: the eyes

Ghost predicts your next action and shows it as a ghost you accept with Tab. To predict, it turns the screen into text: the DOM in the browser extension, the macOS accessibility (AX) tree in Ghost Desktop. Jev (TypeSafe) then picks the next action from that text in one batched call.

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
   │  Ghost Desktop crops the window region around it (1x or 2x, PNG, <= 1.5 MB)
   ▼
POST /v1/vision/label  { image, boxes: [{ id: "<AX signature>", x, y, width, height }], context: { app, nearbyText } }
   │  ONE Responses API call: input_text (image size + boxes) + input_image, strict JSON schema output
   ▼
{ labels: [{ id, label: "Attach file", role: "button", irreversible: false, sensitive: false, confidence: 0.92 }] }
   │  code validated: ids, role enum, 40-char labels, locks and sensitivity re-derived from the FULL label
   ▼
Desktop writes the label into its captured element ("Attach file", source: vision), caches it per AX signature
   │  the element now has text like every other candidate
   ▼
Jev: ONE decision over the page's candidates (+ "none")  →  "Attach file" at 0.91
   ▼
Ghost cursor glides to the paperclip  →  Tab accepts (a locked target still needs Enter or a click)
```

1. **Capture.** `GHCapture` already walks the AX tree and computes a label from `AXTitleUIElement`, `AXTitle`, `AXDescription`, `AXPlaceholderValue`, `AXHelp` or the nearest static text (`docs/desktop.md`). An enabled, visible `AXButton` / `AXLink` / `AXCheckBox` whose label comes out empty is a vision candidate. Sensitive elements (`AXSecureTextField`, anything `isSensitive` flags) are never cropped.
2. **Crop.** Only the region around the unlabeled controls, never the whole screen. Box coordinates are relative to the crop, in the crop's pixels. Up to 40 boxes per call, so a whole icon toolbar is ONE call.
3. **Label.** `POST /v1/vision/label` (contract in `docs/server-api.md`, "Vision fallback"). The server validates the image by its magic bytes, forwards it once, and drops it.
4. **Merge.** The returned label is stored on the element exactly like an AX label, marked `source: vision`, and cached by the element's AX signature, so the same toolbar never costs a second call. Low-confidence labels (below the 0.7 gate) are not used.
5. **Decide.** Jev gets the page's candidates, now including "Attach file", in its usual ONE batched call. It picks; it never sees the image.
6. **Ghost.** The ghost cursor goes to the chosen element. Tab accepts. If the label or the model says the control is irreversible (send, submit, pay, delete, confirm, publish), the ghost shows a lock and needs Enter or a click, whatever the model said: code can lock, the model can never unlock.

When the AX tree has no element at all for what Ghost wants (a canvas app draws everything itself), `POST /v1/vision/locate` answers "where is *the attach resume button*?" with a box in image pixels. That is the computer-use-style fallback, reduced to pointing: the result is only ever a ghost suggestion, and nothing clicks.

The browser extension can use the same routes for icon-only buttons with no `aria-label`, `title` or text, and for `<canvas>` regions.

## What the server does (and does not) send to OpenAI

- **One call per request, one request per crop.** `POST /v1/responses` with `instructions`, one user message holding `input_text` (a small JSON state: image size, boxes renamed `b1..bN` with their centers, `context.app`, filtered `context.nearbyText`) and `input_image` (the base64 data URL), and `text.format: { type: "json_schema", strict: true }`.
- **Fixed schemas.** The label and locate schemas never change per request, because OpenAI documents extra latency the first time it sees a schema. Box ids and length limits are therefore enforced in code, not in the schema.
- **Pick-style output, checked by code.** The model returns short labels, a role from a closed enum, a lock flag and a confidence. Code drops entries with unknown or repeated ids, wrong types or roles outside the enum, trims and clips labels to 40 characters, and throws away a label that looks like personal data (an email address, 7 or more digits). `irreversible` is the model's flag OR the shared `isLockedAction` on the model's full label, read before clipping and scrubbing (and on the instruction for locate). `sensitive` is the shared `isSensitive` on that full label. Locate never returns a target whose label is sensitive, null, or scrubbed. All text is NFKC-folded and stripped of invisible characters (soft hyphens, zero-width characters, Unicode tags, variation selectors) before any rule reads it, and text with bidi overrides is refused or dropped, so hidden characters cannot hide a lock, a sensitive field or an instruction.
- **Who may call.** Vision spends the user's paid quota and carries screen pixels, so it uses the loop routes' caller rules: no web page (not even on localhost), only the pinned extension (`GHOST_EXTENSION_ID`) or a caller with `X-Ghost-Token`, or a local process without an `Origin` (Ghost Desktop).
- **Privacy.** Client ids never reach the model (an AX signature can contain a label). `context.windowTitle` is refused with 400: window titles name documents, threads and people. `nearbyText` lines that look sensitive are dropped before the prompt. `store: false` asks OpenAI not to keep the response for later retrieval (OpenAI's own abuse-monitoring retention is governed by its data controls, not by this flag). The server keeps no image, no cache and no label; its log line has sizes, counts and latency only.
- **Cost.** A per-process budget (`GHOST_VISION_BUDGET`, default 200 billed calls, retries included) returns 429 when spent. 8 s timeout. No retries on 4xx (429 included); one retry on a 5xx only if time remains and a budget unit can be taken, taken before the backoff so a concurrent request cannot spend it. Images over 1.5 MB, or over OpenAI's 30,000-patch limit, are refused before any call.

## Model choice and where it came from

Default `OPENAI_VISION_MODEL=gpt-5.6-luna`. Sources, read on 2026-09-19:

- Model catalog, `https://developers.openai.com/api/docs/models`: gpt-5.6-luna is the cost-optimized tier ($0.20 / $1.20 per 1M input / output tokens) with image input.
- Model page, `https://developers.openai.com/api/docs/models/gpt-5.6-luna`: text and image input, Responses API supported, Structured Outputs supported, `reasoning.effort` supports `none, low, medium (default), high, xhigh, max`.
- Vision guide, `https://developers.openai.com/api/docs/guides/images-vision`: `input_image` with `image_url` (a data URL) and `detail` (`low | high | auto | original`); the gpt-5.6 family supports `original`; use `original` for coordinate-sensitive and computer-use images; 32 px patches and a 30,000-patch rejection limit; PNG and JPEG are supported types.
- Responses API reference, `https://developers.openai.com/api/reference/resources/responses/methods/create`: `instructions`, `input`, `text.format` (`json_schema`, `name`, `schema`, `strict`), `reasoning.effort`, `max_output_tokens` (includes reasoning tokens), `store` (defaults to true). The raw HTTP response has no `output_text`: that is an SDK convenience, so the server reads the `output_text` parts of `message` items and treats a `refusal` part, `status: "incomplete"` or an `error` object as a failure.
- Structured Outputs guide, `https://developers.openai.com/api/docs/guides/structured-outputs`: strict mode needs every property required and `additionalProperties: false`; nullable fields use `["string", "null"]`; `minimum` / `maximum` and `maxItems` are supported; the first request with a new schema is slower.
- Computer use guide, `https://developers.openai.com/api/docs/guides/tools-computer-use`: screenshots are sent with `detail: "original"`; if an image is downscaled, remap coordinates back. Locate follows that advice: the default model keeps the image's own pixels; on a model whose detail level downscales the image, the server computes the size the model sees (the guide's sizing table and patch-budget algorithm), states that size and the boxes in that grid, and maps the returned point back before clamping it.

Per model, the server sends only what that model documents: `reasoning: { effort: "none" }` and `detail: "original"` for the gpt-5.6 family; `effort: "low"` and `original` for gpt-6-astra (its lowest effort); `original` without `reasoning` for gpt-5.5 / gpt-5.4; `detail: "high"` and no `reasoning` for anything else (gpt-4.1-mini, gpt-4o, ...). Sizing as the model sees it (vision guide table): gpt-5.6 / gpt-6 `original` keeps the size (over 30,000 patches is rejected, so the server refuses it first); gpt-5.5 / gpt-5.4 `original` fits 6000 px and 10,000 patches; gpt-5.2 / gpt-4.1-mini `high` fits 2048 px and 6,144 patches; gpt-4.1, gpt-4o and unknown models use the tile rules (fit 2048 x 2048, shortest side 768). A model that reasons gets 4,000 extra `max_output_tokens` so reasoning cannot cut the JSON short.

## Verified vs mocked

| What | Status |
| --- | --- |
| Request shape: ONE `/responses` call, `input_image` data URL + `detail`, strict `json_schema`, `store: false`, per-model `reasoning` | Unit-tested against a mocked `fetch` (`server/test/vision.test.ts`). Field names checked against the docs above. NOT yet sent to the real API: there is no `OPENAI_API_KEY` in this checkout. |
| Reply validation (ids, roles, label cleaning, lock and sensitive re-derivation from the full label, point to box mapping and clamping) | Unit-tested with mocked Responses API replies. The downscale mapping follows the documented algorithm but is not confirmed against a real non-default model. |
| Caller rules (web pages and unpinned extensions refused, token, no-Origin local callers) | Unit-tested through `createApp` and the route. |
| Image validation (magic bytes, PNG / JPEG header sizes, 1.5 MB, patch limit), budget 429, 8 s timeout, no 4xx retries, one 5xx retry, 503 without a key, `windowTitle` refused, logs free of values | Unit-tested (`server/test/vision.test.ts`, `server/test/visionImage.test.ts`). |
| Live call | `server/test/live/vision.live.test.ts` labels 3 boxes on a toolbar drawn in code (SEND, CANCEL and an icon-only trash can, `demoToolbar()` in `server/src/vision/testing.ts`, no binary fixture) and locates "the cancel button". Skipped without `OPENAI_API_KEY`; at most 2 real calls. **Not run yet.** Run with `pnpm test:live vision` once a key is in `.env`. |
| Desktop crop and merge (steps 1, 2, 4 above) | **Not built.** Ghost Desktop does not call `/v1/vision/*` yet. Cropping needs macOS Screen Recording permission in addition to Accessibility. |
| Extension use for icon-only buttons / canvas | **Not built.** |

## Codex in the product (proposal, not implemented)

"Do it twice, Ghost does the rest" already learns a loop: two demonstrations become a `LoopProgram` (iterator, extract / fill / click steps, irreversible steps), previewed in a grid and run after ONE confirmation. That program lives inside Ghost. The second OpenAI feature would make it **durable**: Codex turns a learned loop into a small, tested script the user owns, can read, can put in cron, and can run without Ghost.

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
  return JSON.parse(turn.finalResponse);   // then Ghost re-runs testCommand ITSELF before trusting `passed`
}
```

The same job from the CLI, for CI or a cron: `codex exec --sandbox workspace-write --skip-git-repo-check --output-schema result.schema.json -o result.json "<same prompt>"` (documented `codex exec` flags).

Proposed route: `POST /v1/loop/codify { program, sampleRows } -> { runId }`, streaming progress, ending with `{ files, testCommand, passed }`. Guardrails, same as the loop executor: same caller rules as `/v1/loop/execute` (pinned extension or `X-Ghost-Token`); fictional sample rows only (no profile values, secrets masked by the existing `loop/secrets.ts`); Ghost re-runs the test itself before showing "Saved as a script"; the generated script keeps every locked step behind an explicit `--confirm`, and running it for real still goes through `/v1/loop/preview` and its single-use `confirmToken`.
