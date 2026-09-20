import { describe, expect, it } from "vitest";
import { EpisodicStore, actionFromEvent, jaccard, predictFromMemory, predictFromRecentSiteMemory, rankNextCandidates, stateSummary } from "../src";
import type { EpisodicAction, NextCandidate } from "../src";
import { TraceBuilder } from "./helpers/traceBuilder";

const action = (label: string, kind: EpisodicAction["kind"] = "button"): EpisodicAction => ({
  type: "click", targetShape: `${label}#${kind}`, label, signature: `${kind}:${label}`, kind, locked: false,
});

const candidates: NextCandidate[] = [
  { id: "button:Pick slot", kind: "button", label: "Pick slot", locked: false },
  { id: "button:Send", kind: "button", label: "Send", locked: true },
  { id: "link:Calendar", kind: "link", label: "Calendar", locked: false },
];

describe("stateSummary", () => {
  it("is the path pattern plus the last 3 shape keys, without values", () => {
    const tb = new TraceBuilder().navigate("/mail").clickItem("ul#mail", 4, "Can we meet?").navigate("/mail/17").input("Reply", "secret draft").click("Calendar", { kind: "link" });
    const summary = stateSummary(tb.events(), "/mail/:id");
    expect(summary).toBe("/mail/:id > navigate|/mail/:id| > input|/mail/:id|Reply#text > click|/mail/:id|Calendar#link");
    expect(summary).not.toContain("secret");
  });

  it("is stable across list indexes, ids and noise", () => {
    const a = new TraceBuilder().navigate("/mail").clickItem("ul#mail", 4, "A").navigate("/mail/17");
    const b = new TraceBuilder().navigate("/mail").clickBody().clickItem("ul#mail", 9, "B").navigate("/mail/99");
    expect(stateSummary(a.events(), "/mail/:id")).toBe(stateSummary(b.events(), "/mail/:id"));
    expect(stateSummary([], "/mail")).toBe("/mail");
  });
});

describe("EpisodicStore", () => {
  it("counts repeated pairs instead of duplicating them", () => {
    const store = new EpisodicStore();
    store.add("s1", action("Send"));
    store.add("s1", action("Send"));
    store.add("s1", action("Calendar", "link"));
    expect(store.size).toBe(2);
    expect(store.retrieve("s1").map((p) => [p.action.label, p.count])).toEqual([["Send", 2], ["Calendar", 1]]);
  });

  it("ranks exact summaries first, then Jaccard similarity", () => {
    const store = new EpisodicStore();
    store.add("/mail/:id > click|/mail|LIST(ul#mail) > navigate|/mail/:id|", action("Near"));
    store.add("/sheet > input|/sheet|CELL(Total)", action("Far"));
    store.add("/calendar > click|/calendar|Thursday#button", action("Unrelated"));
    store.add("/mail/:id > navigate|/mail/:id|", action("Exact"));
    const got = store.retrieve("/mail/:id > navigate|/mail/:id|", 2).map((p) => p.action.label);
    expect(got).toEqual(["Exact", "Near"]);
    expect(store.retrieve("zzz")).toEqual([]);
    expect(jaccard("a b c", "b c d")).toBeCloseTo(0.5);
  });

  it("returns at most k pairs, 5 by default", () => {
    const store = new EpisodicStore();
    for (let i = 0; i < 8; i++) store.add("same state", action(`Button ${i}`));
    expect(store.retrieve("same state")).toHaveLength(5);
    expect(store.retrieve("same state", 3)).toHaveLength(3);
  });

  it("returns newest pairs across states for a site-filtered recent fallback", () => {
    const store = new EpisodicStore();
    store.add("old state", action("Calendar", "link"));
    store.add("new state", action("Pick slot"));
    expect(store.recent(2).map((pair) => pair.action.label)).toEqual(["Pick slot", "Calendar"]);
  });

  it("evicts the least recently used pair beyond the cap (300 by default)", () => {
    const small = new EpisodicStore(3);
    small.add("s1", action("One"));
    small.add("s2", action("Two"));
    small.add("s3", action("Three"));
    small.add("s1", action("One")); // refreshes s1
    small.add("s4", action("Four")); // evicts s2
    expect(small.toJSON().pairs.map((p) => p.summary)).toEqual(["s3", "s1", "s4"]);
    const big = new EpisodicStore();
    for (let i = 0; i < 320; i++) big.add(`state ${i}`, action("Next"));
    expect(big.size).toBe(300);
    expect(big.retrieve("state 0").some((p) => p.summary === "state 0")).toBe(false);
  });

  it("round-trips through JSON", () => {
    const store = new EpisodicStore(10);
    store.add("s1", action("Send"));
    store.add("s1", action("Send"));
    const restored = EpisodicStore.fromJSON(JSON.parse(JSON.stringify(store)));
    expect(restored.toJSON()).toEqual(store.toJSON());
    expect(restored.predict("s1", candidates)).toEqual({ candidateId: "button:Send", confidence: 0.9 });
    expect(EpisodicStore.fromJSON(null).size).toBe(0);
  });

  it("never stores typed values", () => {
    const e = new TraceBuilder().at("/mail/3").input("Reply", "private words").events()[0]!;
    const store = new EpisodicStore();
    store.add("s", actionFromEvent(e)!);
    expect(JSON.stringify(store)).not.toContain("private words");
    expect(actionFromEvent(new TraceBuilder().navigate("/mail").events()[0]!)).toBeNull();
  });
});

describe("predictFromMemory", () => {
  it("is 0.75 after one observation and 0.9 after two or more", () => {
    const store = new EpisodicStore();
    store.add("s1", action("Pick slot"));
    expect(predictFromMemory("s1", candidates, store.retrieve("s1"))).toEqual({ candidateId: "button:Pick slot", confidence: 0.75 });
    store.add("s1", action("Pick slot"));
    store.add("s1", action("Pick slot"));
    expect(predictFromMemory("s1", candidates, store.retrieve("s1"))).toEqual({ candidateId: "button:Pick slot", confidence: 0.9 });
  });

  it("returns none for an unseen state, a merely similar state, or a target that is not on the page", () => {
    const store = new EpisodicStore();
    store.add("/mail/:id > a", action("Pick slot"));
    store.add("s2", action("Gone"));
    expect(predictFromMemory("s9", candidates, store.retrieve("s9"))).toEqual({ candidateId: "none", confidence: 0 });
    expect(predictFromMemory("/mail/:id > b", candidates, store.retrieve("/mail/:id > b")).candidateId).toBe("none");
    expect(predictFromMemory("s2", candidates, store.retrieve("s2")).candidateId).toBe("none");
  });

  it("falls back to a unique label match when signatures changed", () => {
    const memory = [{ summary: "s1", action: { ...action("send"), signature: "old-signature" }, count: 2 }];
    expect(predictFromMemory("s1", candidates, memory)).toEqual({ candidateId: "button:Send", confidence: 0.9 });
    const twins: NextCandidate[] = [...candidates, { id: "button:Send#2", kind: "button", label: "Send", locked: true }];
    expect(predictFromMemory("s1", twins, memory).candidateId).toBe("none");
  });

  it("prefers the most frequent action and stays below threshold on a tie", () => {
    const store = new EpisodicStore();
    store.add("s1", action("Send"));
    store.add("s1", action("Calendar", "link"));
    expect(store.predict("s1", candidates)).toEqual({ candidateId: "link:Calendar", confidence: 0.5 });
    store.add("s1", action("Send"));
    expect(store.predict("s1", candidates)).toEqual({ candidateId: "button:Send", confidence: 0.9 });
  });
});

describe("predictFromRecentSiteMemory", () => {
  it("uses the newest compatible action across states and strengthens a repeated habit", () => {
    const recent = [
      { summary: "new", action: action("Calendar", "link"), count: 1 },
      { summary: "older", action: action("Calendar", "link"), count: 1 },
      { summary: "oldest", action: action("Pick slot"), count: 9 },
    ];
    expect(predictFromRecentSiteMemory(candidates, recent)).toEqual({ candidateId: "link:Calendar", confidence: 0.8 });
    expect(predictFromRecentSiteMemory(candidates, recent.slice(0, 1))).toEqual({ candidateId: "link:Calendar", confidence: 0.65 });
    expect(predictFromRecentSiteMemory(candidates, [{ summary: "x", action: action("Gone"), count: 3 }])).toEqual({ candidateId: "none", confidence: 0 });
  });

  it("generalizes a recent action to a changing item in the same repeated result group", () => {
    const feed: NextCandidate[] = [
      { id: "new-video", kind: "link", label: "A title never seen before", locked: false, group: "LIST(video-feed)" },
      { id: "settings", kind: "button", label: "Settings", locked: false },
    ];
    const recent = [{ summary: "watch", action: { ...action("Old video", "link"), signature: "gone", targetShape: "LIST(video-feed)" }, count: 1 }];
    expect(predictFromRecentSiteMemory(feed, recent)).toEqual({ candidateId: "new-video", confidence: 0.65 });
  });
});

describe("rankNextCandidates", () => {
  const cold: NextCandidate[] = [
    { id: "logo", kind: "link", label: "Store home", locked: false },
    { id: "search", kind: "field", label: "Search products", locked: false },
    { id: "order", kind: "button", label: "Place your order", locked: true },
    { id: "carousel", kind: "link", label: "Carousel next slide", locked: false },
  ];

  it("chooses meaningful task controls on cold start and keeps a locked final action eligible", () => {
    expect(rankNextCandidates(cold).map((candidate) => candidate.id)).toEqual(["search", "order", "carousel", "logo"]);
  });

  it("moves from a search action into a changing result group and from play into viewing mode", () => {
    const results: NextCandidate[] = [
      { id: "search", kind: "field", label: "Search", locked: false },
      { id: "next-page", kind: "link", label: "Next page", locked: false, group: "LIST(pagination)" },
      { id: "filter", kind: "link", label: "Apply the filter Brand to narrow results", locked: false, group: "LIST(filters)" },
      { id: "promotion", kind: "link", label: "Buy More, Save More", locked: false, group: "LIST(filters)" },
      { id: "result", kind: "link", label: "Unseen result", locked: false, group: "LIST(results)" },
    ];
    expect(rankNextCandidates(results, { type: "input", label: "Search", signature: "search" })[0]?.id).toBe("result");
    const media: NextCandidate[] = [
      { id: "play", kind: "button", label: "Play", locked: false },
      { id: "full", kind: "button", label: "Full screen", locked: false },
    ];
    expect(rankNextCandidates(media, { type: "click", label: "Play", signature: "play" })[0]?.id).toBe("full");
  });

  it("ranks primary results above search accessory buttons", () => {
    const candidates: NextCandidate[] = [
      { id: "voice", kind: "button", label: "Search by voice", locked: false },
      { id: "image", kind: "button", label: "Search by image", locked: false },
      { id: "result", kind: "link", label: "A useful search result", locked: false, group: "LIST(results)" },
    ];
    expect(rankNextCandidates(candidates, { type: "input", label: "Search", signature: "search" })[0]?.id).toBe("result");
  });
});
