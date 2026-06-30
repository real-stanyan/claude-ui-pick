#!/usr/bin/env bash
# detect-dev-url.sh — resolve the running dev-server URL for a web project.
# Usage: detect-dev-url.sh <project-root>
# Prints the chosen http://localhost:<port> on stdout (and a NOTE line on stderr).
# Exit 0 if a live server was reached, 2 if it only inferred a port but nothing
# is listening (runbook then asks Stan / opens it anyway), 1 on bad args.
#
# Strategy (R7 — no cmux RPC exposes the dev port):
#   1. explicit port from package.json dev/start script (--port/-p/PORT=)
#   2. explicit port from vite/astro config (server.port) or next -p flag
#   3. probe the framework-conventional ports, first one LISTENING wins
set -euo pipefail

ROOT="${1:-}"
[ -z "$ROOT" ] && { echo "usage: detect-dev-url.sh <project-root>" >&2; exit 1; }
[ -d "$ROOT" ] || { echo "not a dir: $ROOT" >&2; exit 1; }

PKG="$ROOT/package.json"
explicit=""

# ---- 1. package.json scripts (dev, then start) ----
if [ -f "$PKG" ]; then
  scripts="$(node -e 'try{const s=require(process.argv[1]).scripts||{};process.stdout.write((s.dev||"")+"\n"+(s.start||""))}catch(e){}' "$PKG" 2>/dev/null || true)"
  # PORT=3001 ... | --port 5180 | --port=5180 | -p 5180
  explicit="$(printf '%s\n' "$scripts" | grep -oE '(PORT=|--port[ =]|-p )[0-9]{2,5}' | grep -oE '[0-9]{2,5}' | head -1 || true)"
fi

# ---- 2. config files ----
if [ -z "$explicit" ]; then
  for cfg in vite.config.ts vite.config.js vite.config.mjs astro.config.mjs astro.config.ts; do
    [ -f "$ROOT/$cfg" ] || continue
    explicit="$(grep -oE 'port:[ ]*[0-9]{2,5}' "$ROOT/$cfg" | grep -oE '[0-9]{2,5}' | head -1 || true)"
    [ -n "$explicit" ] && break
  done
fi

# ---- candidate port list ----
# explicit first (if any), then framework conventions:
# 3000 Next/CRA · 5173 Vite · 8081 Expo/RN-Web (Metro) · 19006 Expo web ·
# 4321 Astro · 5174/3001/8080 common alternates
candidates=()
[ -n "$explicit" ] && candidates+=("$explicit")
candidates+=(3000 5173 8081 19006 4321 5174 3001 8080)

probe() { # returns 0 if something is listening + serving on the port
  local p="$1"
  curl -fsS -o /dev/null --max-time 1 "http://localhost:${p}" 2>/dev/null && return 0
  # curl -f fails on 4xx/5xx but the server IS up — treat any HTTP response as up:
  curl -sS -o /dev/null -w '%{http_code}' --max-time 1 "http://localhost:${p}" 2>/dev/null | grep -qE '^[1-5][0-9][0-9]$'
}

seen=""
for p in "${candidates[@]}"; do
  case " $seen " in *" $p "*) continue;; esac
  seen="$seen $p"
  if probe "$p"; then
    echo "http://localhost:${p}"
    echo "NOTE: live server detected on :${p}${explicit:+ (explicit port from config: $explicit)}" >&2
    exit 0
  fi
done

# nothing listening — fall back to the best inferred port
fallback="${explicit:-3000}"
echo "http://localhost:${fallback}"
echo "NOTE: no live server reached; inferred :${fallback}. Start the dev server, then retry." >&2
exit 2
