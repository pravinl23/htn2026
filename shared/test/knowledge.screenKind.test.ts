// Screen kinds from structure alone (docs/knowledge.md section 2, benchmark surfaces from section 6).
//
// Every fixture is a SHAPE. None of them names a site or an app, and none of the rules under test could use one:
// if a test here needed to know where it was, the layer would be overfitted to that place.
import { describe, expect, it } from "vitest";
import { SCREEN_KINDS, inferScreenKind, measureScreen, screenKindFromSignals } from "../src";
import type { ScreenEvidence, ScreenKind, ScreenNode } from "../src";
import {
  allSurfaces,
  basketScreen,
  box,
  encyclopediaArticle,
  fileBrowser,
  gameBoard,
  messageList,
  messageThread,
  musicPlayer,
  node,
  noteEditor,
  photoFeed,
  productScreen,
  professionalFeed,
  settingsPane,
  signupForm,
  unreadableWindow,
  videoPlayer,
  videoWall,
} from "./helpers/knowledgeFixtures";
import type { SurfaceFixture } from "./helpers/knowledgeFixtures";

const EVIDENCE_CODES: readonly ScreenEvidence[] = [
  "media-element", "media-controls", "media-playing", "repeated-items", "many-repeated-items", "large-items",
  "compact-rows", "two-panes", "detail-pane", "cell-grid", "equal-cells", "toggle-rows", "many-toggle-rows",
  "labelled-rows", "dominant-editor", "editable-region", "text-region", "long-text-region", "few-controls",
  "field-cluster", "many-fields", "price-markers", "price-rows", "single-item", "controls-only", "nothing-to-read",
];

describe("inferScreenKind places a screen by its shape", () => {
  it.each<[string, () => SurfaceFixture, ScreenKind]>([
    ["a picture feed", photoFeed, "feed"],
    ["a feed of written posts", professionalFeed, "feed"],
    ["a list of messages with one open", messageList, "list"],
    ["one open message thread", messageThread, "reader"],
    ["a grid of video thumbnails", videoWall, "feed"],
    ["a playing video with a rail", videoPlayer, "media"],
    ["a long reference article", encyclopediaArticle, "reader"],
    ["one item for sale", productScreen, "commerce"],
    ["a basket of lines", basketScreen, "commerce"],
    ["a music player with a queue", musicPlayer, "media"],
    ["a board of equal squares", gameBoard, "board"],
    ["a pane of labelled switches", settingsPane, "settings"],
    ["a document being written", noteEditor, "editor"],
    ["a browser of files", fileBrowser, "list"],
    ["a form of labelled fields", signupForm, "form"],
    ["a window with two nameless controls", unreadableWindow, "unknown"],
  ])("calls %s a %s screen", (_name, make, kind) => {
    expect(inferScreenKind(make().tree).kind).toBe(kind);
  });

  it("covers every kind the layer knows except none", () => {
    const seen = new Set(allSurfaces().map((fixture) => inferScreenKind(fixture.tree).kind));
    for (const kind of SCREEN_KINDS) expect(seen.has(kind)).toBe(true);
  });

  it("reports only closed-set evidence codes", () => {
    for (const fixture of allSurfaces()) {
      for (const code of inferScreenKind(fixture.tree).evidence) expect(EVIDENCE_CODES).toContain(code);
    }
  });

  it("keeps confidence inside its band, and is honest about a screen it cannot read", () => {
    for (const fixture of allSurfaces()) {
      const guess = inferScreenKind(fixture.tree);
      expect(guess.confidence).toBeGreaterThanOrEqual(0.3);
      expect(guess.confidence).toBeLessThanOrEqual(0.92);
    }
    expect(inferScreenKind(unreadableWindow().tree).confidence).toBeLessThan(0.5);
    expect(inferScreenKind(videoPlayer().tree).confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("gives every recognized screen more confidence than a screen it cannot place", () => {
    const floor = inferScreenKind(unreadableWindow().tree).confidence;
    for (const fixture of allSurfaces()) {
      if (fixture.kind === "unknown") continue;
      expect(inferScreenKind(fixture.tree).confidence).toBeGreaterThan(floor);
    }
  });
});

describe("the rules that decide between two shapes", () => {
  it("lets a media node beat the rail of items beside it", () => {
    const player = videoPlayer();
    expect(measureScreen(player.tree).repeatCount).toBeGreaterThanOrEqual(4);
    expect(inferScreenKind(player.tree).kind).toBe("media");
  });

  it("stops being a media screen when the media node goes away", () => {
    const player = videoPlayer();
    const signals = { ...measureScreen(player.tree), media: 0, mediaControlCluster: false, mediaPlaying: false };
    expect(screenKindFromSignals(signals).kind).not.toBe("media");
  });

  it("calls a grid of small equal cells a board, not a feed", () => {
    const board = gameBoard();
    const signals = measureScreen(board.tree);
    expect(signals.cellGrid).toBeGreaterThanOrEqual(9);
    expect(signals.repeatCount).toBeGreaterThan(8);
    expect(screenKindFromSignals(signals).kind).toBe("board");
  });

  it("does not call a wall of large thumbnails a board", () => {
    expect(measureScreen(videoWall().tree).cellGrid).toBe(0);
  });

  it("counts a row's switch as a setting, not as a form field", () => {
    const signals = measureScreen(settingsPane().tree);
    expect(signals.toggleRows).toBe(8);
    expect(signals.fields).toBe(0);
    expect(screenKindFromSignals(signals).kind).toBe("settings");
  });

  it("still calls a column of labelled inputs a form", () => {
    const signals = measureScreen(signupForm().tree);
    expect(signals.fields).toBeGreaterThanOrEqual(6);
    expect(signals.toggleRows).toBeLessThan(3);
    expect(screenKindFromSignals(signals).kind).toBe("form");
  });

  it("lets one editable region that owns the window beat the rail beside it", () => {
    const editor = noteEditor();
    const signals = measureScreen(editor.tree);
    expect(signals.editorShare).toBeGreaterThan(0.2);
    expect(signals.twoPanes).toBe(true);
    expect(screenKindFromSignals(signals).kind).toBe("editor");
  });

  it("treats a rail that carries no text of its own as navigation, not as a list of things", () => {
    const article = measureScreen(encyclopediaArticle().tree);
    const mail = measureScreen(messageList().tree);
    expect(article.twoPanes).toBe(true);
    expect(article.repeatWithText).toBe(0);
    expect(mail.repeatWithText).toBeGreaterThanOrEqual(3);
    expect(screenKindFromSignals(article).kind).toBe("reader");
    expect(screenKindFromSignals(mail).kind).toBe("list");
  });

  it("separates one long run of text from many short ones", () => {
    const article = measureScreen(encyclopediaArticle().tree);
    const feed = measureScreen(professionalFeed().tree);
    expect(article.maxTextNode).toBeGreaterThan(400);
    expect(feed.maxTextNode).toBeLessThan(400);
    expect(feed.textChars).toBeGreaterThan(600);
    expect(screenKindFromSignals(feed).kind).toBe("feed");
  });

  it("reads currency-shaped values on repeated rows as a basket", () => {
    const basket = measureScreen(basketScreen().tree);
    expect(basket.repeatWithPrice).toBeGreaterThanOrEqual(2);
    expect(screenKindFromSignals(basket).kind).toBe("commerce");
    expect(screenKindFromSignals({ ...basket, priceNodes: 0, repeatWithPrice: 0 }).kind).not.toBe("commerce");
  });

  it("reads one picture beside two currency-shaped values as one thing for sale", () => {
    const product = measureScreen(productScreen().tree);
    expect(product.priceNodes).toBe(2);
    expect(product.repeatCount).toBeLessThan(4);
    expect(screenKindFromSignals(product).kind).toBe("commerce");
  });
});

describe("the walk itself", () => {
  it("measures the same screen the same way through both entry points", () => {
    for (const fixture of allSurfaces()) {
      expect(screenKindFromSignals(measureScreen(fixture.tree))).toEqual(inferScreenKind(fixture.tree));
    }
  });

  it("returns unknown for a screen with nothing on it", () => {
    const guess = inferScreenKind(node("group"));
    expect(guess.kind).toBe("unknown");
    expect(guess.evidence).toContain("nothing-to-read");
  });

  it("works on a tree with no rectangles at all, which is what a sparse accessibility walk gives", () => {
    const tree: ScreenNode = {
      role: "region",
      children: [
        { role: "textbox" }, { role: "textbox" }, { role: "textbox" }, { role: "textbox" },
        { role: "select" }, { role: "button" },
      ],
    };
    expect(inferScreenKind(tree).kind).toBe("form");
  });

  it("finds a repeated group without needing a list container", () => {
    const tree: ScreenNode = {
      role: "region",
      rect: box(0, 0, 1000, 800),
      children: Array.from({ length: 6 }, (_, i) => ({
        role: "item" as const,
        rect: box(0, i * 120, 900, 110),
        children: [{ role: "text" as const, rect: box(0, i * 120, 900, 40), textLength: 50 }],
      })),
    };
    expect(measureScreen(tree).repeatCount).toBe(6);
  });

  it("does not invent a repeated group out of two children", () => {
    const tree: ScreenNode = {
      role: "region",
      rect: box(0, 0, 1000, 800),
      children: [node("item", box(0, 0, 400, 200)), node("item", box(0, 210, 400, 200))],
    };
    expect(measureScreen(tree).repeatCount).toBe(0);
  });

  it("only counts equal boxes as one repeated group", () => {
    const tree: ScreenNode = {
      role: "list",
      rect: box(0, 0, 1000, 800),
      children: [
        node("item", box(0, 0, 400, 100)),
        node("item", box(0, 110, 400, 100)),
        node("item", box(0, 220, 400, 100)),
        node("item", box(0, 330, 900, 300)),
      ],
    };
    expect(measureScreen(tree).repeatCount).toBe(3);
  });

  it("keeps the hour of the day, the surface and the text out of what it measures", () => {
    const signals = measureScreen(messageList().tree);
    const serialized = JSON.stringify(signals);
    expect(serialized).not.toContain("s03");
    expect(Object.values(signals).every((value) => typeof value === "number" || typeof value === "boolean")).toBe(true);
  });
});
