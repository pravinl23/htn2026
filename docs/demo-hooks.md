# Demo site hooks, labels and test ids

Reference for e2e tests and extension work. Generated from the page builders' reports; the code in `demo/src` is the source of truth.


## Invoices, invoice view, sheet, reset

The `/invoices`, `/invoices/:id`, `/sheet` and `/reset` demo pages are built. At the 2026-09-19 audit, demo typecheck/build pass, all 74 demo unit tests pass, and the 95-check browser smoke suite passes. These pages expose the hooks below for future loop orchestration; the extension does not yet record or execute the invoice routine.

I ran an isolated headless Playwright script against a temporary dev server on port 5199, which I stopped afterwards. It confirmed:
- 50 inbox rows, with SPA navigation into an invoice.
- The reply flow, including the confirmation text and the disabled "Replied" state.
- Typing in the grid, with Enter moving down and the caret staying put on mid-string edits.
- A programmatic fill (native value setter plus `input` event) sticks.
- Live sync from another tab and from a same-origin iframe.
- Clear sheet, accepting and dismissing the `confirm()`.
- The not-found page, `/reset`, and `?reset=1`.
- No console errors.

The shared Browser pane was being navigated by other agents, which is why I used an isolated context instead.

**localStorage keys** (both prefixed `ghostdemo.`)
- `ghostdemo.invoices.replied`: JSON `string[]` of invoice ids, in the order they were replied.
- `ghostdemo.sheet.rows`: JSON `string[][]`, each row `[vendor, number, date, total]`. Trailing blank rows are not stored, so an empty sheet is `[]` or absent. Reads normalize to 60x4.
- Every cell write re-reads storage before writing, so a stale tab or iframe cannot overwrite another writer's rows.
- Same-tab updates go through the custom window event `"ghostdemo:change"` (a `CustomEvent` with `detail: { key }`). Other tabs and iframes use the native `storage` event.

**Reset behaviour**
- `?reset=1` on `/invoices`, `/invoices/:id` or `/sheet` clears only those two keys before first render, then removes the flag from the URL with `history.replaceState`. `?reset` and `?reset=true` also work; `?reset=0` and `?reset=false` do not.
- `/reset` clears every `ghostdemo.*` key and shows `<p role="status" data-testid="reset-done" data-remaining="0">`, plus links to `/invoices`, `/sheet`, `/mail`, `/calendar` and `/`.
- Playwright's `page.url()` can still show the flag right after `goto`; `location.href` is correct.

**Window test hooks**
- These are getters computed from localStorage on each read, so they are never stale. They are installed on `/invoices`, `/invoices/:id`, `/sheet` and `/reset`.
- `window.__invoices = { total: 50, replied: string[], logged: string[] }`. Both arrays are in inbox order. An invoice counts as logged when its number appears in the sheet's "Invoice #" column, trimmed and case-insensitive.
- `window.__sheet = { rows: string[][], filled: number }`, where `rows` holds only the non-empty rows, top to bottom.

**Data** (`demo/src/data/invoices.ts`)
- `INVOICES` is 50 invoices from a seeded PRNG (`INVOICE_SEED = 20261026`), ids `INV-1001` to `INV-1050`, with `number === id`.
- All 20 invented vendors appear and none repeats back to back.
- Every total is unique, and `total = subtotal + tax` with `tax > 0`, so subtotal always differs from total.
- Inbox order is id ascending, which is also newest first (`INV-1001` is dated 2026-09-17).
- `INV-1001` is Thistledown Textiles, Sep 17, 2026, $3,712.06. `INV-1007` is Brightwave Supply.
- Exports, by group:
  - Data and lookup: `INVOICES`, `VENDOR_NAMES`, `INVOICE_COUNT`, `INVOICE_SEED`, `generateInvoices(seed?, count?)`, `mulberry32`, `findInvoice(id)`.
  - Display: `displayFields(inv)` (keys `vendor`, `number`, `date`, `due`, `description`, `subtotal`, `tax-rate`, `tax`, `total`), plus `expectedSheetRow(inv)`, which returns `[vendor, number, "Sep 17, 2026", "$3,712.06"]`. That is what e2e should assert for a correct row.
  - Formatters: `formatMoney(cents)`, `formatDate(iso)`, `formatDateTime`, `formatRate`, `addDays`.

**/invoices labels and test ids**
- The list is `<ul role="list" aria-label="Invoice emails" data-testid="invoice-list">`.
- Each `<li>` has `data-testid="invoice-row"`, `data-invoice-id="INV-1007"`, `data-replied="true|false"` and `data-logged="true|false"`, plus classes `replied` and `logged` when set.
- Each `<li>` contains exactly one `<Link href="/invoices/INV-1007">`. Its accessible name is exactly the subject, e.g. "Invoice INV-1007 from Brightwave Supply", via `aria-labelledby`. Vendor, preview, total, date and chips are attached with `aria-describedby`.
- Chips are `<span data-chip="logged">Logged</span>` and `<span data-chip="replied">Replied</span>`.
- Counts are `data-testid="replied-count"` ("12 of 50 replied") and `data-testid="logged-count"` ("3 of 50 logged").
- There is one link named "Open spreadsheet" to `/sheet`. The header brand link is named "Ledgerbox Mail home".

**/invoices/:id labels and test ids**
- One link "Back to inbox" to `/invoices`.
- The subject is `<h1 id="email-subject">`.
- The email header is a `<dl>` with From, To and Received; Received includes a time, so its text never equals the invoice date.
- The fields are `<dl data-testid="invoice-fields">`, with `data-field` on each `<dd>`:

| `dt` label | `data-field` |
|---|---|
| Vendor | `vendor` |
| Invoice number | `number` |
| Invoice date | `date` |
| Due date | `due` |
| Description | `description` |
| Subtotal | `subtotal` |
| Tax rate | `tax-rate` |
| Tax | `tax` |
| Total | `total` |

- The reply button is `<button type="button" data-testid="reply-received" data-ghost-lock>`, accessible name exactly "Reply: received".
  - I added `data-ghost-lock` because `shared/src/locks.ts` would not lock that text by regex.
  - Once replied it is `disabled` and reads "Replied".
  - Nothing is sent anywhere.
- The confirmation is `<p role="status" data-testid="reply-confirmation">` with "Reply sent: Received, thanks." It also shows on a revisit if already replied.
- One link "Open spreadsheet" to `/sheet`.
- The `<article>` carries `data-invoice-id`, `data-replied` and `data-logged`.
- An unknown id renders `data-testid="invoice-not-found"` ("Invoice not found") and keeps "Back to inbox".

**/sheet labels and test ids**
- The grid is `<table aria-label="Invoice log" data-testid="sheet-grid">`.
- The single header row is `th[scope=col]`: a visually hidden "Row", then "Vendor", "Invoice #", "Date", "Total".
- There are 60 `<tr data-row="0".."59">`, each with a `<th scope="row">` showing the 1-based row number.
- Each cell is `<input type="text" id="cell-{row}-{col}" aria-label="Vendor row 1">`. The label is 1-based, e.g. "Invoice # row 2", "Date row 3", "Total row 60".
- Each cell also has `data-row="0".."59"` and `data-col="0".."3"` (both zero-based), `data-col-header="Vendor"`, `autocomplete="off"`, and is controlled.
- Enter or ArrowDown moves down, Shift+Enter or ArrowUp moves up, and Tab is left native.
- Toolbar (`role="toolbar"`, `aria-label="Sheet actions"`):
  - A link "Back to invoices" to `/invoices`.
  - `<p data-testid="sheet-filled" data-filled="3">` reading "3 of 60 rows filled".
  - `<button type="button" data-testid="clear-sheet" data-ghost-lock>` named "Clear sheet", styled as a danger action, which asks `window.confirm()`.
- The header brand link is named "Ledgerbox Sheets home".

Absolute paths are in `files`.

### Hooks

- `window.__invoices = { total: 50, replied: string[], logged: string[] }`
- `window.__sheet = { rows: string[][] (non-empty rows only), filled: number }`
- Both are getters over localStorage, installed on `/invoices`, `/invoices/:id`, `/sheet` and `/reset`.
- localStorage keys: `ghostdemo.invoices.replied` (`string[]`) and `ghostdemo.sheet.rows` (`string[][]`, trailing blank rows trimmed).
- Same-tab change event on `window`: `"ghostdemo:change"`, a `CustomEvent` with `detail: { key }`. Other tabs and iframes get the native `storage` event.
- `?reset=1` clears those two keys before first render and removes the flag from the URL. `/reset` clears every `ghostdemo.*` key.


## Mail and calendar

The mail and calendar demo is built: inbox → message → "Open calendar" → pick Thursday 2:30 PM → "Back to mail" → the picked-time chip shows above the reply box, and "Send reply" is the locked action. The 2026-09-19 smoke audit covers reset, cross-tab storage, native-setter textarea writes, sending the fictional local reply, console errors and 375px layouts. Shabang does not yet choose the slot, navigate back or draft the reply itself.

**Pages**
- `/mail` lists 8 fictional emails, ids `msg-1001` to `msg-1008`, all from `@example.com` senders. `msg-1001` is from Priya Nair with subject "Quick chat Thursday afternoon?". No subject contains a word Shabang's lock rules treat as irreversible, so opening an email never looks locked.
- `/mail/:id` shows the message and the reply composer. An unknown id renders `data-testid="mail-missing"`.
- `/calendar` renders "Week of Sep 21, 2026", Monday to Friday, 9 AM to 5 PM in 30 minute rows, with 17 free slots in total. Thursday has two free slots: 10:30 AM in the morning and 2:30 PM, the only one in the afternoon. The table uses no rowspans, so every cell's column index matches its day header.

**localStorage keys** (prefix `ghostdemo.mail.`)
- `ghostdemo.mail.pickedSlot` holds `{"day":"Thursday","start":"14:30","end":"15:00","label":"Thursday 2:30 PM to 3:00 PM"}`. On read it is validated and the label is rebuilt from day and times.
- `ghostdemo.mail.sentReplies` holds `Record<messageId, replyText>` as JSON.
- `ghostdemo.mail.lastOpenedId` holds a plain string such as `msg-1001`, set when a message view mounts.
- Same-document writes fire a `CustomEvent` named `"ghostdemo:change"` with `detail: { key }`. That is the same event name the other agent's `data/storage.ts` uses, but I did not import that file. Other tabs and iframes are reached through the native `"storage"` event.
- `?reset=1` on `/mail`, `/mail/:id` or `/calendar` clears only these three keys during the first render. It fires no same-document events, and the query string stays in the URL. `?reset=true` and a bare `?reset` also reset; `?reset=0` and `?reset=false` do not.

**Window test hooks** (declared in `mailStorage.ts`, because `global.d.ts` is not my file)
- `window.__mail = { pickedSlot: PickedSlot | null, sentReplies: Record<string,string>, lastOpenedId: string | null }`. It is refreshed immediately on every change, including changes from other tabs.
- `window.__mailSent: boolean` is false on mount and true once "Send reply" ran. It is also true when the open message already has a stored reply.
- `window.__formState = { reply }` on the message view.

**Labels and test ids on `/mail`**
- Inbox rows are `<a data-testid="mail-row" data-mail-id="msg-1001" href="/mail/msg-1001">`. The accessible name is exactly the subject (set with `aria-label`), and `aria-describedby` carries sender, date and preview. After a reply the row gets `data-replied="true"` and a visible "Replied" badge.
- `data-testid="mail-count"` reads e.g. "8 messages, 2 unread". The list is `ul[aria-label="Inbox messages"]`. The header brand link is named "Larkspur Mail".

**Labels and test ids on `/mail/:id`**
- There are two links: "Back to inbox" (to `/mail`) and "Open calendar" (to `/calendar`).
- The subject is `h1#mail-subject[data-field="subject"]`. The headers are a `<dl>` with `dd[data-field="from"|"to"|"date"]`. The body is `div[data-field="body"]` and contains "Can we meet Thursday afternoon (Sep 24) for 30 minutes?".
- The chip is `p[data-field="picked-slot"]` reading "Picked time: Thursday 2:30 PM to 3:00 PM". It renders only after a pick.
- The composer is `<label for="reply">Reply</label>` plus `textarea#reply[name="reply"]`, a React controlled input. The heading "Reply to Priya Nair" is deliberately not wired to the section with `aria-labelledby`, so `getByLabel("Reply")` matches one element.
- The send control is `<button type="button" data-testid="send-reply">Send reply</button>`.
  - An empty reply shows `#reply-error[role="alert"]` reading "Write a reply before sending.", and nothing is stored.
  - A valid send stores the text and sets `__mailSent = true`.
  - It then replaces the composer with `section[data-testid="mail-sent"][role="status"]`, which contains `pre[data-testid="mail-sent-text"]`.

**Labels and test ids on `/calendar`**
- The heading is `h1[data-field="week"]` reading "Week of Sep 21, 2026". The grid is `table[data-testid="calendar-week"]` with column headers like "Thursday Sep 24" and row headers like "2:30 PM". An "Inbox" link goes to `/mail`.
- Each free slot is `<button type="button" data-testid="cal-slot" data-day="Thursday" data-start="14:30" data-end="15:00" aria-pressed="false" aria-label="Thursday 2:30 PM to 3:00 PM, free">`. After a pick it has `aria-pressed="true"` and `data-picked="true"`, and the accessible name does not change. Busy blocks are plain `<td class="cal-busy …">`, not buttons.
- After a pick, `div[data-testid="calendar-status"][role="status"]` contains `div[data-testid="calendar-banner"]`. That holds `strong[data-field="picked-slot"]` ("Thursday 2:30 PM to 3:00 PM") and a "Back to mail" link.
- "Back to mail" goes to `/mail/<lastOpenedId>`, or to `/mail` when nothing was opened or the id is unknown. The banner is sticky so the link stays in view.

**Things other agents should know**
- `main.tsx` imports `App` before `styles.css`, so page CSS loads first and the global sheet wins ties in specificity. My selectors are deliberately more specific where that matters, such as `.mail-page .mail-reply > h2`.
- If the extension derives page facts from `[data-field]`, note that `picked-slot` appears on both `/calendar` (the label only) and `/mail/:id` (with the "Picked time: " prefix).

### Hooks

window.__mail = { pickedSlot: { day, start, end, label } | null, sentReplies: Record<string,string>, lastOpenedId: string | null }; window.__mailSent: boolean; window.__formState = { reply: string } on /mail/:id. localStorage keys: ghostdemo.mail.pickedSlot (JSON {day:"Thursday",start:"14:30",end:"15:00",label:"Thursday 2:30 PM to 3:00 PM"}), ghostdemo.mail.sentReplies (JSON Record<messageId,text>), ghostdemo.mail.lastOpenedId (plain string, e.g. msg-1001). Same-document change event: CustomEvent "ghostdemo:change" with detail { key }; other tabs and iframes via the native "storage" event. "?reset=1" on /mail, /mail/:id or /calendar clears these three keys before first render.


## Browser verification

The demo pages work in a real browser without the extension. At the 2026-09-19 audit, `e2e/scripts/smoke-demo.mjs` passed 95 checks against the production preview on :5173 with no console errors, warnings, page errors or failed requests. The script expects a demo server to be running; start `pnpm --filter @shabang/demo preview` first.

Run it with `pnpm --filter @shabang/demo build && pnpm --filter @shabang/demo preview`, then `node e2e/scripts/smoke-demo.mjs`. Setting `BASE_URL=http://localhost:<port>` points it at a dev server instead. It runs headless and exits 1 on the first failed check. It writes 24 full-page PNGs to `e2e/test-results/smoke/` (gitignored; a Playwright test run wipes that folder).

**What the script covers**
- **Reset:** `/reset` leaves no `ghostdemo.*` keys (`data-remaining="0"`).
- **Invoices walk:**
  - The inbox lists 50 rows. Opening INV-1001 is a client-side navigation, and browser Back and Forward do not reload the document.
  - The four `data-field` values (vendor, number, date, total) are typed into sheet row 1 with real keystrokes; Tab moves right and Enter moves down.
  - After "Reply: received", the confirmation shows and the button is disabled and reads "Replied".
  - The inbox then shows the Logged and Replied chips, with "1 of 50 replied" and "1 of 50 logged".
  - `window.__sheet` and `window.__invoices` hold exactly that row and that id.
- **Storage sync:** a cell typed in page A appears in page B and the reverse, without either overwriting the other. An inbox open in page B marks INV-1003 logged while page A types "inv-1003 ".
- **Sheet edge cases:**
  - The sheet survives a reload, and the caret stays put on a mid-string edit.
  - A native value setter plus an `input` event sticks in the controlled input and reaches storage.
  - Dismissing the "Clear sheet" confirm keeps the rows; accepting it clears the sheet but keeps the replies.
  - `?reset=1` clears both keys and is dropped from the URL.
- **Mail walk:**
  - 8 messages; opening msg-1001 is a client-side navigation.
  - A slot picked in another tab shows up live, both as the chip on the message and as the pressed slot on the calendar.
  - The calendar has exactly one free Thursday afternoon slot (14:30). After picking Thursday 2:30 PM it is the only pressed slot, and "Back to mail" shows the chip "Picked time: Thursday 2:30 PM to 3:00 PM".
  - An empty send is rejected with the alert. A typed reply and a programmatic fill both reach `__formState`.
  - "Send reply" produces `data-testid="mail-sent"` with the trimmed text, `__mailSent` is true, `__mail.sentReplies` holds the text, and the inbox row gets `data-replied="true"`.
- **Gallery:** `/`, `/apply` as the reference, both not-found pages, and six pages at 375px with no horizontal page scroll.

**Bugs fixed** (all found by reading the screenshots)
- **Sender names cut off on `/mail`.** They were cut mid-word with no ellipsis ("Campus Robotics Clu", "Harbourlight Hackath"), because `text-overflow` does nothing on bare text inside a flex container. I wrapped the name in a `.mail-row-name` span with its own ellipsis and widened the sender column from 172px to 204px so all eight names fit. The link's accessible name is unchanged.
- **Broken stripe on `/calendar` busy blocks.** The coloured left stripe had a 1px break at every half-hour row, because it was an inset box-shadow, which does not paint under the transparent row border. It is now part of the cell background (a linear-gradient) and is continuous.
- **Crowded Larkspur header on phones.** At 375px the account email crowded the brand and wrapped "Larkspur Calendar" onto two lines. The email is now hidden at 640px and below, as Ledgerbox already does.
- **"Message not found" heading too large.** The card used the large page-level h1 and had extra bottom padding. Every mail card's h1 now shares the message-subject size, and the card's last paragraph has no bottom margin.
- **Washed-out picked slot in one screenshot.** This was a screenshot taken mid-transition, not a page bug; the settled state is solid accent with white text. The script now waits 250ms before each PNG.

Apart from those points the pages looked consistent with `/apply` (same header, card, eyebrow and heading style, teal accent, grey page, footer), so I changed nothing else visually.

**Contract for e2e and the extension**
My edits do not change any of the localStorage keys, window hooks, labels or test ids the page agents reported. The smoke run re-checked these:
- **Keys:**
  - `ghostdemo.invoices.replied` (`string[]`)
  - `ghostdemo.sheet.rows` (`string[][]`)
  - `ghostdemo.mail.pickedSlot` (`{day,start,end,label}`)
  - `ghostdemo.mail.sentReplies` (`Record<id,text>`)
  - `ghostdemo.mail.lastOpenedId` (plain string)
- **Change events:** same-document changes use the `CustomEvent` `"ghostdemo:change"` with `detail: { key }`; other tabs use the native `storage` event.
- **Hooks:**
  - `window.__invoices = { total: 50, replied: string[], logged: string[] }`
  - `window.__sheet = { rows: string[][] (non-empty rows only), filled: number }`
  - `window.__mail = { pickedSlot, sentReplies, lastOpenedId }`
  - `window.__mailSent: boolean`
  - `window.__formState = { reply }`
- **Invoices and sheet:**
  - test ids `invoice-list`, `invoice-row` (with `data-invoice-id`, `data-replied`, `data-logged`), `replied-count`, `logged-count`, `invoice-fields`, `reply-received`, `reply-confirmation`, `sheet-grid`, `sheet-filled`, `clear-sheet`
  - `[data-chip="logged"]` and `[data-chip="replied"]`; invoice fields are `dd[data-field="vendor|number|date|total"]`
  - "Reply: received" and "Clear sheet" carry `data-ghost-lock`
  - links "Open spreadsheet", "Back to invoices", "Back to inbox"
  - cells labelled "Vendor row 1", "Invoice # row 1", "Date row 1", "Total row 1", with ids `cell-{row}-{col}` (zero-based)
- **Mail and calendar:**
  - test ids `mail-row` (with `data-mail-id`), `mail-count`, `send-reply`, `mail-sent`, `mail-sent-text`, `mail-missing`, `calendar-week`, `calendar-status`, `calendar-banner`, and `cal-slot` (with `data-day`, `data-start`, `data-end`)
  - slot name "Thursday 2:30 PM to 3:00 PM, free"
  - links "Open calendar" and "Back to mail"; `<label>Reply</label>` for `textarea#reply`; button "Send reply"
  - `[data-field="picked-slot"]` (on both `/calendar` and `/mail/:id`), `#reply-error`

One new class: `.mail-row-name`. Expected sheet row for INV-1001: `["Thistledown Textiles","INV-1001","Sep 17, 2026","$3,712.06"]`.

### Hooks

My edits do not change any hook, key or test id the page agents reported; I re-checked these in the browser.
- `window.__invoices = { total: 50, replied: string[], logged: string[] }` and `window.__sheet = { rows: string[][] (non-empty rows only), filled: number }`. Both are getters over localStorage, installed on `/invoices`, `/invoices/:id`, `/sheet` and `/reset`.
- `window.__mail = { pickedSlot: { day, start, end, label } | null, sentReplies: Record<string,string>, lastOpenedId: string | null }`.
- `window.__mailSent: boolean` and `window.__formState = { reply: string }`, both on `/mail/:id`.
- localStorage keys:
  - `ghostdemo.invoices.replied` (JSON `string[]`)
  - `ghostdemo.sheet.rows` (JSON `string[][]`, trailing blank rows trimmed)
  - `ghostdemo.mail.pickedSlot` (JSON `{day:"Thursday",start:"14:30",end:"15:00",label:"Thursday 2:30 PM to 3:00 PM"}`)
  - `ghostdemo.mail.sentReplies` (JSON `Record<messageId,text>`)
  - `ghostdemo.mail.lastOpenedId` (plain string)
- Same-document change event on `window`: `CustomEvent` `"ghostdemo:change"` with `detail: { key }`. Other tabs and iframes get the native `storage` event, which I verified live in both directions for the sheet, the inbox logged state, and the picked slot.
- `?reset=1` on `/invoices`, `/invoices/:id` and `/sheet` clears the two invoices and sheet keys and removes the flag from the URL. On `/mail`, `/mail/:id` and `/calendar` it clears the three mail keys and leaves the flag in the URL. `/reset` clears every `ghostdemo.*` key and renders `[data-testid="reset-done"][data-remaining="0"]`.
- The smoke script sets its own throwaway marker `window.__smokeSpa` to prove that navigation stays in one document.
