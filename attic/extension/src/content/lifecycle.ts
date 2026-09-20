/**
 * Reloading or updating the extension leaves the old content script running in every open tab, but
 * orphaned: chrome.runtime.id goes undefined and no storage or runtime event ever reaches it again, so
 * it could not be switched off and would keep walking forms with a stale profile. Polling the id is
 * free; holding a port open instead would wake the service worker every time it idles out.
 */
export function extensionAlive(): boolean {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

/** Calls `onOrphan` once, as soon as the extension behind this content script is gone. Returns a cancel function. */
export function watchForOrphan(onOrphan: () => void, isAlive: () => boolean = extensionAlive, everyMs = 1000): () => void {
  const timer = setInterval(() => {
    if (isAlive()) return;
    clearInterval(timer);
    onOrphan();
  }, everyMs);
  return () => clearInterval(timer);
}
