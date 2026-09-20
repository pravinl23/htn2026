#!/bin/bash
# Undo scripts/install-background.sh: stop and remove the two LaunchAgents and the installed server bundle.
# Docs: README.md "Run Shabang in the background (macOS)".
#
#   scripts/uninstall-background.sh               stop + remove dev.shabang.server and dev.shabang.desktop, remove the server bundle
#   scripts/uninstall-background.sh --dry-run     print every action, change nothing
#   scripts/uninstall-background.sh --remove-app  also remove ~/Applications/Shabang.app and the installed libshabang.dylib
#   scripts/uninstall-background.sh --purge       --remove-app plus profile.json, settings.json, the form cache,
#                                                 ~/.config/shabang/env and ~/Library/Logs/Shabang
#
# Kept unless you ask: your profile and settings, your keys, the logs, and Shabang.app itself (the Accessibility grant is
# tied to that exact copy; keeping it means a later install needs no new grant).
# Never touches privacy permissions (no tccutil, no sudo): remove Shabang from System Settings -> Privacy & Security ->
# Accessibility by hand if you want the entry gone.
# /bin/bash on purpose (3.2 on every Mac).
set -euo pipefail

LABEL_SERVER="dev.shabang.server"
LABEL_DESKTOP="dev.shabang.desktop"

DRY_RUN=0
REMOVE_APP=0
PURGE=0

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'uninstall-background: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,14p' "$0" | sed -e 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run|-n) DRY_RUN=1 ;;
    --remove-app) REMOVE_APP=1 ;;
    --purge) PURGE=1; REMOVE_APP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

[ "$(uname -s)" = "Darwin" ] || die "macOS only (LaunchAgents)."
[ "$(id -u)" -ne 0 ] || die "do not run this as root or with sudo: the LaunchAgents live in your own login session."
case "${HOME:-}" in /*) [ -d "$HOME" ] || die "HOME does not exist" ;; *) die "HOME is not set to an absolute path" ;; esac

DOMAIN="gui/$(id -u)"
SUPPORT_DIR="$HOME/Library/Application Support/Shabang"
SERVER_DIR="$SUPPORT_DIR/server"
LOG_DIR="$HOME/Library/Logs/Shabang"
AGENTS_DIR="$HOME/Library/LaunchAgents"
ENV_DIR="$HOME/.config/shabang"
ENV_FILE="$ENV_DIR/env"
APP_PATH="$HOME/Applications/Shabang.app"

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  +'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# Only ever a path strictly inside $HOME, and only the ones this file names.
remove() {
  case "$1" in "$HOME"/?*) ;; *) die "refusing to remove $1" ;; esac
  if [ -e "$1" ] || [ -L "$1" ]; then
    run rm -rf "$1"
    [ "$DRY_RUN" = 1 ] || say "removed $1"
  else
    say "absent:  $1"
  fi
}

remove_dir_if_empty() {
  [ -d "$1" ] || return 0
  if [ "$DRY_RUN" = 1 ]; then say "  + rmdir $1   (only if it is empty)"; return 0; fi
  rmdir "$1" 2>/dev/null || true
}

agent_loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

stop_agent() { # bootout, errors ignored (not loaded is fine), then wait until launchd has let go
  local label="$1" i
  if [ "$DRY_RUN" = 1 ]; then say "  + launchctl bootout $DOMAIN/$label   (errors ignored)"; return 0; fi
  if ! agent_loaded "$label"; then say "not loaded: $label"; return 0; fi
  launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! agent_loaded "$label"; then say "stopped $label"; return 0; fi
    sleep 0.5
  done
  warn "$label is still loaded after 5 s. Inspect with: launchctl print $DOMAIN/$label"
}

# With the `open -W -n` variant launchd owns `open`, not Shabang, so a bootout leaves the app running. SIGTERM makes Shabang quit
# through AppKit. Only the INSTALLED copy is matched (full path, anchored), never a build you started from the repo.
stop_installed_app() {
  local pattern pids pid i
  pattern="^$(printf '%s' "$APP_PATH/Contents/MacOS/Shabang" | sed -e 's/[][\\.*^$+?(){}|]/\\&/g')"
  if [ "$DRY_RUN" = 1 ]; then say "  + pkill -TERM -f '$pattern'   (only if it still runs after the bootout)"; return 0; fi
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  [ -n "$pids" ] || return 0
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
  for i in 1 2 3 4 5 6; do
    pgrep -f "$pattern" >/dev/null 2>&1 || { say "stopped the installed Shabang.app"; return 0; }
    sleep 0.5
  done
  warn "the installed Shabang.app is still running: quit it from its menu-bar icon."
}

step "Stop the agents$([ "$DRY_RUN" = 0 ] || printf ' (dry run)')"
stop_agent "$LABEL_SERVER"
stop_agent "$LABEL_DESKTOP"
stop_installed_app

step "Remove the LaunchAgents"
remove "$AGENTS_DIR/$LABEL_SERVER.plist"
remove "$AGENTS_DIR/$LABEL_DESKTOP.plist"

step "Remove the server bundle"
remove "$SERVER_DIR"

if [ "$REMOVE_APP" = 1 ]; then
  step "Remove Shabang.app and its library"
  remove "$APP_PATH"
  remove "$SUPPORT_DIR/libshabang.dylib"
  remove "$SUPPORT_DIR/lib-path.txt"
  say "The Accessibility entry for Shabang stays in System Settings (this script never touches privacy permissions)."
  say "Remove it by hand with the - button if you want it gone. A newly built host needs a new grant."
elif [ -e "$APP_PATH" ]; then
  step "Kept"
  say "kept: $APP_PATH and libshabang.dylib. The Accessibility grant belongs to that exact copy, so a later"
  say "      install-background.sh needs no new grant. Shabang no longer starts at login. Delete with --remove-app."
fi

if [ "$PURGE" = 1 ]; then
  step "Purge the profile, the settings, the keys and the logs"
  remove "$SUPPORT_DIR"
  remove "$ENV_FILE"
  remove_dir_if_empty "$ENV_DIR"
  remove "$LOG_DIR"
else
  remove_dir_if_empty "$SUPPORT_DIR"
  say "kept: $SUPPORT_DIR/profile.json and settings.json (your profile), $ENV_FILE (your keys), $LOG_DIR/ (logs)."
  say "      Delete them too with --purge."
fi

step "Done"
say "Shabang no longer runs in the background. The extension and \`pnpm dev\` are unaffected."
[ "$DRY_RUN" = 0 ] || say "(dry run: nothing was stopped or removed)"
