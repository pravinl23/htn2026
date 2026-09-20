#!/usr/bin/env zsh -f
# Drives a real interactive `zsh -f` through a pseudo-terminal (zsh/zpty) with terminal/ghost.zsh loaded against a
# tiny local stub server (stub-server.mjs), and asserts what the line editor holds after each key.
# Run with: pnpm test:terminal   (skips with a message when zsh/zpty, node or curl is missing)

emulate -L zsh
setopt extendedglob

zmodload zsh/zpty 2>/dev/null || { print "test:terminal skipped: the zsh/zpty module is not available"; exit 0 }
zmodload zsh/datetime zsh/zselect 2>/dev/null || { print "test:terminal skipped: zsh/datetime or zsh/zselect is not available"; exit 0 }
(( $+commands[node] )) || { print "test:terminal skipped: node is not installed"; exit 0 }
(( $+commands[curl] )) || { print "test:terminal skipped: curl is not installed"; exit 0 }

ROOT=${${(%):-%x}:A:h:h:h}
PLUGIN=$ROOT/terminal/ghost.zsh
TMP=$(mktemp -d "${TMPDIR:-/tmp}/ghost-terminal-test.XXXXXX")
WORK=$TMP/work-dir
LOG=$TMP/requests.jsonl
DUMP=$TMP/dump
SEP=$'\x1e'
integer passed=0 failed=0 STUB_PID=0
typeset -g OUT='' PORT=''
typeset -gA D

cleanup() {
  (( STUB_PID )) && kill $STUB_PID 2>/dev/null
  zpty -d GH 2>/dev/null
  rm -rf -- $TMP
}
trap cleanup EXIT INT TERM

ok() { (( passed++ )); print -r -- "ok   - $1" }
not_ok() {
  (( failed++ ))
  print -r -- "FAIL - $1"
  [[ -n ${2:-} ]] && print -r -- "       $2"
  # The plugin's own debug log (counts and statuses only) says what happened just before.
  (( failed == 1 )) && [[ -f $TMP/debug.log ]] && print -rl -- "       debug: "${^${(f)"$(tail -8 $TMP/debug.log)"}}
  return 0
}
expect_eq() { if [[ $2 == "$3" ]]; then ok "$1"; else not_ok "$1" "expected [${(V)3}] got [${(V)2}]"; fi }
pause() { zselect -t $1 2>/dev/null; : }   # hundredths of a second

# --------------------------------------------------------------------------------------------------------------
# 1. The zsh filters give the same verdicts as the TypeScript ones (server/test/commandFilter.test.ts).

(
  GHOST_TERMINAL_LIB_ONLY=1 source $PLUGIN
  integer bad=0 rows=0
  local verdict line got
  while IFS=$'\t' read -r verdict line; do
    [[ -z $verdict || $verdict == \#* ]] && continue
    (( rows++ ))
    got=ok
    if _ghost_is_secret "$line"; then got=secret
    elif _ghost_is_destructive "$line"; then got=destructive; fi
    [[ $got == $verdict ]] || { print -r -- "       fixture: want $verdict, got $got: $line"; (( bad++ )) }
  done < $ROOT/terminal/tests/filter-cases.tsv
  (( rows > 50 && bad == 0 ))
) && ok "zsh filters match terminal/tests/filter-cases.tsv" || not_ok "zsh filters match terminal/tests/filter-cases.tsv"

(
  export LC_ALL=en_US.UTF-8
  GHOST_TERMINAL_LIB_ONLY=1 source $PLUGIN
  _ghost_json_str $'a"b\\c\td\x01'; [[ $REPLY == '"a\"b\\c\td"' ]] || exit 1
  _ghost_json_decode 'x \"y\" \\ '$'\\''u00e9 z" trailing' && [[ $REPLY == 'x "y" \ é z' ]]
) && ok "JSON encode/decode round-trips quotes, backslashes and unicode" || not_ok "JSON encode/decode round-trips quotes, backslashes and unicode"

(
  GHOST_TERMINAL_LIB_ONLY=1 source $PLUGIN
  # `path` is an array: once "0x0+s" reached arithmetic, zsh re-read the whole string (s) as an expression and ran
  # the command substitution in the subscript. A \u escape must now be 4 hex digits before anything evaluates it.
  u=$'\\'u   # backslash-u, spelled so that no editor or tool turns it into a real character
  _ghost_json_decode 'path[$(: > '$TMP/pwned')]'$u'0+s "' && exit 1
  _ghost_json_decode "a ${u}d83d\" x" && exit 1      # lone surrogate half
  _ghost_json_decode "a ${u}001b[31m\" x" && exit 1  # control character
  [[ ! -e $TMP/pwned ]]
) && ok "a malformed \\u escape from the server is refused and never evaluated" || not_ok "a malformed \\u escape from the server is refused and never evaluated"

(
  HISTSIZE=100
  GHOST_TERMINAL_LIB_ONLY=1 source $PLUGIN
  print -s 'gpg -c notes.txt'
  print -s 'correct horse battery staple'
  for i in {1..29}; do print -s "ls dir$i"; done
  print -s 'current'   # a non-interactive shell keeps its newest print -s entry out of $history
  _ghost_history_json || exit 1
  [[ $REPLY == '["ls dir1",'*'"ls dir29"]' && $REPLY != *horse* && $REPLY != *gpg* ]]
) && ok "the line after gpg stays out when gpg is just outside the 30-command window" || not_ok "the line after gpg stays out when gpg is just outside the 30-command window"

(
  HISTSIZE=100
  GHOST_TERMINAL_LIB_ONLY=1 source $PLUGIN
  GHOST_TERMINAL_URL=http://127.0.0.1:9   # nothing listens there: a request that is attempted answers "down"
  print -s 'pnpm test'; print -s 'gpg -c notes.txt'; print -s 'current'
  [[ $(_ghost_fetch 'correct horse' 0) == none && $(_ghost_fetch '' 0) == down ]]
) && ok "nothing typed right after gpg is sent as a prefix (no request at all)" || not_ok "nothing typed right after gpg is sent as a prefix (no request at all)"

(
  GHOST_TERMINAL_LIB_ONLY=1 source $PLUGIN
  mkdir -p $TMP/scripts && cd $TMP/scripts || exit 1
  print -r -- '{ "scripts": { "a": "echo {hi}", "b": "tsc \"}\" {", "bad name": "x", "c": "vite" }, "other": { "d": "e" } }' > package.json
  _ghost_scripts_json && [[ $REPLY == '["npm run a","npm run b","npm run c"]' ]]
) && ok "package.json scripts survive braces and escaped quotes inside a command" || not_ok "package.json scripts survive braces and escaped quotes inside a command"

# --------------------------------------------------------------------------------------------------------------
# 2. A stub server and an interactive zsh in a pty.

mkdir -p $WORK
print -r -- '{ "name": "demo", "scripts": { "test": "vitest", "build": "tsc -p ." } }' > $WORK/package.json
: > $WORK/pnpm-lock.yaml
print -r -- $'lib:\n\tcc -c lib.c' > $WORK/Makefile
: > $WORK/uniquefile_ghosttest.txt

STUB_LOG=$LOG node $ROOT/terminal/tests/stub-server.mjs > $TMP/port 2> $TMP/stub.err &
STUB_PID=$!
float deadline=$(( EPOCHREALTIME + 5 ))
while [[ ! -s $TMP/port ]] && (( EPOCHREALTIME < deadline )); do pause 5; done
PORT=$(<$TMP/port)
[[ $PORT == <1-65535> ]] || { print "FAIL - stub server did not start"; cat $TMP/stub.err; exit 1 }

cat > $TMP/setup.zsh <<EOF
PS1='GHOSTPROMPT> '
PROMPT_EOL_MARK=''
HISTSIZE=200
KEYTIMEOUT=5
unsetopt beep
GHOST_TERMINAL_URL=http://127.0.0.1:$PORT
GHOST_TERMINAL_DEBOUNCE=0.05
GHOST_TERMINAL_DEBUG_LOG=$TMP/debug.log
print -s 'pnpm install'
print -s 'pnpm build'
print -s 'export GHOST_TEST_TOKEN=abc123'
print -s 'pnpm test'
print -s 'git status'
print -s 'git add -A'
source $PLUGIN
_t_dump() { print -rn -- "\$BUFFER$SEP\$POSTDISPLAY$SEP\$CURSOR$SEP\$KEYMAP$SEP\${(j:;:)region_highlight}${SEP}END" >| $DUMP }
zle -N _t_dump
bindkey -M emacs '^Xd' _t_dump
bindkey -M viins '^Xd' _t_dump
bindkey -M vicmd '^Xd' _t_dump
cd $WORK
EOF

zpty GH "env -i HOME=$TMP PATH=${(q)PATH} TERM=xterm-256color LANG=en_US.UTF-8 zsh -f -i"

# Reads whatever the pty has written so far into $OUT (the shell must never block on a full pty).
drain() {
  local chunk
  while zpty -rt GH chunk 2>/dev/null; do OUT+=$chunk; done
  return 0
}
send() { zpty -w -n GH "$1"; drain }

# One snapshot of the line editor: D[B]uffer, D[P]ostdisplay, D[C]ursor, D[K]eymap, D[H]ighlight.
dump() {
  rm -f $DUMP
  send $'\C-xd'
  # The widget writes with a builtin (no fork, so a later ^C never lands in a child); END marks a complete write.
  local content=''
  float until=$(( EPOCHREALTIME + 2 ))
  while (( EPOCHREALTIME < until )); do
    [[ -f $DUMP ]] && content=$(<$DUMP) && [[ $content == *${SEP}END ]] && break
    pause 1
    drain
  done
  [[ $content == *${SEP}END ]] || return 1
  local -a f=("${(@ps:$SEP:)content}")
  D=(B "${f[1]-}" P "${f[2]-}" C "${f[3]-}" K "${f[4]-}" H "${f[5]-}")
}

# Polls until the condition (evaluated against $D) holds.
wait_for() {
  local cond=$1
  float until=$(( EPOCHREALTIME + ${2:-3} ))
  while (( EPOCHREALTIME < until )); do
    dump && eval "$cond" && return 0
    pause 3
  done
  return 1
}

wait_output() {
  local pattern=$1
  float until=$(( EPOCHREALTIME + ${2:-3} ))
  while (( EPOCHREALTIME < until )); do
    drain
    [[ $OUT == ${~pattern} ]] && return 0
    pause 1
  done
  return 1
}

fresh_line() { send $'\C-c'; wait_for '[[ -z $D[B] ]]' 2 >/dev/null; pause 5; drain }
requests() { [[ -f $LOG ]] && print -r -- ${#${(f)"$(<$LOG)"}} || print 0 }

send "source $TMP/setup.zsh"$'\r'

# A. After a command finishes, the ghost of the next command appears on the empty line, in gray.
if wait_for '[[ -z $D[B] && $D[P] == "pnpm test" ]]' 5; then ok "ghost appears on an empty prompt"; else not_ok "ghost appears on an empty prompt" "B=[$D[B]] P=[$D[P]]"; fi
[[ ";$D[H];" == *";0 9 fg=8;"* ]] && ok "the ghost is highlighted gray (fg=8)" || not_ok "the ghost is highlighted gray (fg=8)" "region_highlight=[$D[H]]"

# B. Typing asks again with the prefix; the suggestion appears after the cursor.
send "git c"
if wait_for '[[ $D[B] == "git c" && $D[P] == "ommit -m \"\"" ]]'; then ok "typing a prefix shows the matching ghost"; else not_ok "typing a prefix shows the matching ghost" "B=[$D[B]] P=[$D[P]]"; fi

# C. Typing along the ghost shrinks it without a new request.
integer before=$(requests)
send "o"
dump
expect_eq "typing along the ghost shrinks it" "$D[P]" 'mmit -m ""'
pause 30
expect_eq "typing along the ghost sends no new request" "$(requests)" "$before"

# D. Tab accepts: the text is inserted, the cursor lands inside the empty quotes, nothing runs.
send $'\t'
dump
expect_eq "Tab accepts the ghost into the buffer" "$D[B]" 'git commit -m ""'
expect_eq "the cursor lands inside the empty quotes" "$D[C]" 15
expect_eq "no ghost remains after accepting" "$D[P]" ""
[[ $OUT != *"nothing to commit"* && $OUT != *"not a git repository"* ]] && ok "Tab never executes the command" || not_ok "Tab never executes the command"

# E. Clearing the line brings the empty-line ghost back without a request.
send $'\C-u'
if wait_for '[[ -z $D[B] && $D[P] == "pnpm test" ]]' 2; then ok "an emptied line shows the empty-line ghost again"; else not_ok "an emptied line shows the empty-line ghost again" "P=[$D[P]]"; fi

# F. Typing that no longer matches clears the ghost at once.
send "git c"
wait_for '[[ $D[P] == "ommit -m \"\"" ]]' >/dev/null
send "x"
dump
expect_eq "typing that diverges clears the ghost immediately" "$D[P]" ""
send $'\C-u'

# G. Tab with no ghost still completes (expand-or-complete, the widget bound before the plugin loaded).
send "cat uniq"
pause 40
dump
expect_eq "no ghost for an unknown prefix" "$D[P]" ""
send $'\t'
if wait_for '[[ $D[B] == "cat uniquefile_ghosttest.txt"* ]]' 2; then ok "Tab without a ghost still completes"; else not_ok "Tab without a ghost still completes" "B=[$D[B]]"; fi
fresh_line

# H. Esc dismisses for the rest of this line.
send "git c"
wait_for '[[ $D[P] == "ommit -m \"\"" ]]' >/dev/null
send $'\e'
pause 20
dump
expect_eq "Esc dismisses the ghost" "$D[P]" ""
send "o"
pause 40
dump
expect_eq "the ghost stays dismissed for this line" "$D[P]" ""
fresh_line

# I. Right arrow at the end of the line accepts.
send "git c"
wait_for '[[ $D[P] == "ommit -m \"\"" ]]' >/dev/null
send $'\e[C'
dump
expect_eq "Right arrow at the end of the line accepts" "$D[B]" 'git commit -m ""'
fresh_line

# J. Suggestions that are destructive or contain control characters are never shown, whatever the server says.
send "rm"
pause 50
dump
expect_eq "a destructive suggestion from the server is never shown" "$D[P]" ""
[[ $(<$LOG) == *'"prefix":"rm"'* ]] && ok "(the server was asked and did suggest it)" || not_ok "(the server was asked and did suggest it)"
send $'\C-u'"printf"
pause 50
dump
expect_eq "a suggestion with a control character is never shown" "$D[P]" ""
fresh_line

# K. Quotes, backslashes and unicode survive the round trip exactly.
send 'echo "a'
if wait_for '[[ -n $D[P] ]]'; then
  send $'\t'
  dump
  expect_eq "a quoted, escaped, unicode ghost is inserted exactly" "$D[B]" 'echo "a \"quoted\" \\ back ünï"'
else
  not_ok "a quoted, escaped, unicode ghost is inserted exactly" "no ghost for [echo \"a]"
fi
fresh_line

# K2. Nothing typed right after gpg / ssh-keygen / security ... is sent, not even a prefix the server would answer.
send "print -s 'gpg -c notes.txt'"$'\r'
wait_for '[[ -z $D[B] && $D[P] == "pnpm test" ]]' 3 >/dev/null   # the empty line is still asked about
integer before_gpg=$(requests)
send "git c"
pause 50
dump
expect_eq "no ghost for a line typed right after gpg" "$D[P]" ""
expect_eq "a line typed right after gpg is never sent" "$(requests)" "$before_gpg"
fresh_line
send "true"$'\r'
pause 30

# L. Bracketed paste still works.
send $'\e[200~echo pasted\e[201~'
dump
expect_eq "bracketed paste inserts the pasted text" "$D[B]" "echo pasted"
fresh_line

# M. GHOST_TERMINAL_DISABLE=1 turns it off at runtime.
send "GHOST_TERMINAL_DISABLE=1"$'\r'
pause 60
send "git c"
pause 40
dump
expect_eq "GHOST_TERMINAL_DISABLE=1 shows no ghost" "$D[P]" ""
fresh_line
send "unset GHOST_TERMINAL_DISABLE"$'\r'
pause 30

# N. vi mode: Tab accepts in insert mode, Esc still enters command mode and takes the ghost away.
send "bindkey -v"$'\r'
pause 30
send "git c"
if wait_for '[[ $D[P] == "ommit -m \"\"" ]]'; then
  send $'\t'
  dump
  expect_eq "vi insert mode: Tab accepts" "$D[B]" 'git commit -m ""'
else
  not_ok "vi insert mode: Tab accepts" "no ghost in viins: B=[$D[B]] P=[$D[P]]"
fi
send $'\C-u'"git c"
wait_for '[[ -n $D[P] ]]' >/dev/null
send $'\e'
pause 20
dump
expect_eq "vi mode: Esc still switches to command mode" "$D[K]" "vicmd"
expect_eq "vi mode: entering command mode hides the ghost" "$D[P]" ""
fresh_line
send "bindkey -e"$'\r'
pause 30

# O. Completion through compsys (compinit) is preserved too.
send "autoload -Uz compinit && compinit -u -D"$'\r'
pause 80
fresh_line
send "cat uniq"
pause 40
send $'\t'
if wait_for '[[ $D[B] == "cat uniquefile_ghosttest.txt"* ]]' 3; then ok "Tab without a ghost still completes under compinit"; else not_ok "Tab without a ghost still completes under compinit" "B=[$D[B]]"; fi
fresh_line

# P. A slow server never delays the prompt or typing.
curl -q -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"sleepMs":3000}' "http://127.0.0.1:$PORT/control"
OUT=''
float started=$EPOCHREALTIME
send 'echo slow-$((6*7))'$'\r'
if wait_output '*slow-42*GHOSTPROMPT> *' 3; then
  float took=$(( EPOCHREALTIME - started ))
  (( took < 1.0 )) && ok "the prompt returns at once while the server sleeps 3 s ($(printf %.2f $took) s)" || not_ok "the prompt returns at once while the server sleeps 3 s" "took $took s"
else
  not_ok "the prompt returns at once while the server sleeps 3 s" "no prompt within 3 s"
fi
started=$EPOCHREALTIME
send "git c"
dump
float typed=$(( EPOCHREALTIME - started ))
[[ $D[B] == "git c" ]] && (( typed < 0.5 )) && ok "typing is not blocked by a slow server" || not_ok "typing is not blocked by a slow server" "B=[$D[B]] after $(printf %.2f $typed) s"
fresh_line
curl -q -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"sleepMs":0}' "http://127.0.0.1:$PORT/control"

# Q. What was sent: basename only, secrets never, project scripts found.
content=$(<$LOG)
first=${${(f)content}[1]}
[[ $content != *GHOST_TEST_TOKEN* && $content != *abc123* ]] && ok "a secret-looking history line is never sent" || not_ok "a secret-looking history line is never sent"
integer lines=${#${(f)content}} basename_only=${#${(M)${(f)content}:#*'"cwd":"work-dir"'*}}
(( lines > 0 && basename_only == lines )) && ok "every request carries the directory basename only ($lines requests)" || not_ok "every request carries the directory basename only" "$basename_only of $lines"
[[ $content != *"\"cwd\":\"$TMP"* ]] && ok "the full path of the directory is never the cwd" || not_ok "the full path of the directory is never the cwd"
[[ $first == *'"pnpm install","pnpm build","pnpm test","git status","git add -A"]'* ]] && ok "history is sent oldest first, filtered" || not_ok "history is sent oldest first, filtered" "$first"
[[ $content == *'"projectScripts":["pnpm test","pnpm build","make lib"]'* ]] && ok "package.json scripts and Makefile targets become project scripts" || not_ok "package.json scripts and Makefile targets become project scripts"
[[ $content == *'"lastExitCode":0'* ]] && ok "the last exit status is sent" || not_ok "the last exit status is sent"
debug_log=$(<$TMP/debug.log)
[[ -n $debug_log && $debug_log != *(git|pnpm|echo|commit)* ]] && ok "the debug log holds counts and statuses only, never commands" || not_ok "the debug log holds counts and statuses only, never commands"

# U. A hostile server cannot make the plugin run anything: the job that fetches refuses a \u escape that is not 4 hex
#    digits before any arithmetic sees it (it used to run the command substitution in `path[$(...)]`).
curl -q -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"rawCommand":"path[$(: > '$TMP/pwned-fetch')]\\u0+s "}' "http://127.0.0.1:$PORT/control"
hostile=$(cd $WORK && GHOST_TERMINAL_LIB_ONLY=1 GHOST_TERMINAL_URL=http://127.0.0.1:$PORT zsh -f -c 'source $1; _ghost_fetch "" 0' _ $PLUGIN)
curl -q -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"rawCommand":null}' "http://127.0.0.1:$PORT/control"
[[ $hostile == none && ! -e $TMP/pwned-fetch ]] && ok "a hostile server's reply is refused and runs nothing" || not_ok "a hostile server's reply is refused and runs nothing" "reply=[$hostile] marker=$([[ -e $TMP/pwned-fetch ]] && print created || print absent)"

# S. End to end against the REAL server (heuristic provider forced, no .env, zero network): the real route accepts
#    what the plugin sends and the heuristic's `git commit -m ""` after `git add -A` (0.8) clears the 0.7 gate.
TSX=$ROOT/server/node_modules/.bin/tsx
if [[ -x $TSX ]]; then
  env -i PATH=$PATH HOME=$TMP PORT=0 SHABANG_PROVIDER=heuristic $TSX $ROOT/server/src/index.ts > $TMP/server.out 2>&1 &
  integer SERVER_PID=$!
  REAL_PORT=''
  deadline=$(( EPOCHREALTIME + 15 ))
  while [[ -z $REAL_PORT ]] && (( EPOCHREALTIME < deadline )); do
    [[ -f $TMP/server.out && $(<$TMP/server.out) =~ 'http://127\.0\.0\.1:([0-9]+)' ]] && REAL_PORT=$match[1]
    pause 10
  done
  if [[ -n $REAL_PORT ]]; then
    send "fc -p; print -s 'pnpm test'; print -s 'git add -A'; GHOST_TERMINAL_URL=http://127.0.0.1:$REAL_PORT"$'\r'
    if wait_for '[[ -z $D[B] && $D[P] == "git commit -m \"\"" ]]' 5; then ok "end to end with the real server: the ghost appears"; else not_ok "end to end with the real server: the ghost appears" "P=[$D[P]] server: $(tail -3 $TMP/server.out)"; fi
    send $'\t'
    dump
    expect_eq "end to end with the real server: Tab accepts" "$D[B]" 'git commit -m ""'
    fresh_line
    send "fc -P; GHOST_TERMINAL_URL=http://127.0.0.1:$PORT"$'\r'
    pause 30
  else
    not_ok "end to end with the real server" "the server did not start: $(tail -3 $TMP/server.out)"
  fi
  pkill -P $SERVER_PID 2>/dev/null
  kill $SERVER_PID 2>/dev/null
  wait $SERVER_PID 2>/dev/null
  if [[ -n $REAL_PORT ]]; then
    pause 20
    curl -q -s -o /dev/null --max-time 1 "http://127.0.0.1:$REAL_PORT/v1/health" && not_ok "the real server was stopped" || ok "the real server was stopped (nothing left listening)"
  fi
else
  print -r -- "skip - end to end with the real server (run pnpm install first)"
fi

# R. A server that is down is a silent no-op.
kill $STUB_PID 2>/dev/null
wait $STUB_PID 2>/dev/null
STUB_PID=0
OUT=''
send 'echo down-$((6*7))'$'\r'
wait_output '*down-42*GHOSTPROMPT> *' 3 >/dev/null
send "git c"
pause 50
dump
expect_eq "no ghost while the server is down" "$D[P]" ""
drain
[[ $OUT != *(curl|refused|Connection|failed|error)* ]] && ok "the server being down prints nothing" || not_ok "the server being down prints nothing" "${(V)OUT}"
fresh_line

# T. Unusual user options do not break loading, the prompt or Tab.
zpty OPTS "env -i HOME=$TMP PATH=${(q)PATH} TERM=xterm-256color zsh -f -i"
zpty -w -n OPTS "setopt nounset ksharrays shwordsplit; GHOST_TERMINAL_URL=http://127.0.0.1:9; source $PLUGIN && print LOADED-\$((40+2))"$'\r'
zpty -w -n OPTS $'git st\t\C-u'"print DONE-\$((6*7))"$'\r'
opts_out=''
deadline=$(( EPOCHREALTIME + 5 ))
while (( EPOCHREALTIME < deadline )) && [[ $opts_out != *DONE-42* ]]; do
  while zpty -rt OPTS chunk 2>/dev/null; do opts_out+=$chunk; done
  pause 5
done
zpty -d OPTS
[[ $opts_out == *LOADED-42*DONE-42* && $opts_out != *(parameter not set|bad substitution|command not found|no such)* ]] && ok "loads and runs under nounset, ksharrays and shwordsplit" || not_ok "loads and runs under nounset, ksharrays and shwordsplit" "${(V)opts_out[-300,-1]}"

print -r -- "terminal ghost: $passed passed, $failed failed"
(( failed == 0 ))
