#!/bin/bash
# Shabang, installed. One command, from a clean Mac to a working agent.
#
#   ./install.sh              build, install to ~/Applications, grant, verify
#   ./install.sh --update     rebuild the library only (keeps the app and its permission)
#   ./install.sh --check      change nothing, just say what is wrong
#
# WHY IT INSTALLS TO ~/Applications: macOS ties the Accessibility permission to the app's CODE SIGNATURE.
# Rebuild the app and the permission silently stops applying -- the toggle stays on and the agent goes blind.
# So the app is built ONCE and copied to ~/Applications, and every later change ships as the library next to
# it, which is not signed into the grant. Grant it once there and it stays granted.
#
# /bin/bash on purpose (3.2 is what every Mac has): no associative arrays, no mapfile.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_SRC="$REPO/desktop/build/Shabang.app"
APP_DEST="$HOME/Applications/Shabang.app"
SUPPORT="$HOME/Application Support"   # reassigned below; kept literal-free for the linter
SUPPORT="$HOME/Library/Application Support/Shabang"
BUNDLE_ID="dev.shabang.desktop"
SERVER="http://127.0.0.1:8787"

MODE="install"
for arg in "$@"; do
  case "$arg" in
    --update) MODE="update" ;;
    --check)  MODE="check" ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 64 ;;
  esac
done

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; off=$'\033[0m'
step()  { printf '\n%s==>%s %s%s\n' "$bold" "$off" "$bold" "$1$off"; }
ok()    { printf '  %s✓%s %s\n' "$green" "$off" "$1"; }
warn()  { printf '  %s!%s %s\n' "$yellow" "$off" "$1"; }
bad()   { printf '  %s✗%s %s\n' "$red" "$off" "$1"; }
die()   { bad "$1"; [ $# -gt 1 ] && printf '      %s%s%s\n' "$dim" "$2" "$off"; exit 1; }

# ---------------------------------------------------------------- prerequisites
step "Checking what this Mac has"

[ "$(uname -s)" = "Darwin" ] || die "Shabang is a macOS app."

xcode-select -p >/dev/null 2>&1 || die "Xcode Command Line Tools are missing." "xcode-select --install"
ok "Xcode Command Line Tools"

command -v pnpm >/dev/null 2>&1 || die "pnpm is missing." "brew install pnpm"
ok "pnpm $(pnpm -v)"

# Node 22 exactly, because @sentry/profiling-node ships prebuilt binaries for even-numbered LTS only.
# On 23 the server still runs and profiling silently reports OFF, which is a lost Sentry product and no error.
NODE_BIN="$(command -v node || true)"
NODE_MAJOR=0
[ -n "$NODE_BIN" ] && NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" != "22" ]; then
  BREW22="$(brew --prefix node@22 2>/dev/null || true)"
  if [ -n "$BREW22" ] && [ -x "$BREW22/bin/node" ]; then
    export PATH="$BREW22/bin:$PATH"
    NODE_BIN="$BREW22/bin/node"
    ok "Node $("$NODE_BIN" -v) (found node@22 and put it first on PATH for this run)"
  elif [ "$NODE_MAJOR" = "0" ]; then
    die "Node is missing." "brew install node@22"
  else
    warn "Node $("$NODE_BIN" -v): Sentry profiling needs Node 22 and will report off."
    warn "brew install node@22   (then re-run this)"
  fi
else
  ok "Node $("$NODE_BIN" -v)"
fi

# ---------------------------------------------------------------- keys
step "Checking keys"
if [ -e "$REPO/.env" ]; then
  MISSING=""
  for key in TYPESAFE_API_KEY BASETEN_API_KEY; do
    grep -qE "^$key=.+" "$REPO/.env" 2>/dev/null || MISSING="$MISSING $key"
  done
  if [ -n "$MISSING" ]; then
    warn ".env is there but missing:$MISSING"
    warn "Without them the server answers with a heuristic and canned text, which looks like a broken model."
  else
    ok ".env has the keys that matter"
  fi
else
  warn "no .env at the repo root"
  warn "Copy one from a teammate: cp /their/path/.env '$REPO/.env' && chmod 600 '$REPO/.env'"
  warn "Everything below still works; the server just falls back to heuristic + template."
fi

if [ "$MODE" = "check" ]; then
  step "Check only, nothing changed"
  [ -d "$APP_DEST" ] && ok "installed at $APP_DEST" || warn "not installed yet"
  exit 0
fi

# ---------------------------------------------------------------- dependencies
step "Installing dependencies"
# Nothing builds without this: the desktop core is esbuild bundling shared/src.
(cd "$REPO" && pnpm install --silent) && ok "workspace ready"

# ---------------------------------------------------------------- stale builds
step "Clearing anything already running"
STOPPED=0
for pattern in "Shabang.app/Contents/MacOS/Shabang" "Ghost.app/Contents/MacOS/Ghost"; do
  if pgrep -f "$pattern" >/dev/null 2>&1; then pkill -f "$pattern" 2>/dev/null || true; STOPPED=1; fi
done
[ "$STOPPED" = "1" ] && { sleep 2; ok "stopped a running agent"; } || ok "nothing was running"

# A build tree from the Ghost era answers ghostctl and holds the machine-wide lock. It is build output.
for stale in "$REPO/desktop/build/Ghost.app" "$HOME/Applications/Ghost.app"; do
  [ -e "$stale" ] && rm -rf "$stale" && ok "removed stale $(basename "$stale")"
done

# ---------------------------------------------------------------- build
if [ "$MODE" = "update" ] && [ -d "$APP_DEST" ]; then
  step "Rebuilding the library only"
  (cd "$REPO/desktop" && make lib >/dev/null && make install-lib >/dev/null) \
    && ok "library updated; $APP_DEST and its permission are untouched"
else
  step "Building"
  (cd "$REPO/desktop" && make app >/dev/null) || die "the build failed" "cd desktop && make app"
  ok "built $(basename "$APP_SRC")"

  # The app moves to ~/Applications ONCE. Everything after this updates the library beside it instead, so the
  # code signature never changes again and the Accessibility grant never needs redoing.
  mkdir -p "$HOME/Applications"
  if [ -d "$APP_DEST" ]; then
    OLD_HASH="$(codesign -dv --verbose=4 "$APP_DEST" 2>&1 | awk -F= '/^CDHash/{print $2}')"
    NEW_HASH="$(codesign -dv --verbose=4 "$APP_SRC"  2>&1 | awk -F= '/^CDHash/{print $2}')"
    if [ "$OLD_HASH" = "$NEW_HASH" ]; then
      ok "$APP_DEST is already this exact build (permission kept)"
    else
      warn "the installed app differs from this build; replacing it"
      warn "macOS will ask for Accessibility again, because the signature changed."
      rm -rf "$APP_DEST"; cp -R "$APP_SRC" "$APP_DEST"; ok "installed to $APP_DEST"
    fi
  else
    cp -R "$APP_SRC" "$APP_DEST"; ok "installed to $APP_DEST"
  fi
  (cd "$REPO/desktop" && make install-lib >/dev/null) && ok "library installed where the app looks for it"
fi

# ---------------------------------------------------------------- server
step "Prediction server"
if curl -fsS -m 3 "$SERVER/v1/health" >/dev/null 2>&1; then
  HEALTH="$(curl -fsS -m 5 "$SERVER/v1/health")"
  PROVIDER="$(printf '%s' "$HEALTH" | sed -n 's/.*"provider":"\([a-z-]*\)".*/\1/p')"
  TEXT="$(printf '%s' "$HEALTH" | sed -n 's/.*"textProvider":"\([a-z-]*\)".*/\1/p')"
  if [ "$PROVIDER" = "heuristic" ] || [ "$TEXT" = "template" ]; then
    warn "already running, but with no keys (decisions: $PROVIDER, text: $TEXT)"
    warn "That server was probably started elsewhere. Stop it and run: pnpm --filter @shabang/server dev"
  else
    ok "running (decisions: $PROVIDER, text: $TEXT)"
  fi
else
  warn "not running. Start it in another terminal, and leave it running:"
  printf '      %spnpm --filter @shabang/server dev%s\n' "$dim" "$off"
fi

# ---------------------------------------------------------------- permission
step "Accessibility"
# Launched WITH the prompt (no SHABANG_NO_PROMPT): that call is what REGISTERS the app in the list. Without it
# the app never appears there to be switched on, which looks exactly like a broken install.
open -n -g "$APP_DEST" 2>/dev/null || true
sleep 3

trusted() { "$REPO/desktop/tools/shabangctl" trust 2>/dev/null | grep -q '"trusted" : true'; }

if trusted; then
  ok "already granted"
else
  printf '  %sShabang reads the screen through Accessibility. It cannot see anything until you allow it.%s\n' "$dim" "$off"
  printf '\n  %sSwitch on "Shabang" in the window that just opened.%s\n\n' "$bold" "$off"
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true

  printf '  waiting'
  for _ in $(seq 1 60); do
    if trusted; then printf '\n'; ok "granted"; break; fi
    printf '.'; sleep 2
  done
  if ! trusted; then
    printf '\n'
    warn "still not granted. Two things this is, almost always:"
    warn "1. Shabang is not in the list -> quit it, re-run this script."
    warn "2. It IS on but still not working -> macOS remembers the OLD signature. Clear it and re-grant:"
    printf '      %stccutil reset Accessibility %s%s\n' "$dim" "$BUNDLE_ID" "$off"
    printf '      %s%s/install.sh%s\n' "$dim" "$REPO" "$off"
  fi
fi

# ---------------------------------------------------------------- verify
step "Checking it works"
"$REPO/desktop/tools/shabangctl" quit >/dev/null 2>&1 || true
sleep 1
open -n -g "$APP_DEST" 2>/dev/null || true
sleep 4

if trusted; then ok "the agent can read the screen"; else bad "the agent is running but blind (see above)"; fi
[ -f "$SUPPORT/profile.json" ] && ok "profile ready (the fictional demo profile)" || warn "no profile yet; it seeds on first run"

step "Done"
printf '  Shabang is in your menu bar. Press %sright ⌘%s to take a suggestion.\n\n' "$bold" "$off"
printf '  %sshabangctl log 40%s          what it is doing\n' "$dim" "$off"
printf '  %sshabangctl next --frontmost "Messages"%s   what it would propose\n' "$dim" "$off"
printf '  %s./install.sh --update%s      after changing code (keeps the permission)\n\n' "$dim" "$off"
