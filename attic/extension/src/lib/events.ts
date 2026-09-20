// A tiny typed emitter. The controller fires into it so metrics, learning and the trace recorder can
// subscribe without touching controller.ts. Content-script only: payloads carry profile values and
// live elements, so nothing here may ever be forwarded to the page.
import type { CapturedField, Ghost } from "@ghost/shared";

/** Where the ghosts on screen came from: the instant offline pass, the per-site cache, or the server. */
export type PredictionSource = "offline" | "cache" | "server";

export interface GhostEventMap {
  /** Ghosts that were not on this page before. `count` leaves out the locked Submit ghost. */
  "ghosts:shown": { count: number; source: PredictionSource };
  /** `ms` is how long the write took, verification included. */
  "ghost:accepted": { ghost: Ghost; field: CapturedField; ms: number };
  "ghost:dismissed": { ghost: Ghost; reason: "escape" | "typed" | "refused" };
  /** A trusted edit the user committed (change or blur, never per keystroke). Never fired for a sensitive field. */
  "user:input": { field: CapturedField; value: string; el: HTMLElement };
  /** The walk has nothing unlocked left: it is parked on the locked Submit, or it ran out of ghosts. */
  "walk:finished": undefined;
}

export type GhostEventType = keyof GhostEventMap;
export type GhostEventHandler<K extends GhostEventType> = (payload: GhostEventMap[K]) => void;
type EmitArgs<K extends GhostEventType> = GhostEventMap[K] extends undefined ? [] : [payload: GhostEventMap[K]];

export interface GhostEmitter {
  /** Returns the unsubscribe function. */
  on<K extends GhostEventType>(type: K, handler: GhostEventHandler<K>): () => void;
  emit<K extends GhostEventType>(type: K, ...args: EmitArgs<K>): void;
  /** Drops every subscriber (tests, and a retired content script). */
  clear(): void;
}

export function createEmitter(): GhostEmitter {
  const handlers = new Map<GhostEventType, Set<(payload: never) => void>>();
  return {
    on(type, handler) {
      const set = handlers.get(type) ?? new Set();
      handlers.set(type, set);
      set.add(handler);
      return () => void set.delete(handler);
    },
    emit(type, ...args) {
      for (const handler of [...(handlers.get(type) ?? [])]) {
        try {
          (handler as (payload: unknown) => void)(args[0]);
        } catch (error) {
          console.debug(`[ghost] a ${type} subscriber threw`, error); // a broken subscriber must never stop the walk
        }
      }
    },
    clear: () => handlers.clear(),
  };
}

/** The one emitter of this content script. Subscribe here; only the controller emits. */
export const ghostEvents: GhostEmitter = createEmitter();
