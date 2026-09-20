// "Your profile sources": the scanners, the review list, and the page that never saves anything the user
// did not check. Nothing here touches the network: every fetch and every file read is injected.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_PROFILE, listFacts, setUserFact } from "@ghost/shared";
import type { FactProposal } from "@ghost/shared";
import { FACTS_KEY, getFactGraph, getProfile, resetMemoryStorage, updateFactGraph } from "../src/lib/storage";
import {
  buildProposalReview, describeSource, factViews, githubLogin, htmlToText, parseHttpUrl, saveProposalRows, scanGitHub,
  scanLinkedIn, scanResume, scanText, scanVCard, scanWebsite, sourceGroups,
} from "../src/options/facts-scan";
import { mountFacts } from "../src/options/facts-section";
import { createChromeStorageMock } from "./chrome-mock";

const GITHUB_JSON = {
  login: "alexchen-dev",
  name: "Alex Chen",
  email: "alex.chen.dev@example.com",
  blog: "https://alexchen.dev",
  company: "@Northwind Robotics",
  location: "Waterloo, ON",
  twitter_username: "alexchendev",
  // Fields the extractor must ignore, including a wrongly typed one.
  followers: 12,
  bio: null,
};

const VCARD = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Alex Chen",
  "N:Chen;Alex;;;",
  "EMAIL;TYPE=WORK:alex@northwind.example",
  "TEL;TYPE=CELL:+1 519 555 0142",
  "ADR;TYPE=HOME:;Apt 4;88 Rideau Street;Waterloo;Ontario;N2L 3G1;Canada",
  "ORG:Northwind Robotics",
  "TITLE:Software Engineer",
  "END:VCARD",
].join("\n");

const SIGNATURE = [
  "Alex Chen",
  "Software Engineer at Northwind Robotics",
  "alex.chen.dev@example.com",
  "M: +1 519 555 0142",
  "https://github.com/alexchen-dev",
].join("\n");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fetchOnce(response: Response | (() => Response | Promise<Response>)): typeof fetch {
  return vi.fn(async () => (typeof response === "function" ? response() : response)) as unknown as typeof fetch;
}

function proposal(partial: Partial<FactProposal> & { key: string; value: string }): FactProposal {
  return { source: { kind: "file", name: "test.txt" }, ...partial };
}

describe("githubLogin / parseHttpUrl / htmlToText", () => {
  it("accepts a username however the user wrote it", () => {
    for (const input of ["alexchen-dev", "@alexchen-dev", "https://github.com/alexchen-dev", "github.com/alexchen-dev/"]) {
      expect(githubLogin(input)).toBe("alexchen-dev");
    }
  });

  it("refuses anything that is not a login", () => {
    for (const input of ["", "  ", "alex chen", "alex/chen", "-alex", "a".repeat(40), "alex--dev"]) expect(githubLogin(input)).toBeNull();
  });

  it("fills in https:// and refuses other schemes", () => {
    expect(parseHttpUrl("alexchen.dev")?.href).toBe("https://alexchen.dev/");
    expect(parseHttpUrl("http://localhost:5173/about")?.origin).toBe("http://localhost:5173");
    for (const input of ["", "javascript:alert(1)", "file:///etc/passwd"]) expect(parseHttpUrl(input)).toBeNull();
  });

  it("reads text out of a page and drops scripts and markup", () => {
    const text = htmlToText("<html><head><style>p{}</style><script>var email='evil@example.com'</script></head><body><h1>Alex Chen</h1><p>Engineer at Northwind &amp; Co</p></body></html>");
    expect(text).toBe("Alex Chen\nEngineer at Northwind & Co");
    expect(text).not.toContain("evil@example.com");
  });
});

describe("scanners", () => {
  it("turns a public GitHub profile into proposals with provenance", async () => {
    const proposals = await scanGitHub("@alexchen-dev", { fetch: fetchOnce(json(GITHUB_JSON)) });
    const byKey = Object.fromEntries(proposals.map((p) => [p.key, p]));
    expect(Object.keys(byKey).sort()).toEqual(["email", "firstName", "fullName", "github", "lastName", "links.twitter", "location", "website", "work.employer.current"]);
    expect(byKey.github).toMatchObject({ value: "https://github.com/alexchen-dev", source: { kind: "github", login: "alexchen-dev" } });
    expect(byKey["work.employer.current"]?.value).toBe("Northwind Robotics");
    expect(byKey.email?.evidence).toContain("alex.chen.dev@example.com");
  });

  it("says what went wrong instead of throwing something raw", async () => {
    await expect(scanGitHub("not a login")).rejects.toThrow(/not a GitHub username/);
    await expect(scanGitHub("alexchen-dev", { fetch: fetchOnce(json({}, 404)) })).rejects.toThrow(/no public user/);
    await expect(scanGitHub("alexchen-dev", { fetch: fetchOnce(json({}, 500)) })).rejects.toThrow(/answered 500/);
    const boom = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(scanGitHub("alexchen-dev", { fetch: boom })).rejects.toThrow(/Could not read/);
  });

  it("reads a personal page as text and keeps its origin as the source", async () => {
    const page = new Response("<body><h1>Alex Chen</h1><p>Software Engineer at Northwind Robotics</p><p>alex@alexchen.dev</p></body>", { status: 200 });
    const proposals = await scanWebsite("alexchen.dev", { fetch: fetchOnce(page) });
    expect(proposals.map((p) => p.key)).toContain("work.employer.current");
    expect(proposals.every((p) => p.source.kind === "website")).toBe(true);
    expect(proposals[0]?.source).toEqual({ kind: "website", origin: "https://alexchen.dev" });
  });

  it("takes a LinkedIn profile address as a fact, and refuses anything else", () => {
    expect(scanLinkedIn("linkedin.com/in/alexchen-dev")).toEqual([
      expect.objectContaining({ key: "linkedin", value: "https://linkedin.com/in/alexchen-dev", source: { kind: "website", origin: "https://linkedin.com" } }),
    ]);
    expect(scanLinkedIn("https://www.linkedin.com/in/alexchen-dev")[0]?.key).toBe("linkedin");
    expect(() => scanLinkedIn("https://example.com/in/alex")).toThrow(/LinkedIn profile address/);
    expect(() => scanLinkedIn("https://linkedin.com/feed")).toThrow(/not a profile address/);
  });

  it("reads an address out of a contact card, which is what makes a shipping form fillable", () => {
    const byKey = Object.fromEntries(scanVCard(VCARD, "alex.vcf").map((p) => [p.key, p.value]));
    expect(byKey["address.home.street"]).toBe("88 Rideau Street");
    expect(byKey["address.home.postalCode"]).toBe("N2L 3G1");
    expect(byKey["contact.email.work"]).toBe("alex@northwind.example");
    expect(byKey["work.title"]).toBe("Software Engineer");
  });

  it("reads a signature block", () => {
    const byKey = Object.fromEntries(scanText(SIGNATURE, { kind: "file", name: "pasted text" }).map((p) => [p.key, p.value]));
    expect(byKey).toMatchObject({ email: "alex.chen.dev@example.com", phone: "+1 519 555 0142", github: "https://github.com/alexchen-dev", "work.employer.current": "Northwind Robotics" });
  });

  it("sends a resume to the local server, and still proposes when the server is down", async () => {
    const served = await scanResume("Alex Chen\nUniversity of Waterloo", "alex.pdf", {
      fetch: fetchOnce(json({ facts: { school: "University of Waterloo", ssn: "046 454 286" }, provider: "openai" })),
      serverUrl: "http://localhost:8787",
    });
    expect(served.provider).toBe("openai");
    expect(served.proposals.map((p) => p.key)).toEqual(["school"]); // the sensitive key never becomes a proposal
    expect(served.proposals[0]?.source).toEqual({ kind: "file", name: "alex.pdf" });

    const offline = await scanResume(SIGNATURE, "alex.txt", {
      fetch: fetchOnce(() => {
        throw new Error("no server");
      }),
      serverUrl: "http://localhost:8787",
    });
    expect(offline.provider).toBe("offline");
    expect(offline.proposals.map((p) => p.key)).toContain("email");

    // A contact card is read here on the machine; the server is never called for it.
    const fetchSpy = fetchOnce(json({ facts: {} }));
    const card = await scanResume(VCARD, "alex.vcf", { fetch: fetchSpy, serverUrl: "http://localhost:8787" });
    expect(card.provider).toBe("vcard");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the review list", () => {
  it("checks what is new, disables what is already saved, and never shows a sensitive proposal", async () => {
    const graph = await getFactGraph();
    const review = buildProposalReview(graph, [
      proposal({ key: "firstName", value: "Alex" }), // already exactly this
      proposal({ key: "address.home.street", value: "88 Rideau Street" }),
      proposal({ key: "city", value: "Toronto" }), // disagrees with the graph
      proposal({ key: "member.number", value: "4111 1111 1111 1111", label: "member number" }), // a card in disguise
      proposal({ key: "identity.passportNumber", value: "X1234567" }),
      proposal({ key: "city", value: "Ottawa" }), // a second value for a key already proposed
    ]);
    expect(review.sensitive).toBe(2);
    expect(review.rows.map((r) => r.key)).toEqual(["firstName", "address.home.street", "city"]);
    expect(review.rows.map((r) => r.checked)).toEqual([false, true, true]);
    expect(review.rows[0]?.unchanged).toBe(true);
    expect(review.rows[2]?.current).toBe("Waterloo");
  });

  it("saves only the checked rows and keeps the source that proposed them", async () => {
    const graph = await getFactGraph();
    const review = buildProposalReview(graph, [
      proposal({ key: "address.home.street", value: "88 Rideau Street", source: { kind: "github", login: "alexchen-dev" } }),
      proposal({ key: "travel.homeAirport", value: "YKF" }),
    ]);
    const airport = review.rows.find((r) => r.key === "travel.homeAirport");
    if (airport) airport.checked = false;
    const result = saveProposalRows(graph, review.rows);
    expect(result.saved).toBe(1);
    expect(result.graph.facts["address.home.street"]).toMatchObject({ value: "88 Rideau Street", verifiedByUser: true, source: { kind: "github", login: "alexchen-dev" } });
    expect(result.graph.facts["travel.homeAirport"]).toBeUndefined();
    expect(graph.facts["address.home.street"]).toBeUndefined(); // the graph passed in is never mutated
  });

  it("drops a value read off a line that names a government ID, however it was keyed", async () => {
    const graph = await getFactGraph();
    // A Canadian SIN is phone-shaped: only the line it came from says what it is.
    const review = buildProposalReview(graph, [
      proposal({ key: "phone", value: "046 454 286", evidence: "SIN 046 454 286" }),
      proposal({ key: "other.number", value: "123 456", label: "member number", evidence: "Health card number: 123 456" }),
      proposal({ key: "phone", value: "+1 519 555 0142", evidence: "M: +1 519 555 0142" }),
    ]);
    expect(review.sensitive).toBe(2);
    expect(review.rows.map((r) => r.value)).toEqual(["+1 519 555 0142"]);
  });

  it("refuses a row the user edited into something sensitive", async () => {
    const graph = await getFactGraph();
    const review = buildProposalReview(graph, [proposal({ key: "loyalty.number", value: "12345", label: "loyalty number" })]);
    const row = review.rows[0];
    if (!row) throw new Error("expected a row");
    row.value = "4111 1111 1111 1111";
    const result = saveProposalRows(graph, review.rows);
    expect(result).toMatchObject({ saved: 0, skipped: 1 });
    expect(result.graph.facts["loyalty.number"]).toBeUndefined();
  });

  it("leaves a proposal the user turned down out of the next review", async () => {
    let graph = await getFactGraph();
    const first = buildProposalReview(graph, [proposal({ key: "travel.homeAirport", value: "YKF" })]);
    const row = first.rows[0];
    if (!row) throw new Error("expected a row");
    graph = (await import("@ghost/shared")).rejectProposal(graph, row.key, row.value);
    const second = buildProposalReview(graph, [proposal({ key: "travel.homeAirport", value: "YKF" })]);
    expect(second.rows).toHaveLength(0);
    expect(second.rejected).toBe(1);
  });
});

describe("the fact list", () => {
  it("names every source and groups the facts under it", async () => {
    let graph = await getFactGraph();
    graph = saveProposalRows(graph, buildProposalReview(graph, [
      proposal({ key: "work.title", value: "Software Engineer", source: { kind: "github", login: "alexchen-dev" } }),
      proposal({ key: "links.twitter", value: "https://x.com/alexchendev", source: { kind: "github", login: "alexchen-dev" } }),
    ]).rows).graph;
    const groups = sourceGroups(graph);
    expect(groups.map((g) => g.id)).toEqual(["user", "github:alexchen-dev"]);
    expect(groups[1]?.count).toBe(2);
    expect(describeSource({ kind: "github", login: "alexchen-dev" })).toBe("github · alexchen-dev");
  });

  it("searches over key, label, value and source, and never shows a sensitive value", async () => {
    let graph = await getFactGraph();
    graph = setUserFact(graph, "health.cardNumber", "1234 567 890 XY").graph;
    expect(factViews(graph, "waterloo").map((v) => v.key)).toContain("location");
    expect(factViews(graph, "postal")).toHaveLength(0);
    const health = factViews(graph, "health")[0];
    expect(health).toMatchObject({ sensitive: true, value: "" });
  });
});

// ---------- the page itself ----------

describe("the profile sources page", () => {
  let mock: ReturnType<typeof createChromeStorageMock>;
  const $ = <T extends HTMLElement>(testId: string): T => {
    const el = document.querySelector<T>(`[data-testid="${testId}"]`);
    if (!el) throw new Error(`missing ${testId}`);
    return el;
  };
  const maybe = (testId: string): HTMLElement | null => document.querySelector(`[data-testid="${testId}"]`);
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };

  async function mount(fetchImpl?: typeof fetch): Promise<HTMLElement> {
    const panel = document.createElement("section");
    document.body.replaceChildren(panel);
    mountFacts(panel, fetchImpl ? { fetch: fetchImpl, serverUrl: "http://localhost:8787" } : {});
    await settle();
    return panel;
  }

  beforeEach(() => {
    mock = createChromeStorageMock();
    vi.stubGlobal("chrome", mock.chrome);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    resetMemoryStorage();
  });

  it("lists the migrated demo facts, its sources and the connectors that do not exist yet", async () => {
    await mount();
    expect($("facts-summary").textContent).toBe(`${Object.keys(DEMO_PROFILE.facts).length} facts`);
    expect($("fact-row-firstName").textContent).toContain("first name");
    expect($<HTMLInputElement>("fact-value-firstName").value).toBe("Alex");
    expect($("facts-empty").hidden).toBe(true);
    expect($("source-group-user").textContent).toContain("you");
    for (const id of ["resume", "github", "linkedin", "website", "text"]) expect(maybe(`source-scan-${id}`)).not.toBeNull();
    for (const id of ["mail", "calendar", "drive"]) {
      expect($<HTMLButtonElement>(`source-scan-${id}`).disabled).toBe(true);
      expect($(`source-scan-${id}`).textContent).toBe("Connect through the desktop app");
    }
  });

  it("scans GitHub, proposes, and saves nothing until Save is pressed", async () => {
    await mount(fetchOnce(json(GITHUB_JSON)));
    const before = await getFactGraph();
    type($<HTMLInputElement>("source-input-github"), "alexchen-dev");
    $("source-scan-github").click();
    await settle();

    expect($("proposal-source").textContent).toContain("github · alexchen-dev");
    expect(maybe("proposal-row-work.employer.current")).not.toBeNull();
    expect($<HTMLButtonElement>("proposal-save").textContent).toContain("Save");
    // Still nothing in the graph: a proposal is not a fact.
    const after = await getFactGraph();
    expect(listFacts(after).map((f) => f.key)).toEqual(listFacts(before).map((f) => f.key));
    expect(after.facts["work.employer.current"]).toBeUndefined();
  });

  it("saves only the rows that are checked", async () => {
    await mount(fetchOnce(json(GITHUB_JSON)));
    type($<HTMLInputElement>("source-input-github"), "alexchen-dev");
    $("source-scan-github").click();
    await settle();

    // Everything off, then one row back on: the user's choice is the only thing that is saved.
    for (const check of document.querySelectorAll<HTMLInputElement>('[data-testid^="proposal-check-"]')) {
      if (!check.disabled && check.checked) {
        check.checked = false;
        check.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    const wanted = $<HTMLInputElement>("proposal-check-work.employer.current");
    wanted.checked = true;
    wanted.dispatchEvent(new Event("change", { bubbles: true }));
    expect($<HTMLButtonElement>("proposal-save").textContent).toBe("Save 1 fact");
    $("proposal-save").click();
    await settle();

    const graph = await getFactGraph();
    expect(graph.facts["work.employer.current"]?.value).toBe("Northwind Robotics");
    expect(graph.facts["links.twitter"]).toBeUndefined();
    expect($("facts-status").textContent).toBe("Saved 1 fact");
    expect(maybe("facts-review-table")).toBeNull();
    // The flat mirror the content script reads has it too, so the next form can use it.
    expect((await getProfile()).facts["work.employer.current"]).toBe("Northwind Robotics");
    expect(maybe("fact-row-work.employer.current")).not.toBeNull();
  });

  it("reads a file through its own seam and never offers a sensitive proposal, whatever the source sent", async () => {
    const readFile = vi.fn(async () => ({ ok: true as const, text: "Alex Chen\nUniversity of Waterloo" }));
    const panel = document.createElement("section");
    document.body.replaceChildren(panel);
    mountFacts(panel, {
      readFile,
      fetch: fetchOnce(json({ facts: { school: "University of Waterloo", ssn: "046 454 286", creditCardNumber: "4111 1111 1111 1111" }, provider: "openai" })),
      serverUrl: "http://localhost:8787",
    });
    await settle();

    const picker = $<HTMLInputElement>("source-input-resume");
    Object.defineProperty(picker, "files", { value: [new File(["resume"], "alex.pdf", { type: "application/pdf" })] });
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect($("source-note-resume").textContent).toContain("alex.pdf");

    $("source-scan-resume").click();
    await settle();
    expect([...document.querySelectorAll('[data-testid^="proposal-row-"]')].map((el) => el.getAttribute("data-testid"))).toEqual(["proposal-row-school"]);

    $("proposal-save").click();
    await settle();
    const stored = JSON.stringify(await getFactGraph());
    expect(stored).toContain("University of Waterloo");
    expect(stored).not.toContain("046 454 286");
    expect(stored).not.toContain("4111");
    expect(JSON.stringify(await getProfile())).not.toContain("046 454 286");
  });

  it("forgets exactly the facts that came from one source", async () => {
    await mount(fetchOnce(json(GITHUB_JSON)));
    await updateFactGraph((graph) => saveProposalRows(graph, buildProposalReview(graph, [
      { key: "work.employer.current", value: "Northwind Robotics", source: { kind: "github", login: "alexchen-dev" } },
      { key: "links.twitter", value: "https://x.com/alexchendev", source: { kind: "github", login: "alexchen-dev" } },
    ]).rows).graph);
    await settle();
    const before = listFacts(await getFactGraph()).length;

    const forget = $<HTMLButtonElement>("source-forget-github:alexchen-dev");
    forget.click(); // arms
    forget.click(); // confirms
    await settle();

    const graph = await getFactGraph();
    expect(listFacts(graph)).toHaveLength(before - 2);
    expect(graph.facts["work.employer.current"]).toBeUndefined();
    expect(graph.facts.firstName?.value).toBe("Alex"); // the user's own facts are untouched
    expect($("facts-status").textContent).toContain("Forgot 2 facts");
  });

  it("edits and deletes one fact, and filters the list", async () => {
    await mount();
    const value = $<HTMLInputElement>("fact-value-city");
    type(value, "Toronto");
    $("fact-save-city").click();
    await settle();
    expect((await getFactGraph()).facts.city?.value).toBe("Toronto");
    expect((await getProfile()).facts.city).toBe("Toronto");

    const remove = $<HTMLButtonElement>("fact-delete-website");
    remove.click();
    remove.click();
    await settle();
    expect((await getFactGraph()).facts.website).toBeUndefined();
    expect(maybe("fact-row-website")).toBeNull();

    type($<HTMLInputElement>("facts-search"), "toronto");
    expect(document.querySelectorAll('[data-testid^="fact-row-"]')).toHaveLength(1);
    expect($("facts-summary").textContent).toMatch(/^1 of \d+ facts$/);
  });

  it("says what went wrong and proposes nothing when a scan fails", async () => {
    await mount(fetchOnce(json({}, 404)));
    type($<HTMLInputElement>("source-input-github"), "nobody-here");
    $("source-scan-github").click();
    await settle();
    expect($("facts-error").textContent).toContain("no public user");
    expect(maybe("facts-review-table")).toBeNull();
    expect(mock.store.get(FACTS_KEY)).toBeDefined(); // the migration ran; the scan changed nothing
  });
});
