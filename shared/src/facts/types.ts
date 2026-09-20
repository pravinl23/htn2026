// The open fact graph (docs/profile-sources.md section 1).
//
// Ghost used to carry a résumé: 19 fixed keys. That is why it shone on a job form and went blank on a
// shipping address, a support ticket or a conference signup. A fact graph has no fixed key set: a fact is
// a dotted key, a value, a human label, the phrasings a form might use for it, and where it came from.
// Adding a fact teaches every form at once, because the mapper matches labels, never key names.
import type { FieldKind } from "../types";
import type { SensitiveReason, SkippedCounts } from "./sensitivity";

export type FactCategory =
  | "identity"
  | "contact"
  | "address"
  | "work"
  | "education"
  | "links"
  | "preferences"
  | "org"
  | "travel"
  | "finance-safe"
  | "other";

export const FACT_CATEGORIES: readonly FactCategory[] = [
  "identity",
  "contact",
  "address",
  "work",
  "education",
  "links",
  "preferences",
  "org",
  "travel",
  "finance-safe",
  "other",
];

/** Where a fact came from. Only the user's own sources: nothing is read without them connecting it. */
export type FactSource =
  | { kind: "user" } // typed or corrected by the user; always wins
  | { kind: "file"; name: string } // résumé, vCard, exported profile
  | { kind: "github"; login: string }
  | { kind: "website"; origin: string }
  | { kind: "mail"; connector: string } // signature blocks, order confirmations
  | { kind: "calendar"; connector: string }
  | { kind: "drive"; connector: string }
  | { kind: "observed"; origin: string }; // what the user typed into a form before

export type FactSourceKind = FactSource["kind"];

export interface Fact {
  /** Dotted and open-ended: "contact.email.work", "address.home.postalCode", "work.employer.current". */
  key: string;
  value: string;
  category: FactCategory;
  /** Human phrasing, used for matching and for the options page ("work email"). */
  label: string;
  /** Other phrasings a form might use ("business e-mail", "company email"). */
  aliases: string[];
  confidence: number;
  source: FactSource;
  /** Short, local-only snippet for the review UI. Never leaves the machine. */
  evidence?: string;
  updatedAt: string;
  /** True once the user accepts or types it. A verified fact is never overwritten by a scan. */
  verifiedByUser: boolean;
  /** Government ID, payment, health, credentials. Never matched, never sent, never auto-filled. */
  sensitive: boolean;
  /** Why it was classified sensitive, as a code. Present only on the sensitive facts the user typed themselves. */
  sensitiveReason?: SensitiveReason;
  /** Field kinds this fact can land in. Derived from the value when a source does not say. */
  kinds?: readonly FieldKind[];
}

/** One source the graph has read, and when. An id (`sourceId`), never a path and never a URL. */
export interface GraphSourceMeta {
  id: string;
  /** Day resolution: the file keeps no finer time than a date (docs/storage.md section 2). */
  lastScan: string;
}

/** The `meta` section of docs/storage.md: schema version, the source list, and what was skipped as sensitive. */
export interface GraphMeta {
  schema: number;
  /** Counts by reason. The items themselves are never kept, so this is all the user can be shown. */
  skipped: SkippedCounts;
  sources: GraphSourceMeta[];
}

/** The graph as it is stored: a plain object, so `chrome.storage.local` and a JSON file hold it as-is. */
export interface FactGraph {
  /** `FACT_SCHEMA_VERSION`. Older files are migrated on read, never rejected. */
  version: number;
  facts: Record<string, Fact>;
  /**
   * Proposals the user turned down, as "<hash>@<day>": an opaque hash of key+value so a rescan does not offer
   * them again, plus the day it was refused so the hash can expire. No value is kept.
   */
  rejected: string[];
  /** Absent in a version 1 file; `graphMeta()` defaults it. */
  meta?: GraphMeta;
  updatedAt: string;
}

/** A candidate fact, before the user has accepted it. Everything an extractor produces is a proposal. */
export interface FactProposal {
  key: string;
  value: string;
  source: FactSource;
  category?: FactCategory;
  label?: string;
  aliases?: string[];
  confidence?: number;
  evidence?: string;
  updatedAt?: string;
  kinds?: readonly FieldKind[];
  /**
   * The user accepted this proposal in the review list. The fact keeps its provenance (it still came from
   * GitHub, or from a résumé) but from now on it wins conflicts exactly as a typed fact does.
   */
  verifiedByUser?: boolean;
}

export type UpsertStatus =
  /** Stored as a new fact. */
  | "added"
  /** Replaced or refreshed an existing fact. */
  | "updated"
  /** The existing fact stays: the user verified it, or the incoming source is less trusted. */
  | "kept"
  /** The user turned this exact proposal down before. */
  | "rejected"
  /** Classified sensitive and not typed by the user: never stored. */
  | "sensitive"
  /** Malformed key, empty value, or past a size cap. */
  | "invalid";

export interface UpsertResult {
  graph: FactGraph;
  status: UpsertStatus;
  /** Short, value-free reason, for the options page and the tests. */
  reason: string;
  /** Present when the status is "sensitive": which rule refused it. */
  sensitiveReason?: SensitiveReason;
}

export interface ApplyResult {
  graph: FactGraph;
  added: number;
  updated: number;
  kept: number;
  rejected: number;
  /** Sensitive proposals that were dropped rather than stored. Counted, never kept. */
  sensitive: number;
  invalid: number;
  /** The sensitive drops broken down by reason code, for "N items skipped as sensitive". */
  skippedCounts: SkippedCounts;
}

/** One fact a field could take, ranked. `why` is value-free: it names the evidence, never the value. */
export interface FactMatch {
  key: string;
  confidence: number;
  why: string;
}
