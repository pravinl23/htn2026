import { describe, expect, it } from "vitest";
import { ME, MEETING_REQUEST_ID, MESSAGES, findMessage, formatPerson, messagePath } from "./mail";

// A copy of the words shared/src/locks.ts treats as irreversible. Opening an email must never look locked.
const LOCK_WORDS = /submit|send|\bpay\b|order now|\bbuy\b|purchase|check ?out|delete|remove|discard|confirm|\bapply\b|publish|\bpost\b|transfer|withdraw|\bsign\b|unsubscribe|book now|reserve|donate|finish|complete/i;

describe("inbox data", () => {
  it("has about eight messages with unique ids that contain digits", () => {
    expect(MESSAGES.length).toBe(8);
    expect(new Set(MESSAGES.map((m) => m.id)).size).toBe(MESSAGES.length);
    for (const m of MESSAGES) expect(m.id).toMatch(/\d/);
  });

  it("opens with the meeting request from Priya Nair", () => {
    const top = MESSAGES[0];
    expect(top?.id).toBe(MEETING_REQUEST_ID);
    expect(top?.from.name).toBe("Priya Nair");
    expect(top?.subject).toBe("Quick chat Thursday afternoon?");
    expect(top?.body.join(" ")).toContain("Can we meet Thursday afternoon");
    expect(top?.body.join(" ")).toContain("30 minutes");
  });

  it("uses only example.com addresses", () => {
    for (const person of [ME, ...MESSAGES.map((m) => m.from)]) expect(person.email).toMatch(/@example\.com$/);
  });

  it("keeps subjects unique and free of words Ghost locks", () => {
    expect(new Set(MESSAGES.map((m) => m.subject)).size).toBe(MESSAGES.length);
    for (const m of MESSAGES) expect(m.subject).not.toMatch(LOCK_WORDS);
  });
});

describe("helpers", () => {
  it("finds messages by id", () => {
    expect(findMessage("msg-1001")?.from.name).toBe("Priya Nair");
    expect(findMessage("msg-0000")).toBeUndefined();
    expect(findMessage(undefined)).toBeUndefined();
  });

  it("formats people and paths", () => {
    expect(formatPerson(ME)).toBe("Alex Chen <alex.chen.dev@example.com>");
    expect(messagePath("msg-1001")).toBe("/mail/msg-1001");
  });
});
