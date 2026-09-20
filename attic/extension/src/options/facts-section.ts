// "Your profile sources": where Ghost's facts come from, what a scan proposes, and what the user keeps.
//
// The rule of this page (docs/profile-sources.md section 2): nothing is read without the user pressing
// Scan, and nothing enters the fact graph until they press Save. A scan shows proposals with their source
// and their evidence; the user checks the ones they want. Every string is rendered as text, never as HTML.
import type { FactGraph, FactProposal, FactSource } from "@ghost/shared";
import { readResumeFile } from "../lib/pdfText";
import type { FileTextResult } from "../lib/pdfText";
import { getFactGraph, onStorageChanged, updateFactGraph } from "../lib/storage";
import { errorMessage, flashStatus, h } from "./dom";
import {
  buildProposalReview, checkedRows, deleteFact, dismissProposal, editFact, factViews, forgetSource, saveProposalRows,
  scanGitHub, scanLinkedIn, scanResume, scanText, scanWebsite, sourceGroups,
} from "./facts-scan";
import type { FactView, ProposalRow, ScanDeps, ScanReview } from "./facts-scan";
import { SECTION_SHOWN, type OptionsSection } from "./sections";

export interface FactsDeps extends ScanDeps {
  /** Test seam: reading a PDF or a .txt/.vcf file. Never keeps the file, only its text. */
  readFile?: (file: File) => Promise<FileTextResult>;
}

type SourceId = "resume" | "github" | "linkedin" | "website" | "text";

interface SourceDef {
  id: SourceId;
  title: string;
  hint: string;
  input: "file" | "text" | "url" | "textarea";
  placeholder: string;
  action: string;
}

const SOURCES: SourceDef[] = [
  {
    id: "resume",
    title: "Résumé or contact card",
    hint: "A PDF, .txt or .vcf file. A contact card is read here on your machine; a résumé goes to your local Ghost server.",
    input: "file",
    placeholder: "",
    action: "Scan file",
  },
  {
    id: "github",
    title: "GitHub username",
    hint: "Reads the public profile: name, public email, company, location, blog and links.",
    input: "text",
    placeholder: "alexchen-dev",
    action: "Scan GitHub",
  },
  {
    id: "linkedin",
    title: "LinkedIn profile",
    hint: "Your profile address becomes a fact. LinkedIn does not let an extension read the page, so paste the About section below for the rest.",
    input: "url",
    placeholder: "https://linkedin.com/in/alexchen-dev",
    action: "Add LinkedIn",
  },
  {
    id: "website",
    title: "Personal website",
    hint: "One read of the page you name, text only. Some sites refuse to be read from an extension; paste the text instead.",
    input: "url",
    placeholder: "https://alexchen.dev",
    action: "Scan page",
  },
  {
    id: "text",
    title: "Paste text",
    hint: "A mail signature block, an about page, a conference bio. Read here, never uploaded.",
    input: "textarea",
    placeholder: "Alex Chen\nSoftware Engineer at Northwind Robotics\nalex@example.com · +1 519 555 0142",
    action: "Scan text",
  },
];

/** Connectors that do not exist yet. Named so the page tells the truth about what Ghost can read today. */
const CONNECTORS = [
  { id: "mail", title: "Mail", hint: "Signature blocks and shipping addresses from your own mailbox." },
  { id: "calendar", title: "Calendar", hint: "Your employer and working hours, from recurring meetings." },
  { id: "drive", title: "Drive", hint: "A résumé or CV you already keep in a document." },
];
const CONNECTOR_NOTE = "Connect through the desktop app";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Destructive, so it takes two clicks: the first arms the button for a few seconds. */
function armTwice(button: HTMLButtonElement, label: string, armed: string, action: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = (): void => {
    clearTimeout(timer);
    timer = undefined;
    button.textContent = label;
  };
  button.addEventListener("click", () => {
    if (timer === undefined) {
      button.textContent = armed;
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    action();
  });
}

export function mountFacts(panel: HTMLElement, deps: FactsDeps = {}): void {
  const readFile = deps.readFile ?? readResumeFile;
  let graph: FactGraph | null = null;
  let review: ScanReview | null = null;
  let reviewSource = "";
  let query = "";

  const status = h("span", { class: "status", role: "status", "data-testid": "facts-status" });
  const summary = h("span", { class: "muted", "data-testid": "facts-summary" });
  const error = h("p", { class: "error", role: "alert", "data-testid": "facts-error" });
  const reviewArea = h("div", { class: "review-area", "data-testid": "facts-review" });
  const list = h("div", { class: "answers", "data-testid": "facts-list" });
  const groups = h("div", { class: "row", "data-testid": "facts-sources-known" });
  const empty = h("p", { class: "muted", "data-testid": "facts-empty" }, "No facts yet. Scan a source above, or add them in the Profile tab.");
  const search = h("input", { type: "search", class: "text", "aria-label": "Search facts", placeholder: "Search facts", "data-testid": "facts-search" });

  const say = (text: string, kind: "ok" | "error" = "ok"): void => flashStatus(status, text, kind, kind === "error" ? 6000 : 3000);

  // ---------- the fact list ----------

  function factRow(view: FactView): HTMLElement {
    const value = h("input", {
      type: "text", class: "text wide", "aria-label": `Value for ${view.key}`, disabled: view.sensitive,
      "data-testid": `fact-value-${view.key}`,
    });
    value.value = view.sensitive ? "" : view.value;
    const save = h("button", { type: "button", "data-testid": `fact-save-${view.key}`, disabled: true }, "Save");
    value.addEventListener("input", () => {
      save.disabled = value.value.trim() === "" || value.value === view.value;
    });
    save.addEventListener("click", () => void edit(view.key, value.value));
    const remove = h("button", { type: "button", class: "danger", "data-testid": `fact-delete-${view.key}` }, "Delete");
    armTwice(remove, "Delete", "Click again to delete", () => void drop(view.key));

    const tags = [h("span", { class: "tag" }, view.category)];
    if (view.verified) tags.push(h("span", { class: "tag" }, "yours"));
    if (view.sensitive) tags.push(h("span", { class: "tag" }, "sensitive · never filled, never sent"));
    const meta = h("span", { class: "muted small" }, view.sourceText);
    if (view.evidence) meta.append(h("span", { class: "muted small" }, ` · ${view.evidence}`));

    return h(
      "div",
      { class: "answer", "data-testid": `fact-row-${view.key}`, "data-source": view.sourceId, "data-category": view.category },
      h("div", { class: "row" }, h("strong", {}, view.label), h("code", { class: "mono" }, view.key), ...tags, h("span", { class: "spacer" }), meta),
      h("div", { class: "row" }, value, save, remove),
    );
  }

  function sourceGroupRow(id: string, text: string, source: FactSource, count: number): HTMLElement {
    const forget = h("button", { type: "button", class: "danger", "data-testid": `source-forget-${id}` }, `Forget ${text}`);
    armTwice(forget, `Forget ${text}`, `Click again to forget ${plural(count, "fact")}`, () => void forgetEverythingFrom(source, text));
    return h("span", { class: "row", "data-testid": `source-group-${id}` }, h("span", { class: "tag" }, `${text} · ${plural(count, "fact")}`), forget);
  }

  function renderGraph(): void {
    if (!graph) return;
    const views = factViews(graph, query);
    list.replaceChildren(...views.map(factRow));
    const total = factViews(graph).length;
    empty.hidden = total > 0;
    summary.textContent = query.trim() === "" ? plural(total, "fact") : `${views.length} of ${plural(total, "fact")}`;
    groups.replaceChildren(...sourceGroups(graph).map((group) => sourceGroupRow(group.id, group.text, group.source, group.count)));
  }

  // ---------- the review list ----------

  function proposalRow(row: ProposalRow, sync: () => void): HTMLElement {
    const check = h("input", { type: "checkbox", "aria-label": `Save ${row.key}`, disabled: row.unchanged, "data-testid": `proposal-check-${row.key}` });
    check.checked = row.checked;
    check.addEventListener("change", () => {
      row.checked = check.checked;
      sync();
    });
    const value = h("input", { type: "text", class: "text wide", "aria-label": `Proposed value for ${row.key}`, disabled: row.unchanged, "data-testid": `proposal-value-${row.key}` });
    value.value = row.value;
    value.addEventListener("input", () => {
      row.value = value.value;
      sync();
    });
    const dismiss = h("button", { type: "button", "data-testid": `proposal-dismiss-${row.key}` }, "Never suggest this");
    dismiss.addEventListener("click", () => void dismiss_(row));
    return h(
      "tr",
      { "data-testid": `proposal-row-${row.key}`, "data-category": row.category },
      h("td", { class: "check" }, check),
      h("td", {}, h("strong", {}, row.label), h("small", {}, row.key), h("small", {}, row.category)),
      h("td", {}, value),
      h("td", { class: "current muted" }, row.unchanged ? "Already saved" : row.current || "Not set"),
      h("td", { class: "muted small" }, row.sourceText, h("small", {}, row.evidence)),
      h("td", {}, dismiss),
    );
  }

  function renderReview(): void {
    if (!review) return void reviewArea.replaceChildren();
    const { rows, sensitive, rejected } = review;
    const notes: string[] = [`Proposed from ${reviewSource}. Nothing is saved until you press Save.`];
    if (sensitive > 0) notes.push(`${plural(sensitive, "detail")} looked sensitive and ${sensitive === 1 ? "was" : "were"} skipped: Ghost never stores IDs, payment or health details.`);
    if (rejected > 0) notes.push(`${plural(rejected, "proposal")} you turned down before ${rejected === 1 ? "was" : "were"} left out.`);
    if (rows.length === 0) {
      return void reviewArea.replaceChildren(
        h("h3", {}, "Review"),
        h("p", { class: "muted", "data-testid": "proposal-source" }, notes.join(" ")),
        h("p", { class: "empty", "data-testid": "proposal-empty" }, "Nothing new in that source."),
      );
    }
    const save = h("button", { type: "button", class: "primary", "data-testid": "proposal-save" });
    const discard = h("button", { type: "button", "data-testid": "proposal-discard" }, "Discard");
    const sync = (): void => {
      const count = checkedRows(rows).length;
      save.textContent = `Save ${plural(count, "fact")}`;
      save.disabled = count === 0;
    };
    save.addEventListener("click", () => void saveReview());
    discard.addEventListener("click", () => {
      review = null;
      renderReview();
    });
    const head = h("tr", {}, h("th", { scope: "col", class: "check" }), ...["Fact", "Proposed", "Now", "Source", ""].map((t) => h("th", { scope: "col" }, t)));
    const table = h("table", { class: "data review", "data-testid": "facts-review-table" },
      h("thead", {}, head),
      h("tbody", {}, ...rows.map((row) => proposalRow(row, sync))));
    reviewArea.replaceChildren(
      h("h3", {}, "Review"),
      h("p", { class: "muted", "data-testid": "proposal-source" }, notes.join(" ")),
      h("div", { class: "table-scroll" }, table),
      h("div", { class: "row" }, save, discard),
    );
    sync();
  }

  // ---------- writes ----------

  async function withGraph(mutate: (current: FactGraph) => FactGraph | null, message: (next: FactGraph) => string): Promise<void> {
    try {
      const next = await updateFactGraph(mutate);
      graph = next;
      renderGraph();
      say(message(next));
    } catch (err) {
      say(`Could not save: ${errorMessage(err)}`, "error");
    }
  }

  async function saveReview(): Promise<void> {
    const rows = review?.rows ?? [];
    if (rows.length === 0) return;
    let saved = 0;
    let skipped = 0;
    await withGraph(
      (current) => {
        const result = saveProposalRows(current, rows);
        saved = result.saved;
        skipped = result.skipped;
        return result.graph;
      },
      () => (skipped === 0 ? `Saved ${plural(saved, "fact")}` : `Saved ${plural(saved, "fact")}, skipped ${skipped}`),
    );
    review = null;
    renderReview();
  }

  async function dismiss_(row: ProposalRow): Promise<void> {
    await withGraph((current) => dismissProposal(current, row), () => `Ghost will not suggest ${row.label} from this source again`);
    if (review) {
      review = { ...review, rows: review.rows.filter((r) => r !== row), rejected: review.rejected + 1 };
      renderReview();
    }
  }

  async function edit(key: string, value: string): Promise<void> {
    let ok = true;
    let reason = "";
    await withGraph(
      (current) => {
        const result = editFact(current, key, value);
        ok = result.ok;
        reason = result.reason;
        return result.ok ? result.graph : null;
      },
      () => (ok ? `Saved ${key}` : `Not saved: ${reason}`),
    );
  }

  async function drop(key: string): Promise<void> {
    await withGraph((current) => deleteFact(current, key), () => `Deleted ${key}`);
  }

  async function forgetEverythingFrom(source: FactSource, text: string): Promise<void> {
    let removed = 0;
    await withGraph(
      (current) => {
        const result = forgetSource(current, source);
        removed = result.removed;
        return result.graph;
      },
      () => `Forgot ${plural(removed, "fact")} from ${text}`,
    );
  }

  // ---------- the source rows ----------

  function showProposals(proposals: FactProposal[], from: string): void {
    if (!graph) return;
    review = buildProposalReview(graph, proposals);
    reviewSource = from;
    renderReview();
  }

  function sourceRow(def: SourceDef): HTMLElement {
    const note = h("span", { class: "muted small", role: "status", "data-testid": `source-note-${def.id}` });
    const scan = h("button", { type: "button", class: "primary", "data-testid": `source-scan-${def.id}` }, def.action);
    let fileText = "";
    let fileName = "";

    const input: HTMLInputElement | HTMLTextAreaElement = def.input === "textarea"
      ? h("textarea", { class: "json-editor prose", rows: "5", spellcheck: "false", "aria-label": def.title, placeholder: def.placeholder, "data-testid": `source-input-${def.id}` })
      : def.input === "file"
        ? h("input", { type: "file", class: "text", accept: ".pdf,.txt,.vcf,application/pdf,text/plain,text/vcard", "aria-label": def.title, "data-testid": `source-input-${def.id}` })
        : h("input", { type: def.input === "url" ? "url" : "text", class: "text wide", "aria-label": def.title, placeholder: def.placeholder, "data-testid": `source-input-${def.id}` });

    const syncScan = (): void => {
      scan.disabled = def.input === "file" ? fileText === "" : input.value.trim() === "";
    };

    const loadFile = async (): Promise<void> => {
      const picked = input instanceof HTMLInputElement ? input.files?.[0] : undefined;
      if (!picked) return;
      error.textContent = "";
      note.textContent = `Reading ${picked.name}…`;
      const result = await readFile(picked);
      if (!result.ok) {
        fileText = "";
        note.textContent = "";
        error.textContent = result.error;
        return syncScan();
      }
      // The text lives in this closure for one scan and is never written anywhere.
      fileText = result.text;
      fileName = picked.name;
      note.textContent = `${picked.name} · ${plural(result.text.length, "character")} read`;
      syncScan();
    };

    if (def.input === "file") input.addEventListener("change", () => void loadFile());
    else input.addEventListener("input", syncScan);

    const run = async (): Promise<void> => {
      error.textContent = "";
      review = null;
      renderReview();
      scan.disabled = true;
      const previous = scan.textContent ?? def.action;
      scan.textContent = "Scanning…";
      try {
        if (def.id === "github") showProposals(await scanGitHub(input.value, deps), `github · ${input.value.trim()}`);
        else if (def.id === "linkedin") showProposals(scanLinkedIn(input.value), "the profile address you gave");
        else if (def.id === "website") showProposals(await scanWebsite(input.value, deps), "the page you named");
        else if (def.id === "text") showProposals(scanText(input.value, { kind: "file", name: "pasted text" }), "the text you pasted");
        else {
          const result = await scanResume(fileText, fileName, deps);
          showProposals(result.proposals, `${fileName} (${result.provider})`);
        }
      } catch (err) {
        error.textContent = errorMessage(err);
      } finally {
        scan.textContent = previous;
        syncScan();
      }
    };

    scan.addEventListener("click", () => void run());
    syncScan();
    return h(
      "div",
      { class: "answer", "data-testid": `source-row-${def.id}` },
      h("div", { class: "row" }, h("strong", {}, def.title), h("span", { class: "muted small" }, def.hint)),
      input,
      h("div", { class: "row" }, scan, note),
    );
  }

  function connectorRow(def: { id: string; title: string; hint: string }): HTMLElement {
    const button = h("button", { type: "button", disabled: true, "data-testid": `source-scan-${def.id}` }, CONNECTOR_NOTE);
    return h(
      "div",
      { class: "answer", "data-testid": `source-row-${def.id}` },
      h("div", { class: "row" }, h("strong", {}, def.title), h("span", { class: "muted small" }, def.hint), h("span", { class: "spacer" }), button),
    );
  }

  // ---------- the panel ----------

  search.addEventListener("input", () => {
    query = search.value;
    renderGraph();
  });

  panel.append(
    h("div", { class: "row" }, h("h2", {}, "Your profile sources"), h("span", { class: "spacer" }), summary, status),
    h("p", { class: "muted" },
      "Ghost fills forms from facts about you. Point it at what you already have, review every proposal, and keep what is right. "
      + "Everything here stays on this computer: only fact keys (never values) are ever sent to the prediction server, and passwords, "
      + "payment details, government IDs and health details are never extracted at all."),
    ...SOURCES.map(sourceRow),
    ...CONNECTORS.map(connectorRow),
    error,
    reviewArea,
    h("div", { class: "row" }, h("h3", {}, "Facts Ghost knows"), h("span", { class: "spacer" }), search),
    groups,
    empty,
    list,
  );

  const refresh = async (): Promise<void> => {
    graph = await getFactGraph();
    renderGraph();
  };

  void refresh();
  onStorageChanged((changes) => {
    if (!changes.facts) return;
    graph = changes.facts;
    renderGraph();
  });
  panel.addEventListener(SECTION_SHOWN, () => void refresh());
}

export const factsSection: OptionsSection = { id: "sources", title: "Your profile sources", mount: (panel) => mountFacts(panel) };
