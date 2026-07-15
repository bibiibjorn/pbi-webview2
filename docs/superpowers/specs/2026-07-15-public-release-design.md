# pbi-webview2 v1.0.0 — public release design

Date: 2026-07-15. Approved by Bjorn in-session.

Goal: make the MCP server installable by anyone via `npx -y pbi-webview2`
(npm registry) with source on Bjorn's personal GitHub, removing every
machine-specific dependency, plus two small new tools and general fixes.

## 1. De-personalization (required)

- `src/tools.js` — `OUTPUT_DIR` default becomes
  `path.join(os.tmpdir(), 'pbi-webview2-output')` (import `node:os`).
  `PBI_OUTPUT_DIR` env override unchanged.
- `server.js` instructions + `src/connection.js` `HINT` — remove every
  reference to `~/.claude/scripts/pbi-desktop-debug.ps1`; say instead:
  "Launch Desktop via the pbi_launch tool — the CDP port is launch-time only
  (attach-later is impossible); endpoint http://127.0.0.1:9222, never localhost."
- `README.md` — full rewrite for a public audience (see §5).

## 2. `pbi_launch` resolution chain (src/launch.js)

Replace the hardcoded `BRIDGE_CLI` path with a resolution chain, tried in
order; the result reports `launcher: "bridge-env" | "bridge-path" | "direct"`:

1. **`PBI_DESKTOP_BRIDGE` env var** — explicit path to Microsoft's
   `powerbi-desktop` bridge CLI entry (a `.js` run via `process.execPath`,
   or a `.cmd`/`.exe` run directly).
2. **`powerbi-desktop` on PATH** — resolve via `where powerbi-desktop`
   (spawn `where.exe`, first line). Run the resolved `.cmd`/`.exe`
   (`spawn(resolved, ['open', pbip, '--timeout', '480000'], ...)`);
   `shell: false`, but a `.cmd` needs `shell: true` or `cmd /c` — use
   `spawn('cmd.exe', ['/c', resolved, 'open', pbip, '--timeout', '480000'])`
   for `.cmd`/`.bat`, plain spawn otherwise.
3. **Direct `PBIDesktop.exe` spawn (fallback, no MS CLI needed)** — locate the
   exe: `PBI_DESKTOP_EXE` env var →
   `%ProgramFiles%\Microsoft Power BI Desktop\bin\PBIDesktop.exe` →
   `%LOCALAPPDATA%\Microsoft\WindowsApps\PBIDesktop.exe` (Store alias).
   Spawn detached with the `.pbip` as the single argument.

All paths inject `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`
into the child env (unchanged mechanism). If NO launcher resolves, return
`{launched:false, error, hint}` telling the user to either install
`@microsoft/powerbi-desktop-bridge-cli` or set `PBI_DESKTOP_EXE`.
Keep: pre-flight (orphaned PBIDesktop/msmdsrv warnings), skipIfPortUp,
port polling, the "canvas still rendering" note.

## 3. New tools (32 → 34)

- **`pbi_visuals`** (no params) — list visible visuals on the active page:
  `[{title, type, x, y, width, height, hasError}]`.
  Implementation: new page function `listVisuals()` in `src/pagefns.js` —
  iterate `.visualContainer` with nonzero bounding rect; `title` from the
  container's (or first descendant's) `aria-label` / `.visualTitle` text;
  `type` heuristic from class names on the container/descendants (e.g.
  `barChart`, `slicer`, `card`, `tableEx`, `pivotTable`) with `null` when
  unknown; `hasError` reuses the broken-visual selector/regex from
  `scanBrokenVisuals`. Coordinates from `getBoundingClientRect()`, rounded.
- **`pbi_screenshot` gains `visualTitle?` param** — when given, tag the
  matching visual (new page fn `tagVisualByTitle(title)` returning
  `{found, x, y, width, height, candidates}` — exact then contains match on the
  same title logic as `listVisuals`), then screenshot with Playwright `clip`
  set to that rect. Not-found returns `{connected:true, saved:false,
  reason:'visual not found', candidates}`.

## 4. General fixes

- `pbi_eval` / `pbi_run_code` descriptions: state the `powerBIAccessToken`
  regex rejection is a best-effort guard, not a sandbox.
- `pbi_snapshot`: an invalid `filter` regex currently silently ignores the
  filter — instead return `filterInvalid: true` alongside unfiltered lines.
- `test/smoke.mjs`: expected tool list grows to 34 (add `pbi_visuals`;
  `pbi_screenshot` unchanged name). Keep the exact-count assertion.
- Consistency audit: every tool returns either `connected:` or `ok:` as its
  leading status key — document which family each tool belongs to in the
  README tool table (no behavioral change beyond §3/§4 items).

## 5. Packaging + publishing

- `package.json`: remove `"private": true`; `name: "pbi-webview2"`,
  `version: "1.0.0"`, `description` (public-facing), `license: "MIT"`,
  `author: "Bjorn Braet"`, `os: ["win32"]`,
  `files: ["server.js", "src/", "README.md", "LICENSE"]`,
  `keywords: ["mcp", "power-bi", "powerbi", "power-bi-desktop", "webview2",
  "cdp", "playwright", "ui-testing", "modelcontextprotocol"]`,
  `repository`/`bugs`/`homepage` → `https://github.com/GITHUB_USER_PLACEHOLDER/pbi-webview2`
  (placeholder swapped when Bjorn provides the repo URL, before publish).
- `LICENSE`: MIT, "Copyright (c) 2026 Bjorn Braet".
- `README.md` rewrite: what it is + why (drive the LIVE Desktop canvas, no
  reload/OCR); requirements (Windows, PBI Desktop, Node ≥20); quickstart
  (registration snippets for Claude Code `claude mcp add pbi-webview2 -- npx -y
  pbi-webview2`, Claude Desktop JSON, generic MCP JSON); `pbi_launch`-first
  workflow; env var table (incl. new `PBI_DESKTOP_BRIDGE`, `PBI_DESKTOP_EXE`,
  existing `PBI_CDP_ENDPOINT`, `PBI_OUTPUT_DIR`, `PBI_EVAL_BUDGET_MS`,
  `PBI_POLL_MS`); full 34-tool table; safety/etiquette section (never saves,
  Save-click refusal, token guard honesty, restore state after test clicks);
  troubleshooting (127.0.0.1 not localhost, attach-later impossible, orphaned
  msmdsrv, renderer-busy meaning); coexistence-with-other-CDP-clients note
  (keep, de-personalized); `npm test` smoke note. No references to private
  skills/canon docs/personal paths.
- Publish flow (after implementation review): Bjorn creates the GitHub repo in
  the browser and provides the URL → swap placeholder, commit, `git remote add
  origin`, push `main`. Then `npm login` (Bjorn, one-time) → `npm publish`
  (dry-run first with `npm publish --dry-run` to verify the file list).

## Acceptance criteria

- `npm test` passes with Desktop closed (34 tools, `connected:false` status).
- `node server.js` boots and prints the ready line on stderr.
- No occurrence of `bjorn.braet`, `bjorn-braet`, `node-v22.20.0`, or
  `~/.claude` anywhere in `server.js`, `src/`, `README.md`, `package.json`.
- `npm publish --dry-run` lists only server.js, src/, README.md, LICENSE,
  package.json.
- `pbi_launch` on a machine with only PBIDesktop.exe installed (no bridge CLI)
  resolves the direct-spawn path (verifiable by unit inspection; live launch
  verified on this machine).
