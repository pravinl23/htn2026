// "Learned answers": every question the user answered themselves, as Ghost will answer it next time.
// This page is the only place they exist. Nothing here has ever been sent anywhere (docs/answers.md 4 and 7).
import type { LearnedAnswer } from "@ghost/shared";
import { getLearnedAnswers, onStorageChanged, updateLearnedAnswers, updateProfile } from "../lib/storage";
import { errorMessage, flashStatus, h } from "./dom";
import { SECTION_SHOWN, type OptionsSection } from "./sections";

const CLASS_LABEL: Record<LearnedAnswer["class"], string> = {
  ordinary: "question",
  declaration: "declaration",
  protected: "protected",
};

/** A fact key the profile can hold, derived from the question. Null when the question is not a plain fact. */
export function factKeyFromQuestion(label: string): string | null {
  const words = label
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "")
    .slice(0, 4);
  if (words.length === 0) return null;
  const [first, ...rest] = words;
  const key = `${first ?? ""}${rest.map((w) => w[0]?.toUpperCase() + w.slice(1)).join("")}`;
  return /^[A-Za-z][\w]{0,63}$/.test(key) ? key : null;
}

/** "3 times · example.com, jobs.example.org" — what the options page says about where an answer came from. */
export function originSummary(answer: LearnedAnswer): string {
  const times = `${answer.count} time${answer.count === 1 ? "" : "s"}`;
  const origins = answer.origins.map(hostOf).filter((o) => o !== "");
  return origins.length === 0 ? times : `${times} · ${origins.join(", ")}`;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

async function mount(panel: HTMLElement): Promise<void> {
  const status = h("span", { class: "status", role: "status", "data-testid": "answers-status" });
  const summary = h("span", { class: "muted", "data-testid": "answers-summary" });
  const list = h("div", { class: "answers", "data-testid": "answers-list" });
  const empty = h(
    "p",
    { class: "muted", "data-testid": "answers-empty" },
    "Nothing learned yet. Correct a ghost on a form with learning switched on and the answer shows up here.",
  );

  const say = (text: string, kind: "ok" | "error" = "ok"): void => flashStatus(status, text, kind, kind === "error" ? 6000 : 2500);

  const forget = async (signature: string): Promise<void> => {
    try {
      await updateLearnedAnswers((store) => store.forget(signature));
      say("Forgotten");
    } catch (err) {
      say(`Could not forget: ${errorMessage(err)}`, "error");
    }
  };

  const forgetOrigin = async (origin: string): Promise<void> => {
    try {
      const store = await updateLearnedAnswers((s) => s.forgetOrigin(origin) > 0);
      say(`Forgot everything learned on ${hostOf(origin)}`);
      render(store.list());
    } catch (err) {
      say(`Could not forget: ${errorMessage(err)}`, "error");
    }
  };

  const promote = async (answer: LearnedAnswer): Promise<void> => {
    // A profile fact is a different thing from a learned answer in the two ways that matter here. It is
    // proposed at FACT_CONFIDENCE with no guess marking, so hold-Tab writes it on every later form; and its
    // KEY is the one profile thing that goes on the wire (`usableFactKeys` -> `factKeys`). Promoting a
    // protected characteristic or a legal declaration would turn "declined everywhere" into "disclosed
    // everywhere" behind one click, and put a key like `gender` or `areYouLegallyAuthorized` in a request.
    // Those answers stay where they are: local, per-question, and the user's to change one at a time.
    if (answer.class !== "ordinary") {
      return say(`A ${CLASS_LABEL[answer.class]} stays a learned answer: it is never promoted to a profile fact`, "error");
    }
    const key = factKeyFromQuestion(answer.label);
    if (!key) return say("That question does not make a usable fact key", "error");
    try {
      await updateProfile((profile) => ({ ...profile, facts: { ...profile.facts, [key]: answer.value } }));
      say(`Saved as the profile fact "${key}"`);
    } catch (err) {
      say(`Could not save: ${errorMessage(err)}`, "error");
    }
  };

  function row(answer: LearnedAnswer): HTMLElement {
    const forgetButton = h("button", { type: "button", class: "danger", "data-testid": `answer-forget-${answer.signature}` }, "Delete");
    forgetButton.addEventListener("click", () => void forget(answer.signature));
    const ordinary = answer.class === "ordinary";
    const promoteButton = h(
      "button",
      {
        type: "button",
        "data-testid": `answer-promote-${answer.signature}`,
        ...(ordinary ? {} : { disabled: "", title: `A ${CLASS_LABEL[answer.class]} is never promoted to a profile fact: it stays here, on this machine.` }),
      },
      "Make this a profile fact",
    );
    promoteButton.addEventListener("click", () => void promote(answer));
    const actions = [promoteButton, forgetButton];
    const origin = answer.origins.at(-1);
    if (origin) {
      const forgetSite = h("button", { type: "button", "data-testid": `answer-forget-site-${answer.signature}` }, `Forget everything from ${hostOf(origin)}`);
      forgetSite.addEventListener("click", () => void forgetOrigin(origin));
      actions.push(forgetSite);
    }
    return h(
      "div",
      { class: "answer", "data-testid": "answer-row", "data-signature": answer.signature, "data-class": answer.class },
      h("div", { class: "row" },
        h("strong", { class: "answer-question" }, answer.label || answer.signature),
        h("span", { class: "tag" }, CLASS_LABEL[answer.class]),
        h("span", { class: "spacer" }),
        h("span", { class: "muted answer-origins" }, originSummary(answer)),
      ),
      h("p", { class: "answer-value" }, answer.optionLabel ?? answer.value),
      h("div", { class: "row" }, ...actions),
    );
  }

  function render(answers: LearnedAnswer[]): void {
    // Most recently used first: that is the one the user is most likely to want to change.
    const newestFirst = [...answers].reverse();
    list.replaceChildren(...newestFirst.map(row));
    empty.hidden = newestFirst.length > 0;
    summary.textContent = `${newestFirst.length} learned answer${newestFirst.length === 1 ? "" : "s"}`;
  }

  panel.append(
    h("div", { class: "row" }, h("h2", {}, "Learned answers"), h("span", { class: "spacer" }), summary, status),
    h("p", { class: "muted" },
      "Answers you gave yourself. Ghost reuses them on every site that asks the same question, and they never leave this computer."),
    empty,
    list,
  );

  render((await getLearnedAnswers()).list());
  onStorageChanged((changes) => {
    if (changes.answers) render(changes.answers.list());
  });
  panel.addEventListener(SECTION_SHOWN, () => void getLearnedAnswers().then((store) => render(store.list())));
}

export const answersSection: OptionsSection = { id: "answers", title: "Learned answers", mount };
