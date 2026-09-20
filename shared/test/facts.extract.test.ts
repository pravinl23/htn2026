// Sourcing the graph from what the user already has: a GitHub profile, a vCard, a mail signature block.
// Offline, deterministic, no model and no network. All fixtures fictional (CLAUDE.md rule 6).
import { describe, expect, it } from "vitest";
import {
  applyProposals,
  classifyLink,
  emptyGraph,
  factsFromGitHubProfile,
  factsFromText,
  factsFromVCard,
  findEmails,
  findPhone,
  getFact,
  listFacts,
  mapFieldToFact,
  removeBySource,
  setUserFact,
  upsertFact,
} from "../src";
import { fieldOf } from "./helpers/factFixtures";

const T1 = "2026-01-01T00:00:00.000Z";

function byKey(proposals: ReturnType<typeof factsFromVCard>): Record<string, string> {
  return Object.fromEntries(proposals.map((p) => [p.key, p.value]));
}

describe("factsFromGitHubProfile", () => {
  const profile = {
    login: "alexchen-dev",
    name: "Alex Chen",
    email: "alex.chen.dev@example.com",
    blog: "https://alexchen.dev",
    company: "@Northwind Robotics",
    location: "Waterloo, ON",
    twitter_username: "alexchen_dev",
    bio: "builds things",
  };

  it("reads a public profile into facts with provenance", () => {
    const proposals = factsFromGitHubProfile(profile);
    expect(byKey(proposals)).toMatchObject({
      github: "https://github.com/alexchen-dev",
      fullName: "Alex Chen",
      firstName: "Alex",
      lastName: "Chen",
      email: "alex.chen.dev@example.com",
      website: "https://alexchen.dev",
      "work.employer.current": "Northwind Robotics",
      location: "Waterloo, ON",
      "links.twitter": "https://x.com/alexchen_dev",
    });
    for (const proposal of proposals) {
      expect(proposal.source).toEqual({ kind: "github", login: "alexchen-dev" });
      expect(proposal.confidence).toBeLessThan(1);
      expect(proposal.evidence?.length ?? 0).toBeLessThanOrEqual(120);
    }
  });

  it("proposes nothing without a login, and skips the fields the profile leaves empty", () => {
    expect(factsFromGitHubProfile({ name: "Alex Chen" })).toEqual([]);
    expect(byKey(factsFromGitHubProfile({ login: "alexchen-dev", name: null, email: null }))).toEqual({ github: "https://github.com/alexchen-dev" });
  });

  it("feeds the graph, and the graph forgets the source in one call", () => {
    const scanned = applyProposals(emptyGraph(T1), factsFromGitHubProfile(profile), T1);
    expect(scanned.added).toBe(9);
    expect(getFact(scanned.graph, "work.employer.current")?.verifiedByUser).toBe(false);
    const forgotten = removeBySource(scanned.graph, { kind: "github", login: "alexchen-dev" }, T1);
    expect(forgotten.removed).toBe(9);
    expect(listFacts(forgotten.graph)).toEqual([]);
  });

  it("never overwrites what the user typed", () => {
    const typed = setUserFact(emptyGraph(T1), "work.employer.current", "Contoso", {}, T1).graph;
    const scanned = applyProposals(typed, factsFromGitHubProfile(profile), T1);
    expect(getFact(scanned.graph, "work.employer.current")?.value).toBe("Contoso");
    expect(scanned.kept).toBe(1);
  });
});

describe("factsFromVCard", () => {
  const vcard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Alex Chen",
    "N:Chen;Alex;;;",
    "ORG:Northwind Robotics;Platform",
    "TITLE:Software Engineer",
    "EMAIL;TYPE=WORK:alex@northwind.example",
    "EMAIL;TYPE=HOME:alex.chen.dev@example.com",
    "TEL;TYPE=CELL:+1 519 555 0142",
    "ADR;TYPE=HOME:;Unit 4;742 King Street West;Waterloo;ON;N2L 3G1;Canada",
    "URL:https://alexchen.dev",
    "END:VCARD",
  ].join("\n");

  it("reads the address a résumé never had", () => {
    expect(byKey(factsFromVCard(vcard))).toMatchObject({
      fullName: "Alex Chen",
      firstName: "Alex",
      lastName: "Chen",
      "work.employer.current": "Northwind Robotics",
      "work.title": "Software Engineer",
      "contact.email.work": "alex@northwind.example",
      email: "alex.chen.dev@example.com",
      phone: "+1 519 555 0142",
      "address.home.street": "742 King Street West",
      "address.home.unit": "Unit 4",
      city: "Waterloo",
      province: "ON",
      "address.home.postalCode": "N2L 3G1",
      country: "Canada",
      website: "https://alexchen.dev",
    });
  });

  it("turns one exported contact card into a shipping form that fills itself", () => {
    const graph = applyProposals(emptyGraph(T1), factsFromVCard(vcard), T1).graph;
    for (const [label, key] of [
      ["Street address", "address.home.street"],
      ["Shipping postal code", "address.home.postalCode"],
      ["City", "city"],
      ["Full name", "fullName"],
    ] as const) {
      expect(mapFieldToFact(fieldOf(label), [], graph).factKey, label).toBe(key);
    }
  });

  it("ignores a card that is not one, and lines it cannot read", () => {
    expect(factsFromVCard("hello\nworld")).toEqual([]);
    expect(factsFromVCard("FN:\nTEL:not a number\nURL:https://facebook.com/someone")).toEqual([]);
  });
});

describe("factsFromText", () => {
  const signature = [
    "Thanks,",
    "Alex Chen",
    "Software Engineer at Northwind Robotics",
    "m: +1 519 555 0142",
    "alex@northwind.example | https://alexchen.dev",
    "https://github.com/alexchen-dev",
  ].join("\n");

  const source = { kind: "mail", connector: "gmail" } as const;

  it("reads a signature block into modest proposals", () => {
    const proposals = factsFromText(signature, source, { fullName: "Alex Chen", preferDomain: "northwind.example" });
    expect(byKey(proposals)).toMatchObject({
      "contact.email.work": "alex@northwind.example",
      website: "https://alexchen.dev",
      github: "https://github.com/alexchen-dev",
      phone: "+1 519 555 0142",
      fullName: "Alex Chen",
      "work.title": "Software Engineer",
      "work.employer.current": "Northwind Robotics",
    });
    // A signature can hold someone else's details: every proposal stays reviewable, none is a certainty.
    for (const proposal of proposals) expect(proposal.confidence).toBeLessThanOrEqual(0.8);
  });

  it("keeps the source on every proposal so one click can undo the whole scan", () => {
    for (const proposal of factsFromText(signature, source)) expect(proposal.source).toEqual(source);
  });

  it("finds nothing in prose that says nothing", () => {
    expect(factsFromText("Let's meet on Tuesday to talk about the roadmap.", source)).toEqual([]);
  });
});

describe("what extraction must never propose", () => {
  const source = { kind: "mail", connector: "gmail" } as const;

  it("never proposes a card, an ID or anything else sensitive", () => {
    const receipt = "Card 4111 1111 1111 1111 exp 04/29\nSIN 123-45-6789\nalex@example.com";
    const proposals = factsFromText(receipt, source);
    expect(proposals.map((p) => p.key)).toEqual(["email"]);
    expect(JSON.stringify(proposals)).not.toContain("4111");
  });

  it("refuses a sensitive value even when a card names it innocently", () => {
    const vcard = "BEGIN:VCARD\nTEL;TYPE=WORK:4111 1111 1111 1111\nNOTE:123-45-6789\nEND:VCARD";
    expect(factsFromVCard(vcard)).toEqual([]);
  });

  it("and the graph refuses it a second time, on the way in", () => {
    const smuggled = { key: "other.note", value: "4111 1111 1111 1111", source, label: "note" };
    expect(upsertFact(emptyGraph(T1), smuggled, T1).status).toBe("sensitive");
  });
});

describe("the small readers", () => {
  it("reads phone numbers and leaves dates, cards and versions alone", () => {
    expect(findPhone("m: +1 519 555 0142")).toBe("+1 519 555 0142");
    expect(findPhone("(519) 555-0142")).toBe("(519) 555-0142");
    expect(findPhone("2026-04-30")).toBeNull();
    expect(findPhone("no numbers here")).toBeNull();
  });

  it("reads emails once each", () => {
    expect(findEmails("a@x.example, a@x.example; b@y.example.")).toEqual(["a@x.example", "b@y.example"]);
  });

  it("knows which link is which, and which to ignore", () => {
    expect(classifyLink("https://github.com/alexchen-dev")).toBe("github");
    expect(classifyLink("https://www.linkedin.com/in/alexchen-dev")).toBe("linkedin");
    expect(classifyLink("https://x.com/alexchen_dev")).toBe("links.twitter");
    expect(classifyLink("alexchen.dev")).toBe("website");
    expect(classifyLink("https://github.com/alexchen-dev/ghost")).toBeNull();
    expect(classifyLink("https://instagram.com/someone")).toBeNull();
  });
});
