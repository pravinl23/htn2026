// JavaScriptCore is not a browser and is not Node: it has no TextEncoder. The shared rules that measure a file in
// BYTES probe for one (`typeof TextEncoder === "function"`) and fall back to the string length, which is exactly
// right here because the bundle is ASCII-keyed JSON. This declares the probe, not a dependency: nothing in the
// core bundle may assume the global exists.
declare const TextEncoder: (new () => { encode(input: string): { length: number } }) | undefined;
