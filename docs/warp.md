# Warp / developer tool, for pitching

**Read §1 before deciding whether to enter this track at all.** The terminal companion is real,
tested and works — and it does **not render inside Warp**. Pitching it as a Warp integration will not
survive the first follow-up question. Pitching it as a developer tool is honest and still good.

---

## 1. The thing to say first

> We built a terminal companion that ghosts your next shell command the way the desktop agent ghosts
> your next field. It works in zsh, it is 50 tests green, and **it does not draw inside Warp** —
> Warp replaces the shell's line editor with its own, so ZLE widgets and `POSTDISPLAY` are never
> rendered and Warp's own Tab binding wins. The prediction route is editor-agnostic plain JSON over
> HTTP, so a Warp-side integration is a small piece of work — we have not built it and we will not
> claim it.

Saying that out loud is stronger than being caught by it. It also names exactly what a Warp
integration would need, which is the part a Warp judge cares about.

---

## 2. What it actually does

One zsh file, `terminal/ghost.zsh`, no dependencies beyond `curl` (which ships with macOS).

```
~/northwind-app (main*) $ git add -A
~/northwind-app (main*) $ git commit -m "|"     <- gray until you press Tab; the cursor lands inside the quotes
```

- The server builds candidates **in code** and asks Jev (TypeSafe) to pick one.
- **Tab inserts. Enter stays yours.** Accepting only puts text on your command line. Nothing is ever
  executed by the ghost — that is the whole safety story, and it is the same rule the desktop agent
  follows for irreversible actions.
- The cursor lands *inside* the quotes on a `git commit -m ""`, which is the small detail that makes
  it feel like a tool rather than a completion.

Measured live: Jev picked the next command in **491 ms** at **0.89** confidence.
`pnpm test:terminal` → **50 passed, 0 failed**.

---

## 3. Why this is a real developer tool, not a demo toy

**It survives a hostile environment.** The tests cover things that break most zsh plugins:

- loads and runs under `nounset`, `ksharrays` and `shwordsplit`
- **the server being down prints nothing** — a dev tool that spews errors into your prompt when a
  background service dies is worse than no tool
- it installs *after* any plugin that rebinds Tab (fzf, fzf-tab, zsh-autosuggestions, oh-my-zsh) and
  chains to whatever the key did before, instead of stealing it

**It refuses to touch your dotfiles.** Nobody edits `~/.zshrc` for you, not even the installer. You
add one `source` line yourself. Turning it off is removing that line, or
`export GHOST_TERMINAL_DISABLE=1` — checked at load *and* before every request, so it works in a
shell that is already running.

**It is one file you can read.** No daemon of its own, no compiled component, no dependency tree.

---

## 4. Why a terminal ghost at all

The product thesis is *"Cursor Tab for your whole computer"*. A terminal is the one surface where
that claim is easiest to test and hardest to fake: developers know exactly what the right next
command is, so a wrong suggestion is obvious and unforgivable.

It also reuses the entire stack unchanged — same server, same Jev provider, same confidence gate,
same "pick, never generate" split. The only new code is the rendering layer, which is the correct
shape for this architecture and the reason a Warp integration would be small.

---

## 5. What a Warp integration would take

Concrete, since this is the useful answer for that booth:

- The route is `POST /v1/predict/command` — plain JSON over loopback HTTP, no editor assumptions,
  documented in [server-api.md](server-api.md) under "Terminal".
- What is missing is only the **display**: Warp would need to render the suggestion in its own input
  editor and bind a key to accept it, the way it does for its own completions.
- Nothing about the prediction, the safety rules or the confidence gate would change.

We have not built or verified that, so it is described here as work, not as a feature.

---

## 6. What NOT to claim

- **Do not say it works in Warp.** It does not draw there. Sourcing `ghost.zsh` inside Warp is
  harmless and you will simply see nothing.
- **Do not call it an autocomplete.** It predicts one next command from context; it is not a
  history-prefix matcher and should not be compared to one.
- **Do not demo it without the server running.** It correctly prints nothing when the server is down,
  which is right behaviour and a terrible demo.

---

## 7. Running it

```bash
pnpm --filter @shabang/server dev        # must be running
echo 'source /path/to/htn2026/terminal/ghost.zsh' >> ~/.zshrc   # after any Tab-rebinding plugin
pnpm test:terminal                       # 50 passed
```

Full notes, keybindings and the disable switch: [`terminal/README.md`](../terminal/README.md).
