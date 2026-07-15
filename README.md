# pbi-webview2 — MCP server for the live Power BI Desktop report canvas

[![npm version](https://img.shields.io/npm/v/pbi-webview2)](https://www.npmjs.com/package/pbi-webview2)
[![license: MIT](https://img.shields.io/npm/l/pbi-webview2)](LICENSE)
![platform: Windows](https://img.shields.io/badge/platform-Windows-blue)

`pbi-webview2` is a [Model Context Protocol](https://modelcontextprotocol.io) server
that drives **Power BI Desktop's WebView2 report canvas over CDP** (Chrome DevTools
Protocol). It turns an AI agent (Claude Code, Claude Desktop, or any MCP client) into
a hands-on tester of your **running** report: switch pages, click slicers and buttons,
fire bookmarks by name, read cards and matrices as structured data, judge whether a
cross-filter fired, scan for broken visuals, run the Performance Analyzer, capture and
compare value baselines, and screenshot individual visuals.

## Why

Power BI Desktop renders its report canvas inside an embedded WebView2 (Chromium). When
Desktop is launched with the WebView2 remote-debugging port enabled, that canvas is a
real DOM you can attach to over CDP. `pbi-webview2` exploits this to interact with the
**live** report — no reload, no re-render, no screenshot-OCR to guess at numbers. Every
tool reads values straight from the DOM, and clicks are **trusted** OS-level input that
Desktop actually reacts to (synthetic DOM events are ignored by the canvas). Selectors
and behavioural traps were verified against **Power BI Desktop 2.155 (July 2026)**.

Each tool is one full, verified recipe (tag the target element in-page, then act on it
by a `data-pw` selector) rather than a raw primitive — so the agent gets a clean result
object (`{connected:true, ...}`) instead of having to rediscover the DOM every time.

## Requirements

- **Windows** — Power BI Desktop is Windows-only, and so is this server (`os: win32`).
- **Power BI Desktop** installed (as `PBIDesktop.exe` or the Microsoft Store version).
- **Node.js ≥ 20**.
- Optional: Microsoft's `@microsoft/powerbi-desktop-bridge-cli` (only if you prefer the
  bridge CLI over the built-in direct `PBIDesktop.exe` launch — see `pbi_launch` below).

## Install / registration

The server runs straight from npm via `npx`; nothing to clone.

### Claude Code

```sh
claude mcp add pbi-webview2 -- npx -y pbi-webview2
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "pbi-webview2": {
      "command": "npx",
      "args": ["-y", "pbi-webview2"]
    }
  }
}
```

### Generic MCP client / from source

Any client that speaks stdio MCP can launch it. To run from a local checkout instead of
npm:

```json
{
  "mcpServers": {
    "pbi-webview2": {
      "command": "node",
      "args": ["C:/path/to/pbi-webview2/server.js"],
      "env": { "PBI_CDP_ENDPOINT": "http://127.0.0.1:9222" }
    }
  }
}
```

The server connects **lazily** — it boots fine with Desktop closed, and every tool
returns a structured `{connected:false, error, hint}` (never a thrown error) until
Desktop is reachable. So you can register it once and launch Desktop later.

## Quickstart workflow

The canonical loop is **launch → wait → status → drive**:

1. **`pbi_launch {pbip:"C:/path/to/Report.pbip"}`** — launches Desktop *with* the CDP
   debug port and waits until the port answers. The port only exists when Desktop is
   started with the right environment variable, and **it cannot be attached later** — so
   this must be how Desktop comes up.
2. **`pbi_wait_for {text:"<a page name>"}`** — the CDP port answering does not mean the
   canvas has finished rendering; a heavy report re-queries every visual for
   seconds-to-minutes. Poll for a known page/visual label to appear first.
3. **`pbi_status`** — confirm build, title bar, active page, page count, zoom, and
   `canvasReady`.
4. **Drive it** — `pbi_pages`, `pbi_goto_page`, `pbi_set_slicer`, `pbi_read_cards`,
   `pbi_read_matrix`, `pbi_cross_filter_test`, `pbi_visuals`, `pbi_screenshot`, …

If Desktop is already running on the port, `pbi_launch` reports the existing instance
instead of starting a second one (a second instance competes for Analysis Services
memory and makes both render as if frozen).

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PBI_CDP_ENDPOINT` | `http://127.0.0.1:9222` | CDP endpoint to attach to. Always `127.0.0.1`, never `localhost`. |
| `PBI_DESKTOP_BRIDGE` | — | Explicit path to Microsoft's `powerbi-desktop` bridge CLI entry (`.js` run under Node, or a `.cmd`/`.bat`/`.exe`). Tried first by `pbi_launch`. |
| `PBI_DESKTOP_EXE` | — | Explicit path to `PBIDesktop.exe` for the direct-launch fallback (used when no bridge CLI is found). |
| `PBI_OUTPUT_DIR` | `<os tmpdir>/pbi-webview2-output` | Where screenshots + baselines are written (never the repo/CWD). |
| `PBI_EVAL_BUDGET_MS` | `30000` | Per-`page.evaluate` time budget; a read that lands mid-render fails fast with a `renderer-busy` error instead of hanging. |
| `PBI_POLL_MS` | `1000` | Interval between poll probes inside the multi-step tools. |

### How `pbi_launch` resolves a launcher

`pbi_launch` tries three strategies in order and reports which one it used
(`launcher: "bridge-env" | "bridge-path" | "direct"`):

1. **`PBI_DESKTOP_BRIDGE`** — the explicit bridge CLI path from the env var.
2. **`powerbi-desktop` on `PATH`** — resolved via `where.exe` (the npm-installed bridge
   CLI shim).
3. **Direct `PBIDesktop.exe` spawn** — needs no Microsoft CLI at all. Locates the exe
   from `PBI_DESKTOP_EXE`, then `%ProgramFiles%\Microsoft Power BI Desktop\bin\PBIDesktop.exe`,
   then the Store alias `%LOCALAPPDATA%\Microsoft\WindowsApps\PBIDesktop.exe`.

All three inject `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`
into Desktop's own process environment (the only way the port gets enabled). If nothing
resolves, `pbi_launch` returns `{launched:false, error, hint}` telling you to
`npm i -g @microsoft/powerbi-desktop-bridge-cli` or set `PBI_DESKTOP_EXE`.

## Tools

33 tools. Each returns a leading status key: the **`connected:`** family reports CDP
reachability of the report canvas (`{connected:false, ...}` when Desktop is
unreachable); the **`ok:`** family covers escape hatches and the separate DAX/TMDL/dialog
CDP targets (`{ok:false, reason}` when that specific surface isn't available).

| Tool | Status | Key params | What it does |
|---|---|---|---|
| `pbi_launch` | `launched:` | `pbip`, `port?`, `waitPortMs?` | Launch Desktop WITH the CDP port (bridge-env → bridge-path → direct `PBIDesktop.exe`); injects the WebView2 debug env var; pre-flight warns about orphaned PBIDesktop/msmdsrv; reports the running instance if the port is already up. After `cdpUp:true`, call `pbi_wait_for`. |
| `pbi_status` | `connected:` | — | Connect + report build, title bar, active page, page count, zoom, canvasReady. |
| `pbi_pages` | `connected:` | — | All page tabs `[{name, active}]`. |
| `pbi_goto_page` | `connected:` | `name`, `waitReady?` | Exact-match page nav; verifies `aria-selected`; returns candidates on miss. |
| `pbi_deselect` | `connected:` | — | Clear selection via the neighbour-page-and-back trick (never blind-clicks the canvas). |
| `pbi_state_probe` | `connected:` | — | Batched scorecard (toggles, cards, badges, selectedCount, slicerItemsVisible, …). |
| `pbi_read_cards` | `connected:` | — | Parsed cards `[{title, value}]`. |
| `pbi_click` | `connected:` | `text?`, `ariaLabel?`, `selector?`, `ctrl?`, `index?` | Generic tag-then-act click with overlay-intercept + on-path SVG coordinate fallback. |
| `pbi_set_slicer` | `connected:` | `value`, `kind:button\|item` | Click a button/list slicer; returns before/after state. |
| `pbi_fire_bookmark` | `connected:` | `name`, `group?`, `expectPage?` | Fire any bookmark via the View > Bookmarks pane (trusted click); restores chrome. |
| `pbi_read_matrix` | `connected:` | `titleMatch?`, `index?` | Full grid as `{columns, rows, ariaRowCount, ariaColCount, complete}`; scrolls virtualized grids. |
| `pbi_matrix_expand` | `connected:` | `rowHeader`, `titleMatch?`, `collapse?` | Expand/collapse a hierarchy row; returns rowsBefore/After. |
| `pbi_cross_filter_test` | `connected:` | `ariaLabel?`, `selector?`, `restore?` | Click a data point; verdict = highlights rose OR card fingerprint changed; optional restore. |
| `pbi_hover_tooltip` | `connected:` | `selector?`, `ariaLabel?`, `offsetX?`, `offsetY?` | Trusted hover, read tooltip text. |
| `pbi_scan_errors` | `connected:` | — | Broken-visual scan + non-benign console errors (+ benignFaviconCount). |
| `pbi_perf_analyzer` | `connected:` | `captureQueryFor?` | Per-visual render ms; optional visual-DAX capture via clipboard (clobbers clipboard); restores pane + ribbon. |
| `pbi_page_sweep` | `connected:` | `pages?`, `errorScan?` | HEAVY — iterates pages (each re-queries all its visuals), records loadMs + error scan + card fingerprint; restores page. |
| `pbi_baseline` | `connected:` | `action:capture\|compare\|list`, `name?`, `pages?` | Value-baseline capture/compare/list to `PBI_OUTPUT_DIR/baselines`. |
| `pbi_wait_for` | `connected:` | `text?`, `textGone?`, `timeoutMs?` | Poll body innerText until text appears/disappears. |
| `pbi_eval` | `connected:` | `js` | Escape hatch — `page.evaluate` a function/expression string. Rejects `powerBIAccessToken` (best-effort textual guard, not a sandbox). |
| `pbi_run_code` | `connected:` | `code` | TRUSTED escape hatch — runs `async (page) => …` with the real Playwright page (page.mouse/keyboard = trusted input). Rejects `powerBIAccessToken` (best-effort textual guard). |
| `pbi_snapshot` | `connected:` | `selector?`, `filter?`, `maxLines?` | Accessibility-tree (ARIA) snapshot for structure discovery when a selector drifts. An invalid `filter` regex returns `filterInvalid:true` with unfiltered lines. |
| `pbi_type` | `connected:` | `selector?`, `ariaLabel?`, `text`, `clear?`, `submit?` | Trusted-keyboard type into an editable element; aborts if focus doesn't land on the input (never types into the canvas). |
| `pbi_search_slicer` | `connected:` | `query`, `pick?`, `container?` | Type into a slicer search box; return filtered items; optional pick clicks the match. Same focus-safety abort as `pbi_type`. |
| `pbi_context_menu` | `connected:` | `selector?`, `ariaLabel?`, `click?` | Right-click a data point/visual, read menu items; optional click invokes one (else Escape-closes). |
| `pbi_screenshot` | `connected:` | `filename?`, `fullPage?`, `visualTitle?` | Screenshot to the output dir. With `visualTitle`, clips to the matching visual (returns `clippedTo`, or `saved:false` + candidates on a miss). |
| `pbi_visuals` | `connected:` | — | List visible visuals as `[{title, type, x, y, width, height, hasError}]` (type is a class-token heuristic; coordinates rounded). Read-only. |
| `pbi_read_dax_editor` | `ok:` | — | Read the DAX query view editor text (Monaco; reaches the `daxQueryView` CDP target). `{ok:false, reason}` if that view isn't open. Read-only. |
| `pbi_read_tmdl` | `ok:` | — | Read the TMDL view editor text (Monaco; reaches the `tmdlView` CDP target). `{ok:false, reason}` if that view isn't open. Read-only. |
| `pbi_dax_query` | `ok:` | `dax`, `timeoutMs?` | Write DAX into the query view + run (F5, Run-button fallback) + read the results grid. **OVERWRITES the editor content — prior text is NOT restored (unrecoverable); use a throwaway query view.** |
| `pbi_dialog` | `ok:` | `action:read\|click`, `button?` | Read/click a Desktop dialog (`desktopDialogHost` target, exists only while a dialog shows). Refuses to click Save unless `button` is exactly `"Save"`. |
| `pbi_deep_snapshot` | `connected:` | `what:axtree\|dom\|heap`, `maxNodes?` | Raw-CDP deep inspection: compact a11y tree, DOMSnapshot size probe, or V8 heap usage. Read-only. |
| `pbi_emulate_theme` | `connected:` | `scheme:light\|dark\|no-preference` | Forces `prefers-color-scheme` on the WebView. **INERT for PBI report canvases** (verified 2026-07-15): the media query flips but Desktop does not restyle — report theming is theme.json + app settings, not this CSS signal. Kept for completeness; reset when done. |

## Safety & etiquette

Every interaction happens against the **live, unsaved** report in memory. Follow these:

- **Never save after test clicks.** Every click mutates unsaved in-memory report state.
  Restore slicers / active page when done (a CLEAR bookmark or `pbi_deselect` helps; the
  sweep/baseline/bookmark tools restore the starting page/chrome for you).
- **`pbi_dialog` refuses to click a Save button** unless `button` is passed *exactly* as
  `"Save"` (case-sensitive) — a guard against accidentally saving the report.
- **Token guard is honest, not a sandbox.** `pbi_eval` and `pbi_run_code` reject code
  that references `powerBIAccessToken`, but that is a **best-effort textual (regex)
  guard**, not a security sandbox. Do not rely on it as a boundary.
- **Restore state after test clicks** so the next run starts clean.
- Screenshots and baselines are written to `PBI_OUTPUT_DIR` (a temp dir), never the repo.

## Troubleshooting

- **`{connected:false}` from every tool** — Desktop isn't reachable on the CDP port.
  Launch via `pbi_launch` (the port is enabled only at launch and **cannot be attached
  later**). Verify with `Invoke-RestMethod http://127.0.0.1:9222/json/version`.
- **Use `127.0.0.1`, never `localhost`** — `localhost` resolves IPv6 first and times
  out; the debug port binds IPv4 loopback only.
- **`renderer-busy` errors** — a `page.evaluate` landed while the canvas was mid-render
  (page switch or visual queries in flight). The read fails fast rather than hanging;
  retry in a few seconds, or use `pbi_wait_for` to gate on readiness.
- **Report renders as if frozen / blank** — check `pbi_launch`'s pre-flight warnings.
  Orphaned `msmdsrv` (Analysis Services) engines from earlier debug launches hold RAM
  and starve the new instance; end the `msmdsrv` processes with no matching Desktop (or
  reboot) before blaming the report. Also avoid two Desktop instances at once.
- **A selector stopped matching** after a Desktop update — use `pbi_snapshot` (ARIA
  tree) or `pbi_deep_snapshot` to rediscover structure, then `pbi_run_code` to drive it.

## Coexistence with other CDP clients

CDP supports **multiple simultaneous clients** attached to the same endpoint. So
`pbi-webview2` can run alongside any other CDP client (Playwright, another MCP server, a
DevTools window) pointed at `http://127.0.0.1:9222` at the same time — they don't
conflict. On disconnect, `pbi-webview2` never closes Desktop: `connectOverCDP`'s close
only detaches the CDP session, it doesn't terminate the process.

## Development / test

```sh
npm test   # smoke test — passes WITHOUT Desktop running (asserts connected:false)
```

The smoke test spawns `node server.js`, speaks MCP over stdio, asserts all 33 tools are
registered, then calls `pbi_status` and asserts it returns `{connected:false, error,
hint}` (Desktop not running). It points the CDP endpoint at a dead port so the connect
fails fast — no Desktop required.

## License

MIT — see [LICENSE](LICENSE).
