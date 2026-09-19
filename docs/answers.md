# Answering the hard questions: guess, correct, remember

Binding design. Today Ghost fills what it knows and skips the rest, so a real Greenhouse application ends with the demographic questions, the country-specific work-authorization question and the unmatched dropdowns empty. That is not a finished application. This document defines how Ghost answers **every** question, how it keeps its proposals honest, and how a single correction by the user teaches it for every site afterwards.

The whole mechanism is generic: no site rules, no per-ATS lists. A question is identified by what it asks and what it offers, so an answer learned on Greenhouse applies on Lever, Ashby, Workday and a random careers page.

## 1. Always propose something

**Ghost never gives up on a field.** Every question gets a proposal, in this order: a profile fact, then an answer the user gave before, then an inference from the facts, then the most conservative default. A wrong proposal costs one correction, and that correction is remembered for every site afterwards. The point of the product is that it starts out roughly right and becomes exactly right.

Classification (derived in code from the label, the section heading, the option labels and the kind: `shared/src/answers/classify.ts`) does not decide *whether* to answer. It decides *how confident* the proposal is, *how it is shown*, and *which default is the conservative one*.

| Class | How it is recognized | Default when there is no fact and no learned answer |
| --- | --- | --- |
| **Ordinary** (referral source, "how did you hear", relocation, start date, willingness questions, most custom questions) | Everything not matched below | The most neutral option: an explicit "Other" / "None" / "N/A" / "Prefer not to say" when present, otherwise the option that commits the applicant to the least. Confidence 0.72, shown as a guess. |
| **Declaration** (work authorization in a named country, sponsorship, "18 or older", criminal record, export control, security clearance, background-check consent, "I certify...") | Declaration vocabulary in the label, or the question names a country | The **conservative inference from the profile**, never a flattering one: a profile authorized in Canada answers "No" to "authorized to work in the United States" and "Yes" to "will you require sponsorship" in the US. Where no inference exists, the answer that claims the least (no criminal record is the common case and is used; "I certify" style attestations are proposed but flagged). Confidence 0.7, shown as a guess with a "check this" badge. Hold-Tab always stops here, and so does an attestation checkbox: it takes a deliberate Tab. |
| **Protected** (gender, race, ethnicity, Hispanic/Latino, veteran status, disability status, age or date of birth, religion, sexual orientation, marital status, anything under a "self-identification" heading) | Protected vocabulary, or an option set that pairs demographic terms with a decline option | The option meaning **"I prefer not to answer"** (every real EEO control offers one). That is a true answer for anyone and completes the form. Confidence 0.8. If the user prefers to disclose, they change it once and Ghost remembers. The ONLY case where Ghost proposes nothing: a protected question with no decline-style option, because the alternative would be inventing a characteristic; the HUD then says "needs your answer". |

Nothing here is site-specific: the vocabularies and the neutral-option rule are generic and tested against how Greenhouse, Lever, Ashby, Workday and iCIMS phrase things.

## 2. Country-scoped and qualified facts

`workAuthorization` and `requiresSponsorship` become qualified keys: `workAuthorization.CA`, `workAuthorization.US`, `requiresSponsorship.US`, and so on, with the unqualified key as the fallback only when the question names no country. The country is parsed out of the label in code ("in the United States", "in the U.S.", "for any employer in Canada", "in the UK"). The demo profile keeps `workAuthorization.CA = yes` and `requiresSponsorship.CA = no`. A US question is therefore answered by the conservative inference (authorized: No, sponsorship required: Yes) as a visible guess; the moment the user corrects it, the answer is learned as `workAuthorization.US` and used everywhere after that.

## 3. How a default is chosen

1. An option matching a profile fact wins (that is not a guess).
2. Otherwise the **neutral option**, found in code: an explicit neutral ("Other", "None of the above", "N/A", "Prefer not to say", "Decline to self-identify") if the option set has one; else, for a yes/no question, the answer that claims the least for the applicant (for a declaration that is the conservative one, e.g. "No" to authorization the profile does not support; for a willingness question, "Yes" to relocating or starting on time, since that commits nobody to a falsehood and is what most applicants answer).
3. Free-text questions with no fact fall back to the streamed draft path (`/v1/ghost-text`) exactly as today; they are never left empty when the server is reachable.
4. Every proposal that did not come from a fact or a learned answer is marked `source: "guess"`, rendered with a dotted underline, reported in the HUD, and **never accepted by hold-Tab**: holding Tab stops at the first guess so the user sees it before Submit (which stays locked).

## 4. Learning from a correction

```ts
// shared/src/answers/signature.ts
questionSignature(field): string   // stable, value-free, site-independent
```
The signature is built from the normalized question text (lowercased, punctuation and the company name removed, "at Viam" / "at <Company>" stripped), the field kind, and a hash of the normalized option labels when there are options. The same question on another ATS produces the same signature.

A **correction** is recorded when, with learning enabled:

- the user edits a field Ghost filled (typing over ghost text, choosing a different option, unchecking a box), or
- the user answers a field Ghost left empty (the rare protected question with no decline option), or
- the user changes an answer later in the same session.

```ts
// shared/src/answers/store.ts
interface LearnedAnswer {
  signature: string;
  label: string;          // the question as last seen, for the options page; never a value from elsewhere
  kind: FieldKind;
  value: string;          // exactly what the user chose or typed
  optionLabel?: string;   // for selects: the visible option text, so a different site's value can be matched
  count: number;          // how many times the user has given this answer
  updatedAt: string;
  origins: string[];      // up to 3 origins where it was used, for the options page
  class: "ordinary" | "protected" | "declaration";
}
```

Rules:
- A correction always beats a guess and beats a profile fact for that signature (the user is the authority) but never overwrites the profile fact itself; the options page shows both and offers "make this a profile fact".
- Confidence for a learned answer: 0.86 after one correction, 0.94 after two or more.
- Protected and declaration answers are learned exactly like the rest, because the user typed them. They are stored locally only and never sent to any server (`/v1/predict/form` keeps receiving fact KEYS only, and learned answers are applied client-side after the server's assignments come back).
- Values that look like secrets (card, SIN/SSN, password) are never learned, as today.
- Cap 500 answers, LRU, capped at 2,000 characters each. The options page lists them with delete and "forget everything learned here".

## 5. Where it runs

The store and all rules live in `shared/src/answers/**` (pure, unit-tested) so both clients behave identically:

- **Extension**: `extension/src/content/learning.ts` records corrections (it already watches user edits); `extension/src/content/predict.ts` consults the store and the classifier before the offline heuristic and after the server's assignments. Persisted in `chrome.storage.local` under `ghost.answers`.
- **Desktop**: `desktop/core/predict.ts` and `entry.ts` gain the same calls; `GHController`/`GHWriter` report corrections; persisted in `~/Library/Application Support/Ghost/answers.json` (0600).

## 6. Telemetry and the learning loop

Every proposal and correction produces a **value-free** counter, in the shape Samir's agent outcome telemetry already uses (`shared/src/agentTelemetry.ts` on `codex/jev-computer-use-e2e`; until that merges, the same counters ride in `ghost.metrics` and `POST /v1/metrics/event`):

```
answer.proposed   { class, source: "fact"|"learned"|"guess", accepted: bool, confidenceBucket }
answer.corrected  { class, hadGhost: bool, wasGuess: bool }
```

No label, no value, no origin. These answer the only questions that matter for the demo and for Sentry: how often a guess was right, how often one correction was enough, and whether learned answers stay accepted over time. When the agent branch lands, `answer.corrected` becomes an outcome the replay evals can score, so a correction improves future runs rather than being lost.

## 7. What must never happen

- Ghost never invents a protected characteristic when the form offers a way to decline: it declines.
- Ghost never proposes the flattering side of a declaration. Inferences always run toward claiming less (no authorization the profile does not support, sponsorship required rather than not).
- Ghost never sends a learned answer, a protected value or a declaration to any server, and never logs a value.
- A guess is always visibly a guess, never auto-accepted by hold-Tab, and always reversible before Submit, which stays locked and is never pressed by Ghost.
