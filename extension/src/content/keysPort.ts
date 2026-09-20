// The content script's half of the accept-key store (docs/accept-key.md section 2).
//
// Nothing here decides anything: the DECISION is `acceptKeyFor` in shared/src/keys/policy.ts and the COUNTING is
// the shared `KeyMemory`. What lives here is the wiring the controller cannot do for itself - which origin this
// page is, an in-memory copy of that origin's record the controller can read in the same turn it writes one, and
// the write-behind to `ghost.keys` so a verdict outlives the page load that earned it.
//
// Without this, `tabState()` answers "unknown" forever: the controller keeps probing until it hits MAX_PROBES and
// then leaves Tab to the page for good, so a form walk dies six presses in. The observation only means something
// if it is remembered (doc section 2: "observe, then remember").
import { KeyMemory } from "@ghost/shared";
import type { SiteId, TabProbe, TabState } from "@ghost/shared";
import { getKeys, recordTabProbe } from "../lib/storage";
import type { StoredKeys } from "../lib/storage";
import { DEFAULT_KEY_PREFS, originOf } from "./acceptKey";
import type { KeyPrefs } from "./acceptKey";
import type { KeyPort } from "./controller";

export interface ContentKeyPort extends KeyPort {
  /** Scheme + host, which is the most this page is ever stored under (docs/storage.md: no URLs). */
  readonly origin: string;
  /** Reads `ghost.keys` once, at boot. */
  load(): Promise<void>;
  /** Takes on a change someone else wrote: the options page, or another tab watching the same origin. */
  adopt(stored: StoredKeys): void;
}

export interface KeyPortDeps {
  doc?: Document;
  read?: () => Promise<StoredKeys>;
  persist?: (probe: TabProbe) => Promise<unknown>;
}

/** Total Tab presses watched on one origin, which is how far along a record is. */
function probesFor(memory: KeyMemory, id: SiteId): number {
  const { probes } = memory.get(id);
  return probes.free + probes.taken;
}

export function createKeyPort(deps: KeyPortDeps = {}): ContentKeyPort {
  const doc = deps.doc ?? document;
  const read = deps.read ?? getKeys;
  const persist = deps.persist ?? recordTabProbe;
  const origin = originOf(doc);
  const id: SiteId = { origin };
  let prefs: KeyPrefs = { ...DEFAULT_KEY_PREFS };
  let memory = new KeyMemory();

  const adopt = (stored: StoredKeys): void => {
    prefs = { acceptKey: stored.acceptKey, ghostKey: stored.ghostKey };
    const next = KeyMemory.fromJSON(stored.memory);
    // A probe already applied here but not yet written back must not be undone by a change someone else wrote in
    // between - the options page saving a preference read `ghost.keys` before our write landed. Keeping the
    // record that has seen more presses costs nothing and never loses a verdict the user already paid for.
    memory = probesFor(next, id) >= probesFor(memory, id) ? next : memory;
  };

  return {
    origin,
    prefs: () => prefs,
    tabState: (): TabState => memory.tabState(id),
    observe: (probe) => {
      // Applied in memory FIRST: the controller reads `tabState()` in the same turn it calls this, so a verdict
      // that had only reached storage would come back a press too late and the walk would probe again.
      memory.recordTabProbe({ ...probe, origin });
      void persist({ ...probe, origin }).catch(() => undefined);
    },
    adopt,
    load: async (): Promise<void> => {
      adopt(await read());
    },
  };
}
