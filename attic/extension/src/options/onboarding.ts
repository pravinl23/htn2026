// First-run card above the tabs. Static copy only; dismissal is remembered in chrome.storage.local.
import { h } from "./dom";
import { readLocal, writeLocal } from "./local-store";

export const ONBOARDED_KEY = "ghost.onboarded";
const DEMO_URL = "http://localhost:5173";

function keyRow(keys: string[], text: string): HTMLElement {
  const caps = keys.flatMap((key, i) => (i === 0 ? [h("kbd", {}, key)] : [" ", h("kbd", {}, key)]));
  return h("li", {}, h("span", { class: "keys" }, ...caps), h("span", {}, text));
}

function card(onDismiss: () => void): HTMLElement {
  const dismiss = h("button", { type: "button", class: "primary", "data-testid": "onboarding-dismiss" }, "Got it");
  dismiss.addEventListener("click", onDismiss);
  const demo = h("a", { href: DEMO_URL, target: "_blank", rel: "noopener noreferrer", "data-testid": "onboarding-demo" }, "Open the demo pages");
  return h("section", { class: "onboarding", "aria-labelledby": "onboarding-title", "data-testid": "onboarding" },
    h("h2", { id: "onboarding-title" }, "Welcome to Ghost"),
    h("p", {}, "Ghost predicts what you are about to do on a page and shows it as a ghost: gray text inside the field you are about to fill, and a translucent cursor on the control you are about to use. Nothing happens until you accept it."),
    h("ul", { class: "key-list" },
      keyRow(["Tab"], "Accept the ghost and move to the next one. With no ghost on screen, Tab works as usual."),
      keyRow(["Esc"], "Dismiss the ghost. Typing in the field also overrides it."),
      keyRow(["Hold", "Tab"], "Accept every remaining confident ghost. It always stops at a locked action."),
      keyRow(["Enter"], "Locked actions (submit, send, pay, delete) show a lock and only run on your own Enter or click."),
    ),
    h("h3", {}, "Privacy promises"),
    h("ul", { class: "promises" },
      h("li", {}, "Password, card and government ID fields are never read, predicted, filled or learned."),
      h("li", {}, "API keys stay on the local Ghost server. The extension holds none."),
      h("li", {}, "Form mapping sends field labels and the names of your facts, never their values."),
      h("li", {}, "Ghosts only appear above your confidence threshold. A wrong ghost is worse than no ghost."),
    ),
    h("div", { class: "row" }, dismiss, demo, h("span", { class: "muted small" }, "Start the server and demo pages with pnpm dev.")),
  );
}

/** Shows the card until it has been dismissed once. `reopen` brings it back on request. */
export async function mountOnboarding(host: HTMLElement, reopen?: HTMLElement | null): Promise<void> {
  const hide = (): void => {
    host.replaceChildren();
    void writeLocal(ONBOARDED_KEY, true).catch(() => undefined);
  };
  const show = (): void => host.replaceChildren(card(hide));
  reopen?.addEventListener("click", () => {
    show();
    host.scrollIntoView?.({ block: "start" });
  });
  const seen = await readLocal(ONBOARDED_KEY).catch(() => false);
  if (seen !== true) show();
}
