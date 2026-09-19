// Gating: Ghost proposes the next step the page would actually accept, and nothing further.
// A Submit ghost that appears while two required dropdowns are empty is worse than no ghost:
// it implies the form is finished when the page would reject it (docs/incremental.md).
import { isLockedAction } from "../locks";
import type { CapturedField, Ghost } from "../types";
import { isFilled } from "./filled";
import { displayLabel, isRequired, type RequiredEvidence } from "./required";

/** Reading things: "Continue reading" ends nothing. */
const READING = /\b(continue reading|read more|next (article|photo|image|slide|song|track|video|result))/i;
/** A step advance leaves the current page, so it is terminal for this step (docs/incremental.md section 2 rule 6). */
const STEP =
  /^(continue|next|next step|proceed|save (and|&) (continue|next|proceed)|go (to|on) (the )?next|review (and|&) (submit|continue)|start (my |your )?application)\b/i;

/** A ghost that may carry the client's record of the user having accepted it. */
export type GateGhost = Ghost & { accepted?: boolean };

export interface WalkGate {
  /** Signatures of required fields with no answer yet, in reading order. */
  unmetRequired: string[];
  /** False when at least one terminal action on the page has to be withheld. */
  terminalAllowed: boolean;
  /** Why, for the HUD: "2 required fields still empty". Set whenever something is unmet, terminal or not. */
  reason?: string;
  /** The label of the first unmet required field, marker stripped: what the jump pill points at. */
  firstUnmetLabel?: string;
  /** Terminal actions that must not be proposed yet, in reading order. */
  blockedTerminals: string[];
  /** Terminal actions the page would accept right now, in reading order. */
  allowedTerminals: string[];
}

export interface GateOptions {
  /** Signatures of ghosts the user has already accepted, before the page has been rescanned. */
  accepted?: Iterable<string>;
  /** Extra requiredness evidence, keyed by field signature, for callers that cannot set it on the field. */
  evidence?: Readonly<Record<string, RequiredEvidence>>;
}

/**
 * An action that ends the form or the step: submit, send, pay, place order, confirm, continue, next.
 * A locked DATA field (a consent checkbox that needs a deliberate Tab) is still a field to answer, not a step,
 * so only action controls qualify.
 */
export function isTerminalAction(field: CapturedField): boolean {
  const actionable = field.kind === "button" || field.kind === "link";
  if (!actionable) return field.kind === "other" && field.locked === true;
  if (field.locked === true) return true;
  const text = field.label;
  if (READING.test(text)) return false;
  return isLockedAction({ text, buttonType: field.inputType }) || STEP.test(text.trim());
}

/**
 * Walk the fields in reading order and decide what may still be proposed.
 * A required field is met when the page already holds an answer, or when the user has ACCEPTED a ghost for it;
 * a pending ghost meets nothing (docs/incremental.md section 3), so holding Tab can never unlock Submit through a guess.
 * Fields are expected in capture order, which is document order; ghosts for fields that are gone are ignored.
 */
export function gateWalk(fields: readonly CapturedField[], ghosts: readonly GateGhost[], options?: GateOptions): WalkGate {
  const accepted = new Set<string>(options?.accepted ?? []);
  for (const ghost of ghosts) if (ghost.accepted === true) accepted.add(ghost.signature);

  const unmetRequired: string[] = [];
  const blockedTerminals: string[] = [];
  const allowedTerminals: string[] = [];
  let firstUnmetLabel: string | undefined;

  for (const field of fields) {
    if (isTerminalAction(field)) {
      // Only the required fields BEFORE it in reading order can block it.
      (unmetRequired.length === 0 ? allowedTerminals : blockedTerminals).push(field.signature);
      continue;
    }
    if (!isRequired(field, options?.evidence?.[field.signature])) continue; // optional fields never gate anything
    if (isFilled(field) || accepted.has(field.signature)) continue;
    unmetRequired.push(field.signature);
    if (firstUnmetLabel === undefined) firstUnmetLabel = displayLabel(field);
  }

  const gate: WalkGate = {
    unmetRequired,
    terminalAllowed: blockedTerminals.length === 0,
    blockedTerminals,
    allowedTerminals,
  };
  if (unmetRequired.length > 0) {
    gate.reason = `${unmetRequired.length} required field${unmetRequired.length === 1 ? "" : "s"} still empty`;
    gate.firstUnmetLabel = firstUnmetLabel;
  }
  return gate;
}

/** Drop the ghosts for terminal actions the gate withholds. Everything else is untouched, in the same order. */
export function applyGate<T extends Ghost>(ghosts: readonly T[], gate: WalkGate): T[] {
  if (gate.blockedTerminals.length === 0) return [...ghosts];
  const blocked = new Set(gate.blockedTerminals);
  return ghosts.filter((ghost) => !blocked.has(ghost.signature));
}
