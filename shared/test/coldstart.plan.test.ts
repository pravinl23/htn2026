import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET, NEVER_READ, SOURCE_CAPS, SOURCE_TIER,
  buildConsentPlan, describePlan, needsPermissionText,
} from "../src/coldstart";
import type { ColdStartSourceKind, ConsentPlan, PlannedSource, SourceDescriptor } from "../src/coldstart";

const on = (kind: ColdStartSourceKind, itemCount?: number, permission: SourceDescriptor["permission"] = "granted"): SourceDescriptor => ({
  kind,
  enabled: true,
  permission,
  ...(itemCount === undefined ? {} : { itemCount }),
});

function row(plan: ConsentPlan, kind: ColdStartSourceKind): PlannedSource {
  const found = plan.sources.find((s) => s.kind === kind);
  if (!found) throw new Error(`no planned source for ${kind}`);
  return found;
}

const ALL_KINDS: readonly ColdStartSourceKind[] = ["spotlight", "contacts", "resume", "browser-history", "calendar", "mail", "projects"];

describe("consent plan: order and shape", () => {
  it("orders sources by tier, cheapest and most precise first", () => {
    const plan = buildConsentPlan([on("mail", 100), on("contacts", 1), on("browser-history", 5_000), on("spotlight", 40_000)]);
    expect(plan.sources.map((s) => s.kind)).toEqual(["spotlight", "contacts", "browser-history", "mail"]);
  });

  it("gives every source a plain sentence about what it reads and what it yields", () => {
    const plan = buildConsentPlan(ALL_KINDS.map((kind) => on(kind, 10)));
    for (const source of plan.sources) {
      expect(source.reads.length).toBeGreaterThan(20);
      expect(source.yields.length).toBeGreaterThan(5);
      expect(source.tier).toBe(SOURCE_TIER[source.kind]);
    }
  });

  it("ignores duplicate descriptors, keeping the first", () => {
    const plan = buildConsentPlan([on("resume", 3), on("resume", 999)]);
    expect(plan.sources).toHaveLength(1);
    expect(row(plan, "resume").plannedItems).toBe(3);
  });

  it("ignores a kind it does not know", () => {
    const plan = buildConsentPlan([{ kind: "telepathy" as ColdStartSourceKind, enabled: true }, on("contacts", 1)]);
    expect(plan.sources.map((s) => s.kind)).toEqual(["contacts"]);
  });

  it("lists what is never read, whatever is switched on", () => {
    const plan = buildConsentPlan([on("resume", 5)]);
    expect(plan.neverRead).toBe(NEVER_READ);
    const text = plan.neverRead.join(" ").toLowerCase();
    for (const promise of ["password", "financial", "health", "message"]) expect(text).toContain(promise);
  });
});

describe("consent plan: opt in per source", () => {
  it("plans nothing at all for a source that is switched off", () => {
    const plan = buildConsentPlan([{ kind: "contacts", permission: "granted" }, { kind: "resume", enabled: false, itemCount: 12, permission: "granted" }]);
    for (const source of plan.sources) {
      expect(source.status).toBe("off");
      expect(source.plannedItems).toBe(0);
      expect(source.estimatedMs).toBe(0);
    }
    expect(plan.totals.plannedItems).toBe(0);
    expect(plan.totals.enabledSources).toBe(0);
  });

  it("counts only switched-on sources as enabled", () => {
    const plan = buildConsentPlan([on("contacts", 1), { kind: "mail", enabled: false }]);
    expect(plan.totals.enabledSources).toBe(1);
  });
});

describe("consent plan: permissions are reported, never assumed", () => {
  it("says what the user must click instead of skipping the source", () => {
    const plan = buildConsentPlan([on("contacts", 1, "missing")]);
    const contacts = row(plan, "contacts");
    expect(contacts.status).toBe("needs-permission");
    expect(contacts.plannedItems).toBe(0);
    expect(contacts.needsPermission).toContain("needs permission:");
    expect(contacts.needsPermission).toContain("System Settings");
  });

  it("treats an unknown permission as missing, so nothing is promised that would fail", () => {
    const plan = buildConsentPlan([on("calendar", 40, "unknown")]);
    expect(row(plan, "calendar").status).toBe("needs-permission");
  });

  it("needs no permission for Spotlight metadata", () => {
    const plan = buildConsentPlan([{ kind: "spotlight", enabled: true, itemCount: 12_000 }]);
    const spotlight = row(plan, "spotlight");
    expect(spotlight.permission).toBe("not-required");
    expect(spotlight.status).toBe("ready");
    expect(needsPermissionText("spotlight")).toBe("");
  });

  it("reads no file content for Spotlight: its per-item byte cap is zero", () => {
    expect(SOURCE_CAPS.spotlight.maxBytesPerItem).toBe(0);
  });

  it("lists every source needing permission, in tier order", () => {
    const plan = buildConsentPlan([on("mail", 10, "missing"), on("contacts", 1, "missing"), on("resume", 4)]);
    expect(plan.needsPermission).toEqual(["contacts", "mail"]);
    expect(plan.totals.sourcesNeedingPermission).toBe(2);
  });
});

describe("consent plan: hard caps", () => {
  it("caps files per source", () => {
    const plan = buildConsentPlan([on("resume", 400)]);
    const resume = row(plan, "resume");
    expect(resume.itemCount).toBe(400);
    expect(resume.plannedItems).toBe(SOURCE_CAPS.resume.maxItems);
    expect(resume.trimmedByCap).toBe(true);
  });

  it("carries the bytes-per-file cap for each source", () => {
    const plan = buildConsentPlan([on("resume", 3), on("mail", 10)]);
    expect(row(plan, "resume").caps.maxBytesPerItem).toBe(2 * 1024 * 1024);
    expect(row(plan, "mail").caps.maxBytesPerItem).toBe(16 * 1024);
  });

  it("lets an override lower a cap", () => {
    const plan = buildConsentPlan([on("resume", 400)], { caps: { resume: { maxItems: 5 } } });
    expect(row(plan, "resume").plannedItems).toBe(5);
  });

  it("never lets an override raise a cap above the promise on the panel", () => {
    const plan = buildConsentPlan([on("resume", 400)], { caps: { resume: { maxItems: 10_000, maxBytesPerItem: 1e12 } } });
    expect(row(plan, "resume").caps.maxItems).toBe(SOURCE_CAPS.resume.maxItems);
    expect(row(plan, "resume").caps.maxBytesPerItem).toBe(SOURCE_CAPS.resume.maxBytesPerItem);
  });

  it("plans for the cap when nothing has been counted yet", () => {
    const plan = buildConsentPlan([{ kind: "projects", enabled: true, permission: "granted" }]);
    const projects = row(plan, "projects");
    expect(projects.itemCount).toBeUndefined();
    expect(projects.plannedItems).toBe(SOURCE_CAPS.projects.maxItems);
  });

  it("marks a counted-but-empty source empty rather than ready", () => {
    const plan = buildConsentPlan([on("resume", 0)]);
    expect(row(plan, "resume").status).toBe("empty");
    expect(row(plan, "resume").plannedItems).toBe(0);
  });
});

describe("consent plan: wall clock", () => {
  it("keeps the whole estimate inside the wall-clock budget", () => {
    const plan = buildConsentPlan(ALL_KINDS.map((kind) => on(kind, 50_000)));
    expect(plan.totals.estimatedMs).toBeLessThanOrEqual(DEFAULT_BUDGET.wallClockMs);
  });

  it("trims a later source when the budget runs out, and says the budget did it", () => {
    const plan = buildConsentPlan([on("resume", 25), on("projects", 200)], { budget: { wallClockMs: 4_000 } });
    expect(plan.totals.estimatedMs).toBeLessThanOrEqual(4_000);
    const trimmed = plan.sources.filter((s) => s.trimmedByBudget);
    expect(trimmed.length).toBeGreaterThan(0);
  });

  it("never lets one source eat the whole budget", () => {
    const plan = buildConsentPlan([on("mail", 500)], { budget: { wallClockMs: 60_000, perSourceMs: 3_000 } });
    expect(row(plan, "mail").estimatedMs).toBeLessThanOrEqual(3_000);
  });

  it("falls back to the default budget for a nonsense one", () => {
    const plan = buildConsentPlan([on("contacts", 1)], { budget: { wallClockMs: -5 } });
    expect(plan.budget.wallClockMs).toBe(DEFAULT_BUDGET.wallClockMs);
  });

  it("summarizes the plan in one line", () => {
    const plan = buildConsentPlan([on("contacts", 1), on("resume", 4), on("calendar", 100, "missing")]);
    const text = describePlan(plan);
    expect(text).toMatch(/^2 sources, about \d+ s, 1 need permission$/);
  });
});
