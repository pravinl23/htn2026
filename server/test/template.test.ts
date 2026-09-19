import { DEMO_PROFILE } from "@ghost/shared";
import { describe, expect, it } from "vitest";
import { clipToSentences, formatYearMonth, templateDraft, wordCount, type DraftInput } from "../src/lib/template";

const NOW = new Date("2026-09-19T12:00:00Z");
const PLACEHOLDER = /\[[^\]]*\]|<[^>]*>|\{\{|undefined|null/;

function input(fieldLabel: string, overrides: Partial<DraftInput> = {}): DraftInput {
  return { fieldLabel, pageContext: { company: "Northwind Robotics", role: "Software Engineering Intern" }, facts: DEMO_PROFILE.facts, pastAnswers: [], ...overrides };
}

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

describe("templateDraft", () => {
  it.each(["Why Northwind?", "Tell us about a project you are proud of", "Cover letter", "Anything else we should know?"])("writes a 60 to 120 word first-person draft for %s", (label) => {
    const text = templateDraft(input(label), NOW);
    expect(wordCount(text)).toBeGreaterThanOrEqual(60);
    expect(wordCount(text)).toBeLessThanOrEqual(120);
    expect(sentenceCount(text)).toBeGreaterThanOrEqual(2);
    expect(sentenceCount(text)).toBeLessThanOrEqual(4);
    expect(text).toMatch(/\bI\b/);
    expect(text).not.toMatch(PLACEHOLDER);
  });

  it("is deterministic and uses the given company, role, school and graduation date", () => {
    const text = templateDraft(input("Why Northwind?"), NOW);
    expect(templateDraft(input("Why Northwind?"), NOW)).toBe(text);
    expect(text).toContain("Northwind Robotics");
    expect(text).toContain("Software Engineering Intern");
    expect(text).toContain("the University of Waterloo");
    expect(text).toContain("graduating in April 2028");
    expect(text).toContain("https://github.com/alexchen-dev");
  });

  it("says graduated once the date is in the past", () => {
    expect(templateDraft(input("Why Northwind?"), new Date("2029-01-01T00:00:00Z"))).toContain("graduated in April 2028");
  });

  it("never invents details when there are no facts and no page context", () => {
    const text = templateDraft({ fieldLabel: "Why do you want to work here?", pageContext: {}, facts: {}, pastAnswers: [] }, NOW);
    expect(sentenceCount(text)).toBeGreaterThanOrEqual(2);
    expect(text).not.toMatch(PLACEHOLDER);
    expect(text).not.toMatch(/\d/);
    expect(text).not.toMatch(/University|Northwind|Intern/);
  });

  it("mentions skills only when they are in the facts", () => {
    const withSkills = templateDraft(input("Why Northwind?", { facts: { ...DEMO_PROFILE.facts, "extra.skills": "Languages: TypeScript, Python, Go, SQL" } }), NOW);
    expect(withSkills).toContain("TypeScript, Python and Go");
    expect(templateDraft(input("Why Northwind?"), NOW)).not.toContain("TypeScript");
  });

  it("reuses a past answer to a similar essay question, but never for a why-this-company question", () => {
    const answer = "Last term I built a small scheduling tool for my residence floor and iterated on it with feedback from the people using it.";
    const pastAnswers = [{ question: "Tell us about a project", answer }];
    expect(templateDraft(input("Tell us about a project you built", { pastAnswers }), NOW)).toBe(answer);
    const why = [{ question: "Why Acme?", answer: "I want to work at Acme because of its rockets and its long history of roadrunner research." }];
    expect(templateDraft(input("Why Northwind?", { pastAnswers: why }), NOW)).not.toContain("Acme");
  });

  it("respects maxChars by dropping whole sentences", () => {
    const text = templateDraft(input("Why Northwind?", { maxChars: 300 }), NOW);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toMatch(/[.!?]$/);
  });
});

describe("clipToSentences", () => {
  it("does not treat dots inside URLs as sentence ends", () => {
    const text = "See https://github.com/alexchen-dev for more. Second sentence here. Third one.";
    expect(clipToSentences(text, 60)).toBe("See https://github.com/alexchen-dev for more.");
  });

  it("falls back to a word boundary when the first sentence is too long", () => {
    expect(clipToSentences("One very long sentence without any early ending at all.", 25)).toBe("One very long sentence");
  });
});

describe("formatYearMonth", () => {
  it("formats YYYY-MM and leaves other text alone", () => {
    expect(formatYearMonth("2028-04")).toBe("April 2028");
    expect(formatYearMonth("Spring 2028")).toBe("Spring 2028");
    expect(formatYearMonth("2028-13")).toBe("2028-13");
  });
});
