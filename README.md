# pbi-webview2 — MCP server for the live Power BI Desktop report canvas

Drives Power BI Desktop's **WebView2 report canvas over CDP** (Chrome DevTools
Protocol) and exposes the verified `pbi-ui-test` recipes as first-class MCP tools:
switch pages, click slicers/buttons, fire bookmarks by name, read cards and matrices
as data, judge cross-filters, scan for broken visuals, run the Performance Analyzer,
capture value baselines, and screenshot — all against the **running** Desktop, no
reload, no screenshot-OCR.

Verified selectors/traps are copied faithfully from the `pbi-ui-test` skill and the
vendor-neutral `General/Reporting/UI-Testing-CDP.md` canon (Desktop 2.155, 2026-07-14).

## How it coexists with `playwright-pbi`

Both attach to the **same CDP endpoint** (`http://127.0.0.1:9222`). CDP supports
multiple simultaneous clients, so `pbi-webview2` and `playwright-pbi` can be registered
at the same time and used interchangeably — `playwright-pbi` is the raw
tag-then-act primitive lane; `pbi-webview2` is the higher-level, recipe-encoded lane
(one tool = one full verified recipe). Neither closes Desktop on disconnect
(`connectOverCDP` close only detaches).

## Prerequisites (hard constraints)

- **Launch Desktop with the debug port** — attach-later is impossible. Use the
  **`pbi_launch {pbip:"<path>.pbip"}`** tool (or `~/.claude/scripts/pbi-desktop-debug.ps1
  -Pbip "<path>.pbip"`, default port 9222). The CDP port is launch-time only.
- **Always `127.0.0.1`, never `localhost`** (localhost resolves IPv6 first and times
  out; the port binds IPv4 loopback only).
- Health check: `Invoke-RestMethod http://127.0.0.1:9222/json/version`.

Tools connect **lazily** (first tool call), so Desktop may be launched after the MCP
server starts. When Desktop is unreachable, every tool returns a structured
`{connected:false, error, hint}` — never a thrown MCP error.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PBI_CDP_ENDPOINT` | `http://127.0.0.1:9222` | CDP endpoint to attach to. |
| `PBI_OUTPUT_DIR` | `C:/Users/bjorn.braet/AppData/Local/Temp/claude/pbi-webview2-output` | Screenshots + baselines land here (never the repo/CWD). |

## Tools

| Tool | Key params | What it does |
|---|---|---|
| `pbi_launch` | `pbip`, `port?`, `waitPortMs?` | Launch Desktop WITH the CDP port (replaces the ps1 step); pre-flight warns about orphaned PBIDesktop/msmdsrv; reports the running instance if the port is already up. After `cdpUp:true`, call `pbi_wait_for`. |
| `pbi_status` | — | Connect + report build, title bar, active page, page count, zoom, canvasReady. |
| `pbi_pages` | — | All page tabs `[{name, active}]`. |
| `pbi_goto_page` | `name` | Exact-match page nav; verifies `aria-selected`; returns candidates on miss. |
| `pbi_deselect` | — | Clear selection via the neighbour-page-and-back trick. |
| `pbi_state_probe` | — | Batched scorecard (toggles, cards, badges, selectedCount, …). |
| `pbi_read_cards` | — | Parsed cards `[{title, value}]`. |
| `pbi_click` | `text?`, `ariaLabel?`, `selector?`, `ctrl?`, `index?` | Generic tag-then-act click with overlay-intercept coordinate fallback. |
| `pbi_set_slicer` | `value`, `kind:button\|item` | Click a button/list slicer; returns before/after state. |
| `pbi_fire_bookmark` | `name`, `group?`, `expectPage?` | Fire any bookmark via the View > Bookmarks pane (trusted click). |
| `pbi_read_matrix` | `titleMatch?`, `index?` | Full grid as `{columns, rows, ariaRowCount, ariaColCount, complete}`. |
| `pbi_matrix_expand` | `rowHeader`, `titleMatch?`, `collapse?` | Expand/collapse a hierarchy row; returns rowsBefore/After. |
| `pbi_cross_filter_test` | `ariaLabel?`, `selector?`, `restore?` | Verdict: highlights rose OR card fingerprint changed. |
| `pbi_hover_tooltip` | `selector?`, `ariaLabel?`, `offsetX?`, `offsetY?` | Trusted hover, read tooltip text. |
| `pbi_scan_errors` | — | Broken-visual scan + non-benign console errors (+ benignFaviconCount). |
| `pbi_perf_analyzer` | `captureQueryFor?` | Per-visual ms; optional visual-DAX capture via clipboard. |
| `pbi_page_sweep` | `pages?`, `errorScan?` | Iterate pages, loadMs + error scan + card fingerprint; restores page. |
| `pbi_baseline` | `action:capture\|compare\|list`, `name?`, `pages?` | Value-baseline capture/compare/list. |
| `pbi_wait_for` | `text?`, `textGone?`, `timeoutMs?` | Poll body innerText until satisfied. |
| `pbi_eval` | `js` | Escape hatch — page.evaluate (rejects `powerBIAccessToken`). |
| `pbi_run_code` | `code` | TRUSTED escape hatch — runs `async (page) => …` with the real Playwright page (page.mouse/keyboard = trusted input). Rejects `powerBIAccessToken`. |
| `pbi_snapshot` | `selector?`, `filter?`, `maxLines?` | Accessibility-tree (ARIA) snapshot for structure discovery when a selector drifts. |
| `pbi_type` | `selector?`, `ariaLabel?`, `text`, `clear?`, `submit?` | Trusted-keyboard type into an editable element (clear/submit optional). |
| `pbi_search_slicer` | `query`, `pick?`, `container?` | Type into a slicer search box; return filtered items; optional pick clicks the match. |
| `pbi_context_menu` | `selector?`, `ariaLabel?`, `click?` | Right-click a data point/visual, read menu items; optional click invokes one (else Escape-closes). |
| `pbi_screenshot` | `filename?`, `fullPage?` | Screenshot to the output dir. |
| `pbi_read_dax_editor` | — | Read the DAX query view editor text (Monaco; reaches the `daxQueryView` CDP target). `{ok:false, reason}` if that view isn't open. |
| `pbi_read_tmdl` | — | Read the TMDL view editor text (Monaco; reaches the `tmdlView` CDP target). `{ok:false, reason}` if that view isn't open. |
| `pbi_dax_query` | `dax`, `timeoutMs?` | Write DAX into the query view + run (F5, Run-button fallback) + read the results grid. **OVERWRITES the editor content** (prior text not restored). |
| `pbi_dialog` | `action:read\|click`, `button?` | Read/click a Desktop dialog (`desktopDialogHost` target, exists only while a dialog shows). Refuses to click Save unless `button` is exactly `"Save"`. |
| `pbi_deep_snapshot` | `what:axtree\|dom\|heap`, `maxNodes?` | Raw-CDP deep inspection: compact a11y tree, DOMSnapshot size probe, or V8 heap usage. Read-only. |
| `pbi_emulate_theme` | `scheme:light\|dark\|no-preference` | Force `prefers-color-scheme` on the WebView (persists until reset/reload). Reset when done. |

## Registration (`.claude.json` / MCP config)

```json
{
  "mcpServers": {
    "pbi-webview2": {
      "command": "node",
      "args": ["C:/Users/bjorn.braet/powerbi-mcp-servers/MCP-PBI-WebView2/server.js"],
      "env": { "PBI_CDP_ENDPOINT": "http://127.0.0.1:9222" }
    }
  }
}
```

## Hard rules

- **`127.0.0.1` only** — never `localhost`.
- **Launch Desktop via `pbi-desktop-debug.ps1`** — the CDP port cannot be attached later.
- **Never save after test clicks** — every click mutates unsaved in-memory report
  state. Restore slicers / active page when done (a CLEAR bookmark or
  `pbi_deselect` helps); the sweep/baseline tools restore the starting page for you.
- **Never read `window.powerBIAccessToken`** — `pbi_eval` rejects any code referencing it.
- Screenshots and baselines go to `PBI_OUTPUT_DIR`, never the repo/CWD.

## Test

```
npm test   # smoke test — passes WITHOUT Desktop running (asserts connected:false)
```
