// The surface half of cold start: observations from what the machine already keeps become counters, and nothing
// in the code may behave differently because of WHICH place an id names.
//
// Every id in this file is deliberately meaningless (`aaaa.test`, `app:a.b.c`). If a test needed a real site or a
// real application to make its point, the code under test would be overfitted, which is the whole thing this
// module exists to prevent.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_PREFIX,
  DEFAULT_MAX_SURFACES,
  aggregateSurfaces,
  hourBucketIndex,
  impliedActionForKind,
  isAppSurface,
  normalizeSurfaceId,
} from "../src/coldstart/surfaces";
import type { SurfaceObservation } from "../src/coldstart/surfaces";
import { LOCKED_ROLES } from "../src/affordance/roles";

function used(surface: string, extra: Partial<SurfaceObservation> = {}): SurfaceObservation {
  return { surface, source: "recent-apps", visits: 1, ...extra };
}

describe("an id is a token, not a name", () => {
  it("reduces a URL, an origin and a bare host to the same token", () => {
    expect(normalizeSurfaceId("https://aaaa.test/one/two?q=3#x")).toBe("aaaa.test");
    expect(normalizeSurfaceId("http://www.aaaa.test:8443")).toBe("aaaa.test");
    expect(normalizeSurfaceId("AAAA.test")).toBe("aaaa.test");
  });

  it("keeps an application id behind its prefix and lowercases it", () => {
    expect(normalizeSurfaceId("app:A.B.CD")).toBe("app:a.b.cd");
    expect(isAppSurface(normalizeSurfaceId("app:a.b.cd"))).toBe(true);
    expect(isAppSurface(normalizeSurfaceId("aaaa.test"))).toBe(false);
  });

  it("refuses anything that is not one of those two shapes", () => {
    for (const bad of ["", "   ", "/Users/somebody/thing", "app:", "app:has space", "app:/slash", "not a host", "app:" + "x".repeat(200)]) {
      expect(normalizeSurfaceId(bad), bad).toBe("");
    }
  });

  it("never lets a path or a document name through as an id", () => {
    expect(normalizeSurfaceId("file:///Users/x/Documents/thing.pdf")).toBe("");
    expect(normalizeSurfaceId("~/Downloads/a.docx")).toBe("");
  });

  it("maps an hour to one of six four-hour buckets and nothing finer", () => {
    expect([0, 3, 4, 7, 8, 11, 12, 15, 16, 19, 20, 23].map(hourBucketIndex)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect(hourBucketIndex(-1)).toBe(5);
    expect(hourBucketIndex(Number.NaN)).toBe(0);
  });
});

describe("observations fold into counters", () => {
  it("adds two sources that saw the same place into one stronger record", () => {
    const aggregate = aggregateSurfaces([
      used("app:a.b.c", { source: "dock", visits: 1 }),
      used("app:a.b.c", { source: "recent-apps", visits: 40, hours: [9, 9, 10] }),
    ]);
    expect(aggregate.surfaces).toHaveLength(1);
    const record = aggregate.surfaces[0]!;
    expect(record.visits).toBe(41);
    expect(record.sources).toEqual(["dock", "recent-apps"]);
    expect(record.hourBuckets).toEqual([2]);
    expect(aggregate.bySource.dock?.surfaces).toBe(1);
    expect(aggregate.bySource["recent-apps"]?.visits).toBe(40);
  });

  it("counts a place the person merely owns as a surface and never as a habit", () => {
    const aggregate = aggregateSurfaces([used("app:d.e.f", { source: "app-inventory", installedOnly: true })]);
    const record = aggregate.surfaces[0]!;
    expect(record.installedOnly).toBe(true);
    expect(record.visits).toBe(0);
    expect(Object.keys(record.actions)).toEqual([]);
  });

  it("stops owning from outranking using when the cap bites", () => {
    const observations: SurfaceObservation[] = [];
    for (let i = 0; i < DEFAULT_MAX_SURFACES + 50; i += 1) {
      observations.push(used(`app:x.y.n${i}`, { source: "app-inventory", installedOnly: true }));
    }
    observations.push(used("app:z.z.z", { source: "recent-apps", visits: 3 }));
    const aggregate = aggregateSurfaces(observations);
    expect(aggregate.surfaces).toHaveLength(DEFAULT_MAX_SURFACES);
    expect(aggregate.capped).toBe(51);
    expect(aggregate.surfaces[0]!.surface).toBe("app:z.z.z");
  });

  it("drops an observation whose id does not reduce, and counts the drop", () => {
    const aggregate = aggregateSurfaces([used("not a host"), used("aaaa.test")]);
    expect(aggregate.dropped).toBe(1);
    expect(aggregate.surfaces.map((s) => s.surface)).toEqual(["aaaa.test"]);
  });

  it("keeps time at four-hour resolution and days at day resolution", () => {
    const aggregate = aggregateSurfaces([used("aaaa.test", { hours: [8, 9, 21], lastUsedDaysAgo: 2.7 })]);
    const record = aggregate.surfaces[0]!;
    expect(record.hourBuckets).toEqual([2, 5]);
    expect(record.lastUsedDaysAgo).toBe(2);
    expect(JSON.stringify(record)).not.toMatch(/\d{2}:\d{2}/);
  });

  it("caps a broken visit counter instead of letting it swamp everything", () => {
    const aggregate = aggregateSurfaces([used("aaaa.test", { visits: 9e15 }), used("bbbb.test", { visits: 5 })]);
    expect(aggregate.surfaces[0]!.visits).toBe(10_000);
  });
});

describe("a kind implies an action, and never an irreversible one", () => {
  it("gives a used surface its kind's implied action when the source knew no better", () => {
    const aggregate = aggregateSurfaces([used("aaaa.test", { kind: "feed", visits: 6 })]);
    expect(Object.keys(aggregate.surfaces[0]!.actions)).toEqual(["primary-item"]);
  });

  it("never implies a locked action for any kind", () => {
    for (const kind of ["feed", "media", "commerce", "reader", "mail", "form", "app", "unknown"] as const) {
      const implied = impliedActionForKind(kind);
      if (implied) expect(LOCKED_ROLES).not.toContain(implied);
    }
  });

  it("prefers what a source actually observed over the implied action", () => {
    const aggregate = aggregateSurfaces([
      used("aaaa.test", { kind: "feed", visits: 6, actions: [{ role: "search", count: 4 }] }),
    ]);
    expect(aggregate.surfaces[0]!.actions).toEqual({ search: 4 });
  });
});

describe("transitions", () => {
  it("counts a transition only when both ends survived", () => {
    const aggregate = aggregateSurfaces(
      [used("aaaa.test", { visits: 4 }), used("bbbb.test", { visits: 4 })],
      [
        { from: "https://aaaa.test/x", to: "bbbb.test", count: 3 },
        { from: "aaaa.test", to: "cccc.test", count: 9 },
        { from: "aaaa.test", to: "aaaa.test", count: 5 },
      ],
    );
    expect(aggregate.transitions).toEqual([{ from: "aaaa.test", to: "bbbb.test", count: 3 }]);
  });
});

describe("the summary can describe without naming", () => {
  it("says how much Ghost knows in kinds and counts only", () => {
    const aggregate = aggregateSurfaces([
      used("aaaa.test", { kind: "feed", visits: 20, hours: [9] }),
      used("bbbb.test", { kind: "feed", visits: 12, hours: [9] }),
      used("cccc.test", { kind: "media", visits: 30, hours: [9] }),
      used("app:g.h.i", { source: "app-inventory", installedOnly: true }),
    ]);
    const text = aggregate.summary.join(" ");
    expect(text).toContain("3 places you actually use");
    expect(text).toContain("1 more you have");
    for (const record of aggregate.surfaces) expect(text).not.toContain(record.surface);
  });
});

// The same mechanical check the knowledge layer makes on itself: a source file that names a place is a bug, not
// a style question. It scans the module and this test, so a fixture cannot sneak one in either.
const HOST_SHAPED = /\b[a-z0-9][a-z0-9-]{1,}\.(com|net|org|io|co|tv|fm|gg|ai|dev|xyz|me)\b/i;
const BUNDLE_SHAPED = /\b(com|org|net|io)\.[a-z][a-z0-9]*\.[a-z][a-z0-9]*/i;

describe("nothing in the surface layer names a place", () => {
  const SRC = join(__dirname, "..", "src", "coldstart");
  // Every file that decides how a SURFACE behaves, not only the two this test is about: a per-site rule is a bug
  // wherever it appears, and the cheapest place to catch one is before it is written twice.
  //
  // `extract.ts` is deliberately not on this list. It maps a code-hosting remote to a FACT key ("this remote means
  // your code-account login"), which is a data-format mapping and not a rule about what to propose on a screen.
  // Nothing it names ever reaches a surface id, a habit or a ranking.
  const BEHAVIOUR = ["surfaces.ts", "graph.ts", "habits.ts", "plan.ts", "index.ts", "sensitiveScan.ts"];
  const files = readdirSync(SRC)
    .filter((file) => BEHAVIOUR.includes(file))
    .map((file) => ({ name: `src/coldstart/${file}`, text: readFileSync(join(SRC, file), "utf8") }));
  const tests = readdirSync(__dirname)
    .filter((file) => file.startsWith("coldstart.surfaces") || file.startsWith("coldstart.graph"))
    .map((file) => ({ name: `test/${file}`, text: readFileSync(join(__dirname, file), "utf8") }));

  it("finds no host-shaped string", () => {
    for (const file of [...files, ...tests]) expect(HOST_SHAPED.test(file.text), file.name).toBe(false);
  });

  it("finds no bundle-shaped string", () => {
    for (const file of [...files, ...tests]) expect(BUNDLE_SHAPED.test(file.text), file.name).toBe(false);
  });

  it("uses the prefix as the only thing that distinguishes a native place from a web one", () => {
    expect(APP_PREFIX).toBe("app:");
  });
});
