# Cold start: build the knowledge graph from the machine you already own

Binding design. A brand-new Shabang knows nothing, so its first hour is its worst hour. But the answers are already on the computer: the user's own contact card, their résumé, the sites they open every morning, the addresses in their order confirmations, the people they mail. **Cold start** is the one-time (and then incremental) pass that turns that into the fact graph from `docs/profile-sources.md` and the habit priors from `docs/anywhere.md`, entirely locally.

The product promise: install Shabang, click **Scan my Mac**, review what it found, and from that moment Tab is useful on any form and any page.

## 1. Non-negotiable stance

- **Local only.** Nothing scanned leaves the machine. No file content, no snippet, no URL is uploaded. The prediction server keeps receiving fact KEYS only. If a model is used for extraction it is the LOCAL server calling the user's own configured provider, one small document at a time, and never for anything classified sensitive.
- **Opt in per source, not one blanket yes.** The scan panel lists each source with what it would read, an estimated item count, and its own switch. Nothing is read until a source is switched on and **Scan** is pressed.
- **Proposals, never silent writes.** Every fact and habit lands in a review list with its evidence and origin. The graph changes only on **Save**.
- **Excluded by default and never stored:** credentials and key files (`.env`, `.pem`, `id_rsa`, keychains, password managers), financial documents (statements, tax returns, card numbers), health records, government IDs, anything in a folder the user marked private, and message *bodies* (only signature blocks are parsed, never conversations).
- **Forgettable.** One click per source removes every fact and habit it produced; one click clears everything and stops the watcher.

## 2. What it reads, cheapest and most precise first

| Tier | Source | Yield | Cost / permission |
| --- | --- | --- | --- |
| 0 | **Spotlight metadata** (`mdfind`, `mdls`): file names, kinds, dates, authors. No content. | Which sources are worth opening at all, plus counts for the consent panel | Instant, no permission |
| 1 | **The user's own contact card** (Contacts "me" card) | Name, emails, phones, addresses, employer, job title: the highest-precision facts on the machine, with no model involved | macOS Contacts permission, prompted once |
| 2 | **Résumé / CV documents** found by Spotlight (`kMDItemContentType` pdf/docx whose name or content mentions résumé, CV, cover letter) | Education, work history, links, skills | Folder access; text extracted with `textutil`/`mdimport` output, then the existing extractor |
| 3 | **Browser history and bookmarks** (Chrome/Arc/Brave profiles under Application Support; Safari needs Full Disk Access) | **Habit priors**: which sites, in what order, at what hours; the top actions per site kind; the accounts the user actually uses | Read-only copy of the SQLite file; Safari only if the user grants FDA |
| 4 | **Calendar** (EventKit) | Employer, colleagues, working hours, timezone, recurring commitments | Calendar permission, prompted |
| 5 | **Mail signature blocks** (the user's own sent messages, header + last 10 lines only) and **order-confirmation addresses** | Work title, employer, phone, shipping addresses the user really uses | Mail/connector permission; bodies are never stored, only the extracted fields |
| 6 | **Local project folders** (git remotes, `package.json` author fields) | GitHub login, personal site, org membership | Folder access, file reads of a few small files |

Tiers 0 to 3 give most of the value without any model call. Tiers 4 to 6 are opt-in extras.

## 3. Two graphs come out of it

1. **Fact graph** (`docs/profile-sources.md`): who the user is. Feeds form filling and the answer engine.
2. **Habit priors** (`docs/anywhere.md`, role-keyed memory): what the user does. Derived only from *aggregates*, never raw history: per site kind and per origin, the actions taken and their order, time-of-day buckets, and the transitions between origins ("mail then calendar in the morning"). Stored as counts, not as a list of visited URLs; the raw history copy is deleted the moment the aggregate is computed.

The habit priors are what make the first Tab on YouTube or Amazon right instead of generic: the affordance priors say "on a video page, fullscreen is likely", and the habits say "this user always does".

## 4. How it runs

- Native agent, because it is the part with file access. `ghostctl scan --dry-run` prints the consent panel's contents (counts per source, nothing read); `ghostctl scan --sources contacts,resume,history` performs it; the menu bar shows progress and a Review button. Extraction runs off the main thread with a wall-clock budget (default 60 s) and a hard cap on files opened per source.
- **Incremental after that:** a small watcher re-scans only what changed (Spotlight query by modification date, the browser history since the last high-water mark), at most once an hour, and adds proposals to the review list instead of applying them.
- **Degrade honestly:** any source whose permission is missing is listed as "needs permission: <what to click>", never silently skipped. The scan works with zero permissions granted using only what is already accessible, and says how much better it would be with each one.

## 5. Sensitivity classification, before anything is stored

Every extracted candidate passes `shared/src/sensitive.ts` plus value-shape checks (card numbers via Luhn, SSN/SIN shapes, IBAN, key material, medical vocabulary). A sensitive candidate is dropped, counted, and reported as "N items skipped as sensitive" so the user can see the filter working. Sensitive facts can only ever enter the graph by the user typing them into a form themselves.

## 6. What the user sees

1. First run: "Shabang works better when it knows you. Everything stays on this Mac." with the per-source list, counts from Spotlight, and estimated time.
2. Progress with a live count and a Cancel.
3. Review: facts grouped by category with evidence; habits summarized in plain language ("You open mail, then calendar, most weekday mornings"); "Skipped 23 items as sensitive".
4. Save. From then on, form filling and next-action ghosts use it, and every correction refines it (`docs/answers.md`).
