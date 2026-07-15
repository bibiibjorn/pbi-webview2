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
| `PBI_POLL_MS` | `1000` | Steady interval between poll probes inside the multi-step tools. Polls ramp adaptively from ~250ms toward this value, so warm/ready pages satisfy fast. |
| `PBI_SETTLE_MS` | `700` | Post-navigation settle in `pbi_goto_page` (waitReady) for late-binding visuals; only paid when the canvas isn't already stable. `0` disables it. |

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

55 tools. Each returns a leading status key: the **`connected:`** family reports CDP
reachability of the report canvas (`{connected:false, ...}` when Desktop is
unreachable); the **`ok:`** family covers escape hatches, the separate DAX/TMDL/dialog
CDP targets, and the guarded save/close/reload tools (`{ok:false, reason}` — or a
`{ok:true, <action>:false, reason}` refusal — when a surface isn't available or a guard
flag wasn't passed). Tools returning `found:false` / `extracted:false` also carry a
structured **`code`** REASON (`not-found` / `not-ready` / `wrong-view` / `canvas-busy`
/ `not-extractable`) so a loop can branch on the failure without string-matching.

| Tool | Status | Key params | What it does |
|---|---|---|---|
| `pbi_launch` | `launched:` | `pbip`, `port?`, `waitPortMs?` | Launch Desktop WITH the CDP port (bridge-env → bridge-path → direct `PBIDesktop.exe`); injects the WebView2 debug env var; pre-flight warns about orphaned PBIDesktop/msmdsrv; reports the running instance if the port is already up. After `cdpUp:true`, call `pbi_wait_for`. |
| `pbi_status` | `connected:` | `light?` | Connect + report build, title bar, active page, page count, zoom, canvasReady, dirty. `light:true` returns only `{activePage, canvasReady, visibleVisualCount}` (cheap hot-path probe; skips the title/zoom scan). |
| `pbi_pages` | `connected:` | — | All page tabs `[{name, active}]`. |
| `pbi_goto_page` | `connected:` | `name`, `waitReady?`, `stable?` | Exact-match page nav; verifies `aria-selected`; returns candidates on miss. `stable:true` (with `waitReady`) also waits for the render to SETTLE and returns `stableResult`. |
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
| `pbi_dax_query` | `ok:` | `dax`, `timeoutMs?`, `restore?` | Write DAX into the query view + run (F5, Run-button fallback) + read the results grid. **OVERWRITES the editor content** — but the prior text is captured first; `restore:true` re-instates it after reading (also recoverable via `pbi_editor_buffer {action:"restore"}`). |
| `pbi_dialog` | `ok:` | `action:read\|click`, `button?` | Read/click a Desktop dialog (`desktopDialogHost` target, exists only while a dialog shows). Refuses to click Save unless `button` is exactly `"Save"`. |
| `pbi_deep_snapshot` | `connected:` | `what:axtree\|dom\|heap`, `maxNodes?` | Raw-CDP deep inspection: compact a11y tree, DOMSnapshot size probe, or V8 heap usage. Read-only. |
| `pbi_emulate_theme` | `connected:` | `scheme:light\|dark\|no-preference` | Forces `prefers-color-scheme` on the WebView. **INERT for PBI report canvases** (verified 2026-07-15): the media query flips but Desktop does not restyle — report theming is theme.json + app settings, not this CSS signal. Kept for completeness; reset when done. |
| `pbi_save` | `ok:` | `confirm?` | **GUARDED save.** Without `confirm:true` → refuses (`{saved:false, reason}`), does nothing. With `confirm:true` → trusted Ctrl+S, handles the first-save "Save" dialog, verifies via lastSaved change / dirty clear. Deselect/restore BEFORE saving. |
| `pbi_close` | `ok:` | `discardChanges?` | **GUARDED process kill — always needs `discardChanges:true`** (dirty state is undetectable over CDP; see note below). Save via `pbi_save {confirm:true}` first to keep changes. With the flag: discovers the PBIDesktop PID owning the CDP port and taskkills the tree (`/T` ends msmdsrv + WebView2 too), then resets the CDP connection. This TERMINATES Desktop — not a detach. |
| `pbi_reload` | `ok:` | `saveFirst?`, `discardChanges?`, `waitReadyMs?`, `stable?` | **GUARDED visual repaint — needs `saveFirst:true` OR `discardChanges:true`** (dirty state is undetectable over CDP). `saveFirst` saves (and aborts on unverified save). Mechanism: re-navigates the current page (neighbour-and-back) so Desktop re-queries the visuals **from the loaded model** — it does **not** press Refresh and does **not** reload data from the sources (no database hit); re-nav clears transient selection. A data refresh from sources, or a full file-reopen for TMDL/TOM schema edits, is out of scope — drive those yourself. |
| `pbi_health` | `connected:` | `heap?` | CHEAP aggregate: `{activePage, canvasReady, visibleVisualCount, brokenVisualCount, consoleErrorCount, dirty, heapUsedMB?}`. The loop's "is everything OK?" probe. `heapUsedMB` only when `heap:true`. **`dirty` is always `null`** — see the dirty-state note below. |
| `pbi_model_info` | `ok:` | `object`, `table?`, `nameLike?`, `top?`, `includeExpression?` | List measures/tables/columns/relationships as structured metadata via `INFO.VIEW.*` DAX (NO XMLA connection). Requires the DAX query view open in Desktop. Heavy Expression columns dropped unless `includeExpression:true`; auto-captures + restores the prior editor buffer. |
| `pbi_dax_batch` | `ok:` | `queries[]`, `restore?` | Run up to 20 DAX queries sequentially, collect all result sets. Auto-restores the editor buffer (default `restore:true`). |
| `pbi_format_dax` | `ok:` | — | Format the DAX query editor via Monaco `editor.action.formatDocument`; returns the reformatted text. |
| `pbi_editor_buffer` | `ok:` | `action:capture\|restore`, `target:dax\|tmdl?` | Capture/restore the Monaco editor text so `dax_query`/`model_info` don't lose the user's query (`target` default `dax`). |
| `pbi_wait_stable` | `connected:` | `timeoutMs?`, `quietTicks?` | Wait until the canvas render is STABLE (`Performance.getMetrics` LayoutCount/RecalcStyleCount flat + aria-busy clear). Deterministic render-done vs fixed timeouts. |
| `pbi_read_table` | `connected:` | `titleMatch?`, `index?` | Read a `tableEx` (flat, non-matrix) grid fully as `{columns, rows}` (scrolls + merges virtualized rows). Use `pbi_read_matrix` for matrices/pivots. |
| `pbi_show_as_table` | `connected:` | `visualTitle`, `timeoutMs?` | Best-effort: extract a visual's data via right-click data point → "Show as a table". SCOPE: needs a DOM data point — many chart/canvas visuals expose none (returns `not-extractable`). Prefer `read_matrix`/`read_table` for tabular data. |
| `pbi_read_slicer` | `connected:` | `container?` | Read a slicer's `kind` + `selected` + `available` values (button/list); `container` scopes by title. |
| `pbi_read_filters` | `connected:` | — | Best-effort read of the Filters pane as data; opens the pane if closed, reads, then restores it. Honest `not-ready` when empty/unparseable. |
| `pbi_expand_all` | `connected:` | `titleMatch?`, `collapse?`, `maxClicks?` | Expand/collapse ALL matrix hierarchy levels by iteratively left-clicking the +/- expander buttons; returns `rowsBefore/After`, `clicks`, `changed`. |
| `pbi_sort_column` | `connected:` | `column`, `titleMatch?` | Sort a grid by a column header; returns `aria-sort` before/after. |
| `pbi_multiselect_slicer` | `connected:` | `values[]` | Multi-select list-slicer items (first plain, rest Ctrl+click); returns `clicked`/`notFound`/`selectedCount`. Mutates a filter — restore after. |
| `pbi_drill` | `connected:` | `action:down\|up\|through`, `visualTitle?`, `dataPoint?`, `target?` | Drill down/up via the visual-header control, or drill-through via a data-point menu. Honest `not-found`/`not-extractable` when a control/point is absent. |
| `pbi_keyboard_nav` | `connected:` | `maxStops?` | Trusted-Tab focus-order / a11y audit; records `role`+`name`+`inCanvas` per stop, detects when focus leaves the canvas. Read-only. |
| `pbi_page_digest` | `connected:` | — | ONE-call page judgment: visuals+cards+badges+slicers+broken-visuals+console-errors in a single round-trip. The agentic loop's observe step. |
| `pbi_diff_state` | `connected:` | `action:capture\|compare\|list`, `name?` | Capture a full page digest and structurally diff two states (cards changed/added/removed, visual/broken deltas, slicer/page changes). |
| `pbi_assert` | `connected:` | `cardEquals?`, `visualCountAtLeast?`, `noBrokenVisuals?`, `activePageIs?` | Structured pass/fail assertions over a fresh page digest for loop control; each provided predicate becomes a `{name, passed, actual, expected}` check. |
| `pbi_annotate_screenshot` | `connected:` | `filename?` | Screenshot with numbered overlay boxes over each visual + a legend (`n → {title, type, hasError}`) for multimodal judging; overlays always removed afterwards. |

> **Dirty state is not detectable over CDP.** Verified against Desktop 2.155: a real
> report edit changes nothing reachable from any WebView target (no title-bar change, no
> `*`, Save button always enabled, no `window.powerbi.isDirty`). Power BI Desktop's dirty
> flag lives in its native WPF host shell, which CDP cannot see. So `pbi_save`/`pbi_close`/
> `pbi_reload` never *detect* unsaved work — they gate on **your explicit intent flag**
> (`confirm` / `discardChanges` / `saveFirst`). This is deliberate: a guard that silently
> under-reports "clean" would be more dangerous than one that always asks you to state intent.

## Cost tiers

A loop should poll the **CHEAP** tools; call **HEAVY** tools only intentionally.

| Tier | Latency (warm) | Tools |
|---|---|---|
| **CHEAP** | sub-second | `pbi_status {light}`, `pbi_pages`, `pbi_state_probe`, `pbi_read_cards`, `pbi_scan_errors`, `pbi_visuals`, `pbi_health`, `pbi_snapshot`, `pbi_deep_snapshot` (heap), `pbi_read_dax_editor`, `pbi_read_tmdl`, `pbi_dialog` (read), `pbi_wait_for` (warm), `pbi_page_digest`, `pbi_wait_stable`, `pbi_read_slicer`, `pbi_assert`, `pbi_editor_buffer` (capture/restore) |
| **MEDIUM** | ~1-5s (click + poll) | `pbi_click`, `pbi_set_slicer`, `pbi_goto_page`, `pbi_deselect`, `pbi_hover_tooltip`, `pbi_context_menu`, `pbi_fire_bookmark`, `pbi_read_matrix`, `pbi_matrix_expand`, `pbi_search_slicer`, `pbi_type`, `pbi_screenshot`, `pbi_dax_query`, `pbi_save`, `pbi_reload`, `pbi_model_info`, `pbi_dax_batch`, `pbi_format_dax`, `pbi_read_table`, `pbi_sort_column`, `pbi_multiselect_slicer`, `pbi_drill`, `pbi_expand_all`, `pbi_diff_state`, `pbi_annotate_screenshot`, `pbi_read_filters`, `pbi_keyboard_nav` |
| **HEAVY** | ~10-45s+ (deliberate) | `pbi_perf_analyzer`, `pbi_page_sweep`, `pbi_cross_filter_test` (repaints), `pbi_baseline` (`pages:["*"]` = all pages), `pbi_close` (process kill), `pbi_launch`, `pbi_show_as_table` (context-menu + view switch + restore) |

## Choosing between similar tools

Several tools overlap in area but answer different questions — pick by intent:

- **State reads:** `pbi_status` (build/title/page/zoom) · `pbi_state_probe` (toggles/cards/badges/selection — cheapest data probe) · `pbi_health` (broken/console/heap quick-check) · `pbi_page_digest` (everything in one call — supersets `state_probe`; use it as the agentic **observe** step, `state_probe` when you only need the cheap scorecard).
- **Slicers:** `pbi_set_slicer` (one button/item) · `pbi_multiselect_slicer` (several list items, Ctrl-held) · `pbi_search_slicer` (type in the search box, optional pick). Distinct mechanics — not interchangeable.
- **Grids:** `pbi_read_matrix` (matrix/pivot, merges row headers) · `pbi_read_table` (flat `tableEx`, no row headers). `pbi_show_as_table` is the best-effort extractor for **non-grid** visuals (and often returns `not-extractable` — see below).
- **Waiting:** `pbi_wait_for` (a specific text appears/disappears) · `pbi_wait_stable` (render fully settles — deterministic, use after a nav/edit).
- **Escape hatches:** `pbi_eval` (`page.evaluate`, synthetic events — read-only DOM) · `pbi_run_code` (trusted `page.mouse`/`page.keyboard` — real input).
- **Screenshots:** `pbi_screenshot` (full page or one visual via `visualTitle`) · `pbi_annotate_screenshot` (numbered overlay boxes + legend for multimodal judging).

## Model & DAX introspection

`pbi_model_info` gives you a **metadata browser** — measures, tables, columns, and
relationships as structured rows — with **no XMLA connection**. It runs `INFO.VIEW.*` DAX
(`INFO.VIEW.MEASURES/TABLES/COLUMNS/RELATIONSHIPS()`) inside the DAX query view and shapes
the result grid, so you read the model over the same CDP channel as everything else.

- **Precondition:** the **DAX query view must be OPEN** in Desktop (the Home ribbon's
  "DAX query view" tab). These tools reach the separate `daxQueryView` CDP target and
  **will not open ribbon views for you** — same precondition as `pbi_read_dax_editor`.
- Filter with `table` (exact `[Table]`), `nameLike` (`CONTAINSSTRING` on `[Name]`), and
  `top`. The heavy `Expression` / `FormatStringDefinition` / `DetailRowsDefinition`
  columns are dropped by default; pass `includeExpression:true` to keep them.
- `pbi_dax_batch` runs up to 20 queries in one call; `pbi_format_dax` pretty-prints the
  editor via Monaco's Format Document action.
- **Editor safety.** `pbi_dax_query` / `pbi_model_info` / `pbi_dax_batch` **overwrite** the
  query editor, so they **capture the prior text first** and restore it (`restore:true` on
  `dax_query`, on by default for `dax_batch`, always for `model_info`). You can also snapshot
  and re-instate the buffer manually with `pbi_editor_buffer {action:"capture"|"restore"}`.

## Reading visual data

**Grids expose their full data in the DOM; charts do not.** This asymmetry is the single
most important thing to know when reading values:

- **Matrices & tables** (`pbi_read_matrix`, `pbi_read_table`) return the **complete** grid —
  every cell is a real DOM node, and both tools scroll virtualized grids and merge the rows.
  This is the reliable path for any tabular data.
- **Chart values are NOT in the DOM.** Verified against Desktop 2.155: donut/column/line
  visuals render their marks **without persistent DOM values** — arcs aren't addressable
  SVG paths, and the `role="option"` nodes carry `aria-label="null"` (only category labels
  are present as text). Scraping a chart's values from the DOM does not work.
- `pbi_show_as_table` is a **best-effort** extra path: it right-clicks a data point →
  "Show as a table" (or the `Alt+Shift+F11` accessible show-data table), reads the overlay
  grid, and restores the canvas. It only works where the visual exposes a DOM **data point**
  — many chart/canvas/custom visuals expose none, so it honestly returns
  `{extracted:false, code:"not-extractable"}`. Prefer `read_matrix` / `read_table` for
  tabular data; reach for `show_as_table` only when the data lives behind a chart.

## Agentic loop v2

The canonical **safe** act → observe → judge → verify loop. Every state-changing step is
behind an explicit guard flag — the loop only passes `confirm` / `saveFirst` /
`discardChanges` when the edit is legitimate, so a test-click loop can never persist garbage
or lose work. The v1.2.0 tools collapse the observe/judge/verify steps into single
round-trips:

- **settle** — `pbi_wait_stable` blocks until the render is actually done (LayoutCount /
  RecalcStyleCount flat + aria-busy clear), instead of guessing at a fixed timeout.
- **observe** — `pbi_page_digest` returns visuals + cards + badges + slicers + broken
  visuals + console errors in ONE call.
- **judge** — `pbi_assert` runs structured predicates (`cardEquals`, `visualCountAtLeast`,
  `noBrokenVisuals`, `activePageIs`) over a fresh digest and returns pass/fail.
- **verify change** — `pbi_diff_state` captures a digest before an action and structurally
  diffs it after (which cards changed, visual/broken deltas, slicer/page changes).

```
pbi_launch → pbi_wait_for
  → pbi_diff_state {action:"capture", name:"before"}   # snapshot the page digest
  → (edit via your model/authoring MCP)
  → pbi_reload {saveFirst:true, stable:true}           # repaint from the loaded model + wait for settle (guarded; no data refresh)
  → pbi_page_digest                                     # ONE-call observe: broken visuals? console errors? cards?
  → pbi_assert {noBrokenVisuals:true, cardEquals:{...}} # judge: did it land?
  → pbi_diff_state {action:"compare", name:"before"}    # verify: exactly what changed
  → judge → fix → repeat
  → (restore slicers/selection: pbi_deselect / CLEAR bookmark)
  → pbi_save {confirm:true}                             # opt-in save
  → pbi_close {discardChanges:true}                     # deliberate teardown at the very end (flag always required)
```

Between iterations, observe with `pbi_page_digest` / `pbi_health` and `pbi_status
{light:true}` (all CHEAP). **Restore slicers/selection BEFORE `pbi_save {confirm:true}`** so
you don't persist test-click state. `pbi_save`, `pbi_close`, and `pbi_reload` NEVER act
without their guard flag — without it they return a refusal object, not the action.

## Robustness

Newer tools resolve elements through an **ARIA-role resolver** (role + accessible name)
rather than brittle class selectors, so they survive Desktop DOM churn better. When a tool
can't complete, it returns a **structured REASON `code`** instead of a bare error, so a loop
can branch on the failure kind without string-matching:

| `code` | Meaning |
|---|---|
| `not-found` | The target element (visual, column, slicer, matrix, drill control) wasn't present. |
| `not-ready` | The surface exists but hasn't populated yet (e.g. an empty/collapsed Filters pane, a show-as-table grid that never appeared). |
| `wrong-view` | The wrong CDP view is focused for the operation. |
| `canvas-busy` | A read landed mid-render; retry after `pbi_wait_stable` / `pbi_wait_for`. |
| `not-extractable` | The data exists but isn't reachable over the DOM (e.g. a chart with no DOM data point for `show_as_table` / drill-through). |

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

The smoke test spawns `node server.js`, speaks MCP over stdio, asserts all 55 tools are
registered (exact-count assertion), then calls `pbi_status` and asserts it returns
`{connected:false, error, hint}` (Desktop not running). It points the CDP endpoint at a
dead port so the connect fails fast — no Desktop required.

## License

MIT — see [LICENSE](LICENSE).
