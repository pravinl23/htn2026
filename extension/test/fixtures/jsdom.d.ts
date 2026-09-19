// jsdom ships no types and this package adds no dependencies: declare the one constructor the loop tests use
// (a second window, so frame documents live in another realm exactly like a real iframe's contentDocument).
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    readonly window: Window & typeof globalThis;
  }
}
