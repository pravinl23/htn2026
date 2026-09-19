import { describe, expect, it } from "vitest";
import { makeSlot } from "./calendar";
import { MEETING_REQUEST_ID } from "./mail";
import {
  MAIL_KEYS, MAIL_PREFIX, backToMailPath, clearMailState, memoryStorage, parsePickedSlot, parseSentReplies,
  pickedSlotText, rawFingerprint, readMailState, resetIfRequested, saveLastOpenedId, savePickedSlot, saveSentReply,
  wantsReset,
} from "./mailStorage";

const THURSDAY = makeSlot("Thursday", "14:30");

describe("mail storage keys", () => {
  it("prefixes every key with ghostdemo.mail.", () => {
    for (const key of Object.values(MAIL_KEYS)) expect(key.startsWith(MAIL_PREFIX)).toBe(true);
    expect(MAIL_PREFIX.startsWith("ghostdemo.")).toBe(true);
  });
});

describe("readMailState", () => {
  it("starts empty", () => {
    expect(readMailState(memoryStorage())).toEqual({ pickedSlot: null, sentReplies: {}, lastOpenedId: null });
  });

  it("round trips a picked slot, sent replies and the last opened id", () => {
    const storage = memoryStorage();
    expect(savePickedSlot(THURSDAY, storage)).toBe(true);
    saveSentReply("msg-1001", "Thursday 2:30 PM works.", storage);
    saveSentReply("msg-1002", "Thanks Marcus.", storage);
    saveLastOpenedId("msg-1001", storage);

    expect(readMailState(storage)).toEqual({
      pickedSlot: { day: "Thursday", start: "14:30", end: "15:00", label: "Thursday 2:30 PM to 3:00 PM" },
      sentReplies: { "msg-1001": "Thursday 2:30 PM works.", "msg-1002": "Thanks Marcus." },
      lastOpenedId: "msg-1001",
    });
  });

  it("stores the picked slot as the documented JSON shape", () => {
    const storage = memoryStorage();
    savePickedSlot(THURSDAY, storage);
    expect(JSON.parse(storage.getItem(MAIL_KEYS.pickedSlot) ?? "null")).toEqual({
      day: "Thursday",
      start: "14:30",
      end: "15:00",
      label: "Thursday 2:30 PM to 3:00 PM",
    });
  });

  it("removes the picked slot when saved as null", () => {
    const storage = memoryStorage();
    savePickedSlot(THURSDAY, storage);
    savePickedSlot(null, storage);
    expect(storage.getItem(MAIL_KEYS.pickedSlot)).toBeNull();
  });

  it("survives a storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readMailState(broken)).toEqual({ pickedSlot: null, sentReplies: {}, lastOpenedId: null });
    expect(savePickedSlot(THURSDAY, broken)).toBe(false);
  });
});

describe("parsing untrusted values", () => {
  it("rejects malformed picked slots", () => {
    expect(parsePickedSlot(null)).toBeNull();
    expect(parsePickedSlot("not json")).toBeNull();
    expect(parsePickedSlot("[]")).toBeNull();
    expect(parsePickedSlot(JSON.stringify({ day: "Sunday", start: "14:30", end: "15:00" }))).toBeNull();
    expect(parsePickedSlot(JSON.stringify({ day: "Thursday", start: "2:30 PM", end: "15:00" }))).toBeNull();
    expect(parsePickedSlot(JSON.stringify({ day: "Thursday", start: "15:00", end: "14:30" }))).toBeNull();
  });

  it("rebuilds the label instead of trusting the stored one", () => {
    const raw = JSON.stringify({ day: "Thursday", start: "14:30", end: "15:00", label: "<b>anything</b>" });
    expect(parsePickedSlot(raw)?.label).toBe("Thursday 2:30 PM to 3:00 PM");
  });

  it("keeps only string replies", () => {
    expect(parseSentReplies(JSON.stringify({ a: "ok", b: 3, c: null }))).toEqual({ a: "ok" });
    expect(parseSentReplies("[1,2]")).toEqual({});
    expect(parseSentReplies("{broken")).toEqual({});
  });
});

describe("fingerprint", () => {
  it("changes with every write and returns after a clear", () => {
    const storage = memoryStorage();
    const empty = rawFingerprint(storage);
    savePickedSlot(THURSDAY, storage);
    const picked = rawFingerprint(storage);
    expect(picked).not.toBe(empty);
    saveLastOpenedId("msg-1001", storage);
    expect(rawFingerprint(storage)).not.toBe(picked);
    clearMailState(storage);
    expect(rawFingerprint(storage)).toBe(empty);
  });
});

describe("reset", () => {
  it("recognizes ?reset=1", () => {
    expect(wantsReset("?reset=1")).toBe(true);
    expect(wantsReset("?foo=bar&reset=1")).toBe(true);
    expect(wantsReset("?reset=true")).toBe(true);
    expect(wantsReset("")).toBe(false);
    expect(wantsReset("?reset=0")).toBe(false);
    expect(wantsReset("?preset=1")).toBe(false);
  });

  it("clears only the mail keys, and only when asked", () => {
    const storage = memoryStorage({ "ghostdemo.sheet.rows": "[]" });
    savePickedSlot(THURSDAY, storage);
    saveSentReply("msg-1001", "hello", storage);
    saveLastOpenedId("msg-1001", storage);

    expect(resetIfRequested("", storage)).toBe(false);
    expect(readMailState(storage).pickedSlot).not.toBeNull();

    expect(resetIfRequested("?reset=1", storage)).toBe(true);
    expect(readMailState(storage)).toEqual({ pickedSlot: null, sentReplies: {}, lastOpenedId: null });
    expect(storage.getItem("ghostdemo.sheet.rows")).toBe("[]");
  });
});

describe("cross page helpers", () => {
  it("sends 'Back to mail' to the message the user came from, else the inbox", () => {
    expect(backToMailPath(MEETING_REQUEST_ID)).toBe("/mail/msg-1001");
    expect(backToMailPath(null)).toBe("/mail");
    expect(backToMailPath("msg-9999")).toBe("/mail");
  });

  it("words the picked time chip", () => {
    expect(pickedSlotText(THURSDAY)).toBe("Picked time: Thursday 2:30 PM to 3:00 PM");
  });
});
