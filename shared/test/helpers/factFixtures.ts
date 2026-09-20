// The demo profile as a graph, plus the facts a résumé never holds: an address, an employer, a job title,
// a work inbox, a few preferences. All fictional (CLAUDE.md rule 6). These are what make a shipping form,
// a support ticket, a conference signup and an address book entry fill themselves.
import { DEMO_FACT_GRAPH, setUserFact, type CapturedField, type FactGraph, type FieldKind } from "../../src";

const NOW = "2026-02-01T00:00:00.000Z";

const EXTRA: Array<[string, string]> = [
  ["address.home.street", "742 King Street West"],
  ["address.home.unit", "Unit 4"],
  ["address.home.postalCode", "N2L 3G1"],
  ["contact.email.work", "alex@northwind.example"],
  ["work.employer.current", "Northwind Robotics"],
  ["work.title", "Software Engineer"],
  ["preferences.shirtSize", "Medium"],
  ["preferences.dietary", "Vegetarian"],
  ["links.twitter", "https://x.com/alexchen-dev"],
];

/** The demo graph with the open-world facts. Nothing sensitive. */
export function demoGraph(): FactGraph {
  let graph = DEMO_FACT_GRAPH;
  for (const [key, value] of EXTRA) graph = setUserFact(graph, key, value, {}, NOW).graph;
  return graph;
}

/** The same graph plus one sensitive fact the user typed themselves: it must never be matched or sent. */
export function demoGraphWithSensitive(): FactGraph {
  return setUserFact(demoGraph(), "health.cardNumber", "1234 567 890 AB", { category: "other", label: "health card number" }, NOW).graph;
}

const RECT = { x: 0, y: 0, width: 100, height: 20 };

export function fieldOf(label: string, kind: FieldKind = "text", extra: Partial<CapturedField> = {}): CapturedField {
  return { signature: `sig:${label}:${kind}`, label, kind, rect: RECT, ...extra };
}
