#!/usr/bin/env node
// Benchmarks every configured provider on the 12-field sample form and on streamed ghost text.
//
//   node scripts/bench-providers.mjs                 all configured providers, N=8 decisions + 4 drafts each
//   node scripts/bench-providers.mjs --dry-run       print the planned call count and stop
//   node scripts/bench-providers.mjs --providers baseten,heuristic --n 4 --drafts 2
//   node scripts/bench-providers.mjs --ambiguous --drafts 0 --n 4
//                                                    a 10-field form with look-alike labels (someone else's phone, an employer's
//                                                    website): providers DO get answers wrong here, so confidence on correct vs
//                                                    incorrect answers means something. Writes bench-providers-ambiguous.{md,svg}
//   node scripts/bench-providers.mjs --models        list the live Baseten catalog with the thinking switch we use (no inference)
//
// Works with no keys (heuristic + template only). Loads .env into the process WITHOUT printing it; this script
// never logs a key, a header or a request body. Hard cost guard: more than 120 real calls per run is refused.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const SERVER = join(ROOT, "server");
const MAX_REAL_CALLS = 120;

// Stage 1: load .env, then re-run under tsx from server/ so the server's TypeScript provider factories can be imported.
if (!process.env.GHOST_BENCH_CHILD) {
  const envFile = join(ROOT, ".env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(\S+)/);
      if (m && !m[2].startsWith("#") && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
  const child = spawnSync(process.execPath, ["--import", "tsx", SELF, ...process.argv.slice(2)], {
    cwd: SERVER,
    stdio: "inherit",
    // The bench measures cold and warm calls itself, so the server's start-up warm-up request stays off.
    env: { ...process.env, GHOST_BENCH_CHILD: "1", SHABANG_WARMUP: "0", SHABANG_PROVIDER: "", SHABANG_DECISION_PROVIDER: "", SHABANG_TEXT_PROVIDER: "" },
  });
  process.exit(child.status ?? 1);
}

// ---------------------------------------------------------------------------------------------------------------
// Stage 2 (under tsx, cwd = server/).
// ---------------------------------------------------------------------------------------------------------------

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}
const has = (name) => process.argv.includes(`--${name}`);
const wholeNumber = (raw, fallback, max) => (Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Math.min(max, Number(raw)) : fallback);

const N = wholeNumber(flag("n", "8"), 8, 20);
const DRAFTS = wholeNumber(flag("drafts", "4"), 4, 8);
const RPM = wholeNumber(flag("rpm", "15"), 15, 1200) || 15; // Baseten request limit measured on this account: 15 per minute
const ONLY = flag("providers", "").split(",").map((s) => s.trim()).filter(Boolean);
const OUT_DIR = resolve(ROOT, flag("out", "docs/media"));
const GATE = 0.7;

// Status codes of model calls only (never URLs with queries, headers or bodies), so a fallback can be explained in the report.
const httpStatuses = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const res = await realFetch(...args);
  httpStatuses.push(res.status);
  return res;
};

const src = (path) => import(join(SERVER, "src", path));
const { loadConfig } = await src("config.ts");
const { createDecisionProvider } = await src("providers/index.ts");
const { thinkingControl } = await src("providers/baseten.ts");
const { buildFormDecision, wordingFor } = await src("providers/formQuestions.ts");
const { SAMPLE_FACT_KEYS, sampleFormFields } = await src("providers/sampleForm.ts");
const { createApp } = await src("app.ts");

const SAMPLE_EXPECTED = ["firstName", "lastName", "email", "phone", "linkedin", "github", "website", "school", "degree", "graduationDate", "referralSource", "needs_text"];
// Look-alike labels with a clear ground truth. Fictional, no personal data. A wrong ghost here would type the applicant's own fact into someone else's field.
const AMBIGUOUS = [
  ["Emergency contact phone", "tel", "none"],
  ["Referrer's email address", "email", "none"],
  ["Current employer's website", "url", "none"],
  ["First language", "text", "none"],
  ["Mobile number", "tel", "phone"],
  ["Personal site or portfolio", "url", "website"],
  ["University", "text", "school"],
  ["Anything else we should know?", "textarea", "needs_text"],
  ["Manager's last name", "text", "none"],
  ["Where did you find this posting?", "text", "referralSource"],
];
const FORM = has("ambiguous")
  ? {
      suffix: "-ambiguous",
      title: `${AMBIGUOUS.length}-field ambiguous form`,
      describe: `a ${AMBIGUOUS.length}-field form of look-alike labels defined in \`scripts/bench-providers.mjs\` (an emergency contact's phone, a referrer's email, an employer's website, "First language", a manager's last name: all must map to \`none\`)`,
      fields: AMBIGUOUS.map(([label, kind], i) => ({ signature: `ambiguous-${i}`, label, kind, rect: { x: 0, y: 40 * i, width: 320, height: 32 } })),
      expected: AMBIGUOUS.map(([, , want]) => want),
    }
  : { suffix: "", title: "12-field form", describe: "the 12-field sample job application (`server/src/providers/sampleForm.ts`)", fields: sampleFormFields(), expected: SAMPLE_EXPECTED };
const EXPECTED = FORM.expected;
const DRAFT_LABELS = [
  "Why do you want to work at Northwind Robotics?",
  "Tell us about a project you are proud of.",
  "What would you like to learn during this internship?",
  "Describe a time you worked through a hard bug.",
];

/** Forces one provider at a time, so precedence never hides a configured provider from the bench. */
function configFor(decision, text, extra = {}) {
  return loadConfig({ ...process.env, SHABANG_PROVIDER: undefined, SHABANG_DECISION_PROVIDER: decision, SHABANG_TEXT_PROVIDER: text, SHABANG_WARMUP: "0", ...extra });
}

function targets() {
  const list = [];
  const baseten = configFor("baseten", "baseten");
  if (baseten.baseten) {
    const b = baseten.baseten;
    list.push({ id: "baseten", config: baseten, decisionModel: b.decisionModel, textModel: b.textModel, callsPerDecision: b.samples + b.hedge, callsPerDraft: 1, paceRpm: RPM, note: `K=${b.samples} samples + H=${b.hedge} hedge per decision, thinking ${thinkingControl(b.decisionModel).mode}` });
  }
  const typesafe = configFor("typesafe", "template");
  if (typesafe.typesafeApiKey) list.push({ id: "typesafe", config: typesafe, decisionModel: "jev-latest", callsPerDecision: 1, callsPerDraft: 0, note: "Jev direct, calibrated" });
  const gateway = configFor("jev-gateway", "template");
  if (gateway.aiGatewayApiKey) list.push({ id: "jev-gateway", config: gateway, decisionModel: "typesafe-ai/jev", callsPerDecision: 1, callsPerDraft: 0, note: "Jev through Vercel AI Gateway, calibrated" });
  const llm = configFor("llm", undefined, { BASETEN_API_KEY: "" });
  if (llm.llm) list.push({ id: `llm (${llm.llm.name})`, config: llm, decisionModel: llm.llm.model, textModel: llm.llm.model, callsPerDecision: 1, callsPerDraft: 1, note: "one JSON-mode call, self-reported confidence" });
  list.push({ id: "heuristic", config: configFor("heuristic", "template"), callsPerDecision: 0, callsPerDraft: 0, note: "no model: label keywords + autocomplete tokens; template drafts" });
  return ONLY.length === 0 ? list : list.filter((t) => ONLY.some((name) => t.id.startsWith(name)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** "reason x3, other x1" */
const tally = (items) => [...items.reduce((m, item) => m.set(item, (m.get(item) ?? 0) + 1), new Map())].map(([item, n]) => `${item} x${n}`).join(", ");
const round = (n) => Math.round(n);
const mean = (xs) => (xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length);
/** Nearest-rank percentile. With N=8, p95 is the slowest call. */
function percentile(xs, p) {
  if (xs.length === 0) return undefined;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

async function benchDecisions(target) {
  const provider = createDecisionProvider(target.config, { warmUp: false, log: () => undefined });
  // Mirror production: formPredict picks the wording from the provider, so the benchmark must too.
  const { state, questions } = buildFormDecision("http://localhost:5173", FORM.fields, SAMPLE_FACT_KEYS, wordingFor(provider.name));
  const gapMs = target.paceRpm ? Math.ceil((target.callsPerDecision / target.paceRpm) * 60_000) : 0;
  const runs = [];
  for (let i = 0; i < N; i += 1) {
    if (i > 0 && gapMs > 0) await sleep(gapMs);
    const started = performance.now();
    try {
      const result = await provider.decide(state, questions);
      const ms = round(performance.now() - started);
      const answers = EXPECTED.map((want, q) => {
        const a = result.answers[`f${q}`];
        return a?.type === "choice" ? { correct: a.choice === want, confidence: a.confidence } : { correct: false, confidence: undefined };
      });
      runs.push({ ok: true, ms, answers, sampling: result.sampling });
      const s = result.sampling;
      console.log(`  decision ${i + 1}/${N} ${ms}ms correct=${answers.filter((a) => a.correct).length}/${EXPECTED.length}${s ? ` received=${s.samplesReceived}/${s.samplesExpected} launched=${s.launched} abandoned=${s.abandoned} failed=${s.failed} 429=${s.rateLimited}` : ""}`);
    } catch (err) {
      const ms = round(performance.now() - started);
      // Provider errors carry a provider name, a status and a short reason at most (see providers/errors.ts).
      runs.push({ ok: false, ms, error: String(err?.message ?? err?.name ?? "error").slice(0, 80) });
      console.log(`  decision ${i + 1}/${N} FAILED after ${ms}ms (${runs.at(-1).error}); the server would fall back to the heuristic`);
    }
  }
  const ok = runs.filter((r) => r.ok);
  const all = ok.flatMap((r) => r.answers);
  const confident = all.filter((a) => typeof a.confidence === "number");
  const shown = confident.filter((a) => a.confidence >= GATE);
  const arrivals = ok.flatMap((r) => (r.sampling?.arrivalsMs?.length ? [r.sampling.arrivalsMs] : []));
  return {
    calls: N,
    failures: runs.length - ok.length,
    failureReasons: tally(runs.filter((r) => !r.ok).map((r) => r.error)),
    firstSampleP50: percentile(arrivals.map((a) => a[0]), 0.5),
    lastSampleP50: percentile(arrivals.map((a) => a[a.length - 1]), 0.5),
    lastSampleMax: arrivals.length ? Math.max(...arrivals.map((a) => a[a.length - 1])) : undefined,
    sampled: arrivals.length,
    p50: percentile(ok.map((r) => r.ms), 0.5),
    p95: percentile(ok.map((r) => r.ms), 0.95),
    first: ok[0]?.ms,
    accuracy: all.length ? all.filter((a) => a.correct).length / all.length : undefined,
    confCorrect: mean(confident.filter((a) => a.correct).map((a) => a.confidence)),
    confIncorrect: mean(confident.filter((a) => !a.correct).map((a) => a.confidence)),
    incorrect: all.filter((a) => !a.correct).length,
    shownRate: confident.length ? shown.length / confident.length : undefined,
    wrongShown: shown.filter((a) => !a.correct).length,
    distinctConfidences: new Set(confident.map((a) => a.confidence.toFixed(2))).size,
    partial: ok.filter((r) => r.sampling?.partial).length,
    abandoned: ok.reduce((n, r) => n + (r.sampling?.abandoned ?? 0), 0),
    rateLimited: ok.reduce((n, r) => n + (r.sampling?.rateLimited ?? 0), 0),
  };
}

async function benchDrafts(target) {
  if (DRAFTS === 0) return undefined;
  // The real app, so a draft takes the same path as one from the extension. Warm-up is off in every bench config.
  const app = createApp(target.config);
  const gapMs = target.paceRpm && target.callsPerDraft ? Math.ceil(60_000 / target.paceRpm) : 0;
  const runs = [];
  for (let i = 0; i < DRAFTS; i += 1) {
    // The first draft follows a burst of decision requests, so it waits for a whole decision's worth of budget.
    if (gapMs > 0) await sleep(i === 0 ? gapMs * target.callsPerDecision : gapMs);
    const seen = httpStatuses.length;
    const res = await app.request("/v1/shabang-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fieldLabel: DRAFT_LABELS[i % DRAFT_LABELS.length],
        maxChars: 360,
        pageContext: { company: "Northwind Robotics", role: "Software Engineering Intern", description: "Build the software that coordinates fleets of warehouse robots." },
        facts: { school: "University of Waterloo", major: "Computer Science", graduationDate: "2028-04" },
        pastAnswers: [],
      }),
    });
    const events = (await res.text()).split("\n\n").filter(Boolean).map((block) => JSON.parse(block.slice(6)));
    const done = events.at(-1) ?? {};
    const ok = done.done === true && !done.fallbackFrom;
    const chars = String(done.text ?? "").length;
    const statuses = httpStatuses.slice(seen);
    const reason = ok ? undefined : statuses.some((code) => code >= 400) ? `HTTP ${statuses.find((code) => code >= 400)}` : statuses.length === 0 ? "no response" : "draft rejected by the server's checks";
    runs.push({ ok, reason, ttft: done.firstTokenMs, total: done.latencyMs, chars, leaked: /<\/?think>/i.test(JSON.stringify(events)) });
    console.log(`  draft ${i + 1}/${DRAFTS} ${ok ? "ok" : `FELL BACK from ${done.fallbackFrom} (${reason})`} ttft=${done.firstTokenMs}ms total=${done.latencyMs}ms chars=${chars}`);
  }
  const ok = runs.filter((r) => r.ok);
  return {
    calls: DRAFTS,
    failures: runs.length - ok.length,
    failureReasons: tally(runs.filter((r) => !r.ok).map((r) => r.reason)),
    ttftP50: percentile(ok.map((r) => r.ttft), 0.5),
    totalP50: percentile(ok.map((r) => r.total), 0.5),
    ttftMax: ok.length ? Math.max(...ok.map((r) => r.ttft)) : undefined,
    // Streaming speed only means something when there was a stream: template drafts are instant.
    charsPerSec: percentile(ok.filter((r) => r.total >= 50).map((r) => r.chars / (r.total / 1000)), 0.5),
    leaked: runs.filter((r) => r.leaked).length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------------------------------------------

const ms = (v) => (v === undefined ? "n/a" : `${round(v)} ms`);
const pct = (v) => (v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
const num = (v, digits = 2) => (v === undefined ? "n/a" : v.toFixed(digits));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function markdown(results, meta) {
  const lines = [
    "# Provider benchmark",
    "",
    `Generated by \`node scripts/bench-providers.mjs\` on ${meta.date} (Node ${process.version}, ${process.platform}). Every number below was measured in that run; nothing is estimated.`,
    "",
    `Task: ${FORM.describe}, ${N} decisions per provider through the server's provider factories${DRAFTS ? `, and ${DRAFTS} streamed ghost-text drafts (at most 360 characters) per text provider through \`POST /v1/shabang-text\`` : ""}. Decision latency is wall clock around \`provider.decide()\`, so for Baseten it is the time until the K-th valid sample of the hedged vote, inside the production deadline of 2.3 s. Percentiles are nearest-rank, so with N=${N} the p95 is the slowest successful call.`,
    "",
    `![Decision and draft latency per provider](bench-providers${FORM.suffix}.svg)`,
    "",
    "## Decisions",
    "",
    "| provider | model | calls | failed | p50 | p95 | first call | accuracy | mean conf. correct | mean conf. incorrect | distinct conf. values |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map((r) => `| ${r.id} | ${r.decisionModel ?? "none"} | ${r.decisions.calls} | ${r.decisions.failures} | ${ms(r.decisions.p50)} | ${ms(r.decisions.p95)} | ${ms(r.decisions.first)} | ${pct(r.decisions.accuracy)} | ${num(r.decisions.confCorrect)} | ${r.decisions.incorrect === 0 ? "no incorrect answers" : num(r.decisions.confIncorrect)} | ${r.decisions.distinctConfidences} |`),
    "",
    `Confidence gating at the default threshold of ${GATE}:`,
    "",
    "| provider | answers shown as ghosts | wrong answers among the shown |",
    "| --- | ---: | ---: |",
    ...results.map((r) => `| ${r.id} | ${pct(r.decisions.shownRate)} | ${r.decisions.wrongShown} |`),
    "",
    `A failed decision is one that threw or timed out; in the server that form is answered by the heuristic (\`fallbackFrom\`). Accuracy counts the ${EXPECTED.length} expected fact keys over successful decisions only.`,
    "",
    ...hedgeSection(results),
    ...draftSection(results),
    "## Notes",
    "",
    ...results.map((r) => `- **${r.id}**: ${r.note}.${r.decisions.partial ? ` ${r.decisions.partial} of the successful decisions were partial votes (deadline or rate budget), which lowers their confidence.` : ""}${r.decisions.abandoned ? ` ${r.decisions.abandoned} straggler requests were aborted by the hedge.` : ""}${r.decisions.rateLimited ? ` ${r.decisions.rateLimited} requests were answered 429.` : ""}${r.decisions.failureReasons ? ` Failed decisions: ${r.decisions.failureReasons}.` : ""}${r.drafts?.failureReasons ? ` Drafts that fell back: ${r.drafts.failureReasons}.` : ""}`),
    `- Real calls in this run: ${meta.realCalls} (guard: ${MAX_REAL_CALLS}). Baseten calls were paced for a limit of ${RPM} requests per minute.`,
    "- The heuristic answers in code, so its latency is the cost of the provider interface, not of a model.",
    "",
  ];
  return lines.join("\n");
}

/** Left out entirely when the run drafted nothing (--drafts 0). */
function draftSection(results) {
  const drafted = results.filter((r) => r.drafts);
  if (drafted.length === 0) return [];
  return [
    "## Streamed drafts",
    "",
    "| text provider | model | drafts | fell back | TTFT p50 | TTFT slowest | total p50 | chars/s p50 | drafts with leaked reasoning |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...drafted.map((r) => `| ${r.textId} | ${r.textModel ?? "none"} | ${r.drafts.calls} | ${r.drafts.failures} | ${ms(r.drafts.ttftP50)} | ${ms(r.drafts.ttftMax)} | ${ms(r.drafts.totalP50)} | ${num(r.drafts.charsPerSec, 0)} | ${r.drafts.leaked} |`),
    "",
  ];
}

/** Only providers that vote over parallel samples report arrivals. */
function hedgeSection(results) {
  const sampled = results.filter((r) => r.decisions.sampled > 0);
  if (sampled.length === 0) return [];
  return [
    "## Hedged sampling (time from the start of a decision to a valid sample)",
    "",
    "| provider | decisions | first sample p50 | K-th sample p50 | K-th sample, slowest | stragglers aborted | partial votes | requests answered 429 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...sampled.map((r) => `| ${r.id} | ${r.decisions.sampled} | ${ms(r.decisions.firstSampleP50)} | ${ms(r.decisions.lastSampleP50)} | ${ms(r.decisions.lastSampleMax)} | ${r.decisions.abandoned} | ${r.decisions.partial} | ${r.decisions.rateLimited} |`),
    "",
    "The first sample is what a single unhedged request would have cost in the best case; the K-th sample is what the vote costs. The difference is the price of a confidence signal on an API that returns no logprobs.",
    "",
  ];
}

/** Horizontal bars. Bar = p50, tick = the slower companion number (p95, or total for drafts). One axis per panel. */
function svgChart(results, meta) {
  const panels = [
    { title: `Decision latency, ${FORM.title}`, sub: "bar: p50 · tick: p95 (slowest of the run)", rows: results.map((r) => ({ label: r.id, value: r.decisions.p50, mark: r.decisions.p95, markName: "p95" })) },
    { title: "Streamed draft, time to first token", sub: "bar: TTFT p50 · tick: total p50", rows: results.filter((r) => r.drafts).map((r) => ({ label: r.textId, value: r.drafts.ttftP50, mark: r.drafts.totalP50, markName: "total" })) },
  ].map((p) => ({ ...p, rows: p.rows.filter((row) => row.value !== undefined) })).filter((p) => p.rows.length > 0);

  const W = 760;
  const LEFT = 150;
  const RIGHT = 150;
  const ROW = 34;
  const BAR = 14;
  const plotW = W - LEFT - RIGHT;
  let y = 56;
  const parts = [];
  for (const panel of panels) {
    const max = Math.max(1, ...panel.rows.flatMap((r) => [r.value, r.mark ?? 0]));
    // Round tick steps, at most 6 intervals.
    const step = [50, 100, 250, 500, 1000, 2500, 5000, 10000].find((candidate) => max / candidate <= 6) ?? 20000;
    const niceMax = Math.ceil(max / step) * step;
    const x = (v) => LEFT + (v / niceMax) * plotW;
    parts.push(`<text class="h" x="${LEFT}" y="${y}">${esc(panel.title)}</text><text class="s" x="${LEFT}" y="${y + 17}">${esc(panel.sub)}</text>`);
    y += 34;
    const top = y;
    const bottom = y + panel.rows.length * ROW;
    for (let value = 0; value <= niceMax; value += step) {
      const gx = x(value);
      parts.push(`<line class="grid" x1="${gx}" y1="${top}" x2="${gx}" y2="${bottom}"/><text class="tick" x="${gx}" y="${bottom + 15}" text-anchor="middle">${value}${value === niceMax ? " ms" : ""}</text>`);
    }
    for (const row of panel.rows) {
      const cy = y + ROW / 2;
      const w = Math.max(2, x(row.value) - LEFT);
      const r = Math.min(4, w / 2);
      // Square at the baseline, 4px rounded at the data end.
      const bar = `M${LEFT},${cy - BAR / 2}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${BAR - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`;
      const tip = `${row.label}: ${round(row.value)} ms${row.mark === undefined ? "" : `, ${row.markName} ${round(row.mark)} ms`}`;
      parts.push(`<g><title>${esc(tip)}</title><rect x="${LEFT}" y="${y}" width="${plotW + RIGHT - 10}" height="${ROW}" fill="transparent"/><text class="l" x="${LEFT - 10}" y="${cy + 4}" text-anchor="end">${esc(row.label)}</text><path class="bar" d="${bar}"/>`);
      if (row.mark !== undefined) parts.push(`<line class="mark" x1="${x(row.mark)}" y1="${cy - 10}" x2="${x(row.mark)}" y2="${cy + 10}"/>`);
      const labelX = Math.max(x(row.value), row.mark === undefined ? 0 : x(row.mark)) + 8;
      parts.push(`<text class="v" x="${labelX}" y="${cy + 4}">${round(row.value)} ms${row.mark === undefined ? "" : ` · ${row.markName} ${round(row.mark)}`}</text></g>`);
      y += ROW;
    }
    parts.push(`<line class="axis" x1="${LEFT}" y1="${top}" x2="${LEFT}" y2="${bottom}"/>`);
    y = bottom + 50;
  }
  const H = y - 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">Ghost provider benchmark</title>
<desc id="d">Decision latency and streamed draft latency per provider, measured ${esc(meta.date)}. The same numbers are in the table in bench-providers${FORM.suffix}.md.</desc>
<style>
  svg { --surface: #fcfcfb; --text: #0b0b0b; --text2: #52514e; --grid: #e6e5e0; --series: #2a78d6; }
  @media (prefers-color-scheme: dark) { svg { --surface: #1a1a19; --text: #ffffff; --text2: #c3c2b7; --grid: #33332f; --series: #3987e5; } }
  text { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; fill: var(--text); }
  .bg { fill: var(--surface); }
  .t { font-size: 16px; font-weight: 600; }
  .h { font-size: 13px; font-weight: 600; }
  .s, .tick { font-size: 11px; fill: var(--text2); }
  .l { font-size: 12px; }
  .v { font-size: 12px; fill: var(--text2); font-variant-numeric: tabular-nums; }
  .bar { fill: var(--series); }
  .mark { stroke: var(--text); stroke-width: 2; stroke-linecap: round; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis { stroke: var(--text2); stroke-width: 1; }
</style>
<rect class="bg" width="${W}" height="${H}" rx="8"/>
<text class="t" x="20" y="30">Ghost provider benchmark · ${esc(meta.date)} · N=${N} decisions, ${DRAFTS} drafts</text>
${parts.join("\n")}
</svg>
`;
}

async function listModels() {
  const b = configFor("baseten", "baseten").baseten;
  if (!b) return console.log("baseten:models needs BASETEN_API_KEY in .env");
  const res = await fetch(`${b.baseUrl.replace(/\/+$/, "")}/models`, { headers: { Authorization: `Bearer ${b.apiKey}` } });
  if (!res.ok) return console.log(`GET /models answered HTTP ${res.status}`);
  const ids = ((await res.json()).data ?? []).map((m) => m.id).filter((id) => typeof id === "string").sort();
  console.log(`${ids.length} models at ${b.baseUrl} (thinking switch from server/src/providers/baseten.ts):`);
  for (const id of ids) {
    const active = [id === b.decisionModel ? "decisions" : "", id === b.textModel ? "text" : ""].filter(Boolean).join(" + ");
    console.log(`  ${id.padEnd(48)} thinking=${thinkingControl(id).mode.padEnd(8)} ${active ? `<- active for ${active}` : ""}`);
  }
}

if (has("models")) {
  await listModels();
  process.exit(0);
}

const plan = targets();
const realCalls = plan.reduce((n, t) => n + N * t.callsPerDecision + DRAFTS * t.callsPerDraft, 0);
console.log(`Planned real API calls: ${realCalls} (guard: ${MAX_REAL_CALLS})`);
for (const t of plan) console.log(`  ${t.id}: ${N} decisions x ${t.callsPerDecision} + ${DRAFTS} drafts x ${t.callsPerDraft} = ${N * t.callsPerDecision + DRAFTS * t.callsPerDraft}`);
if (realCalls > MAX_REAL_CALLS) {
  console.error(`Refusing to run: ${realCalls} real calls is over the guard of ${MAX_REAL_CALLS}. Lower --n, --drafts, BASETEN_SAMPLES or BASETEN_HEDGE.`);
  process.exit(1);
}
if (has("dry-run")) process.exit(0);

const results = [];
for (const target of plan) {
  console.log(`\n${target.id}${target.decisionModel ? ` (${target.decisionModel})` : ""}`);
  const decisions = await benchDecisions(target);
  const drafts = target.callsPerDraft > 0 || target.id === "heuristic" ? await benchDrafts(target) : undefined;
  results.push({ ...target, textId: target.id === "heuristic" ? "template" : target.id, decisions, drafts });
}

const meta = { date: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC", realCalls };
mkdirSync(OUT_DIR, { recursive: true });
const outName = `bench-providers${FORM.suffix}`;
writeFileSync(join(OUT_DIR, `${outName}.md`), markdown(results, meta));
writeFileSync(join(OUT_DIR, `${outName}.svg`), svgChart(results, meta));
console.log(`\nWrote ${join(OUT_DIR, `${outName}.md`)} and ${outName}.svg`);
process.exit(0);
