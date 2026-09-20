import { describe, expect, it } from "vitest";
import { DEFAULT_MIN_VISITS, OTHER_ORIGIN, aggregateHabits, bucketForHour, hostOfOrigin, pageKindFromPath } from "../src/coldstart";
import type { HabitAggregate, HistoryRow, OriginHabit } from "../src/coldstart";

// Fictional hosts and paths only: no history from a real machine ever enters this repo.
const MAIL = "https://mail.example";
const VIDEO = "https://video.example";
const SHOP = "https://shop.example";

const visit = (origin: string, at: string, pathPattern?: string, from?: string): HistoryRow => ({
  origin,
  visitedAt: at,
  ...(pathPattern === undefined ? {} : { pathPattern }),
  ...(from === undefined ? {} : { transitionFromOrigin: from }),
});

/** Monday to Tuesday mornings, plus a weekend evening. */
const ROWS: HistoryRow[] = [
  visit(`${MAIL}/inbox?q=unread`, "2026-03-02T08:10:00Z", "/inbox"),
  visit(`${MAIL}/inbox`, "2026-03-02T08:40:00Z", "/inbox"),
  visit(`${MAIL}/inbox`, "2026-03-03T09:05:00Z", "/inbox"),
  visit(`${MAIL}/inbox`, "2026-03-03T09:30:00Z", "/inbox"),
  visit(`${VIDEO}/watch?v=abc`, "2026-03-02T20:10:00Z", "/watch", MAIL),
  visit(`${VIDEO}/watch?v=def`, "2026-03-02T21:10:00Z", "/watch", MAIL),
  visit(`${VIDEO}/watch?v=ghi`, "2026-03-03T20:15:00Z", "/watch", MAIL),
  visit(`${VIDEO}/watch?v=jkl`, "2026-03-08T19:00:00Z", "/watch"),
  visit(`${SHOP}/cart`, "2026-03-07T14:00:00Z", "/cart"),
  visit(`${SHOP}/checkout`, "2026-03-07T14:05:00Z", "/checkout"),
  visit(`${SHOP}/orders/123`, "2026-03-07T14:20:00Z", "/orders/:id"),
  visit("https://rare-clinic.example/booking/4821", "2026-03-04T11:00:00Z", "/booking/:id"),
  visit("https://one-off.example/page", "2026-03-05T11:00:00Z", "/page"),
];

function origin(aggregate: HabitAggregate, name: string): OriginHabit {
  const found = aggregate.origins.find((o) => o.origin === name);
  if (!found) throw new Error(`no origin ${name}: got ${aggregate.origins.map((o) => o.origin).join(", ")}`);
  return found;
}

/** Every string anywhere in the output, for the "nothing can be read back out" checks. */
function allStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const item of node) allStrings(item, out);
  else if (node && typeof node === "object") for (const v of Object.values(node)) allStrings(v, out);
  return out;
}

function allNumbers(node: unknown, out: number[] = []): number[] {
  if (typeof node === "number") out.push(node);
  else if (Array.isArray(node)) for (const item of node) allNumbers(item, out);
  else if (node && typeof node === "object") for (const v of Object.values(node)) allNumbers(v, out);
  return out;
}

describe("origins are reduced to bare hosts", () => {
  it("strips scheme, www, port, path, query and fragment", () => {
    expect(hostOfOrigin("https://www.Mail.example:8443/inbox?q=1#x")).toBe("mail.example");
    expect(hostOfOrigin("mail.example")).toBe("mail.example");
    expect(hostOfOrigin("https://user:pw@mail.example/")).toBe("mail.example");
  });

  it("returns nothing for something that is not a host", () => {
    for (const bad of ["", "   ", "localhost", "http://[::1]:3000", "file:///Users/someone/doc.pdf", "about:blank"]) {
      expect(hostOfOrigin(bad), bad).toBe("");
    }
  });
});

describe("page kind from a path", () => {
  it("recognizes the generic shapes", () => {
    expect(pageKindFromPath("/watch")).toBe("media");
    expect(pageKindFromPath("/cart")).toBe("commerce");
    expect(pageKindFromPath("/inbox")).toBe("mail");
    expect(pageKindFromPath("/apply/step-2")).toBe("form");
    expect(pageKindFromPath("/blog/:slug")).toBe("reader");
  });

  it("says unknown rather than guessing", () => {
    expect(pageKindFromPath("/x/y/z")).toBe("unknown");
    expect(pageKindFromPath(undefined)).toBe("unknown");
  });

  it("buckets an hour", () => {
    expect(bucketForHour(2)).toBe("night");
    expect(bucketForHour(8)).toBe("morning");
    expect(bucketForHour(12)).toBe("midday");
    expect(bucketForHour(16)).toBe("afternoon");
    expect(bucketForHour(22)).toBe("evening");
  });
});

describe("aggregation", () => {
  const aggregate = aggregateHabits(ROWS);

  it("counts visits per origin", () => {
    expect(origin(aggregate, "mail.example").visits).toBe(4);
    expect(origin(aggregate, "video.example").visits).toBe(4);
    expect(origin(aggregate, "shop.example").visits).toBe(3);
    expect(aggregate.totalVisits).toBe(13);
  });

  it("counts time-of-day buckets instead of keeping times", () => {
    expect(origin(aggregate, "mail.example").timeOfDay.morning).toBe(4);
    expect(origin(aggregate, "video.example").timeOfDay.evening).toBe(4);
  });

  it("splits weekday from weekend", () => {
    expect(origin(aggregate, "video.example").dayType).toEqual({ weekday: 3, weekend: 1 });
    expect(origin(aggregate, "shop.example").dayType).toEqual({ weekday: 0, weekend: 3 });
  });

  it("aggregates per inferred page kind too", () => {
    const kinds = Object.fromEntries(aggregate.pageKinds.map((k) => [k.kind, k.visits]));
    expect(kinds["mail"]).toBe(4);
    expect(kinds["media"]).toBe(4);
    expect(kinds["commerce"]).toBe(3);
  });

  it("records the kind each origin usually is", () => {
    expect(origin(aggregate, "mail.example").dominantKind).toBe("mail");
    expect(origin(aggregate, "shop.example").dominantKind).toBe("commerce");
  });

  it("sorts origins by how often they are visited", () => {
    expect(aggregate.origins[0]?.visits).toBeGreaterThanOrEqual(aggregate.origins[1]?.visits ?? 0);
  });

  it("returns an empty aggregate for no rows", () => {
    const empty = aggregateHabits([]);
    expect(empty.origins).toEqual([]);
    expect(empty.totalVisits).toBe(0);
    expect(empty.roleMemory.entries).toEqual([]);
    expect(empty.summary).toEqual([]);
  });

  it("applies the caller's timezone offset before bucketing", () => {
    const rows = [visit(MAIL, "2026-03-02T02:00:00Z", "/inbox"), visit(MAIL, "2026-03-02T02:30:00Z", "/inbox"), visit(MAIL, "2026-03-02T02:45:00Z", "/inbox")];
    expect(origin(aggregateHabits(rows), "mail.example").timeOfDay.night).toBe(3);
    expect(origin(aggregateHabits(rows, { timeZoneOffsetMinutes: 8 * 60 }), "mail.example").timeOfDay.morning).toBe(3);
  });
});

describe("rare origins", () => {
  const aggregate = aggregateHabits(ROWS);

  it("folds a host seen fewer than three times into one 'other' bucket", () => {
    expect(aggregate.minVisits).toBe(DEFAULT_MIN_VISITS);
    expect(aggregate.origins.some((o) => o.origin.includes("rare-clinic"))).toBe(false);
    expect(aggregate.origins.some((o) => o.origin.includes("one-off"))).toBe(false);
    expect(origin(aggregate, OTHER_ORIGIN).visits).toBe(2);
    expect(origin(aggregate, OTHER_ORIGIN).other).toBe(true);
  });

  it("counts how much went into the bucket, so the user can see the trade", () => {
    expect(aggregate.rareOrigins).toBe(2);
    expect(aggregate.rareVisits).toBe(2);
  });

  it("honours a stricter threshold", () => {
    const strict = aggregateHabits(ROWS, { minVisits: 5 });
    expect(strict.origins.map((o) => o.origin)).toEqual([OTHER_ORIGIN]);
    expect(origin(strict, OTHER_ORIGIN).visits).toBe(13);
  });

  it("never drops below a threshold of two, whatever the caller passes", () => {
    expect(aggregateHabits(ROWS, { minVisits: 1 }).minVisits).toBe(2);
    expect(aggregateHabits(ROWS, { minVisits: 0 }).minVisits).toBe(2);
  });

  it("folds everything past the origin cap into the same bucket, losing no visits", () => {
    const capped = aggregateHabits(ROWS, { maxOrigins: 1 });
    expect(capped.origins).toHaveLength(2);
    expect(capped.origins.reduce((sum, o) => sum + o.visits, 0)).toBe(13);
  });
});

describe("nothing can be read back out of the output", () => {
  const aggregate = aggregateHabits(ROWS);
  const strings = allStrings(aggregate);
  const json = JSON.stringify(aggregate);

  it("keeps no URL, path, query or fragment", () => {
    for (const s of strings) {
      expect(s, s).not.toMatch(/[/?#]/);
      expect(s, s).not.toContain("://");
    }
    for (const path of ["/inbox", "/watch", "/cart", "/orders/123", "/booking/4821", "q=unread", "v=abc"]) {
      expect(json, path).not.toContain(path);
    }
  });

  it("keeps no rarely-visited host, in any field", () => {
    for (const host of ["rare-clinic", "one-off"]) expect(json, host).not.toContain(host);
  });

  it("keeps no timestamp: only buckets survive", () => {
    for (const s of strings) expect(s, s).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{2}:\d{2}/);
    for (const n of allNumbers(aggregate)) expect(n).toBeLessThan(1_000_000);
  });

  it("keeps no page title, because none is ever taken in", () => {
    expect(json.toLowerCase()).not.toContain("title");
  });

  it("summarizes habits in words that name no site", () => {
    expect(aggregate.summary.length).toBeGreaterThan(0);
    for (const line of aggregate.summary) {
      expect(line).not.toContain("example");
      expect(line).toMatch(/^(You|After) /);
      expect(line).toMatch(/\.$/);
    }
  });
});

describe("transitions", () => {
  const aggregate = aggregateHabits(ROWS);

  it("counts origin-to-origin moves", () => {
    const mailToVideo = aggregate.transitions.find((t) => t.from === "mail.example" && t.to === "video.example");
    expect(mailToVideo?.count).toBe(3);
  });

  it("drops a move that stays on the same site", () => {
    const rows = [visit(SHOP, "2026-03-07T14:00:00Z", "/cart", SHOP), ...ROWS];
    expect(aggregateHabits(rows).transitions.some((t) => t.from === t.to)).toBe(false);
  });

  it("folds a rare end of a transition into the other bucket", () => {
    const rows = [...ROWS, visit(MAIL, "2026-03-09T08:00:00Z", "/inbox", "https://rare-clinic.example/booking/4821")];
    const transitions = aggregateHabits(rows).transitions;
    expect(transitions.some((t) => t.from === OTHER_ORIGIN && t.to === "mail.example")).toBe(true);
    expect(JSON.stringify(transitions)).not.toContain("rare-clinic");
  });

  it("caps how many transitions are kept", () => {
    expect(aggregateHabits(ROWS, { maxTransitions: 1 }).transitions).toHaveLength(1);
  });

  it("derives kind-to-kind transitions, which are what transfer to a new site", () => {
    const kindTransition = aggregate.kindTransitions.find((t) => t.from === "mail" && t.to === "media");
    expect(kindTransition?.count).toBe(3);
  });
});

describe("actions after arrival", () => {
  const rows: HistoryRow[] = [
    { origin: VIDEO, pathPattern: "/watch", visitedAt: "2026-03-02T20:00:00Z", actionsAfterArrival: [{ role: "play" }, { role: "fullscreen", previousRole: "play" }] },
    { origin: VIDEO, pathPattern: "/watch", visitedAt: "2026-03-03T20:00:00Z", actionsAfterArrival: [{ role: "play" }, { role: "fullscreen", previousRole: "play" }] },
    { origin: VIDEO, pathPattern: "/watch", visitedAt: "2026-03-04T20:00:00Z", actionsAfterArrival: [{ role: "play" }, { role: "captions", previousRole: "play", outcome: "dismissed" }] },
  ];
  const aggregate = aggregateHabits(rows);

  it("counts the roles taken per origin and per kind", () => {
    expect(origin(aggregate, "video.example").actions["play"]).toBe(3);
    expect(aggregate.pageKinds.find((k) => k.kind === "media")?.actions["fullscreen"]).toBe(2);
  });

  it("produces the role-keyed memory shape the ranker already uses", () => {
    const entry = aggregate.roleMemory.entries.find((e) => e.role === "fullscreen");
    expect(entry).toMatchObject({ pageKind: "media", previousRole: "play", role: "fullscreen" });
    expect(entry?.stat).toEqual({ accepted: 2, dismissed: 0, replaced: 0 });
  });

  it("records the first action of a view under the 'none' previous role", () => {
    const entry = aggregate.roleMemory.entries.find((e) => e.role === "play");
    expect(entry?.previousRole).toBe("none");
    expect(entry?.stat.accepted).toBe(3);
  });

  it("records a refusal as a refusal, so a bad habit is not learned", () => {
    const entry = aggregate.roleMemory.entries.find((e) => e.role === "captions");
    expect(entry?.stat).toEqual({ accepted: 0, dismissed: 1, replaced: 0 });
  });

  it("respects a count on an action, and caps a silly one", () => {
    const counted = aggregateHabits([
      { origin: VIDEO, pathPattern: "/watch", visitedAt: "2026-03-02T20:00:00Z", actionsAfterArrival: [{ role: "next", count: 4 }] },
      { origin: VIDEO, pathPattern: "/watch", visitedAt: "2026-03-03T20:00:00Z", actionsAfterArrival: [{ role: "next", count: 10_000 }] },
      { origin: VIDEO, pathPattern: "/watch", visitedAt: "2026-03-04T20:00:00Z", actionsAfterArrival: [{ role: "next", count: -3 }] },
    ]);
    expect(origin(counted, "video.example").actions["next"]).toBe(54);
  });

  it("holds no role memory when the caller supplies no actions", () => {
    expect(aggregateHabits(ROWS).roleMemory.entries).toEqual([]);
  });
});

describe("malformed rows", () => {
  it("drops and counts a row with an unusable origin or timestamp", () => {
    const rows = [
      ...ROWS,
      visit("file:///Users/someone/Documents/secret.pdf", "2026-03-02T08:00:00Z", "/x"),
      visit("about:blank", "2026-03-02T08:00:00Z"),
      visit(MAIL, "not a date", "/inbox"),
      { origin: MAIL, visitedAt: Number.NaN, pathPattern: "/inbox" },
    ];
    const aggregate = aggregateHabits(rows);
    expect(aggregate.droppedRows).toBe(4);
    expect(aggregate.rows).toBe(13);
    expect(JSON.stringify(aggregate)).not.toContain("secret");
  });

  it("accepts epoch milliseconds as well as an ISO string", () => {
    const at = Date.parse("2026-03-02T08:10:00Z");
    const aggregate = aggregateHabits([visit(MAIL, "2026-03-02T08:10:00Z", "/inbox"), { origin: MAIL, visitedAt: at, pathPattern: "/inbox" }, { origin: MAIL, visitedAt: at, pathPattern: "/inbox" }]);
    expect(origin(aggregate, "mail.example").visits).toBe(3);
  });
});
