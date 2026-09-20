# Where Shabang's brain lives, and how small it stays

Binding design. Everything Shabang learns about a person stays on that person's computer, in one small file. No account, no sync service, no upload. The budget below is deliberate: a brain you can read in a text editor, delete in one click, and carry in a backup without thinking about it.

## 1. One canonical file

```
~/Library/Application Support/Ghost/graph.json      mode 0600, atomic writes, versioned
```

It holds four sections, and nothing else:

| Section | What it is | Cap | Typical size |
| --- | --- | --- | --- |
| `facts` | The fact graph (`docs/profile-sources.md`): key, value, label, aliases, category, confidence, provenance kind, updatedAt | 500 facts, 2 KB each | 40 to 100 KB |
| `answers` | Learned answers to questions (`docs/answers.md`): signature, value, count, class | 500 entries | 40 to 75 KB |
| `habits` | Role-keyed priors and aggregates (`docs/anywhere.md`, `docs/cold-start.md`): counters only, no URLs, no timestamps beyond buckets | 300 origins / 2,000 counters | 10 to 30 KB |
| `meta` | Schema version, source list with their last scan time, counts of what was skipped as sensitive | fixed | under 2 KB |

**Target: under 200 KB. Hard cap: 1 MB**, enforced on every write. Past the cap, pruning runs before the write and the file never grows beyond it.

## 2. How it stays small

- **Counters, not histories.** A habit is `(pageKind, previousRole, role) -> {accepted, dismissed, replaced, lastSeenBucket}`. There is no event log, so the file does not grow with use.
- **Evidence is optional and short.** An evidence snippet (80 characters, for the review UI) is kept only until the user accepts the fact, then dropped. Rejected proposals keep a hash, not the text, so they are not re-proposed.
- **No raw source material, ever.** No file contents, no page text, no message bodies, no URLs. The scan deletes its working copies as soon as aggregates are computed.
- **Pruning policy, in order:** drop rejected-proposal hashes older than 90 days; drop habits whose total count is 1 and that have not been seen in 30 days; LRU-evict the least recently used facts and answers that the user never verified; never evict anything the user typed or confirmed (`verifiedByUser`), which is the only class that is protected.
- **Compaction on write:** stable key order, no whitespace, numbers rounded to three decimals, timestamps as day-resolution strings. A rewrite happens at most once per 10 seconds; changes in between are coalesced.

## 3. Two clients, one brain

The native agent owns the file. The extension cannot read `~/Library`, so it mirrors what it needs through the local server on 127.0.0.1:

- `GET /v1/graph` returns the graph (localhost only, same access rules as every other route: it never leaves the machine).
- `PATCH /v1/graph` applies a small change set (a learned answer, a correction, an accepted proposal) with last-write-wins per key and a monotonic counter to detect a stale writer.
- The extension keeps a copy in `chrome.storage.local` under `ghost.graph` for offline work and reconciles on the next successful call. When the server is not running, the extension works from its copy and syncs later.

If the user never installs the native app, the extension's copy is the brain, with the same caps.

## 4. Visible and removable

The options page and the menu bar both show the current size, the number of facts, answers and habits, and what each source contributed. Two buttons that must always work: **Forget this source** (removes exactly what it produced) and **Delete everything** (removes the file and the extension copy, and stops any watcher). Deleting is instant and needs no confirmation beyond the click, because a brain the user cannot delete is not one they will trust.
