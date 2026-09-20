type AttrValue = string | boolean | undefined;

/** Minimal element builder: h("button", { class: "primary", disabled: true }, "Save"). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? "" : value);
  }
  el.append(...children);
  return el;
}

export type StatusKind = "ok" | "error" | "info";

const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Shows short-lived feedback ("Saved") in a status element, then clears it. */
export function flashStatus(el: HTMLElement, text: string, kind: StatusKind = "ok", ms = 2500): void {
  const previous = timers.get(el);
  if (previous) clearTimeout(previous);
  el.textContent = text;
  el.dataset.kind = kind;
  timers.set(el, setTimeout(() => {
    el.textContent = "";
    delete el.dataset.kind;
  }, ms));
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Same as h() for SVG. Numbers are allowed because coordinates are. */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | undefined> = {},
  ...children: Array<Node | string>
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined) el.setAttribute(name, String(value));
  }
  el.append(...children);
  return el;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
