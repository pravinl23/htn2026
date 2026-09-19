export {};

declare global {
  interface Window {
    /** Set to true by a demo page once its irreversible action (submit, send) really ran. */
    __submitted?: boolean;
    /** Current values of the demo page's form, keyed by control name. */
    __formState?: Record<string, unknown>;
  }
}
