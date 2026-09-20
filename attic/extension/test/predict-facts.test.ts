// The client, switched to the fact graph: the same job form as always, plus the forms Ghost used to go
// blank on. A shipping checkout is the honest test — none of its fields is a résumé key, and Ghost fills
// it the moment the graph holds an address, with no new mapping code anywhere.
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEMO_PROFILE, profileFromGraph, profileToGraph, setUserFact } from "@ghost/shared";
import type { CapturedField, FactGraph, Ghost, GhostSettings } from "@ghost/shared";
import { captureFields } from "../src/content/capture";
import { buildGhostsOffline, graphFor } from "../src/content/predict";
import type { PredictDeps } from "../src/content/predict";
import applyHtml from "./fixtures/apply.html?raw";

const SETTINGS: GhostSettings = { ...DEFAULT_SETTINGS };

/** A plain shipping checkout: nothing on it is a résumé field, and it never goes near the demo site. */
const SHIPPING = `
  <form>
    <h2>Shipping address</h2>
    <label>Full name <input name="name" autocomplete="name"></label>
    <label>Email address <input type="email" name="email"></label>
    <label>Street address <input name="line1" autocomplete="address-line1"></label>
    <label>Apartment, suite, etc. (optional) <input name="line2"></label>
    <label>City <input name="city"></label>
    <label>Province <input name="province"></label>
    <label>ZIP / Postal code <input name="postal"></label>
    <label>Country
      <select name="country">
        <option value="">Select a country</option>
        <option value="CA">Canada</option>
        <option value="US">United States</option>
      </select>
    </label>
    <label>Phone <input type="tel" name="phone"></label>
    <h2>Payment</h2>
    <label>Card number <input name="cardnumber" autocomplete="cc-number"></label>
    <button type="submit">Place order</button>
  </form>`;

function mount(html: string): CapturedField[] {
  document.body.innerHTML = html;
  return captureFields();
}

function deps(graph?: FactGraph): PredictDeps {
  const profile = graph ? profileFromGraph(graph, DEMO_PROFILE.pastAnswers) : structuredClone(DEMO_PROFILE);
  return graph ? { profile, graph, settings: SETTINGS } : { profile, settings: SETTINGS };
}

/** Ghosts keyed by the field's own label, which is what a reader of this test cares about. */
function filled(fields: CapturedField[], ghosts: Ghost[]): Record<string, string> {
  const labels = new Map(fields.map((field) => [field.signature, field.label]));
  return Object.fromEntries(ghosts.filter((g) => !g.locked).map((g) => [labels.get(g.signature) ?? g.signature, g.value ?? ""]));
}

function run(html: string, graph?: FactGraph): { fields: CapturedField[]; ghosts: Ghost[]; values: Record<string, string> } {
  const fields = mount(html);
  const ghosts = buildGhostsOffline(fields, deps(graph));
  return { fields, ghosts, values: filled(fields, ghosts) };
}

/** The graph as it stands after the user saves what a contact card proposed. */
function graphWithAddress(): FactGraph {
  let graph = profileToGraph(DEMO_PROFILE);
  graph = setUserFact(graph, "address.home.street", "88 Rideau Street").graph;
  graph = setUserFact(graph, "address.home.unit", "Apt 4").graph;
  graph = setUserFact(graph, "address.home.postalCode", "N2L 3G1").graph;
  return graph;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("graphFor", () => {
  it("derives a graph from the flat profile, with the labels and phrasings the defs give the keys", () => {
    const graph = graphFor(deps());
    expect(graph.facts.email?.label).toBe("email");
    expect(graph.facts.city?.category).toBe("address");
    expect(Object.keys(graph.facts)).toHaveLength(Object.keys(DEMO_PROFILE.facts).length);
  });

  it("memoizes per profile object, and prefers a graph the caller passed", () => {
    const d = deps();
    expect(graphFor(d)).toBe(graphFor(d));
    const passed = graphWithAddress();
    expect(graphFor({ ...d, graph: passed })).toBe(passed);
  });
});

describe("a shipping checkout", () => {
  it("fills what the profile already knows, and leaves the address alone until Ghost has one", () => {
    const { values } = run(SHIPPING);
    expect(values).toMatchObject({
      "Full name": "Alex Chen",
      "Email address": "alex.chen.dev@example.com",
      City: "Waterloo",
      Province: "Ontario",
      Country: "CA",
      Phone: "+1 519 555 0142",
    });
    expect(values["Street address"]).toBeUndefined();
    expect(values["ZIP / Postal code"]).toBeUndefined();
  });

  it("fills the whole address once the graph holds one, with no new mapping code", () => {
    const { values } = run(SHIPPING, graphWithAddress());
    expect(values).toMatchObject({
      "Full name": "Alex Chen",
      "Street address": "88 Rideau Street",
      "Apartment, suite, etc. (optional)": "Apt 4",
      "ZIP / Postal code": "N2L 3G1",
      City: "Waterloo",
      Province: "Ontario",
      Country: "CA",
    });
  });

  it("never proposes anything for the card number, and parks on the locked button", () => {
    const { values, ghosts } = run(SHIPPING, graphWithAddress());
    expect(values["Card number"]).toBeUndefined();
    expect(JSON.stringify(ghosts)).not.toContain("cc-number");
    const last = ghosts.at(-1);
    expect(last?.locked).toBe(true);
    expect(last?.displayText).toBe("Place order");
  });

  it("never offers a sensitive fact, whatever a field is called", () => {
    const graph = setUserFact(graphWithAddress(), "health.cardNumber", "1234 567 890 XY").graph;
    const { ghosts } = run(`<form><label>Health card number <input name="health"></label><label>City <input name="city"></label></form>`, graph);
    expect(ghosts.map((g) => g.value)).toEqual(["Waterloo"]);
    expect(JSON.stringify(ghosts)).not.toContain("1234 567 890");
  });
});

describe("the job application still fills exactly as it did", () => {
  const expected: Record<string, string> = {
    "First name": "Alex",
    "Last name": "Chen",
    Email: "alex.chen.dev@example.com",
    Location: "Waterloo, ON",
    School: "University of Waterloo",
    Degree: "BCS Computer Science",
    "Expected graduation date": "2028-04",
  };

  it("maps the demo profile onto the demo form", () => {
    const { values } = run(applyHtml);
    for (const [label, value] of Object.entries(expected)) expect(values[label], label).toBe(value);
    expect(values["Social Insurance Number"]).toBeUndefined();
    expect(values["Student record (filled by your school)"]).toBeUndefined();
  });

  it("maps it the same way with an address in the graph: a new fact never steals a job form's field", () => {
    expect(run(applyHtml, graphWithAddress()).values).toEqual(run(applyHtml).values);
  });
});
