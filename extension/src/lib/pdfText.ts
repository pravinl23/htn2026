// Resume file -> plain text, inside the options page. pdf.js and its worker are copied into dist by
// build.mjs and loaded from the extension's own origin on first use (MV3 forbids remote code), so the
// 450 KB library costs nothing until someone actually uploads a PDF.

/** The slice of the pdf.js API this module uses. The real module is checked against it below. */
export interface PdfJsLike {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(source: PdfSource): { promise: Promise<PdfDocumentLike>; destroy(): Promise<void> };
}

export interface PdfSource {
  data: Uint8Array;
  useWasm: boolean;
  useWorkerFetch: boolean;
  useSystemFonts: boolean;
  disableFontFace: boolean;
  isOffscreenCanvasSupported: boolean;
  stopAtErrors: boolean;
  verbosity: number;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
}

type RealPdfJs = typeof import("pdfjs-dist");
// Compile-time only: fails typecheck when a pdfjs-dist upgrade stops matching PdfJsLike.
export type PdfJsCompatible = RealPdfJs extends PdfJsLike ? true : never;
const compatible: PdfJsCompatible = true;
void compatible;

export interface PdfTextDeps {
  loadPdfJs?: () => Promise<PdfJsLike>;
  maxPages?: number;
  maxChars?: number;
}

export type FileTextResult = { ok: true; text: string; pages?: number } | { ok: false; error: string };

export const PDF_LIMITS = { maxPages: 12, maxChars: 20_000, maxBytes: 10 * 1024 * 1024 };
export const PDF_FAILED = "Could not read this PDF. Paste the resume text instead.";
export const PDF_NO_TEXT = "This PDF has no selectable text (it may be a scan). Paste the resume text instead.";

const LIB_FILE = "pdf.min.mjs";
const WORKER_FILE = "pdf.worker.min.mjs";

async function loadBundledPdfJs(): Promise<PdfJsLike> {
  const lib = (await import(/* @vite-ignore */ chrome.runtime.getURL(LIB_FILE))) as PdfJsLike;
  lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(WORKER_FILE);
  return lib;
}

function itemText(item: unknown): string {
  if (typeof item !== "object" || item === null) return "";
  const { str, hasEOL } = item as { str?: unknown; hasEOL?: unknown };
  return (typeof str === "string" ? str : "") + (hasEOL === true ? "\n" : "");
}

function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Text of the first pages, in reading order, one line per PDF line. Throws whatever pdf.js throws. */
export async function extractPdfText(data: Uint8Array, deps: PdfTextDeps = {}): Promise<{ text: string; pages: number }> {
  const lib = await (deps.loadPdfJs ?? loadBundledPdfJs)();
  const maxChars = deps.maxChars ?? PDF_LIMITS.maxChars;
  // Text only: no wasm image decoders (needs 'wasm-unsafe-eval'), no font faces, no fetches from the worker.
  // verbosity 0 = errors only: the missing standard-font data pdf.js warns about is only needed to draw.
  const task = lib.getDocument({ data, useWasm: false, useWorkerFetch: false, useSystemFonts: false, disableFontFace: true, isOffscreenCanvasSupported: false, stopAtErrors: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages = Math.min(doc.numPages, deps.maxPages ?? PDF_LIMITS.maxPages);
    let text = "";
    for (let n = 1; n <= pages && text.length < maxChars; n += 1) {
      const content = await (await doc.getPage(n)).getTextContent();
      text += `${content.items.map(itemText).join("")}\n\n`;
    }
    return { text: tidy(text).slice(0, maxChars), pages };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function isPlainText(file: File): boolean {
  return file.type.startsWith("text/") || /\.(txt|md)$/i.test(file.name);
}

// FileReader rather than Blob.text()/arrayBuffer(): same result in Chrome, and jsdom only has this one.
function readBlob(file: Blob, as: "text"): Promise<string>;
function readBlob(file: Blob, as: "buffer"): Promise<ArrayBuffer>;
function readBlob(file: Blob, as: "text" | "buffer"): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (reader.result === null ? reject(new Error("empty read")) : resolve(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    if (as === "text") reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

async function readPdf(file: File, deps: PdfTextDeps): Promise<FileTextResult> {
  try {
    const { text, pages } = await extractPdfText(new Uint8Array(await readBlob(file, "buffer")), deps);
    return text ? { ok: true, text, pages } : { ok: false, error: PDF_NO_TEXT };
  } catch {
    // Encrypted or damaged file, or pdf.js itself failed to load: pasting always works.
    return { ok: false, error: PDF_FAILED };
  }
}

/** Never throws and never keeps the file: the caller gets text or a sentence to show. */
export async function readResumeFile(file: File, deps: PdfTextDeps = {}): Promise<FileTextResult> {
  if (file.size > PDF_LIMITS.maxBytes) return { ok: false, error: "That file is larger than 10 MB. Paste the resume text instead." };
  if (isPdf(file)) return readPdf(file, deps);
  if (!isPlainText(file)) return { ok: false, error: "Upload a PDF or a .txt file, or paste the text." };
  try {
    const text = tidy(await readBlob(file, "text")).slice(0, deps.maxChars ?? PDF_LIMITS.maxChars);
    return text ? { ok: true, text } : { ok: false, error: "That file is empty." };
  } catch {
    return { ok: false, error: "Could not read that file. Paste the resume text instead." };
  }
}
