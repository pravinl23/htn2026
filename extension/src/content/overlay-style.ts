/** Styles for the overlay shadow root. Colors are "r g b" triplets so alpha can vary per use. */
const SANS = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
const GLIDE = "180ms cubic-bezier(.2,.8,.2,1)";

export const OVERLAY_CSS = `
:host { all: initial; }
.layer {
  --accent: 124 92 255;
  --lock: 245 165 36;
  position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  font-family: ${SANS}; -webkit-font-smoothing: antialiased;
}

/* Ghost text: sits exactly over the field's own text box. */
.ghost {
  position: absolute; left: 0; top: 0; box-sizing: border-box; overflow: hidden;
  display: flex; align-items: center;
  color: rgba(120,120,135,.75); opacity: .62;
  transition: opacity 160ms ease;
}
.ghost[data-status="current"] { opacity: 1; }
.ghost[data-streaming="true"] .label { animation: ghost-stream 1.1s ease-in-out infinite; }
.ghost .label { flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: pre; }
.ghost[data-mode="multiline"] { align-items: flex-start; }
.ghost[data-mode="multiline"] .label { white-space: pre-wrap; overflow-wrap: anywhere; }

/* Pill: used where ghost text cannot live inside the control (select, radio, checkbox). */
.ghost[data-mode="pill"] {
  overflow: visible; opacity: 1; gap: 6px; max-width: 260px; padding: 2px 9px;
  border-radius: 999px; border: 1px solid rgba(120,120,135,.3);
  background: #f5f4fb; color: rgba(88,86,104,.95);
  font: 500 12px/18px ${SANS}; white-space: nowrap;
  box-shadow: 0 1px 2px rgba(24,16,64,.06);
}
.ghost[data-mode="pill"][data-status="current"] {
  border-color: rgb(var(--accent) / .45);
  box-shadow: 0 4px 14px -6px rgb(var(--accent) / .55);
}
.ghost[data-mode="pill"] .label { text-overflow: ellipsis; }
.ghost[data-mode="pill"][data-status="pending"] .label { opacity: .7; }

.keycap {
  display: none; flex: 0 0 auto; margin-left: 8px; padding: 3px 6px 2px;
  font: 600 10px/1 ${SANS}; letter-spacing: .03em; text-transform: none; text-indent: 0;
  color: rgba(74,58,150,.95); background: linear-gradient(#ffffff, #f0edfb);
  border: 1px solid rgb(var(--accent) / .38); border-bottom-width: 2px; border-radius: 5px;
  box-shadow: 0 1px 2px rgba(24,16,64,.14);
}
.ghost[data-status="current"] .keycap { display: inline-block; }
.ghost[data-mode="pill"] .keycap { margin-left: 2px; margin-right: -4px; }
.ghost[data-mode="multiline"] .keycap { margin-top: 1px; }

/* Highlight ring around the current target. */
.ring {
  position: absolute; left: 0; top: 0; box-sizing: border-box; opacity: 0; border-radius: 8px;
  box-shadow:
    0 0 0 1.5px rgb(var(--accent) / .72),
    0 0 0 5px rgb(var(--accent) / .16),
    0 8px 26px -8px rgb(var(--accent) / .5);
  transition: transform ${GLIDE}, width ${GLIDE}, height ${GLIDE}, opacity 140ms ease;
}

/* The ghost cursor: translucent pointer with a soft glow. */
.cursor {
  position: absolute; left: 0; top: 0; width: 28px; height: 28px; opacity: 0;
  will-change: transform;
  transition: transform ${GLIDE}, opacity 160ms ease;
}
.cursor .halo {
  position: absolute; left: -12px; top: -13px; width: 34px; height: 34px; border-radius: 50%;
  background: radial-gradient(circle, rgb(var(--accent) / .38), rgb(var(--accent) / 0) 68%);
  animation: ghost-pulse 1.9s ease-out infinite;
}
.cursor svg {
  position: relative; display: block; overflow: visible;
  filter: drop-shadow(0 0 7px rgb(var(--accent) / .62)) drop-shadow(0 3px 6px rgba(24,16,64,.28));
  animation: ghost-float 2.8s ease-in-out infinite;
}
.cursor .body { stroke: rgb(var(--accent) / .95); }

.lock {
  position: absolute; left: 0; top: 0; display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px 5px 8px; border-radius: 999px; white-space: nowrap; opacity: 0;
  font: 600 11px/1 ${SANS}; color: #ffdf9e; background: rgba(30,21,6,.9);
  border: 1px solid rgb(var(--lock) / .6);
  box-shadow: 0 8px 22px -8px rgb(var(--lock) / .6);
  transition: transform ${GLIDE}, opacity 160ms ease;
}
.lock svg { display: block; color: rgb(var(--lock)); }
.lock kbd {
  font: 700 10px/1 ${SANS}; padding: 2px 5px 1px; margin-right: 1px; border-radius: 4px;
  color: #2a1c02; background: linear-gradient(#ffe3a6, #f5b942); border-bottom: 1.5px solid #b97a0c;
}

.ring[data-visible="true"], .cursor[data-visible="true"], .lock[data-visible="true"] { opacity: 1; }
.ring[data-locked="true"], .cursor[data-locked="true"] { --accent: var(--lock); }
/* Repositioning on scroll must track the page exactly; only a change of target glides. */
.still { transition-property: opacity !important; }

.hud {
  position: absolute; right: 14px; bottom: 14px; max-width: calc(100% - 28px); display: none;
  flex-direction: column; align-items: flex-end; gap: 6px;
}
.hud[data-visible="true"] { display: flex; }
.hud-main, .hud-error {
  display: flex; align-items: center; gap: 12px; padding: 7px 12px; border-radius: 11px;
  box-sizing: border-box; max-width: 100%; overflow: hidden; white-space: nowrap;
  font: 500 11px/1.2 ${MONO}; color: rgba(255,255,255,.92);
  background: rgba(16,14,26,.86); border: 1px solid rgba(255,255,255,.1);
  -webkit-backdrop-filter: blur(10px) saturate(1.4); backdrop-filter: blur(10px) saturate(1.4);
  box-shadow: 0 12px 32px -12px rgba(10,6,40,.65);
}
.hud-main[hidden], .hud-error[hidden] { display: none; }
.hud-error { color: #ffb4b4; border-color: rgba(255,120,120,.4); max-width: 320px; }
.hud .brand { display: flex; align-items: center; gap: 6px; font: 700 11px/1.2 ${SANS}; letter-spacing: .02em; }
.hud .dot { width: 7px; height: 7px; border-radius: 50%; background: rgb(var(--accent)); box-shadow: 0 0 8px rgb(var(--accent)); }
.hud .k { color: rgba(255,255,255,.48); margin-right: 5px; }
.hud [data-cache="hit"] .v { color: #7ee2a8; }
.hud [data-cache="miss"] .v { color: #ffd58a; }
.hud [data-cache="offline"] .v { color: #b9b4d0; }

@keyframes ghost-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2px); } }
@keyframes ghost-pulse { 0% { transform: scale(.7); opacity: .9; } 100% { transform: scale(1.35); opacity: 0; } }
@keyframes ghost-stream { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }

@media (prefers-reduced-motion: reduce) {
  .ring, .cursor, .lock, .ghost { transition: none !important; }
  .cursor svg, .cursor .halo, .ghost .label { animation: none !important; }
  .cursor .halo { opacity: .6; }
}
`;

/**
 * Injected into the page itself: the field's own placeholder would show through the ghost text. Date,
 * month and time inputs draw theirs ("---------- ----") in ::-webkit-datetime-edit, not ::placeholder.
 */
export const PAGE_CSS = `
[data-ghost-hint]::placeholder { color: transparent !important; }
[data-ghost-hint]::-webkit-datetime-edit { color: transparent !important; }
`;

export const CURSOR_PATH = "M5 3.5 L5 21.5 L10.2 16.9 L13.6 24.6 L17 23.1 L13.7 15.6 L20.5 15.2 Z";
/** Where the pointer's tip sits inside the 28x28 cursor box. */
export const CURSOR_TIP = { x: 5, y: 3.5 };
