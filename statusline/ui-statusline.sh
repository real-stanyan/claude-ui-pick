#!/bin/bash
# ui-statusline.sh — non-invasive wrapper around Stan's statusline.
# Outputs his original statusline UNCHANGED, then appends a one-line /ui banner
# IFF a fresh selection marker exists (~/.claude/ui-selection.json), so the
# terminal side shows that a block is really selected / being edited.
# Fail-safe: any error here must NOT break the statusline — always emit the
# original output first; the banner is best-effort.

ORIG="$HOME/.claude/statusline-command.sh"

# Claude Code passes session context as JSON on stdin; capture so we can re-feed it.
input="$(cat 2>/dev/null)"

# Per-pane marker: key by this pane's session_id so a /ui selection in one cmux pane
# never shows on another pane's statusline. Derivation MUST match ui-selection-watch.sh
# and ui.md (ui-selection${SID:+-$SID}.json). Empty SID → legacy shared path.
SID="$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)"
if [ -n "$SID" ]; then MARKER="$HOME/.claude/ui-selection-$SID.json"; else MARKER="$HOME/.claude/ui-selection.json"; fi

# 1) original statusline, verbatim (never altered)
if [ -x "$ORIG" ] || [ -f "$ORIG" ]; then
  printf '%s' "$input" | bash "$ORIG" 2>/dev/null
fi

# 2) best-effort /ui banner (only when a fresh marker is present)
if [ -f "$MARKER" ]; then
  line="$(python3 - "$MARKER" <<'PY' 2>/dev/null
import json, sys, time
try:
    m = json.load(open(sys.argv[1]))
    if time.time() - float(m.get("ts", 0)) > 180:   # idle >3min -> auto-hide
        sys.exit(0)
    state = m.get("state", "selected")
    tag = str(m.get("tag", "?"))[:16]
    txt = (m.get("text") or "").strip().replace("\n", " ")[:24]
    extra = ' "%s"' % txt if txt else ""
    if state == "editing":
        print("\033[38;5;99m⚙️  /ui · editing <%s>%s…\033[0m" % (tag, extra))
    elif state == "done":
        print("\033[38;5;42m✓ /ui · <%s> updated\033[0m" % tag)
    else:
        print("\033[38;5;111m\U0001f3af /ui · <%s>%s selected — your next prompt edits this\033[0m" % (tag, extra))
except Exception:
    pass
PY
)"
  [ -n "$line" ] && printf '\n%s' "$line"
fi

# Never let a failed test (e.g. missing/stale marker) bubble up as a non-zero
# exit — Claude Code hides the whole statusline when the command exits != 0.
exit 0
