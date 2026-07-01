#!/bin/bash
# ui-selection-watch.sh — background bridge so the terminal statusline tracks the
# live /ui selection in real time. Polls the in-page window.__UI_PICK__ and mirrors
# it to ~/.claude/ui-selection.json (the banner marker): a blob → "selected" (refreshed),
# null/cancelled/undefined → marker removed (banner clears).
#
# cmux driver ONLY — the chrome driver's __UI_PICK__ is read via an MCP tool that a
# background shell cannot call; on chrome the marker is updated at the agent's poll
# checkpoints instead.
#
# Usage:  ui-selection-watch.sh <surface-ref>     (launch in background)
# Stop:   touch ~/.claude/.ui-watch.stop          (Step 9 disarm does this)
set -u
CMUX=/Applications/cmux.app/Contents/Resources/bin/cmux
S="${1:?surface ref required}"
# SID = the calling Claude Code session_id → per-pane marker so a selection in ONE
# cmux pane never bleeds into another pane's statusline. Empty SID falls back to the
# legacy shared path (must match ui-statusline.sh's identical derivation).
SID="${2:-}"
MARKER="$HOME/.claude/ui-selection${SID:+-$SID}.json"
STOP="$HOME/.claude/.ui-watch${SID:+-$SID}.stop"
PIDF="$HOME/.claude/.ui-watch${SID:+-$SID}.pid"
export UI_MARKER="$MARKER"
rm -f "$STOP"; echo $$ > "$PIDF"
# safety: never run longer than ~30min (3600 * 0.5s) even if the stop file is lost
i=0
while [ ! -f "$STOP" ] && [ "$i" -lt 3600 ]; do
  i=$((i+1))
  PICK="$("$CMUX" browser "$S" eval 'JSON.stringify(window.__UI_PICK__)' 2>/dev/null)"
  case "$PICK" in
    null|'"null"'|''|undefined|'"undefined"'|cancelled|'"cancelled"')
      [ -f "$MARKER" ] && rm -f "$MARKER" ;;          # no selection → clear the banner
    *)
      printf '%s' "$PICK" | python3 -c '
import json,sys,time,os
try:
    p=json.loads(sys.stdin.read())
    if isinstance(p,str): p=json.loads(p)
    e=p.get("element") or {}
    f=os.environ.get("UI_MARKER") or os.path.expanduser("~/.claude/ui-selection.json")
    prev={}
    try: prev=json.load(open(f))
    except Exception: pass
    # let a fresh "editing" state (set by Step 8) survive a couple seconds, else "selected"
    st="editing" if (prev.get("state")=="editing" and time.time()-prev.get("ts",0)<3) else "selected"
    json.dump({"state":st,"tag":e.get("tag","?"),"text":(e.get("text") or "")[:24],"ts":time.time()}, open(f,"w"))
except Exception: pass
' ;;
  esac
  sleep 0.5
done
rm -f "$PIDF"
