import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEMO_PROFILE, FACT_DESCRIPTIONS } from "@ghost/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { extractFactsByRegex, toYearMonth } from "../src/lib/resumeRegex";
import { parseExtractedFacts } from "../src/llm/profileExtract";
import { chatJsonResponse, fakeFetch, type Responder } from "../src/llm/testing";
import { registerTextRoutes } from "../src/routes/text";

const FAKE_KEY = "test-key-not-real";
const RESUME = readFileSync(fileURLToPath(new URL("../../demo/fixtures/resume-alex-chen.txt", import.meta.url)), "utf8");
const DEMO = DEMO_PROFILE.facts;

interface ExtractJson {
  facts: Record<string, string>;
  pastAnswers: unknown[];
  provider: string;
  latencyMs: number;
  fallbackFrom?: string;
  error?: string;
}

function appWith(responder: Responder, env: Record<string, string> = { XAI_API_KEY: FAKE_KEY }) {
  const fake = fakeFetch(responder);
  const app = new Hono();
  registerTextRoutes(app, loadConfig(env), { fetch: fake.fetch });
  const post = async (body: unknown): Promise<{ status: number; json: ExtractJson }> => {
    const res = await app.request("/v1/profile/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as ExtractJson };
  };
  return { post, calls: fake.calls };
}

describe("regex extraction on the fictional fixture resume", () => {
  const facts = extractFactsByRegex(RESUME);

  it.each(["fullName", "firstName", "lastName", "email", "phone", "github", "linkedin", "website", "school", "degree", "major", "graduationDate", "location", "city", "province", "country"])("recovers %s exactly as in the demo profile", (key) => {
    expect(facts[key]).toBe(DEMO[key]);
  });

  it("parses the graduation date into YYYY-MM", () => {
    expect(facts.graduationDate).toBe("2028-04");
  });

  it("keeps skills as an extra fact and emits only canonical or extra.* keys", () => {
    expect(facts["extra.skills"]).toContain("TypeScript");
    for (const key of Object.keys(facts)) expect(key in FACT_DESCRIPTIONS || key.startsWith("extra.")).toBe(true);
  });

  it("does not guess facts the resume never states", () => {
    expect(facts.workAuthorization).toBeUndefined();
    expect(facts.requiresSponsorship).toBeUndefined();
    expect(facts.referralSource).toBeUndefined();
  });
});

describe("regex extraction on other layouts", () => {
  it("handles an upper-case name, a date range, and a spelled-out degree", () => {
    const facts = extractFactsByRegex(
      ["JORDAN LEE", "jordan.lee@example.org  (416) 555-0199  Toronto, ON", "https://www.jordanlee.ca/portfolio/", "Education", "Maplewood Institute of Technology, Toronto", "Bachelor of Science in Software Engineering, Sept 2022 - June 2026"].join("\n"),
    );
    expect(facts).toMatchObject({
      fullName: "Jordan Lee",
      firstName: "Jordan",
      lastName: "Lee",
      email: "jordan.lee@example.org",
      phone: "(416) 555-0199",
      website: "https://jordanlee.ca/portfolio",
      location: "Toronto, ON",
      school: "Maplewood Institute of Technology",
      major: "Software Engineering",
      graduationDate: "2026-06",
    });
  });

  it("never mistakes the email domain, a framework name or a date range for a website or phone", () => {
    const facts = extractFactsByRegex("Sam Park\nsam@parkmail.dev\nBuilt apps with Node.js and socket.io from 2019 - 2024 2025.\n");
    expect(facts.website).toBeUndefined();
    expect(facts.phone).toBeUndefined();
  });

  it("returns no name when the first line is not a name", () => {
    expect(extractFactsByRegex("Curriculum Vitae 2026\nsomeone@example.com").fullName).toBeUndefined();
  });
});

describe("regex extraction stays fast on hostile input", () => {
  const N = 20_000;
  // Each of these took 120 to 480 ms before the inputs were bounded, blocking every other route meanwhile.
  const hostile: [string, string][] = [
    ["a whitespace run in the header", `Alex Chen\nToronto${" ".repeat(N - 30)}, ON`],
    ["one long word with no @", "a".repeat(N)],
    ["a digit run", "1".repeat(N)],
    ["capitalised words after a school keyword", `University ${"A ".repeat((N - 12) / 2)}`],
    ["unclosed parentheses in a degree", `EDUCATION\nUniversity of X\nBSc in ${"(".repeat(N - 50)}`],
    ["a dotted pseudo-domain", `http://${"a.".repeat((N - 8) / 2)}`],
  ];

  it.each(hostile)("%s", (_name, text) => {
    const started = performance.now();
    extractFactsByRegex(text);
    expect(performance.now() - started).toBeLessThan(60);
  });

  it("still finds facts in a resume pasted as one long line", () => {
    const oneLine = `Sam Park  ${"Built things with care. ".repeat(60)} sam@parkmail.dev  github.com/sampark  ${"More prose here. ".repeat(40)}`;
    expect(extractFactsByRegex(oneLine)).toMatchObject({ email: "sam@parkmail.dev", github: "https://github.com/sampark" });
  });
});

describe("toYearMonth", () => {
  it.each([
    ["Expected April 2028", "2028-04"],
    ["Sept. 2023 – Apr 2027", "2027-04"],
    ["Graduating 05/2027", "2027-05"],
    ["2026-12 (expected)", "2026-12"],
    ["Spring 2029", "2029-05"],
    ["Class of 2028", undefined],
    ["no date here", undefined],
  ])("%s -> %s", (text, expected) => {
    expect(toYearMonth(text)).toBe(expected);
  });
});

describe("parseExtractedFacts", () => {
  it("keeps canonical and extra.* keys, drops unknown, empty, sensitive and non-string values", () => {
    const raw = "```json\n" + JSON.stringify({
      facts: {
        firstName: " Alex ", email: "alex.chen.dev@example.com", graduationDate: "Expected April 2028", "extra.skills": ["TypeScript", "Go"], "extra.yearsCoding": 6,
        favouriteColour: "green", phone: "", referralSource: "N/A", "extra.sin": "046 454 286", "extra.notes": "SIN 046-454-286", "extra.bad key": "x", major: { nested: true },
      },
    }) + "\n```";
    expect(parseExtractedFacts(raw)).toEqual({ firstName: "Alex", email: "alex.chen.dev@example.com", graduationDate: "2028-04", "extra.skills": "TypeScript, Go", "extra.yearsCoding": "6" });
  });

  it("drops a graduation date that code cannot parse", () => {
    expect(parseExtractedFacts('{"facts":{"graduationDate":"sometime soon","city":"Waterloo"}}')).toEqual({ city: "Waterloo" });
  });

  it("throws on output that is not a JSON object", () => {
    expect(() => parseExtractedFacts("Sorry, I cannot help with that.")).toThrow();
  });
});

describe("POST /v1/profile/extract", () => {
  it("uses the LLM in JSON mode, filters its answer, and fills gaps from the regex pass", async () => {
    const llmFacts = { firstName: "Alex", lastName: "Chen", fullName: "Alex Chen", email: "alex.chen@hallucinated.example", github: "https://github.com/alexchen-dev", province: "Ontario", graduationDate: "May 2029", "extra.recentRole": "Software Engineering Intern", shoeSize: "10" };
    const { post, calls } = appWith(() => chatJsonResponse(JSON.stringify({ facts: llmFacts })));
    const { status, json } = await post({ resumeText: RESUME });
    expect(status).toBe(200);
    expect(json.provider).toBe("xai");
    expect(json.pastAnswers).toEqual([]);
    expect(json.latencyMs).toBeGreaterThanOrEqual(0);
    expect(json.facts).toMatchObject({ firstName: "Alex", github: DEMO.github, province: "Ontario", "extra.recentRole": "Software Engineering Intern", phone: DEMO.phone, school: DEMO.school });
    // The hallucinated email is not in the resume, so the regex value wins; the date always comes from code.
    expect(json.facts.email).toBe(DEMO.email);
    expect(json.facts.graduationDate).toBe("2028-04");
    expect(json.facts.shoeSize).toBeUndefined();
    const sent = calls[0]?.body as { response_format: unknown; stream?: boolean; messages: { content: string }[] };
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.stream).toBeUndefined();
    expect(sent.messages[0]?.content).toContain("graduationDate");
    expect(sent.messages[1]?.content).toContain("Maple Lantern Labs");
  });

  it("falls back to regex and says so when the LLM answers garbage or errors", async () => {
    for (const responder of [() => chatJsonResponse("not json at all"), () => new Response("nope", { status: 429 }), () => chatJsonResponse('{"facts":{"shoeSize":"10"}}')]) {
      const { json } = await appWith(responder).post({ resumeText: RESUME });
      expect(json).toMatchObject({ provider: "regex", fallbackFrom: "xai", pastAnswers: [] });
      expect(json.facts.email).toBe(DEMO.email);
    }
  });

  it("uses regex with zero model calls when there is no key", async () => {
    const { post, calls } = appWith(() => new Response("unused"), {});
    const { json } = await post({ resumeText: RESUME });
    expect(calls).toHaveLength(0);
    expect(json.provider).toBe("regex");
    expect(json.fallbackFrom).toBeUndefined();
    expect(json.facts.graduationDate).toBe("2028-04");
  });

  it.each([
    ["a missing resumeText", {}],
    ["an empty resumeText", { resumeText: "   " }],
    ["a non-string resumeText", { resumeText: 42 }],
    ["an oversized resumeText", { resumeText: "x".repeat(20_001) }],
  ])("answers 400 for %s", async (_name, body) => {
    const { post, calls } = appWith(() => new Response("unused"));
    const { status, json } = await post(body);
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});
