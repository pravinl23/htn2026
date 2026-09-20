# Answering the hard questions: guess, correct, remember

Binding design. Today Shabang fills what it knows and skips the rest, so a real Greenhouse application ends with the demographic questions, the country-specific work-authorization question and the unmatched dropdowns empty. That is not a finished application. This document defines how Shabang answers **every** question, how it keeps its proposals honest, and how a single correction by the user teaches it for every site afterwards.

The whole mechanism is generic: no site rules, no per-ATS lists. A question is identified by what it asks and what it offers, so an answer learned on Greenhouse applies on Lever, Ashby, Workday and a random careers page.

## 1. Always propose something

**Shabang never gives up on a field.** Every question gets a proposal, in this order: a profile fact, then an answer the user gave before, then an inference from the facts, then the most conservative default. A wrong proposal costs one correction, and that correction is remembered for every site afterwards. The point of the product is that it starts out roughly right and becomes exactly right.

Classification (derived in code from the label, the section heading, the option labels and the kind: `shared/src/answers/classify.ts`) does not decide *whether* to answer. It decides *how confident* the proposal is, *how it is shown*, and *which default is the conservative one*.

| Class | How it is recognized | Default when there is no fact and no learned answer |
| --- | --- | --- |
| **Ordinary** (referral source, "how did you hear", relocation, start date, willingness questions, most custom questions) | Everything not matched below | The most neutral option: an explicit "Other" / "None" / "N/A" / "Prefer not to say" when present, otherwise the option that commits the applicant to the least. Confidence 0.72, shown as a guess. |
| **Declaration** (work authorization in a named country, sponsorship, "18 or older", criminal record, export control, security clearance, background-check consent, "I certify...") | Declaration vocabulary in the label, or the question names a country | The **conservative inference from the profile**, never a flattering one: a profile authorized in Canada answers "No" to "authorized to work in the United States" and "Yes" to "will you require sponsorship" in the US. Where no inference exists, the answer that claims the least (no criminal record is the common case and is used; "I certify" style attestations are proposed but flagged). Confidence 0.7, shown as a guess with a "check this" badge. Hold-Tab always stops here, and so does an attestation checkbox: it takes a deliberate Tab. A **consent to be screened** (background, credit, drug) is the exception: an unticked box is already an answer, so Shabang leaves the box alone and says so. A yes/no *control* has no unanswered state, so there the routine consent is still proposed and flagged. |
| **Protected** (gender, race, ethnicity, Hispanic/Latino, veteran status, disability status, age or date of birth, religion, sexual orientation, marital status, anything under a "self-identification" heading) | Protected vocabulary, or an option set that pairs demographic terms with a decline option | The option meaning **"I prefer not to answer"** (every real EEO control offers one). That is a true answer for anyone and completes the form. Confidence 0.8. If the user prefers to disclose, they change it once and Shabang remembers. With no decline-style option at all (rare), Shabang still proposes: the least specific option available, marked as a guess with a "check this" badge, because a visible guess the user corrects in one keystroke beats an empty field (`docs/always-propose.md`). |

Nothing here is site-specific: the vocabularies and the neutral-option rule are generic and tested against how Greenhouse, Lever, Ashby, Workday and iCIMS phrase things.

Two things the vocabulary has to carry on its own, because the option set gives nothing away:

- **A protected question with a bare Yes/No answer set.** "Do you identify as a member of an underrepresented group?", "Are you currently pregnant or planning to start a family?", "Are you a first-generation college student?", "Which generation do you belong to?" offer no demographic option text and no decline option, so the EEO-scale rule cannot see them. They are recognized from the label instead; otherwise they fall through to the ordinary guess, which would state the claim.
- **A negation that belongs to a subordinate clause, not to the question.** "convicted of a felony THAT HAS NOT been expunged" is not a negated question, and "authorized to work in the US WITHOUT RESTRICTION" is not one either -- "without restriction" qualifies the scope of the authorization. Only the head clause is read for negation, and scope qualifiers are taken out of it first. Reading either as a negation flips the conservative answer into the flattering one, which section 7 forbids.

## 2. Country-scoped and qualified facts

`workAuthorization` and `requiresSponsorship` become qualified keys: `workAuthorization.CA`, `workAuthorization.US`, `requiresSponsorship.US`, and so on, with the unqualified key as the fallback only when the question names no country.

**A qualified key never answers an unscoped question.** "Will you now or in the future require sponsorship for employment visa status?" is the commonest question on a US board and it names nowhere; answering it from `requiresSponsorship.CA` would put "No, I will not require sponsorship" on a US form as a *fact* -- unflagged, above every threshold, and taken by a held accept key. Only the UNQUALIFIED key is a fallback there. With nothing unqualified to go on, the conservative guess answers it, visibly, and one correction learns the real key.

The reverse direction is sound and is kept: a question that names the profile's OWN country may be answered from the unqualified key, at 0.85, because that is what the old key always meant. The country is parsed out of the label in code ("in the United States", "in the U.S.", "for any employer in Canada", "in the UK"). The demo profile keeps `workAuthorization.CA = yes` and `requiresSponsorship.CA = no`. A US question is therefore answered by the conservative inference (authorized: No, sponsorship required: Yes) as a visible guess; the moment the user corrects it, the answer is learned as `workAuthorization.US` and used everywhere after that.

## 3. How a default is chosen

1. An option matching a profile fact wins (that is not a guess).
2. Otherwise the **neutral option**, found in code: an explicit neutral ("Other", "None of the above", "N/A", "Prefer not to say", "Decline to self-identify") if the option set has one; else, for a yes/no question, the answer that claims the least for the applicant (for a declaration that is the conservative one, e.g. "No" to authorization the profile does not support; for a willingness question, "Yes" to relocating or starting on time, since that commits nobody to a falsehood and is what most applicants answer).
3. Free-text questions with no fact fall back to the streamed draft path (`/v1/shabang-text`) exactly as today; they are never left empty when the server is reachable.
4. Every proposal that did not come from a fact or a learned answer is marked `source: "guess"`, rendered with a dotted underline, reported in the HUD, and **never accepted by hold-Tab**: holding Tab stops at the first guess so the user sees it before Submit (which stays locked).

## 4. Learning from a correction

```ts
// shared/src/answers/signature.ts
questionSignature(field): string   // stable, value-free, site-independent
```
The signature is built from the normalized question text (lowercased, punctuation and the company name removed, "at Viam" / "at <Company>" stripped), the field kind, and a hash of the normalized option labels when there are options. The same question on another ATS produces the same signature.

A **correction** is recorded when, with learning enabled:

- the user edits a field Shabang filled (typing over ghost text, choosing a different option, unchecking a box), or
- the user answers a field Shabang left empty (the rare protected question with no decline option), or
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
- A correction always beats a guess and beats a profile fact for that signature (the user is the authority) but never overwrites the profile fact itself; the options page shows both and offers "make this a profile fact" -- **for an ordinary question only**. A protected characteristic or a legal declaration is never promoted: a profile fact is proposed at 0.95 with no guess marking (so a held accept key writes it everywhere afterwards), and a fact KEY is the one profile thing that goes on the wire. Those answers stay where they are, per question, on this machine.
- The signature strips a required MARKER ("(required)", a trailing "* ", "- required"), never the word inside the question. "Travel required?" and "Travel optional?" are opposite questions and must not hash alike, or an answer learned on one is replayed onto the other as a confident `learned`.
- Confidence for a learned answer: 0.86 after one correction, 0.94 after two or more.
- Protected and declaration answers are learned exactly like the rest, because the user typed them. They are stored locally only and never sent to any server (`/v1/predict/form` keeps receiving fact KEYS only, and learned answers are applied client-side after the server's assignments come back).
- Values that look like secrets (card, SIN/SSN, password) are never learned, as today.
- Cap 500 answers, LRU, capped at 2,000 characters each. The options page lists them with delete and "forget everything learned here".

## 5. Where it runs

The store and all rules live in `shared/src/answers/**` (pure, unit-tested) so both clients behave identically:

- **Extension**: `extension/src/content/learning.ts` records corrections (it already watches user edits); `extension/src/content/predict.ts` consults the store and the classifier before the offline heuristic and after the server's assignments. Persisted in `chrome.storage.local` under `ghost.answers`.
- **Desktop**: `desktop/core/predict.ts` and `entry.ts` gain the same calls; `GHController`/`GHWriter` report corrections; persisted in `~/Library/Application Support/Shabang/answers.json` (0600).

## 6. Telemetry and the learning loop

Every proposal and correction produces a **value-free** counter, in the shape the walk outcome telemetry already uses (`shared/src/walkTelemetry.ts`, merged; see `docs/learning-loop.md`):

```
answer.proposed   { class, source: "fact"|"learned"|"guess", accepted: bool, confidenceBucket }
answer.corrected  { class, hadGhost: bool, wasGuess: bool }
```

No label, no value, no origin. These answer the only questions that matter for the demo and for Sentry: how often a guess was right, how often one correction was enough, and whether learned answers stay accepted over time. `answer.corrected` should become an outcome the replay evals can score, so a correction improves future runs rather than being lost. Note the open question recorded in `docs/learning-loop.md`: the envelope deliberately carries no `questionSignature`, because that is derived from page text, so a correction is currently countable but not replayable by question. Resolving that is the next design step, and it must not widen what crosses the wire.

## 7. What must never happen

- Shabang never invents a protected characteristic when the form offers a way to decline: it declines.
- Shabang never proposes the flattering side of a declaration. Inferences always run toward claiming less (no authorization the profile does not support, sponsorship required rather than not).
- Shabang never sends a learned answer, a protected value or a declaration to any server, and never logs a value. Concretely, in both clients: a protected question is not in the `/v1/predict/form` body at all (label, section heading and option list included, and so not cached against the site either); a protected or declaration free-text prompt is never drafted by `/v1/shabang-text`; and such an answer never becomes a `pastAnswer`, which is the one learned thing that rides in a request. `isSensitive` guards none of this -- it knows passwords, cards and government IDs and has no protected vocabulary -- so each route carries its own check.
- A guess is always visibly a guess, never auto-accepted by hold-Tab, and always reversible before Submit, which stays locked and is never pressed by Shabang.
