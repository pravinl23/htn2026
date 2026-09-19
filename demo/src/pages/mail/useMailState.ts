import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CHANGE_EVENT, MAIL_PREFIX, rawFingerprint, readMailState, resetIfRequested, type MailState,
} from "../../data/mailStorage";

let cached: { fingerprint: string; state: MailState } | undefined;

/** Stable between changes (useSyncExternalStore needs that), fresh after any write, clear, or reset. */
function snapshot(): MailState {
  const fingerprint = rawFingerprint();
  if (!cached || cached.fingerprint !== fingerprint) {
    cached = { fingerprint, state: readMailState() };
    window.__mail = cached.state;
  }
  return cached.state;
}

function concernsMail(event: Event): boolean {
  const key = event instanceof StorageEvent ? event.key : (event as CustomEvent<{ key?: string | null }>).detail?.key;
  return key === null || key === undefined || key.startsWith(MAIL_PREFIX); // null: the whole storage was cleared
}

function subscribe(onChange: () => void): () => void {
  const listener = (event: Event) => {
    if (!concernsMail(event)) return;
    snapshot(); // keeps window.__mail current even before React re-renders
    onChange();
  };
  window.addEventListener("storage", listener); // other tabs and iframes
  window.addEventListener(CHANGE_EVENT, listener); // this document
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

/**
 * The shared mail/calendar state, live across tabs and iframes. Honors "?reset=1" before the first render
 * and publishes the window.__mail test hook.
 */
export function useMailState(): MailState {
  useState(() => resetIfRequested(window.location.search));
  const state = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    window.__mail = state;
  }, [state]);
  return state;
}
