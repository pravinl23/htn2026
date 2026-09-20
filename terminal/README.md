# Shabang for the terminal

Shabang predicts your next shell command and shows it as gray text after the cursor, the way it ghosts the next field in a form. Press **Tab** to take it. Nothing ever runs by itself: accepting only puts the text on your command line, and **Enter** stays yours.

```
~/northwind-app (main*) $ git add -A
~/northwind-app (main*) $ git commit -m "|"        <- gray until you press Tab; the cursor lands inside the quotes
```

It is a single zsh file, `ghost.zsh`, with no dependencies beyond `curl` (which ships with macOS). The prediction comes from the Shabang server (`POST /v1/predict/command`, see `docs/server-api.md`, section "Terminal"), which builds candidates in code and asks Jev (TypeSafe) to pick one.

## Install

1. Start the server: `pnpm --filter @shabang/server start` from the repo (or the background LaunchAgent from the main README). It listens on `http://127.0.0.1:8787`.
2. Add this line to your `~/.zshrc`, **after** any plugin that rebinds Tab (fzf, fzf-tab, zsh-autosuggestions, oh-my-zsh):

   ```zsh
   source /path/to/htn2026/terminal/ghost.zsh
   ```

3. Open a new terminal. Run a couple of commands; the ghost appears on the next empty prompt, and again as you type.

Nobody edits your `~/.zshrc` for you, not even the installer. To turn Shabang off, remove the line or set `GHOST_TERMINAL_DISABLE=1` (it is checked at load and before every request, so `export GHOST_TERMINAL_DISABLE=1` in a running shell works too).

## Keys

| Key | With a ghost visible | Without a ghost |
| --- | --- | --- |
| **Tab** | inserts the ghost (the cursor lands inside `""` when it ends with empty quotes) | exactly what Tab did before Shabang loaded (usually `expand-or-complete`, or whatever you bound: completion keeps working) |
| **Right arrow** at the end of the line | inserts the ghost | unchanged (`forward-char`, `vi-forward-char`) |
| **Esc** | dismisses the ghost for the rest of this command line | unchanged |
| typing | a character that matches the ghost just shrinks it (no new request); anything else clears it and asks again after 120 ms | |
| **Enter** | runs what is on the line, never the ghost (the ghost is removed from the line first) | |

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `GHOST_TERMINAL_URL` | `http://127.0.0.1:8787` | the Shabang server |
| `GHOST_TERMINAL_DISABLE` | unset | `1` turns everything off |
| `GHOST_TERMINAL_MIN_CONFIDENCE` | `0.7` | ghosts below this confidence are not shown: a wrong ghost is worse than no ghost |
| `GHOST_TERMINAL_HIGHLIGHT` | `fg=8` | the `region_highlight` style of the ghost (gray) |
| `GHOST_TERMINAL_DEBOUNCE` | `0.12` | seconds to wait after typing before asking |
| `GHOST_TERMINAL_TIMEOUT` | `2` | seconds `curl` may take |
| `GHOST_TERMINAL_DEBUG_LOG` | unset | a file to append one line per event to (request started or skipped, reply status and length); never a command or typed text |

## What leaves your shell

Per request, to the local server only:

- `cwd`: the **basename** of the current directory (`~` for your home directory), never the path.
- `history`: at most the last 30 commands, oldest first, after this filter, applied in the shell before anything is sent (and applied again by the server):
  - dropped: `export` / `set` / `typeset` / inline assignments of names containing KEY, TOKEN, SECRET, PASS (PASSWORD, PASSWD, PASSPHRASE), PWD, CREDENTIAL; `--password`, `--pass`, `--token`, `--api-key`, `--auth` flags; `Authorization:`, `Bearer `, API-key and cookie headers; `-p<password>`, and `-p <password>` after `login` (`docker login -u alex -p ...`) and for the mysql / mongo clients; `redis-cli -a`; `openssl -pass` / `-passin` / `-passout`; HTTP basic credentials on `curl` / `wget` / httpie (`-u alex:pw`, `--user alex:pw`, `-a alex:pw`); URLs with `user:pass@`; base64 or hex blobs of 24+ characters, and random-looking runs of 30+ letters and digits even when `/` splits them (AWS secret access keys); private key headers; well-known token shapes (AWS, GitHub, GitLab, Slack, npm, JWT); multi-line commands and lines over 300 characters;
  - dropped together with **the command right after them**: `ssh-keygen`, `gpg`, `sshpass`, `security find-generic-password` (and the other keychain password commands), because a passphrase is often pasted next. This holds at the edge of the 30-command window too, and whatever you type right after one of them is never sent as a `prefix`;
  - dropped: commands you started with a space (the usual "keep this out of history" convention).
- `prefix`: what you typed, only when it passes the same filter (a line that looks like `export GITHUB_TOKEN=...` is never sent, and the server returns nothing for it).
- `git`: branch name, dirty flag, ahead / behind / untracked counts (from `git status --porcelain=v2`, never file names).
- `projectScripts`: `package.json` script names and `Makefile` targets of the current directory, as commands (`pnpm test`, `make lib`).
- `lastExitCode` of the previous command.

The request body goes to `curl` on stdin, so it never appears in `ps`, and `curl -q --noproxy '*'` ignores `~/.curlrc` and proxies. The server keeps at most a hash of the last three commands as a cache key, logs numbers only, and sends Jev the directory basename, the git summary, the last 15 filtered commands and the candidate list. The filter rules are pinned by `tests/filter-cases.tsv`, which both the zsh and the TypeScript implementations are tested against.

## Safety

- **Never destructive.** The server never offers these as candidates, and the plugin refuses to show them even if a server did: `rm -rf` (any recursive or forced `rm`), `git push --force` / `-f` / `+ref`, pushes that delete a remote branch (`-d`, `--delete`, `:branch`, `--prune`), `git reset --hard`, `git clean -f`, `git branch -D`, `sudo`, `dd`, `mkfs`, `chmod -R 777`, SQL `DROP` / `TRUNCATE`, `kubectl delete`, `terraform destroy`, `docker system prune`, `killall`, `curl ... | sh`, `npm publish` and a few more (`server/src/command/filter.ts`).
- **Never executes.** Tab and Right arrow only edit the line. The plugin never calls `accept-line`. Nothing the server sends is ever evaluated: the reply is parsed as data (a `\u` escape must be exactly 4 hex digits, or the whole reply is dropped) and only ever inserted as text, so even a hostile server at `GHOST_TERMINAL_URL` cannot make the plugin run anything (it can still suggest a bad command, which is why destructive ones are refused here too and Enter stays yours).
- **Never in the way.** The request runs in a background job whose answer arrives through `zle -F`, so the prompt and your typing never wait for the network. A server that is down is a silent no-op (Shabang then waits 10 s before trying again), and nothing is ever printed to your terminal.

## Compatibility

- **iTerm2 and Terminal.app** work (anything that runs zsh's own line editor, ZLE).
- **Warp does not render it.** Warp replaces the shell's line editor with its own input editor, so ZLE widgets, `POSTDISPLAY` and `region_highlight` (what zsh-autosuggestions and Shabang draw with) are not shown there, and Warp's own Tab binding wins. Sourcing `ghost.zsh` in Warp is harmless but you will not see ghosts. The server route itself is editor-agnostic (plain JSON over HTTP), but showing its answer inside Warp would need a Warp-side integration, which we have not built or verified.
- **vi mode** (`bindkey -v`) works: Tab and Right arrow accept in insert mode; Esc keeps entering command mode (Shabang is not bound to Esc in vi mode) and entering command mode hides the ghost for that line.
- **zsh-autosuggestions** draws in the same place (`POSTDISPLAY`). Shabang never overwrites a suggestion it did not draw, and only accepts its own ghost on Tab. With both loaded you will mostly see whichever answers first; we suggest using one of them. If you keep both, load zsh-autosuggestions first and Shabang last.
- **zsh-syntax-highlighting** may repaint the ghost in its own colors if it is loaded after Shabang; load Shabang last.
- **Bracketed paste** is untouched; a pasted command is filtered like typed text before it can be sent.
- Requires zsh 5.3 or newer (for `add-zle-hook-widget`); macOS ships 5.9.

## How it works

1. `precmd` (first in the list, so it sees the real `$?`) starts a background job with `exec {fd}< <(...)` and registers `zle -F $fd`. The job reads the history, runs `git status`, reads `package.json` / `Makefile`, filters, builds the JSON and calls `curl`.
2. On every buffer change (`zle-line-pre-redraw`), typing along the ghost just shrinks it; anything else kills the old job and starts a new one with the typed prefix after a 120 ms debounce. Keys still queued (fast typing) are waited out, so a burst costs one request.
3. When the answer arrives, the `zle -F` handler checks that it is single-line, confident enough, not secret-looking, not destructive and still extends what is on the line, then sets `POSTDISPLAY` and a gray `region_highlight` entry.
4. Tab and Right arrow are bound in the `emacs` and `viins` keymaps to widgets that accept the ghost if one is visible and otherwise call the widget that key had before Shabang loaded.

## Tests

```bash
pnpm test:terminal            # zsh + zsh/zpty + node + curl; skips with a message when one is missing
pnpm --filter @shabang/server test command       # the route, candidates, n-gram, filters (vitest, no keys)
pnpm test:live command        # one real Jev call when TYPESAFE_API_KEY or AI_GATEWAY_API_KEY is set
```

`tests/ghost.test.zsh` starts a clean `zsh -f -i` in a pseudo-terminal with the plugin loaded against `tests/stub-server.mjs` (a few lines of node on a free port), types, presses Tab, Esc and Right arrow, and asserts the line editor's buffer, ghost, cursor, keymap and highlight. It checks that Tab without a ghost still completes (plain and under `compinit`), that the prompt returns at once while the stub sleeps 3 s, that vi mode and bracketed paste still work, that what was sent is filtered, and finally runs the plugin against the real server with the heuristic provider (no keys, no network).
