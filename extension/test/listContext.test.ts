import { beforeEach, describe, expect, it } from "vitest";
import {
  cellOf, findList, handledIndexes, itemKeyOf, listContextOf, listItems, listRefOf, listSignatureOf, locateListItem,
  locateSemanticItem, pageLists, visibleText,
} from "../src/content/listContext";
import { el, inboxHtml, INVOICES, invoiceHtml, mount, sheetHtml } from "./fixtures/demoPages";

const INBOX_SIGNATURE = "list|ul|list|invoice-list||invoice emails|";

beforeEach(() => mount(""));

describe("grid cells", () => {
  it("reads row, column and column header for every sheet input", () => {
    mount(sheetHtml(), "/sheet");
    expect(listContextOf(el("#cell-0-0"))).toEqual({ cell: { row: 0, col: 0, colHeader: "Vendor" } });
    expect(cellOf(el("#cell-1-1"))).toEqual({ row: 1, col: 1, colHeader: "Invoice #" });
    expect(cellOf(el("#cell-2-2"))).toEqual({ row: 2, col: 2, colHeader: "Date" });
    expect(cellOf(el("#cell-5-3"))).toEqual({ row: 5, col: 3, colHeader: "Total" });
  });

  it("never reports a list for a cell, so the row index cannot pass for an iterator", () => {
    mount(sheetHtml(), "/sheet");
    expect(listContextOf(el("#cell-3-0")).list).toBeUndefined();
  });

  it("falls back to th[scope=col] when the input carries no data attributes", () => {
    mount(`<table><thead><tr><th scope="col">#</th><th scope="col">Vendor</th><th scope="col">Total</th></tr></thead>
      <tbody><tr><th scope="row">1</th><td><input id="a"></td><td><input id="b"></td></tr>
      <tr><th scope="row">2</th><td><input id="c"></td><td><input id="d"></td></tr></tbody></table>`);
    expect(cellOf(el("#a"))).toEqual({ row: 0, col: 0, colHeader: "Vendor" });
    expect(cellOf(el("#d"))).toEqual({ row: 1, col: 1, colHeader: "Total" });
  });

  it("falls back to the aria-label prefix when there is no header at all", () => {
    mount(`<div><input id="x" data-row="4" data-col="2" aria-label="Date row 5"></div>`);
    expect(cellOf(el("#x"))).toEqual({ row: 4, col: 2, colHeader: "Date" });
  });

  it("reads role=gridcell grids with column headers", () => {
    mount(`<div role="grid" aria-label="Ledger">
      <div role="row"><span role="columnheader">Vendor</span><span role="columnheader">Total</span></div>
      <div role="row"><span role="gridcell"><input id="g1"></span><span role="gridcell"><input id="g2"></span></div>
      <div role="row"><span role="gridcell"><input id="g3"></span><span role="gridcell"><button id="g4">Edit</button></span></div></div>`);
    expect(cellOf(el("#g2"))).toEqual({ row: 0, col: 1, colHeader: "Total" });
    expect(cellOf(el("#g4"))).toEqual({ row: 1, col: 1, colHeader: "Total" });
  });

  it("drops a column header that reads as sensitive", () => {
    mount(`<table><thead><tr><th scope="col">Card number</th></tr></thead><tbody><tr><td><input id="s"></td></tr></tbody></table>`);
    expect(cellOf(el("#s"))?.colHeader).toBe("");
  });

  it("is null outside any grid", () => {
    mount(`<form><input id="plain"></form>`);
    expect(cellOf(el("#plain"))).toBeNull();
    expect(listContextOf(el("#plain"))).toEqual({});
  });
});

describe("repeated lists", () => {
  it("finds the inbox row of a link: stable signature, index and the subject as item key", () => {
    mount(inboxHtml(), "/invoices");
    const third = el('[data-invoice-id="INV-1003"] a');
    expect(listContextOf(third)).toEqual({
      list: { listSignature: INBOX_SIGNATURE, index: 2, itemKey: "Invoice INV-1003 from Harbourlight Freight" },
    });
    expect(listRefOf(el('[data-invoice-id="INV-1001"] a'))?.index).toBe(0);
  });

  it("keeps the signature free of values: handled rows and other invoices do not change it", () => {
    mount(inboxHtml(), "/invoices");
    const before = listRefOf(el('[data-invoice-id="INV-1002"] a'))?.listSignature;
    mount(inboxHtml(INVOICES.map((inv, i) => ({ ...inv, id: `INV-20${i}9`, vendor: `Other ${i}`, replied: i < 2, logged: i < 3 }))), "/invoices");
    expect(listRefOf(el('[data-testid="invoice-row"]:nth-child(2) a'))?.listSignature).toBe(before);
    expect(before).not.toMatch(/INV|\d/);
  });

  it("strips counts from a list label", () => {
    mount(`<ul aria-label="Inbox (12 unread)"><li><a href="/m/1">One</a></li><li><a href="/m/2">Two</a></li></ul>`);
    const signature = listSignatureOf(el("ul"));
    mount(`<ul aria-label="Inbox (3 unread)"><li><a href="/m/1">One</a></li><li><a href="/m/2">Two</a></li></ul>`);
    expect(listSignatureOf(el("ul"))).toBe(signature);
  });

  it("does not treat header navigation or toolbars as lists", () => {
    mount(inboxHtml(), "/invoices");
    expect(listContextOf(el('nav a[href="/sheet"]'))).toEqual({});
    mount(sheetHtml(), "/sheet");
    expect(listContextOf(el('[data-testid="clear-sheet"]'))).toEqual({});
  });

  it("treats table body rows as a list for buttons inside them", () => {
    mount(`<table data-testid="orders"><tbody>
      <tr><th scope="row">A-1</th><td><button id="b0">Approve</button></td></tr>
      <tr><th scope="row">A-2</th><td><button id="b1">Approve</button></td></tr>
      <tr><th scope="row">A-3</th><td><button id="b2">Approve</button></td></tr></tbody></table>`);
    expect(listContextOf(el("#b1"))).toEqual({ list: { listSignature: "list|tbody||orders|||", index: 1, itemKey: "A-2" } });
    mount(`<ul><li><button id="k0">Archive</button></li><li><button>Archive</button></li></ul>`);
    expect(listRefOf(el("#k0"))?.itemKey).toBe("Archive");
  });

  it("finds look-alike siblings without list markup, but not a button group", () => {
    mount(`<main><div class="cards">
      ${[1, 2, 3].map((n) => `<div class="card is-${n}"><h3>Card ${n}</h3><p>Body</p><a href="/c/${n}" id="c${n}">Open</a></div>`).join("")}
      </div><div class="actions"><button class="btn" id="save">Save</button><button class="btn">Cancel</button><button class="btn">Delete</button></div></main>`);
    const found = locateListItem(el("#c2"));
    expect(found?.index).toBe(1);
    expect(found?.items).toHaveLength(3);
    expect(itemKeyOf(found?.item as Element)).toBe("Card 2");
    expect(locateSemanticItem(el("#c2"))).toBeNull();
    expect(locateListItem(el("#save"))).toBeNull();
  });

  it("needs two real list items or three look-alikes", () => {
    mount(`<ul><li><a id="only" href="/x">Only</a></li></ul><div><div class="row"><b>1</b><a id="r1" href="/1">a</a></div><div class="row"><b>2</b><a href="/2">b</a></div></div>`);
    expect(locateListItem(el("#only"))).toBeNull();
    expect(locateListItem(el("#r1"))).toBeNull();
  });

  it("handles role=listitem elements that are not direct children of their list", () => {
    mount(`<div role="list" aria-label="Tasks"><div class="group"><div role="listitem"><a id="t0" href="/t/0">Alpha</a></div>
      <div role="listitem"><a id="t1" href="/t/1">Beta</a></div></div></div>`);
    expect(listRefOf(el("#t1"))).toEqual({ listSignature: "list|div|list|||tasks|", index: 1, itemKey: "Beta" });
  });

  it("uses a structural path when the container has no name", () => {
    mount(`<main id="app"><section><ul><li><a id="p0" href="/p/0">Zero</a></li><li><a href="/p/1">One</a></li></ul></section></main>`);
    expect(listRefOf(el("#p0"))?.listSignature).toBe("list|ul|||||main#app>section:1>ul:1");
  });

  it("drops an item key that reads as sensitive and never includes typed values", () => {
    mount(`<ul><li id="a">Your one-time code is ready</li><li id="b">Note <input value="typed secret"> here</li></ul>`);
    expect(itemKeyOf(el("#a"))).toBe("");
    expect(itemKeyOf(el("#b"))).toBe("Note here");
    expect(visibleText(el("#b"))).not.toContain("typed secret");
  });
});

describe("resolving lists again", () => {
  it("finds the container and its items from the signature", () => {
    mount(inboxHtml(), "/invoices");
    expect(findList(document, INBOX_SIGNATURE)).toBe(el('[data-testid="invoice-list"]'));
    const items = listItems(document, INBOX_SIGNATURE);
    expect(items).toHaveLength(INVOICES.length);
    expect(items[3]?.getAttribute("data-invoice-id")).toBe("INV-1004");
    expect(findList(document, "list|ul|list|other||nope|")).toBeNull();
  });

  it("finds a look-alike sibling list by its structural signature", () => {
    mount(`<main id="app"><div class="cards">${[1, 2, 3].map((n) => `<div class="card"><h3>Card ${n}</h3><a href="/c/${n}" id="c${n}">Open</a></div>`).join("")}</div></main>`);
    const signature = listRefOf(el("#c1"))?.listSignature ?? "";
    expect(listItems(document, signature)).toHaveLength(3);
  });

  it("is empty on a page that does not show the list", () => {
    mount(invoiceHtml(), "/invoices/INV-1001");
    expect(listItems(document, INBOX_SIGNATURE)).toEqual([]);
  });
});

describe("page lists and handled markers", () => {
  it("reports the inbox, not the header navigation", () => {
    mount(inboxHtml(), "/invoices");
    const lists = pageLists(document);
    expect(lists.map((l) => [l.listSignature, l.items.length])).toEqual([[INBOX_SIGNATURE, 5]]);
  });

  it("reads handled markers from state classes and data attributes", () => {
    mount(inboxHtml(INVOICES.map((inv, i) => ({ ...inv, replied: i === 0, logged: i === 0 || i === 3 }))), "/invoices");
    expect(handledIndexes(listItems(document, INBOX_SIGNATURE))).toEqual([0, 3]);
    mount(`<ul><li class="todo done">a</li><li class="todo">b</li><li data-archived="true">c</li><li data-done="false">d</li></ul>`);
    expect(handledIndexes(Array.from(document.querySelectorAll("li")))).toEqual([0, 2]);
  });

  it("always includes a container the user acted in", () => {
    mount(`<main id="app"><div class="cards">${[1, 2, 3].map((n) => `<div class="card"><h3>Card ${n}</h3><a href="/c/${n}">Open</a></div>`).join("")}</div>
      ${[1, 2, 3, 4, 5, 6].map((n) => `<ul data-testid="l${n}"><li>a</li><li>b</li><li>c</li><li>d</li></ul>`).join("")}</main>`);
    const cards = el(".cards");
    expect(pageLists(document).some((l) => l.container === cards)).toBe(false);
    const lists = pageLists(document, [cards]);
    expect(lists).toHaveLength(5);
    expect(lists[0]?.container).toBe(cards);
  });
});
