// Cold start, the gate every candidate passes before it is ever proposed (docs/cold-start.md section 5).
// Pure: no file system, no network, no AX. The caller has already read something; this decides whether any of it is
// allowed to become a fact. When in doubt it says sensitive, because a dropped fact costs one Tab and a stored one
// can cost a credential. Nothing here returns the offending value: reasons are codes, so a count can be shown
// ("23 items skipped as sensitive") without the report itself leaking what was skipped.
//
// The value shapes, the directive rules and the reason codes live in shared/src/facts/sensitivity.ts, because the
// graph enforces the SAME rule on the way in. This module adds what only a scan knows: what kind of container the
// candidate came out of, and what its file was called.
import { isSensitive } from "../sensitive";
import {
  MEDICAL_TERM,
  classifyFactSensitivity,
  looksLikeDirective,
  sensitiveValueShape,
  type SensitiveVerdict,
  type SkippedCounts,
} from "../facts/sensitivity";

/** What the candidate was read out of. The caller classifies the file; this module never touches a path. */
export type PathKind =
  | "contact-card"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "code"
  | "config"
  | "key"
  | "keychain"
  | "database"
  | "message"
  | "archive"
  | "image"
  | "unknown";

export interface ScanCandidate {
  pathKind: PathKind;
  /** Base name only. The caller strips directories: a full path is itself personal data. */
  fileName?: string;
  /** How the field was named where it was found ("work email", "SIN"). */
  label?: string;
  /** The candidate value. Never stored anywhere by this module. */
  value?: string;
  /** The user marked the containing folder private. */
  excludedFolder?: boolean;
  /** The line the value came from; scanned for key material and directives, never kept. */
  context?: string;
  /** Message sources are bodies unless the caller isolated the signature block (the only part we may read). */
  signatureBlock?: boolean;
}

const SAFE: SensitiveVerdict = { sensitive: false };

/** File names that are credentials by name alone: never opened, never proposed, whatever they contain. */
const CREDENTIAL_NAME =
  /^\.env(\.[\w-]+)?$|^\.?(npmrc|netrc|pgpass|htpasswd|aws|gnupg|ssh)$|(^|[._-])(credentials?|secrets?|passwords?|token|apikey|api[_-]key)([._-]|$)|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|\.(pem|key|p12|pfx|jks|keystore|asc|gpg|ppk|ovpn)$/i;
const KEYCHAIN_NAME = /\.(keychain|keychain-db|kdbx|kdb|1pif|agilekeychain|opvault|psafe3|enc)$/i;
const FINANCIAL_NAME =
  /(bank|account|credit[-_ ]?card|brokerage|investment)[-_ ]?statement|statement[-_ ]?\d|\b(t4|t4a|t5|1099|w-?2|w-?9|rrsp|401k)\b|tax[-_ ]?(return|slip|summary|\d{4})|pay[-_ ]?(slip|stub|check|cheque)|remittance|void(ed)?[-_ ]?che(que|ck)/i;
const HEALTH_NAME = /(medical|health|clinic|hospital|dental|pharmacy)[-_ ]?(record|report|result|note|bill)|lab[-_ ]?result|prescription|immuni[sz]ation|insurance[-_ ]?claim/i;
const IDENTITY_NAME = /passport|driver'?s?[-_ ]?licen[cs]e|birth[-_ ]?certificate|citizenship|green[-_ ]?card|permanent[-_ ]?resident|\b(ssn|sin)\b|national[-_ ]?id/i;

/** The file-name half. Exported so the native scanner can skip a file before opening it at all. */
export function sensitiveFileName(fileName: string): SensitiveVerdict | undefined {
  const name = fileName.trim();
  if (name === "") return undefined;
  if (CREDENTIAL_NAME.test(name)) return { sensitive: true, reason: "credential-file", detail: "name" };
  if (KEYCHAIN_NAME.test(name)) return { sensitive: true, reason: "credential-file", detail: "keychain" };
  if (FINANCIAL_NAME.test(name)) return { sensitive: true, reason: "financial-document", detail: "name" };
  if (HEALTH_NAME.test(name)) return { sensitive: true, reason: "health-document", detail: "name" };
  if (IDENTITY_NAME.test(name)) return { sensitive: true, reason: "identity-document", detail: "name" };
  return undefined;
}

/** Does this document's TEXT read like a financial or health record, whatever it is called? */
const FINANCIAL_TEXT =
  /\b(account (summary|statement|balance)|statement period|opening balance|closing balance|available balance|minimum payment|payment due|interest charged|deposits and credits|withdrawals and debits|sort code|iban|swift ?code|annual percentage rate)\b/i;

export function sensitiveDocumentText(text: string): SensitiveVerdict | undefined {
  const sample = text.slice(0, 8000);
  if (looksLikeDirective(sample)) return { sensitive: true, reason: "directive", detail: "instructions" };
  // One of these phrases can appear in prose; two of them is a statement.
  if (countMatches(sample, FINANCIAL_TEXT) >= 2) return { sensitive: true, reason: "financial-document", detail: "content" };
  if (countMatches(sample, MEDICAL_TERM) >= 2) return { sensitive: true, reason: "health-document", detail: "content" };
  const shape = sensitiveValueShape(sample);
  if (shape && (shape.reason === "key-material" || shape.reason === "card-number" || shape.reason === "government-id" || shape.reason === "bank-account")) return shape;
  return undefined;
}

function countMatches(text: string, re: RegExp): number {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  return [...text.matchAll(global)].length;
}

/** Always-sensitive containers: nothing inside them may ever become a fact. */
const SENSITIVE_PATH_KINDS: Partial<Record<PathKind, SensitiveVerdict>> = {
  key: { sensitive: true, reason: "credential-file", detail: "path-kind" },
  keychain: { sensitive: true, reason: "credential-file", detail: "path-kind" },
};

/** The one entry point: safe or sensitive, with a reason code. Called before anything is proposed. */
export function classifyCandidate(candidate: ScanCandidate): SensitiveVerdict {
  if (candidate.excludedFolder === true) return { sensitive: true, reason: "excluded-folder", detail: "user" };
  const byKind = SENSITIVE_PATH_KINDS[candidate.pathKind];
  if (byKind) return { ...byKind };
  if (candidate.pathKind === "message" && candidate.signatureBlock !== true) return { sensitive: true, reason: "message-body", detail: "body" };
  if (candidate.fileName) {
    const byName = sensitiveFileName(candidate.fileName);
    if (byName) return byName;
  }
  const label = candidate.label ?? "";
  if (label !== "" && isSensitive({ label, name: label })) return { sensitive: true, reason: "sensitive-label", detail: "label" };
  for (const text of [candidate.value, candidate.context]) {
    if (!text) continue;
    if (looksLikeDirective(text)) return { sensitive: true, reason: "directive", detail: "instructions" };
    const shape = sensitiveValueShape(text);
    if (shape) return shape;
  }
  return { ...SAFE };
}

/**
 * The same gate the graph applies on the way in (`classifyFactSensitivity`), reached from the scan side so a caller
 * that has a key and a value but no file can still screen it. Exported for the extractors.
 */
export function classifyCandidateFact(key: string, label: string, aliases: readonly string[], value: string): SensitiveVerdict {
  return classifyFactSensitivity(key, label, aliases, value);
}

export interface ScreenResult<T> {
  kept: T[];
  skipped: number;
  counts: SkippedCounts;
}

/**
 * Screen a batch, keeping what is safe and COUNTING what was not, per docs/cold-start.md section 5: the user is
 * shown "N items skipped as sensitive" so they can see the filter working, and never the items themselves.
 */
export function screenCandidates<T>(items: readonly T[], toCandidate: (item: T) => ScanCandidate): ScreenResult<T> {
  const kept: T[] = [];
  const counts: SkippedCounts = {};
  let skipped = 0;
  for (const item of items) {
    const verdict = classifyCandidate(toCandidate(item));
    if (!verdict.sensitive) {
      kept.push(item);
      continue;
    }
    skipped += 1;
    const reason = verdict.reason ?? "sensitive-label";
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return { kept, skipped, counts };
}

// `SensitiveReason`, `SkippedCounts`, `mergeSkippedCounts` and `totalSkipped` live with the value shapes in
// shared/src/facts/sensitivity.ts and are NOT re-exported here: the package keeps exactly one definition of each
// name, so `@ghost/shared` cannot hand two callers two different ideas of what counts as sensitive.
