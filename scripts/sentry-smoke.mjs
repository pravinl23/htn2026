#!/usr/bin/env node
/**
 * Real traffic against a running Ghost prediction server, so the Sentry dashboard has something true to show.
 *
 * This script is the "did it actually arrive" half of docs/observability.md. It drives one of every span shape the
 * server can produce -- a cold form prediction, the same one again from cache, a streamed ghost text, a vision label
 * on a PNG it draws itself, a deliberate 500, and a walk outcome -- then prints the client-side numbers so they can
 * be held against what the dashboard reports.
 *
 *   PORT=8795 <server running with the real .env>
 *   node scripts/sentry-smoke.mjs --base http://127.0.0.1:8795
 *
 * Rules it keeps, because the whole point is to prove the privacy claim rather than quietly break it:
 *   - It never reads .env and never prints a key, a DSN or an Authorization header. The SERVER loads .env itself.
 *   - Everything it sends is fictional (the "Alex Chen" demo profile from PLAN.md) and lives on example.test.
 *   - It never touches a real website and never submits a real form.
 *   - Node builtins only: no dependency, not even a PNG encoder.
 *
 * Budget: 7 real model calls by default (4 form decisions, 2 ghost-text drafts, 1 vision label). --calls <n> lowers
 * it; the script refuses to go above 15, because every call is the user's money.
 */
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const BASE = (flag("base", process.env.GHOST_SERVER_URL ?? "http://127.0.0.1:8795")).replace(/\/$/, "");
const MAX_CALLS = Math.min(15, Number(flag("calls", "15")));
const SKIP_VISION = args.includes("--no-vision");

let modelCalls = 0;
const results = [];
const budgetLeft = () => MAX_CALLS - modelCalls;

const ms = (n) => `${Math.round(n)}ms`;
const line = (s) => process.stdout.write(`${s}\n`);
const head = (s) => line(`\n── ${s} ${"─".repeat(Math.max(0, 62 - s.length))}`);

/** One request, timed on the client so the wall clock can be compared with the transaction duration in Sentry. */
async function call(step, method, path, { body, expect = 200, headers = {} } = {}) {
  const started = performance.now();
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response;
  let payload;
  let error;
  try {
    response = await fetch(`${BASE}${path}`, init);
    const type = response.headers.get("content-type") ?? "";
    payload = type.includes("application/json") ? await response.json() : await response.text();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const elapsed = performance.now() - started;
  const status = response?.status ?? 0;
  const ok = error === undefined && status === expect;
  results.push({ step, method, path, status, expected: expect, clientMs: Math.round(elapsed), ok, ...(error ? { error } : {}) });
  line(`${ok ? "ok  " : "FAIL"} ${method} ${path} -> ${error ?? status} in ${ms(elapsed)}${ok ? "" : ` (expected ${expect})`}`);
  return { status, payload, elapsed, ok, error };
}

// ---------------------------------------------------------------------------------------------- the sample form
// A 12-field job application, the shape Ghost was built for. Fictional company, fictional applicant, no real site.
// No password, card or government-ID field: rule 3 says Ghost never predicts one, so the smoke never sends one.
const FACT_KEYS = [
  "firstName", "lastName", "fullName", "email", "phone", "location", "city", "province", "country",
  "school", "degree", "major", "graduationDate", "github", "linkedin", "website",
  "workAuthorization", "requiresSponsorship", "referralSource",
];

function formRequest(variant) {
  const forms = {
    /** The plain one: most fields have a standard autocomplete token, so the fast path answers some of them in code. */
    application: {
      origin: "https://careers.example.test",
      formSignature: "form#apply-smoke-1",
      fields: [
        { signature: "input#given-name", label: "First name", kind: "text", name: "given_name", autocomplete: "given-name", required: true },
        { signature: "input#family-name", label: "Last name", kind: "text", name: "family_name", autocomplete: "family-name", required: true },
        { signature: "input#contact-email", label: "Email address", kind: "email", name: "email", autocomplete: "email", required: true },
        { signature: "input#contact-phone", label: "Phone", kind: "tel", name: "phone", autocomplete: "tel" },
        { signature: "input#where-you-live", label: "Where are you based?", kind: "text", name: "location", placeholder: "City, Province" },
        { signature: "input#school-name", label: "University", kind: "text", name: "school" },
        { signature: "input#program", label: "Program of study", kind: "text", name: "program" },
        { signature: "input#grad", label: "Expected graduation", kind: "month", name: "graduation" },
        { signature: "input#gh", label: "GitHub", kind: "url", name: "github", autocomplete: "url" },
        { signature: "input#li", label: "LinkedIn profile", kind: "url", name: "linkedin" },
        {
          signature: "select#heard", label: "How did you hear about us?", kind: "select", name: "source",
          options: [{ value: "friend", label: "A friend" }, { value: "career-fair", label: "Career fair" }, { value: "job-board", label: "Job board" }, { value: "other", label: "Other" }],
        },
        { signature: "input#consent", label: "I agree to the candidate privacy notice", kind: "checkbox", name: "consent", required: true },
      ],
      factKeys: FACT_KEYS,
    },
    /** The ambiguous one: labels a regex gets wrong on purpose, so the model has to do the work and the span is slow. */
    ambiguous: {
      origin: "https://apply.example.test",
      formSignature: "form#apply-smoke-2",
      fields: [
        { signature: "input#legal", label: "Legal name (as on your transcript)", kind: "text", name: "legal_name" },
        { signature: "input#preferred", label: "Preferred first name", kind: "text", name: "preferred" },
        { signature: "input#first-language", label: "First language", kind: "text", name: "first_language" },
        { signature: "input#reachable", label: "Best way to reach you", kind: "email", name: "reach" },
        { signature: "input#mobile", label: "Mobile", kind: "tel", name: "mobile" },
        { signature: "input#institution", label: "Institution", kind: "text", name: "institution" },
        { signature: "input#credential", label: "Credential", kind: "text", name: "credential" },
        { signature: "input#concentration", label: "Concentration", kind: "text", name: "concentration" },
        { signature: "input#finish", label: "When do you finish?", kind: "month", name: "finish" },
        { signature: "input#portfolio", label: "Somewhere we can see your work", kind: "url", name: "portfolio" },
        { signature: "radio#auth", label: "Are you legally entitled to work in Canada?", kind: "radio", name: "auth", options: [{ value: "y", label: "Yes" }, { value: "n", label: "No" }] },
        { signature: "radio#sponsor", label: "Will you now or in the future need sponsorship?", kind: "radio", name: "sponsor", options: [{ value: "y", label: "Yes" }, { value: "n", label: "No" }] },
      ],
      factKeys: FACT_KEYS,
    },
    /** A different site with the same shape: a second cold decision, so the latency numbers have more than one sample. */
    second: {
      origin: "https://jobs.example.test",
      formSignature: "form#apply-smoke-3",
      fields: [
        { signature: "input#nm", label: "Your name", kind: "text", name: "name" },
        { signature: "input#em", label: "Contact email", kind: "email", name: "email" },
        { signature: "input#ph", label: "Contact number", kind: "tel", name: "tel" },
        { signature: "input#cty", label: "City", kind: "text", name: "city" },
        { signature: "input#prov", label: "Province", kind: "text", name: "province" },
        { signature: "input#ctry", label: "Country", kind: "text", name: "country" },
        { signature: "input#uni", label: "School", kind: "text", name: "school" },
        { signature: "input#deg", label: "Degree", kind: "text", name: "degree" },
        { signature: "input#maj", label: "Major", kind: "text", name: "major" },
        { signature: "input#grd", label: "Graduation", kind: "month", name: "grad" },
        { signature: "input#site", label: "Personal site", kind: "url", name: "site" },
        { signature: "input#ref", label: "Referred by", kind: "text", name: "ref" },
      ],
      factKeys: FACT_KEYS,
    },
  };
  return forms[variant];
}

/** The fictional demo profile. Values only ever go to the ghost-text route, which needs facts to write a draft. */
const DEMO_FACTS = {
  fullName: "Alex Chen",
  school: "University of Waterloo",
  degree: "BASc Computer Engineering",
  major: "Computer Engineering",
  graduationDate: "2027-04",
};

// ---------------------------------------------------------------------------------------------- a PNG, from scratch
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A small toolbar: three flat rectangles on a light background, which is exactly the kind of unlabelled control
 * strip the vision fallback exists for. Drawn here so the smoke needs no fixture file and no image library.
 */
function toolbarPng(width = 240, height = 64) {
  const buttons = [
    { x: 12, y: 18, w: 60, h: 28, rgb: [0x2f, 0x6f, 0xed] },
    { x: 86, y: 18, w: 60, h: 28, rgb: [0x6b, 0x72, 0x80] },
    { x: 160, y: 18, w: 60, h: 28, rgb: [0xd9, 0x3b, 0x3b] },
  ];
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const hit = buttons.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
      const [r, g, b] = hit ? hit.rgb : [0xf3, 0xf4, 0xf6];
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return { dataUrl: `data:image/png;base64,${png.toString("base64")}`, boxes: buttons, width, height, bytes: png.length };
}

// ---------------------------------------------------------------------------------------------- the streamed route
/** Reads the SSE body to the last token, so the transaction in Sentry covers what the user actually waited for. */
async function ghostText(step, fieldLabel, company, role) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(`${BASE}/v1/shabang-text`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        fieldLabel,
        fieldSignature: `textarea#${step}`,
        maxChars: 600,
        pageContext: { company, role, description: "A fictional posting on example.test, used only to exercise the draft path." },
        facts: DEMO_FACTS,
        pastAnswers: [],
      }),
    });
  } catch (err) {
    results.push({ step, method: "POST", path: "/v1/shabang-text", status: 0, expected: 200, clientMs: Math.round(performance.now() - started), ok: false, error: String(err) });
    line(`FAIL POST /v1/shabang-text -> ${err}`);
    return undefined;
  }
  let firstDeltaMs;
  let done;
  let chars = 0;
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (reader) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    let at = buffer.indexOf("\n\n");
    while (at >= 0) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data:"));
      if (data) {
        const event = JSON.parse(data.slice(5).trim());
        if (event.delta !== undefined) {
          firstDeltaMs ??= Math.round(performance.now() - started);
          chars += String(event.delta).length;
        }
        if (event.done) done = event;
      }
      at = buffer.indexOf("\n\n");
    }
  }
  const clientMs = Math.round(performance.now() - started);
  // The draft itself is never printed: it is model-written prose about a fictional person, and it has no place in a log.
  const summary = { step, method: "POST", path: "/v1/shabang-text", status: response.status, expected: 200, clientMs, ok: response.status === 200, provider: done?.provider, serverLatencyMs: done?.latencyMs, serverFirstTokenMs: done?.firstTokenMs, clientFirstDeltaMs: firstDeltaMs, chars };
  results.push(summary);
  line(`ok   POST /v1/shabang-text -> 200 in ${ms(clientMs)} (provider=${done?.provider} firstToken=${done?.firstTokenMs ?? "?"}ms server=${done?.latencyMs ?? "?"}ms chars=${chars})`);
  return summary;
}

// ---------------------------------------------------------------------------------------------- the run
async function main() {
  line(`ghost sentry smoke -> ${BASE}`);
  line(`started ${new Date().toISOString()} (budget: ${MAX_CALLS} real model calls)`);

  head("1. health");
  const health = await call("health", "GET", "/v1/health");
  if (!health.ok) {
    line(`\nthe server is not answering on ${BASE}. Start it first, then run this again.`);
    process.exitCode = 1;
    return;
  }
  const h = health.payload;
  line(`     provider=${h.provider} calibrated=${h.calibrated} model=${h.model ?? "-"} text=${h.textProvider}/${h.textModel ?? "-"} version=${h.version}`);
  const vision = await call("vision-availability", "GET", "/v1/vision");
  line(`     vision available=${vision.payload?.available} model=${vision.payload?.model ?? "-"} budget=${JSON.stringify(vision.payload?.budget ?? {})}`);

  head("2. form prediction: cold, then the same form again");
  const cold = await call("form-cold", "POST", "/v1/predict/form", { body: formRequest("application") });
  modelCalls += cold.payload?.cache === "miss" && cold.payload?.fastPath !== true ? 1 : 0;
  line(`     provider=${cold.payload?.provider} cache=${cold.payload?.cache} fastPath=${cold.payload?.fastPath ?? false} latencyMs=${cold.payload?.latencyMs} assignments=${cold.payload?.assignments?.length}`);
  const warm = await call("form-cached", "POST", "/v1/predict/form", { body: formRequest("application") });
  line(`     provider=${warm.payload?.provider} cache=${warm.payload?.cache} latencyMs=${warm.payload?.latencyMs}  <- the contrast the trace list is for`);

  head("3. form prediction: labels a regex gets wrong (the model has to work)");
  if (budgetLeft() > 0) {
    const hard = await call("form-ambiguous", "POST", "/v1/predict/form", { body: formRequest("ambiguous") });
    modelCalls += hard.payload?.cache === "miss" && hard.payload?.fastPath !== true ? 1 : 0;
    line(`     provider=${hard.payload?.provider} cache=${hard.payload?.cache} latencyMs=${hard.payload?.latencyMs} fallbackFrom=${hard.payload?.fallbackFrom ?? "-"}`);
    const third = await call("form-third-site", "POST", "/v1/predict/form", { body: formRequest("second") });
    modelCalls += third.payload?.cache === "miss" && third.payload?.fastPath !== true ? 1 : 0;
    line(`     provider=${third.payload?.provider} cache=${third.payload?.cache} latencyMs=${third.payload?.latencyMs}`);
  } else line("     skipped: model-call budget spent");

  head("4. ghost text: two streamed drafts");
  if (budgetLeft() >= 2) {
    await ghostText("text-why", "Why do you want to work here?", "Northwind Robotics", "Software Engineering Intern");
    modelCalls += 1;
    await ghostText("text-project", "Tell us about a project you are proud of", "Northwind Robotics", "Software Engineering Intern");
    modelCalls += 1;
  } else line("     skipped: model-call budget spent");

  head("5. vision label on a PNG this script drew");
  if (SKIP_VISION) line("     skipped: --no-vision");
  else if (!vision.payload?.available) line(`     skipped: the server says vision is unavailable (${vision.payload?.reason ?? "no OPENAI_API_KEY"})`);
  else if (budgetLeft() < 1) line("     skipped: model-call budget spent");
  else {
    const image = toolbarPng();
    line(`     image: ${image.width}x${image.height} png, ${image.bytes} bytes, ${image.boxes.length} boxes`);
    const label = await call("vision-label", "POST", "/v1/vision/label", {
      body: {
        image: image.dataUrl,
        boxes: image.boxes.map((b, i) => ({ id: `btn-${i + 1}`, x: b.x, y: b.y, width: b.w, height: b.h })),
        context: { app: "Ghost smoke toolbar" },
        page: { pathPattern: "/smoke/toolbar" },
      },
    });
    if (label.status === 200) modelCalls += label.payload?.cached ? 0 : 1;
    line(`     labels=${label.payload?.labels?.length ?? 0} cached=${label.payload?.cached} latencyMs=${label.payload?.latencyMs ?? "-"}`);
  }

  head("6. a deliberate 500");
  // GET /v1/workflows/:userId validates its parameter but has no try/catch, so an over-long id becomes an unhandled
  // BadRequest, which Hono answers with 500 and the middleware turns into a captured exception. No model call, no
  // state change, nothing written: the request is refused before the handler reaches the store.
  const boom = await call("deliberate-500", "GET", `/v1/workflows/${"g".repeat(200)}`, { expect: 500 });
  line(`     status=${boom.status} body=${typeof boom.payload === "string" ? boom.payload.slice(0, 60) : JSON.stringify(boom.payload).slice(0, 60)}`);

  head("7. one walk outcome");
  // The dedicated walk route does not exist in this tree yet (docs/observability.md, "Walk telemetry"), so this both
  // proves that and posts the outcome through the route that DOES feed ghost.proposed / accepted / corrected today.
  const walkProbe = await call("walk-route-probe", "POST", "/v1/telemetry/walk", { expect: 404, body: { events: [] } });
  line(`     POST /v1/telemetry/walk -> ${walkProbe.status} (404 = the dedicated walk route is still unwritten)`);
  // One Tab-Tab-Tab pass over the 12-field form: 12 ghosts drawn, 10 taken, 2 corrected. Counts and confidences only.
  await call("walk-outcome", "POST", "/v1/metrics/event", {
    body: {
      counters: { ghostsShown: 12, ghostsAccepted: 10, keystrokesSaved: 214, clicksSaved: 11 },
      calibration: [
        { confidence: 0.97, accepted: true }, { confidence: 0.95, accepted: true }, { confidence: 0.93, accepted: true },
        { confidence: 0.91, accepted: true }, { confidence: 0.88, accepted: true }, { confidence: 0.86, accepted: true },
        { confidence: 0.82, accepted: true }, { confidence: 0.79, accepted: true }, { confidence: 0.74, accepted: true },
        { confidence: 0.71, accepted: true }, { confidence: 0.64, accepted: false }, { confidence: 0.41, accepted: false },
      ],
    },
  });

  head("8. what the server itself measured");
  const metrics = await call("metrics", "GET", "/v1/metrics");
  const snapshot = metrics.payload ?? {};
  for (const [route, series] of Object.entries(snapshot.routes ?? snapshot ?? {})) {
    if (typeof series !== "object" || series === null) continue;
    line(`     ${route}: ${JSON.stringify(series)}`);
  }

  head("summary");
  const failures = results.filter((r) => !r.ok);
  line(`requests: ${results.length}, unexpected: ${failures.length}, real model calls: ${modelCalls} of ${MAX_CALLS}`);
  for (const r of results) line(`  ${r.ok ? " " : "!"} ${String(r.clientMs).padStart(6)}ms  ${r.method} ${r.path} -> ${r.status}`);
  line(`finished ${new Date().toISOString()}`);
  line("\nJSON\n" + JSON.stringify({ base: BASE, modelCalls, results, health: health.payload, metrics: snapshot }, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

await main();
