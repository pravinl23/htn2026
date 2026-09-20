// The `keys` port the controller reads (docs/accept-key.md), in the two shapes tests need.
//
// Most controller tests are about the WALK: does Tab accept, advance, stop at a lock, refuse a sensitive
// field. They are not about which key an origin ends up taking, so they pin the answer with `TAB_KEYS` -
// an origin already watched and found to leave Tab alone - and stay readable. Tests that ARE about key
// ownership use `watchedKeys()`, which starts on a brand-new origin ("unknown"), records the probes the
// controller reports, and can be flipped the way the shared store flips one.
import type { TabProbe, TabState } from "@ghost/shared";
import { DEFAULT_KEY_PREFS } from "../src/content/acceptKey";
import type { KeyPrefs } from "../src/content/acceptKey";
import type { KeyPort } from "../src/content/controller";

/** What the controller hands `observe()`: one watched Tab press, before the store adds the origin. */
export type WatchedProbe = Omit<TabProbe, "origin" | "appId">;

/**
 * Tab accepts here: the user chose plain Tab everywhere AND the origin has been watched and found free, so
 * neither setting nor observation is what the test is measuring.
 */
export const TAB_KEYS: KeyPort = {
  prefs: (): KeyPrefs => ({ ...DEFAULT_KEY_PREFS, acceptKey: "tab" }),
  tabState: (): TabState => "free",
  observe: () => undefined,
};

export interface WatchedKeys extends KeyPort {
  /** Every Tab press the controller watched instead of intercepting, oldest first. */
  readonly probes: WatchedProbe[];
  /** What the store would say now. Set it to stand in for a verdict the shared store reached. */
  state: TabState;
  prefs(): KeyPrefs;
}

/**
 * A live port for the accept-key rules themselves: `acceptKey: "auto"` (the default) on an origin whose Tab
 * has never been watched. Nothing is intercepted until `state` says "free".
 */
export function watchedKeys(state: TabState = "unknown", prefs: Partial<KeyPrefs> = {}): WatchedKeys {
  const port: WatchedKeys = {
    probes: [],
    state,
    prefs: () => ({ ...DEFAULT_KEY_PREFS, ...prefs }),
    tabState: () => port.state,
    observe: (probe) => {
      port.probes.push(probe);
    },
  };
  return port;
}

/**
 * One tap of the Ghost key: right Option down, nothing in between, up (docs/accept-key.md section 3).
 * Returns the keyup, which is the half that accepts, so a test can assert it was swallowed.
 */
export function ghostKeyTap(target: EventTarget = document.activeElement ?? document.body): KeyboardEvent {
  const init = { key: "Alt", code: "AltRight", location: 2, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  const up = new KeyboardEvent("keyup", init);
  target.dispatchEvent(up);
  return up;
}
