// Resume import: text or PDF -> POST /v1/profile/extract -> review table -> merge into the profile.
// The resume text lives in the textarea and nowhere else: it is never written to storage.
import { readResumeFile } from "../lib/pdfText";
import type { FileTextResult } from "../lib/pdfText";
import { getProfile, saveProfile } from "../lib/storage";
import { errorMessage, flashStatus, h } from "./dom";
import { buildReviewRows, mergeReviewRows, selectedRows } from "./resume-merge";
import type { ReviewRow } from "./resume-merge";
import type { OptionsSection } from "./sections";
import { RESUME_MAX_CHARS, extractProfile } from "./server";
import type { ServerDeps } from "./server";

export interface ResumeDeps extends ServerDeps {
  readFile?: (file: File) => Promise<FileTextResult>;
}

function factCell(row: ReviewRow): HTMLElement {
  const cell = h("td", {}, h("code", {}, row.key));
  if (row.description) cell.append(h("small", {}, row.description));
  if (!row.canonical) cell.append(h("small", {}, "Extra detail, off by default"));
  return cell;
}

function reviewRow(row: ReviewRow, onChange: () => void): { el: HTMLTableRowElement; check: HTMLInputElement } {
  const check = h("input", { type: "checkbox", "aria-label": `Save ${row.key}`, disabled: row.unchanged, "data-testid": `review-check-${row.key}` });
  check.checked = row.checked;
  check.addEventListener("change", () => {
    row.checked = check.checked;
    onChange();
  });
  const proposed = h("input", { type: "text", class: "text wide", "aria-label": `Proposed value for ${row.key}`, disabled: row.unchanged, "data-testid": `review-value-${row.key}` });
  proposed.value = row.proposed;
  proposed.addEventListener("input", () => {
    row.proposed = proposed.value;
    onChange();
  });
  const current = h("td", { class: row.current ? "current" : "current muted" }, row.unchanged ? "Already saved" : row.current || "Not set");
  return { check, el: h("tr", { "data-testid": `review-row-${row.key}` }, h("td", { class: "check" }, check), factCell(row), current, h("td", {}, proposed)) };
}

function reviewTable(rows: ReviewRow[], onChange: () => void): HTMLElement {
  const all = h("input", { type: "checkbox", "aria-label": "Select every proposed fact", "data-testid": "review-check-all" });
  const open = rows.filter((row) => !row.unchanged);
  const syncAll = (): void => {
    all.checked = open.length > 0 && open.every((row) => row.checked);
    all.disabled = open.length === 0;
  };
  const views = rows.map((row) => reviewRow(row, () => {
    syncAll();
    onChange();
  }));
  all.addEventListener("change", () => {
    for (const row of open) row.checked = all.checked;
    views.forEach((view, i) => (view.check.checked = rows[i]?.checked === true));
    onChange();
  });
  syncAll();
  const head = h("tr", {}, h("th", { scope: "col", class: "check" }, all), ...["Fact", "Current", "Proposed"].map((t) => h("th", { scope: "col" }, t)));
  const table = h("table", { class: "data review", "data-testid": "review-table" }, h("thead", {}, head), h("tbody", {}, ...views.map((view) => view.el)));
  return h("div", { class: "table-scroll" }, table);
}

export function mountResume(panel: HTMLElement, deps: ResumeDeps = {}): void {
  const readFile = deps.readFile ?? readResumeFile;
  const file = h("input", { type: "file", id: "resume-file", class: "sr-only", accept: ".pdf,.txt,application/pdf,text/plain", "data-testid": "resume-file" });
  const fileNote = h("span", { class: "muted small", role: "status", "data-testid": "resume-file-note" });
  const text = h("textarea", { class: "json-editor prose", rows: "10", spellcheck: "false", "aria-label": "Resume text", placeholder: "Paste your resume here", "data-testid": "resume-text" });
  const counter = h("span", { class: "muted small", "data-testid": "resume-count" });
  const extract = h("button", { type: "button", class: "primary", "data-testid": "resume-extract" }, "Propose facts");
  const error = h("p", { class: "error", role: "alert", "data-testid": "resume-error" });
  const status = h("span", { class: "status", role: "status", "data-testid": "resume-status" });
  const review = h("div", { class: "review-area", "data-testid": "resume-review" });
  let rows: ReviewRow[] = [];
  let busy = false;

  const syncInput = (): void => {
    const length = text.value.length;
    counter.textContent = `${length.toLocaleString("en-US")} / ${RESUME_MAX_CHARS.toLocaleString("en-US")} characters${length > RESUME_MAX_CHARS ? " (only the first 20,000 are sent)" : ""}`;
    extract.disabled = busy || text.value.trim() === "";
  };

  const setBusy = (value: boolean, label: string): void => {
    busy = value;
    extract.textContent = label;
    syncInput();
  };

  const clearReview = (): void => {
    rows = [];
    review.replaceChildren();
  };

  const save = async (): Promise<void> => {
    const count = selectedRows(rows).length;
    try {
      await saveProfile(mergeReviewRows(await getProfile(), rows));
      clearReview();
      text.value = "";
      file.value = "";
      fileNote.textContent = "";
      syncInput();
      flashStatus(status, `Saved ${count} fact${count === 1 ? "" : "s"} to your profile`, "ok", 5000);
    } catch (err) {
      flashStatus(status, `Could not save: ${errorMessage(err)}`, "error", 6000);
    }
  };

  const showReview = (provider: string, latencyMs: number | null): void => {
    if (rows.length === 0) {
      return review.replaceChildren(h("p", { class: "empty", "data-testid": "review-empty" }, "No facts found in that text. Try pasting more of the resume."));
    }
    const saveButton = h("button", { type: "button", class: "primary", "data-testid": "review-save" });
    const discard = h("button", { type: "button", "data-testid": "review-discard" }, "Discard");
    const syncSave = (): void => {
      const count = selectedRows(rows).length;
      saveButton.textContent = `Save ${count} selected fact${count === 1 ? "" : "s"}`;
      saveButton.disabled = count === 0;
    };
    saveButton.addEventListener("click", () => void save());
    discard.addEventListener("click", clearReview);
    const source = `Proposed by the ${provider} extractor${latencyMs === null ? "" : ` in ${Math.round(latencyMs)} ms`}. Nothing is saved until you press Save.`;
    review.replaceChildren(h("h3", {}, "Review"), h("p", { class: "muted", "data-testid": "review-source" }, source), reviewTable(rows, syncSave), h("div", { class: "row" }, saveButton, discard));
    syncSave();
  };

  const runExtract = async (): Promise<void> => {
    error.textContent = "";
    clearReview();
    setBusy(true, "Reading…");
    try {
      const [result, profile] = await Promise.all([extractProfile(text.value, deps), getProfile()]);
      rows = buildReviewRows(profile.facts, result.facts);
      showReview(result.provider, result.latencyMs);
    } catch (err) {
      error.textContent = errorMessage(err);
    } finally {
      setBusy(false, "Propose facts");
    }
  };

  const loadFile = async (): Promise<void> => {
    const picked = file.files?.[0];
    if (!picked) return;
    error.textContent = "";
    fileNote.textContent = `Reading ${picked.name}…`;
    const result = await readFile(picked);
    file.value = ""; // so picking the same file again fires "change"
    if (!result.ok) {
      fileNote.textContent = "";
      error.textContent = result.error;
      return;
    }
    text.value = result.text;
    fileNote.textContent = `${picked.name}${result.pages ? `, ${result.pages} page${result.pages === 1 ? "" : "s"}` : ""}`;
    syncInput();
  };

  text.addEventListener("input", syncInput);
  extract.addEventListener("click", () => void runExtract());
  file.addEventListener("change", () => void loadFile());

  panel.append(
    h("h2", {}, "Import resume"),
    h("p", { class: "muted" }, "Paste your resume, or upload a PDF or .txt file. The text goes to your local Ghost server (and to the language model configured there, if any) to propose profile facts. You review every fact before anything is saved, and the resume itself is never stored."),
    h("div", { class: "row" }, file, h("label", { for: "resume-file", class: "button" }, "Choose PDF or .txt"), fileNote, h("span", { class: "spacer" }), counter),
    text,
    error,
    h("div", { class: "row" }, extract, status),
    review,
  );
  syncInput();
}

export const resumeSection: OptionsSection = { id: "resume", title: "Import resume", mount: (panel) => mountResume(panel) };
