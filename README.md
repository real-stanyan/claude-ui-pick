# claude-ui-pick

> Click a component in your running localhost browser, and Claude Code edits its source.

`/ui` is a Claude Code slash command for front-end work. While your dev server is
running, you run `/ui`, click the element you want to change in the browser, and
Claude resolves that element back to its source file and line and edits it — no
copy-pasting selectors, no "which component is this again?". It works over two
transports: **cmux** (zero-config) or **plain Chrome** via the chrome-devtools MCP
(any terminal).

<!-- demo gif -->

## How the loop feels

1. Run `/ui` in a project with a running dev server.
2. Claude opens (or reuses) your localhost tab and arms a select overlay.
3. You hover — elements highlight; you click — the element locks with a selection box.
4. A bottom-docked widget shows the state (`armed` → `picked` → `processing` → `done`),
   and a terminal-side banner shows what's selected.
5. You tell Claude what to change. It edits the clicked component's source, runs a
   "processing" sweep over the element while it works, and your dev server hot-reloads.

It is **dev-build only** — source mapping needs the JSX-source transform that
Vite/Next/CRA/Astro add in their **dev** servers. Prod builds strip that info, so on
a prod build `/ui` proposes candidate files instead of silently editing a guess.

## Prerequisites

- **Claude Code.**
- **A web app you can run on localhost** — a React-family **dev** build
  (Vite, Next.js, CRA, or Astro dev). The dev server must be running.
- **One transport**, either:
  - **cmux** — preferred, zero-config. Run inside a cmux browser session and it
    binds the browser surface to your project's working directory for free; or
  - **the chrome-devtools MCP + a running Chrome** — for any other terminal:
    ```bash
    claude mcp add chrome-devtools npx chrome-devtools-mcp@latest
    ```
    then start Chrome.
- **Node.js** — used for the min.js syntax check at install time and the readback
  decode on the cmux transport.

You do **not** need a build plugin (e.g. react-grab's babel plugin). The capture
script reads the React fiber's `_debugSource` directly. If your project does ship
react-grab's plugin, `/ui` uses its trusted source line as a bonus.

## Install

### Option A — `install.sh` (command + assets)

```bash
git clone https://github.com/real-stanyan/claude-ui-pick.git
cd claude-ui-pick
./install.sh
```

This installs the `/ui` command and its assets into `~/.claude/commands/` and
`~/.claude/commands/ui-assets/`. It is idempotent and makes a timestamped backup of
any file it would overwrite. **It does not touch `settings.json`.**

To also wire the opt-in selection-banner statusline:

```bash
./install.sh --with-statusline
```

The statusline path is the only thing that touches `settings.json`. When you opt in,
the installer backs up `settings.json` first (timestamped), **preserves** your
existing statusline by chaining it, and prints an exact rollback command. It refuses
to wire anything if it can't write a backup. It also sets `"refreshInterval": 1` —
Claude Code only re-runs the statusline on events (new message, etc.) and goes static
while idle, so the 1s timer is **required** for the banner to track your selection live
while you click in the browser. (If you wire the statusline by hand, add `refreshInterval`
yourself.) Changes to `settings.json` may need a Claude Code restart to take effect.

### Option B — Claude Code plugin

This repo is a valid Claude Code plugin (`.claude-plugin/plugin.json`). Point Claude
Code at the repo as a plugin and `commands/ui.md` is auto-discovered; the bundled
`.mcp.json` wires the `chrome-devtools` MCP server for you, so the Chrome transport
works out of the box.

### Option C — manual copy

```bash
cp commands/ui.md           ~/.claude/commands/ui.md
mkdir -p                    ~/.claude/commands/ui-assets
cp ui-assets/*              ~/.claude/commands/ui-assets/
chmod +x                    ~/.claude/commands/ui-assets/*.sh
```

> Asset resolution is resolved at runtime by a ladder, so any of these layouts work:
> `$CLAUDE_PLUGIN_ROOT/ui-assets` → `~/.claude/commands/ui-assets` → `~/.claude/ui-assets`.

## Usage

```bash
/ui                            # select-then-instruct: click, then I ask what to change
/ui make this button rounded   # one-shot: still requires a click, then applies this
/ui chrome                     # force the Chrome driver
/ui cmux round the corners     # force cmux, with a one-shot instruction
```

- The first whitespace token of the argument, if it's `chrome` or `cmux`, **forces
  the driver** and is consumed; the rest is your instruction. Otherwise the whole
  argument is the instruction and the driver is auto-detected.
- With no instruction, `/ui` captures your click and then asks what to change.
- Press **Esc** (or close the widget) to cancel a pending selection.

### The select-then-instruct rule

The target is always the **live selection**, never the conversation. Once you've
clicked an element, your next prompt edits **that** element — Claude re-reads the
live pick on every edit instruction rather than inferring the target from chat
history. If nothing is selected, it stops and asks you to click first instead of
guessing. To edit something else, click it.

## How it works

- **Driver detection** (first match wins): forced token → `UI_DRIVER` env →
  cmux usable → chrome-devtools MCP present → otherwise stop with install guidance.
- **Its own overlay.** `/ui` injects its own capture script that draws the hover
  highlight and a capture-phase click handler — it `preventDefault`s the app's own
  click so selecting never triggers the app's buttons or navigation.
- **Source from the fiber.** It reads the React fiber's `_debugSource`
  (file + column reliable; line not), so no build plugin is required.
- **Content-locate the line.** The `_debugSource` line is offset by the bundler
  preamble, so the exact line is pinned by grepping the element's unique
  text/class/attrs in the resolved file — not by trusting the raw line number.
- **Edit with feedback.** Before editing, Claude echoes the target
  (`file:line — tag/component`), turns on the in-page "processing" sweep, edits the
  file, and lets your dev server hot-reload.
- **Statusline banner** (opt-in): a terminal-side line mirrors the live state —
  selected → editing → updated.

## The two drivers

| | **cmux** | **chrome** |
|---|---|---|
| Setup | zero-config (preferred) | needs the chrome-devtools MCP + running Chrome |
| Project root | bound automatically from the cmux surface's cwd | `PROJECT_ROOT` = your session cwd (must contain `package.json`), else Claude asks you to confirm |
| Tab focus | open the surface focused so you can click | `new_page`/`select_page` foreground the tab automatically |
| Readback | string + decode | typed JSON |

Both drivers share the same capture script, the same selection blob, and the same
edit logic — only the four transport ops (open / inject / read-back / screenshot)
differ. cmux is preferred when both are available because it binds the browser
surface to your project directory for free.

## Troubleshooting & limitations

- **Dev build only.** Source mapping needs the dev-server JSX-source transform.
  On a prod build, expect no source info — `/ui` falls back to proposing candidate
  files (by data-attrs, component name, visible text, or class) and asks you to
  confirm. It never silently edits a guess.
- **React only.** Source resolution relies on the React fiber's `_debugSource`.
  Expo-web / React-Native-Web under Metro is unverified; if source comes back null
  it uses the text/class fallback ladder.
- **You have to click a foregrounded tab.** On cmux, the surface must be in front
  (open it focused, or click the cmux browser tab) — its focus API is a known gap.
  On Chrome this is handled automatically.
- **Same-host Chrome.** The Chrome transport assumes Chrome and the dev server are
  on the same machine as your Claude Code session.
- **`PROJECT_ROOT` on Chrome.** With no cmux surface there's no cwd binding, so the
  Chrome path uses your session cwd (must contain `package.json`) and otherwise asks
  you to confirm the project before any edit. A resolved path outside the target
  project hard-stops the edit.
- **Chrome screenshots** must use a workspace-relative path (absolute `/tmp` paths
  are rejected by the MCP).
- **HMR can wipe the overlay** (e.g. a Vite reload). The runbook re-injects
  reactively; on Chrome you can also arm a navigation init-script so it reinstalls
  on every load.
- **The statusline is opt-in** (`--with-statusline`) and never alters your existing
  statusline — it chains it.

## What's in here

| Path | Purpose |
|---|---|
| `commands/ui.md` | the transport-aware operator runbook (the slash command) |
| `ui-assets/react-grab-pick.js` | in-page capture script (readable source) |
| `ui-assets/react-grab-pick.min.js` | single-line minified capture IIFE (Chrome inject payload) |
| `ui-assets/detect-dev-url.sh` | resolve the running dev-server URL for a project |
| `ui-assets/spike-react-grab.sh` | (cmux) probe the injected react-grab API shape |
| `statusline/ui-statusline.sh` | opt-in statusline banner showing the live selection |
| `install.sh` | safe installer (idempotent, backups, opt-in statusline) |
| `.mcp.json` | bundles the chrome-devtools MCP server for plugin installs |
| `.claude-plugin/plugin.json` | Claude Code plugin manifest |

## License

MIT — see [LICENSE](./LICENSE).

## Acknowledgements

Built with a Claude Code expert squad. The in-page select/overlay layer is `/ui`'s
own; it interoperates with react-grab when a project ships its babel plugin, but
does not require it.
