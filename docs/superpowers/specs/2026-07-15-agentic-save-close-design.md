# pbi-webview2 v1.1.0 — agentic-loop readiness: save, close, guarded reload, health, latency

Date: 2026-07-15. Approved by Bjorn in-session (full scope A+B+C; guarded reload lives in this server).

Goal: make pbi-webview2 safe and efficient to drive in an autonomous act→observe→judge
loop. Add explicit, opt-in state-changing tools (save/close/reload) that CANNOT fire as a
side effect, a cheap aggregate health probe, a fast status path, latency tuning, and
cost-tier documentation. The "never save implicitly" property is preserved — it becomes
"never save/close/reload WITHOUT an explicit confirm/guard flag."

Base: 33 tools (v1.0.0, published). Target: 38 tools, v1.1.0.

## Guiding safety invariant (unchanged in spirit)

NO tool saves, closes, reloads, or discards as a SIDE EFFECT. Every state-changing or
destructive action requires an explicit flag the caller must pass on purpose:
- save → `confirm:true`
- close dirty → `discardChanges:true`
- reload dirty → `saveFirst:true` OR `discardChanges:true`
A test-click loop that never passes these flags can never persist garbage or lose work.
Defense in depth: the existing `pbi_dialog` exact-`"Save"` guard STAYS.

## Part A — save + close

### `pbi_save {confirm?:boolean}`
- Without `confirm:true`: return `{ok:true, saved:false, reason:"pass confirm:true to save — every test click mutates unsaved in-memory state, so saving is opt-in. Deselect/clear/restore BEFORE saving."}`. Do NOT throw.
- With `confirm:true`:
  1. Read title-bar `lastSaved` via existing `F.pageMetadata` (lastSavedBefore).
  2. Focus the reportView page, send trusted `Control+S` (page.keyboard).
  3. A save dialog MAY appear (first save / Save As on a new file) in the `desktopDialogHost` target — poll ~3s for it; if present, click its "Save" button via existing `F.tagDialogButton`/dialog machinery (the exact-"Save" guard applies — this is a deliberate save so it's allowed).
  4. Poll (~8s) `F.pageMetadata` for `lastSaved` to CHANGE from lastSavedBefore (verifies the save actually took). Note: PBIP save can also clear a dirty marker; verification = lastSaved changed OR dirty marker cleared.
  5. Return `{ok:true, saved:true, lastSavedBefore, lastSavedAfter, verified:boolean, dialogHandled:boolean}`. If not verified, `saved:true, verified:false` with a note (best-effort — Ctrl+S was sent).
- New page fn if needed: `F.reportDirty()` → best-effort dirty detection (title-bar has no "Last saved" yet, or a `*`/unsaved marker). Reuse pageMetadata's title parsing; add a `dirty` field there rather than a whole new scan (cheaper).

### `pbi_close {discardChanges?:boolean}`
- Determine dirty state (F.pageMetadata dirty field).
- If dirty && !discardChanges: return `{ok:true, closed:false, wasDirty:true, reason:"unsaved changes — call pbi_save {confirm:true} first, or pass discardChanges:true"}`.
- Else: discover the PBIDesktop PID and terminate the tree, then `reset()` the cached connection.
  - PID discovery (launch.js helper `findDesktopPid(port)`): query `http://127.0.0.1:<port>/json/version` is not enough for PID. Use `spawnSync` of PowerShell: get the process that owns the CDP port —
    `Get-NetTCPConnection -LocalPort <port> -State Listen | Select -Expand OwningProcess` → that PID's process tree; OR fall back to killing PBIDesktop by name is TOO broad (could kill other instances) — so prefer the port-owner PID. Walk up: the port owner is a WebView2/msedgewebview2 child; get its PBIDesktop ancestor via `Get-CimInstance Win32_Process` ParentProcessId chain, then `taskkill /PID <pbiPid> /T /F`. If the ancestor walk fails, taskkill the port-owner tree (/T gets children) as a fallback and note it.
  - CDP `browser.close()` only DETACHES (connectOverCDP) — do NOT rely on it to close Desktop. Document this.
- Return `{ok:true, closed:true, wasDirty, discarded:!!discardChanges, killedPid, method}`.
- Env: `PBI_ALLOW_CLOSE` need NOT gate this (the discardChanges flag is the gate); but the tool description must be explicit that this terminates the process.

## Part C — guarded reload (agentic loop enabler)

### `pbi_reload {saveFirst?:boolean, discardChanges?:boolean, waitReadyMs?:number}`
Reloads the report/model so live edits (or external file changes) repaint. Directly fixes
the #1 data-loss trap: a reload silently discarding unsaved in-memory TOM/report edits.
- Determine dirty state.
- If dirty && !saveFirst && !discardChanges: `{ok:true, reloaded:false, wasDirty:true, reason:"unsaved changes would be discarded by reload — pass saveFirst:true to save then reload, or discardChanges:true to reload and lose them"}`.
- If saveFirst: perform the pbi_save {confirm:true} sequence first; abort reload if save fails verification (return the save result with reloaded:false).
- Reload mechanism (verify during impl against Desktop 2.155): the trusted-keyboard/ribbon "Refresh" reloads DATA; a full model reload is Desktop reopening the file. For the agentic RENDER loop the need is "repaint visuals after a model edit" — implement as: trusted Home ribbon → Refresh (all), which re-queries visuals. If a deeper reopen is needed that's out of scope (document it). Poll canvas-ready up to waitReadyMs (default 60000).
- Return `{ok:true, reloaded:true, savedFirst:!!saveFirst, canvasReady, elapsedMs}`.
- IMPLEMENTATION NOTE: if a true file-reopen (not just data refresh) is required to pick up TOM schema edits, and it can't be driven safely via CDP, the tool should say so honestly in its result rather than pretend — do not fabricate a reload that didn't happen. Prefer the honest partial over a false success.

## Part B — cost/latency

### `pbi_status {light?:boolean}`
- `light:true`: return ONLY `{connected, activePage, canvasReady, visibleVisualCount}` — skip the title-bar regex scan, zoom lookup, build. New cheap page fn `F.pageMetadataLight()` (activePage from the selected tab + visualContainer count only; no title/zoom scan). This is the loop's hot-path probe.
- Default (no light): unchanged full pageMetadata.

### `pbi_health` (new, cheap aggregate)
One call the loop uses as "is everything OK?": `{connected, activePage, canvasReady, visibleVisualCount, brokenVisualCount, consoleErrorCount, dirty, heapUsedMB?}`. Compose from existing page fns (pageMetadataLight + scanBrokenVisuals count + consoleSnapshot count + dirty). heapUsedMB optional (one cheap CDP Runtime.getHeapUsage; if it adds latency, gate behind a param `heap:true`). No new heavy scans.

### `pbi_goto_page` settle tuning
- The fixed 700ms post-settle after waitReady fires unconditionally. Make it: only settle if the canvas wasn't already stable, and expose `PBI_SETTLE_MS` (default 700) so it's tunable. Fast pages should return sooner.

### `pbi_wait_for` adaptive poll
- Add a short first interval (e.g. 250ms) ramping to the configured interval, so a warm/ready page satisfies in ~250ms-1s instead of waiting a full fixed tick. Keep PBI_POLL_MS override.

### Docs: cost tiers
README gets a **cost-tier table**:
- CHEAP (read probes, sub-second warm): status light, pages, state_probe, read_cards, scan_errors, visuals, health, snapshot, deep_snapshot(heap), read_dax_editor, read_tmdl, dialog(read), wait_for(warm).
- MEDIUM (click + poll, ~1-5s): click, set_slicer, goto_page, deselect, hover_tooltip, context_menu, fire_bookmark, read_matrix, matrix_expand, search_slicer, type, screenshot, dax_query, save, reload.
- HEAVY (deliberate, 10-45s+): perf_analyzer, page_sweep, cross_filter_test (repaints), baseline(*=all pages), close (process kill), launch.
Guidance: a loop should poll CHEAP tools; call HEAVY tools only intentionally.

### Docs: agentic-loop recipe
README section with the canonical safe loop:
```
launch → wait_for → (edit via your model/authoring MCP) → reload {saveFirst:true}
  → health → read_cards/read_matrix/screenshot → judge → fix → repeat
  → save {confirm:true} → close
```
Emphasize: the loop NEVER passes confirm/saveFirst/discard unless the edit is legit;
observe with health + light status; restore slicers/selection before save.

## Non-goals
- No pbi_save_and_close (two explicit steps by design).
- No auto-save/auto-close/unattended teardown.
- No true full-file reopen if it can't be driven safely (document honestly instead).

## Delivery / acceptance
- Tools 33 → 38 (add: pbi_save, pbi_close, pbi_reload, pbi_health; pbi_status gains light param — status is not a new tool, so 33+4=37... RE-COUNT: new tools are save, close, reload, health = 4 → 37 total. Update smoke test to the ACTUAL registered count and assert it; do not hard-code 38 if it's 37.)
- `npm test` passes with Desktop closed (correct tool count; connected:false).
- New guard tools, called WITHOUT their flags, return the refusal object (not a throw, not an action).
- No personal strings introduced (grep clean).
- README updated: new tools, cost-tier table, agentic recipe, env vars (PBI_SETTLE_MS).
- version 1.1.0.
- Live verification (orchestrator, post-implement): save-guard refusal, health, light status, reload-guard refusal on a dirty state. Actual save/close/reload happy-path tested carefully on R0105 (save only if we can restore; close only at the very end).
