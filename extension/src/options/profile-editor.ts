// The friendly half of the profile tab: one row per fact, plus the saved essay answers.
// Every value comes from storage, so it only ever reaches the DOM through .value and textContent.
import { FACT_DESCRIPTIONS } from "@ghost/shared";
import type { PastAnswer, Profile } from "@ghost/shared";
import { h } from "./dom";
import { collectFacts } from "./validate";
import type { FactRow, ProfileParseResult } from "./validate";

export interface ProfileEditor {
  el: HTMLElement;
  show(profile: Profile): void;
  read(): ProfileParseResult;
}

const KEY_LIST_ID = "ghost-fact-keys";
const ANSWER_PREVIEW_CHARS = 280;

interface RowView extends FactRow {
  el: HTMLElement;
}

function describe(key: string): string {
  const trimmed = key.trim();
  if (trimmed.startsWith("extra.")) return "extra detail";
  const description = Object.hasOwn(FACT_DESCRIPTIONS, trimmed) ? (FACT_DESCRIPTIONS[trimmed] ?? "") : "";
  return description.toLowerCase() === trimmed.toLowerCase() ? "" : description;
}

function factRow(fact: FactRow, onChange: () => void, onRemove: (row: RowView) => void): RowView {
  const key = h("input", { type: "text", class: "text fact-key", list: KEY_LIST_ID, spellcheck: "false", placeholder: "factName", "aria-label": "Fact name" });
  const value = h("input", { type: "text", class: "text fact-value", placeholder: "Value", "aria-label": "Fact value" });
  const hint = h("small", { class: "muted fact-hint" }, describe(fact.key));
  const remove = h("button", { type: "button", class: "icon", title: "Remove fact" }, "×");
  key.value = fact.key;
  value.value = fact.value;
  const row: RowView = { key: fact.key, value: fact.value, el: h("div", { class: "fact-row", "data-testid": "fact-row" }, key, value, remove, hint) };
  const label = (): void => remove.setAttribute("aria-label", `Remove fact ${row.key || "(unnamed)"}`);
  key.addEventListener("input", () => {
    row.key = key.value;
    hint.textContent = describe(key.value);
    label();
    onChange();
  });
  value.addEventListener("input", () => {
    row.value = value.value;
    onChange();
  });
  remove.addEventListener("click", () => onRemove(row));
  label();
  return row;
}

function answerMeta(answer: PastAnswer): string {
  const saved = answer.savedAt ? new Date(answer.savedAt) : null;
  const date = saved && !Number.isNaN(saved.getTime()) ? saved.toLocaleDateString() : "";
  return [answer.origin ?? "", date].filter(Boolean).join(" · ");
}

function answerItem(answer: PastAnswer, onDelete: () => void): HTMLElement {
  const preview = answer.answer.length > ANSWER_PREVIEW_CHARS ? `${answer.answer.slice(0, ANSWER_PREVIEW_CHARS)}…` : answer.answer;
  const remove = h("button", { type: "button", class: "danger small", "data-testid": "answer-delete", "aria-label": `Delete answer to: ${answer.question.slice(0, 80)}` }, "Delete");
  remove.addEventListener("click", onDelete);
  const meta = answerMeta(answer);
  return h("li", { class: "answer", "data-testid": "past-answer" },
    h("div", { class: "row" }, h("strong", {}, answer.question), h("span", { class: "spacer" }), remove),
    h("p", {}, preview),
    ...(meta ? [h("small", { class: "muted" }, meta)] : []),
  );
}

export function createProfileEditor(onChange: () => void): ProfileEditor {
  const factList = h("div", { class: "fact-list", "data-testid": "fact-list" });
  const answers = h("ul", { class: "answers", "data-testid": "past-answers" });
  const add = h("button", { type: "button", "data-testid": "fact-add" }, "Add fact");
  const keyList = h("datalist", { id: KEY_LIST_ID }, ...Object.keys(FACT_DESCRIPTIONS).map((key) => h("option", { value: key })));
  let rows: RowView[] = [];
  let pastAnswers: PastAnswer[] = [];

  const removeRow = (row: RowView): void => {
    rows = rows.filter((r) => r !== row);
    row.el.remove();
    onChange();
  };

  const addRow = (fact: FactRow): RowView => {
    const row = factRow(fact, onChange, removeRow);
    rows.push(row);
    factList.append(row.el);
    return row;
  };

  const renderAnswers = (): void => {
    if (pastAnswers.length === 0) {
      return answers.replaceChildren(h("li", { class: "empty" }, "No saved answers yet. With learning on, essay answers you write are kept here and reused as a starting point."));
    }
    answers.replaceChildren(...pastAnswers.map((answer, index) => answerItem(answer, () => {
      pastAnswers = pastAnswers.filter((_, i) => i !== index);
      renderAnswers();
      onChange();
    })));
  };

  add.addEventListener("click", () => addRow({ key: "", value: "" }).el.querySelector("input")?.focus());

  return {
    el: h("div", { class: "profile-fields" }, keyList, factList, h("div", { class: "row" }, add), h("h3", {}, "Past answers"), answers),
    show(profile) {
      rows = [];
      factList.replaceChildren();
      for (const [key, value] of Object.entries(profile.facts)) addRow({ key, value });
      pastAnswers = [...profile.pastAnswers];
      renderAnswers();
    },
    read() {
      const result = collectFacts(rows);
      return result.ok ? { ok: true, profile: { facts: result.facts, pastAnswers: [...pastAnswers] } } : result;
    },
  };
}
