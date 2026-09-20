import { classifyAffordance, MEDIA_ROLES, type AffordanceRole } from "@ghost/shared";

/**
 * Adapter: a vision label becomes an affordance role through the ONE shared classifier
 * (`shared/src/affordance/roles.ts`), which the extension ranker and the native agent also use.
 *
 * docs/anywhere.md section 4: "The returned label feeds the same affordance mapping, so one vision call can turn a row
 * of icon buttons into `play`, `fullscreen`, `captions`." Same mapping means the same module, not a second copy of the
 * vocabulary: a role Ghost learned from a DOM label and the same role read off pixels must be the same string, scored
 * the same way, or role-keyed memory cannot transfer between them.
 *
 * Nothing here reads a hostname, an app name or a brand. The only page-level input is a path PATTERN, which the shared
 * classifier already accepts and only ever uses to reinforce a role a control already suggested.
 */

export type { AffordanceRole };
export { MEDIA_ROLES };

/** Mirrors the shared `AffordanceRole` union. The annotation is the check: a typo here fails typecheck. */
export const AFFORDANCE_ROLES: readonly AffordanceRole[] = [
  "primary-item", "search",
  "play", "pause", "fullscreen", "next", "previous", "skip", "mute", "captions", "speed",
  "cart", "checkout", "buy", "quantity", "wishlist",
  "compose", "reply", "send", "save", "download", "share",
  "more", "menu", "settings", "close", "back", "forward", "scroll-more",
  "field", "submit", "unknown",
];

/** The vision role enum is finer than a candidate's kind; a checkbox, tab or menu is a control you activate. */
function kindOf(visionRole: string | undefined): "button" | "link" | "field" {
  if (visionRole === "field") return "field";
  if (visionRole === "link") return "link";
  return "button";
}

export interface AffordanceHints {
  /** The page's path PATTERN (/watch, /dp/*). Reinforces a role the control already suggests; never names one alone. */
  pathPattern?: string;
  /**
   * The client says these boxes sit in a media-controls cluster. Without it the batch decides for itself (below):
   * the shared classifier discounts player vocabulary outside a player, because "Play" on a form is not a video.
   */
  mediaControls?: boolean;
}

export interface LabelledBox {
  id: string;
  label: string | null;
  /** The coarse vision role: button, link, field, checkbox, tab, menu, other. */
  role?: string;
  locked?: boolean;
}

function roleOf(box: LabelledBox, hints: AffordanceHints, inMedia: boolean): AffordanceRole {
  return classifyAffordance(
    { id: box.id, kind: kindOf(box.role), label: box.label ?? "", locked: box.locked === true, insideMediaControls: inMedia },
    { pathPattern: hints.pathPattern },
  ).role;
}

/**
 * Roles for a whole batch, by box id, in ONE pass over the shared classifier — plus a second pass when the batch turns
 * out to be a player bar.
 *
 * Why two passes: player vocabulary only means what it says inside a player, so "Play", "Captions" and "Mute" are
 * discounted on their own and come back `unknown`. "Fullscreen" is not discounted, because nothing else on a page is
 * called that. A crop the client grouped that contains a fullscreen control IS a media-controls cluster, so the whole
 * batch is classified again with that context and the rest of the bar resolves. Entirely generic: the evidence is a
 * control in the same crop, never a site, a URL or an app name.
 */
export function affordanceRolesFor(boxes: readonly LabelledBox[], hints: AffordanceHints = {}): Map<string, AffordanceRole> {
  const first = boxes.map((box) => roleOf(box, hints, hints.mediaControls === true));
  const inMedia = hints.mediaControls === true || first.some((role) => MEDIA_ROLES.includes(role));
  const roles = inMedia && hints.mediaControls !== true ? boxes.map((box) => roleOf(box, hints, true)) : first;
  return new Map(boxes.map((box, i) => [box.id, roles[i] ?? "unknown"]));
}

/** One control on its own. Prefer `affordanceRolesFor` for a batch: a lone "Play" has no player around it to prove it. */
export function affordanceRoleOf(label: string | null | undefined, visionRole?: string, hints: AffordanceHints = {}): AffordanceRole {
  return roleOf({ id: "x", label: label ?? null, role: visionRole }, hints, hints.mediaControls === true);
}
