// The point of the fact graph, as five forms no job board would ever show: a shipping checkout, a support
// ticket, a conference signup, an address book entry and a doctor's intake form. Ghost used to go blank on
// every one of them. Not one line of form-specific code exists; the facts describe themselves and the
// mapper compares names.
import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS_CONFIDENCE,
  NEEDS_TEXT,
  NONE,
  bestFactForField,
  emptyGraph,
  factKeysForRequest,
  getFact,
  mapFieldToFact,
  mapFormHeuristically,
  matchFieldToFacts,
  setUserFact,
  type CapturedField,
  type FieldKind,
} from "../src";
import { demoGraph, demoGraphWithSensitive, fieldOf } from "./helpers/factFixtures";

const GRAPH = demoGraph();
const THRESHOLD = 0.7;

type Case = [label: string, kind: FieldKind, expected: string, extra?: Partial<CapturedField>];

function fields(cases: Case[]): CapturedField[] {
  return cases.map(([label, kind, , extra]) => fieldOf(label, kind, extra));
}

/** Every corpus is run through the real mapping path, field by field and then as a whole form. */
function form(name: string, cases: Case[]): void {
  describe(name, () => {
    for (const [label, kind, expected, extra] of cases) {
      it(`${kind} "${label}" -> ${expected}`, () => {
        const assignment = mapFieldToFact(fieldOf(label, kind, extra), [], GRAPH);
        expect(assignment.factKey).toBe(expected);
        if (expected !== NONE) expect(assignment.confidence).toBeGreaterThanOrEqual(THRESHOLD);
      });
    }

    it("survives the form-level pass unchanged", () => {
      expect(mapFormHeuristically(fields(cases), [], GRAPH).map((a) => a.factKey)).toEqual(cases.map(([, , expected]) => expected));
    });
  });
}

form("a shipping checkout", [
  ["Full name", "text", "fullName"],
  ["Street address", "text", "address.home.street", { autocomplete: "street-address" }],
  ["Apartment, suite, etc. (optional)", "text", "address.home.unit"],
  ["City", "text", "city"],
  ["Province", "select", "province"],
  ["Shipping postal code", "text", "address.home.postalCode"],
  ["Country", "select", "country"],
  ["Phone number", "tel", "phone"],
  ["Email address", "email", "email"],
  ["Delivery instructions", "textarea", NEEDS_TEXT],
]);

form("a support ticket", [
  ["Your name", "text", "fullName"],
  ["Work email", "email", "contact.email.work"],
  ["Company name", "text", "work.employer.current"],
  ["Subject", "text", NONE],
  ["Order number", "text", NONE],
  ["Website URL", "url", "website"],
  ["How can we help?", "textarea", NEEDS_TEXT],
]);

form("a conference signup", [
  ["Full name", "text", "fullName"],
  ["Email", "email", "email"],
  ["Job title", "text", "work.title"],
  ["Organization", "text", "work.employer.current"],
  ["T-shirt size", "select", "preferences.shirtSize"],
  ["Dietary restrictions", "text", "preferences.dietary"],
  ["Twitter handle", "text", "links.twitter"],
  ["LinkedIn profile", "url", "linkedin"],
  ["What do you hope to get out of the conference?", "textarea", NEEDS_TEXT],
]);

form("an address book entry", [
  ["First name", "text", "firstName"],
  ["Last name", "text", "lastName"],
  ["Home address", "text", "address.home.street"],
  ["City", "text", "city"],
  ["Postal code", "text", "address.home.postalCode"],
  ["Mobile phone", "tel", "phone"],
  ["Work email", "email", "contact.email.work"],
  ["Employer", "text", "work.employer.current"],
  ["Website", "url", "website"],
]);

const INTAKE: Case[] = [
  ["Full name", "text", "fullName"],
  ["Home address", "text", "address.home.street"],
  ["Phone number", "tel", "phone"],
  ["Health card number", "text", NONE],
  ["Date of birth", "text", NONE],
  ["Insurance policy number", "text", NONE],
  ["Emergency contact name", "text", NONE],
  ["Emergency contact phone", "tel", NONE],
  ["Family doctor", "text", NONE],
  ["Reason for your visit", "textarea", NEEDS_TEXT],
];

form("a doctor's intake form", INTAKE);

describe("a doctor's intake form maps nothing sensitive", () => {
  const graph = demoGraphWithSensitive();

  it("keeps the sensitive fact out of every match, even on the field that asks for it", () => {
    for (const [label, kind] of INTAKE) {
      const matches = matchFieldToFacts(fieldOf(label, kind), graph);
      expect(matches.map((m) => m.key), label).not.toContain("health.cardNumber");
      expect(mapFieldToFact(fieldOf(label, kind), [], graph).factKey, label).not.toBe("health.cardNumber");
    }
    expect(getFact(graph, "health.cardNumber")?.sensitive).toBe(true);
  });

  it("keeps it off the wire", () => {
    expect(factKeysForRequest(graph)).not.toContain("health.cardNumber");
  });

  it("proposes nothing at all for the sensitive fields themselves", () => {
    for (const label of ["Health card number", "Date of birth", "Social insurance number", "Credit card number"]) {
      expect(matchFieldToFacts(fieldOf(label), graph), label).toEqual([]);
    }
  });
});

describe("matchFieldToFacts", () => {
  it("ranks, and says why, without ever naming a value", () => {
    const [best, ...rest] = matchFieldToFacts(fieldOf("Work email", "email"), GRAPH);
    expect(best).toMatchObject({ key: "contact.email.work" });
    expect(best?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(rest.map((m) => m.key)).toContain("email");
    for (const match of [best, ...rest]) expect(match?.why).not.toContain("@");
  });

  it("reads a standard autocomplete token over a label that says nothing", () => {
    for (const [token, key] of [
      ["postal-code", "address.home.postalCode"],
      ["street-address", "address.home.street"],
      ["organization", "work.employer.current"],
      ["organization-title", "work.title"],
      ["country-name", "country"],
      ["given-name", "firstName"],
    ] as const) {
      const match = bestFactForField(fieldOf("Field 3", "text", { autocomplete: token }), GRAPH);
      expect(match?.key, token).toBe(key);
      expect(match?.confidence, token).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("answers a question nobody wrote a rule for", () => {
    expect(bestFactForField(fieldOf("Where should we send this?"), GRAPH)?.key).toBe("address.home.street");
    expect(bestFactForField(fieldOf("Your title"), GRAPH)?.key).toBe("work.title");
  });

  it("reads a name or id only when it says nothing beyond the fact", () => {
    expect(bestFactForField(fieldOf("", "text", { name: "shipping_postal_code" }), GRAPH)?.key).toBe("address.home.postalCode");
    expect(bestFactForField(fieldOf("", "text", { name: "employer_lookup_token" }), GRAPH)).toBeNull();
  });

  it("keeps a fact out of a field it cannot be written into", () => {
    expect(matchFieldToFacts(fieldOf("Postal code", "checkbox"), GRAPH)).toEqual([]);
    expect(matchFieldToFacts(fieldOf("Street address", "button"), GRAPH)).toEqual([]);
    expect(matchFieldToFacts(fieldOf("Employer", "file"), GRAPH)).toEqual([]);
  });

  it("never offers a fact for someone else's details", () => {
    for (const label of ["Emergency contact phone", "Reference email", "Manager's email", "Next of kin address"]) {
      expect(matchFieldToFacts(fieldOf(label, "text"), GRAPH), label).toEqual([]);
    }
  });

  it("never offers a fact for a credential field", () => {
    expect(matchFieldToFacts(fieldOf("Email", "email", { autocomplete: "username" }), GRAPH)).toEqual([]);
    expect(matchFieldToFacts(fieldOf("Password", "text", { inputType: "password" }), GRAPH)).toEqual([]);
  });

  it("stays under the gate when two facts fit equally well", () => {
    let graph = setUserFact(emptyGraph(), "other.alpha", "one", { label: "widget colour" }).graph;
    graph = setUserFact(graph, "other.beta", "two", { label: "widget colour" }).graph;
    const matches = matchFieldToFacts(fieldOf("Widget colour"), graph);
    expect(matches).toHaveLength(2);
    for (const match of matches) expect(match.confidence).toBe(AMBIGUOUS_CONFIDENCE);
    expect(bestFactForField(fieldOf("Widget colour"), graph)).toBeNull();
  });

  it("is not confused by two facts that hold the same value", () => {
    let graph = setUserFact(emptyGraph(), "other.alpha", "same", { label: "widget colour" }).graph;
    graph = setUserFact(graph, "other.beta", "same", { label: "widget colour" }).graph;
    expect(bestFactForField(fieldOf("Widget colour"), graph)?.key).toBe("other.alpha");
  });

  it("stays under the gate when the label may mean a different one of several", () => {
    const match = matchFieldToFacts(fieldOf("Alternate email", "email"), GRAPH)[0];
    expect(match?.key).toBe("email");
    expect(match?.confidence).toBeLessThan(THRESHOLD);
  });

  it("only offers the keys the caller is offering", () => {
    expect(matchFieldToFacts(fieldOf("Postal code"), GRAPH, { keys: ["city"] })).toEqual([]);
  });

  it("offers nothing from an empty graph", () => {
    expect(matchFieldToFacts(fieldOf("Postal code"), emptyGraph())).toEqual([]);
  });
});

describe("one new fact teaches every form at once", () => {
  it("fills a field that mapped to nothing a moment ago", () => {
    const field = fieldOf("Blood type", "select");
    expect(mapFieldToFact(field, [], GRAPH).factKey).toBe(NONE);
    const taught = setUserFact(GRAPH, "other.bloodType", "O negative", { label: "blood type" }).graph;
    const assignment = mapFieldToFact(field, [], taught);
    expect(assignment.factKey).toBe("other.bloodType");
    expect(assignment.confidence).toBeGreaterThanOrEqual(THRESHOLD);
  });
});
