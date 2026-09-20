import type { Ghost } from "@ghost/shared";
import { jumpLabel } from "./jump";
import type { JumpHint } from "./jump";
import { CURSOR_PATH, CURSOR_TIP, OVERLAY_CSS, PAGE_CSS } from "./overlay-style";
import { clippingAncestors, intersect, isCovered } from "./visibility";
import type { Box } from "./visibility";

export interface OverlayState {
  /** `waiting`: Tab was pressed on a draft that is still streaming; the ghost shimmers until the rest arrives. */
  ghosts: Array<{ ghost: Ghost; el: HTMLElement; status: "pending" | "current"; waiting?: boolean }>;
  hud?: {
    provider: string; latencyMs: number | null; cache: "hit" | "miss" | "offline"; keystrokesSaved: number;
    /** The last finished free-text draft: who wrote it, time to the first token, time to the whole text. */
    text?: { provider: string; firstTokenMs: number | null; totalMs: number | null };
  };
  /** The jump pill ("14 ghosts ready · Tab to jump"). Mirrored to `data-ghost-jump`; omitted or null hides it. */
  jump?: JumpHint | null;
  /** Mirrored to `data-ghost-accepted`. When omitted the attribute is left as it is. */
  accepted?: number;
  /** Mirrored to `data-ghost-error` and shown in the HUD. Undefined leaves it alone, null or "" clears it. */
  error?: string | null;
}

type GhostEntry = OverlayState["ghosts"][number];
type Mode = "text" | "multiline" | "pill";

/** One reusable overlay node per ghost signature, plus what we cached about its field. */
interface GhostNode {
  root: HTMLDivElement;
  label: HTMLSpanElement;
  el: HTMLElement;
  value: string | undefined;
  /** Element the ghost visually lands on (the matching radio of a group, otherwise `el`). */
  target: HTMLElement;
  /** Target plus its label: what the highlight ring wraps for radios and checkboxes. */
  ringEls: HTMLElement[];
  /** Every control and label of the group: the pill sits past all of them. */
  groupEls: HTMLElement[];
  /** Scroll containers and overflow:hidden ancestors: the ghost must not paint outside them. */
  clipEls: HTMLElement[];
  mode: Mode;
  sizeKey: string;
  fieldCss: string;
  radius: number;
  css: string;
  hinted: HTMLElement | null;
  /** Multi-line only: the text or the box changed, so whether the draft overflows the box must be measured again. */
  remeasure: boolean;
}

interface Measured {
  entry: GhostEntry;
  node: GhostNode | null;
  box: Box;
  ringBox: Box;
  groupBox: Box;
  radius: number;
  /** The part of `box` the user can see: inside the viewport and every clipping ancestor. Null when none of it, or covered. */
  seen: Box | null;
}

interface Parts {
  host: HTMLDivElement;
  shadow: ShadowRoot;
  pageStyle: HTMLStyleElement;
  texts: HTMLDivElement;
  ring: HTMLDivElement;
  cursor: HTMLDivElement;
  lock: HTMLDivElement;
  hud: HTMLDivElement;
  hudMain: HTMLDivElement;
  hudError: HTMLDivElement;
  hudText: HTMLDivElement;
  hudValues: Record<"provider" | "latency" | "cache" | "saved" | "textProvider" | "firstToken" | "textTotal", HTMLSpanElement>;
  hudCache: HTMLSpanElement;
  jump: HTMLDivElement;
  jumpCount: HTMLSpanElement;
}

const HOST_ID = "ghost-overlay-host";
const PAGE_STYLE_ID = "ghost-overlay-page-style";
const HINT_ATTR = "data-ghost-hint";
const SVG_NS = "http://www.w3.org/2000/svg";
// `all: initial` lives in the :host rule; inline it would expand into hundreds of longhands.
const HOST_CSS = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
/** After the current ghost changes, renders inside this window keep the glide transition alive. */
const GLIDE_WINDOW_MS = 240;
const PILL_ROOM_PX = 140;

export class Overlay {
  private readonly doc: Document;
  private parts: Parts | null = null;
  private readonly nodes = new Map<string, GhostNode>();
  private currentSig = "";
  private glideUntil = 0;
  private hudKey = "";
  private savedTitle = "";
  private ringCss = "";
  private readonly clipCache = new WeakMap<HTMLElement, HTMLElement[]>();

  constructor(doc: Document = document) {
    this.doc = doc;
    this.mount();
  }

  /** The element carrying the `data-ghost-*` test hooks. */
  get host(): HTMLElement {
    return this.mount().host;
  }

  /**
   * The root is closed because it holds every predicted profile value before the user accepts anything,
   * and an open root is readable by any page script. This getter lives in the isolated world only: the
   * page cannot reach the Overlay object, so it is safe for our own code and unit tests.
   */
  get shadow(): ShadowRoot {
    return this.mount().shadow;
  }

  /** Hover text of the HUD's "saved" item (lifetime totals, from the metrics reporter). Survives re-mounts; never mounts. */
  setSavedTitle(title: string): void {
    this.savedTitle = title;
    const item = this.parts?.hudValues.saved.parentElement;
    if (item) setAttr(item, "title", title || null);
  }

  render(state: OverlayState): void {
    const parts = this.mount();
    const live = state.ghosts.filter((entry) => entry.el.isConnected);
    this.syncNodes(parts, live);
    // All layout reads happen before any write so a render costs at most one reflow.
    const viewport = viewportOf(this.doc);
    const measured = live.map((entry) => this.measure(entry, viewport));
    for (const m of measured) paintNode(m, viewport);
    this.paintCurrent(parts, measured.find((m) => m.entry.status === "current") ?? null, viewport);
    this.paintHud(parts, state);
    paintJump(parts, state.jump ?? null);
    paintHostAttrs(parts.host, state);
  }

  destroy(): void {
    for (const node of this.nodes.values()) setHint(node, null);
    this.nodes.clear();
    this.parts?.host.remove();
    this.parts?.pageStyle.remove();
    this.parts = null;
    this.currentSig = "";
    this.hudKey = "";
    this.ringCss = "";
  }

  /** Lazy so the overlay survives destroy() followed by another render(), and a page that drops our host. */
  private mount(): Parts {
    const root = this.doc.documentElement;
    if (!this.parts) {
      this.doc.getElementById(HOST_ID)?.remove();
      this.doc.getElementById(PAGE_STYLE_ID)?.remove();
      this.parts = buildParts(this.doc);
      this.setSavedTitle(this.savedTitle);
    }
    if (this.parts.host.parentNode !== root) root.appendChild(this.parts.host);
    if (!this.parts.pageStyle.isConnected) (this.doc.head ?? root).appendChild(this.parts.pageStyle);
    return this.parts;
  }

  private syncNodes(parts: Parts, live: GhostEntry[]): void {
    const seen = new Set<string>();
    for (const { ghost, el } of live) {
      if (ghost.action === "click") continue;
      seen.add(ghost.signature);
      let node = this.nodes.get(ghost.signature);
      if (!node) {
        node = createNode(this.doc, ghost, el);
        this.nodes.set(ghost.signature, node);
        parts.texts.appendChild(node.root);
      } else if (node.el !== el || (node.value !== ghost.value && isRadio(el))) {
        retarget(node, ghost, el);
      } else {
        node.value = ghost.value; // a streaming draft grows on every delta: same element, nothing to look up again
      }
    }
    for (const [signature, node] of this.nodes) {
      if (seen.has(signature)) continue;
      setHint(node, null);
      node.root.remove();
      this.nodes.delete(signature);
    }
  }

  private measure(entry: GhostEntry, viewport: Box): Measured {
    const node = this.nodes.get(entry.ghost.signature) ?? null;
    const target = node?.target ?? entry.el;
    const box = boxOf(target);
    if (node) refreshFieldStyle(node, box);
    const isCurrent = entry.status === "current";
    return {
      entry,
      node,
      box,
      seen: seenPart(target, box, node?.clipEls ?? this.clipElsOf(target), viewport),
      ringBox: node && isCurrent ? union(node.ringEls.map(boxOf)) : box,
      groupBox: node?.mode === "pill" ? union(node.groupEls.map(boxOf)) : box,
      radius: node ? node.radius : isCurrent ? readRadius(target) : 0,
    };
  }

  /** For the lock ghost, which has no node of its own to remember its clipping ancestors. */
  private clipElsOf(el: HTMLElement): HTMLElement[] {
    let known = this.clipCache.get(el);
    if (!known) this.clipCache.set(el, (known = clippingAncestors(el)));
    return known;
  }

  private paintCurrent(parts: Parts, m: Measured | null, viewport: Box): void {
    const { ring, cursor, lock } = parts;
    // A current field scrolled out of its container or under a sticky header gets no ring: Tab is native there too.
    if (!m || (m.seen === null && hasSize(m.box))) {
      for (const el of [ring, cursor, lock]) setAttr(el, "data-visible", "false");
      setAttr(parts.host, "data-ghost-cursor", null);
      if (!m) this.currentSig = "";
      return;
    }
    const signature = m.entry.ghost.signature;
    const now = Date.now();
    if (signature !== this.currentSig) {
      // First appearance fades in place; gliding in from the corner would look like a bug.
      this.glideUntil = this.currentSig === "" ? 0 : now + GLIDE_WINDOW_MS;
      this.currentSig = signature;
    }
    const still = now >= this.glideUntil;
    for (const el of [ring, cursor, lock]) el.classList.toggle("still", still);

    const locked = m.entry.ghost.locked;
    const grouped = m.node !== null && m.node.ringEls.length > 1;
    const ringCss = ringStyle(m.ringBox, grouped ? 4 : 3, grouped ? 8 : m.radius + 3);
    if (ringCss !== this.ringCss) ring.style.cssText = this.ringCss = ringCss;
    const tip = tipPoint(m);
    setTransform(cursor, translate(tip.x - CURSOR_TIP.x, tip.y - CURSOR_TIP.y));
    // The root is closed, so e2e tests read where the pointer rests from the host. Coordinates only, never values.
    setAttr(parts.host, "data-ghost-cursor", `${Math.round(tip.x)},${Math.round(tip.y)}`);
    setTransform(lock, lockTransform(tip, viewport));

    setAttr(ring, "data-visible", "true");
    setAttr(cursor, "data-visible", "true");
    setAttr(lock, "data-visible", locked ? "true" : "false");
    setAttr(ring, "data-locked", String(locked));
    setAttr(cursor, "data-locked", String(locked));
  }

  private paintHud(parts: Parts, state: OverlayState): void {
    const error = state.error === undefined ? (parts.host.getAttribute("data-ghost-error") ?? "") : (state.error ?? "");
    const key = JSON.stringify([state.hud ?? null, error]);
    if (key === this.hudKey) return;
    this.hudKey = key;
    const { hud } = state;
    parts.hudMain.hidden = !hud;
    parts.hudText.hidden = !hud?.text;
    parts.hudError.hidden = error === "";
    parts.hudError.textContent = error;
    setAttr(parts.hud, "data-visible", hud || error ? "true" : "false");
    if (!hud) return;
    parts.hudValues.provider.textContent = hud.provider;
    parts.hudValues.latency.textContent = millis(hud.latencyMs);
    parts.hudValues.cache.textContent = hud.cache;
    parts.hudValues.saved.textContent = `${hud.keystrokesSaved} keys`;
    setAttr(parts.hudCache, "data-cache", hud.cache);
    if (!hud.text) return;
    parts.hudValues.textProvider.textContent = hud.text.provider;
    parts.hudValues.firstToken.textContent = millis(hud.text.firstTokenMs);
    parts.hudValues.textTotal.textContent = millis(hud.text.totalMs);
  }
}

function paintHostAttrs(host: HTMLElement, state: OverlayState): void {
  const current = state.ghosts.find((entry) => entry.status === "current")?.ghost;
  setAttr(host, "data-ghost-state", state.ghosts.length > 0 ? "ready" : "idle");
  setAttr(host, "data-ghost-count", String(state.ghosts.length));
  setAttr(host, "data-ghost-current", current?.signature ?? "");
  setAttr(host, "data-ghost-current-locked", String(current?.locked ?? false));
  if (state.accepted !== undefined) setAttr(host, "data-ghost-accepted", String(state.accepted));
  if (state.error !== undefined) setAttr(host, "data-ghost-error", state.error || null);
  setAttr(host, "data-ghost-jump", state.jump ? "true" : "false");
}

function paintJump(parts: Parts, hint: JumpHint | null): void {
  setAttr(parts.jump, "data-visible", hint ? "true" : "false");
  if (!hint) return;
  setAttr(parts.jump, "data-direction", hint.direction);
  const label = jumpLabel(hint);
  if (parts.jumpCount.textContent !== label) parts.jumpCount.textContent = label;
}

function paintNode(m: Measured, viewport: Box): void {
  const { node, entry, box } = m;
  if (!node) return;
  let css = node.mode === "pill" ? pillStyle(m, viewport) : textStyle(node, box);
  // Never draw over something the user (or the page) already put in the field, nor outside what they can see of it.
  const filled = node.mode !== "pill" && Boolean((node.el as HTMLInputElement).value);
  const hidden = filled || (hasSize(box) && !drawable(m));
  if (hidden) css += "visibility:hidden;";
  else if (node.mode !== "pill" && m.seen) css += clipPath(box, m.seen);
  if (css !== node.css) node.root.style.cssText = node.css = css;
  // The field's own placeholder only steps aside while ghost text is really drawn over it.
  setHint(node, hidden || node.mode === "pill" ? null : node.target);
  if (node.label.textContent !== entry.ghost.displayText) {
    node.label.textContent = entry.ghost.displayText;
    node.remeasure = true;
  }
  setAttr(node.root, "data-status", entry.status);
  setAttr(node.root, "data-streaming", entry.ghost.pending ? "true" : null);
  setAttr(node.root, "data-waiting", entry.waiting ? "true" : null);
  if (node.mode === "multiline" && node.remeasure && !hidden) measureOverflow(node);
}

/**
 * A draft taller than its textarea is clipped like the textarea's own scroll box, and fades out at the bottom
 * edge so it reads as "there is more". The one layout read after a write: only for multi-line ghosts, and
 * only when their text or box changed (a streaming draft, a few times a second).
 */
function measureOverflow(node: GhostNode): void {
  node.remeasure = false;
  const overflows = node.label.scrollHeight > node.label.clientHeight + 1;
  setAttr(node.root, "data-overflow", overflows ? "true" : null);
}

function hasSize(box: Box): boolean {
  return box.width > 0 || box.height > 0; // jsdom measures nothing: then nothing is ever treated as clipped
}

/** Text can be drawn partly (clip-path); a pill sits beside its control, so the control must be fully in view. */
function drawable(m: Measured): boolean {
  if (!m.seen) return false;
  if (m.node?.mode !== "pill") return true;
  return m.seen.width >= m.box.width - 1 && m.seen.height >= m.box.height - 1;
}

function clipPath(box: Box, seen: Box): string {
  const top = seen.y - box.y;
  const left = seen.x - box.x;
  const right = box.x + box.width - (seen.x + seen.width);
  const bottom = box.y + box.height - (seen.y + seen.height);
  if (top < 1 && left < 1 && right < 1 && bottom < 1) return "";
  return `clip-path:inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)});`;
}

function seenPart(target: HTMLElement, box: Box, clipEls: HTMLElement[], viewport: Box): Box | null {
  let seen = intersect(box, viewport);
  for (const clip of clipEls) seen = intersect(seen, boxOf(clip));
  if (seen.width < 1 || seen.height < 1 || isCovered(target)) return null;
  return seen;
}

function textStyle(node: GhostNode, box: Box): string {
  return `${node.fieldCss}width:${px(box.width)};height:${px(box.height)};transform:${translate(box.x, box.y)};`;
}

/** Inside a select (left of its arrow); past the whole group for radios and checkboxes. */
function pillStyle(m: Measured, viewport: Box): string {
  const { box, groupBox } = m;
  const y = box.y + box.height / 2;
  if (m.node?.target.tagName === "SELECT") {
    const room = `max-width:${px(Math.max(40, box.width - 44))};`;
    return `${room}transform:${translate(box.x + box.width - 30, y)} translate(-100%,-50%);`;
  }
  const right = groupBox.x + groupBox.width;
  const fits = right + PILL_ROOM_PX <= viewport.width;
  return `transform:${translate(fits ? right + 8 : right - 8, y)} translate(${fits ? "0" : "-100%"},-50%);`;
}

function ringStyle(box: Box, pad: number, radius: number): string {
  const size = `width:${px(box.width + pad * 2)};height:${px(box.height + pad * 2)};`;
  return `${size}border-radius:${px(radius)};transform:${translate(box.x - pad, box.y - pad)};`;
}

/** Where the pointer's tip rests: past the ghost text in a field, dead center on small controls. */
function tipPoint(m: Measured): { x: number; y: number } {
  const { box, node } = m;
  const small = !node || (node.mode === "pill" && node.target.tagName !== "SELECT");
  if (small) return { x: box.x + box.width / 2, y: box.y + box.height * 0.55 };
  const dx = Math.max(20, Math.min(box.width * 0.62, box.width - 56));
  return { x: box.x + dx, y: box.y + Math.min(box.height * 0.62, 34) };
}

function lockTransform(tip: { x: number; y: number }, viewport: Box): string {
  const below = tip.y + 56 <= viewport.height || tip.y < 48;
  const x = Math.max(8, Math.min(tip.x + 14, viewport.width - 176));
  return translate(x, below ? tip.y + 22 : tip.y - 40);
}

function createNode(doc: Document, ghost: Ghost, el: HTMLElement): GhostNode {
  const root = make(doc, "div", "ghost");
  const label = make(doc, "span", "label");
  root.append(label, make(doc, "span", "keycap", "Tab"));
  const node: GhostNode = {
    root, label, el, value: ghost.value, target: el, ringEls: [el], groupEls: [el], clipEls: [],
    mode: "text", sizeKey: "", fieldCss: "", radius: 0, css: "", hinted: null, remeasure: true,
  };
  retarget(node, ghost, el);
  return node;
}

function retarget(node: GhostNode, ghost: Ghost, el: HTMLElement): void {
  const group = isRadio(el) ? radiosLike(el) : [el];
  const target = group.find((r) => (r as HTMLInputElement).value === ghost.value) ?? el;
  node.el = el;
  node.value = ghost.value;
  node.target = target;
  node.mode = modeOf(target);
  node.ringEls = withLabels([target]);
  node.groupEls = withLabels(group);
  node.clipEls = clippingAncestors(target);
  node.sizeKey = "";
  node.css = "";
  node.remeasure = true;
  setAttr(node.root, "data-mode", node.mode);
  setAttr(node.root, "data-signature", ghost.signature);
  setAttr(node.root, "data-review", ghost.answer?.needsReview ? "true" : null);
  if (node.hinted !== target) setHint(node, null); // paintNode puts the hint on once the text is really drawn
}

function modeOf(target: HTMLElement): Mode {
  if (target.tagName === "SELECT") return "pill";
  if (target.tagName !== "INPUT") return "multiline";
  return isToggle(target) ? "pill" : "text";
}

/** Radios and checkboxes are tiny, so their label is part of what the ghost points at. */
function isToggle(el: HTMLElement): el is HTMLInputElement {
  if (el.tagName !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return type === "radio" || type === "checkbox";
}

function isRadio(el: HTMLElement): el is HTMLInputElement {
  return el.tagName === "INPUT" && (el as HTMLInputElement).type === "radio";
}

function radiosLike(first: HTMLInputElement): HTMLElement[] {
  if (!first.name) return [first];
  const scope = (first.form ?? first.getRootNode()) as ParentNode;
  const radios = Array.from(scope.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  return radios.filter((r) => r.name === first.name && r.form === first.form);
}

function withLabels(els: HTMLElement[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of els) {
    out.push(el);
    const label = isToggle(el) ? el.labels?.[0] : undefined;
    if (label) out.push(label);
  }
  return out;
}

/** Marks the field so PAGE_CSS hides its placeholder while ghost text sits on top of it. */
function setHint(node: GhostNode, target: HTMLElement | null): void {
  if (node.hinted === target) return;
  node.hinted?.removeAttribute(HINT_ATTR);
  node.hinted = target;
  if (target) setAttr(target, HINT_ATTR, "");
}

/** Computed style is only re-read when the field changes size; scrolling never touches it. */
function refreshFieldStyle(node: GhostNode, box: Box): void {
  const sizeKey = `${box.width}x${box.height}`;
  if (sizeKey === node.sizeKey) return;
  node.sizeKey = sizeKey;
  node.remeasure = true;
  const view = node.target.ownerDocument.defaultView;
  if (!view) return;
  const cs = view.getComputedStyle(node.target);
  node.radius = radiusFrom(cs);
  node.fieldCss = node.mode === "pill" ? "" : fieldCssFrom(cs, node.mode === "multiline" ? scrollbarWidth(node.target, cs) : 0);
}

/** A textarea with `overflow-y: scroll` wraps its text short of the scrollbar; the ghost has to wrap there too. */
function scrollbarWidth(el: HTMLElement, cs: CSSStyleDeclaration): number {
  if (el.offsetWidth === 0) return 0;
  return Math.max(0, el.offsetWidth - el.clientWidth - num(cs.borderLeftWidth) - num(cs.borderRightWidth));
}

function fieldCssFrom(cs: CSSStyleDeclaration, scrollbar: number): string {
  const edge = (side: "Top" | "Right" | "Bottom" | "Left") => num(cs[`padding${side}`]) + num(cs[`border${side}Width`]);
  return [
    decl("word-break", cs.wordBreak), decl("tab-size", cs.tabSize),
    decl("font-family", cs.fontFamily), decl("font-size", cs.fontSize), decl("font-weight", cs.fontWeight),
    decl("font-style", cs.fontStyle), decl("letter-spacing", cs.letterSpacing), decl("word-spacing", cs.wordSpacing),
    decl("line-height", cs.lineHeight), decl("text-align", cs.textAlign), decl("text-transform", cs.textTransform),
    decl("text-indent", cs.textIndent), decl("direction", cs.direction),
    `padding:${px(edge("Top"))} ${px(edge("Right") + scrollbar)} ${px(edge("Bottom"))} ${px(edge("Left"))};`,
  ].join("");
}

function readRadius(el: HTMLElement): number {
  const view = el.ownerDocument.defaultView;
  return view ? radiusFrom(view.getComputedStyle(el)) : 0;
}

function radiusFrom(cs: CSSStyleDeclaration): number {
  const raw = cs.borderTopLeftRadius ?? "";
  return raw.includes("%") ? 999 : num(raw);
}

function buildParts(doc: Document): Parts {
  const host = make(doc, "div");
  host.id = HOST_ID;
  host.style.cssText = HOST_CSS;
  const shadow = host.attachShadow({ mode: "closed" });
  adoptStyles(doc, shadow);
  const layer = make(doc, "div", "layer");
  const texts = make(doc, "div", "texts");
  const ring = make(doc, "div", "ring still");
  const cursor = buildCursor(doc);
  const lock = buildLock(doc);
  const hudParts = buildHud(doc);
  const jumpParts = buildJump(doc);
  // The HUD goes first so the ghost visuals always paint above it.
  layer.append(hudParts.hud, jumpParts.jump, texts, ring, lock, cursor);
  shadow.appendChild(layer);
  const pageStyle = make(doc, "style");
  pageStyle.id = PAGE_STYLE_ID;
  pageStyle.textContent = PAGE_CSS;
  return { host, shadow, pageStyle, texts, ring, cursor, lock, ...hudParts, ...jumpParts };
}

/** Constructed sheets are exempt from the page's CSP; the <style> fallback covers jsdom and old engines. */
function adoptStyles(doc: Document, shadow: ShadowRoot): void {
  try {
    const Sheet = doc.defaultView?.CSSStyleSheet;
    if (Sheet && "replaceSync" in Sheet.prototype && "adoptedStyleSheets" in shadow) {
      const sheet = new Sheet();
      sheet.replaceSync(OVERLAY_CSS);
      shadow.adoptedStyleSheets = [sheet];
      return;
    }
  } catch {
    // fall through to the <style> element
  }
  shadow.appendChild(make(doc, "style", undefined, OVERLAY_CSS));
}

function buildCursor(doc: Document): HTMLDivElement {
  const cursor = make(doc, "div", "cursor still");
  const svg = svgEl(doc, "svg", { width: "28", height: "28", viewBox: "0 0 28 28", fill: "none", "aria-hidden": "true" });
  const gradient = svgEl(doc, "linearGradient", {
    id: "ghost-cursor-fill", x1: "4", y1: "3", x2: "19", y2: "25", gradientUnits: "userSpaceOnUse",
  });
  gradient.append(
    svgEl(doc, "stop", { "stop-color": "#ffffff", "stop-opacity": "0.92" }),
    svgEl(doc, "stop", { offset: "1", "stop-color": "#cdc2ff", "stop-opacity": "0.5" }),
  );
  const defs = svgEl(doc, "defs", {});
  defs.appendChild(gradient);
  const body = svgEl(doc, "path", {
    class: "body", d: CURSOR_PATH, fill: "url(#ghost-cursor-fill)", "stroke-width": "1.5", "stroke-linejoin": "round",
  });
  svg.append(defs, body);
  cursor.append(make(doc, "div", "halo"), svg);
  return cursor;
}

function buildLock(doc: Document): HTMLDivElement {
  const lock = make(doc, "div", "lock still");
  const svg = svgEl(doc, "svg", { width: "13", height: "13", viewBox: "0 0 16 16", "aria-hidden": "true" });
  svg.append(
    svgEl(doc, "rect", { x: "3", y: "7", width: "10", height: "7.5", rx: "2", fill: "currentColor" }),
    svgEl(doc, "path", {
      d: "M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round",
    }),
  );
  const text = make(doc, "span", "lock-text");
  text.append(make(doc, "kbd", undefined, "Enter"), " to confirm");
  lock.append(svg, text);
  return lock;
}

function buildJump(doc: Document): Pick<Parts, "jump" | "jumpCount"> {
  const jump = make(doc, "div", "jump");
  const arrow = svgEl(doc, "svg", { class: "arrow", width: "12", height: "12", viewBox: "0 0 12 12", "aria-hidden": "true" });
  arrow.append(svgEl(doc, "path", {
    d: "M6 1.5v8M2.5 6.2 6 9.7l3.5-3.5", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round",
  }));
  const jumpCount = make(doc, "span", "count");
  const hint = make(doc, "span", "hint");
  hint.append(make(doc, "kbd", undefined, "Tab"), "to jump");
  jump.append(arrow, jumpCount, make(doc, "span", "sep", "·"), hint);
  return { jump, jumpCount };
}

function buildHud(doc: Document): Pick<Parts, "hud" | "hudMain" | "hudError" | "hudText" | "hudValues" | "hudCache"> {
  const hud = make(doc, "div", "hud");
  const hudMain = make(doc, "div", "hud-main");
  const hudError = make(doc, "div", "hud-error");
  const hudText = make(doc, "div", "hud-text");
  const brand = make(doc, "span", "brand");
  brand.append(make(doc, "span", "dot"), "Ghost");
  const item = (key: string, name: string): [HTMLSpanElement, HTMLSpanElement] => {
    const wrap = make(doc, "span", `item ${name}`);
    const value = make(doc, "span", "v");
    wrap.append(make(doc, "span", "k", key), value);
    return [wrap, value];
  };
  const [providerWrap, provider] = item("via", "provider");
  const [latencyWrap, latency] = item("last", "latency");
  const [hudCache, cache] = item("cache", "cache");
  const [savedWrap, saved] = item("saved", "saved");
  const [textProviderWrap, textProvider] = item("draft via", "text-provider");
  const [firstTokenWrap, firstToken] = item("first token", "first-token");
  const [textTotalWrap, textTotal] = item("total", "text-total");
  hudMain.append(brand, providerWrap, latencyWrap, hudCache, savedWrap);
  hudText.append(textProviderWrap, firstTokenWrap, textTotalWrap);
  hudMain.hidden = hudError.hidden = hudText.hidden = true;
  hud.append(hudError, hudText, hudMain);
  return { hud, hudMain, hudError, hudText, hudValues: { provider, latency, cache, saved, textProvider, firstToken, textTotal }, hudCache };
}

function make<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function svgEl(doc: Document, tag: string, attrs: Record<string, string>): SVGElement {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

/** Skips identical writes: attribute mutations are observable by the page and by our own rescan observer. */
function setAttr(el: Element, name: string, value: string | null): void {
  if (el.getAttribute(name) === value) return;
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

function setTransform(el: HTMLElement, value: string): void {
  if (el.dataset.at === value) return;
  el.dataset.at = value;
  el.style.transform = value;
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function union(boxes: Box[]): Box {
  const solid = boxes.filter((b) => b.width > 0 || b.height > 0);
  const use = solid.length > 0 ? solid : boxes.slice(0, 1);
  const left = Math.min(...use.map((b) => b.x));
  const top = Math.min(...use.map((b) => b.y));
  const right = Math.max(...use.map((b) => b.x + b.width));
  const bottom = Math.max(...use.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function viewportOf(doc: Document): Box {
  const view = doc.defaultView;
  const width = doc.documentElement.clientWidth || view?.innerWidth || 0;
  const height = doc.documentElement.clientHeight || view?.innerHeight || 0;
  return { x: 0, y: 0, width, height };
}

function num(value: string | undefined): number {
  return Number.parseFloat(value ?? "") || 0;
}

function millis(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms)} ms`;
}

function px(n: number): string {
  return `${Math.round(n * 100) / 100}px`;
}

function translate(x: number, y: number): string {
  return `translate(${px(x)},${px(y)})`;
}

function decl(name: string, value: string | undefined): string {
  return value ? `${name}:${value};` : "";
}
