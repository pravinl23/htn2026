// The fact graph: who the user is, learned from what they already have (docs/profile-sources.md).
// Typed facts with dotted keys, labels, aliases, provenance and confidence, plus the one matcher that
// maps ANY form field against them. Pure, client-agnostic, and never leaves the machine: only fact KEYS
// ever go on the wire (`factKeysForRequest`).
export * from "./types";
export * from "./sensitivity";
export * from "./defs";
export * from "./graph";
export * from "./extract";
export * from "./match";
export * from "./migrate";
