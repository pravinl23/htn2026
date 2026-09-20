// Synthetic screens for the knowledge-layer tests (docs/knowledge.md section 6).
//
// Sixteen SHAPES of screen, described by structure and generic UI English only. No site, app, product or brand
// name appears here, and no surface id carries one: a surface is "s01". That is the point of the whole layer —
// if a fixture had to name a place for a test to pass, the code would be overfitted to that place.
import type { ActionRole, Rect, ScreenKind, ScreenNode, ScreenState, StructuralRole, SurfaceCandidate } from "../../src";

const W = 1200;
const H = 800;
const ROOT_AREA = W * H;

export function box(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function node(role: StructuralRole, rect?: Rect, over: Partial<ScreenNode> = {}): ScreenNode {
  return rect ? { role, rect, ...over } : { role, ...over };
}

function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

export function cand(id: string, label: string, over: Partial<SurfaceCandidate> = {}): SurfaceCandidate {
  return { id, kind: "button", label, locked: false, ...over };
}

export function listItems(count: number, signature: string, over: Partial<SurfaceCandidate> = {}): SurfaceCandidate[] {
  return repeat(count, (index) =>
    cand(`item-${index}`, `Entry ${index + 1}`, { kind: "link", list: { listSignature: signature, index }, ...over }),
  );
}

const searchField = cand("search", "", { kind: "field", inputType: "search", placeholder: "Search" });

export interface SurfaceFixture {
  /** Opaque. A grouping key and nothing else. */
  surface: string;
  /** What SHAPE of screen this is, in plain words, for the test names and the benchmark table. */
  shape: string;
  kind: ScreenKind;
  tree: ScreenNode;
  candidates: SurfaceCandidate[];
  state?: ScreenState;
  previousAction?: ActionRole;
  mainListSignature?: string | null;
  /** What this (synthetic) person actually wants here. The benchmark measures where it ranks. */
  correct: string;
  /** The role that action classifies as, so a cold-start scan can seed the same role on another surface. */
  correctRole: ActionRole;
}

const root = (children: ScreenNode[]): ScreenNode => node("region", box(0, 0, W, H), { children });
const toolbar = (children: ScreenNode[] = []): ScreenNode => node("toolbar", box(0, 0, W, 56), { children });

/** A column of large cards, each with a picture and a caption: the shape of a picture feed. */
export function photoFeed(): SurfaceFixture {
  const cards = repeat(8, (i) =>
    node("item", box(240, 56 + i * 520, 700, 500), {
      repeatKey: "card",
      children: [
        node("image", box(240, 56 + i * 520, 700, 380)),
        node("text", box(240, 440 + i * 520, 700, 40), { textLength: 60 }),
        node("button", box(240, 490 + i * 520, 90, 32)),
        node("button", box(340, 490 + i * 520, 118, 32)),
        node("button", box(470, 490 + i * 520, 76, 32)),
      ],
    }),
  );
  return {
    surface: "s01",
    shape: "a picture feed",
    kind: "feed",
    tree: root([toolbar([node("textbox", box(900, 10, 280, 36))]), node("list", box(0, 56, W, 744), { children: cards })]),
    candidates: [
      searchField,
      ...listItems(8, "feed-list"),
      cand("fav-0", "Add to favourites"),
      cand("comment-0", "Comment"),
      cand("share-0", "Share"),
    ],
    mainListSignature: "feed-list",
    correct: "fav-0",
    correctRole: "wishlist",
  };
}

/** The same shape with more words per card: a feed of posts people write. */
export function professionalFeed(): SurfaceFixture {
  const cards = repeat(6, (i) =>
    node("item", box(240, 56 + i * 420, 700, 400), {
      repeatKey: "post",
      children: [
        node("image", box(240, 56 + i * 420, 64, 64)),
        node("text", box(240, 130 + i * 420, 700, 200), { textLength: 140 }),
        node("button", box(240, 340 + i * 420, 100, 32)),
        node("button", box(350, 340 + i * 420, 122, 32)),
        node("button", box(480, 340 + i * 420, 88, 32)),
      ],
    }),
  );
  return {
    surface: "s02",
    shape: "a feed of written posts",
    kind: "feed",
    tree: root([toolbar([node("textbox", box(900, 10, 280, 36))]), node("list", box(0, 56, W, 744), { children: cards })]),
    candidates: [searchField, ...listItems(6, "post-list"), cand("react-0", "Like"), cand("comment-0", "Comment"), cand("compose", "New post")],
    mainListSignature: "post-list",
    correct: "item-0",
    correctRole: "primary-item",
  };
}

/** Rows on the left, one of them opened on the right: the list-and-detail shape. */
export function messageList(): SurfaceFixture {
  const rows = repeat(10, (i) =>
    node("row", box(0, 56 + i * 72, 380, 72), { repeatKey: "row", children: [node("text", box(8, 62 + i * 72, 360, 60), { textLength: 70 })] }),
  );
  const detail = node("region", box(384, 56, 816, 744), {
    children: [
      node("heading", box(400, 70, 700, 40), { textLength: 40 }),
      node("text", box(400, 120, 780, 600), { textLength: 700 }),
      node("button", box(400, 740, 90, 32)),
      node("button", box(500, 740, 104, 32)),
      node("button", box(614, 740, 78, 32)),
    ],
  });
  return {
    surface: "s03",
    shape: "a list of messages with one open",
    kind: "list",
    tree: root([
      toolbar([node("textbox", box(900, 10, 280, 36))]),
      node("group", box(0, 56, W, 744), { children: [node("list", box(0, 56, 380, 744), { children: rows }), detail] }),
    ]),
    candidates: [
      searchField,
      ...listItems(10, "row-list"),
      cand("compose", "New message"),
      cand("reply", "Reply"),
      cand("forward", "Forward"),
      cand("archive", "Archive"),
    ],
    mainListSignature: "row-list",
    state: { readingItem: true },
    correct: "compose",
    correctRole: "compose",
  };
}

/** One long thread on its own: a wall of text with a handful of controls. */
export function messageThread(): SurfaceFixture {
  return {
    surface: "s04",
    shape: "one open message thread",
    kind: "reader",
    tree: root([
      toolbar([node("button", box(20, 10, 90, 36)), node("button", box(120, 10, 104, 36)), node("button", box(234, 10, 78, 36))]),
      node("region", box(0, 56, W, 744), {
        children: [node("heading", box(40, 70, 900, 40), { textLength: 50 }), node("text", box(40, 120, 900, 640), { textLength: 2600 })],
      }),
    ]),
    candidates: [cand("reply", "Reply"), cand("forward", "Forward"), cand("archive", "Archive"), cand("back", "Back")],
    previousAction: "primary-item",
    correct: "archive",
    correctRole: "unknown",
  };
}

/** A grid of thumbnails, three across: the shape of a video wall. */
export function videoWall(): SurfaceFixture {
  const tiles = repeat(9, (i) =>
    node("item", box((i % 3) * 400, 56 + Math.floor(i / 3) * 300, 380, 290), {
      repeatKey: "tile",
      children: [
        node("image", box((i % 3) * 400, 56 + Math.floor(i / 3) * 300, 380, 214)),
        node("text", box((i % 3) * 400, 274 + Math.floor(i / 3) * 300, 380, 40), { textLength: 48 }),
      ],
    }),
  );
  return {
    surface: "s05",
    shape: "a grid of video thumbnails",
    kind: "feed",
    tree: root([toolbar([node("textbox", box(900, 10, 280, 36))]), node("list", box(0, 56, W, 900), { children: tiles })]),
    candidates: [searchField, ...listItems(9, "tile-list")],
    mainListSignature: "tile-list",
    correct: "item-0",
    correctRole: "primary-item",
  };
}

/** A playing media node with its controls, and a rail of related things beside it. */
export function videoPlayer(): SurfaceFixture {
  const controls = node("media-controls", box(0, 536, 840, 48), {
    children: repeat(5, (i) => node("button", box(16 + i * 56, 544, 40, 40))),
  });
  const main = node("region", box(0, 56, 840, 744), {
    children: [
      node("media", box(0, 56, 840, 480), { playing: true }),
      controls,
      node("heading", box(16, 600, 800, 36), { textLength: 46 }),
      node("text", box(16, 640, 800, 120), { textLength: 120 }),
    ],
  });
  const rail = node("list", box(848, 56, 344, 744), {
    children: repeat(5, (i) =>
      node("item", box(848, 56 + i * 96, 344, 88), { repeatKey: "rail", children: [node("text", box(856, 60 + i * 96, 320, 40), { textLength: 40 })] }),
    ),
  });
  return {
    surface: "s06",
    shape: "a playing video with a rail beside it",
    kind: "media",
    tree: root([node("group", box(0, 56, W, 744), { children: [main, rail] })]),
    candidates: [
      cand("pause", "Pause", { insideMediaControls: true }),
      cand("fullscreen", "Full screen", { insideMediaControls: true }),
      cand("captions", "Captions", { insideMediaControls: true }),
      cand("mute", "Mute", { insideMediaControls: true }),
      cand("next", "Next video", { insideMediaControls: true }),
      ...listItems(5, "rail-list"),
    ],
    mainListSignature: "rail-list",
    state: { mediaPlaying: true },
    previousAction: "play",
    correct: "fullscreen",
    correctRole: "fullscreen",
  };
}

/** A navigation rail with no text of its own beside a very long article: still an article. */
export function encyclopediaArticle(): SurfaceFixture {
  const nav = node("list", box(0, 56, 220, 744), {
    children: repeat(5, (i) => node("link", box(8, 70 + i * 32, 200, 28), { repeatKey: "toc" })),
  });
  const article = node("region", box(240, 56, 940, 744), {
    children: [node("heading", box(260, 70, 880, 44), { textLength: 40 }), node("text", box(260, 130, 880, 640), { textLength: 6400 })],
  });
  return {
    surface: "s07",
    shape: "a long reference article",
    kind: "reader",
    tree: root([toolbar([node("textbox", box(900, 10, 280, 36))]), node("group", box(0, 56, W, 744), { children: [nav, article] })]),
    candidates: [
      searchField,
      ...repeat(5, (i) => cand(`nav-${i}`, `Section ${i + 1}`, { kind: "link", list: { listSignature: "toc", index: i } })),
      cand("edit", "Edit this page"),
      cand("history", "View history"),
    ],
    mainListSignature: null,
    correct: "search",
    correctRole: "search",
  };
}

/** One thing for sale: a big picture, two currency-shaped values, and a couple of controls. */
export function productScreen(): SurfaceFixture {
  return {
    surface: "s08",
    shape: "one item for sale",
    kind: "commerce",
    tree: root([
      toolbar([node("textbox", box(860, 10, 240, 36)), node("button", box(1140, 10, 40, 40))]),
      node("region", box(0, 56, W, 744), {
        children: [
          node("image", box(40, 80, 520, 520)),
          node("heading", box(600, 80, 520, 40), { textLength: 40 }),
          node("text", box(600, 130, 520, 200), { textLength: 320 }),
          node("text", box(600, 340, 120, 32), { textLength: 8, price: true }),
          node("text", box(730, 340, 120, 32), { textLength: 8, price: true }),
          node("select", box(600, 390, 120, 36)),
          node("button", box(600, 440, 180, 44)),
          node("button", box(800, 440, 200, 44)),
        ],
      }),
    ]),
    candidates: [
      searchField,
      cand("cart-icon", "Cart"),
      cand("add", "Add to cart", { nearbyPrice: true }),
      cand("qty", "Quantity", { kind: "field" }),
      cand("fav", "Add to favourites"),
    ],
    state: { cartCount: 0 },
    correct: "add",
    correctRole: "cart",
  };
}

/** Rows that each carry a currency-shaped value, and a total underneath: a basket. */
export function basketScreen(): SurfaceFixture {
  const lines = repeat(3, (i) =>
    node("row", box(40, 80 + i * 150, 900, 140), {
      repeatKey: "line",
      children: [
        node("image", box(48, 88 + i * 150, 120, 120)),
        node("text", box(180, 88 + i * 150, 400, 40), { textLength: 40 }),
        node("text", box(600, 88 + i * 150, 100, 32), { textLength: 7, price: true }),
        node("select", box(720, 88 + i * 150, 90, 36)),
        node("button", box(830, 88 + i * 150, 90, 32)),
      ],
    }),
  );
  return {
    surface: "s09",
    shape: "a basket with three lines",
    kind: "commerce",
    tree: root([
      toolbar([node("textbox", box(900, 10, 280, 36))]),
      node("list", box(0, 56, W, 500), { children: lines }),
      node("group", box(40, 600, 900, 120), {
        children: [
          node("text", box(600, 610, 120, 32), { textLength: 12 }),
          node("text", box(740, 610, 120, 32), { textLength: 8, price: true }),
          node("button", box(740, 660, 200, 48)),
        ],
      }),
    ]),
    candidates: [
      searchField,
      ...repeat(3, (i) => cand(`remove-${i}`, "Remove")),
      ...repeat(3, (i) => cand(`qty-${i}`, "Quantity", { kind: "field" })),
      cand("checkout", "Proceed to checkout", { locked: true, nearbyPrice: true }),
      cand("continue", "Continue shopping", { kind: "link" }),
    ],
    state: { cartCount: 3 },
    correct: "checkout",
    correctRole: "checkout",
  };
}

/** A queue of tracks beside a playing audio node: the same media shape without a picture. */
export function musicPlayer(): SurfaceFixture {
  const queue = node("list", box(0, 56, 400, 744), {
    children: repeat(8, (i) =>
      node("row", box(0, 56 + i * 80, 400, 76), { repeatKey: "track", children: [node("text", box(8, 62 + i * 80, 380, 60), { textLength: 30 })] }),
    ),
  });
  const player = node("region", box(408, 56, 784, 744), {
    children: [
      node("media", box(408, 56, 784, 300), { playing: true }),
      node("media-controls", box(408, 366, 784, 60), {
        children: [
          node("button", box(500, 376, 44, 44)),
          node("button", box(560, 376, 56, 44)),
          node("button", box(630, 376, 48, 44)),
          node("button", box(690, 376, 52, 44)),
        ],
      }),
      node("heading", box(420, 440, 600, 36), { textLength: 34 }),
      node("text", box(420, 486, 600, 40), { textLength: 80 }),
    ],
  });
  return {
    surface: "s10",
    shape: "a music player with a queue",
    kind: "media",
    tree: root([node("group", box(0, 56, W, 744), { children: [queue, player] })]),
    candidates: [
      cand("pause", "Pause", { insideMediaControls: true }),
      cand("next", "Next track", { insideMediaControls: true }),
      cand("previous", "Previous track", { insideMediaControls: true }),
      cand("shuffle", "Shuffle", { insideMediaControls: true }),
      ...listItems(8, "track-list"),
      searchField,
    ],
    mainListSignature: "track-list",
    state: { mediaPlaying: true },
    previousAction: "play",
    correct: "next",
    correctRole: "next",
  };
}

/** Sixty-four small equal squares: a board. */
export function gameBoard(): SurfaceFixture {
  const squares = repeat(64, (i) =>
    node("cell", box(80 + (i % 8) * 80, 80 + Math.floor(i / 8) * 80, 80, 80), { repeatKey: "square" }),
  );
  const moves = node("list", box(760, 80, 300, 640), {
    children: [
      node("heading", box(768, 84, 280, 28), { textLength: 10 }),
      ...repeat(12, (i) => node("row", box(768, 120 + i * 40, 280, 36), { repeatKey: "move", children: [node("text", box(772, 124 + i * 40, 270, 28), { textLength: 12 })] })),
    ],
  });
  return {
    surface: "s11",
    shape: "a board of small equal squares",
    kind: "board",
    tree: root([node("group", box(0, 56, W, 744), { children: [node("group", box(80, 80, 640, 640), { children: squares }), moves] })]),
    candidates: [
      ...repeat(8, (i) => cand(`cell-${i}`, "", { cell: true })),
      cand("draw", "Offer a draw"),
      cand("flip", "Flip the board"),
      cand("resign", "Resign", { locked: true }),
    ],
    correct: "cell-0",
    correctRole: "cell",
  };
}

/** A column of labelled rows, each with one switch: the settings shape, in a browser or in a window. */
export function settingsPane(): SurfaceFixture {
  const categories = node("list", box(0, 56, 260, 744), {
    children: repeat(6, (i) => node("row", box(0, 60 + i * 44, 260, 40), { repeatKey: "cat", children: [node("text", box(8, 64 + i * 44, 240, 32), { textLength: 14 })] })),
  });
  const rows = node("list", box(268, 56, 932, 744), {
    children: repeat(8, (i) =>
      node("group", box(280, 70 + i * 72, 900, 64), {
        repeatKey: "setting",
        children: [node("text", box(288, 78 + i * 72, 700, 48), { textLength: 26 }), node("switch", box(1100, 84 + i * 72, 48, 28))],
      }),
    ),
  });
  return {
    surface: "s12",
    shape: "a pane of labelled switches",
    kind: "settings",
    tree: root([node("group", box(0, 56, W, 744), { children: [categories, rows] })]),
    candidates: [
      cand("search", "", { kind: "field", inputType: "search", placeholder: "Search" }),
      ...repeat(8, (i) => cand(`toggle-${i}`, `Option ${i + 1}`, { kind: "field", toggle: true })),
      ...repeat(6, (i) => cand(`cat-${i}`, `Group ${i + 1}`, { kind: "link", list: { listSignature: "cat", index: i } })),
    ],
    mainListSignature: "cat",
    correct: "search",
    correctRole: "search",
  };
}

/** One editable region that owns the window, with a rail of documents beside it. */
export function noteEditor(): SurfaceFixture {
  const rail = node("list", box(0, 56, 280, 744), {
    children: repeat(8, (i) => node("row", box(0, 60 + i * 76, 280, 72), { repeatKey: "note", children: [node("text", box(8, 64 + i * 76, 264, 64), { textLength: 30 })] })),
  });
  const pane = node("region", box(288, 56, 912, 744), {
    children: [
      node("toolbar", box(288, 56, 912, 40), {
        children: [node("button", box(300, 62, 70, 28)), node("button", box(380, 62, 84, 28)), node("button", box(474, 62, 96, 28))],
      }),
      node("textarea", box(300, 104, 880, 680), { editable: true, textLength: 900 }),
    ],
  });
  return {
    surface: "s13",
    shape: "a document being written",
    kind: "editor",
    tree: root([node("group", box(0, 56, W, 744), { children: [rail, pane] })]),
    candidates: [
      cand("body", "", { kind: "field" }),
      cand("save", "Save"),
      cand("share", "Share"),
      cand("more", "More actions"),
      ...listItems(8, "note-list"),
    ],
    mainListSignature: "note-list",
    correct: "save",
    correctRole: "save",
  };
}

/** Sources on the left, compact rows of things on the right: a browser of files. */
export function fileBrowser(): SurfaceFixture {
  const sources = node("list", box(0, 56, 240, 744), {
    children: repeat(6, (i) => node("row", box(0, 60 + i * 44, 240, 40), { repeatKey: "src", children: [node("text", box(8, 64 + i * 44, 220, 32), { textLength: 18 })] })),
  });
  const files = node("table", box(248, 56, 952, 744), {
    children: repeat(12, (i) =>
      node("row", box(250, 60 + i * 38, 940, 34), { repeatKey: "file", children: [node("text", box(258, 62 + i * 38, 900, 30), { textLength: 24 })] }),
    ),
  });
  return {
    surface: "s14",
    shape: "a browser of files",
    kind: "list",
    tree: root([node("group", box(0, 56, W, 744), { children: [sources, files] })]),
    candidates: [searchField, ...listItems(12, "file-list"), cand("newfolder", "New folder"), cand("share", "Share")],
    mainListSignature: "file-list",
    correct: "item-0",
    correctRole: "primary-item",
  };
}

/** A column of labelled fields and one button: the oldest shape Shabang knew, now just one kind among ten. */
export function signupForm(): SurfaceFixture {
  const fields = repeat(7, (i) =>
    node("group", box(200, 80 + i * 76, 400, 64), {
      repeatKey: "field",
      children: [node("text", box(200, 80 + i * 76, 400, 20), { textLength: 18 }), node("textbox", box(200, 104 + i * 76, 400, 40))],
    }),
  );
  return {
    surface: "s15",
    shape: "a form of labelled fields",
    kind: "form",
    tree: root([
      node("region", box(0, 56, W, 744), {
        children: [
          ...fields,
          node("group", box(200, 620, 400, 40), { children: [node("text", box(230, 620, 360, 36), { textLength: 40 }), node("switch", box(200, 626, 24, 24))] }),
          node("select", box(200, 676, 400, 40)),
          node("button", box(200, 730, 160, 44)),
        ],
      }),
    ]),
    candidates: [
      ...repeat(6, (i) => cand(`field-${i}`, ["Full name", "Email", "Phone", "Street address", "City", "Postal code"][i] ?? "Detail", { kind: "field" })),
      cand("country", "Country", { kind: "field" }),
      cand("agree", "I agree to the terms", { kind: "field", toggle: true }),
      cand("submit", "Submit", { locked: true }),
    ],
    correct: "field-0",
    correctRole: "field",
  };
}

/** A window Shabang cannot read: two nameless controls and nothing else. It still has to propose something. */
export function unreadableWindow(): SurfaceFixture {
  return {
    surface: "s16",
    shape: "a window with two nameless controls",
    kind: "unknown",
    tree: root([node("group", box(40, 80, 300, 120), { children: [node("button", box(48, 88, 90, 36)), node("button", box(150, 88, 120, 44))] })]),
    candidates: [cand("btn-a", ""), cand("btn-b", "")],
    correct: "btn-a",
    correctRole: "unknown",
  };
}

/** The fourteen shapes of docs/knowledge.md section 6, plus a form and a window nothing can read. */
export const SURFACES: readonly (() => SurfaceFixture)[] = [
  photoFeed,
  professionalFeed,
  messageList,
  messageThread,
  videoWall,
  videoPlayer,
  encyclopediaArticle,
  productScreen,
  basketScreen,
  musicPlayer,
  gameBoard,
  settingsPane,
  noteEditor,
  fileBrowser,
  signupForm,
  unreadableWindow,
];

export function allSurfaces(): SurfaceFixture[] {
  return SURFACES.map((make) => make());
}

export { ROOT_AREA };
