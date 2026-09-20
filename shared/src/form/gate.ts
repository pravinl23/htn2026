// Gating: Shabang proposes the next step the page would actually accept, and nothing further.
// A Submit ghost that appears while two required dropdowns are empty is worse than no ghost:
// it implies the form is finished when the page would reject it (docs/incremental.md).
import { isLockedAction } from "../locks";
import type { CapturedField, Shabang } from "../types";
import { isDefinitelyEmpty, isFilled } from "./filled";
import { displayLabel, isRequired, type RequiredEvidence } from "./required";

/** Reading things: "Continue reading" ends nothing. */
const READING = /\b(continue reading|read more|next (article|photo|image|slide|song|track|video|result))/i;
/** A step advance leaves the current page, so it is terminal for this step (docs/incremental.md section 2 rule 6). */
const STEP =
  /^(continue|next|next step|proceed|save (and|&) (continue|next|proceed)|go (to|on) (the )?next|review (and|&) (submit|continue)|start (my |your )?application)\b/i;

/** A ghost that may carry the client's record of the user having accepted it. */
export type GateGhost = Shabang & { accepted?: boolean };

/**
 * Kinds whose empty reading is the page's own word rather than a gap in capture, and so may retire an
 * acceptance. A file input and a custom widget are left out on purpose: both routinely report nothing for a
 * control that holds an answer (a react-select hides its chosen value in a child widget), and treating that
 * as "the user cleared it" would strand the walk on a field it has already filled.
 */
const RECONCILABLE: ReadonlySet<string> = new Set([
  "text", "email", "tel", "url", "number", "date", "month", "textarea", "select", "radio", "checkbox",
]);

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
 * Could this required field and this terminal action belong to the same form? Capture order is DOCUMENT order,
 * not visual order, so "the required fields before it" is not a safe test on its own: a sticky submit bar or a
 * header action is declared before the body it submits and would be proposed with the whole form still empty.
 * Membership decides instead, and silence means yes: an undefined `formId` could be any form, so it blocks.
 */
function sameForm(a: CapturedField, b: CapturedField): boolean {
  return a.formId === undefined || b.formId === undefined || a.formId === b.formId;
}

/**
 * Walk the fields and decide what may still be proposed.
 * A required field is met when the page already holds an answer, or when the user has ACCEPTED a ghost for it;
 * a pending ghost meets nothing (docs/incremental.md section 3), so holding Tab can never unlock Submit through a guess.
 * A terminal action is withheld when ANY required field it could submit is still unmet, wherever that field sits
 * in the document. Fields are expected in capture order; ghosts for fields that are gone are ignored.
 */
export function gateWalk(fields: readonly CapturedField[], ghosts: readonly GateGhost[], options?: GateOptions): WalkGate {
  const accepted = new Set<string>(options?.accepted ?? []);
  for (const ghost of ghosts) if (ghost.accepted === true) accepted.add(ghost.signature);

  const unmet: CapturedField[] = [];
  const terminals: CapturedField[] = [];

  for (const field of fields) {
    if (isTerminalAction(field)) {
      terminals.push(field);
      continue;
    }
    if (!isRequired(field, options?.evidence?.[field.signature])) continue; // optional fields never gate anything
    if (isFilled(field) || accepted.has(field.signature)) continue;
    unmet.push(field);
  }

  const blockedTerminals: string[] = [];
  const allowedTerminals: string[] = [];
  for (const terminal of terminals) {
    const blocked = unmet.some((field) => sameForm(field, terminal));
    (blocked ? blockedTerminals : allowedTerminals).push(terminal.signature);
  }

  const gate: WalkGate = {
    unmetRequired: unmet.map((field) => field.signature),
    terminalAllowed: blockedTerminals.length === 0,
    blockedTerminals,
    allowedTerminals,
  };
  if (unmet.length > 0) {
    gate.reason = `${unmet.length} required field${unmet.length === 1 ? "" : "s"} still empty`;
    gate.firstUnmetLabel = displayLabel(unmet[0] as CapturedField);
  }
  return gate;
}

/**
 * The accepted set, reconciled with what the page now says. A signature the user accepted stands only while
 * the answer does: if the field is back on the page reporting nothing (the user cleared it, the site's own
 * validation reset it, React remounted it empty), the acceptance goes with it and the gate withholds Submit
 * again. A field capture cannot read (gone, or reporting "unknown") keeps its acceptance: silence is not proof
 * the answer went away, and dropping it would strand a walk that cannot re-fill the field.
 */
export function reconcileAccepted(fields: readonly CapturedField[], accepted: Iterable<string>): Set<string> {
  const emptied = new Set<string>();
  for (const field of fields) if (RECONCILABLE.has(field.kind) && isDefinitelyEmpty(field)) emptied.add(field.signature);
  const out = new Set<string>();
  for (const signature of accepted) if (!emptied.has(signature)) out.add(signature);
  return out;
}

/** Drop the ghosts for terminal actions the gate withholds. Everything else is untouched, in the same order. */
export function applyGate<T extends Shabang>(ghosts: readonly T[], gate: WalkGate): T[] {
  if (gate.blockedTerminals.length === 0) return [...ghosts];
  const blocked = new Set(gate.blockedTerminals);
  return ghosts.filter((ghost) => !blocked.has(ghost.signature));
}
