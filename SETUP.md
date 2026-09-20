# Setting Shabang up on a new Mac

Start to finish, roughly 10 minutes. Every trap in here is one somebody actually hit, not a
precaution — if a step looks paranoid, it is because skipping it cost an hour.

Read this top to bottom the first time. The **Troubleshooting** table at the end is what to come
back to.

---

## 0. What you need first

| Thing | Why | Check |
| --- | --- | --- |
| macOS (Apple Silicon or Intel) | the agent is a native macOS app | — |
| **Node 22**, not 23 | `@sentry/profiling-node` ships prebuilt binaries for even-numbered LTS only. On 23 profiling silently reports **off** and you lose a Sentry product without any error | `node -v` → `v22.x` |
| pnpm | the repo is a pnpm workspace | `pnpm -v` |
| Xcode Command Line Tools | `clang`, `codesign`, `iconutil` | `xcode-select -p` |

```bash
brew install node@22 pnpm
xcode-select --install     # no-op if already there
```

If `node -v` says 23 or higher, put 22 first on PATH **in the shell you start the server from**:

```bash
export PATH="$(brew --prefix node@22)/bin:$PATH"
```

---

## 1. Get the code

```bash
git clone https://github.com/pravinl23/htn2026.git
cd htn2026
```

## 2. Keys

The server needs `.env` at the repo root. **It is gitignored and must never be committed** — ask a
teammate for it and copy it across by hand.

```bash
cp /path/from/teammate/.env .env
chmod 600 .env
```

`.env.example` lists every variable. The only two that matter for the demo:

- `TYPESAFE_API_KEY` — Jev, which maps form fields
- `BASETEN_API_KEY` — GLM-5.3-Flash, which writes the text (iMessage replies, "why this company")

Without them the server still starts and still works, but falls back to `heuristic` + `template`:
no model, canned text. That looks like "the AI stopped working" and is only a missing file.

> **Working in a git worktree?** A new worktree does **not** inherit `.env` or `node_modules`.
> Symlink the env file: `ln -s /path/to/htn2026/.env .env`

## 3. Install

```bash
pnpm install
```

Run this at the **repo root**. Nothing builds until it has: the desktop core is esbuild bundling
`shared/src`, so without it you get `Error: esbuild not found` from `make`.

## 4. Start the server

```bash
export PATH="$(brew --prefix node@22)/bin:$PATH"   # Node 22, see above
pnpm --filter @shabang/server dev
```

Leave it running. It hot-reloads on edits under `server/src`.

**Verify it is actually wired up** — this is the single most useful check in this document:

```bash
curl -s localhost:8787/v1/health
```

```json
{"ok":true,"provider":"typesafe","calibrated":true,"textProvider":"baseten","model":"jev-latest","textModel":"zai-org/GLM-5.3-Flash"}
```

- `"provider":"typesafe"` → Jev is live. `"heuristic"` means **no keys loaded** (see step 2).
- `"textProvider":"baseten"` → text generation is live. `"template"` means no keys.

The startup line should also say `sentry on ... profiling=on`. If it says `profiling=off`, you are
on Node 23 — go back to step 0.

The demo pages (used for safe testing, never a real site) run separately:

```bash
pnpm --filter @shabang/demo dev      # http://localhost:5173
```

## 5. Remove old builds first

If this Mac has ever run an older build — or the old "Ghost"-era app — clear it out **before**
building. A stale agent holds a machine-wide lock and will answer your commands instead of the build
you are testing.

```bash
# stop anything already running
pkill -f "Shabang.app/Contents/MacOS/Shabang"
pkill -f "Ghost.app/Contents/MacOS/Ghost"

# delete stale bundles (build output — always regenerable)
find ~/Projects -maxdepth 6 \( -name "Ghost.app" -o -name "Shabang.app" \) 2>/dev/null
# then rm -rf each one that is not the checkout you are about to build

# clear any stale permission entries (see step 7 for why this matters)
tccutil reset Accessibility dev.shabang.desktop
tccutil reset Accessibility dev.ghost.desktop
```

Afterwards, remove leftover **Ghost** rows from System Settings → Privacy & Security →
Accessibility with the `−` button. They point at bundles that no longer exist.

## 6. Build the app

```bash
cd desktop
make test          # 454 tests, 0 failed — do this first, it catches a broken checkout early
make app           # builds Shabang.app + the dev library
make install-lib   # installs the RELEASE library where the app looks for it
```

**`make install-lib` is not optional.** There are two libraries and picking the wrong one means
testing stale code:

| Library | Built by | Used by | Has the test harness? |
| --- | --- | --- | --- |
| `desktop/build/libshabang.dylib` | `make app` / `make lib` | `shabangctl run` (via `SHABANG_LIB`) | yes |
| `~/Library/Application Support/Shabang/libshabang.dylib` | `make install-lib` | double-clicking `Shabang.app` | no |

`make app` does **not** update the release one. Run both, every time.

> **Never run `make host-force`.** The host app is built and ad-hoc signed once. Rebuilding it
> changes its code signature, which invalidates the Accessibility grant — the agent then silently
> sees nothing and you have to grant it again. `make app` deliberately leaves the host alone once it
> exists; that is the whole reason the code is split into a host and a library.

## 7. Grant Accessibility — the step that fights back

Shabang reads the accessibility tree of whatever app is frontmost. Without this permission it
launches fine, shows its menu bar icon, and **sees absolutely nothing**.

Start it in a way that makes macOS *register* it:

```bash
cd desktop
open -n -g --env SHABANG_LIB="$PWD/build/libshabang.dylib" "$PWD/build/Shabang.app"
```

macOS shows a permission dialog and adds **Shabang** to the list. Open
**System Settings → Privacy & Security → Accessibility** and switch it **on**.

> **Why not `shabangctl run`?** That launches with `SHABANG_NO_PROMPT=1`, which suppresses the call
> that asks macOS to prompt — and that same call is what puts the app in the list in the first
> place. Use the `open` command above for the *first* launch on a machine; `shabangctl run` is fine
> forever after.

Check it took:

```bash
./tools/shabangctl trust      # {"trusted": true}
```

### If the toggle is ON but `trusted` is still false

This is the confusing one, and it is normal for an ad-hoc signed app. macOS keys the permission to
the app's **code signature**, not its name or path. Rebuild the app after granting it and the
toggle still shows on while the recorded signature no longer matches the binary — so it is on, and
it does not work.

```bash
./tools/shabangctl quit
tccutil reset Accessibility dev.shabang.desktop
open -n -g --env SHABANG_LIB="$PWD/build/libshabang.dylib" "$PWD/build/Shabang.app"
# toggle it on again in System Settings
./tools/shabangctl trust
```

Rule of thumb: **grant it last**, after the final `make app`. If you rebuild the app, expect to
redo this.

## 8. Verify the whole thing works

Read-only, sends no keystrokes, presses nothing:

```bash
cd desktop
./tools/shabangctl trust                       # {"trusted": true}
./tools/shabangctl next --frontmost "Messages" # what it would propose right now
./tools/shabangctl log 40                      # what it has been doing
```

A healthy `next` looks like:

```
pageKind: app   fields: 21
top: primary-item 0.655 "<a conversation row>"
```

The single most useful line in the log says what each ghost **is**:

```
controller: rescan fields=81 ghosts=2 [select/offline click/offline/locked] source=offline
```

### Prove the two model paths end to end

```bash
# Jev — maps form fields
curl -s localhost:8787/v1/health | grep -o '"provider":"[a-z]*"'

# Baseten — writes text
curl -s -X POST localhost:8787/v1/shabang-text -H 'content-type: application/json' \
  -d '{"fieldLabel":"Message","maxChars":120,
       "conversation":{"correspondent":"T","messages":[{"from":"T","text":"can you bring the hdmi adapter tmrw"}]}}' \
  | grep '"done"'
```

You should get a real reply back, something like `"yeah ill bring it"`. If this 404s, see the
routes row in Troubleshooting.

### The best live demo

Open Messages on a conversation. The log should read:

```
controller: conversation of 4 messages (51 nodes) in the compose column
server: /v1/shabang-text started label=Message
controller: draft ready label=Message chars=61 provider=baseten
```

Then press the accept key — **right ⌘** by default — and the reply lands in the compose box.
Nothing is ever sent: send is a locked action.

---

## Day-to-day commands

```bash
cd desktop
./tools/shabangctl run          # start the agent
./tools/shabangctl quit         # stop every Shabang process
./tools/shabangctl log 40       # tail the log
./tools/shabangctl next --frontmost "Spotify"     # what it would propose (read-only)
./tools/shabangctl dump --frontmost "Messages"    # captured fields (labels, never values)
./tools/shabangctl accept --frontmost "Spotify"   # TAKE the ghost — this one actually presses
```

After changing any code under `desktop/` or `shared/`:

```bash
make app && make install-lib && ./tools/shabangctl quit && ./tools/shabangctl run
```

---

## Where things live

| Path | What |
| --- | --- |
| `~/Library/Application Support/Shabang/` | profile, settings, role memory, form cache, the release library |
| `~/Library/Logs/Shabang/desktop.log` | the log `shabangctl log` tails |
| `desktop/build/Shabang.app` | the app (carries the Accessibility grant) |

`profile.json` is seeded automatically on first run with the **fictional** demo profile
("Alex Chen"). No real personal data is in the repo, and none should be added. To point it at a
resume for upload testing, edit `resumePath` — see `desktop/profile.example.json`.

Settings live in `settings.json`; `acceptKey` chooses between `right-command` (default) and
`right-option`.

> Right **Option** was tried as the default and was wrong twice over: macOS toggles Mouse Keys on
> five Option presses, and some apps bind a double tap of it. Right Command has neither problem.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Error: esbuild not found` | no `node_modules` in this checkout/worktree | `pnpm install` at the repo root |
| Health says `"provider":"heuristic"` / `"textProvider":"template"` | `.env` missing or not found | step 2; in a worktree, symlink it |
| Server says `sentry ... profiling=off` | running on Node 23 | `export PATH="$(brew --prefix node@22)/bin:$PATH"` and restart |
| Agent runs but proposes nothing, anywhere | no Accessibility grant | step 7 |
| Accessibility toggle is ON but `trusted: false` | app was rebuilt after granting; TCC keys on the code signature | `tccutil reset Accessibility dev.shabang.desktop`, relaunch with `open`, re-toggle |
| Shabang is not in the Accessibility list at all | launched with `SHABANG_NO_PROMPT=1`, which suppresses the prompt that registers it | first launch via the `open -n -g ...` command in step 7 |
| `/v1/shabang-text` returns **404** | a server from an older checkout is on :8787 | `curl localhost:8787/v1/health`, kill that server, start this one. The route answers `/v1/ghost-text` too, so a stale *client* still works |
| Your changes seem to have no effect | testing the stale release library | `make install-lib`, then `shabangctl quit && shabangctl run` |
| `shabangctl` answers, but with behaviour you did not build | **another agent holds the machine-wide lock** | `ps -p "$(cat ~/Library/Application\ Support/Shabang/harness/agent.lock)" -o command=` — if the path is not your checkout, `shabangctl quit` and start yours |
| `EADDRINUSE` on 8787 | a server is already running | use it, or kill it first. Never run two |
| Proposals are strange / it keeps suggesting the same kind of thing | role memory has over-learned | `rm ~/Library/Application\ Support/Shabang/memory.json` |
| Agent silently sees nothing after a rebuild | `make host-force` was run, invalidating the signature | re-grant (step 7); do not run `host-force` |

### Reset everything and start clean

```bash
cd desktop
./tools/shabangctl quit
rm -rf build
tccutil reset Accessibility dev.shabang.desktop
rm -rf ~/Library/Application\ Support/Shabang      # deletes profile, settings, memory, cache
make app && make install-lib
open -n -g --env SHABANG_LIB="$PWD/build/libshabang.dylib" "$PWD/build/Shabang.app"
```

---

## Two rules that are not negotiable

1. **Never commit `.env` or any key.** A pre-commit hook blocks key-shaped strings; extend its
   `FAKE_FIXTURES` list rather than reaching for `--no-verify`.
2. **Never point automated tests at a real website.** Anything irreversible — submit, send, pay,
   place order, delete — is a *locked* action: Shabang draws it and refuses to press it. Test
   against the local demo pages on :5173.
