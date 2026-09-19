// "Ghost learned: phone  [Undo]": a small chip inside the overlay's closed shadow root. It never takes
// focus (the walk depends on where focus is), never blocks the page, and shows a fact KEY, never a value.
export const TOAST_MS = 6000;
const UNDONE_MS = 1500;

export interface ToastRequest {
  text: string;
  onUndo: () => void;
}

export interface ToastDeps {
  /** Where the chip lives: the overlay's shadow root, or null while Ghost is off (then nothing is shown). */
  root: () => ParentNode | null;
  doc?: Document;
  durationMs?: number;
  /** Default: event.isTrusted. Tests pass () => true (jsdom cannot mint trusted events). */
  isUserEvent?: (event: Event) => boolean;
}

// Inline CSSOM styles: the overlay's sheet is not ours to edit, and el.style is exempt from the page's CSP.
const CHIP_CSS = [
  "position:absolute", "left:14px", "bottom:14px", "display:flex", "align-items:center", "gap:10px", "max-width:calc(100% - 28px)",
  "box-sizing:border-box", "padding:7px 8px 7px 12px", "border-radius:11px", "pointer-events:auto",
  "font:500 12px/1.2 ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif", "color:rgba(255,255,255,.92)",
  "background:rgba(16,14,26,.92)", "border:1px solid rgba(255,255,255,.12)", "box-shadow:0 12px 32px -12px rgba(10,6,40,.65)",
].join(";");
const TEXT_CSS = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
const BUTTON_CSS = [
  "all:unset", "cursor:pointer", "padding:4px 9px", "border-radius:7px", "font-weight:600", "font-size:11px",
  "color:#cdc2ff", "background:rgba(124,92,255,.22)",
].join(";");

export class LearnToast {
  private chip: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ToastDeps) {}

  /** One chip at a time: a newer lesson replaces the one on screen (its Undo goes with it). */
  show(request: ToastRequest): void {
    this.hide();
    const root = this.deps.root();
    if (!root) return;
    const doc = this.deps.doc ?? document;
    const chip = doc.createElement("div");
    chip.className = "learn-toast";
    chip.setAttribute("role", "status");
    chip.style.cssText = CHIP_CSS;
    const text = doc.createElement("span");
    text.style.cssText = TEXT_CSS;
    text.textContent = request.text;
    chip.append(text, this.undoButton(doc, request, text));
    root.appendChild(chip);
    this.chip = chip;
    this.timer = setTimeout(() => this.hide(), this.deps.durationMs ?? TOAST_MS);
  }

  hide(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.chip?.remove();
    this.chip = null;
  }

  private undoButton(doc: Document, request: ToastRequest, text: HTMLElement): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.tabIndex = -1; // mouse only: Tab belongs to the page and to the walk
    button.textContent = "Undo";
    button.style.cssText = BUTTON_CSS;
    button.addEventListener("mousedown", (event) => event.preventDefault()); // a click must not pull focus out of the form
    button.addEventListener("click", (event) => {
      if (!(this.deps.isUserEvent ?? ((e: Event) => e.isTrusted))(event)) return;
      request.onUndo();
      button.remove();
      text.textContent = "Undone";
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.hide(), UNDONE_MS);
    });
    return button;
  }
}
