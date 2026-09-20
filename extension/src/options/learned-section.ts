import type { LearnedAnswer } from "@ghost/shared";
import { getLearnedAnswers, onStorageChanged, updateLearnedAnswers } from "../lib/storage";
import { flashStatus, h } from "./dom";
import type { OptionsSection } from "./sections";

const PREVIEW_CHARS = 240;

function clip(value: string): string {
  return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value;
}

function meta(answer: LearnedAnswer): string {
  const date = new Date(answer.updatedAt);
  return [answer.class, `${answer.count} correction${answer.count === 1 ? "" : "s"}`, Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString()]
    .filter(Boolean)
    .join(" · ");
}

async function mount(panel: HTMLElement): Promise<void> {
  const list = h("ul", { class: "answers", "data-testid": "learned-answers" });
  const status = h("span", { class: "status", role: "status", "data-testid": "learned-status" });
  const forgetAll = h("button", { type: "button", class: "danger", "data-testid": "learned-forget-all" }, "Forget all learned answers");
  let armed = false;
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  const render = (answers: LearnedAnswer[]): void => {
    forgetAll.disabled = answers.length === 0;
    if (answers.length === 0) {
      list.replaceChildren(h("li", { class: "empty" }, "Nothing learned yet. Turn learning on, correct a form answer once, and Ghost will reuse it on matching questions across sites."));
      return;
    }
    list.replaceChildren(...answers.slice().reverse().map((answer) => {
      const remove = h("button", { type: "button", class: "danger small", "data-testid": "learned-delete", "aria-label": `Forget answer to: ${answer.label.slice(0, 80)}` }, "Forget");
      remove.addEventListener("click", () => {
        void updateLearnedAnswers((store) => store.forget(answer.signature)).then((changed) => {
          if (changed) flashStatus(status, "Learned answer forgotten");
        });
      });
      const origins = answer.origins.length > 0 ? `Seen on ${answer.origins.join(", ")}` : "Stored only on this device";
      return h("li", { class: "answer learned-answer", "data-testid": "learned-answer" },
        h("div", { class: "row" }, h("strong", {}, answer.label), h("span", { class: "spacer" }), remove),
        h("p", { class: "learned-value" }, clip(answer.optionLabel ?? answer.value)),
        h("small", { class: "muted" }, meta(answer)),
        h("small", { class: "muted learned-origin" }, origins),
      );
    }));
  };

  const refresh = async (): Promise<void> => render((await getLearnedAnswers()).list());
  onStorageChanged((changes) => {
    if (changes.answers) render(changes.answers.answers);
  });

  forgetAll.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      forgetAll.textContent = "Click again to forget everything";
      clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armed = false;
        forgetAll.textContent = "Forget all learned answers";
      }, 4_000);
      return;
    }
    armed = false;
    clearTimeout(armTimer);
    forgetAll.textContent = "Forget all learned answers";
    void updateLearnedAnswers((store) => {
      const answers = store.list();
      for (const answer of answers) store.forget(answer.signature);
      return answers.length > 0;
    }).then((changed) => {
      if (changed) flashStatus(status, "All learned answers forgotten");
    });
  });

  panel.append(
    h("div", { class: "row" }, h("h2", {}, "Learned answers"), h("span", { class: "spacer" }), status),
    h("p", { class: "muted" }, "Corrections stay in Chrome storage and are applied before any server or Jev request. Forgetting one does not change your profile."),
    list,
    h("div", { class: "row" }, forgetAll),
  );
  await refresh();
}

export const learnedSection: OptionsSection = { id: "learned", title: "Learned", mount };
