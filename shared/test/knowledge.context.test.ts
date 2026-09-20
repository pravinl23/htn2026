// The context key (docs/knowledge.md section 2): one shape for a web page and a native window alike.
import { describe, expect, it } from "vitest";
import {
  HOUR_BUCKETS,
  PREVIOUS_NONE,
  actionRefOf,
  candidateFromAx,
  emptyKnowledge,
  hourBucketOf,
  measureScreen,
  nativeContext,
  previousActionOf,
  rankActions,
  webContext,
} from "../src";
import type { AxCandidate, SurfaceCandidate } from "../src";
import { cand, gameBoard, messageList, settingsPane, signupForm, unreadableWindow, videoPlayer } from "./helpers/knowledgeFixtures";

const AT = new Date(2026, 8, 19, 10, 30);

function contextFor(fixture = settingsPane()) {
  return webContext({
    surface: fixture.surface,
    candidates: fixture.candidates,
    screen: fixture.tree,
    at: AT,
    ...(fixture.state ? { state: fixture.state } : {}),
    ...(fixture.previousAction ? { previousAction: fixture.previousAction } : {}),
    ...(fixture.mainListSignature !== undefined ? { mainListSignature: fixture.mainListSignature } : {}),
  });
}

describe("webContext builds the key from what a DOM walk saw", () => {
  it("carries the surface id through untouched and never parses it", () => {
    const context = webContext({ surface: "s99", candidates: [cand("a", "Search")], screenKind: "feed" });
    expect(context.surface).toBe("s99");
  });

  it("infers the screen kind from the tree", () => {
    expect(contextFor(settingsPane()).screenKind).toBe("settings");
    expect(contextFor(videoPlayer()).screenKind).toBe("media");
  });

  it("takes a screen kind the caller already knows instead of walking again", () => {
    const context = webContext({ surface: "s99", candidates: [cand("a", "Reply")], screenKind: "reader", screenConfidence: 0.8 });
    expect(context.screenKind).toBe("reader");
    expect(context.screenConfidence).toBe(0.8);
  });

  it("accepts measured signals in place of a tree", () => {
    const fixture = settingsPane();
    const fromTree = webContext({ surface: fixture.surface, candidates: fixture.candidates, screen: fixture.tree });
    const fromSignals = webContext({ surface: fixture.surface, candidates: fixture.candidates, signals: measureScreen(fixture.tree) });
    expect(fromSignals.screenKind).toBe(fromTree.screenKind);
  });

  it("gives every candidate a role, a role confidence and a lock flag", () => {
    for (const candidate of contextFor(messageList()).candidates) {
      expect(typeof candidate.role).toBe("string");
      expect(candidate.roleConfidence).toBeGreaterThan(0);
      expect(typeof candidate.locked).toBe("boolean");
    }
  });

  it("keeps no label, no value and no text on a candidate", () => {
    const context = contextFor(messageList());
    const serialized = JSON.stringify(context.candidates);
    expect(serialized).not.toContain("New message");
    expect(serialized).not.toContain("Reply");
  });

  it("locks an irreversible control", () => {
    const context = contextFor(signupForm());
    expect(context.candidates.find((c) => c.id === "submit")?.locked).toBe(true);
    expect(context.candidates.find((c) => c.id === "field-0")?.locked).toBe(false);
  });

  it("puts the hour into a four-hour bucket and nothing finer", () => {
    expect(contextFor().hourBucket).toBe(2);
    expect(JSON.stringify(contextFor())).not.toContain("2026-09-19");
  });

  it("defaults the previous action to none and passes a given one through", () => {
    expect(previousActionOf(contextFor(settingsPane()))).toBe(PREVIOUS_NONE);
    expect(contextFor(videoPlayer()).previousAction).toBe("play");
  });

  it("passes the screen state through for the shape prior to use", () => {
    expect(contextFor(videoPlayer()).state?.mediaPlaying).toBe(true);
  });
});

describe("roles come from what a control offers, plus two structural overrides", () => {
  it("calls a control with a boolean state a toggle when nothing more specific was recognized", () => {
    const ref = actionRefOf({ id: "t", kind: "field", label: "Notifications", locked: false, toggle: true });
    expect(ref.role).toBe("toggle");
    expect(ref.roleConfidence).toBeGreaterThanOrEqual(0.6);
  });

  it("does not turn a switch that clearly does something else into a toggle", () => {
    const ref = actionRefOf({ id: "t", kind: "button", label: "Save", locked: false, toggle: true });
    expect(ref.role).toBe("save");
  });

  it("calls one square of an equal grid a cell", () => {
    expect(actionRefOf({ id: "c", kind: "button", label: "", locked: false, cell: true }).role).toBe("cell");
  });

  it("keeps the list index, which is how the first item of a list wins a tie", () => {
    const ref = actionRefOf({ id: "i", kind: "link", label: "Entry 1", locked: false, list: { listSignature: "L", index: 3 } });
    expect(ref.index).toBe(3);
  });

  it("reads a search field as a search wherever it is", () => {
    const ref = actionRefOf({ id: "s", kind: "field", label: "", locked: false, inputType: "search", placeholder: "Search" });
    expect(ref.role).toBe("search");
  });
});

describe("nativeContext builds the same key from an accessibility walk", () => {
  const ax: AxCandidate[] = [
    { id: "n1", axRole: "AXButton", label: "Full screen", insideMediaControls: true },
    { id: "n2", axRole: "AXCheckBox", label: "Notifications" },
    { id: "n3", axRole: "AXSearchField", label: "" },
    { id: "n4", axRole: "AXLink", label: "Entry 1", repeatKey: "rows", index: 0 },
    { id: "n5", axRole: "AXCell", label: "" },
    { id: "n6", axRole: "AXTextArea", label: "" },
  ];

  it("maps accessibility roles onto the one candidate shape", () => {
    expect(candidateFromAx(ax[0] as AxCandidate).kind).toBe("button");
    expect(candidateFromAx(ax[3] as AxCandidate).kind).toBe("link");
    expect(candidateFromAx(ax[5] as AxCandidate).kind).toBe("field");
  });

  it("recognizes a checkbox as a control with a boolean state", () => {
    expect(candidateFromAx(ax[1] as AxCandidate).toggle).toBe(true);
  });

  it("recognizes a grid cell", () => {
    expect(candidateFromAx(ax[4] as AxCandidate).cell).toBe(true);
  });

  it("turns a repeat key into list membership", () => {
    expect(candidateFromAx(ax[3] as AxCandidate).list).toEqual({ listSignature: "rows", index: 0 });
  });

  it("gives the same roles a browser walk would", () => {
    const context = nativeContext({ surface: "w01", candidates: ax, screenKind: "settings", hasMediaElement: true });
    const roles = Object.fromEntries(context.candidates.map((candidate) => [candidate.id, candidate.role]));
    expect(roles.n1).toBe("fullscreen");
    expect(roles.n2).toBe("toggle");
    expect(roles.n3).toBe("search");
    expect(roles.n5).toBe("cell");
  });

  it("ranks a native window and a web page identically when their shapes match", () => {
    const fixture = settingsPane();
    const web = webContext({ surface: "s12", candidates: fixture.candidates, screen: fixture.tree, at: AT });
    const native = nativeContext({
      surface: "w12",
      candidates: fixture.candidates.map(toAx),
      screen: fixture.tree,
      at: AT,
    });
    expect(native.screenKind).toBe(web.screenKind);
    const graph = emptyKnowledge();
    const webRanking = rankActions(web, graph).map((row) => `${row.id}:${row.role}:${row.score}`);
    const nativeRanking = rankActions(native, graph).map((row) => `${row.id}:${row.role}:${row.score}`);
    expect(nativeRanking).toEqual(webRanking);
  });

  it("still builds a key for a window it cannot place", () => {
    const fixture = unreadableWindow();
    const context = nativeContext({ surface: "w16", candidates: fixture.candidates.map(toAx), screen: fixture.tree });
    expect(context.screenKind).toBe("unknown");
    expect(context.candidates).toHaveLength(2);
  });

  it("carries a board of cells through the accessibility path", () => {
    const fixture = gameBoard();
    const context = nativeContext({ surface: "w11", candidates: fixture.candidates.map(toAx), screen: fixture.tree });
    expect(context.screenKind).toBe("board");
    expect(context.candidates.filter((candidate) => candidate.role === "cell")).toHaveLength(8);
  });
});

describe("hourBucketOf", () => {
  it.each([
    [0, 0], [3, 0], [4, 1], [7, 1], [8, 2], [11, 2], [12, 3], [15, 3], [16, 4], [19, 4], [20, 5], [23, 5],
  ])("puts hour %i in bucket %i", (hour, bucket) => {
    expect(hourBucketOf(new Date(2026, 0, 1, hour, 0))).toBe(bucket);
  });

  it("returns one of the six buckets for any input", () => {
    expect(HOUR_BUCKETS).toContain(hourBucketOf(Date.now()));
    expect(HOUR_BUCKETS).toContain(hourBucketOf(new Date(Number.NaN)));
  });
});

/** A DOM candidate expressed the way an accessibility walk would report the same control. */
function toAx(candidate: SurfaceCandidate): AxCandidate {
  const role = candidate.toggle === true ? "AXCheckBox" : candidate.cell === true ? "AXCell" : axRoleFor(candidate);
  const out: AxCandidate = { id: candidate.id, axRole: role, label: candidate.label };
  if (candidate.locked) out.locked = true;
  if (candidate.insideMediaControls) out.insideMediaControls = true;
  if (candidate.nearbyPrice) out.nearbyPrice = true;
  if (candidate.list) {
    out.repeatKey = candidate.list.listSignature;
    out.index = candidate.list.index;
  }
  return out;
}

function axRoleFor(candidate: SurfaceCandidate): string {
  if (candidate.kind === "link") return "AXLink";
  if (candidate.kind === "field") return candidate.inputType === "search" ? "AXSearchField" : "AXTextField";
  return "AXButton";
}
