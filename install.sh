#!/usr/bin/env bash
# install.sh — install the /ui slash command + assets into ~/.claude/.
#
# Safe by design:
#   - set -euo pipefail
#   - idempotent (re-running is fine; every run that touches settings.json makes a
#     fresh timestamped backup first)
#   - the /ui command + assets install unconditionally (no settings.json changes)
#   - statusline wiring is OPT-IN (--with-statusline). It NEVER silently repoints
#     your statusLine: it backs up settings.json first, preserves your existing
#     statusline by chaining it, and prints an exact rollback command. It refuses
#     to wire if it cannot write a backup.
#
# Usage:
#   ./install.sh                    # install /ui command + assets only
#   ./install.sh --with-statusline  # also opt into the /ui selection banner statusline
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CMD_DIR="$CLAUDE_DIR/commands"
ASSETS_DIR="$CMD_DIR/ui-assets"
SETTINGS="$CLAUDE_DIR/settings.json"
STAMP="$(date +%Y%m%d-%H%M%S)"

say()  { printf '\033[36m[ui-pick]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[ui-pick]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[ui-pick]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 1. command + assets (always) ----
mkdir -p "$CMD_DIR" "$ASSETS_DIR"

install_file() { # src dst  — backup dst if it differs, then copy
  local src="$1" dst="$2"
  if [ -f "$dst" ] && ! cmp -s "$src" "$dst"; then
    cp -p "$dst" "$dst.bak-$STAMP"
    say "backed up existing $(basename "$dst") -> $(basename "$dst").bak-$STAMP"
  fi
  cp "$src" "$dst"
}

install_file "$HERE/commands/ui.md"                     "$CMD_DIR/ui.md"
install_file "$HERE/ui-assets/react-grab-pick.js"       "$ASSETS_DIR/react-grab-pick.js"
install_file "$HERE/ui-assets/react-grab-pick.min.js"   "$ASSETS_DIR/react-grab-pick.min.js"
install_file "$HERE/ui-assets/detect-dev-url.sh"        "$ASSETS_DIR/detect-dev-url.sh"
install_file "$HERE/ui-assets/spike-react-grab.sh"      "$ASSETS_DIR/spike-react-grab.sh"
install_file "$HERE/ui-assets/ui-selection-watch.sh"    "$ASSETS_DIR/ui-selection-watch.sh"
chmod +x "$ASSETS_DIR/detect-dev-url.sh" "$ASSETS_DIR/spike-react-grab.sh" "$ASSETS_DIR/ui-selection-watch.sh"
say "installed /ui command + assets into $CMD_DIR"

# sanity: the minified payload must parse
if command -v node >/dev/null 2>&1; then
  node --check "$ASSETS_DIR/react-grab-pick.min.js" && say "react-grab-pick.min.js syntax OK"
fi

# ---- 2. statusline (opt-in only) ----
if [ "${1:-}" = "--with-statusline" ]; then
  say "opting into the /ui selection-banner statusline…"
  install_file "$HERE/statusline/ui-statusline.sh" "$CLAUDE_DIR/ui-statusline.sh"
  chmod +x "$CLAUDE_DIR/ui-statusline.sh"

  # Refuse to wire if we cannot make a backup of settings.json.
  if [ -e "$SETTINGS" ]; then
    [ -w "$SETTINGS" ] || die "cannot write $SETTINGS — refusing to wire statusline (no rollback possible)"
    cp -p "$SETTINGS" "$SETTINGS.bak-$STAMP" || die "could not back up $SETTINGS — refusing to wire statusline"
    say "backed up settings.json -> settings.json.bak-$STAMP"
  else
    # creating a fresh settings.json; the 'backup' is simply removing it on rollback
    touch "$SETTINGS" 2>/dev/null || die "cannot create $SETTINGS — refusing to wire statusline"
    printf '{}\n' > "$SETTINGS"
    warn "no settings.json existed — created one; rollback = delete it"
  fi

  # Preserve any existing statusLine.command by chaining it through statusline-command.sh,
  # which ui-statusline.sh invokes as ORIG. Then point statusLine at ui-statusline.sh.
  WRAPPER="$CLAUDE_DIR/ui-statusline.sh"
  ORIG_SHIM="$CLAUDE_DIR/statusline-command.sh"
  python3 - "$SETTINGS" "$WRAPPER" "$ORIG_SHIM" <<'PY'
import json, os, sys, stat
settings, wrapper, orig_shim = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    cfg = json.load(open(settings))
    if not isinstance(cfg, dict): cfg = {}
except Exception:
    cfg = {}
sl = cfg.get("statusLine")
prev_cmd = None
if isinstance(sl, dict) and sl.get("command"):
    prev_cmd = sl["command"]
# If the user already had a statusline AND it isn't our wrapper, preserve it as the shim
# that ui-statusline.sh chains to (only if no shim already exists, to stay idempotent).
if prev_cmd and os.path.abspath(prev_cmd) != os.path.abspath(wrapper) and not os.path.exists(orig_shim):
    with open(orig_shim, "w") as f:
        f.write("#!/bin/bash\n# preserved by claude-ui-pick installer on %s\nexec %s \"$@\"\n" %
                (__import__("time").strftime("%Y-%m-%d %H:%M:%S"), prev_cmd))
    os.chmod(orig_shim, os.stat(orig_shim).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
cfg["statusLine"] = {"type": "command", "command": wrapper}
json.dump(cfg, open(settings, "w"), indent=2)
print("[ui-pick] statusLine -> %s" % wrapper)
print("[ui-pick] preserved prior statusline as shim: %s" % (prev_cmd or "(none)"))
PY
  say "statusline wired. ROLLBACK: cp \"$SETTINGS.bak-$STAMP\" \"$SETTINGS\"   (then remove ui-statusline.sh if undesired)"
else
  say "statusline NOT wired (opt-in). To enable the /ui selection banner: ./install.sh --with-statusline"
fi

# ---- 3. chrome-devtools MCP setup hint ----
cat <<'EOF'

[ui-pick] Transports:
  - cmux:   works automatically inside a cmux browser session (preferred).
  - chrome: needs the chrome-devtools MCP. If you are NOT in cmux, connect it once:
      claude mcp add chrome-devtools npx chrome-devtools-mcp@latest
    then start Chrome and run:  /ui chrome
  (Installed as a plugin? The bundled .mcp.json wires chrome-devtools for you.)

[ui-pick] Done. Run /ui in a project with a running dev server.
EOF
