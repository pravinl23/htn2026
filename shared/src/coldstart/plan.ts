// Cold start, the consent plan (docs/cold-start.md sections 2 and 4). Pure: this module reads NOTHING. It is handed
// a descriptor per source — what kind it is, how many items Spotlight counted, whether its permission is already
// granted, whether the user switched it on — and returns exactly what the first-run panel shows: the ordered list of
// sources, one plain sentence each, an estimate, and the hard caps the scanner must obey.
//
// Two rules are enforced here rather than trusted to the scanner:
//   - a source that is not switched on plans zero items (nothing is read before an explicit opt-in);
//   - a source whose permission is missing plans zero items and says what the user must click, never "skipped".

export type ColdStartSourceKind =
  | "spotlight"
  | "dock"
  | "login-items"
  | "recent-apps"
  | "recent-docs"
  | "app-inventory"
  | "contacts"
  | "resume"
  | "browser-history"
  | "calendar"
  | "mail"
  | "projects";

/**
 * The sources that describe WHAT THIS PERSON USES rather than who they are (docs/knowledge.md section 3). They are
 * the cheap half of tier 0: names and counts the machine already keeps, no dialog, nothing opened that is not a
 * list of application names. They are what makes a first run useful on a surface Ghost has never seen.
 */
export const SURFACE_SOURCES: readonly ColdStartSourceKind[] = [
  "dock",
  "login-items",
  "recent-apps",
  "recent-docs",
  "app-inventory",
  "browser-history",
];

/** True for a source that can be run unattended: it can raise no permission dialog on any Mac. */
export function isDialogFree(kind: ColdStartSourceKind): boolean {
  return PERMISSION_ACTION[kind] === "";
}

/** Not-required is Spotlight: metadata only, no dialog. Unknown means the capability check has not run yet. */
export type PermissionState = "not-required" | "granted" | "missing" | "unknown";

export interface SourceDescriptor {
  kind: ColdStartSourceKind;
  /** What a Spotlight COUNT found (files, rows, events, messages). Metadata only; unknown when the count has not run. */
  itemCount?: number;
  permission?: PermissionState;
  /** The user's switch for this source. Off (the default) means nothing is read. */
  enabled?: boolean;
}

export interface SourceCaps {
  /** Hard cap on items opened for this source in one scan. */
  maxItems: number;
  /** Hard cap on bytes read per item. Zero means the source reads no file content at all. */
  maxBytesPerItem: number;
}

export interface ColdStartBudget {
  /** Total wall clock for the whole scan. The plan trims sources so the estimate fits (docs section 4: default 60 s). */
  wallClockMs: number;
  /** Ceiling on any one source, so a huge history cannot eat the whole budget. */
  perSourceMs: number;
}

export const DEFAULT_BUDGET: ColdStartBudget = { wallClockMs: 60_000, perSourceMs: 25_000 };

export const SOURCE_TIER: Record<ColdStartSourceKind, number> = {
  spotlight: 0,
  dock: 0,
  "login-items": 0,
  "recent-apps": 0,
  "recent-docs": 0,
  "app-inventory": 0,
  contacts: 1,
  resume: 2,
  "browser-history": 3,
  calendar: 4,
  mail: 5,
  projects: 6,
};

/**
 * Ties inside a tier. Sorting by tier alone would leave the panel's order up to the caller's array; this pins it,
 * so the first-run list always reads the same way: what needs nothing, then what needs a click.
 */
export const SOURCE_ORDER: readonly ColdStartSourceKind[] = [
  "spotlight",
  "dock",
  "login-items",
  "recent-apps",
  "recent-docs",
  "app-inventory",
  "contacts",
  "resume",
  "browser-history",
  "calendar",
  "mail",
  "projects",
];

export const SOURCE_CAPS: Record<ColdStartSourceKind, SourceCaps> = {
  // Metadata only: names, kinds, dates. maxBytesPerItem 0 is the promise that no file is opened.
  spotlight: { maxItems: 50_000, maxBytesPerItem: 0 },
  // One preference file, read for its list of application names and nothing else.
  dock: { maxItems: 300, maxBytesPerItem: 4 * 1024 * 1024 },
  "login-items": { maxItems: 300, maxBytesPerItem: 1024 * 1024 },
  // Spotlight metadata: last-used dates and use counts. maxBytesPerItem 0 is the promise that nothing is opened.
  "recent-apps": { maxItems: 500, maxBytesPerItem: 0 },
  "recent-docs": { maxItems: 5_000, maxBytesPerItem: 0 },
  // An application bundle's own identifier file, which is a name and a version: never anything the app stores.
  "app-inventory": { maxItems: 1_000, maxBytesPerItem: 256 * 1024 },
  contacts: { maxItems: 1, maxBytesPerItem: 64 * 1024 },
  resume: { maxItems: 25, maxBytesPerItem: 2 * 1024 * 1024 },
  "browser-history": { maxItems: 20_000, maxBytesPerItem: 256 * 1024 * 1024 },
  calendar: { maxItems: 2_000, maxBytesPerItem: 16 * 1024 },
  // Header plus the last 10 lines of the user's OWN sent messages, never a conversation.
  mail: { maxItems: 500, maxBytesPerItem: 16 * 1024 },
  projects: { maxItems: 200, maxBytesPerItem: 256 * 1024 },
};

/** Rough per-item cost, measured in the same units the estimate is reported in. Plus a fixed setup cost per source. */
const COST_MS: Record<ColdStartSourceKind, { setup: number; perItem: number }> = {
  spotlight: { setup: 400, perItem: 0 },
  dock: { setup: 60, perItem: 0.2 },
  "login-items": { setup: 60, perItem: 0.5 },
  "recent-apps": { setup: 500, perItem: 1 },
  "recent-docs": { setup: 500, perItem: 0.05 },
  "app-inventory": { setup: 200, perItem: 3 },
  contacts: { setup: 250, perItem: 40 },
  resume: { setup: 200, perItem: 700 },
  "browser-history": { setup: 1_200, perItem: 0.05 },
  calendar: { setup: 300, perItem: 2 },
  mail: { setup: 600, perItem: 25 },
  projects: { setup: 200, perItem: 8 },
};

/** One plain sentence, shown next to the switch. Says what is read AND what is not. */
const READS: Record<ColdStartSourceKind, string> = {
  spotlight: "Counts files by name, kind and date so this list can show numbers. Opens nothing.",
  dock: "Reads the list of applications you keep in the Dock. Their names, nothing they hold.",
  "login-items": "Reads which applications start when you log in, by name.",
  "recent-apps": "Counts how recently and how often you used each application. Opens nothing.",
  "recent-docs": "Counts what KIND of document you opened recently (text, picture, sound). No names, no contents.",
  "app-inventory": "Lists the applications installed on this Mac by name, so one Ghost has never seen is still yours.",
  contacts: "Reads only your own contact card: name, emails, phones, addresses, employer and job title.",
  resume: "Opens up to 25 résumé-shaped documents and reads their text to find your education, work history and links.",
  "browser-history": "Copies your browser history, counts visits per site and time of day, then deletes the copy. No page titles or addresses are kept.",
  calendar: "Reads event metadata to work out your employer, timezone and working hours. No event contents are stored.",
  mail: "Reads the signature block of messages you sent and the shipping addresses in order confirmations. Never a conversation.",
  projects: "Reads git remotes and package author fields in your project folders to find your code accounts and personal site.",
};

const YIELDS: Record<ColdStartSourceKind, string> = {
  spotlight: "Which sources are worth opening, and the counts on this panel",
  dock: "The places you keep at hand",
  "login-items": "The places your day starts in",
  "recent-apps": "Which places you actually use, and how recently",
  "recent-docs": "What kind of screen you spend your time on",
  "app-inventory": "Places Ghost can recognise the first time you open them",
  contacts: "Name, emails, phones, addresses, employer, job title",
  resume: "Education, work history, links, skills",
  "browser-history": "Habits: which sites, in what order, at what hours",
  calendar: "Employer, colleagues, working hours, timezone",
  mail: "Work title, employer, phone, the addresses you really use",
  projects: "Code account, personal site, organisation",
};

/** What the user must click. Never triggered from code: the native side reports the state, this reports the words. */
const PERMISSION_ACTION: Record<ColdStartSourceKind, string> = {
  spotlight: "",
  // These read a preference file or an application's own name. When one is not readable the grant is the same
  // one résumé documents need; on a normal Mac none of them asks for anything.
  dock: "",
  "login-items": "",
  "recent-apps": "",
  "recent-docs": "",
  "app-inventory": "",
  contacts: "Contacts — System Settings › Privacy & Security › Contacts, then Ghost",
  resume: "Files and Folders — System Settings › Privacy & Security › Files and Folders, then Ghost",
  // Chromium profiles sit under Application Support (Files and Folders); only Safari's history needs Full Disk Access.
  "browser-history": "Files and Folders for Chrome, Arc or Brave — or Full Disk Access for Safari — in System Settings › Privacy & Security",
  calendar: "Calendars — System Settings › Privacy & Security › Calendars, then Ghost",
  mail: "Full Disk Access (or connect a mail account) — System Settings › Privacy & Security › Full Disk Access",
  projects: "Files and Folders — System Settings › Privacy & Security › Files and Folders, then Ghost",
};

/** Shown once, above the switches: the things cold start never reads, whatever is switched on. */
export const NEVER_READ: readonly string[] = [
  "Passwords, keys and anything in a keychain or password manager",
  "Bank, card, tax and other financial documents",
  "Health records and government ID numbers",
  "The body of any message — only your own signature block",
  "Anything in a folder you mark private",
];

export type PlannedStatus = "ready" | "off" | "needs-permission" | "empty";

export interface PlannedSource {
  kind: ColdStartSourceKind;
  tier: number;
  reads: string;
  yields: string;
  status: PlannedStatus;
  /** What Spotlight counted, before caps. Undefined when no count has run. */
  itemCount?: number;
  /** What this scan will actually open: 0 unless the source is on, permitted and non-empty. */
  plannedItems: number;
  estimatedMs: number;
  caps: SourceCaps;
  permission: PermissionState;
  /** Present exactly when status is "needs-permission": "needs permission: <what to click>". */
  needsPermission?: string;
  /** True when the wall-clock budget, not the source cap, is what limited plannedItems. */
  trimmedByBudget: boolean;
  /** True when the source cap limited plannedItems. */
  trimmedByCap: boolean;
}

export interface ConsentPlan {
  sources: PlannedSource[];
  budget: ColdStartBudget;
  totals: {
    enabledSources: number;
    plannedItems: number;
    estimatedMs: number;
    sourcesNeedingPermission: number;
  };
  /** Kinds the user must grant something for, in tier order. Listed honestly, never silently dropped. */
  needsPermission: ColdStartSourceKind[];
  neverRead: readonly string[];
}

export interface PlanOptions {
  budget?: Partial<ColdStartBudget>;
  /** Per-kind cap overrides, for a user who wants a bigger or smaller scan. Never raised above the defaults here. */
  caps?: Partial<Record<ColdStartSourceKind, Partial<SourceCaps>>>;
}

export function needsPermissionText(kind: ColdStartSourceKind): string {
  const action = PERMISSION_ACTION[kind];
  return action === "" ? "" : `needs permission: ${action}`;
}

function capsFor(kind: ColdStartSourceKind, options: PlanOptions): SourceCaps {
  const base = SOURCE_CAPS[kind];
  const override = options.caps?.[kind];
  return {
    maxItems: clampCap(override?.maxItems, base.maxItems),
    maxBytesPerItem: clampCap(override?.maxBytesPerItem, base.maxBytesPerItem),
  };
}

/** An override may lower a cap; it may never raise one. The defaults are the promise made on the consent panel. */
function clampCap(override: number | undefined, ceiling: number): number {
  if (typeof override !== "number" || !Number.isFinite(override) || override < 0) return ceiling;
  return Math.min(ceiling, Math.floor(override));
}

function estimate(kind: ColdStartSourceKind, items: number): number {
  const cost = COST_MS[kind];
  return items <= 0 ? 0 : Math.round(cost.setup + cost.perItem * items);
}

/** How many items fit in `budgetMs`, inverting the estimate. Zero when even the setup does not fit. */
function itemsWithin(kind: ColdStartSourceKind, items: number, budgetMs: number): number {
  const cost = COST_MS[kind];
  if (budgetMs <= cost.setup) return 0;
  if (cost.perItem <= 0) return items;
  return Math.max(0, Math.min(items, Math.floor((budgetMs - cost.setup) / cost.perItem)));
}

function permissionOf(descriptor: SourceDescriptor): PermissionState {
  if (descriptor.kind === "spotlight") return "not-required";
  return descriptor.permission ?? "unknown";
}

/** Unknown is treated as missing for planning: the panel asks for the grant instead of promising a scan that fails. */
function permitted(state: PermissionState): boolean {
  return state === "granted" || state === "not-required";
}

/**
 * The consent panel, in data. Sources come back in tier order — cheapest and most precise first — so the panel reads
 * top to bottom exactly like the table in docs/cold-start.md section 2.
 */
export function buildConsentPlan(descriptors: readonly SourceDescriptor[], options: PlanOptions = {}): ConsentPlan {
  const budget: ColdStartBudget = {
    wallClockMs: positive(options.budget?.wallClockMs, DEFAULT_BUDGET.wallClockMs),
    perSourceMs: positive(options.budget?.perSourceMs, DEFAULT_BUDGET.perSourceMs),
  };
  const seen = new Set<ColdStartSourceKind>();
  const ordered = [...descriptors]
    .filter((d) => {
      if (!d || !(d.kind in SOURCE_TIER) || seen.has(d.kind)) return false;
      seen.add(d.kind);
      return true;
    })
    .sort((a, b) => SOURCE_TIER[a.kind] - SOURCE_TIER[b.kind] || SOURCE_ORDER.indexOf(a.kind) - SOURCE_ORDER.indexOf(b.kind));

  let remaining = budget.wallClockMs;
  const sources: PlannedSource[] = [];

  for (const descriptor of ordered) {
    const kind = descriptor.kind;
    const caps = capsFor(kind, options);
    const permission = permissionOf(descriptor);
    const counted = countOf(descriptor.itemCount);
    const row: PlannedSource = {
      kind,
      tier: SOURCE_TIER[kind],
      reads: READS[kind],
      yields: YIELDS[kind],
      status: "ready",
      ...(descriptor.itemCount === undefined ? {} : { itemCount: counted }),
      plannedItems: 0,
      estimatedMs: 0,
      caps,
      permission,
      trimmedByBudget: false,
      trimmedByCap: false,
    };

    // The sentence is attached whenever the grant is missing, whatever the STATUS is. A source that is switched
    // off, or that Ghost has no reader for yet, still has to say what the user would have to click — otherwise
    // "off" quietly hides a permission problem, which is exactly the silent skip docs/cold-start.md forbids.
    if (!permitted(permission)) {
      const sentence = needsPermissionText(kind);
      if (sentence !== "") row.needsPermission = sentence;
    }
    if (descriptor.enabled !== true) {
      row.status = "off";
      sources.push(row);
      continue;
    }
    if (!permitted(permission)) {
      row.status = "needs-permission";
      sources.push(row);
      continue;
    }
    if (descriptor.itemCount !== undefined && counted === 0) {
      row.status = "empty";
      sources.push(row);
      continue;
    }

    // No count yet (Spotlight has not run, or the source cannot be counted): plan for the cap.
    const wanted = descriptor.itemCount === undefined ? caps.maxItems : counted;
    const capped = Math.min(wanted, caps.maxItems);
    const allowance = Math.min(remaining, budget.perSourceMs);
    const affordable = itemsWithin(kind, capped, allowance);
    row.trimmedByCap = capped < wanted;
    row.trimmedByBudget = affordable < capped;
    row.plannedItems = affordable;
    row.estimatedMs = estimate(kind, affordable);
    row.status = affordable > 0 ? "ready" : "empty";
    remaining = Math.max(0, remaining - row.estimatedMs);
    sources.push(row);
  }

  const needsPermission = sources.filter((s) => s.status === "needs-permission").map((s) => s.kind);
  return {
    sources,
    budget,
    totals: {
      enabledSources: sources.filter((s) => s.status !== "off").length,
      plannedItems: sources.reduce((sum, s) => sum + s.plannedItems, 0),
      estimatedMs: sources.reduce((sum, s) => sum + s.estimatedMs, 0),
      sourcesNeedingPermission: needsPermission.length,
    },
    needsPermission,
    neverRead: NEVER_READ,
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function countOf(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** The plain-language summary under the switches, e.g. "3 sources, about 12 s, 2 need permission". */
export function describePlan(plan: ConsentPlan): string {
  const active = plan.sources.filter((s) => s.status === "ready").length;
  const seconds = Math.max(1, Math.round(plan.totals.estimatedMs / 1000));
  const parts = [`${active} source${active === 1 ? "" : "s"}`, `about ${seconds} s`];
  if (plan.totals.sourcesNeedingPermission > 0) parts.push(`${plan.totals.sourcesNeedingPermission} need permission`);
  return parts.join(", ");
}
