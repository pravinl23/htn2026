# Knowing the user first: a fact graph built from what they already have

Binding design. Ghost's mapping layer currently assumes a résumé: 19 fixed keys (`firstName … workAuthorization, referralSource`). That is why it shines on a job form and goes blank on a shipping address, a support ticket, a conference signup or a doctor's intake form. The fix is not more keys, it is a different shape: **learn who the user is from the accounts and files they already have, store typed facts with provenance, and let any form match against that graph.**

## 1. The fact graph

```ts
// shared/src/facts/types.ts
export type FactCategory =
  | "identity" | "contact" | "address" | "work" | "education" | "links"
  | "preferences" | "org" | "travel" | "finance-safe" | "other";

export interface Fact {
  key: string;              // dotted, open-ended: "contact.email.work", "address.home.postalCode", "work.employer.current"
  value: string;
  category: FactCategory;
  label: string;            // human phrasing used for matching and for the options page ("work email")
  aliases: string[];        // other phrasings a form might use ("business e-mail", "company email")
  confidence: number;       // 0..1
  source: FactSource;       // where it came from
  evidence?: string;        // short, local-only snippet for the review UI; never leaves the machine
  updatedAt: string;
  verifiedByUser: boolean;  // true once the user accepts or types it
  sensitive: boolean;       // never auto-filled, never sent anywhere (IDs, financial, health)
}

export type FactSource =
  | { kind: "user" }                                    // typed or corrected by the user (always wins)
  | { kind: "file"; name: string }                      // résumé, vCard, exported PDF
  | { kind: "github"; login: string }
  | { kind: "website"; origin: string }
  | { kind: "mail"; connector: string }                 // signature blocks, receipts, confirmations
  | { kind: "calendar"; connector: string }
  | { kind: "drive"; connector: string }
  | { kind: "observed"; origin: string };               // what the user typed into a form before
```

Keys are open-ended strings, not an enum: a new kind of fact never needs a code change. Matching a form field to a fact is done by comparing the field's accessible name against each fact's `label` and `aliases` (the existing normalizer plus the Jev choice question that already picks one option out of many), so **the same mapping code fills a job form, a shipping form and a hospital intake form**.

## 2. Sources, in order of trust

| Source | What it yields | How it is read |
| --- | --- | --- |
| **The user** | Anything they type or correct | Already implemented (`docs/answers.md`); always overrides |
| **Résumé / vCard / exported profile file** | Name, contact, education, work history, links | Existing `POST /v1/profile/extract` |
| **GitHub** | Login, display name, public email, blog URL, company, location, pinned languages | Public REST, no auth needed for a username |
| **Personal website** | Name, role, location, links, short bio | One fetch of the URL the user gives, text only |
| **Mail connector** | Signature blocks (name, title, employer, phone), shipping addresses from order confirmations, the address the user actually applies with | Read-only, through a connector the user has already authorized (Composio session, or an MCP the host provides) |
| **Calendar connector** | Current employer from recurring internal meetings, timezone, working hours | Read-only, metadata only |
| **Drive / docs connector** | A résumé or CV document the user already keeps | Read-only, opened only when the user points at it |
| **Observed** | Values the user typed into forms before | Already implemented |

Nothing is read without the user connecting that source and pressing "Scan". Every import is a **proposal**: the options page shows each candidate fact with its source, its evidence snippet and a checkbox, and nothing enters the graph until the user accepts it. A fact the user edits becomes `source: user` and is never overwritten by a later scan.

## 3. Extraction pipeline

```
source text  ->  code extractors (regex for emails, phones, URLs, postal codes, dates)
             ->  LLM structured extraction for the rest (one call per document, JSON schema, local server)
             ->  code validation (shape, plausibility, sensitivity classification)
             ->  Jev choice for conflicts ("which of these three is the user's current employer?")
             ->  proposals with provenance  ->  user review  ->  fact graph
```

The LLM never decides what is sensitive and never writes a value into a form directly: code classifies, code validates, the user accepts.

## 4. Privacy rules (non-negotiable)

- The graph lives only on the machine: `chrome.storage.local` for the extension, `~/Library/Application Support/Ghost/profile.json` for the native agent. It is never uploaded; `/v1/predict/form` keeps receiving fact **keys** only.
- Connector reads happen through the user's own authorization, locally, and fetched text is discarded after extraction; only the extracted facts and a short evidence snippet are kept.
- Anything classified sensitive (government IDs, payment details, health, credentials) is never extracted at all. If a source contains one, it is skipped and counted, never stored.
- A one-click "forget this source" removes every fact whose provenance is that source.

## 5. What this unlocks

With a populated graph the guess policy in `docs/answers.md` gets much better inputs: a shipping form matches `address.home.*`, a support ticket matches `contact.email.work` and `work.employer.current`, a conference signup matches `identity.fullName` plus `work.title`. The existing 19 résumé keys become just one category of the graph, and the field→fact question Jev already answers stays exactly the same shape: pick one of the offered fact keys, or `none`.
