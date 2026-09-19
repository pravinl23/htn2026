// Incremental suggestion (docs/incremental.md): requiredness, filled-ness, and the gate that keeps Ghost
// from proposing a step the page would reject. Pure and client-agnostic: the extension and the desktop
// app withhold the same Submit at the same moment.
export * from "./required";
export * from "./filled";
export * from "./gate";
