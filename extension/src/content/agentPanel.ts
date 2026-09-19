import type { AgentRunUpdate, AgentRunner } from "./agentRunner";
import type { Overlay } from "./overlay";

export interface AgentPanelDeps {
  overlay: Overlay;
  runner: AgentRunner;
  pauseGhosts(paused: boolean): void;
  isEnabled?(): boolean;
  doc?: Document;
  isUserEvent?: (event: Event) => boolean;
}

interface Parts {
  root: HTMLDivElement;
  goal: HTMLTextAreaElement;
  run: HTMLButtonElement;
  stop: HTMLButtonElement;
  close: HTMLButtonElement;
  status: HTMLDivElement;
  meta: HTMLDivElement;
}

const PANEL_ID = "ghost-agent-panel";

/** Closed-shadow command palette for the live demo. Alt+Shift+J opens it; nothing is persisted. */
export class AgentPanel {
  private readonly doc: Document;
  private readonly isUserEvent: (event: Event) => boolean;
  private parts: Parts | null = null;
  private open = false;

  constructor(private readonly deps: AgentPanelDeps) {
    this.doc = deps.doc ?? document;
    this.isUserEvent = deps.isUserEvent ?? ((event) => event.isTrusted);
  }

  start(): void {
    this.doc.addEventListener("keydown", this.onKeyDown, true);
  }

  stop(): void {
    this.doc.removeEventListener("keydown", this.onKeyDown, true);
    this.deps.runner.cancel();
    this.parts?.root.remove();
    this.parts = null;
    this.open = false;
    this.deps.pauseGhosts(false);
  }

  update(update: AgentRunUpdate): void {
    const parts = this.ensure();
    const host = this.deps.overlay.host;
    host.dataset.ghostAgentState = update.state;
    host.dataset.ghostAgentStep = String(update.step);
    if (update.reason) host.dataset.ghostAgentReason = update.reason;
    else delete host.dataset.ghostAgentReason;
    if (update.decision) {
      host.dataset.ghostAgentOperation = update.decision.operation;
      host.dataset.ghostAgentProvider = update.decision.provider;
      host.dataset.ghostAgentConfidence = update.decision.confidence.toFixed(3);
      host.dataset.ghostAgentOperationConfidence = update.decision.operationConfidence.toFixed(3);
      if (update.decision.targetConfidence !== undefined) host.dataset.ghostAgentTargetConfidence = update.decision.targetConfidence.toFixed(3);
      else delete host.dataset.ghostAgentTargetConfidence;
    }
    const labels: Record<AgentRunUpdate["state"], string> = {
      running: update.step === 0 ? "Observing page…" : `Step ${update.step}: ${update.decision?.operation ?? "choosing"}`,
      done: `Done after ${update.history.length} verified action${update.history.length === 1 ? "" : "s"}.`,
      blocked: `Stopped safely: ${friendly(update.reason)}.`,
      cancelled: "Stopped.",
    };
    parts.status.textContent = labels[update.state];
    const decision = update.decision;
    parts.meta.textContent = decision
      ? `${decision.provider} · ${Math.round(decision.confidence * 100)}% · ${decision.latencyMs} ms`
      : "Values stay local; Jev receives labels and filled/locked state only.";
    const running = update.state === "running";
    parts.run.disabled = running;
    parts.stop.disabled = !running;
    if (!running) this.deps.pauseGhosts(false);
  }

  show(): void {
    if (this.deps.isEnabled?.() === false) return;
    const parts = this.ensure();
    this.open = true;
    parts.root.hidden = false;
    this.deps.overlay.host.dataset.ghostAgentState ||= "idle";
    queueMicrotask(() => parts.goal.focus());
  }

  hide(): void {
    if (!this.parts) return;
    this.deps.runner.cancel();
    this.parts.root.hidden = true;
    this.open = false;
    this.deps.pauseGhosts(false);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isUserEvent(event)) return;
    if (event.key.toLowerCase() === "j" && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.open ? this.hide() : this.show();
      return;
    }
    if (event.key === "Escape" && this.open && this.doc.activeElement === this.deps.overlay.host) this.hide();
  };

  private ensure(): Parts {
    if (this.parts?.root.isConnected) return this.parts;
    const root = this.doc.createElement("div");
    root.id = PANEL_ID;
    root.dataset.ghostUi = "agent";
    root.hidden = true;

    const style = this.doc.createElement("style");
    style.textContent = `
      #${PANEL_ID}{position:fixed;right:22px;bottom:22px;width:min(430px,calc(100vw - 44px));padding:18px;border:1px solid rgba(255,255,255,.14);border-radius:18px;background:#11130f;color:#f5f7ef;box-shadow:0 20px 70px rgba(0,0,0,.45);pointer-events:auto;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #${PANEL_ID}[hidden]{display:none} #${PANEL_ID} *{box-sizing:border-box} #${PANEL_ID} .head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px} #${PANEL_ID} h2{font-size:15px;margin:0} #${PANEL_ID} .close{border:0;background:transparent;color:#a8b09d;font-size:20px;cursor:pointer;padding:0 4px} #${PANEL_ID} textarea{display:block;width:100%;min-height:82px;resize:vertical;border:1px solid #394034;border-radius:11px;background:#1a1d17;color:#f5f7ef;padding:11px;font:inherit;outline:none} #${PANEL_ID} textarea:focus{border-color:#9bcf77;box-shadow:0 0 0 3px rgba(155,207,119,.12)} #${PANEL_ID} .actions{display:flex;gap:8px;margin-top:11px} #${PANEL_ID} button.action{border:0;border-radius:10px;padding:9px 13px;font:600 12px/1 inherit;cursor:pointer} #${PANEL_ID} .run{background:#b8ef8e;color:#15200d} #${PANEL_ID} .stop{background:#292d25;color:#e4e8dc} #${PANEL_ID} button:disabled{opacity:.45;cursor:default} #${PANEL_ID} .status{margin-top:12px;font-weight:600} #${PANEL_ID} .meta{margin-top:3px;color:#9ea795;font-size:11px}
    `;
    const head = this.doc.createElement("div");
    head.className = "head";
    const title = this.doc.createElement("h2");
    title.textContent = "Jev computer-use run";
    const close = this.doc.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close agent panel");
    head.append(title, close);
    const goal = this.doc.createElement("textarea");
    goal.id = "ghost-agent-goal";
    goal.placeholder = "Complete this application and stop before Submit application";
    goal.setAttribute("aria-label", "Agent goal");
    const actions = this.doc.createElement("div");
    actions.className = "actions";
    const run = this.doc.createElement("button");
    run.className = "action run";
    run.type = "button";
    run.textContent = "Run with Jev";
    const stop = this.doc.createElement("button");
    stop.className = "action stop";
    stop.type = "button";
    stop.textContent = "Stop";
    stop.disabled = true;
    actions.append(run, stop);
    const status = this.doc.createElement("div");
    status.className = "status";
    status.textContent = "Ready.";
    const meta = this.doc.createElement("div");
    meta.className = "meta";
    meta.textContent = "Values stay local; Jev receives labels and filled/locked state only.";
    root.append(style, head, goal, actions, status, meta);
    this.deps.overlay.shadow.appendChild(root);
    this.parts = { root, goal, run, stop, close, status, meta };

    close.addEventListener("click", () => this.hide());
    stop.addEventListener("click", () => {
      this.deps.runner.cancel();
      status.textContent = "Stopping…";
    });
    run.addEventListener("click", () => {
      if (this.deps.isEnabled?.() === false) return;
      const command = goal.value.trim() || goal.placeholder;
      this.deps.pauseGhosts(true);
      void this.deps.runner.run(command);
    });
    goal.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        run.click();
      }
    });
    return this.parts;
  }
}

function friendly(reason: string | undefined): string {
  return (reason ?? "blocked").replaceAll("-", " ");
}
