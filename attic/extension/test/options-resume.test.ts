import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_PROFILE } from "@ghost/shared";
import type { Profile } from "@ghost/shared";
import { PDF_FAILED, PDF_NO_TEXT, extractPdfText, readResumeFile } from "../src/lib/pdfText";
import type { PdfJsLike } from "../src/lib/pdfText";
import { PROFILE_KEY, getProfile, resetMemoryStorage, saveProfile } from "../src/lib/storage";
import { buildReviewRows, mergeReviewRows, selectedRows } from "../src/options/resume-merge";
import { mountResume } from "../src/options/resume-section";
import { createChromeStorageMock } from "./chrome-mock";

const profile = (facts: Record<string, string>): Profile => ({ facts, pastAnswers: [{ question: "Why?", answer: "Because." }] });

describe("buildReviewRows", () => {
  const current = { firstName: "Alex", email: "alex.chen.dev@example.com" };
  const proposed = { "extra.languages": "English", school: "  University of Waterloo ", email: "alex.chen.dev@example.com", firstName: "Alexander", "extra.awards": "Dean's list" };

  it("orders canonical keys first and carries their descriptions", () => {
    const rows = buildReviewRows(current, proposed);
    expect(rows.map((r) => r.key)).toEqual(["firstName", "email", "school", "extra.awards", "extra.languages"]);
    expect(rows[0]).toMatchObject({ description: "first / given name", current: "Alex", proposed: "Alexander", canonical: true });
    expect(rows[2]).toMatchObject({ current: "", proposed: "University of Waterloo" });
  });

  it("checks changed canonical facts, leaves extra.* and unchanged facts unchecked", () => {
    const checked = Object.fromEntries(buildReviewRows(current, proposed).map((r) => [r.key, r.checked]));
    expect(checked).toEqual({ firstName: true, email: false, school: true, "extra.awards": false, "extra.languages": false });
    expect(buildReviewRows(current, proposed).find((r) => r.key === "email")?.unchanged).toBe(true);
  });

  it("drops sensitive keys, non-strings, blanks and malformed keys", () => {
    const rows = buildReviewRows({}, { ssn: "000-00-0000", "extra.passportNumber": "X1", "extra.card_number": "4111", city: 7, phone: "   ", "bad key": "x", __proto__x: "y", major: "CS" });
    expect(rows.map((r) => r.key)).toEqual(["major"]);
  });

  it("clips very long values and survives junk input", () => {
    expect(buildReviewRows({}, { city: "x".repeat(900) })[0]?.proposed).toHaveLength(500);
    for (const junk of [null, undefined, "facts", 3, []]) expect(buildReviewRows({}, junk)).toEqual([]);
  });
});

describe("mergeReviewRows", () => {
  it("writes only the checked rows and keeps everything else", () => {
    const before = profile({ firstName: "Alex", city: "Waterloo" });
    const rows = buildReviewRows(before.facts, { firstName: "Alexander", school: "UW", "extra.languages": "English" });
    const school = rows.find((r) => r.key === "school");
    if (school) school.checked = false;
    const merged = mergeReviewRows(before, rows);
    expect(merged.facts).toEqual({ firstName: "Alexander", city: "Waterloo" });
    expect(merged.pastAnswers).toEqual(before.pastAnswers);
    expect(before.facts.firstName).toBe("Alex");
  });

  it("uses the edited value, ignores rows edited down to nothing, and can add an extra fact", () => {
    const rows = buildReviewRows({}, { firstName: "Alexander", lastName: "Chen", "extra.languages": "English" });
    for (const row of rows) {
      if (row.key === "firstName") row.proposed = " Alex ";
      if (row.key === "lastName") row.proposed = "  ";
      if (row.key === "extra.languages") row.checked = true;
    }
    expect(selectedRows(rows).map((r) => r.key)).toEqual(["firstName", "extra.languages"]);
    expect(mergeReviewRows(profile({}), rows).facts).toEqual({ firstName: "Alex", "extra.languages": "English" });
  });
});

function fakePdfJs(pages: Array<Array<{ str: string; hasEOL?: boolean }>>): { lib: PdfJsLike; destroy: ReturnType<typeof vi.fn> } {
  const destroy = vi.fn(async () => undefined);
  const doc = { numPages: pages.length, getPage: async (n: number) => ({ getTextContent: async () => ({ items: pages[n - 1] ?? [] }) }) };
  return { destroy, lib: { GlobalWorkerOptions: { workerSrc: "" }, getDocument: () => ({ promise: Promise.resolve(doc), destroy }) } };
}

const pdfFile = (name = "resume.pdf"): File => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: "application/pdf" });

describe("pdfText", () => {
  it("joins text items into lines, page by page, and releases the document", async () => {
    const { lib, destroy } = fakePdfJs([[{ str: "Alex Chen", hasEOL: true }, { str: "alex.chen.dev@example.com" }], [{ str: "University of" }, { str: " " }, { str: "Waterloo" }]]);
    const result = await extractPdfText(new Uint8Array(4), { loadPdfJs: async () => lib });
    expect(result).toEqual({ text: "Alex Chen\nalex.chen.dev@example.com\n\nUniversity of Waterloo", pages: 2 });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("stops at the page and character limits", async () => {
    const { lib } = fakePdfJs([[{ str: "a".repeat(30) }], [{ str: "b".repeat(30) }], [{ str: "c" }]]);
    const result = await extractPdfText(new Uint8Array(4), { loadPdfJs: async () => lib, maxPages: 2, maxChars: 40 });
    expect(result.pages).toBe(2);
    expect(result.text).toHaveLength(40);
    expect(result.text).not.toContain("c");
  });

  it("falls back to a paste-instead message when pdf.js cannot load", async () => {
    const result = await readResumeFile(pdfFile(), { loadPdfJs: async () => Promise.reject(new Error("worker blocked")) });
    expect(result).toEqual({ ok: false, error: PDF_FAILED });
  });

  it("falls back when pdf.js throws on the document, and still releases it", async () => {
    const destroy = vi.fn(async () => undefined);
    const lib: PdfJsLike = { GlobalWorkerOptions: { workerSrc: "" }, getDocument: () => ({ promise: Promise.reject(new Error("PasswordException")), destroy }) };
    expect(await readResumeFile(pdfFile(), { loadPdfJs: async () => lib })).toEqual({ ok: false, error: PDF_FAILED });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("falls back without chrome.runtime (the bundled loader itself throws)", async () => {
    expect(await readResumeFile(pdfFile())).toEqual({ ok: false, error: PDF_FAILED });
  });

  it("reports a scanned PDF that has no text", async () => {
    const { lib } = fakePdfJs([[{ str: " " }]]);
    expect(await readResumeFile(pdfFile("scan.PDF"), { loadPdfJs: async () => lib })).toEqual({ ok: false, error: PDF_NO_TEXT });
  });

  it("reads .txt files and rejects other types and oversized files", async () => {
    expect(await readResumeFile(new File(["Alex Chen  \n\n\n\nWaterloo"], "resume.txt", { type: "text/plain" }))).toEqual({ ok: true, text: "Alex Chen\n\nWaterloo" });
    expect((await readResumeFile(new File(["x"], "resume.docx"))).ok).toBe(false);
    const huge = pdfFile();
    Object.defineProperty(huge, "size", { value: 11 * 1024 * 1024 });
    expect(await readResumeFile(huge)).toMatchObject({ ok: false, error: expect.stringMatching(/larger than 10 MB/) });
  });
});

describe("resume import tab", () => {
  const $ = <T extends HTMLElement>(testId: string): T => {
    const el = document.querySelector<T>(`[data-testid="${testId}"]`);
    if (!el) throw new Error(`missing ${testId}`);
    return el;
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const paste = (value: string): void => {
    const text = $<HTMLTextAreaElement>("resume-text");
    text.value = value;
    text.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const jsonReply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const mount = (fetchMock: typeof fetch, readFile?: Parameters<typeof mountResume>[1]): void => {
    const panel = document.createElement("section");
    document.body.replaceChildren(panel);
    mountResume(panel, { fetch: fetchMock, serverUrl: "http://localhost:8788", ...readFile });
  };

  afterEach(() => {
    document.body.replaceChildren();
    resetMemoryStorage();
    vi.unstubAllGlobals();
  });

  it("posts the resume as JSON, shows the review table, and merges the checked rows on Save", async () => {
    await saveProfile(structuredClone(DEMO_PROFILE));
    const facts = { firstName: "Alexander", email: DEMO_PROFILE.facts.email, "extra.languages": "<b>English</b>" };
    const fetchMock = vi.fn(async () => jsonReply({ facts, pastAnswers: [], provider: "regex", latencyMs: 3 }));
    mount(fetchMock as unknown as typeof fetch);
    expect($<HTMLButtonElement>("resume-extract").disabled).toBe(true);
    paste("Alexander Chen\nalex.chen.dev@example.com");
    $("resume-extract").click();
    await settle();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8788/v1/profile/extract");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ resumeText: "Alexander Chen\nalex.chen.dev@example.com" });

    expect($<HTMLInputElement>("review-check-firstName").checked).toBe(true);
    expect($<HTMLInputElement>("review-check-email").disabled).toBe(true);
    expect($<HTMLInputElement>("review-check-extra.languages").checked).toBe(false);
    expect($<HTMLInputElement>("review-value-extra.languages").value).toBe("<b>English</b>");
    expect($("review-table").querySelector("b")).toBeNull();
    expect($("review-row-firstName").textContent).toContain("first / given name");
    expect($("review-save").textContent).toBe("Save 1 selected fact");

    $<HTMLInputElement>("review-check-all").click();
    expect($<HTMLInputElement>("review-check-extra.languages").checked).toBe(true);
    expect($<HTMLInputElement>("review-check-email").checked).toBe(false);
    $<HTMLInputElement>("review-check-all").click();
    expect($("review-save").textContent).toBe("Save 0 selected facts");
    expect($<HTMLButtonElement>("review-save").disabled).toBe(true);
    $<HTMLInputElement>("review-check-firstName").click();
    $<HTMLInputElement>("review-check-extra.languages").click();
    expect($<HTMLInputElement>("review-check-all").checked).toBe(true);
    expect($("review-save").textContent).toBe("Save 2 selected facts");
    $("review-save").click();
    await settle();
    const saved = await getProfile();
    expect(saved.facts).toEqual({ ...DEMO_PROFILE.facts, firstName: "Alexander", "extra.languages": "<b>English</b>" });
    expect($<HTMLTextAreaElement>("resume-text").value).toBe("");
    expect(document.querySelector('[data-testid="review-table"]')).toBeNull();
    expect($("resume-status").textContent).toBe("Saved 2 facts to your profile");
  });

  it("never writes the resume text to storage", async () => {
    const mock = createChromeStorageMock();
    vi.stubGlobal("chrome", mock.chrome);
    const fetchMock = vi.fn(async () => jsonReply({ facts: { major: "Robotics" }, provider: "regex", latencyMs: 1 }));
    mount(fetchMock as unknown as typeof fetch);
    paste("UNIQUE-RESUME-MARKER studied Robotics");
    $("resume-extract").click();
    await settle();
    $("review-save").click();
    await settle();
    expect((mock.store.get(PROFILE_KEY) as Profile).facts.major).toBe("Robotics");
    expect(JSON.stringify([...mock.store.entries()])).not.toContain("UNIQUE-RESUME-MARKER");
  });

  it("tells the user to start the server when it is down", async () => {
    mount(vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch);
    paste("Alex Chen");
    $("resume-extract").click();
    await settle();
    expect($("resume-error").textContent).toBe("Cannot reach the Ghost server at http://localhost:8788. Start the server with pnpm dev.");
    expect($<HTMLButtonElement>("resume-extract").disabled).toBe(false);
    expect($("resume-extract").textContent).toBe("Propose facts");
  });

  it("shows the server's own error for a rejected request", async () => {
    mount(vi.fn(async () => jsonReply({ error: "resumeText must be at most 20000 characters" }, 400)) as unknown as typeof fetch);
    paste("Alex Chen");
    $("resume-extract").click();
    await settle();
    expect($("resume-error").textContent).toMatch(/answered 400: resumeText must be at most 20000/);
  });

  it("says so when nothing was found, and Discard clears a review", async () => {
    const fetchMock = vi.fn(async () => jsonReply({ facts: {}, provider: "regex", latencyMs: 1 }));
    mount(fetchMock as unknown as typeof fetch);
    paste("???");
    $("resume-extract").click();
    await settle();
    expect($("review-empty").textContent).toMatch(/No facts found/);
    fetchMock.mockImplementation(async () => jsonReply({ facts: { major: "CS" }, provider: "regex", latencyMs: 1 }));
    $("resume-extract").click();
    await settle();
    $("review-discard").click();
    expect($("resume-review").childElementCount).toBe(0);
  });

  it("fills the textarea from an uploaded file and shows a failed PDF as an error", async () => {
    const readFile = vi.fn(async (file: File) => (file.name === "ok.pdf" ? { ok: true as const, text: "Alex Chen", pages: 2 } : { ok: false as const, error: PDF_FAILED }));
    mount(vi.fn() as unknown as typeof fetch, { readFile });
    const input = $<HTMLInputElement>("resume-file");
    const pick = async (name: string): Promise<void> => {
      Object.defineProperty(input, "files", { configurable: true, value: [pdfFile(name)] });
      input.dispatchEvent(new Event("change"));
      await settle();
    };
    await pick("ok.pdf");
    expect($<HTMLTextAreaElement>("resume-text").value).toBe("Alex Chen");
    expect($("resume-file-note").textContent).toBe("ok.pdf, 2 pages");
    expect($<HTMLButtonElement>("resume-extract").disabled).toBe(false);
    await pick("broken.pdf");
    expect($("resume-error").textContent).toBe(PDF_FAILED);
  });
});
