// View-only objects: undoing a filter or a sort changes nothing but what is on screen.
const VIEW_ONLY = "(?! (all |this |the |these )?(filters?|sort(ing)?|search( terms?)?|highlight(s|ing)?|zoom|view|layout)\\b)";

const MONEY = [
  "\\bpay\\b", "make (a |my |your )?payment", "place (my |your |the |an? )?(order|bid|bet|trade)", "order (now|again)", "\\bbuy\\b",
  "purchase", "check ?out", "subscribe", "upgrade", "downgrade", "start (my |your |a |free )*trial", "donate", "transfer", "withdraw", "deposit",
  "refund", "\\bcharge\\b", "redeem", "\\bsell\\b", "\\bbid\\b", "\\btrade\\b", "\\bbook\\b", "reserve",
];
const DESTROY = [
  "delete", `\\bremove\\b${VIEW_ONLY}`, "discard", "\\berase\\b", "\\bwipe\\b", "destroy", "purge", "(move|send) to (the )?(trash|bin)",
  "empty (the )?(trash|bin|cart|recycle)", `clear all${VIEW_ONLY}`, `\\breset\\b${VIEW_ONLY}`, "overwrite", "replace all",
  "deactivate", "terminate", "revoke", "unlink", "disconnect", "\\b(un)?install\\b",
  "cancel (my |your |this |the )?(subscription|order|account|booking|reservation|membership|plan|appointment|trip|flight|ticket|payment|transfer|application|event|meeting)",
  "close (my |your |this |the )?(account|issue|pull request|pr|ticket)", "drop (table|database|course|class)",
];
const COMMIT = [
  "submit", "\\b(re)?send\\b", "confirm", `\\bapply\\b${VIEW_ONLY}`, "publish", "\\bpost\\b(?! ?code)", "\\btweet\\b", "\\bcomment\\b", "\\binvite\\b",
  "\\bvote\\b", "rsvp", "\\bhire\\b", "finish", "\\bcomplete", "\\bproceed\\b", "^yes\\b", "^ok(ay)?$",
];
const ACCOUNT = ["\\bsign\\b", "sign ?(up|out|off)", "log ?(out|off)", "\\bregist(er|ration)\\b", "create (my |your |an? )?account", "\\bjoin\\b", "\\benrol"];
const CONSENT = ["\\bagree\\b", "accept", "\\bconsent\\b", "\\ballow\\b", "authori[sz]e", "\\bgrant\\b", "approve", "\\breject\\b", "decline", "\\bdeny\\b"];
const OPERATE = [
  "\\bmerg(e|ing)\\b", "\\b(re)?deploy\\b", "\\brelease\\b", "\\bpush\\b", "\\brevert\\b", "roll ?back", "\\bship\\b", "\\blaunch\\b", "go live",
  "\\brun\\b", "\\bexecute\\b", "restart", "reboot", "shut ?down",
];

const IRREVERSIBLE = new RegExp([...MONEY, ...DESTROY, ...COMMIT, ...ACCOUNT, ...CONSENT, ...OPERATE].join("|"), "i");

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
