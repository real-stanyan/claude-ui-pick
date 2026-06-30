---
description: Click a component in your running localhost and edit its source (cmux OR plain Chrome)
argument-hint: "[chrome|cmux] [optional one-shot instruction, e.g. make this button rounded]"
allowed-tools: Bash(/Applications/cmux.app/Contents/Resources/bin/cmux:*), Bash(bash:*), Bash(node:*), Bash(curl:*), Bash(test:*), Bash(grep:*), Bash(rg:*), Bash(cat:*), Read, Edit, Glob, Grep, mcp__chrome-devtools__new_page, mcp__chrome-devtools__list_pages, mcp__chrome-devtools__select_page, mcp__chrome-devtools__evaluate_script, mcp__chrome-devtools__navigate_page, mcp__chrome-devtools__take_screenshot
---

# /ui — point-and-edit a React component in your localhost browser

You are running an **operator runbook**, not writing prose. Execute the steps in
order with real transport calls. Be deterministic. Never silently edit a file you
*guessed* — if source resolution fails, PROPOSE candidates and stop.

`/ui` works over **two transports** (drivers), resolved once in **Step T**:
- **cmux** — drives a cmux browser surface (binds surface→cwd for free). Preferred.
- **chrome** — drives plain Chrome via the **chrome-devtools MCP**, for Claude Code
  users in any terminal (no cmux). Same capture script, same blob, same edit logic.

`$ARGUMENTS` parsing: if the **first whitespace token** is `chrome` or `cmux`, it
**forces the driver** and is consumed; the REST is the one-shot instruction. Otherwise
the whole of `$ARGUMENTS` is the instruction and the driver is auto-detected. Empty
instruction → **select-then-instruct**: capture the pick, then ask Stan what to change.

Constants:
```bash
CMUX=/Applications/cmux.app/Contents/Resources/bin/cmux
# --- asset resolution (plugin-relative, works wherever installed) ---
# A markdown slash command can't introspect its own path from bash, so resolve the
# asset dir by a ladder. CLAUDE_PLUGIN_ROOT is set by Claude Code for plugin commands;
# the install.sh layout drops assets next to the user's commands dir.
if   [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -d "$CLAUDE_PLUGIN_ROOT/ui-assets" ]; then ASSETS="$CLAUDE_PLUGIN_ROOT/ui-assets"
elif [ -d "$HOME/.claude/commands/ui-assets" ]; then ASSETS="$HOME/.claude/commands/ui-assets"
elif [ -d "$HOME/.claude/ui-assets" ]; then ASSETS="$HOME/.claude/ui-assets"
else echo "ui-assets not found — set CLAUDE_PLUGIN_ROOT or run install.sh" >&2; fi
echo "ASSETS=$ASSETS"
SCRATCH="${TMPDIR:-/tmp}/ui-pick-$$"; mkdir -p "$SCRATCH"   # runtime artifacts
```

**`/ui` uses its OWN select overlay — it does NOT rely on cmux's react-grab.** VERIFIED
live: (1) without a build plugin, react-grab's `getSource()` returns `null`, so the
capture script reads the React fiber's `_debugSource` directly instead; (2) react-grab's
active overlay swallows the click in the capture phase. So the capture script
(`react-grab-pick.js`) installs its own hover-highlight + capture-phase click that
`preventDefault`s the app's handler and commits the blob. This is **transport-agnostic**:
VERIFIED live in plain Chrome with `window.__REACT_GRAB__` undefined — the `_debugSource`
read works identically. react-grab is only a *bonus*: if the project ships react-grab's
babel plugin, `getSource` returns a trusted line and the capture script prefers it.

---

## Step T — Transport (resolve the driver ONCE, then bind the 4 ops)

The entire transport dependency is **4 ops**: `open_url`, `inject`, `eval_readback`,
`screenshot` (+ the `processing`/`teardown` eval helpers). Everything else (blob shape,
source resolution, edit discipline) is **shared and identical** across drivers. Resolve
`DRIVER` here, then every later step calls ops **by name** — only the per-op line swaps.

### Detection (first match wins)
| # | Condition | Result |
|---|---|---|
| 1 | `$ARGUMENTS` first token is `chrome` or `cmux` | force `DRIVER`=that (consume the token) |
| 2 | env `UI_DRIVER` is `chrome` or `cmux` | force `DRIVER`=that |
| 3 | `test -x $CMUX` **AND** `cmux rpc surface.current '{}'` returns a surface id | `DRIVER=cmux` |
| 4 | chrome-devtools MCP tools are present (`mcp__chrome-devtools__*`) | `DRIVER=chrome` |
| 5 | none of the above | **STOP** — print install guidance (below) |

```bash
# tokenize $ARGUMENTS → DRIVER + INSTRUCTION
# glob-safe: do NOT use `set -- $ARGUMENTS` — under a normal user shell it word-splits
# AND pathname-expands the instruction (e.g. `/ui chrome make the * bigger` expands `*`
# to filenames, then that corrupted text drives the edit). Use param expansion instead.
first="${ARGUMENTS%%[[:space:]]*}"
case "$first" in
  chrome|cmux) DRIVER="$first"; INSTRUCTION="${ARGUMENTS#"$first"}"; INSTRUCTION="${INSTRUCTION#"${INSTRUCTION%%[![:space:]]*}"}";;
  *) DRIVER=""; INSTRUCTION="$ARGUMENTS";;
esac
[ -z "$DRIVER" ] && [ -n "${UI_DRIVER:-}" ] && DRIVER="$UI_DRIVER"
if [ -z "$DRIVER" ]; then
  if [ -x "$CMUX" ] && $CMUX rpc surface.current '{}' >/dev/null 2>&1; then DRIVER=cmux; fi
fi
# if still empty, the chrome-devtools MCP tools being available -> DRIVER=chrome (you, the
# operator, can see whether mcp__chrome-devtools__* tools exist; bind chrome if so).
echo "DRIVER=${DRIVER:-<undetermined — see install guidance>}"
```
**cmux is preferred** when both are available (it binds the surface to the project cwd,
so Step 0 is free). If detection reaches #5, STOP and tell Stan:
> No transport available. Either: (a) run inside a **cmux** browser session, or
> (b) connect the **chrome-devtools MCP** (`claude mcp add chrome-devtools npx chrome-devtools-mcp@latest`)
> and start Chrome, then re-run `/ui chrome`.

### The 4 ops — exact call per driver

| op | **cmux** | **chrome** (chrome-devtools MCP) |
|---|---|---|
| **open_url(url)** | diff `surface.list` before/after `cmux open <url>`; bind surface ref `S` (Step 1) | `mcp__chrome-devtools__new_page({url})` — or `list_pages` + `select_page` to reuse a localhost tab |
| **inject(IIFE)** | `cmux browser <S> eval --script "$(cat $ASSETS/react-grab-pick.js)"` → status JSON | `evaluate_script({function:"() => { return (<MIN_SRC>); }"})` → status JSON. THEN arm resilience (below). |
| **eval_readback** | `cmux browser <S> eval --script 'JSON.stringify(window.__UI_PICK__)'` → STRING; bare/quoted `case` + node double-decode (Step 6 cmux box) | `evaluate_script({function:"() => window.__UI_PICK__"})` → **typed JSON**; branch on JS type (Step 6 chrome box). No quoting ladder, no double-decode. |
| **screenshot(out)** | `cmux browser <S> screenshot --out <path>` | `take_screenshot({filePath:<path>})` — path MUST be inside a workspace root (relative path recommended); absolute `/tmp` paths are rejected. |
| **processing(on)** | `cmux browser <S> eval --script 'window.__UI_PICK_PROCESSING__&&window.__UI_PICK_PROCESSING__(true)'` | `evaluate_script({function:"() => { window.__UI_PICK_PROCESSING__&&window.__UI_PICK_PROCESSING__(true); return true; }"})` |
| **teardown** | `cmux browser <S> eval --script 'window.__UI_PICK_TEARDOWN__&&window.__UI_PICK_TEARDOWN__()'` | `evaluate_script({function:"() => { window.__UI_PICK_TEARDOWN__&&window.__UI_PICK_TEARDOWN__(); return true; }"})` |

**chrome inject — `<MIN_SRC>`:** read `$ASSETS/react-grab-pick.min.js` (one line, ~21KB,
the minified capture IIFE) and pass it inline as the `function` argument wrapped EXACTLY
as `() => { return (` + that source + `); }`. The IIFE evaluates and returns its status
JSON, which `evaluate_script` hands back as a typed string. (VERIFIED live: returns
`{"mode":"self-overlay","reactGrabPresent":false,…}` and the overlay/widget appear.)

**chrome inject — resilience (initScript):** a Vite/HMR reload WIPES the injected script.
On chrome, harden against this by registering the SAME IIFE as a navigation init script:
`navigate_page({type:"reload", initScript:"(" + <MIN_SRC> + ")"})` — it reinstalls the
capture script on **every** future document load. NOTE this performs ONE reload now (the
overlay reinstalls itself via the initScript immediately after). If you'd rather not
reload mid-pick, skip it: the Step 6 chrome poll already treats `undefined` as
"script gone → reinject", which covers the wipe reactively.

**chrome `eval_readback` typed-JSON win:** chrome-devtools returns the value as typed
JSON, so `null` is JS `null`, `"cancelled"` is the JS string, and the blob is a real
object — the cmux double-decode/quoting ladder is **DELETED** on the chrome branch.

---

## Step 0 — Self locate (project root)

**Goal: bind `PROJECT_ROOT` to the target web project. Confirm `package.json` exists.**

### Branch DRIVER=cmux — surface gives the cwd
`surface.current` gives the calling surface's refs but **NOT** the cwd. The cwd lives in
the matching `surface.list` entry (`requested_working_directory`, or `resume_binding.cwd`):
```bash
$CMUX rpc surface.current '{}'          # -> note surface_id, workspace_id
$CMUX rpc surface.list '{}'             # -> find entry whose id == that surface_id
```
`PROJECT_ROOT` = that entry's `requested_working_directory`. Confirm:
`test -f "$PROJECT_ROOT/package.json"`. If not a web project, tell Stan which dir you got
and ask which project to target. Do not proceed on a non-web dir.

### Branch DRIVER=chrome — NO surface→cwd binding
Chrome has no cmux surface, so there is no cwd binding. Resolve `PROJECT_ROOT` thus:
```bash
if [ -f "$PWD/package.json" ]; then PROJECT_ROOT="$PWD"; echo "PROJECT_ROOT=$PROJECT_ROOT"
else echo "no package.json in session cwd ($PWD) — ASK Stan for the project root"; fi
```
- session cwd has `package.json` → `PROJECT_ROOT="$PWD"`.
- otherwise → **ASK Stan** for the project root before any source edit. Do not guess.

> DEV-BUILD ONLY (both drivers). Source info needs the JSX-source babel transform, present
> only in Next/Vite/CRA/Astro **dev** servers, absent in prod builds. On a prod build,
> expect `source: null` and the fallback ladder (Step 7).

## Step 1 — open_url: find or open the localhost browser

Reuse an existing localhost view if there is one; else open the dev URL.

### Branch DRIVER=cmux
Prefer **reusing** an existing browser surface already showing localhost:
```bash
$CMUX rpc surface.list '{}'             # look for entries with type != "terminal"
$CMUX browser --surface <ref> get url   # reuse if it points at localhost
```
If none, detect the dev URL and open one. **`--json` is NOT supported on `cmux open`**, so
capture the new surface ref by **diffing `surface.list` before/after the open**:
```bash
DEV_URL="$(bash "$ASSETS/detect-dev-url.sh" "$PROJECT_ROOT")"; echo "$DEV_URL"
BEFORE="$($CMUX rpc surface.list '{}')"
$CMUX open "$DEV_URL" --workspace <workspace_id>          # focused, so Step 5 can click; no --json
sleep 1
AFTER="$($CMUX rpc surface.list '{}')"
# S = ref of the AFTER entry, type != "terminal", whose id is NOT in BEFORE.
```
If `detect-dev-url.sh` exits 2 (nothing listening), tell Stan the inferred URL and ask him
to start his dev server, then re-run. Bind `S=<surface-ref>` for all later op calls.

### Branch DRIVER=chrome
Reuse a localhost tab if one is open; else open it:
```bash
DEV_URL="$(bash "$ASSETS/detect-dev-url.sh" "$PROJECT_ROOT")"; echo "$DEV_URL"
```
- `list_pages` → if a page's URL is localhost (the dev app), `select_page` it.
- else `new_page({url:"<DEV_URL>"})` (opens foregrounded — solves Step 5's "make it visible").
- If `detect-dev-url.sh` exits 2, tell Stan the inferred URL and ask him to start the dev
  server, then re-run. There is no surface ref on chrome — the **selected page** IS the target.

## Step 2 — (Optional, cmux only) spike: is the project source-instrumented?

On the FIRST cmux run against a new project you may confirm the source signal:
```bash
bash "$ASSETS/spike-react-grab.sh" "$S"
```
- `getSource` returns `{filePath,lineNumber}` on a known component → project ships
  react-grab's plugin → `source.lineTrusted:true`, edit at the reported line directly.
- `getSource` returns `null` (common) → capture script falls back to fiber `_debugSource`:
  trusted FILE + column, **untrusted line** → locate the line by content (Step 7).

Skip after the first run on a given project. (On chrome the equivalent signal comes back
in the inject status JSON: `reactGrabPresent` / `hasGetSource`.)

## Step 3 — (removed)

No react-grab injection/toggle is needed. The capture script (Step 4) is self-sufficient.

## Step 4 — inject: install the capture script (turns ON select mode)

Run the **inject** op (Step T cheatsheet for your driver). The capture script installs its
own hover-highlight + capture-phase click listener that `preventDefault`s the app's handler
and commits the blob; it reads `_debugSource` directly (and `getSource`/`getStackContext`
as a bonus when instrumented), arms `window.__UI_PICK__ = null`, binds Escape→cancel,
exposes `window.__UI_PICK_TEARDOWN__`, and returns a JSON status. Select mode is ON the
instant inject returns.

- **cmux:** `cmux browser <S> eval --script "$(cat "$ASSETS/react-grab-pick.js")"`
- **chrome:** `evaluate_script({function:"() => { return (<MIN_SRC>); }"})` using
  `$ASSETS/react-grab-pick.min.js`, then optionally arm `navigate_page` initScript
  resilience (Step T).

Parse the returned JSON: `mode` is `self-overlay`; `hasGetSource` tells you whether to
expect a trusted line or the content-locate path. `reactGrabPresent:false` is fine —
`_debugSource` does not depend on react-grab (VERIFIED live in plain Chrome).

## Step 5 — make the browser visible, tell Stan to click

The capture overlay is already live. Make sure the view is foregrounded so Stan can click.

### Branch DRIVER=cmux — KNOWN GAP
`surface.focus` needs a surface UUID that `surface.list` does not reliably expose, and
`browser focus-webview` errors `WebView is hidden` when the surface isn't foregrounded. Most
reliable: open the surface **focused** in Step 1 (no `--no-focus`) so it is already in front,
or ask Stan to click the cmux browser tab.

### Branch DRIVER=chrome — largely solved
`new_page` opens the tab **foregrounded**, and `select_page` brings a reused tab to front, so
the view is already visible. No focus gymnastics needed.

Then say exactly: **"Click the component you want to edit (Esc to cancel)."**

## Step 6 — eval_readback: poll `window.__UI_PICK__` until non-null

There is no "selected" event; read-back is eval-polling. Loop every ~400ms, 120s cap.

### Branch DRIVER=cmux — STRING readback + quoting ladder + double-decode
`eval` returns a STRING; match BOTH bare and quoted sentinel forms; the blob may arrive
double-encoded — normalize before parsing:
```bash
for i in $(seq 1 300); do
  PICK="$($CMUX browser --surface "$S" eval --script 'JSON.stringify(window.__UI_PICK__)')"
  case "$PICK" in
    null|'"null"'|'""'|'') sleep 0.4 ;;                         # nothing yet
    undefined|'"undefined"')                                    # page reloaded → script wiped
      $CMUX browser --surface "$S" eval --script "$(cat "$ASSETS/react-grab-pick.js")" >/dev/null
      sleep 0.4 ;;                                              # re-inject
    cancelled|'"cancelled"'|'"\"cancelled\""') echo CANCELLED; break ;;  # bare OR quoted
    *) printf '%s' "$PICK" > "$SCRATCH/last-pick.json"; break ;; # got the blob
  esac
done
# decode one layer if double-encoded:
node -e 'let s=require("fs").readFileSync(process.argv[1],"utf8");let v=JSON.parse(s);if(typeof v==="string")v=JSON.parse(v);process.stdout.write(JSON.stringify(v,null,2))' "$SCRATCH/last-pick.json" > "$SCRATCH/pick.json" && mv "$SCRATCH/pick.json" "$SCRATCH/last-pick.json"
```
> VERIFIED-in-test footgun: `JSON.stringify(window.__UI_PICK__)` prints the bare string
> `undefined` when the page reloaded (Vite HMR / a nav from an `<a href="#">`) — which WIPES
> the injected script. Treat `undefined` as "script gone → re-inject", NEVER as a captured pick.

### Branch DRIVER=chrome — typed-JSON poll (no ladder)
`evaluate_script({function:"() => window.__UI_PICK__"})` returns a **typed JS value**. Branch
on its JS type directly — no bare/quoted matching, no double-decode:
- `null` → nothing picked yet → wait ~400ms, poll again.
- string `"cancelled"` → user pressed Escape / closed the widget → **abort** (Step 9 + report).
- `undefined` → the page reloaded and wiped the script → **reinject** (Step 4 chrome inject)
  then keep polling. (If you armed `navigate_page` initScript in Step 4, the script is already
  back — just keep polling.)
- an **object** → that's the blob. Write it to `$SCRATCH/last-pick.json` as-is (it's already a
  real object: `node -e '…'` JSON.stringify it, or have evaluate_script return it and save).
  No double-decode layer.

After you have the blob (either driver), it is:
`{ source{filePath,lineNumber,column,componentName,lineTrusted}, component, stack, element{tag,text,outerHTML,attrs,className}, computedStyles, box, url, enriched }`.
(`enriched:false` means source enrichment hadn't settled — re-poll once if you need `source`;
the element half is already valid.) VERIFIED live over chrome on a Vite app: a click on
`.field` returned `source.filePath` ending `/src/App.jsx`, `lineTrusted:false`,
`element.tag:"input"`, `enriched:true`.

Capture a screenshot for visual context via the **screenshot** op (`box` locates the element):
- cmux: `cmux browser <S> screenshot --out "$SCRATCH/last-pick.png"`
- chrome: `mkdir -p "$PROJECT_ROOT/.ui-pick"`, then `take_screenshot({filePath:".ui-pick/last.png"})`
  (chrome rejects absolute /tmp paths; `.ui-pick/` is workspace-relative + removed in Step 9 — S3).

**Write the terminal-side selection marker** so the statusline shows a block is selected:
```bash
python3 -c 'import json,time,os;p=json.load(open(os.environ["SCRATCH"]+"/last-pick.json"));p=json.loads(p) if isinstance(p,str) else p;e=p.get("element") or {};json.dump({"state":"selected","tag":e.get("tag","?"),"text":(e.get("text") or "")[:24],"ts":time.time()},open(os.path.expanduser("~/.claude/ui-selection.json"),"w"))' # export SCRATCH first
```

## Step 7 — Resolve the file (with fallback ladder) — SHARED, driver-agnostic

The blob is identical across drivers, so source resolution is unchanged.

**If `source.filePath` is present** → resolve to an absolute path:
```bash
fp="<source.filePath>"
fp="${fp#webpack-internal:///}"; fp="${fp#file://}"; fp="${fp#./}"
ABS=""
for cand in "$fp" "$PROJECT_ROOT/$fp" "$PROJECT_ROOT/${fp#"$PROJECT_ROOT"/}"; do
  [ -f "$cand" ] && { ABS="$cand"; break; }
done
# wrong-project guard: refuse to edit outside the target project.
case "$ABS" in
  "$PROJECT_ROOT"/*) echo "ABS=$ABS" ;;
  "") echo "UNRESOLVED — fall through to ladder" ;;
  *) echo "OUTSIDE_PROJECT: $ABS not under $PROJECT_ROOT"; ABS="" ;;
esac
```
If resolved OUTSIDE the project: STOP and tell Stan *"resolved source is outside the target
project ($ABS) — wrong tab/surface? confirm the project before I edit."* Do not edit.

**If `ABS` resolved and is under `$PROJECT_ROOT`, locate the EXACT line by CONTENT — do NOT
trust `source.lineNumber`** when `source.lineTrusted` is `false`/absent. The fiber
`_debugSource` line is offset by the bundler preamble (VERIFIED +19 under @vitejs/plugin-react;
Next/Metro differ). File + column are reliable; line is not. Find the real line by the
element's unique content:
```bash
rg -n -F '<element.text, if short & distinctive>' "$ABS"
rg -n -F '<distinctive token from element.className/attrs>' "$ABS"
```
Use `source.lineNumber` only as a tiebreaker. If `source.lineTrusted` is `true`, open directly
at `lineNumber`. Read the surrounding component, then Step 8.

**If `source` is null** (prod build / `hasGetSource:false`), run the ladder IN ORDER and
**PROPOSE candidates — never auto-edit a guess**:
1. **data-* attrs** — `data-testid`/`data-component`/`data-source` from `element.attrs`:
   `rg -l --glob '!node_modules' '<attr-value>' "$PROJECT_ROOT"`
2. **componentName grep** (if `component` known):
   `rg -n --glob '!node_modules' -e "function $C\b" -e "const $C\s*=" -e "class $C\b" "$PROJECT_ROOT/src" "$PROJECT_ROOT/app" "$PROJECT_ROOT/components" 2>/dev/null`
3. **unique visible-text grep** (`element.text` if short & distinctive):
   `rg -n --glob '!node_modules' -F '<the exact visible text>' "$PROJECT_ROOT"`
4. **DOM/class heuristic** — distinctive className tokens:
   `rg -n --glob '!node_modules' -F '<distinctive-class-token>' "$PROJECT_ROOT"`
5. **interactive snapshot + human confirm** (cmux only): `cmux browser --surface "$S" snapshot --interactive`

Present the top 1–3 file:line candidates with one line each, ask Stan to confirm before editing.
If zero candidates, say so plainly.

## ⚠️ EDITING DISCIPLINE — the target is the LIVE SELECTION, never the chat context

**VERIFIED failure (real session): the user selected an `<input>`, then typed "make it more
refined". The assistant inferred the target from recent conversation (a different element) and
edited the WRONG thing.** The single most important rule:

1. **On EVERY edit instruction, FIRST re-read the live selection via the eval_readback op** —
   do NOT infer the target from conversation history:
   - cmux: `cmux browser --surface "$S" eval --script 'JSON.stringify(window.__UI_PICK__)'`
   - chrome: `evaluate_script({function:"() => window.__UI_PICK__"})`
   - a blob → that element is the target. Resolve it (Step 7) and edit it.
   - `null` → **nothing selected**. STOP. Tell the user "I don't see a current selection — click
     the element you want to change first." NEVER guess from conversation.
   - `"cancelled"` → the user exited; do not edit.
2. **The widget's PICKED label (`<tag> selected`) is the visible source of truth.** Confirm it
   matches what the next instruction edits.
3. **Do not let tooling clobber a live pick.** Avoid re-injecting / re-arming while a real
   selection is pending — re-arm sets `__UI_PICK__=null` and discards the pick.

## Step 8 — Edit, then re-check — SHARED logic, ops swap per driver

**Before editing, ALWAYS echo the target** so a wrong selection is visible before the change
lands — mandatory in BOTH one-shot and conversational mode:
> `Editing <ABS>:<lineNumber> — <tag>/<componentName> ("<element.text>"). Applying: <instruction>`

**Turn on the "processing" effect** right before editing (processing op):
```bash
# cmux:   $CMUX browser --surface "$S" eval --script 'window.__UI_PICK_PROCESSING__&&window.__UI_PICK_PROCESSING__(true)'
# chrome: evaluate_script({function:"() => { window.__UI_PICK_PROCESSING__&&window.__UI_PICK_PROCESSING__(true); return true; }"})
python3 -c 'import json,time,os;f=os.path.expanduser("~/.claude/ui-selection.json");m=json.load(open(f)) if os.path.exists(f) else {};m.update(state="editing",ts=time.time());json.dump(m,open(f,"w"))' 2>/dev/null
```
Then apply the instruction (or, if empty, ask Stan what to change now the component is
identified) to the resolved file with the Edit tool. Keep the change scoped to the clicked
component. Verify visually — the dev server hot-reloads:
```bash
# reload only if no HMR:  cmux: $CMUX browser --surface "$S" reload   |   chrome: navigate_page({type:"reload"})
# processing(false) (done flash):
#   cmux:   $CMUX browser --surface "$S" eval --script 'window.__UI_PICK_PROCESSING__&&window.__UI_PICK_PROCESSING__(false)'
#   chrome: evaluate_script({function:"() => { window.__UI_PICK_PROCESSING__&&window.__UI_PICK_PROCESSING__(false); return true; }"})
python3 -c 'import json,time,os;f=os.path.expanduser("~/.claude/ui-selection.json");m=json.load(open(f)) if os.path.exists(f) else {};m.update(state="selected",ts=time.time());json.dump(m,open(f,"w"))' 2>/dev/null
# screenshot the result:  cmux: ... screenshot --out "$SCRATCH/after.png"  |  chrome: take_screenshot({filePath:".ui-pick/after.png"})
```
> chrome reload caveat: if you reload and did NOT arm `navigate_page` initScript, the capture
> script is gone — reinject (Step 4) before the next pick.

Report the file:line edited, the component name, what changed, and any console errors
(cmux: `cmux browser <S> errors list`).

## Step 9 — Disarm — teardown op + marker cleanup

Tear down the capture script's overlay + listeners (teardown op):
```bash
# cmux:   $CMUX browser --surface "$S" eval --script 'window.__UI_PICK_TEARDOWN__&&window.__UI_PICK_TEARDOWN__()'
# chrome: evaluate_script({function:"() => { window.__UI_PICK_TEARDOWN__&&window.__UI_PICK_TEARDOWN__(); return true; }"})
rm -f ~/.claude/ui-selection.json             # clear the statusline banner
rm -rf "$SCRATCH"                             # clean runtime artifacts
[ "$DRIVER" = chrome ] && rm -rf "$PROJECT_ROOT/.ui-pick"   # chrome screenshot artifacts (S3)
```
`window.__UI_PICK__` is reset automatically on the next /ui invocation (the capture script is
idempotent and re-arms via `window.__UI_PICK_REARM__`).

---

### Failure-mode quick table
| Symptom | Cause | Action |
|---|---|---|
| `source.lineTrusted:false` but line looks wrong | bundler preamble offsets `_debugSource` line | EXPECTED — locate by element content (Step 7) |
| `source: null` entirely | prod build, no `_debugSource` | fallback ladder (Step 7); element half still captured |
| poll times out | no click / surface not foregrounded | bring view to front (Step 5), retry |
| click navigates/submits instead of selecting | overlay not installed (inject failed) | re-run inject; it `preventDefault`s in capture phase |
| resolved path outside project | reused a foreign tab/surface | wrong-project guard STOPS the edit (Step 7) |
| (chrome) readback returns `undefined` | Vite HMR reloaded → script wiped | reinject (Step 4); or arm `navigate_page` initScript (Step T) |
| (chrome) `take_screenshot` Access denied | absolute `/tmp` path outside workspace root | use a workspace-relative `filePath` |
| (chrome) no `DRIVER` resolved | neither cmux nor chrome-devtools MCP present | Step T #5 install guidance |
| detector picks wrong port | global probe across multi-project | reuse existing localhost view (Step 1) |
| Expo-web / RN-Web | unverified `_debugSource` under Metro | spike (Step 2, cmux); if source null, text/class ladder |
