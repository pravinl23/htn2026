import { afterEach, describe, expect, it, vi } from "vitest";
import type { CapturedField } from "@ghost/shared";
import {
  accessibleName,
  captureFields,
  computeSignature,
  findElement,
  isElementLocked,
  isElementSensitive,
  setVisibilityProbe,
} from "../src/content/capture";
import applyHtml from "./fixtures/apply.html?raw";
import sensitiveHtml from "./fixtures/sensitive.html?raw";

function mount(html: string): void {
  document.body.innerHTML = html;
}

function loadDocument(html: string): void {
  document.documentElement.innerHTML = html;
}

function el<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

function labels(fields: CapturedField[]): string[] {
  return fields.map((f) => f.label);
}

function byLabel(fields: CapturedField[], label: string): CapturedField {
  const found = fields.find((f) => f.label === label);
  if (!found) throw new Error(`no field labelled "${label}" in ${JSON.stringify(labels(fields))}`);
  return found;
}

function fakeRect(width: number, height: number, left = 10): DOMRect {
  return { x: left, y: 20, left, top: 20, right: left + width, bottom: 20 + height, width, height, toJSON: () => ({}) };
}

afterEach(() => {
  setVisibilityProbe(null);
  vi.restoreAllMocks();
  loadDocument("<head></head><body></body>");
});

describe("accessibleName precedence", () => {
  it("prefers aria-labelledby (all ids, in order) over everything else", () => {
    mount(`
      <span id="a">Billing</span><span id="b">postal code</span>
      <label for="x">Label for</label>
      <input id="x" aria-labelledby="a b" aria-label="Aria label" placeholder="Placeholder" title="Title">`);
    expect(accessibleName(el("#x"))).toBe("Billing postal code");
  });

  it("prefers aria-label over label[for]", () => {
    mount(`<label for="x">Label for</label><input id="x" aria-label="Aria label" placeholder="Placeholder">`);
    expect(accessibleName(el("#x"))).toBe("Aria label");
  });

  it("prefers label[for] over a wrapping label", () => {
    mount(`<label>Wrapping <input id="x" placeholder="Placeholder"></label><label for="x">Explicit</label>`);
    expect(accessibleName(el("#x"))).toBe("Explicit");
  });

  it("uses a wrapping label without swallowing the control's own text", () => {
    mount(`<label>Country <select name="c"><option>Canada</option><option>Mexico</option></select></label>`);
    expect(accessibleName(el("select"))).toBe("Country");
  });

  it("prefers a wrapping label over placeholder", () => {
    mount(`<label>Wrapping <input id="x" placeholder="Placeholder" title="Title"></label>`);
    expect(accessibleName(el("#x"))).toBe("Wrapping");
  });

  it("names a radio by its group legend, not by the option label that wraps it", () => {
    mount(`
      <fieldset><legend>Need sponsorship?</legend>
        <label><input type="radio" name="s" value="y"> Yes</label>
        <label><input type="radio" name="s" value="n"> No</label>
      </fieldset>`);
    expect(accessibleName(el('input[value="y"]'))).toBe("Need sponsorship?");
    expect(accessibleName(el('input[value="n"]'))).toBe("Need sponsorship?");
  });

  it("prefers placeholder over title", () => {
    mount(`<p>Nearby</p><input id="x" placeholder="Placeholder" title="Title">`);
    expect(accessibleName(el("#x"))).toBe("Placeholder");
  });

  it("prefers title over nearby text", () => {
    mount(`<p>Nearby</p><input id="x" title="Title">`);
    expect(accessibleName(el("#x"))).toBe("Title");
  });

  it("falls back to the nearest preceding text node", () => {
    mount(`<div>Favourite robot <input id="x"></div>`);
    expect(accessibleName(el("#x"))).toBe("Favourite robot");
  });

  it("finds preceding text in a table-style layout", () => {
    mount(`<table><tr><td>School</td><td><input id="x"></td></tr></table>`);
    expect(accessibleName(el("#x"))).toBe("School");
  });

  it("does not borrow text that belongs to a previous control", () => {
    mount(`<div><span>First</span><input id="a"><input id="b"></div>`);
    expect(accessibleName(el("#a"))).toBe("First");
    expect(accessibleName(el("#b"))).toBe("");
  });

  it("strips required markers", () => {
    mount(`
      <label for="a">First name *</label><input id="a">
      <label for="b">Email (required)</label><input id="b">
      <label for="c">Phone <span aria-hidden="true">*</span>:</label><input id="c">
      <label for="d">* City</label><input id="d">`);
    expect(["#a", "#b", "#c", "#d"].map((s) => accessibleName(el(s)))).toEqual(["First name", "Email", "Phone", "City"]);
  });

  it("names buttons and links by their content", () => {
    mount(`
      <button id="a">Save <b>draft</b></button>
      <input id="b" type="submit" value="Send it">
      <input id="c" type="submit">
      <button id="d" aria-label="Close dialog"><svg><title>x</title></svg></button>
      <a id="e" href="/jobs"><img alt="All jobs"></a>
      <input id="f" type="image" alt="Search">`);
    const names = ["#a", "#b", "#c", "#d", "#e", "#f"].map((s) => accessibleName(el(s)));
    expect(names).toEqual(["Save draft", "Send it", "Submit", "Close dialog", "All jobs", "Search"]);
  });
});

describe("radio groups", () => {
  const markup = `
    <form id="f1">
      <fieldset><legend>Require sponsorship? *</legend>
        <label><input type="radio" name="sponsor" value="yes"> Yes</label>
        <input type="radio" name="sponsor" value="no" id="no"><label for="no">No</label>
        <input type="radio" name="sponsor" value="later"> Maybe later
        <input type="radio" name="sponsor" value="na" aria-label="Not applicable">
      </fieldset>
    </form>`;

  it("captures the group as one field with every option", () => {
    mount(markup);
    const fields = captureFields();
    expect(fields).toHaveLength(1);
    const field = fields[0]!;
    expect(field).toMatchObject({ kind: "radio", label: "Require sponsorship?", name: "sponsor", required: true, value: "" });
    expect(field.options).toEqual([
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
      { value: "later", label: "Maybe later" },
      { value: "na", label: "Not applicable" },
    ]);
    expect(field.context).toBeUndefined();
  });

  it("reports the checked radio's value", () => {
    mount(markup);
    el<HTMLInputElement>("#no").checked = true;
    expect(captureFields()[0]?.value).toBe("no");
  });

  it("resolves the group signature to its first radio", () => {
    mount(markup);
    const field = captureFields()[0]!;
    expect(findElement(field.signature)).toBe(el('input[value="yes"]'));
    expect(computeSignature(el("#no"))).toBe(field.signature);
  });

  it("drops disabled radios from the options and anchors on the first usable one", () => {
    mount(markup);
    el<HTMLInputElement>('input[value="yes"]').disabled = true;
    const field = captureFields()[0]!;
    expect(field.options?.map((o) => o.value)).toEqual(["no", "later", "na"]);
    expect(findElement(field.signature)).toBe(el("#no"));
  });

  it("keeps same-named groups in different forms apart", () => {
    mount(`
      <form><p>Shirt size</p><label><input type="radio" name="size" value="s"> S</label><label><input type="radio" name="size" value="m"> M</label></form>
      <form><p>Hat size</p><label><input type="radio" name="size" value="s"> S</label><label><input type="radio" name="size" value="m"> M</label></form>`);
    const fields = captureFields();
    expect(labels(fields)).toEqual(["Shirt size", "Hat size"]);
    expect(new Set(fields.map((f) => f.signature)).size).toBe(2);
  });

  it("names a role=radiogroup by its aria-labelledby", () => {
    mount(`
      <span id="q">Preferred contact method</span>
      <div role="radiogroup" aria-labelledby="q">
        <label><input type="radio" name="contact" value="email"> Email</label>
        <label><input type="radio" name="contact" value="phone"> Phone</label>
      </div>`);
    expect(captureFields()[0]).toMatchObject({ label: "Preferred contact method", kind: "radio" });
  });

  it("does not mistake a preceding option label for the question", () => {
    mount(`<div><label for="r1">Yes</label><input id="r1" type="radio" name="q" value="y"></div>`);
    expect(captureFields()[0]?.label).toBe("");
  });
});

describe("selects, checkboxes and kinds", () => {
  it("captures select options with labels and the current value", () => {
    mount(`
      <label for="auth">Work authorization</label>
      <select id="auth" name="auth">
        <option value="">Select one</option>
        <option value="citizen">Citizen or permanent resident</option>
        <option value="permit" selected>Work permit</option>
        <option value="old" disabled>Legacy option</option>
        <option label="Short label" value="other">Long text</option>
      </select>`);
    const field = captureFields()[0]!;
    expect(field).toMatchObject({ kind: "select", label: "Work authorization", value: "permit" });
    expect(field.options).toEqual([
      { value: "", label: "Select one" },
      { value: "citizen", label: "Citizen or permanent resident" },
      { value: "permit", label: "Work permit" },
      { value: "other", label: "Short label" },
    ]);
  });

  it("reports checkbox state as a string", () => {
    mount(`<label><input type="checkbox" name="a" checked> Remote ok</label><label><input type="checkbox" name="b"> Relocate</label>`);
    expect(captureFields().map((f) => [f.kind, f.label, f.value])).toEqual([
      ["checkbox", "Remote ok", "true"],
      ["checkbox", "Relocate", "false"],
    ]);
  });

  it("includes the current value of text fields and omits it for files and actions", () => {
    mount(`<input aria-label="City" value="Waterloo"><input type="file" aria-label="Resume"><button type="button">Next</button>`);
    const fields = captureFields();
    expect(byLabel(fields, "City").value).toBe("Waterloo");
    expect(byLabel(fields, "Resume")).not.toHaveProperty("value");
    expect(byLabel(fields, "Next")).not.toHaveProperty("value");
  });

  it("detects every kind from tag and type", () => {
    mount(`
      <input aria-label="text" type="text"><input aria-label="implicit">
      <input aria-label="search" type="search"><input aria-label="email" type="email">
      <input aria-label="tel" type="tel"><input aria-label="url" type="url">
      <input aria-label="number" type="number"><input aria-label="date" type="date">
      <input aria-label="month" type="month"><textarea aria-label="textarea"></textarea>
      <select aria-label="select"><option>a</option></select>
      <input aria-label="radio" type="radio" name="r"><input aria-label="checkbox" type="checkbox">
      <input aria-label="file" type="file"><button type="button">button</button>
      <input type="button" value="input button"><div role="button" tabindex="0">div button</div>
      <a href="/x">link</a><a>no href</a><input aria-label="range" type="range">`);
    expect(captureFields().map((f) => f.kind)).toEqual([
      "text", "text", "text", "email", "tel", "url", "number", "date", "month", "textarea",
      "select", "radio", "checkbox", "file", "button", "button", "button", "link", "other",
    ]);
  });

  it("captures custom dropdown openers and their visible options", () => {
    mount(`
      <div role="combobox" aria-label="Owner" aria-haspopup="listbox" aria-expanded="false" tabindex="0"></div>
      <div role="listbox"><div role="option" aria-label="Owned by me" tabindex="0"></div></div>
      <div aria-label="Sort documents" aria-haspopup="menu" tabindex="0"></div>
    `);
    expect(captureFields().map((field) => [field.kind, field.label])).toEqual([
      ["button", "Owner"],
      ["button", "Owned by me"],
      ["button", "Sort documents"],
    ]);
  });

  it("copies the descriptive attributes and leaves absent ones out", () => {
    mount(`<label for="e">Email</label><input id="e" name="mail" type="email" autocomplete="email" placeholder="you@example.com" required>`);
    const field = captureFields()[0]!;
    expect(field).toMatchObject({ id: "e", name: "mail", inputType: "email", autocomplete: "email", placeholder: "you@example.com", required: true });
    expect(field.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(field).not.toHaveProperty("options");
    expect(field).not.toHaveProperty("locked");
  });
});

describe("context", () => {
  it("uses the fieldset legend, then the nearest section heading", () => {
    mount(`
      <section><h2>Education</h2>
        <div><label for="s">School</label><input id="s"></div>
        <fieldset><legend>Address</legend><input placeholder="Street"></fieldset>
      </section>
      <section><div class="head"><h2>Links</h2></div><div><input placeholder="GitHub"></div></section>`);
    const fields = captureFields();
    expect(fields.map((f) => [f.label, f.context])).toEqual([["School", "Education"], ["Street", "Address"], ["GitHub", "Links"]]);
  });

  it("does not take the heading of a previous section", () => {
    mount(`<section><h2>Personal</h2><input placeholder="Name"></section><section><input placeholder="Other"></section>`);
    expect(byLabel(captureFields(), "Other").context).toBeUndefined();
  });
});

describe("skipping", () => {
  it("skips hidden, disabled and readonly controls", () => {
    mount(`
      <input type="hidden" name="csrf" value="t">
      <input aria-label="disabled" disabled>
      <input aria-label="aria-disabled" aria-disabled="true">
      <fieldset disabled><input aria-label="in disabled fieldset"></fieldset>
      <input aria-label="readonly" readonly value="fixed">
      <textarea aria-label="readonly textarea" readonly></textarea>
      <input aria-label="hidden attr" hidden>
      <div hidden><input aria-label="in hidden parent"></div>
      <input aria-label="display none" style="display:none">
      <div style="display:none"><span><input aria-label="in display none parent"></span></div>
      <input aria-label="visibility hidden" style="visibility:hidden">
      <div style="visibility:hidden"><input aria-label="in visibility hidden parent"></div>
      <div inert><input aria-label="inert"></div>
      <div id="ghost-overlay-host"><button>Ghost HUD</button></div>
      <input aria-label="kept">`);
    expect(labels(captureFields())).toEqual(["kept"]);
  });

  it("treats unmeasurable elements as visible when the document has no layout (jsdom)", () => {
    mount(`<input aria-label="unmeasured">`);
    expect(labels(captureFields())).toEqual(["unmeasured"]);
  });

  it("skips zero-size elements once the document has real layout", () => {
    mount(`
      <input id="a" aria-label="collapsed">
      <input id="b" aria-label="measured">
      <label id="l"><input id="c" type="checkbox"> Styled checkbox</label>`);
    vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue(fakeRect(1024, 768));
    vi.spyOn(el("#b"), "getBoundingClientRect").mockReturnValue(fakeRect(200, 32));
    vi.spyOn(el("#l"), "getBoundingClientRect").mockReturnValue(fakeRect(140, 24));
    const fields = captureFields();
    expect(labels(fields)).toEqual(["measured", "Styled checkbox"]);
    expect(byLabel(fields, "measured").rect).toEqual({ x: 10, y: 20, width: 200, height: 32 });
    // The real checkbox has no box, so the ghost should target the label that stands in for it.
    expect(byLabel(fields, "Styled checkbox").rect).toEqual({ x: 10, y: 20, width: 140, height: 24 });
  });

  it("skips honeypots parked off the edge of the page", () => {
    mount(`<input id="trap" aria-label="Website"><input id="real" aria-label="Email">`);
    vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue(fakeRect(1024, 768));
    vi.spyOn(el("#trap"), "getBoundingClientRect").mockReturnValue(fakeRect(200, 32, -9999));
    vi.spyOn(el("#real"), "getBoundingClientRect").mockReturnValue(fakeRect(200, 32));
    expect(labels(captureFields())).toEqual(["Email"]);
  });

  it("skips honeypots hidden by opacity, aria-hidden, a collapsed clipping wrapper or a flattened box", () => {
    mount(`
      <div style="opacity:0;position:absolute"><label>Website <input id="clear" name="website"></label></div>
      <div aria-hidden="true"><label>Url <input id="aria" name="url"></label></div>
      <div id="wrap" style="height:0;overflow:hidden"><label>Phone <input id="clipped" name="phone2"></label></div>
      <label>Fax <input id="flat" name="fax"></label>
      <label>Homepage <input id="trap" name="homepage" tabindex="-1" autocomplete="off"></label>
      <label><input id="custom" type="checkbox" style="opacity:0"> Styled checkbox</label>
      <label>Email <input id="real" name="email"></label>`);
    vi.spyOn(document.documentElement, "getBoundingClientRect").mockReturnValue(fakeRect(1024, 768));
    for (const id of ["clear", "aria", "clipped", "trap", "custom", "real"]) {
      vi.spyOn(el(`#${id}`), "getBoundingClientRect").mockReturnValue(fakeRect(150, 21));
    }
    vi.spyOn(el("#flat"), "getBoundingClientRect").mockReturnValue(fakeRect(150, 0));
    for (const node of document.querySelectorAll("div, label, body")) {
      const collapsed = node.id === "wrap";
      Object.defineProperty(node, "clientWidth", { configurable: true, value: 300 });
      Object.defineProperty(node, "clientHeight", { configurable: true, value: collapsed ? 0 : 40 });
    }
    expect(labels(captureFields())).toEqual(["Styled checkbox", "Email"]);
  });

  it("honours a custom visibility probe", () => {
    mount(`<input id="a" aria-label="a"><input id="b" aria-label="b">`);
    setVisibilityProbe((e) => e.id !== "a");
    expect(labels(captureFields())).toEqual(["b"]);
    setVisibilityProbe(null);
    expect(labels(captureFields())).toEqual(["a", "b"]);
  });

  it("limits capture to the given root", () => {
    mount(`<form id="one"><input aria-label="inside"></form><form id="two"><input aria-label="outside"></form>`);
    expect(labels(captureFields(el("#one")))).toEqual(["inside"]);
  });
});

describe("sensitive exclusion", () => {
  const cases: Array<[string, string]> = [
    ["password type", `<label for="p">Secret word</label><input id="p" type="password">`],
    ["password type with a harmless label", `<label for="p">Access</label><input id="p" type="password">`],
    ["cc-number autocomplete", `<label for="n">Number</label><input id="n" autocomplete="cc-number">`],
    ["cc-csc behind a section token", `<input aria-label="Code" autocomplete="section-pay cc-csc">`],
    ["SIN label", `<label for="s">SIN</label><input id="s">`],
    ["Social Insurance Number label", `<label>Social Insurance Number <input></label>`],
    ["ssn name", `<input name="applicant_ssn" aria-label="Number">`],
    ["sensitive placeholder", `<input placeholder="Passport number">`],
    ["data-ghost-sensitive ancestor", `<div data-ghost-sensitive><label>Nickname <input></label></div>`],
    ["data-sensitive on the element", `<input aria-label="Nickname" data-sensitive>`],
    ["visible label hidden behind a harmless aria-label", `<label for="x">Driver's licence number</label><input id="x" aria-label="Number">`],
    ["nearby text hidden behind a placeholder", `<p>Social Insurance Number</p><input placeholder="000-000-000">`],
    ["fieldset legend", `<fieldset><legend>Credit card</legend><label>Number <input></label></fieldset>`],
    ["one-time code", `<input aria-label="Code" autocomplete="one-time-code">`],
  ];

  it.each(cases)("never captures: %s", (_name, markup) => {
    mount(`${markup}<input aria-label="City">`);
    expect(labels(captureFields())).toEqual(["City"]);
  });

  it("keeps sensitive labels and values out of the whole payload", () => {
    mount(`
      <h3>Social Insurance Number</h3>
      <input id="sin" name="sin" value="000 000 000">
      <label for="city">City</label><input id="city">`);
    const fields = captureFields();
    expect(labels(fields)).toEqual(["City"]);
    expect(JSON.stringify(fields)).not.toMatch(/insurance|000 000 000|sin/i);
  });

  it("captures only the safe fields of a checkout page", () => {
    loadDocument(sensitiveHtml);
    const fields = captureFields();
    expect(fields.map((f) => [f.label, f.kind, f.context])).toEqual([
      ["Email", "email", "Contact"],
      ["City", "text", "Shipping"],
      ["Pay now", "button", "Checkout"],
    ]);
    expect(JSON.stringify(fields)).not.toMatch(/password|card|cvc|expiry|insurance|passport|nickname|pet name/i);
  });

  it("drops card fields that carry no autocomplete hint, value included", () => {
    mount(`
      <form>
        <label>Name on card <input name="holder"></label>
        <fieldset><legend>Card details</legend>
          <label>Number <input name="number" value="4111111111111111"></label>
          <label>Expiry <input name="exp" value="12/29"></label>
          <label>CVV2 <input name="code" value="123"></label>
        </fieldset>
        <h3>Payment</h3>
        <div><label>Name <input name="payer"></label></div>
        <h3>Shipping</h3>
        <div><label>Name <input name="shipTo"></label></div>
      </form>`);
    const fields = captureFields();
    expect(fields.map((f) => [f.label, f.name])).toEqual([["Name", "shipTo"]]);
    expect(JSON.stringify(fields)).not.toMatch(/4111|12\/29|123|card|cvv/i);
  });

  it("exposes the same verdict through isElementSensitive", () => {
    loadDocument(sensitiveHtml);
    const sensitive = ["#accountPassword", "#cardholder", "#pan", "#exp", "#cvc", "#govId", '[name="idBackup"]', "#nickname", "#petName"];
    for (const selector of sensitive) expect(isElementSensitive(el(selector)), selector).toBe(true);
    for (const selector of ["#contactEmail", "#city"]) expect(isElementSensitive(el(selector)), selector).toBe(false);
  });

  it("drops a whole radio group when it asks for something sensitive", () => {
    mount(`
      <fieldset><legend>Which government ID will you bring?</legend>
        <label><input type="radio" name="gov" value="a"> Option A</label>
        <label><input type="radio" name="gov" value="b"> Option B</label>
      </fieldset>`);
    expect(captureFields()).toEqual([]);
  });
});

describe("locked actions", () => {
  const markup = `
    <form id="f">
      <label for="confirmEmail">Confirm email</label><input id="confirmEmail" type="email">
      <button id="implicit">Continue</button>
      <button id="draft" type="button">Save draft</button>
      <button id="delete" type="button">Delete account</button>
      <input id="inputSubmit" type="submit" value="Go">
      <button id="reset" type="reset">Start over</button>
      <div id="divButton" role="button" tabindex="0">Add another position</div>
      <button id="submit" type="submit">Submit application</button>
    </form>
    <button id="next">Next</button>
    <a id="unsubscribe" href="/unsubscribe">Unsubscribe</a>
    <a id="about" href="/about">About us</a>
    <div data-ghost-lock><button id="marked" type="button">Archive</button></div>`;

  it("locks irreversible buttons and links only", () => {
    mount(markup);
    const verdicts = Object.fromEntries(
      Array.from(document.querySelectorAll<HTMLElement>("[id]"), (e) => [e.id, isElementLocked(e)]),
    );
    expect(verdicts).toMatchObject({
      confirmEmail: false, implicit: true, draft: false, delete: true, inputSubmit: true, reset: true,
      divButton: false, submit: true, next: false, unsubscribe: true, about: false, marked: true,
    });
  });

  it("sets locked on every captured action and leaves it off plain fields", () => {
    mount(markup);
    const fields = captureFields();
    expect(byLabel(fields, "Confirm email")).not.toHaveProperty("locked");
    expect(byLabel(fields, "Save draft")).toMatchObject({ kind: "button", locked: false });
    expect(byLabel(fields, "Submit application")).toMatchObject({ kind: "button", locked: true, inputType: "submit" });
    expect(byLabel(fields, "Unsubscribe")).toMatchObject({ kind: "link", locked: true });
    expect(byLabel(fields, "About us")).toMatchObject({ kind: "link", locked: false });
  });

  it("marks a field locked when an ancestor carries data-ghost-lock", () => {
    mount(`<div data-ghost-lock><input aria-label="Amount"></div>`);
    expect(captureFields()[0]).toMatchObject({ label: "Amount", locked: true });
  });
});

describe("signatures", () => {
  const markup = `
    <form>
      <label for="first">First name</label><input id="first" name="first">
      <div class="ref"><label>Email <input type="email"></label></div>
      <div class="ref"><label>Email <input type="email"></label></div>
      <div class="ref"><label>Email <input type="email"></label></div>
      <button type="submit">Submit</button>
    </form>`;

  it("is stable across two captures of the same markup", () => {
    mount(markup);
    const first = captureFields().map((f) => f.signature);
    mount(markup);
    expect(captureFields().map((f) => f.signature)).toEqual(first);
  });

  it("is unique for repeated labels, numbered in DOM order", () => {
    mount(markup);
    const signatures = captureFields().map((f) => f.signature);
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(signatures.filter((s) => s.includes("|email|"))).toEqual([
      "input|email|||email|0",
      "input|email|||email|1",
      "input|email|||email|2",
    ]);
  });

  it("never contains or depends on what the user typed", () => {
    mount(markup);
    const before = captureFields().map((f) => f.signature);
    const input = el<HTMLInputElement>("#first");
    input.value = "Alex-Typed-Value";
    input.setAttribute("value", "Alex-Attr-Value");
    const after = captureFields();
    expect(after.map((f) => f.signature)).toEqual(before);
    expect(after.map((f) => f.signature).join(" ")).not.toMatch(/alex/i);
    expect(after[0]?.value).toBe("Alex-Typed-Value");
  });

  it("ignores generated ids that change on every load", () => {
    mount(`<label for="input-482913">School</label><input id="input-482913" name="school">`);
    const first = captureFields()[0]!.signature;
    mount(`<label for="input-771204">School</label><input id="input-771204" name="school">`);
    expect(captureFields()[0]!.signature).toBe(first);
    expect(first).toBe("input||school||school|0");
  });

  it("does not shift when an earlier field becomes hidden", () => {
    mount(markup);
    const last = captureFields().filter((f) => f.kind === "email")[2]!.signature;
    el(".ref").hidden = true;
    const emails = captureFields().filter((f) => f.kind === "email");
    expect(emails).toHaveLength(2);
    expect(emails[1]?.signature).toBe(last);
  });

  it("matches computeSignature for every captured element", () => {
    mount(markup);
    for (const field of captureFields()) {
      const target = findElement(field.signature);
      expect(target).not.toBeNull();
      expect(computeSignature(target!)).toBe(field.signature);
    }
  });
});

describe("findElement", () => {
  it("round-trips every field of the job application", () => {
    loadDocument(applyHtml);
    const fields = captureFields();
    const targets = fields.map((f) => findElement(f.signature));
    expect(targets.every((t) => t instanceof HTMLElement)).toBe(true);
    expect(new Set(targets).size).toBe(fields.length);
    expect(findElement(byLabel(fields, "Email").signature)).toBe(el("#email"));
    expect(findElement(byLabel(fields, "Phone").signature)).toBe(el('[name="phone"]'));
  });

  it("returns null for unknown signatures", () => {
    mount(`<input aria-label="City">`);
    captureFields();
    expect(findElement("input|text|||nope|0")).toBeNull();
  });

  it("follows a field whose node was replaced by a re-render", () => {
    mount(`<label for="city">City</label><input id="city">`);
    const signature = captureFields()[0]!.signature;
    const stale = el("#city");
    mount(`<label for="city">City</label><input id="city">`);
    expect(findElement(signature)).toBe(el("#city"));
    expect(findElement(signature)).not.toBe(stale);
  });

  it("never resolves to a sensitive element", () => {
    mount(`<label for="pw">Password</label><input id="pw" type="password">`);
    captureFields();
    expect(findElement(computeSignature(el("#pw")))).toBeNull();
  });
});

describe("job application fixture", () => {
  it("captures the expected labels and kinds in DOM order", () => {
    loadDocument(applyHtml);
    expect(captureFields().map((f) => [f.label, f.kind])).toEqual([
      ["Northwind Robotics", "link"],
      ["All open roles", "link"],
      ["First name", "text"],
      ["Last name", "text"],
      ["Email", "email"],
      ["Phone", "tel"],
      ["Location", "text"],
      ["LinkedIn profile", "url"],
      ["GitHub", "url"],
      ["Portfolio or personal website", "url"],
      ["School", "text"],
      ["Degree", "text"],
      ["Expected graduation date", "month"],
      ["Are you legally authorized to work in Canada?", "select"],
      ["Will you now or in the future require sponsorship for an employment visa?", "radio"],
      ["How did you hear about us?", "select"],
      ["Why Northwind?", "textarea"],
      ["Tell us about a project you are proud of", "textarea"],
      ["Resume", "file"],
      ["I certify that the information above is accurate", "checkbox"],
      ["Save draft", "button"],
      ["Submit application", "button"],
      ["Privacy policy", "link"],
    ]);
  });

  it("leaves out the honeypot, hidden, readonly, disabled and SIN fields", () => {
    loadDocument(applyHtml);
    const payload = JSON.stringify(captureFields());
    expect(payload).not.toMatch(/csrf|fixture-token|hp_website|studentRecord|referralCode|insurance|"sin"/i);
  });

  it("captures options, required flags, context and the lock on Submit", () => {
    loadDocument(applyHtml);
    const fields = captureFields();
    expect(byLabel(fields, "First name")).toMatchObject({ required: true, autocomplete: "given-name", context: "Personal information", value: "" });
    expect(byLabel(fields, "Email")).toMatchObject({ required: true, context: "Personal information" });
    expect(byLabel(fields, "Phone")).toMatchObject({ required: false });
    expect(byLabel(fields, "GitHub")).toMatchObject({ name: "github", context: "Links" });
    expect(byLabel(fields, "Are you legally authorized to work in Canada?").options).toEqual([
      { value: "", label: "Select one" },
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ]);
    const sponsorship = byLabel(fields, "Will you now or in the future require sponsorship for an employment visa?");
    expect(sponsorship).toMatchObject({ name: "sponsorship", required: true, value: "", context: "Work eligibility" });
    expect(sponsorship.options).toEqual([{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]);
    expect(byLabel(fields, "How did you hear about us?").options).toHaveLength(6);
    expect(byLabel(fields, "Save draft").locked).toBe(false);
    expect(byLabel(fields, "Submit application").locked).toBe(true);
  });

  it("produces unique, value-free signatures that survive a reload", () => {
    loadDocument(applyHtml);
    const first = captureFields().map((f) => f.signature);
    expect(new Set(first).size).toBe(first.length);
    loadDocument(applyHtml);
    el<HTMLInputElement>("#firstName").value = "Alex";
    el<HTMLInputElement>('input[name="sponsorship"][value="no"]').checked = true;
    expect(captureFields().map((f) => f.signature)).toEqual(first);
  });
});
