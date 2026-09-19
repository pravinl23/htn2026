#!/bin/bash
# Ghost in the background at login (macOS): the prediction server and the menu-bar agent as two LaunchAgents.
# Docs: README.md "Run Ghost in the background (macOS)", docs/desktop.md "Running in the background at login".
#
#   scripts/install-background.sh                  build, install, start
#   scripts/install-background.sh --dry-run        print every action, change nothing (no build, no copy, no launchctl)
#   scripts/install-background.sh --server-only    only dev.ghost.server
#   scripts/install-background.sh --desktop-only   only dev.ghost.desktop
#   scripts/install-background.sh --launch-via-open   start Ghost.app with `open -W -n` instead of its binary (see the templates)
#   scripts/install-background.sh --render-to DIR  render the plists and the server wrapper into DIR, lint them, touch nothing else
#
# YOU run this, never an agent or CI: it adds login items. It never touches privacy permissions (no tccutil, no sudo):
# Accessibility is granted by hand, once, to ~/Applications/Ghost.app.
# /bin/bash on purpose (3.2 on every Mac): no associative arrays, no mapfile, no ${var,,}.
set -euo pipefail

LABEL_SERVER="dev.ghost.server"
LABEL_DESKTOP="dev.ghost.desktop"
# The ONLY lines ever copied out of the repo's .env. Keep in step with README.md and .env.example.
ENV_KEYS_RE='^(XAI_API_KEY|OPENAI_API_KEY|AI_GATEWAY_API_KEY|TYPESAFE_API_KEY|BASETEN_API_KEY|BASETEN_[A-Z_]+|BROWSERBASE_API_KEY|BROWSERBASE_PROJECT_ID|COMPOSIO_API_KEY|GHOST_PUBLIC_DEMO_URL)='
SERVER_URL="http://127.0.0.1:8787"

DRY_RUN=0
WANT_SERVER=1
WANT_DESKTOP=1
LAUNCH_VIA_OPEN=0
RENDER_TO=""

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'install-background: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,12p' "$0" | sed -e 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1 ;;
    --server-only) WANT_DESKTOP=0 ;;
    --desktop-only) WANT_SERVER=0 ;;
    --launch-via-open) LAUNCH_VIA_OPEN=1 ;;
    --render-to) shift; [ $# -gt 0 ] || die "--render-to needs a directory"; RENDER_TO="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done
[ "$WANT_SERVER" = 1 ] || [ "$WANT_DESKTOP" = 1 ] || die "--server-only and --desktop-only exclude each other"

[ "$(uname -s)" = "Darwin" ] || die "macOS only (LaunchAgents)."
# Root would install into root's home, own the files in yours, and run the agents outside your login session.
[ "$(id -u)" -ne 0 ] || die "do not run this as root or with sudo: LaunchAgents belong to your own login session."
case "${HOME:-}" in /*) [ -d "$HOME" ] || die "HOME does not exist" ;; *) die "HOME is not set to an absolute path" ;; esac

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATES="$REPO/scripts/launchd"
DOMAIN="gui/$(id -u)"
SUPPORT_DIR="$HOME/Library/Application Support/Ghost"
SERVER_DIR="$SUPPORT_DIR/server"
LOG_DIR="$HOME/Library/Logs/Ghost"
AGENTS_DIR="$HOME/Library/LaunchAgents"
ENV_DIR="$HOME/.config/ghost"
ENV_FILE="$ENV_DIR/env"
APP_SRC="$REPO/desktop/build/Ghost.app"
APP_PATH="$HOME/Applications/Ghost.app"
NODE_BIN=""

# ---------- helpers ----------

# Every change to the machine goes through run (or is printed by hand next to a DRY_RUN test), so --dry-run shows all of it.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  +'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# A path becomes safe inside XML text and inside a sed replacement that uses | as its delimiter.
subst() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/[\\&|]/\\&/g'; }

render() { # render <template>: the plist on stdout
  [ -f "$1" ] || die "missing template: $1"
  sed -e "s|@SERVER_DIR@|$(subst "$SERVER_DIR")|g" -e "s|@NODE_BIN@|$(subst "$NODE_BIN")|g" \
      -e "s|@LOG_DIR@|$(subst "$LOG_DIR")|g" -e "s|@APP_PATH@|$(subst "$APP_PATH")|g" "$1"
}

check_plist() { # check_plist <file>
  if grep -qE '@[A-Z_]+@' "$1"; then die "unrendered placeholder in $1"; fi
  plutil -lint "$1" >/dev/null || die "plutil rejects $1"
}

install_plist() { # install_plist <template> <destination>
  local tmp
  if [ "$DRY_RUN" = 1 ]; then
    say "  + render $1 -> $2 (mode 0644), then plutil -lint. Rendered:"
    render "$1" | grep -v '^[[:space:]]*$' | sed -e 's/^/      /'
    render "$1" | plutil -lint - >/dev/null || die "plutil rejects the rendered $1"
    return
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/ghost-plist.XXXXXX")"
  render "$1" > "$tmp"
  check_plist "$tmp"
  install -m 0644 "$tmp" "$2"
  rm -f "$tmp"
  say "wrote $2"
}

desktop_template() {
  if [ "$LAUNCH_VIA_OPEN" = 1 ]; then printf '%s' "$TEMPLATES/$LABEL_DESKTOP.open.plist.template"; else printf '%s' "$TEMPLATES/$LABEL_DESKTOP.plist.template"; fi
}

# The program of dev.ghost.server. Static on purpose (the node path arrives as $1 from the plist), so it can be reviewed here.
wrapper_script() {
  cat <<'WRAPPER'
#!/bin/bash
# Started by the dev.ghost.server LaunchAgent. Written by scripts/install-background.sh: re-run it instead of editing this.
# Exports ~/.config/ghost/env, then execs node on the server bundle. The env file is DATA: KEY=value lines are split by
# hand and exported, nothing in it is ever evaluated as shell, and neither names nor values are printed.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
env_file="${GHOST_ENV_FILE:-$HOME/.config/ghost/env}"
node_bin="${1:-}"

# launchd keeps these files open in append mode, so they are trimmed in place rather than renamed.
for log in "$HOME/Library/Logs/Ghost/server.log" "$HOME/Library/Logs/Ghost/server.err.log"; do
  if [ -f "$log" ] && [ "$(stat -f %z "$log" 2>/dev/null || echo 0)" -gt 5242880 ]; then
    cp -f "$log" "$log.1" 2>/dev/null || true
    : > "$log"
  fi
done

if [ ! -x "$node_bin" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then node_bin="$candidate"; break; fi
  done
fi
if [ ! -x "$node_bin" ]; then
  echo "[ghost] $(date '+%Y-%m-%d %H:%M:%S') node not found (installed path: ${1:-none}). Re-run scripts/install-background.sh." >&2
  sleep 50 # KeepAlive starts this again: do not spin
  exit 78
fi

count=0
if [ -r "$env_file" ]; then
  chmod 600 "$env_file" 2>/dev/null || true
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    line="${line#export }"
    key="${line%%=*}"
    value="${line#*=}"
    [ "$key" != "$line" ] || continue
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] || continue
    # Variables that change how node or the dynamic linker load code have no business in a key file.
    case "$key" in PATH|HOME|SHELL|NODE_OPTIONS|NODE_PATH|DYLD_*|LD_*) continue ;; esac
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    # "KEY=" means "not set": an exported empty PORT or *_BASE_URL would override the server's defaults.
    [ -n "$value" ] || continue
    export "$key=$value"
    count=$((count + 1))
  done < "$env_file"
fi

echo "[ghost] $(date '+%Y-%m-%d %H:%M:%S') starting the server bundle with node $("$node_bin" -v 2>/dev/null), $count variables from the env file"
exec "$node_bin" "$here/server.mjs"
WRAPPER
}

env_file_template() {
  cat <<'ENVFILE'
# Keys for the Ghost background server (dev.ghost.server). Mode 0600. Read by ghost-server.sh, never by the repo.
# KEY=value, one per line, no inline comments. Empty means "not set". With no keys Ghost uses the offline heuristic.
# After editing: launchctl kickstart -k gui/$(id -u)/dev.ghost.server
#AI_GATEWAY_API_KEY=
#TYPESAFE_API_KEY=
#OPENAI_API_KEY=
#XAI_API_KEY=
#BASETEN_API_KEY=
#BROWSERBASE_API_KEY=
#BROWSERBASE_PROJECT_ID=
#COMPOSIO_API_KEY=
#GHOST_PUBLIC_DEMO_URL=
ENVFILE
}

find_node() {
  NODE_BIN="${GHOST_NODE:-$(command -v node || true)}"
  case "$NODE_BIN" in /*) ;; *) die "node not found. Install Node 22+ (or set GHOST_NODE=/absolute/path/to/node)." ;; esac
  [ -x "$NODE_BIN" ] || die "not executable: $NODE_BIN"
  local major
  major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "Node 22 or later is required, $NODE_BIN is $("$NODE_BIN" -v)."
  case "$NODE_BIN" in
    */.nvm/*|*/fnm/*|*/.volta/*|*/Cellar/*|*/.asdf/*)
      warn "$NODE_BIN belongs to one specific Node version. Run this script again after you upgrade or remove that version." ;;
  esac
}

agent_loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

stop_agent() { # bootout, errors ignored (not loaded is the normal case), then wait until launchd has really let go of it
  local label="$1" i
  if [ "$DRY_RUN" = 1 ]; then say "  + launchctl bootout $DOMAIN/$label   (errors ignored)"; return; fi
  launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    agent_loaded "$label" || return 0
    sleep 0.5
  done
  warn "$label is still loaded after 5 s; the bootstrap below may fail. Try again in a moment."
}

start_agent() { # start_agent <label> <plist>
  local label="$1" plist="$2" try
  if [ "$DRY_RUN" = 1 ]; then
    say "  + launchctl enable $DOMAIN/$label"
    say "  + launchctl bootstrap $DOMAIN $plist"
    return
  fi
  launchctl enable "$DOMAIN/$label" >/dev/null 2>&1 || true
  for try in 1 2 3; do
    if launchctl bootstrap "$DOMAIN" "$plist"; then say "started $label"; return 0; fi
    sleep 1 # "Bootstrap failed: 5" right after a bootout means launchd is still tearing the old job down
  done
  die "launchctl bootstrap $DOMAIN $plist failed. Inspect with: launchctl print $DOMAIN/$label"
}

# ---------- steps ----------

build_all() {
  step "Build"
  if [ "$WANT_SERVER" = 1 ]; then
    run "$NODE_BIN" "$REPO/server/build.mjs"
    [ "$DRY_RUN" = 1 ] || [ -s "$REPO/server/dist/server.mjs" ] || die "server/dist/server.mjs was not produced"
  fi
  if [ "$WANT_DESKTOP" = 1 ]; then
    # Builds the host only when it does not exist yet (docs/desktop-realworld.md section 1), plus the core bundle and the library.
    run make -C "$REPO/desktop" app
    [ "$DRY_RUN" = 1 ] || [ -d "$APP_SRC" ] || die "desktop/build/Ghost.app was not produced"
  fi
}

stop_all() {
  step "Stop the running agents (if any)"
  [ "$WANT_SERVER" = 0 ] || stop_agent "$LABEL_SERVER"
  [ "$WANT_DESKTOP" = 0 ] || stop_agent "$LABEL_DESKTOP"
}

install_server_files() {
  step "Server bundle -> $SERVER_DIR"
  local externals name source
  run mkdir -p "$SERVER_DIR" "$LOG_DIR" "$AGENTS_DIR"
  run chmod 700 "$SERVER_DIR" "$LOG_DIR"
  run install -m 0644 "$REPO/server/dist/server.mjs" "$SERVER_DIR/server.mjs"
  if [ "$DRY_RUN" = 1 ]; then
    say "  + write $SERVER_DIR/ghost-server.sh (mode 0755): exports $ENV_FILE, then exec $NODE_BIN server.mjs"
    wrapper_script | bash -n /dev/stdin || die "the generated wrapper does not parse"
  else
    wrapper_script > "$SERVER_DIR/ghost-server.sh"
    chmod 755 "$SERVER_DIR/ghost-server.sh"
    bash -n "$SERVER_DIR/ghost-server.sh" || die "the generated wrapper does not parse"
  fi
  # Packages server/build.mjs could not put inside the bundle (playwright-core: it finds its own files on disk at run time).
  # They have no dependencies of their own (build.mjs refuses otherwise), so a dereferenced copy of the pnpm link is a
  # complete install; `pnpm deploy` would copy the whole dependency tree for the same result.
  externals="playwright-core"
  [ ! -f "$REPO/server/dist/externals.txt" ] || externals="$(cat "$REPO/server/dist/externals.txt")"
  run rm -rf "$SERVER_DIR/node_modules"
  for name in $externals; do
    source="$REPO/server/node_modules/$name"
    if [ -d "$source" ]; then
      case "$name" in */*) run mkdir -p "$SERVER_DIR/node_modules/${name%/*}" ;; *) run mkdir -p "$SERVER_DIR/node_modules" ;; esac
      run cp -RL "$source" "$SERVER_DIR/node_modules/$name"
    else
      warn "$source is missing (pnpm install?). The server runs without it; only Browserbase cloud batches need $name."
    fi
  done
  # launchd would create the log files world-readable.
  for name in server.log server.err.log; do
    run touch "$LOG_DIR/$name"
    run chmod 600 "$LOG_DIR/$name"
  done
}

install_env_file() {
  step "Keys -> $ENV_FILE (mode 0600; the LaunchAgent never reads the repo's .env)"
  if [ -e "$ENV_FILE" ]; then
    say "kept: $ENV_FILE already exists and is never overwritten. Edit it by hand to change keys."
    run chmod 600 "$ENV_FILE"
    return
  fi
  run mkdir -p "$ENV_DIR"
  run chmod 700 "$ENV_DIR"
  if [ -f "$REPO/.env" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      say "  + (umask 077) grep -E '$ENV_KEYS_RE' $REPO/.env > $ENV_FILE   (known names only; nothing is printed)"
    else
      # No echo, no xtrace, no temp copy outside the 0700 directory: the lines go from one file straight into the other.
      ( umask 077; grep -E "$ENV_KEYS_RE" "$REPO/.env" > "$ENV_FILE" || true )
      chmod 600 "$ENV_FILE"
      say "created $ENV_FILE with $(grep -c '' "$ENV_FILE" | tr -d ' ') known variable(s) from the repo's .env (values not shown)"
    fi
  elif [ "$DRY_RUN" = 1 ]; then
    say "  + write $ENV_FILE (mode 0600): a commented list of the variable names, no values (the repo has no .env)"
  else
    ( umask 077; env_file_template > "$ENV_FILE" )
    chmod 600 "$ENV_FILE"
    say "created $ENV_FILE with no keys (the repo has no .env): Ghost uses the offline heuristic until you add one"
  fi
}

install_desktop_files() {
  step "Ghost.app -> $APP_PATH"
  run mkdir -p "$LOG_DIR" "$AGENTS_DIR"
  if [ -e "$APP_PATH" ]; then
    say "kept: $APP_PATH is already installed and is NEVER overwritten. macOS ties the Accessibility grant to the"
    say "      host's code hash: a fresh copy would silently lose the grant. Updates arrive through libghost.dylib instead."
    say "      To replace the host on purpose: scripts/uninstall-background.sh --remove-app, run this again, grant again."
  else
    run mkdir -p "$HOME/Applications"
    run /usr/bin/ditto "$APP_SRC" "$APP_PATH"
    [ "$DRY_RUN" = 1 ] || codesign --verify "$APP_PATH" 2>/dev/null || warn "codesign --verify failed for $APP_PATH (the copy is unsigned or damaged)"
  fi
  if grep -qsE '^install-lib[[:space:]]*:' "$REPO/desktop/Makefile" "$REPO"/desktop/tools/*.mk; then
    run make -C "$REPO/desktop" install-lib
  else
    warn "desktop/Makefile has no install-lib target yet (the app is still one binary): skipped. Re-run this script after the host/library split lands."
  fi
  run touch "$LOG_DIR/desktop.launchd.log"
  run chmod 600 "$LOG_DIR/desktop.launchd.log"
}

install_plists() {
  step "LaunchAgents -> $AGENTS_DIR"
  run mkdir -p "$AGENTS_DIR"
  [ "$WANT_SERVER" = 0 ] || install_plist "$TEMPLATES/$LABEL_SERVER.plist.template" "$AGENTS_DIR/$LABEL_SERVER.plist"
  [ "$WANT_DESKTOP" = 0 ] || install_plist "$(desktop_template)" "$AGENTS_DIR/$LABEL_DESKTOP.plist"
}

preflight_conflicts() { # after the bootout: whatever still holds these is not ours
  [ "$DRY_RUN" = 0 ] || return 0
  local pids
  if [ "$WANT_SERVER" = 1 ]; then
    pids="$(lsof -nP -iTCP:8787 -sTCP:LISTEN -t 2>/dev/null | tr '\n' ' ' || true)"
    [ -z "$pids" ] || warn "port 8787 is taken by pid $pids(a \`pnpm dev\` server?). dev.ghost.server will retry every 10 s until the port is free."
  fi
  if [ "$WANT_DESKTOP" = 1 ]; then
    pids="$(pgrep -f 'Ghost\.app/Contents/MacOS/Ghost' 2>/dev/null | tr '\n' ' ' || true)"
    [ -z "$pids" ] || warn "another Ghost is running (pid $pids): the background copy will exit at once. Quit that one, then: launchctl kickstart $DOMAIN/$LABEL_DESKTOP"
  fi
}

start_all() {
  step "Start"
  [ "$WANT_SERVER" = 0 ] || start_agent "$LABEL_SERVER" "$AGENTS_DIR/$LABEL_SERVER.plist"
  [ "$WANT_DESKTOP" = 0 ] || start_agent "$LABEL_DESKTOP" "$AGENTS_DIR/$LABEL_DESKTOP.plist"
  [ "$DRY_RUN" = 0 ] && [ "$WANT_SERVER" = 1 ] || return 0
  local i health
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if health="$(curl -fsS -m 2 "$SERVER_URL/v1/health" 2>/dev/null)"; then say "server: up. $health"; return 0; fi
    sleep 0.5
  done
  warn "no answer from $SERVER_URL/v1/health after 10 s. Look at $LOG_DIR/server.err.log"
}

next_steps() {
  step "Next steps"
  if [ "$WANT_DESKTOP" = 1 ]; then
    say "1. Grant Accessibility ONCE: System Settings -> Privacy & Security -> Accessibility -> switch on Ghost"
    say "   ($APP_PATH; use + and Cmd+Shift+G to add it if it is not listed). Ghost notices within 2 s, no restart."
    say "   Only you can do this. The grant survives updates because this script never replaces that app:"
    say "   update with   make -C desktop install-lib && launchctl kickstart -k $DOMAIN/$LABEL_DESKTOP"
  fi
  [ "$WANT_SERVER" = 0 ] || say "2. Keys live in $ENV_FILE. After editing:   launchctl kickstart -k $DOMAIN/$LABEL_SERVER"
  say "3. Logs: $LOG_DIR/   Status: launchctl print $DOMAIN/$LABEL_SERVER | head -20"
  say "4. Undo: scripts/uninstall-background.sh   (--remove-app also deletes Ghost.app; --purge also the profile, the keys and the logs)"
  [ "$DRY_RUN" = 0 ] || say "(dry run: nothing was built, copied, written or loaded)"
}

render_only() {
  mkdir -p "$RENDER_TO"
  render "$TEMPLATES/$LABEL_SERVER.plist.template" > "$RENDER_TO/$LABEL_SERVER.plist"
  render "$(desktop_template)" > "$RENDER_TO/$LABEL_DESKTOP.plist"
  wrapper_script > "$RENDER_TO/ghost-server.sh"
  check_plist "$RENDER_TO/$LABEL_SERVER.plist"
  check_plist "$RENDER_TO/$LABEL_DESKTOP.plist"
  bash -n "$RENDER_TO/ghost-server.sh"
  say "rendered and linted: $RENDER_TO/$LABEL_SERVER.plist $RENDER_TO/$LABEL_DESKTOP.plist $RENDER_TO/ghost-server.sh"
}

# ---------- main ----------

find_node
if [ -n "$RENDER_TO" ]; then render_only; exit 0; fi

step "Plan$([ "$DRY_RUN" = 0 ] || printf ' (dry run)')"
say "repo     $REPO"
say "node     $NODE_BIN ($("$NODE_BIN" -v))"
[ "$WANT_SERVER" = 0 ]  || say "server   $SERVER_DIR/server.mjs as $DOMAIN/$LABEL_SERVER, keys from $ENV_FILE"
[ "$WANT_DESKTOP" = 0 ] || say "desktop  $APP_PATH as $DOMAIN/$LABEL_DESKTOP ($([ "$LAUNCH_VIA_OPEN" = 1 ] && printf 'open -W -n' || printf 'binary started by launchd'))"
say "logs     $LOG_DIR/"

build_all # first: a failed build must leave the running agents alone
stop_all
preflight_conflicts
if [ "$WANT_SERVER" = 1 ]; then install_server_files; install_env_file; fi
[ "$WANT_DESKTOP" = 0 ] || install_desktop_files
install_plists
start_all
next_steps
