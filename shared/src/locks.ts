const IRREVERSIBLE = new RegExp(
  [
    "submit", "send", "\\bpay\\b", "pay now", "place (my |your )?order", "order now", "\\bbuy\\b", "purchase",
    "check ?out", "delete", "remove", "discard", "confirm", "apply now", "\\bapply\\b", "publish", "\\bpost\\b",
    "transfer", "withdraw", "\\bsign\\b", "unsubscribe", "cancel (my |your )?(subscription|order|account)",
    "book now", "reserve", "donate", "finish", "complete",
  ].join("|"),
  "i",
);

export interface LockProbe {
  text: string;
  /** type attribute of a button or input ("submit", "button", "reset"...). */
  buttonType?: string;
  /** True when the element or an ancestor carries data-ghost-lock. */
  markedLocked?: boolean;
  /** True when the button is the default submit button of a form. */
  insideForm?: boolean;
}

/** Rule 2: irreversible actions need an explicit Enter or click. When in doubt, lock. */
export function isLockedAction(p: LockProbe): boolean {
  if (p.markedLocked) return true;
  const type = (p.buttonType ?? "").toLowerCase();
  if (type === "submit" || type === "reset") return true;
  if (p.insideForm && type === "") return true; // <button> inside a form defaults to submit
  return IRREVERSIBLE.test(p.text);
}
