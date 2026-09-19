/**
 * Styles for the loop proposal sheet (docs/loops.md 3.4). Same palette as overlay-style.ts: dark translucent
 * surfaces, the purple accent, amber for anything locked. Colors are "r g b" triplets so alpha can vary per use.
 */
const SANS = `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
const EASE = "cubic-bezier(.2,.8,.2,1)";

/** One below the overlay host, so the ghost cursor of a visible run glides over the sheet. */
export const LOOP_HOST_CSS = "display:block;position:fixed;left:0;right:0;bottom:0;z-index:2147483646;pointer-events:none;";

export const LOOP_PANEL_CSS = `
:host { all: initial; }
.dock {
  --accent: 124 92 255;
  --lock: 245 165 36;
  --ok: 126 226 168;
  --bad: 255 140 140;
  display: flex; justify-content: center; box-sizing: border-box; padding: 0 16px 16px;
  pointer-events: none; font-family: ${SANS}; -webkit-font-smoothing: antialiased;
}
.sheet {
  pointer-events: auto; box-sizing: border-box; width: min(1040px, 100%); max-height: max(300px, min(60vh, 560px));
  display: flex; flex-direction: column; overflow: hidden; outline: none;
  color: rgba(255,255,255,.92); background: rgba(16,14,26,.93);
  border: 1px solid rgba(255,255,255,.1); border-radius: 16px;
  -webkit-backdrop-filter: blur(16px) saturate(1.4); backdrop-filter: blur(16px) saturate(1.4);
  box-shadow: 0 0 0 1px rgb(var(--accent) / .22), 0 -6px 50px -18px rgb(var(--accent) / .55), 0 24px 60px -20px rgba(6,4,24,.8);
  transition: transform 240ms ${EASE}, opacity 180ms ease, visibility 0s linear 0s;
}
.sheet[data-open="false"] {
  transform: translateY(28px); opacity: 0; visibility: hidden; pointer-events: none;
  transition: transform 200ms ease, opacity 160ms ease, visibility 0s linear 200ms;
}
/* Smaller during a run, so a visible run stays watchable behind it. */
.sheet[data-view="running"] { max-height: max(240px, min(40vh, 380px)); }

/* ---------- header ---------- */
.top, .progress, .report, .foot { flex: 0 0 auto; }
.top { display: flex; align-items: flex-start; gap: 14px; padding: 16px 18px 12px; }
.brand {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; margin-top: 2px; padding: 4px 9px 4px 8px;
  border-radius: 999px; font: 700 11px/1.2 ${SANS}; letter-spacing: .02em;
  background: rgb(var(--accent) / .16); border: 1px solid rgb(var(--accent) / .4);
}
.brand .dot { width: 7px; height: 7px; border-radius: 50%; background: rgb(var(--accent)); box-shadow: 0 0 8px rgb(var(--accent)); }
.titles { flex: 1 1 auto; min-width: 0; }
.headline { margin: 0; font: 650 16px/1.3 ${SANS}; letter-spacing: -.01em; color: #fff; }
.name { margin: 3px 0 0; font: 400 12.5px/1.4 ${SANS}; color: rgba(255,255,255,.62); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-note {
  flex: 0 0 auto; margin-top: 4px; font: 500 11px/1.2 ${MONO}; color: rgba(255,255,255,.55); white-space: nowrap;
}
.preview-note[data-streaming="true"] { color: rgb(var(--accent)); filter: brightness(1.5); animation: loop-breathe 1.2s ease-in-out infinite; }

/* ---------- progress + report ---------- */
.progress, .report { display: none; padding: 0 18px 12px; }
.sheet[data-view="running"] .progress, .sheet[data-view="done"] .progress, .sheet[data-view="failed"] .progress { display: flex; align-items: center; gap: 12px; }
.sheet[data-view="done"] .report, .sheet[data-view="failed"] .report { display: block; }
.bar { flex: 1 1 auto; height: 6px; border-radius: 999px; overflow: hidden; background: rgba(255,255,255,.1); }
.fill {
  height: 100%; width: 0%; border-radius: inherit;
  background: linear-gradient(90deg, rgb(var(--accent)), rgb(168 142 255));
  box-shadow: 0 0 12px rgb(var(--accent) / .8); transition: width 200ms ease;
}
.sheet[data-view="done"] .fill { background: rgb(var(--ok)); box-shadow: 0 0 12px rgb(var(--ok) / .6); }
.sheet[data-view="failed"] .fill { background: rgb(var(--bad)); box-shadow: none; }
.progress-text { flex: 0 0 auto; font: 600 11px/1 ${MONO}; color: rgba(255,255,255,.75); }
.summary { margin: 0; font: 500 12.5px/1.5 ${SANS}; color: rgba(255,255,255,.85); }
.failures, .effects-list { margin: 6px 0 0; padding: 0; list-style: none; }
.failures li {
  padding: 6px 10px; margin-top: 4px; border-radius: 8px; font: 500 12px/1.4 ${SANS};
  color: #ffc9c9; background: rgb(var(--bad) / .1); border: 1px solid rgb(var(--bad) / .3);
}
.failures:empty { display: none; }

/* ---------- grid ---------- */
.grid-wrap {
  flex: 1 1 auto; min-height: 72px; overflow: auto; margin: 0 10px; border-radius: 10px;
  background: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.07);
  scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.22) transparent;
}
.grid { width: 100%; border-collapse: separate; border-spacing: 0; font: 400 12px/1.3 ${SANS}; }
.grid th {
  position: sticky; top: 0; z-index: 1; padding: 8px 10px; text-align: left; white-space: nowrap;
  font: 600 10.5px/1.2 ${SANS}; letter-spacing: .06em; text-transform: uppercase;
  color: rgba(255,255,255,.55); background: rgba(24,21,38,.98); border-bottom: 1px solid rgba(255,255,255,.09);
}
.grid td {
  padding: 7px 10px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  border-bottom: 1px solid rgba(255,255,255,.05); color: rgba(255,255,255,.88);
}
.grid tr:last-child td { border-bottom: 0; }
.grid .pick { width: 30px; padding-right: 0; }
.grid .num { width: 34px; color: rgba(255,255,255,.4); font: 500 11px/1.3 ${MONO}; }
.grid .item { color: rgba(255,255,255,.7); }
.grid .val { font-variant-numeric: tabular-nums; }
.grid .note { color: rgb(var(--lock)); font-weight: 500; }
.grid tbody tr { animation: loop-row-in 220ms ease both; }
.grid tbody tr:hover td { background: rgba(255,255,255,.03); }
.grid tr[data-included="false"] { display: none; }

/* A value that has not streamed in yet. */
.val[data-pending="true"]::after {
  content: ""; display: block; width: 62%; height: 9px; border-radius: 5px;
  background: linear-gradient(100deg, rgba(255,255,255,.07) 30%, rgb(var(--accent) / .35) 50%, rgba(255,255,255,.07) 70%);
  background-size: 250% 100%; animation: loop-shimmer 1.3s linear infinite;
}
.val[data-missing="true"] { color: rgb(var(--lock) / .85); font-style: italic; }

/* Low confidence: amber rail, amber tint, unchecked. */
.grid tr[data-flag="low"] td, .grid tr[data-flag="missing"] td { background: rgb(var(--lock) / .07); }
.grid tr[data-flag="low"] td:first-child, .grid tr[data-flag="missing"] td:first-child { box-shadow: inset 3px 0 0 rgb(var(--lock)); }
.grid tr[data-flag="missing"] .item, .grid tr[data-flag="missing"] .val { opacity: .6; }

input[type="checkbox"] {
  appearance: none; -webkit-appearance: none; width: 15px; height: 15px; margin: 0; vertical-align: middle; cursor: pointer;
  border-radius: 4px; border: 1.5px solid rgba(255,255,255,.35); background: transparent; transition: background 120ms ease, border-color 120ms ease;
}
input[type="checkbox"]:checked { border-color: rgb(var(--accent)); background: rgb(var(--accent)); }
/* A glyph, not a data: image: url() loads answer to the page's img-src policy, constructed sheets do not. */
input[type="checkbox"]:checked::before {
  content: "\\2713"; display: block; color: #fff; font: 800 11px/12px ${SANS}; text-align: center;
}
input[type="checkbox"]:indeterminate { border-color: rgb(var(--accent)); background: rgb(var(--accent) / .45); }
input[type="checkbox"]:indeterminate::before {
  content: ""; display: block; width: 7px; height: 2px; margin: 5px auto 0; border-radius: 1px; background: #fff;
}
input[type="checkbox"]:disabled { opacity: .35; cursor: not-allowed; }
input[type="checkbox"]:focus-visible, button:focus-visible { outline: 2px solid rgb(var(--accent)); outline-offset: 2px; }

/* Run status replaces the checkbox once a run starts. */
.status { display: none; width: 15px; height: 15px; box-sizing: border-box; border-radius: 50%; font: 700 11px/15px ${SANS}; text-align: center; }
.sheet:not([data-view="proposed"]) .pick input { display: none; }
.sheet:not([data-view="proposed"]) .status { display: inline-block; }
.status[data-status="pending"] { border: 1.5px solid rgba(255,255,255,.25); }
.status[data-status="running"] { border: 2px solid rgb(var(--accent) / .3); border-top-color: rgb(var(--accent)); animation: loop-spin .7s linear infinite; }
.status[data-status="done"] { background: rgb(var(--ok) / .18); color: rgb(var(--ok)); }
.status[data-status="done"]::before { content: "\\2713"; }
.status[data-status="failed"] { background: rgb(var(--bad) / .2); color: rgb(var(--bad)); }
.status[data-status="failed"]::before { content: "\\2715"; }
.status[data-status="skipped"]::before { content: "\\2013"; color: rgba(255,255,255,.4); }
.grid tr[data-status="running"] td { background: rgb(var(--accent) / .1); }
.grid tr[data-status="failed"] td { background: rgb(var(--bad) / .08); }

/* ---------- footer ---------- */
.foot { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 12px 18px 16px; }
.modes { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 3px; border-radius: 11px; background: rgba(255,255,255,.06); }
.mode {
  display: inline-flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 11px; cursor: pointer;
  border: 1px solid transparent; border-radius: 8px; background: transparent; color: rgba(255,255,255,.72); font: 600 12px/1.2 ${SANS};
}
.mode:hover:not(:disabled) { color: #fff; background: rgba(255,255,255,.06); }
.mode[aria-checked="true"] { color: #fff; background: rgb(var(--accent) / .3); border-color: rgb(var(--accent) / .6); }
.mode:disabled { cursor: not-allowed; color: rgba(255,255,255,.35); }
.mode .reason { font: 400 10px/1.2 ${SANS}; color: rgba(255,255,255,.38); }
.mode .reason:empty { display: none; }

.effects {
  flex: 1 1 260px; min-width: 0; display: flex; align-items: flex-start; gap: 8px; padding: 8px 11px; border-radius: 10px;
  color: #ffdf9e; background: rgba(30,21,6,.72); border: 1px solid rgb(var(--lock) / .45);
}
.effects[hidden] { display: none; }
.effects svg { flex: 0 0 auto; margin-top: 1px; color: rgb(var(--lock)); }
.effects-title { font: 600 10.5px/1.2 ${SANS}; letter-spacing: .06em; text-transform: uppercase; color: rgb(var(--lock) / .9); }
.effects-list { margin-top: 3px; }
.effects-list li { font: 500 12px/1.45 ${SANS}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.actions { flex: 1 0 auto; display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.hint { margin-right: 4px; font: 500 11px/1 ${SANS}; color: rgba(255,255,255,.5); white-space: nowrap; }
kbd {
  font: 700 10px/1 ${SANS}; padding: 3px 6px 2px; margin: 0 3px; border-radius: 5px;
  color: rgba(74,58,150,.95); background: linear-gradient(#ffffff, #e9e4fb); border-bottom: 2px solid rgb(var(--accent) / .55);
}
button { font-family: ${SANS}; }
.btn {
  display: inline-flex; align-items: center; gap: 7px; padding: 9px 14px; cursor: pointer; white-space: nowrap;
  border-radius: 10px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06);
  color: rgba(255,255,255,.85); font: 600 12.5px/1 ${SANS}; transition: background 120ms ease, transform 120ms ease;
}
.btn:hover:not(:disabled) { background: rgba(255,255,255,.12); }
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:disabled { cursor: not-allowed; opacity: .45; }
/* The one locked control: amber, like every lock in Ghost. */
.confirm {
  color: #2a1c02; border-color: #b97a0c; border-bottom-width: 2px; background: linear-gradient(#ffe3a6, #f5b942);
  box-shadow: 0 8px 22px -8px rgb(var(--lock) / .7);
}
.confirm:hover:not(:disabled) { background: linear-gradient(#ffeabb, #f8c252); }
.confirm:focus-visible { outline-color: rgb(var(--lock)); box-shadow: 0 0 0 5px rgb(var(--lock) / .25), 0 8px 22px -8px rgb(var(--lock) / .7); }
.confirm svg { display: block; }

.cancel, .close { display: none; }
.sheet[data-view="running"] .cancel { display: inline-flex; }
.sheet[data-view="done"] .close, .sheet[data-view="failed"] .close { display: inline-flex; }
.sheet:not([data-view="proposed"]) :is(.modes, .later, .confirm, .hint, .preview-note) { display: none; }
.sheet[data-view="running"] .effects { display: none; }

@keyframes loop-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -50% 0; } }
@keyframes loop-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
@keyframes loop-spin { to { transform: rotate(360deg); } }
@keyframes loop-row-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

@media (max-width: 640px) {
  .top { flex-wrap: wrap; }
  .actions { flex: 1 1 100%; }
  .hint { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .sheet, .fill, .btn { transition: none !important; }
  .grid tbody tr, .val[data-pending="true"]::after, .preview-note, .status { animation: none !important; }
}
`;

/** Padlock glyph shared by the confirm button and the irreversible list (same drawing as the overlay's lock badge). */
export const PADLOCK = {
  viewBox: "0 0 16 16",
  body: { x: "3", y: "7", width: "10", height: "7.5", rx: "2", fill: "currentColor" },
  shackle: { d: "M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round" },
} as const;
