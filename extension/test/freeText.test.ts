// Speculative drafts: scheduling (three at a time, once per field, abort on typing), what a request may
// carry, and the port to the worker.
import { DEMO_PROFILE } from "@ghost/shared";
import type { CapturedField, Profile } from "@ghost/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftScheduler, MAX_DRAFTS_PER_PAGE, buildTextRequest, clipDraft, openTextPort, similarPastAnswers } from "../src/content/freeText";
import type { DraftChange, DraftJob, OpenTextStream } from "../src/content/freeText";
import type { GhostTextRequest, TextPortEvent } from "../src/lib/messages";

const field = (overrides: Partial<CapturedField> = {}): CapturedField => ({
  signature: "textarea||why|why|why northwind|0", label: "Why Northwind?", kind: "textarea", rect: { x: 0, y: 0, width: 0, height: 0 }, ...overrides,
});

const request = (signature: string): GhostTextRequest => ({ fieldLabel: `Question ${signature}`, fieldSignature: signature, pageContext: {}, facts: {}, pastAnswers: [] });
const job = (signature: string, extra: Partial<DraftJob> = {}): DraftJob => ({ signature, build: () => request(signature), ...extra });

/** A fake worker: every opened stream is recorded and driven by the test. */
function fakeStreams() {
  const opened: Array<{ request: GhostTextRequest; emit(event: TextPortEvent): void; aborted: boolean }> = [];
  const open: OpenTextStream = (req, onEvent) => {
    const stream = { request: req, emit: onEvent, aborted: false };
    opened.push(stream);
    return { abort: () => void (stream.aborted = true) };
  };
  const bySignature = (signature: string) => {
    const stream = opened.find((s) => s.request.fieldSignature === signature);
    if (!stream) throw new Error(`no stream was opened for ${signature}`);
    return stream;
  };
  return { open, opened, bySignature };
}

const done = (text: string, provider = "template"): TextPortEvent => ({ type: "done", text, provider, latencyMs: 5, firstTokenMs: 1 });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DraftScheduler", () => {
  it("starts every wanted field at once, three at a time, and hands a freed slot to the next in line", () => {
    const { open, opened, bySignature } = fakeStreams();
    const drafts = new DraftScheduler({ open });
    for (const signature of ["a", "b", "c", "d", "e"]) drafts.want(job(signature));
    expect(opened.map((s) => s.request.fieldSignature)).toEqual(["a", "b", "c"]);
    expect(drafts.active()).toBe(3);

    bySignature("b").emit(done("Draft for b."));
    expect(opened.map((s) => s.request.fieldSignature)).toEqual(["a", "b", "c", "d"]);
    bySignature("a").emit({ type: "error", error: "server unreachable" });
    expect(opened.map((s) => s.request.fieldSignature)).toEqual(["a", "b", "c", "d", "e"]);
    expect(drafts.active()).toBe(3);
  });

  it("never asks twice for the same field on one page load, however often the form is rescanned", () => {
    const { open, opened, bySignature } = fakeStreams();
    const drafts = new DraftScheduler({ open });
    const build = vi.fn(() => request("a"));
    for (let i = 0; i < 5; i++) drafts.want({ signature: "a", build });
    bySignature("a").emit(done("Only once."));
    drafts.want({ signature: "a", build }); // done: cached for the page load
    expect(build).toHaveBeenCalledTimes(1);
    expect(opened).toHaveLength(1);
    expect(drafts.get("a")).toEqual({ text: "Only once.", pending: false });
  });

  it("builds a request only when its turn comes, and skips a field whose request cannot be built", () => {
    const { open, opened } = fakeStreams();
    const drafts = new DraftScheduler({ open, maxConcurrent: 1 });
    const later = vi.fn(() => request("later"));
    drafts.want(job("first"));
    drafts.want({ signature: "unbuildable", build: () => null });
    drafts.want({ signature: "later", build: later });
    expect(later).not.toHaveBeenCalled();
    opened[0]?.emit(done("First."));
    expect(later).toHaveBeenCalledTimes(1);
    expect(opened.map((s) => s.request.fieldSignature)).toEqual(["first", "later"]);
    expect(drafts.get("unbuildable")).toBeUndefined();
  });

  it("grows the draft with every delta and takes the final text from the done event", () => {
    const { open, bySignature } = fakeStreams();
    const drafts = new DraftScheduler({ open });
    const changes: Array<[string, DraftChange]> = [];
    drafts.subscribe((signature, change) => void changes.push([signature, change]));
    drafts.want(job("a"));
    expect(drafts.get("a")).toBeUndefined(); // nothing to show before the first token
    bySignature("a").emit({ type: "delta", delta: "I want " });
    expect(drafts.get("a")).toEqual({ text: "I want ", pending: true });
    bySignature("a").emit({ type: "delta", delta: "to build robots." });
    expect(drafts.get("a")).toEqual({ text: "I want to build robots.", pending: true });
    // The server discarded the streamed draft (it quoted an email address) and answered with its template instead.
    bySignature("a").emit(done("A safe template answer."));
    expect(drafts.get("a")).toEqual({ text: "A safe template answer.", pending: false });
    expect(changes).toEqual([["a", "text"], ["a", "text"], ["a", "done"]]);
    bySignature("a").emit({ type: "delta", delta: " late noise" });
    expect(drafts.get("a")?.text).toBe("A safe template answer.");
  });

  it("aborts the stream when the user types, frees the slot, and never drafts that field again", () => {
    const { open, opened, bySignature } = fakeStreams();
    const drafts = new DraftScheduler({ open });
    const changes: DraftChange[] = [];
    drafts.subscribe((_signature, change) => void changes.push(change));
    for (const signature of ["a", "b", "c", "d"]) drafts.want(job(signature));
    bySignature("a").emit({ type: "delta", delta: "Half a thought" });

    drafts.abort("a");
    expect(bySignature("a").aborted).toBe(true);
    expect(drafts.get("a")).toBeUndefined();
    expect(opened.map((s) => s.request.fieldSignature)).toEqual(["a", "b", "c", "d"]); // d took the slot
    bySignature("a").emit(done("Too late."));
    expect(drafts.get("a")).toBeUndefined();
    expect(changes).toEqual(["text"]); // the abort is the controller's own doing: no event for it

    drafts.want(job("a"));
    expect(opened).toHaveLength(4);
  });

  it("drops a queued field the user typed in before its turn, and remembers typing in a field nobody asked about yet", () => {
    const { open, opened } = fakeStreams();
    const drafts = new DraftScheduler({ open, maxConcurrent: 1 });
    drafts.want(job("a"));
    drafts.want(job("queued"));
    drafts.abort("queued");
    drafts.abort("typed-early");
    opened[0]?.emit(done("A."));
    drafts.want(job("typed-early"));
    expect(opened).toHaveLength(1);
    expect(drafts.has("typed-early")).toBe(true);
  });

  it("caps the drafts of one page load", () => {
    const { open, opened } = fakeStreams();
    const drafts = new DraftScheduler({ open, maxConcurrent: 100 });
    for (let i = 0; i < MAX_DRAFTS_PER_PAGE + 5; i++) drafts.want(job(`field-${i}`));
    expect(opened).toHaveLength(MAX_DRAFTS_PER_PAGE);
  });

  it("settled() resolves on done, on failure, on abort, and gives up after the timeout", async () => {
    vi.useFakeTimers();
    const { open, bySignature } = fakeStreams();
    const drafts = new DraftScheduler({ open, maxConcurrent: 10 });
    for (const signature of ["ok", "bad", "typed", "slow"]) drafts.want(job(signature));
    const outcomes = Promise.all(["ok", "bad", "typed", "slow", "unknown"].map((signature) => drafts.settled(signature, 4000)));
    bySignature("ok").emit(done("Fine."));
    bySignature("bad").emit({ type: "error", error: "stream ended early" });
    drafts.abort("typed");
    await vi.advanceTimersByTimeAsync(4000);
    expect(await outcomes).toEqual(["done", "failed", "failed", "timeout", "failed"]);
    bySignature("slow").emit(done("Finally."));
    expect(await drafts.settled("slow", 4000)).toBe("done");
  });

  it("treats an empty final text as a failure", () => {
    const { open, bySignature } = fakeStreams();
    const drafts = new DraftScheduler({ open });
    const changes: DraftChange[] = [];
    drafts.subscribe((_signature, change) => void changes.push(change));
    drafts.want(job("a"));
    bySignature("a").emit({ type: "delta", delta: "x" });
    bySignature("a").emit(done("   "));
    expect(drafts.get("a")).toBeUndefined();
    expect(changes).toEqual(["text", "failed"]);
  });

  it("reports provider, first-token and total latency of the last finished draft, as the user waited for it", () => {
    const { open, bySignature } = fakeStreams();
    let now = 1000;
    const drafts = new DraftScheduler({ open, now: () => now });
    expect(drafts.stats()).toBeNull();
    drafts.want(job("a"));
    now = 1210;
    bySignature("a").emit({ type: "delta", delta: "First" });
    now = 1300;
    bySignature("a").emit({ type: "delta", delta: " second" });
    now = 2234;
    bySignature("a").emit(done("First second.", "xai"));
    expect(drafts.stats()).toEqual({ provider: "xai", firstTokenMs: 210, totalMs: 1234 });
  });

  it("reset() stops every stream and forgets every draft, so a new page starts clean", async () => {
    const { open, opened, bySignature } = fakeStreams();
    const drafts = new DraftScheduler({ open, maxConcurrent: 1 });
    drafts.want(job("a"));
    drafts.want(job("b"));
    const waiting = drafts.settled("a", 60_000);
    drafts.reset();
    expect(await waiting).toBe("failed");
    expect(bySignature("a").aborted).toBe(true);
    expect(drafts.active()).toBe(0);
    expect(drafts.has("a")).toBe(false);
    drafts.want(job("a"));
    expect(opened).toHaveLength(2);
  });

  it("survives a stream that fails before open() even returns", () => {
    const open: OpenTextStream = (_req, onEvent) => {
      onEvent({ type: "error", error: "no-worker" });
      return { abort: vi.fn() };
    };
    const drafts = new DraftScheduler({ open });
    drafts.want(job("a"));
    drafts.want(job("b"));
    expect(drafts.active()).toBe(0);
    expect(drafts.get("a")).toBeUndefined();
  });
});

describe("clipDraft (maxlength)", () => {
  it("leaves a draft within the limit alone", () => {
    expect(clipDraft("Short and sweet. ", 280, false)).toBe("Short and sweet.");
    expect(clipDraft("\r\nLine one\r\nLine two", undefined, false)).toBe("Line one\nLine two");
  });

  it("cuts a finished draft back to its last whole sentence, or word, inside the limit", () => {
    const text = "I build robots for fun. I also write tests for them. And then a very long tail follows here.";
    const clipped = clipDraft(text, 60, false);
    expect(clipped).toBe("I build robots for fun. I also write tests for them.");
    expect(clipDraft("Supercalifragilistic expialidocious words keep going on", 30, false)).toBe("Supercalifragilistic");
    expect(clipDraft("x".repeat(100), 40, false)).toHaveLength(40);
  });

  it("only slices while the draft is still streaming", () => {
    expect(clipDraft("I build robots for fun. I also wri", 30, true)).toBe("I build robots for fun. I also");
  });
});

describe("buildTextRequest: what may leave for a draft", () => {
  const context = { company: "Northwind Robotics", role: "Software Engineering Intern", description: "We build robots." };

  it("sends only the allowlisted facts: never email, phone, LinkedIn, work authorization or sponsorship", () => {
    const built = buildTextRequest(field(), DEMO_PROFILE, context);
    expect(built?.facts).toEqual({
      fullName: "Alex Chen", firstName: "Alex", lastName: "Chen", school: "University of Waterloo", degree: "BCS Computer Science",
      major: "Computer Science", graduationDate: "2028-04", location: "Waterloo, ON", github: "https://github.com/alexchen-dev", website: "https://alexchen.dev",
    });
    const wire = JSON.stringify(built);
    for (const secret of ["alex.chen.dev@example.com", "519 555 0142", "linkedin", "workAuthorization", "requiresSponsorship", "Hack the North"]) {
      expect(wire).not.toContain(secret);
    }
    expect(built).toMatchObject({ fieldLabel: "Why Northwind?", fieldSignature: field().signature, pageContext: context });
  });

  it("drops an allowlisted fact whose value is itself an email address or a phone number", () => {
    const profile: Profile = { facts: { fullName: "Alex Chen", website: "alex.chen.dev@example.com", location: "+1 519 555 0142" }, pastAnswers: [] };
    expect(buildTextRequest(field(), profile, {})?.facts).toEqual({ fullName: "Alex Chen" });
  });

  it("passes maxlength on as maxChars, and asks for nothing when the label is missing or sensitive", () => {
    expect(buildTextRequest(field(), DEMO_PROFILE, {}, 280)?.maxChars).toBe(280);
    expect(buildTextRequest(field(), DEMO_PROFILE, {}, 99_999)?.maxChars).toBe(5000);
    expect(buildTextRequest(field(), DEMO_PROFILE, {})).not.toHaveProperty("maxChars");
    expect(buildTextRequest(field({ label: "  " }), DEMO_PROFILE, {})).toBeNull();
    expect(buildTextRequest(field({ label: "Security question answer" }), DEMO_PROFILE, {})).toBeNull();
    expect(buildTextRequest(field({ label: "Notes", name: "cardNumber" }), DEMO_PROFILE, {})).toBeNull();
  });

  it("sends up to three past answers whose question overlaps with the label, closest first", () => {
    const pastAnswers = [
      { question: "What is your favourite colour?", answer: "Teal." },
      { question: "Tell us about a project you are proud of", answer: "A telemetry replayer.", origin: "https://acme.example", savedAt: "2026-02-01" },
      { question: "Describe a project you're proud of and why", answer: "A robot arm." },
      { question: "Project you are most proud of?", answer: "Ghost." },
      { question: "Tell us about a hard project", answer: "A compiler." },
    ];
    const similar = similarPastAnswers("Tell us about a project you are proud of", pastAnswers);
    expect(similar).toHaveLength(3);
    expect(similar[0]).toEqual({ question: "Tell us about a project you are proud of", answer: "A telemetry replayer." });
    expect(similar.map((p) => p.answer)).not.toContain("Teal.");
    expect(similarPastAnswers("Why Northwind?", pastAnswers)).toEqual([]);
  });

  it("never reuses a past answer that quotes contact details or answers a sensitive question", () => {
    const pastAnswers = [
      { question: "Why do you want to work here?", answer: "Mail me at alex.chen.dev@example.com to find out." },
      { question: "Why do you want to work here?", answer: "Call +1 519 555 0142." },
      { question: "Why is your security question answer so long?", answer: "Because." },
      { question: "Why do you want to work here?", answer: "Robots." },
    ];
    expect(similarPastAnswers("Why do you want to work at Northwind?", pastAnswers)).toEqual([{ question: "Why do you want to work here?", answer: "Robots." }]);
  });
});

describe("openTextPort", () => {
  function fakeRuntime() {
    const listeners = { message: [] as Array<(m: unknown) => void>, disconnect: [] as Array<() => void> };
    const port = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (l: (m: unknown) => void) => void listeners.message.push(l) },
      onDisconnect: { addListener: (l: () => void) => void listeners.disconnect.push(l) },
    };
    const connect = vi.fn(() => port);
    vi.stubGlobal("chrome", { runtime: { connect, lastError: undefined } });
    return { port, connect, send: (m: unknown) => listeners.message.forEach((l) => l(m)), drop: () => listeners.disconnect.forEach((l) => l()) };
  }

  it("opens one ghost:text port, sends the start message and relays validated events until the terminal one", () => {
    const { port, connect, send, drop } = fakeRuntime();
    const events: TextPortEvent[] = [];
    openTextPort(request("a"), (event) => void events.push(event));
    expect(connect).toHaveBeenCalledWith({ name: "ghost:text" });
    expect(port.postMessage).toHaveBeenCalledWith({ type: "start", request: request("a") });
    send({ type: "delta", delta: "Hi" });
    send({ type: "delta", delta: 5 });
    send({ nonsense: true });
    send(done("Hi there."));
    send({ type: "delta", delta: "after the end" });
    drop();
    expect(events).toEqual([{ type: "delta", delta: "Hi" }, done("Hi there.")]);
  });

  it("turns a port that closes without a terminal event into an error, and abort() into silence", () => {
    const first = fakeRuntime();
    const events: TextPortEvent[] = [];
    openTextPort(request("a"), (event) => void events.push(event));
    first.drop();
    expect(events).toEqual([{ type: "error", error: "disconnected" }]);

    const second = fakeRuntime();
    const quiet: TextPortEvent[] = [];
    const stream = openTextPort(request("b"), (event) => void quiet.push(event));
    stream.abort();
    second.send({ type: "delta", delta: "ignored" });
    second.drop();
    expect(second.port.disconnect).toHaveBeenCalledTimes(1);
    expect(quiet).toEqual([]);
  });

  it("reports no-worker, asynchronously, when there is no extension runtime to connect to", async () => {
    const events: TextPortEvent[] = [];
    openTextPort(request("a"), (event) => void events.push(event));
    expect(events).toEqual([]);
    await Promise.resolve();
    expect(events).toEqual([{ type: "error", error: "no-worker" }]);
  });
});
