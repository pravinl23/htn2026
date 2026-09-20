import { isLockedAction, isSensitive } from "@ghost/shared";
import type { CapturedField, FieldKind, FieldOption, Rect } from "@ghost/shared";
import { clipsOverflow, hasLayout } from "./visibility";

export type VisibilityProbe = (el: Element) => boolean;

const OVERLAY_HOST = "#ghost-overlay-host";
const CANDIDATES = 'input, textarea, select, button, a[href], [role="button"]';
const CONTROLS = "input, textarea, select, button";
const NON_TEXT = "script, style, noscript, template";
const SKIPPED_TEXT = `${CONTROLS}, ${NON_TEXT}`;
const SENSITIVE_MARK = "[data-ghost-sensitive], [data-sensitive]";
const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const INPUT_KINDS: Record<string, FieldKind> = {
  text: "text", search: "text", email: "email", tel: "tel", url: "url", number: "number",
  date: "date", month: "month", radio: "radio", checkbox: "checkbox", file: "file",
  submit: "button", button: "button", reset: "button", image: "button",
};
const BUTTON_DEFAULT_TEXT: Record<string, string> = { submit: "Submit", reset: "Reset" };
const MAX_LABEL = 160;
const MAX_CONTEXT = 80;
const HIDDEN_FROM_USER = '[hidden], [inert], [aria-hidden="true"]';
// "Card details > Number" is a card number even though neither word alone says so.
const CARD_CONTEXT = /\bcards?\b|\bpayment\b/i;
const GENERIC_CARD_LABEL = /^(name|full name|holder|number|num|no|#|expiry|expiration|exp|exp date|valid (thru|until|to)|code|security)$/i;

/** One capturable thing: a single element, or a whole radio group anchored at its first radio. */
interface Unit {
  el: HTMLElement;
  radios?: HTMLInputElement[];
}

let visibilityProbe: VisibilityProbe | null = null;
let nameCache: WeakMap<Element, string> | null = null; // only alive during one captureFields pass
let openModals: Element[] = []; // refreshed per captureFields pass
let lastRoot: ParentNode | null = null;
let lastCapture = new Map<string, HTMLElement>();

/** Test seam: replace the visibility check (jsdom has no layout). Pass null to restore the default. */
export function setVisibilityProbe(fn: VisibilityProbe | null): void {
  visibilityProbe = fn;
}

// ---------- text helpers ----------

function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function cleanLabel(text: string): string {
  let out = squash(text);
  let prev = "";
  while (out !== prev) {
    prev = out;
    out = out.replace(/^\*\s*/, "").replace(/\s*(\*|\(required\)|:)$/i, "").trim();
  }
  return out.slice(0, MAX_LABEL);
}

/** Text content without nested controls, so a wrapping label does not swallow its select's options. */
function textOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLImageElement) return node.alt;
  const parts = Array.from(node.childNodes, (child) => (child instanceof Element && child.matches(SKIPPED_TEXT) ? "" : textOf(child)));
  return parts.join(" ");
}

function attr(el: Element, name: string): string {
  return squash(el.getAttribute(name));
}

// ---------- accessible name ----------

function labelledByText(el: Element): string {
  const doc = el.ownerDocument;
  const ids = attr(el, "aria-labelledby").split(" ").filter(Boolean);
  return squash(ids.map((id) => textOf(doc.getElementById(id) ?? doc.createTextNode(""))).join(" "));
}

function labelElements(el: Element): HTMLLabelElement[] {
  const labels = (el as HTMLInputElement).labels;
  return labels ? Array.from(labels) : [];
}

/** label[for] wins over a wrapping label. */
function labelTagText(el: Element): string {
  const labels = labelElements(el);
  const explicit = labels.filter((l) => el.id !== "" && l.htmlFor === el.id);
  for (const label of [...explicit, ...labels]) {
    const text = squash(textOf(label));
    if (text) return text;
  }
  return "";
}

function blocksPrecedingText(el: Element): boolean {
  return el.matches(CONTROLS) || el.querySelector(CONTROLS) !== null;
}

/** Walks backwards (then upwards) for the closest text, stopping at another control or a form boundary. */
function precedingText(start: Element, ignore: ReadonlySet<Element> = new Set()): string {
  let node: Element | null = start;
  for (let depth = 0; depth < 4 && node; depth++) {
    for (let sib = node.previousSibling; sib; sib = sib.previousSibling) {
      if (sib instanceof Element && (ignore.has(sib) || sib.matches(NON_TEXT))) continue;
      if (sib instanceof Element && blocksPrecedingText(sib)) return "";
      const text = squash(textOf(sib));
      if (text) return text;
    }
    node = node.parentElement;
    if (!node || node.matches("form, fieldset, body, html")) break;
  }
  return "";
}

function isRadio(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.type === "radio";
}

function isActionable(el: Element): boolean {
  const kind = kindOf(el);
  return kind === "button" || kind === "link";
}

function actionName(el: Element): string {
  if (el instanceof HTMLInputElement) {
    const fallback = el.type === "image" ? el.alt : BUTTON_DEFAULT_TEXT[el.type] ?? "";
    return attr(el, "value") || squash(fallback) || attr(el, "title");
  }
  return squash(textOf(el)) || attr(el, "title");
}

function fieldName(el: Element): string {
  return labelTagText(el) || attr(el, "placeholder") || attr(el, "title") || precedingText(el);
}

function ownName(el: Element): string {
  const aria = labelledByText(el) || attr(el, "aria-label");
  return aria || (isActionable(el) ? actionName(el) : fieldName(el));
}

function radioGroupOf(radio: HTMLInputElement): HTMLInputElement[] {
  if (!radio.name) return [radio];
  const scope: ParentNode = radio.form ?? (radio.getRootNode() as ParentNode);
  const all = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  return all.filter((r) => r.name === radio.name && r.form === radio.form);
}

function legendText(el: Element): string {
  const legend = el.closest("fieldset")?.querySelector(":scope > legend");
  return legend ? squash(textOf(legend)) : "";
}

/** The question a radio group answers: radiogroup aria name, then legend, then the text before the group. */
function radioGroupName(radios: HTMLInputElement[]): string {
  const first = radios[0];
  if (!first) return "";
  const group = first.closest('[role="radiogroup"]');
  const aria = group ? labelledByText(group) || attr(group, "aria-label") : "";
  if (aria) return aria;
  const optionLabels = new Set<Element>(radios.flatMap(labelElements));
  return legendText(first) || precedingText(first, optionLabels);
}

function radioOptionLabel(radio: HTMLInputElement): string {
  const following = radio.nextSibling?.nodeType === Node.TEXT_NODE ? squash(radio.nextSibling.textContent) : "";
  const name = labelledByText(radio) || attr(radio, "aria-label") || labelTagText(radio) || attr(radio, "title");
  return cleanLabel(name || following || radio.value);
}

/** For a radio this is the name of its whole group, because a group is captured as one field. */
export function accessibleName(el: Element): string {
  const cached = nameCache?.get(el);
  if (cached !== undefined) return cached;
  const name = cleanLabel(isRadio(el) ? radioGroupName(radioGroupOf(el)) : ownName(el));
  nameCache?.set(el, name);
  return name;
}

// ---------- kind, safety ----------

function kindOf(el: Element): FieldKind {
  if (el instanceof HTMLInputElement) return INPUT_KINDS[el.type] ?? "other";
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLButtonElement || el.getAttribute("role") === "button") return "button";
  return el instanceof HTMLAnchorElement ? "link" : "other";
}

/**
 * Safety looks at every naming source, not just the winning one: a benign aria-label must not
 * hide a visible "Social Insurance Number" label, and "Card details > Number" is a card number.
 */
function sensitiveProbeText(el: Element): string {
  const explicit = [labelledByText(el), attr(el, "aria-label"), labelTagText(el)];
  const loose = explicit.some(Boolean) || isActionable(el) ? [] : [precedingText(el)];
  return [accessibleName(el), ...explicit, attr(el, "title"), legendText(el), ...loose].filter(Boolean).join(" ");
}

/** A bare "Number", "Expiry" or "Name" under a card or payment legend/heading belongs to the card. */
function inCardContext(el: Element): boolean {
  if (isActionable(el) || !GENERIC_CARD_LABEL.test(accessibleName(el).replace(/[.\s]+$/, ""))) return false;
  return CARD_CONTEXT.test(`${legendText(el)} ${nearestHeading(el)}`);
}

export function isElementSensitive(el: Element): boolean {
  const members = isRadio(el) ? radioGroupOf(el) : [el];
  const label = sensitiveProbeText(el);
  if (inCardContext(el)) return true;
  return members.some((m) =>
    isSensitive({
      inputType: m.getAttribute("type") ?? undefined,
      autocomplete: m.getAttribute("autocomplete") ?? undefined,
      name: m.getAttribute("name") ?? undefined,
      id: m.id || undefined,
      label,
      placeholder: m.getAttribute("placeholder") ?? undefined,
      markedSensitive: m.closest(SENSITIVE_MARK) !== null,
    }),
  );
}

export function isElementLocked(el: Element): boolean {
  if (el.closest("[data-ghost-lock]")) return true;
  if (!isActionable(el)) return false; // a text field labelled "Confirm email" is not an action
  // Only native buttons submit their form by default; a div[role=button] or a link does not.
  const native = el instanceof HTMLButtonElement || el instanceof HTMLInputElement;
  return isLockedAction({
    text: accessibleName(el),
    // The attribute, not the property: button.type reports "submit" even outside a form.
    buttonType: native ? el.getAttribute("type") ?? "" : undefined,
    insideForm: native && el.form !== null,
  });
}

// ---------- visibility ----------

function isToggle(el: Element): el is HTMLInputElement {
  return el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox");
}

/**
 * display, visibility, content-visibility and opacity, on the element or any ancestor. Custom toggles
 * make the real input transparent and style the label, so their own opacity does not count.
 */
function hiddenByStyle(el: Element): boolean {
  const opacityFrom = isToggle(el) ? el.parentElement : el;
  if (typeof el.checkVisibility === "function") {
    if (!el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return true;
    return opacityFrom ? !opacityFrom.checkVisibility({ opacityProperty: true }) : false;
  }
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  let opacityCounts = false;
  for (let n: Element | null = el; n; n = n.parentElement) {
    opacityCounts ||= n === opacityFrom;
    const style = view.getComputedStyle(n);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
    if (opacityCounts && Number.parseFloat(style.opacity) === 0) return true;
  }
  return false;
}

/** Has a real box on the page: not collapsed in either direction and not parked off the top-left edge. */
function hasBox(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const view = el.ownerDocument.defaultView;
  if (r.width < 2 || r.height < 2) return false;
  // Honeypots and "visually hidden" inputs sit at left:-9999px; filling a honeypot gets the user flagged as a bot.
  return r.right + (view?.scrollX ?? 0) > 0 && r.bottom + (view?.scrollY ?? 0) > 0;
}

/** Inside a wrapper that is collapsed and clips (height:0; overflow:hidden, the sr-only recipe, a closed accordion). */
function clippedAway(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view) return false;
  for (let n = el.parentElement; n && n !== el.ownerDocument.body; n = n.parentElement) {
    if (n.clientWidth >= 2 && n.clientHeight >= 2) continue;
    const style = view.getComputedStyle(n);
    if (style.display === "inline" || style.display === "contents") continue; // no box of their own to clip with
    if (clipsOverflow(style)) return true;
  }
  return false;
}

/** Custom radios and checkboxes often hide the real input and style the label instead. */
function visibleStandIn(el: Element): Element | null {
  if (!isToggle(el)) return null;
  return labelElements(el).find(hasBox) ?? null;
}

/** showModal() makes the rest of the page inert without touching any attribute. */
function findOpenModals(root: ParentNode): Element[] {
  try {
    return Array.from((root.ownerDocument ?? (root as Document)).querySelectorAll("dialog:modal"));
  } catch {
    return []; // engines without :modal
  }
}

function behindModal(el: Element): boolean {
  return openModals.length > 0 && !openModals.some((modal) => modal.contains(el));
}

function defaultVisible(el: Element): boolean {
  if (el.closest(HIDDEN_FROM_USER) || behindModal(el) || hiddenByStyle(el)) return false;
  // No box anywhere means nothing can be measured (jsdom), not that the element is invisible.
  if (!hasLayout(el.ownerDocument)) return true;
  if (!isActionable(el) && clippedAway(el)) return false;
  return hasBox(el) || visibleStandIn(el) !== null;
}

function isVisible(el: Element): boolean {
  return (visibilityProbe ?? defaultVisible)(el);
}

function isDisabled(el: Element): boolean {
  if ((el as HTMLInputElement).disabled === true || el.getAttribute("aria-disabled") === "true") return true;
  return el.closest("fieldset[disabled]") !== null;
}

function isReadonly(el: Element): boolean {
  return el.hasAttribute("readonly") || el.getAttribute("aria-readonly") === "true";
}

/** The classic honeypot markup: a text field taken out of the tab order with autofill switched off. */
function looksLikeTrap(el: Element): boolean {
  if (isActionable(el) || isToggle(el)) return false;
  return el.getAttribute("tabindex") === "-1" && el.getAttribute("autocomplete")?.toLowerCase() === "off";
}

function isUsable(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === "hidden") return false;
  if (el.closest(OVERLAY_HOST) || looksLikeTrap(el)) return false;
  return !isDisabled(el) && !isReadonly(el) && isVisible(el);
}

// ---------- signatures ----------

function topRoot(node: Node): ParentNode {
  return node.getRootNode() as ParentNode;
}

function collectUnits(top: ParentNode): Unit[] {
  const units: Unit[] = [];
  const groups = new Map<HTMLFormElement | ParentNode, Map<string, Unit>>();
  for (const el of top.querySelectorAll<HTMLElement>(CANDIDATES)) {
    if (!isRadio(el) || !el.name) {
      units.push(isRadio(el) ? { el, radios: [el] } : { el });
      continue;
    }
    const scope = el.form ?? top;
    const byName = groups.get(scope) ?? new Map<string, Unit>();
    groups.set(scope, byName);
    const existing = byName.get(el.name);
    if (existing) existing.radios?.push(el);
    else {
      const unit: Unit = { el, radios: [el] };
      byName.set(el.name, unit);
      units.push(unit);
    }
  }
  return units;
}

function normalizeForSignature(label: string): string {
  return label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 60);
}

/** Generated ids (ember1234, input-839201) change on every load, so they must not reach the signature. */
function stableId(el: Element): string {
  return /\d{4,}|^ember\d+/.test(el.id) ? "" : el.id;
}

function signatureBase(unit: Unit): string {
  const el = unit.el;
  const type = el.getAttribute("type")?.toLowerCase() ?? "";
  const id = unit.radios ? "" : stableId(el); // a group is identified by its name, not by one radio's id
  const label = normalizeForSignature(accessibleName(el));
  return [el.tagName.toLowerCase(), type, el.getAttribute("name") ?? "", id, label].join("|");
}

/** Value-free signatures for every unit under `top`; repeated bases are numbered in DOM order. */
function signUnits(units: Unit[]): Map<Unit, string> {
  const seen = new Map<string, number>();
  const out = new Map<Unit, string>();
  for (const unit of units) {
    const base = signatureBase(unit);
    const index = seen.get(base) ?? 0;
    seen.set(base, index + 1);
    out.set(unit, `${base}|${index}`);
  }
  return out;
}

export function computeSignature(el: Element): string {
  const units = collectUnits(topRoot(el));
  const unit = units.find((u) => u.el === el || (isRadio(el) && u.radios?.includes(el)));
  return (unit && signUnits(units).get(unit)) ?? `${signatureBase({ el: el as HTMLElement })}|0`;
}

// ---------- field assembly ----------

function rectOf(el: Element): Rect {
  const source = hasBox(el) ? el : visibleStandIn(el) ?? el;
  const r = source.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function unionRect(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}

function selectOptions(el: HTMLSelectElement): FieldOption[] {
  return Array.from(el.options)
    .filter((o) => !o.disabled)
    .map((o) => ({ value: o.value, label: squash(o.label || o.text) }));
}

function nearestHeading(el: Element): string {
  let node: Element | null = el;
  for (let depth = 0; depth < 8 && node && !node.matches("body, html"); depth++) {
    let sib = node.previousElementSibling;
    for (let i = 0; i < 30 && sib; i++, sib = sib.previousElementSibling) {
      // A control-free wrapper may hold the heading; a sibling with controls is another section.
      const heading = sib.matches(HEADINGS) ? sib : blocksPrecedingText(sib) ? null : sib.querySelector(HEADINGS);
      if (heading) return squash(textOf(heading));
    }
    node = node.parentElement;
  }
  return "";
}

function contextOf(el: Element, label: string): string | undefined {
  const candidates = [legendText(el), nearestHeading(el)].map((t) => cleanLabel(t).slice(0, MAX_CONTEXT));
  // A heading can name a neighbouring sensitive field; that text must not ride along as context.
  return candidates.find((t) => t !== "" && t !== label && !isSensitive({ label: t }));
}

function markedRequired(el: Element, members: Element[]): boolean {
  const raw = isRadio(el) ? radioGroupName(members as HTMLInputElement[]) : ownName(el);
  const flagged = members.some((m) => (m as HTMLInputElement).required === true || m.getAttribute("aria-required") === "true");
  return flagged || /^\*|\*$|\(required\)$/i.test(squash(raw));
}

function currentValue(el: HTMLElement, radios: HTMLInputElement[] | undefined): string | undefined {
  if (radios) return radios.find((r) => r.checked)?.value ?? "";
  if (el instanceof HTMLInputElement && el.type === "checkbox") return String(el.checked);
  if (el instanceof HTMLInputElement && el.type === "file") return undefined;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
  return undefined;
}

function opt(text: string | null | undefined): string | undefined {
  return text ? text : undefined;
}

function dropUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function buildField(unit: Unit, usable: HTMLElement[], signature: string): CapturedField {
  const el = usable[0] ?? unit.el;
  const kind = kindOf(el);
  const label = accessibleName(el);
  const action = kind === "button" || kind === "link";
  const locked = isElementLocked(el);
  const radios = unit.radios ? (usable as HTMLInputElement[]) : undefined;
  return dropUndefined<CapturedField>({
    signature,
    label,
    kind,
    inputType: opt(el instanceof HTMLInputElement ? el.type : el.getAttribute("type")?.toLowerCase()),
    name: opt(el.getAttribute("name")),
    id: opt(radios ? undefined : el.id),
    autocomplete: opt(el.getAttribute("autocomplete")),
    placeholder: opt(el.getAttribute("placeholder")),
    options: optionsOf(el, radios),
    required: action ? undefined : markedRequired(el, usable),
    value: action ? undefined : currentValue(el, radios),
    rect: unit.radios ? unionRect(usable.map(rectOf)) : rectOf(el),
    locked: action || locked ? locked : undefined,
    formId: formIdOf(el),
    context: kind === "link" ? undefined : contextOf(el, label), // links never get a ghost; the heading walk is not free
  });
}

let formIds: WeakMap<HTMLFormElement, string> | null = null;
let formCount = 0;

/**
 * Which form this control belongs to, so the gate can tell one form's unmet required field from another's
 * (shared/src/form/gate.ts). `el.form` is the DOM's own answer and honours a `form=` attribute, so a submit
 * bar declared outside the form it submits still comes back as part of it. "-" means "no form at all", which
 * is a scope of its own: a required search box in the site header does not withhold a newsletter's Subscribe.
 * The ids are per capture pass and never leave the page: they are ordinals, not anything from the markup.
 */
function formIdOf(el: HTMLElement): string {
  const form = (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement).form ?? null;
  if (!(form instanceof HTMLFormElement)) return "-";
  if (!formIds) formIds = new WeakMap();
  const known = formIds.get(form);
  if (known !== undefined) return known;
  const id = `f${++formCount}`;
  formIds.set(form, id);
  return id;
}

function optionsOf(el: HTMLElement, radios: HTMLInputElement[] | undefined): FieldOption[] | undefined {
  if (radios) return radios.map((r) => ({ value: r.value, label: radioOptionLabel(r) }));
  return el instanceof HTMLSelectElement ? selectOptions(el) : undefined;
}

function within(root: ParentNode, el: Element): boolean {
  return root === el.getRootNode() || root.contains(el);
}

/** Visible, enabled, non-sensitive interactive elements under `root`, in DOM order. */
export function captureFields(root: ParentNode = document): CapturedField[] {
  nameCache = new WeakMap();
  formIds = new WeakMap();
  formCount = 0;
  openModals = findOpenModals(root);
  try {
    return captureUnits(root);
  } finally {
    nameCache = null;
    openModals = [];
  }
}

function captureUnits(root: ParentNode): CapturedField[] {
  const units = collectUnits(root instanceof Element ? topRoot(root) : root);
  const signatures = signUnits(units);
  const fields: CapturedField[] = [];
  lastRoot = root;
  lastCapture = new Map();
  for (const unit of units) {
    const usable = (unit.radios ?? [unit.el]).filter((m) => within(root, m) && isUsable(m));
    const anchor = usable[0];
    const signature = signatures.get(unit);
    if (!anchor || !signature || isElementSensitive(unit.el)) continue;
    fields.push(buildField(unit, usable, signature));
    lastCapture.set(signature, anchor);
  }
  return fields;
}

/** Resolves a signature from the last capture; re-captures once when the page re-rendered the node away. */
export function findElement(signature: string): HTMLElement | null {
  const cached = lastCapture.get(signature);
  if (cached?.isConnected) return cached;
  if (!lastRoot) return null;
  captureFields(lastRoot instanceof Element && !lastRoot.isConnected ? document : lastRoot);
  return lastCapture.get(signature) ?? null;
}
