// From the flat 19-key résumé profile to the open graph, and back.
//
// The résumé keys keep their names ("firstName", "workAuthorization.CA"): stored profiles, per-site
// caches, learned answers and the server's own fact descriptions all speak them, and renaming them would
// break every one of those for no gain. What migration adds is what the flat profile never had: a
// category, a human label and the phrasings a form might use, so the SAME mapping code that fills a job
// form fills a shipping form once one address fact is in the graph.
import type { PastAnswer, Profile } from "../types";
import { factDefFor, labelFromKey } from "./defs";
import { emptyGraph, upsertFact } from "./graph";
import type { FactGraph, FactProposal, FactSource } from "./types";

/** A flat profile as facts, with labels, aliases and provenance. Values the user already owns: source `user`. */
export function profileToGraph(profile: Profile, source: FactSource = { kind: "user" }, now = new Date().toISOString()): FactGraph {
  let graph = emptyGraph(now);
  for (const [key, value] of Object.entries(profile.facts)) {
    if (typeof value !== "string" || value.trim() === "") continue;
    const def = factDefFor(key);
    // Only what the definition actually says: a key the defs do not know still finds its category from
    // its own first segment ("travel.homeAirport" is travel), and its label from its last one.
    const proposal: FactProposal = {
      key,
      value,
      source,
      label: def?.label ?? labelFromKey(key),
      aliases: def?.aliases ?? [],
      confidence: source.kind === "user" ? 1 : 0.8,
    };
    if (def?.category) proposal.category = def.category;
    if (def?.kinds) proposal.kinds = def.kinds;
    graph = upsertFact(graph, proposal, now).graph;
  }
  return graph;
}

/**
 * The graph as the flat facts the rest of Shabang still reads. Sensitive facts are left out: they are the
 * user's to type into a field themselves, and `Profile.facts` keys travel to the server.
 */
export function graphToProfileFacts(graph: FactGraph): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const fact of Object.values(graph.facts)) {
    if (!fact.sensitive && fact.value !== "") facts[fact.key] = fact.value;
  }
  return facts;
}

export function profileFromGraph(graph: FactGraph, pastAnswers: PastAnswer[] = []): Profile {
  return { facts: graphToProfileFacts(graph), pastAnswers };
}
