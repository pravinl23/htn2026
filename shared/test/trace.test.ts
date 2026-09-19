import { describe, expect, it } from "vitest";
import { filterNoise, isNoopEvent, isVolatileSegment, normalizeUrl, pathPatternOf, shapeKey, shapeKeys, targetShape } from "../src";
import { INBOX_LIST, TraceBuilder, makeTarget } from "./helpers/traceBuilder";

describe("pathPatternOf", () => {
  it("reads percent escapes as text, so %20 is not an id but an encoded id still is", () => {
    expect(pathPatternOf("/my%20documents")).toBe("/my%20documents");
    expect(pathPatternOf("/invoices/INV%2D1042")).toBe("/invoices/:id");
    expect(pathPatternOf("/files/100%")).toBe("/files/:id");
    expect(pathPatternOf("/files/bad%ZZname%20")).toBe("/files/bad%ZZname%20");
  });

  it("generalizes numeric segments, uuids and ids containing digits", () => {
    expect(pathPatternOf("/invoices/INV-1042")).toBe("/invoices/:id");
    expect(pathPatternOf("/users/42/orders/7")).toBe("/users/:id/orders/:id");
    expect(pathPatternOf("/docs/3f2b8c1e-9a4d-4e2f-8b1a-0c9d8e7f6a5b/edit")).toBe("/docs/:id/edit");
    expect(pathPatternOf("/blob/deadbeefdeadbeefcafe")).toBe("/blob/:id");
  });

  it("keeps stable segments, api versions and the root", () => {
    expect(pathPatternOf("/sheet")).toBe("/sheet");
    expect(pathPatternOf("/api/v1/users")).toBe("/api/v1/users");
    expect(pathPatternOf("/")).toBe("/");
    expect(pathPatternOf("")).toBe("/");
    expect(pathPatternOf("/mail/")).toBe("/mail");
    expect(isVolatileSegment("invoices")).toBe(false);
  });

  it("never lets a query string or fragment leak into the pattern", () => {
    expect(pathPatternOf("/invoices/INV-1042?token=abc#top")).toBe("/invoices/:id");
  });
});

describe("normalizeUrl", () => {
  it("keeps origin + pathname only", () => {
    expect(normalizeUrl("http://localhost:5173/invoices/INV-1042?reset=1#reply")).toEqual({
      origin: "http://localhost:5173",
      pathname: "/invoices/INV-1042",
      pathPattern: "/invoices/:id",
      url: "http://localhost:5173/invoices/INV-1042",
    });
  });

  it("drops credentials, lowercases the origin and defaults the path", () => {
    expect(normalizeUrl("HTTPS://alex:hunter2@Example.COM")?.url).toBe("https://example.com/");
    expect(normalizeUrl("https://example.com?x=1")?.url).toBe("https://example.com/");
  });

  it("returns null for urls without an authority", () => {
    expect(normalizeUrl("about:blank")).toBeNull();
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("shapeKey", () => {
  it("uses label#kind for ordinary targets and never the value", () => {
    const [a, b] = new TraceBuilder().at("/mail/7").input("Reply", "first").input("Reply", "second").events();
    expect(shapeKey(a!)).toBe("input|/mail/:id|Reply#text");
    expect(shapeKey(a!)).toBe(shapeKey(b!));
  });

  it("removes the index from list items and the row from grid cells", () => {
    const events = new TraceBuilder()
      .at("/invoices").clickItem(INBOX_LIST, 0, "INV-1001").clickItem(INBOX_LIST, 5, "INV-1006")
      .at("/sheet").fillCell(0, 3, "Total", "1").fillCell(9, 3, "Total", "2")
      .events();
    expect(shapeKeys(events)).toEqual([
      "click|/invoices|LIST(ul#inbox)", "click|/invoices|LIST(ul#inbox)",
      "input|/sheet|CELL(Total)", "input|/sheet|CELL(Total)",
    ]);
  });

  it("prefers the cell shape when a target is both a cell and a list item, and handles missing targets", () => {
    const target = makeTarget("x", "text", { cell: { row: 1, col: 2, colHeader: "Date" }, list: { listSignature: "table", index: 1, itemKey: "r" } });
    expect(targetShape(target)).toBe("CELL(Date)");
    expect(shapeKey(new TraceBuilder().navigate("/sheet").events()[0]!)).toBe("navigate|/sheet|");
  });
});

describe("filterNoise", () => {
  it("drops focus-only clicks on the page body", () => {
    const events = new TraceBuilder().at("/sheet").clickBody().click("", { kind: "other" }).click("Save").events();
    expect(events.map(isNoopEvent)).toEqual([true, true, false]);
    expect(filterNoise(events).map((e) => e.target?.label)).toEqual(["Save"]);
  });

  it("collapses consecutive duplicate keys and keeps the final value", () => {
    const events = new TraceBuilder().at("/sheet").fillCell(0, 0, "Vendor", "Nortwind").fillCell(0, 0, "Vendor", "Northwind").click("Save").events();
    const clean = filterNoise(events);
    expect(clean).toHaveLength(2);
    expect(clean[0]?.value).toBe("Northwind");
  });

  it("drops repeated clicks on the same target within 500 ms but keeps slower ones apart from duplicates", () => {
    const tb = new TraceBuilder({ stepMs: 100 }).at("/mail");
    const events = tb.click("Archive").click("Archive").click("Next").wait(1000).click("Archive").events();
    expect(filterNoise(events).map((e) => e.target?.label)).toEqual(["Archive", "Next", "Archive"]);
    expect(filterNoise(events)[0]?.t).toBe(events[0]?.t);
  });
});
