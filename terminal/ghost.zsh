# Shabang for the terminal: predicts your next shell command and shows it as gray text after the cursor.
#
#   Tab          accepts the ghost, but ONLY while one is visible; otherwise Tab does exactly what it did before
#   Right arrow  at the end of the line accepts too (the usual autosuggestion convention)
#   Esc          dismisses the ghost for the rest of this command line
#
# Accepting only inserts text into the line. Nothing ever runs by itself: Enter stays yours.
#
#   source /path/to/htn2026/terminal/ghost.zsh   # in ~/.zshrc, AFTER plugins that rebind Tab (fzf, zsh-autosuggestions)
#
# GHOST_TERMINAL_URL             prediction server, default http://127.0.0.1:8787 (pnpm --filter @ghost/server start)
# GHOST_TERMINAL_DISABLE=1       turns it off (checked at load and before every request)
# GHOST_TERMINAL_MIN_CONFIDENCE  default 0.7: a wrong ghost is worse than no ghost
# GHOST_TERMINAL_HIGHLIGHT       default fg=8 (gray)
#
# Privacy: only the directory's basename is sent (~ for home), history lines that look like secrets are dropped here
# before anything leaves the shell (the server drops them again), the body goes to curl on stdin (never argv), and a
# server that is down is a silent no-op. See terminal/README.md.

zmodload zsh/parameter 2>/dev/null   # $history, $commands
zmodload zsh/system 2>/dev/null      # $sysparams[pid] of the background job
zmodload zsh/datetime 2>/dev/null    # $EPOCHSECONDS
zmodload zsh/zselect 2>/dev/null     # fork-free debounce

# ---------------------------------------------------------------------------------------------------------------
# Safety filters. Same rules as server/src/command/filter.ts; terminal/tests/filter-cases.tsv pins both.

# True (status 0) when the line must never leave the shell.
_ghost_is_secret() {
  emulate -L zsh
  local LC_ALL=C line=$1 re
  [[ $line == *$'\n'* || $line == *$'\r'* ]] && return 0
  (( $#line > 300 )) && return 0
  _ghost_is_secret_command "$line" && return 0
  local w='(key|token|secret|password|passwd|passphrase|pass|pwd|credential)'
  local -a insensitive=(
    '(^|[^a-z0-9_])(export|set|setenv|typeset|declare|local|readonly|env)[[:space:]]+(-[a-z]+[[:space:]]+)*[a-z0-9_]*'$w
    '[a-z0-9_]*'$w'[a-z0-9_]*='
    '--[a-z0-9-]*(password|passwd|token|secret|api-?key|passphrase|pass|pwd|auth)([[:space:]]|=|$)'
    '(^|[^a-z0-9_-])(curl|wget|http|https|xh)[[:space:]]([^;&|]*[[:space:]])?(-u|-a|--user|--proxy-user)([[:space:]]*|=)[^[:space:]:=-][^[:space:]:]*:[^[:space:]]'
    'authorization:'
    'bearer[[:space:]]'
    '(x-api-key|api-key|x-auth-token|cookie)[[:space:]]*:'
    '[a-z][a-z0-9+.-]*://[^/[:space:]:@]+:[^/[:space:]@]+@'
    '-----begin'
    'private key'
    'akia[0-9a-z]{16}'
    '(^|[^a-z0-9])(sk|pk|rk)-[a-z0-9_-]{16,}'
    '(ghp|gho|ghu|ghs|ghr)_[a-z0-9]{16,}'
    'github_pat_'
    'glpat-'
    'xox[abprs]-'
    'npm_[a-z0-9]{20,}'
  )
  local -a sensitive=(
    '(^|[[:space:]])-p[^[:space:]]+'
    '(^|[[:space:]])login[[:space:]]([^;&|]*[[:space:]])?-p[[:space:]]+[^[:space:]]'
    '(^|[^a-z0-9_-])(mysql|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlsh|mariadb|mariadb-dump|mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport)[[:space:]]([^;&|]*[[:space:]])?-p[[:space:]]+[^[:space:]-]'
    '(^|[^a-z0-9_-])redis-cli[[:space:]]([^;&|]*[[:space:]])?-a[[:space:]]+[^[:space:]]'
    '(^|[[:space:]])-pass(in|out)?[[:space:]]+[^[:space:]]'
    '(^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}'
  )
  for re in $sensitive; do [[ $line =~ $re ]] && return 0; done
  setopt localoptions nocasematch
  for re in $insensitive; do [[ $line =~ $re ]] && return 0; done
  unsetopt nocasematch
  _ghost_has_blob "$line"
}

# ssh-keygen, gpg, sshpass, security find-generic-password: that line AND the command after it are dropped.
_ghost_is_secret_command() {
  emulate -L zsh
  setopt localoptions nocasematch
  local LC_ALL=C
  [[ $1 =~ '(^|[^a-z0-9_-])(ssh-keygen|gpg2?|sshpass)([[:space:]]|$)' ]] && return 0
  [[ $1 =~ '(^|[^a-z0-9_-])security[[:space:]]+(find|add|delete|set)-(generic|internet)-password' ]]
}

# Long base64 / hex runs. Runs are split at / = - first, so ordinary paths, flags and branch names survive.
_ghost_has_blob() {
  emulate -L zsh
  setopt localoptions extendedglob
  local LC_ALL=C rest=$1 run piece alnum stretches
  while [[ $rest =~ '[A-Za-z0-9+/=_-]{24,}' ]]; do
    run=$MATCH
    rest=${rest[MEND+1,-1]}
    [[ $run =~ '[0-9a-fA-F]{24,}' ]] && return 0
    [[ $run =~ '[A-Za-z0-9]{20,}={1,2}$' ]] && return 0
    [[ $run == *+* && $run == *[0-9]* && $run == *[A-Za-z]* ]] && return 0
    for piece in ${(s:/:)${run//[=-]//}}; do
      (( $#piece >= 24 )) && [[ $piece == *[0-9]* && $piece == *[A-Za-z]* ]] && return 0
    done
    for piece in ${(s:/:)${run//=//}}; do
      (( $#piece >= 32 )) && [[ $piece == *[0-9]* && $piece == *[a-z]* && $piece == *[A-Z]* ]] && return 0
    done
    # Random-looking even when "/" splits it into short pieces (an AWS secret access key): 30+ letters and digits of
    # all three kinds that change between upper case, lower case and digit every 3 characters or less on average.
    alnum=${run//[^A-Za-z0-9]/}
    if (( $#alnum >= 30 )) && [[ $alnum == *[A-Z]* && $alnum == *[a-z]* && $alnum == *[0-9]* ]]; then
      stretches=${${${${run//[A-Z]##/U}//[a-z]##/l}//[0-9]##/d}//[^Uld]/}
      (( $#alnum < 3 * $#stretches )) && return 0
    fi
  done
  return 1
}

# Defense in depth: even if a server suggested it, these are never shown. Over-blocking is fine.
_ghost_is_destructive() {
  emulate -L zsh
  local LC_ALL=C c=$1 re
  local s='(^|[;&|(){}`[:space:]])' a='[[:space:]]([^;&|]*[[:space:]])?' e='([[:space:]]|$)'
  local -a rules=(
    $s'(sudo|doas|dd|newfs|killall|pkill|shred|srm|wipefs|shutdown|reboot|halt|poweroff|mkfs[^[:space:]]*)'$e
    $s'rm'$a'-(-recursive|-force|[a-z]*[rf][a-z]*)'$e
    'git'$a'push'$a'(-[a-z]*[fd][a-z]*|--force[^[:space:]]*|--mirror|--delete|--prune|[\'\''"]*[+:][^[:space:]]+)'$e
    'git'$a'reset'$a'--(hard|merge)'
    'git'$a'clean'$a'(-[a-z]*f|--force)'
    'git'$a'branch'$a'-[a-z]*d'
    'git'$a'checkout'$a'(-f|--force)'$e
    'git'$a'checkout'$a'--[[:space:]]+\.'$e
    'git'$a'stash[[:space:]]+(clear|drop)'
    'git'$a'(filter-branch|filter-repo)'
    'git'$a'reflog[[:space:]]+(expire|delete)'
    'chmod'$a'-[a-z]*r[a-z]*'$a'(0?777|a\+rwx|ugo\+rwx)'$e
    'chmod'$a'(0?777|a\+rwx|ugo\+rwx)'$a'-[a-z]*r'
    '(^|[^a-z0-9_])drop[[:space:]]+(table|database|schema|index|view|user|role|collection)([^a-z0-9_]|$)'
    '(^|[^a-z0-9_])(truncate|dropdb|dropdatabase)([^a-z0-9_]|$)'
    'kubectl'$a'delete'
    '(terraform|tofu|terragrunt)'$a'-?destroy'
    '(docker|podman|docker-compose)'$a'prune'
    '(docker|docker-compose)'$a'down'$a'(-v|--volumes)'$e
    $s'kill'$a'-(9|kill|sigkill)'$e
    $s'find'$a'-delete'
    'diskutil'$a'(erase|zerodisk|partitiondisk)'
    '(npm|pnpm|yarn)'$a'(un)?publish'
    '(^|[^a-z0-9_-])gh'$a'delete'
    '(curl|wget)[^|;&]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z|da|k)?sh([^a-z0-9_]|$)'
    '>[[:space:]]*/dev/(r?disk|sd|hd|nvme)'
    ':\(\)[[:space:]]*\{'
    '(^|[^a-z0-9_])mv[[:space:]][^;&|]*[[:space:]]/dev/null'
  )
  setopt localoptions nocasematch
  for re in $rules; do [[ $c =~ $re ]] && return 0; done
  return 1
}

# ---------------------------------------------------------------------------------------------------------------
# Request building (runs in the background job, never in front of the prompt).

# JSON string literal in $REPLY. Tabs are escaped, other control characters dropped.
_ghost_json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//[[:cntrl:]]/}
  REPLY="\"$s\""
}

# Decodes the JSON string that starts right after its opening quote into $REPLY. Status 1 when unterminated or
# malformed. The text comes from the network: none of it may reach arithmetic, eval or a format string, so a \u
# escape must be exactly 4 hex digits before (#) evaluates it; control characters and lone surrogates are refused.
_ghost_json_decode() {
  emulate -L zsh
  local s=$1 out='' c hex
  integer i=1 n=$#1
  while (( i <= n )); do
    c=$s[i]
    if [[ $c == '"' ]]; then
      REPLY=$out
      return 0
    fi
    if [[ $c == '\' ]]; then
      (( i++ ))
      c=$s[i]
      case $c in
        (n) out+=$'\n' ;;
        (t) out+=$'\t' ;;
        (r) out+=$'\r' ;;
        (b|f) ;;
        (u)
          hex=${s[i+1,i+4]}
          [[ $hex == [0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f] ]] || return 1
          [[ $hex == 00[01]? || $hex == 007[Ff] || $hex == [Dd][89A-Fa-f]?? ]] && return 1
          out+=${(#):-0x$hex}
          (( i += 4 ))
          ;;
        (*) out+=$c ;;
      esac
    else
      out+=$c
    fi
    (( i++ ))
  done
  return 1
}

# The last 30 history entries, oldest first, filtered, as a JSON array in $REPLY. Status 1 when the newest entry is
# a secret command (ssh-keygen, gpg, ...): whatever is typed next is the command right after it, and is not sent.
_ghost_history_json() {
  emulate -L zsh
  setopt localoptions extendedglob
  local -a keys lines
  local k line
  integer skip=0 after_secret=0 lookbehind
  keys=(${(Onk)history})
  # One entry more than is sent: it only says whether the first entry sent follows a secret command.
  keys=(${(on)keys[1,31]})
  lookbehind=$(( $#keys > 30 ))
  for k in $keys; do
    line=$history[$k]
    after_secret=$skip
    line=${${line##[[:space:]]##}%%[[:space:]]##}
    _ghost_is_secret_command "$line" && skip=1 || skip=0
    (( lookbehind )) && { lookbehind=0; continue }
    (( after_secret )) && continue
    [[ $history[$k] == [[:space:]]* ]] && continue   # a leading space asks to keep the command out of history
    [[ -z $line ]] && continue
    _ghost_is_secret "$line" && continue
    _ghost_json_str "$line"
    lines+=("$REPLY")
  done
  REPLY="[${(j:,:)lines}]"
  (( ! skip ))
}

# {branch, dirty, ahead, behind, untracked} in $REPLY, status 1 outside a git work tree.
_ghost_git_json() {
  emulate -L zsh
  REPLY=''
  (( $+commands[git] )) || return 1
  local out line ab branch='' dirty=false
  integer ahead=0 behind=0 untracked=0
  out=$(GIT_OPTIONAL_LOCKS=0 command git status --porcelain=v2 --branch 2>/dev/null) || return 1
  for line in ${(f)out}; do
    case $line in
      ('# branch.head '*) branch=${line#'# branch.head '} ;;
      ('# branch.ab '*) ab=${line#'# branch.ab '}; ahead=${${ab%% *}#+}; behind=${${ab##* }#-} ;;
      ('#'*|'! '*) ;;
      ('? '*) (( untracked++ )) ;;
      (*) dirty=true ;;
    esac
  done
  [[ $branch == '(detached)' ]] && branch=''
  _ghost_is_secret "$branch" && branch=''
  _ghost_json_str "$branch"
  REPLY="{\"branch\":$REPLY,\"dirty\":$dirty,\"ahead\":$ahead,\"behind\":$behind,\"untracked\":$untracked}"
}

# package.json scripts and Makefile targets of the current directory as runnable commands, JSON array in $REPLY.
_ghost_scripts_json() {
  emulate -L zsh
  REPLY=''
  local -a found out small
  local pm=npm json block name line s
  integer pairs=0
  small=(package.json(N.L-262144))
  if (( $#small )); then
    [[ -f pnpm-lock.yaml ]] && pm=pnpm
    [[ -f yarn.lock ]] && pm=yarn
    [[ -f bun.lockb || -f bun.lock ]] && pm=bun
    json=$(<package.json)
    if [[ $json =~ '"scripts"[[:space:]]*:[[:space:]]*\{' ]]; then
      block=${json[MEND+1,-1]}
      # One "name": "command" pair at a time, string-aware, so a brace or an escaped quote inside a command does not
      # end the scripts object early. Stops at its closing brace (or anything that is not such a pair).
      while (( $#found < 20 && pairs++ < 100 )) \
        && [[ $block =~ '^[[:space:],]*"((\\.|[^"\\])*)"[[:space:]]*:[[:space:]]*"(\\.|[^"\\])*"' ]]; do
        name=$match[1]
        block=${block[MEND+1,-1]}
        [[ $name =~ '^[A-Za-z0-9:_.-]+$' ]] || continue
        if [[ $name == (test|start) || $pm != npm ]]; then found+=("$pm $name"); else found+=("npm run $name"); fi
      done
    fi
  fi
  small=(Makefile(N.L-262144))
  if (( $#small )); then
    integer targets=0
    for line in ${(f)"$(<Makefile)"}; do
      (( targets >= 20 )) && break
      [[ $line =~ '^([A-Za-z0-9][A-Za-z0-9_.-]*)[[:space:]]*:([^=]|$)' ]] || continue
      found+=("make $match[1]")
      (( targets++ ))
    done
  fi
  for s in $found; do
    _ghost_is_secret "$s" && continue
    _ghost_json_str "$s"
    out+=("$REPLY")
  done
  (( $#out )) || return 1
  REPLY="[${(j:,:)out}]"
}

# The JSON body in $REPLY. Status 1 (nothing to send) when something is typed right after a secret command.
_ghost_request_body() {
  emulate -L zsh
  local prefix=$1 code=$2 cwd=${PWD:t}
  local -a parts
  [[ $PWD == "$HOME" ]] && cwd='~'
  [[ $PWD == / ]] && cwd='/'
  _ghost_is_secret "$cwd" && cwd=''
  _ghost_json_str "$cwd"; parts+=("\"cwd\":$REPLY")
  _ghost_history_json || [[ -z $prefix ]] || return 1
  parts+=("\"history\":$REPLY")
  if [[ -n $prefix ]]; then _ghost_json_str "$prefix"; parts+=("\"prefix\":$REPLY"); fi
  [[ $code == <0-255> ]] && parts+=("\"lastExitCode\":$code")
  _ghost_git_json && parts+=("\"git\":$REPLY")
  _ghost_scripts_json && parts+=("\"projectScripts\":$REPLY")
  REPLY="{${(j:,:)parts}}"
}

# Background job: ask the server, print "ok<TAB>command", "none" or "down". Only single-line, confident, safe
# suggestions that extend the prefix get through.
_ghost_fetch() {
  emulate -L zsh
  local prefix=$1 code=$2 response conf cmd
  _ghost_request_body "$prefix" "$code" || { print -rn -- none; return }
  # -q ignores ~/.curlrc; the body goes through stdin so history never shows up in `ps`.
  response=$(print -rn -- "$REPLY" | command curl -q -s --noproxy '*' --max-time "${GHOST_TERMINAL_TIMEOUT:-2}" \
    -H 'Content-Type: application/json' --data-binary @- "${GHOST_TERMINAL_URL:-http://127.0.0.1:8787}/v1/predict/command" 2>/dev/null)
  case $? in
    (0) ;;
    (7) print -rn -- down; return ;;
    (*) print -rn -- none; return ;;
  esac
  if [[ $response =~ '"confidence":(-?[0-9.]+([eE][-+]?[0-9]+)?)' ]]; then conf=$match[1]; else print -rn -- none; return; fi
  if [[ $response != *'"command":"'* ]] || ! _ghost_json_decode "${response#*\"command\":\"}"; then print -rn -- none; return; fi
  cmd=$REPLY
  if [[ -z $cmd || $cmd == *[[:cntrl:]]* || $cmd != "$prefix"?* ]] || (( conf < ${GHOST_TERMINAL_MIN_CONFIDENCE:-0.7} )) \
    || _ghost_is_secret "$cmd" || _ghost_is_destructive "$cmd"; then
    print -rn -- none
    return
  fi
  print -rn -- "ok"$'\t'"$cmd"
}

# Tests load only the functions above.
(( ${+GHOST_TERMINAL_LIB_ONLY} )) && return 0

# ---------------------------------------------------------------------------------------------------------------
# Line editor integration. Needs an interactive zsh with ZLE.

[[ -o interactive && -o zle ]] || return 0
[[ ${GHOST_TERMINAL_DISABLE:-0} == (0|) ]] || return 0
(( ${+_ghost_loaded} )) && return 0
typeset -g _ghost_loaded=1

autoload -Uz add-zle-hook-widget is-at-least

typeset -g _ghost_fd='' _ghost_pid='' _ghost_req_prefix='' _ghost_suggestion='' _ghost_shown='' _ghost_hl=''
typeset -g _ghost_last_buffer='' _ghost_empty='' _ghost_exit=0 _ghost_fork_workaround=0
typeset -gi _ghost_dismissed=0 _ghost_down_until=0 _ghost_owed=0
typeset -gA _ghost_orig
is-at-least 5.8 || _ghost_fork_workaround=1

_ghost_enabled() { emulate -L zsh; [[ ${GHOST_TERMINAL_DISABLE:-0} == (0|) ]] }

# GHOST_TERMINAL_DEBUG_LOG=<file>: one line per event, counts and statuses only (never a command or typed text).
_ghost_debug() { [[ -n ${GHOST_TERMINAL_DEBUG_LOG:-} ]] && print -r -- "${EPOCHREALTIME:-} $*" >> $GHOST_TERMINAL_DEBUG_LOG; return 0 }

_ghost_cancel() {
  emulate -L zsh
  if [[ -n $_ghost_fd ]]; then
    zle -F $_ghost_fd 2>/dev/null
    exec {_ghost_fd}<&-
    _ghost_fd=''
  fi
  if [[ -n $_ghost_pid ]]; then
    kill -TERM -$_ghost_pid 2>/dev/null || kill -TERM $_ghost_pid 2>/dev/null
    _ghost_pid=''
  fi
}

# Starts the background request; its answer arrives through `zle -F`, so the prompt never waits for it.
_ghost_start() {
  emulate -L zsh
  local prefix=$1 delay=$2 code=$_ghost_exit
  integer ticks=$(( ${delay:-0} * 100 ))
  _ghost_cancel
  (( _ghost_dismissed )) && { _ghost_debug "skip dismissed"; return }
  _ghost_enabled || { _ghost_debug "skip disabled"; return }
  (( ${EPOCHSECONDS:-0} < _ghost_down_until )) && { _ghost_debug "skip server-down"; return }
  _ghost_debug "start prefix_chars=$#prefix ticks=$ticks"
  _ghost_req_prefix=$prefix
  exec {_ghost_fd}< <(
    exec 2>/dev/null   # the job never prints to the terminal
    print -r -- ${sysparams[pid]:-}
    if (( ticks > 0 )); then
      if (( $+builtins[zselect] )); then zselect -t $ticks; else command sleep $delay; fi
    fi
    _ghost_fetch "$prefix" "$code"
  )
  (( _ghost_fork_workaround )) && command true
  read -r -u $_ghost_fd _ghost_pid
  zle -F $_ghost_fd _ghost_on_response
}

_ghost_on_response() {
  emulate -L zsh
  local fd=$1 reply=''
  [[ -z $2 || $2 == hup ]] && IFS='' read -rd '' -u $fd reply
  zle -F $fd
  exec {fd}<&-
  if [[ $fd == $_ghost_fd ]]; then
    _ghost_fd=''
    _ghost_pid=''
  fi
  _ghost_debug "response event=${2:-data} reply=${reply%%$'\t'*} chars=$#reply"
  case $reply in
    (down) _ghost_down_until=$(( ${EPOCHSECONDS:-0} + 10 )) ;;
    (ok$'\t'?*)
      [[ -z $_ghost_req_prefix ]] && _ghost_empty=${reply#ok$'\t'}
      zle _ghost_show -- "${reply#ok$'\t'}"
      ;;
  esac
}

# Draws (or clears) the ghost for the current buffer. Leaves a POSTDISPLAY it did not write alone
# (zsh-autosuggestions uses the same slot).
_ghost_render() {
  emulate -L zsh
  local want=''
  if [[ -n $_ghost_hl ]]; then
    region_highlight=("${(@)region_highlight:#${(b)_ghost_hl}}")
    _ghost_hl=''
  fi
  if (( ! _ghost_dismissed )) && _ghost_enabled && [[ -n $_ghost_suggestion && $CURSOR -eq $#BUFFER && $_ghost_suggestion == "$BUFFER"?* ]]; then
    want=${_ghost_suggestion#"$BUFFER"}
  fi
  if [[ -n $want && ( -z $POSTDISPLAY || $POSTDISPLAY == "$_ghost_shown" ) ]]; then
    POSTDISPLAY=$want
    _ghost_shown=$want
    _ghost_hl="$#BUFFER $(( $#BUFFER + $#want )) ${GHOST_TERMINAL_HIGHLIGHT:-fg=8}"
    region_highlight+=("$_ghost_hl")
  elif [[ -n $_ghost_shown ]]; then
    [[ $POSTDISPLAY == "$_ghost_shown" ]] && POSTDISPLAY=''
    _ghost_shown=''
  fi
}

_ghost_visible() {
  emulate -L zsh
  [[ -n $_ghost_shown && $POSTDISPLAY == "$_ghost_shown" && $CURSOR -eq $#BUFFER ]]
}

_ghost_show() {
  emulate -L zsh
  (( _ghost_dismissed )) && return
  _ghost_suggestion=$1
  _ghost_render
  zle -R
}

# Inserts the ghost. Never runs it.
_ghost_accept() {
  emulate -L zsh
  local full=$BUFFER$POSTDISPLAY
  _ghost_cancel
  POSTDISPLAY=''
  _ghost_shown=''
  _ghost_suggestion=''
  BUFFER=$full
  CURSOR=$#BUFFER
  [[ $full == *'""' || $full == *"''" ]] && (( CURSOR-- ))   # land inside git commit -m ""
  _ghost_last_buffer=$BUFFER
  _ghost_render
}

_ghost_dismiss() {
  emulate -L zsh
  _ghost_dismissed=1
  _ghost_cancel
  _ghost_suggestion=''
  _ghost_render
}

# Calls whatever the key did before Shabang was loaded, in the keymap the key was pressed in.
_ghost_call_orig() {
  emulate -L zsh
  local which=$1 km=$KEYMAP widget
  if [[ $km == main ]]; then
    [[ "$(bindkey -lL main)" == *viins* ]] && km=viins || km=emacs
  fi
  widget=${_ghost_orig[$which:$km]:-${_ghost_orig[$which:emacs]:-}}
  if [[ -z $widget ]]; then
    case $which in
      (tab) widget=expand-or-complete ;;
      (right) [[ $km == viins ]] && widget=vi-forward-char || widget=forward-char ;;
      (*) return 0 ;;
    esac
  fi
  [[ $widget == undefined-key ]] && return 0
  zle $widget
}

_ghost_tab() { emulate -L zsh; if _ghost_visible; then _ghost_accept; else _ghost_call_orig tab; fi }
_ghost_right() { emulate -L zsh; if _ghost_visible; then _ghost_accept; else _ghost_call_orig right; fi }
_ghost_esc() { emulate -L zsh; if [[ -n $_ghost_shown || -n $_ghost_suggestion ]]; then _ghost_dismiss; else _ghost_call_orig esc; fi }

_ghost_schedule() {
  emulate -L zsh
  (( _ghost_dismissed )) && return
  if (( CURSOR != $#BUFFER || $#BUFFER > 300 )) || [[ $BUFFER == *$'\n'* ]] || _ghost_is_secret "$BUFFER"; then
    _ghost_cancel
    return
  fi
  _ghost_start "$BUFFER" "${GHOST_TERMINAL_DEBOUNCE:-0.12}"
}

# Runs before every redraw: typing along the ghost shrinks it, typing anything else clears it and asks again.
# While more keys are queued (fast typing) the request is owed rather than started, so a burst costs one fork.
_ghost_pre_redraw() {
  emulate -L zsh
  if [[ $BUFFER != "$_ghost_last_buffer" ]]; then
    _ghost_last_buffer=$BUFFER
    _ghost_owed=0
    if ! [[ -n $_ghost_suggestion && $_ghost_suggestion == "$BUFFER"?* ]]; then
      _ghost_suggestion=''
      if [[ -z $BUFFER ]]; then
        _ghost_cancel
        _ghost_suggestion=$_ghost_empty
      else
        _ghost_owed=1
      fi
    fi
  fi
  if (( _ghost_owed && PENDING == 0 )); then
    _ghost_owed=0
    _ghost_schedule
  fi
  _ghost_render
}

_ghost_line_init() {
  emulate -L zsh
  _ghost_last_buffer=$BUFFER
}

# Enter: take the ghost off the line before it scrolls away with it.
_ghost_line_finish() {
  emulate -L zsh
  _ghost_cancel
  _ghost_suggestion=''
  if [[ -n $_ghost_shown || -n $_ghost_hl ]]; then
    _ghost_render
    zle -R
  fi
}

_ghost_keymap_select() {
  emulate -L zsh
  [[ $KEYMAP == vicmd ]] && _ghost_dismiss
}

_ghost_precmd() {
  _ghost_exit=$?   # before anything else touches $?
  emulate -L zsh
  _ghost_dismissed=0
  _ghost_owed=0
  _ghost_suggestion=''
  _ghost_empty=''
  _ghost_shown=''
  _ghost_last_buffer=''
  _ghost_start '' ''
}

# Remembers what the key did in that keymap, then binds it to Shabang.
_ghost_bind() {
  emulate -L zsh
  local which=$1 km=$2 key=$3 widget=$4 current
  current=${${(z)"$(bindkey -M $km -- $key 2>/dev/null)"}[2]:-}
  [[ -n $current && $current != ghost-* ]] && _ghost_orig[$which:$km]=$current
  bindkey -M $km -- $key $widget
}

zle -N ghost-tab _ghost_tab
zle -N ghost-right _ghost_right
zle -N ghost-esc _ghost_esc
zle -N _ghost_show

() {
  emulate -L zsh   # whatever the user's options (ksh_arrays, no_unset, ...)
  local km
  for km in emacs viins; do
    _ghost_bind tab $km $'\t' ghost-tab
    _ghost_bind right $km $'\e[C' ghost-right
    _ghost_bind right $km $'\eOC' ghost-right
  done
  # vi users reach vicmd with Esc; the keymap-select hook dismisses there, so Esc is only bound in emacs mode.
  _ghost_bind esc emacs $'\e' ghost-esc

  add-zle-hook-widget line-pre-redraw _ghost_pre_redraw
  add-zle-hook-widget line-init _ghost_line_init
  add-zle-hook-widget line-finish _ghost_line_finish
  add-zle-hook-widget keymap-select _ghost_keymap_select
  # First, so $? is the status of the user's command and not of another hook.
  typeset -ga precmd_functions
  precmd_functions=(_ghost_precmd ${precmd_functions[@]:#_ghost_precmd})
}
