// Cold start (docs/cold-start.md): the one-time local pass that turns what is already on the machine into the fact
// graph (shared/src/facts) and the habit priors (shared/src/affordance). This module is the PURE half — the consent
// plan, the extractors, the habit aggregation and the sensitivity gate. It reads no file, opens no database, asks
// for no permission and makes no network call: the native agent does all of that and hands the text and metadata in.
//
// Everything stays on the machine. Only fact KEYS ever reach the prediction server.
export * from "./plan";
export * from "./sensitiveScan";
export * from "./extract";
export * from "./habits";
export * from "./surfaces";
export * from "./graph";
