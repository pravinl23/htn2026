// A list hands Ghost its headings as rows, in the same list and the same index space as the rows themselves.
//
// Every label below was CAPTURED from a live app on a real Mac (`shabangctl next --frontmost ...`, 2026-09-20),
// which is why they are shaped the way they are: a native table interleaves its column widths into the header
// row's accessible name, so "# Title 50 Album 50 Date added 50 Duration" is one row's real name, not a typo.
//
// The four surfaces are asserted TOGETHER in one test apiece, because fixing headings for a notes app while
// breaking a file list is the failure mode this file exists to prevent.
import { describe, expect, it } from "vitest";
import { classifyAffordance, type AffordanceCandidate, type AffordanceContext } from "../src/affordance/roles";

/** A native list row as `GHField.toCandidateJSONObject` sends it: a button that says what it is in `ariaRole`. */
function row(label: string, index = 0, listSignature = "l1"): AffordanceCandidate {
  return { id: label, kind: "button", label, ariaRole: "listitem", list: { listSignature, index } };
}

const inThatList: AffordanceContext = { mainListSignature: "l1" };

function roleOf(candidate: AffordanceCandidate, context: AffordanceContext = inThatList): string {
  return classifyAffordance(candidate, context).role;
}

describe("a heading is not an item", () => {
  it("does not offer a notes list's own group headings", () => {
    // Measured before this rule: "Pinned" was the top proposal in the whole window at 0.704, ahead of every note.
    for (const heading of ["Pinned", "Today", "Previous 7 Days", "Previous 30 Days"]) {
      expect(roleOf(row(heading)), heading).toBe("section");
    }
    // ...while the notes interleaved with them, at the same depth in the same list, stay openable.
    for (const note of [
      "Sep 21 - HEALTH 105 Assignment 1 (7.5%) Sep 22 - L",
      "Stuff Names 2026-04-20",
      "Traba Scale AI - talk recruiter, do oa 4:35 AM",
      "sarah.ruhe@scale.com No additional text Friday",
      "Jb Shopify 2026-09-10",
    ]) {
      expect(roleOf(row(note, 1)), note).toBe("primary-item");
    }
  });

  it("does not offer a column-title row, in either list that publishes one", () => {
    // A file list and a track list, both of which made their header row zero of the main list.
    expect(roleOf(row("Name Kind Date Last Opened"))).toBe("section");
    expect(roleOf(row("# Title 50 Album 50 Date added 50 Duration"))).toBe("section");
    // Captured from the same app on a different page: one unknown column word used to let the whole row through.
    expect(roleOf(row("# Title 50 Plays 50 Duration"))).toBe("section");
    // The rows under them are untouched.
    expect(roleOf(row("PNG image Sep 6, 2026 at 8:56 PM", 1))).toBe("primary-item");
    expect(roleOf(row("MP3 audio Jul 13, 2026 at 10:35 PM", 2))).toBe("primary-item");
    expect(roleOf(row("pre grrr", 1))).toBe("primary-item");
    expect(roleOf(row("Liked Songs", 2))).toBe("primary-item");
  });

  it("leaves a conversation list alone, headings or not", () => {
    // The strongest flow in the product runs through these rows; none of them may become a heading.
    for (const conversation of [
      "Yasen Behiri, Flip, 2:16 AM",
      "Yuvraj Dwivedi, HOLY, 1:21 AM",
      "Harini, And a backwards cap, 1",
      "Tahseen Rayhan, Alr bet, Yeste",
      "Frank & Johannes, Muted, Frank",
    ]) {
      expect(roleOf(row(conversation)), conversation).toBe("primary-item");
    }
  });

  it("leaves a feed of links alone", () => {
    for (const entry of ["Go to channel NBA", "Shorts", "Subscriptions"]) {
      expect(roleOf({ ...row(entry), kind: "link" }), entry).toBe("primary-item");
    }
  });
});

describe("only a row can be a heading", () => {
  it("keeps a toolbar's own Today button as an action, because it is not in the list", () => {
    // Same word, opposite meaning: in a list it names the rows below it, in a toolbar it jumps to now.
    const button: AffordanceCandidate = { id: "t", kind: "button", label: "Today" };
    expect(classifyAffordance(button, {}).role).not.toBe("section");
  });

  it("needs the WHOLE name, so a row that merely starts with a heading word stays an item", () => {
    for (const note of [
      "Today's standup 9:41 AM",
      "Pinned tabs to sort out",
      "Name of the new kind of date parser",
      "Previous 7 Days of revenue, Sep 2",
    ]) {
      expect(roleOf(row(note)), note).toBe("primary-item");
    }
  });

  it("needs a run of column titles, not one word that happens to be one", () => {
    expect(roleOf(row("Name"))).toBe("primary-item");
    expect(roleOf(row("Date Added"))).toBe("primary-item");
  });
});

describe("a heading can never be the proposal", () => {
  it("scores below every ordinary row, because no place has a prior for it", () => {
    // `section` is deliberately absent from priors.ts: an unlisted role falls back to UNLISTED_PRIOR and sorts
    // under anything the place actually expects. This is the mechanism the fix relies on, so it is asserted.
    const heading = classifyAffordance(row("Today"), inThatList);
    const note = classifyAffordance(row("Stuff Names 2026-04-20", 1), inThatList);
    expect(heading.role).toBe("section");
    expect(heading.evidence).toContain("section-heading");
    expect(note.role).toBe("primary-item");
  });
});
