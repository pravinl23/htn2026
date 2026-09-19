import type { ServerLoopProgram, ServerLoopStep } from "./transforms";

type FillStep = Extract<ServerLoopStep, { op: "fill" }>;

const MAX_LABELS = 4;
const MAX_LABEL_CHARS = 30;
const MAX_TITLE_CHARS = 120;

function short(label: string): string {
  const flat = label.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_LABEL_CHARS ? flat : `${flat.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…`;
}

function fieldName(fill: FillStep): string {
  return short(fill.target.cell?.colHeader || fill.target.label);
}

function listed(labels: string[]): string {
  const unique = [...new Set(labels.filter((l) => l !== ""))];
  if (unique.length <= MAX_LABELS) return unique.join(", ");
  return `${unique.slice(0, MAX_LABELS - 1).join(", ")} and ${unique.length - (MAX_LABELS - 1)} more`;
}

/** "/sheet" -> "sheet", "/orders/:id/edit" -> "edit", "/" -> "". */
function pageName(pathPattern: string | undefined): string {
  const segments = (pathPattern ?? "").split("/").filter((s) => s !== "" && s !== ":id");
  return segments[segments.length - 1] ?? "";
}

/**
 * A short human title built in code from the steps' own labels, e.g.
 * "Copy Vendor, Invoice #, Date, Total to sheet and Reply: received". Never written by a model.
 */
export function programTitle(program: ServerLoopProgram): string {
  const fills = program.steps.filter((s): s is FillStep => s.op === "fill");
  const copied = fills.filter((f) => "var" in f.value);
  const named = listed((copied.length > 0 ? copied : fills).map(fieldName));
  const where = pageName((copied[0] ?? fills[0])?.at?.pathPattern);
  let title = `Open each item in ${pageName(program.iterator.pathPattern) || "the list"}`;
  if (named !== "") title = `${copied.length > 0 ? "Copy" : "Fill"} ${named}${where === "" ? "" : ` ${copied.length > 0 ? "to" : "on"} ${where}`}`;
  const clicks = listed(program.steps.flatMap((s) => (s.op === "click" && s.target.label.trim() !== "" ? [short(s.target.label)] : [])));
  if (clicks !== "") title = `${title} and ${clicks}`;
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}
