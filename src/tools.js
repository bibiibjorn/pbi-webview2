/**
 * Tool catalog — registers all 20 pbi-webview2 tools on the McpServer.
 *
 * Every tool wraps its work in withReport(fn) (lazy connect + reconnect-retry),
 * returns compact JSON via ok(), and never leaks window.powerBIAccessToken.
 * All DOM logic lives in ../src/pagefns.js (single source; passed to page.evaluate).
 */
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { withReport, consoleSnapshot, HINT } from './connection.js';
import * as F from './pagefns.js';

const OUTPUT_DIR =
  process.env.PBI_OUTPUT_DIR || 'C:/Users/bjorn.braet/AppData/Local/Temp/claude/pbi-webview2-output';
const BASELINE_DIR = path.join(OUTPUT_DIR, 'baselines');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Wrap any result object into the MCP content shape (compact JSON). */
function ok(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

/** Short poll: run probe() until predicate(v) is true or timeout; returns {value, elapsedMs, satisfied}. */
async function poll(probe, predicate, timeoutMs, intervalMs = 200) {
  const start = Date.now();
  let value = await probe();
  while (!predicate(value) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    value = await probe();
  }
  return { value, elapsedMs: Date.now() - start, satisfied: predicate(value) };
}

/**
 * Click a tagged locator with the overlay-intercept coordinate fallback.
 * Returns {clicked, method}. `ctrl` adds the Control modifier on both paths.
 */
async function robustClick(page, selector, ctrl) {
  const locator = page.locator(selector);
  const modifiers = ctrl ? ['Control'] : [];
  try {
    await locator.click({ modifiers, timeout: 5000 });
    return { clicked: true, method: 'locator' };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/intercepts pointer events/i.test(msg)) throw e;
    // Overlay-intercept fallback: trusted coordinate click.
    const box = await locator.boundingBox();
    if (!box) throw e;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (ctrl) await page.keyboard.down('Control');
    try {
      await page.mouse.click(cx, cy);
    } finally {
      if (ctrl) await page.keyboard.up('Control');
    }
    return { clicked: true, method: 'coordinate' };
  }
}

export function registerTools(server) {
  /* 1. pbi_status --------------------------------------------------------- */
  server.registerTool(
    'pbi_status',
    {
      description:
        'Connect to Power BI Desktop over CDP and report status: build, title bar, active page, page count, zoom, canvasReady. Returns {connected:false,...} if unreachable.',
      inputSchema: {},
    },
    async () =>
      ok(
        await withReport(async (page) => {
          const meta = await page.evaluate(F.pageMetadata);
          return { connected: true, ...meta };
        })
      )
  );

  /* 2. pbi_pages ---------------------------------------------------------- */
  server.registerTool(
    'pbi_pages',
    { description: 'List all report page tabs as [{name, active}].', inputSchema: {} },
    async () =>
      ok(
        await withReport(async (page) => {
          const pages = await page.evaluate(F.listPages);
          return { connected: true, pages };
        })
      )
  );

  /* 3. pbi_goto_page ------------------------------------------------------ */
  server.registerTool(
    'pbi_goto_page',
    {
      description:
        'Navigate to a page by EXACT name. Verifies aria-selected after; on not-found returns closest candidates.',
      inputSchema: { name: z.string().describe('Exact page display name') },
    },
    async ({ name }) =>
      ok(
        await withReport(async (page) => {
          const tag = await page.evaluate(F.tagPageTab, name);
          if (!tag.found) {
            return { connected: true, navigated: false, reason: 'not-found', candidates: tag.candidates };
          }
          await robustClick(page, tag.selector, false);
          const res = await poll(
            () => page.evaluate(F.activePageName),
            (v) => v === name,
            5000
          );
          return { connected: true, navigated: res.satisfied, activePage: res.value, elapsedMs: res.elapsedMs };
        })
      )
  );

  /* 4. pbi_deselect ------------------------------------------------------- */
  server.registerTool(
    'pbi_deselect',
    {
      description:
        'Clear visual/group selection via the neighbour-page-and-back trick (never blind-clicks the canvas). Returns {selectedBefore, selectedAfter, page}.',
      inputSchema: {},
    },
    async () =>
      ok(
        await withReport(async (page) => {
          const before = await page.evaluate(F.stateProbe);
          const original = before.activePage;
          const pages = await page.evaluate(F.listPages);
          const neighbour = pages.find((p) => p.name !== original);
          if (!neighbour || !original) {
            return {
              connected: true,
              selectedBefore: before.selectedCount,
              selectedAfter: before.selectedCount,
              page: original,
              note: 'no neighbour page available',
            };
          }
          const nt = await page.evaluate(F.tagPageTab, neighbour.name);
          if (nt.found) await robustClick(page, nt.selector, false);
          await poll(() => page.evaluate(F.activePageName), (v) => v === neighbour.name, 4000);
          const bt = await page.evaluate(F.tagPageTab, original);
          if (bt.found) await robustClick(page, bt.selector, false);
          await poll(() => page.evaluate(F.activePageName), (v) => v === original, 4000);
          const after = await page.evaluate(F.stateProbe);
          return {
            connected: true,
            selectedBefore: before.selectedCount,
            selectedAfter: after.selectedCount,
            page: after.activePage,
          };
        })
      )
  );

  /* 5. pbi_state_probe ---------------------------------------------------- */
  server.registerTool(
    'pbi_state_probe',
    {
      description:
        'Batched scorecard: {activePage, toggles, cards, badges, selectedCount, slicerItemsVisible, visibleVisualCount}.',
      inputSchema: {},
    },
    async () =>
      ok(
        await withReport(async (page) => {
          const s = await page.evaluate(F.stateProbe);
          return { connected: true, ...s };
        })
      )
  );

  /* 6. pbi_read_cards ----------------------------------------------------- */
  server.registerTool(
    'pbi_read_cards',
    { description: 'Parsed card visuals as [{title, value}].', inputSchema: {} },
    async () =>
      ok(
        await withReport(async (page) => {
          const cards = await page.evaluate(F.readCards);
          return { connected: true, cards };
        })
      )
  );

  /* 7. pbi_click ---------------------------------------------------------- */
  server.registerTool(
    'pbi_click',
    {
      description:
        'Generic tag-then-act click by text | ariaLabel | selector (ctrl for action buttons; index disambiguates). Overlay-intercept coordinate fallback. Returns {clicked, method, matchedLabel, candidateCount}.',
      inputSchema: {
        text: z.string().optional(),
        ariaLabel: z.string().optional(),
        selector: z.string().optional(),
        ctrl: z.boolean().optional(),
        index: z.number().int().optional(),
      },
    },
    async (args) =>
      ok(
        await withReport(async (page) => {
          const tag = await page.evaluate(F.tagForClick, {
            text: args.text,
            ariaLabel: args.ariaLabel,
            selector: args.selector,
            index: args.index,
          });
          if (!tag.found) {
            return { connected: true, clicked: false, candidateCount: 0, reason: 'no-match' };
          }
          const r = await robustClick(page, tag.selector, !!args.ctrl);
          return {
            connected: true,
            clicked: r.clicked,
            method: r.method,
            matchedLabel: tag.matchedLabel,
            candidateCount: tag.candidateCount,
          };
        })
      )
  );

  /* 8. pbi_set_slicer ----------------------------------------------------- */
  server.registerTool(
    'pbi_set_slicer',
    {
      description:
        'Set a slicer: kind "button" (buttonSlicerVisual, returns aria-pressed before/after) or "item" (list slicer item, returns a fresh state probe).',
      inputSchema: {
        value: z.string(),
        kind: z.enum(['button', 'item']),
      },
    },
    async ({ value, kind }) =>
      ok(
        await withReport(async (page) => {
          if (kind === 'button') {
            const tag = await page.evaluate(F.tagButtonSlicer, value);
            if (!tag.found) return { connected: true, clicked: false, reason: 'not-found' };
            const before = tag.pressed;
            await robustClick(page, tag.selector, false);
            const res = await poll(
              () => page.evaluate(F.buttonSlicerState, value),
              (v) => v !== before,
              4000
            );
            return { connected: true, clicked: true, kind, value, pressedBefore: before, pressedAfter: res.value };
          }
          const tag = await page.evaluate(F.tagSlicerItem, value);
          if (!tag.found)
            return { connected: true, clicked: false, reason: 'not-found (open the slicer popup first?)' };
          await robustClick(page, tag.selector, false);
          await new Promise((r) => setTimeout(r, 400));
          const state = await page.evaluate(F.stateProbe);
          return {
            connected: true,
            clicked: true,
            kind,
            value,
            state: {
              activePage: state.activePage,
              cards: state.cards,
              badges: state.badges,
              slicerItemsVisible: state.slicerItemsVisible,
            },
          };
        })
      )
  );

  /* 9. pbi_fire_bookmark -------------------------------------------------- */
  server.registerTool(
    'pbi_fire_bookmark',
    {
      description:
        'Fire ANY bookmark by name via the View > Bookmarks pane (trusted coordinate click; optional group; expandable groups auto-expanded). Returns {fired, landedPage, warning?}.',
      inputSchema: {
        name: z.string(),
        group: z.string().optional(),
        expectPage: z.string().optional(),
      },
    },
    async ({ name, group, expectPage }) =>
      ok(
        await withReport(async (page) => {
          let warning;
          // Ensure Bookmarks pane is open (View ribbon tab -> Bookmarks button).
          const paneOpen = await page.evaluate(F.bookmarksPaneOpen);
          if (!paneOpen) {
            const view = await page.evaluate(F.tagRibbonTab, 'View');
            if (view.found) {
              await robustClick(page, view.selector, false);
              await new Promise((r) => setTimeout(r, 400));
            }
            const btn = await page.evaluate(F.tagRibbonButton, 'Bookmarks');
            if (!btn.found) {
              return { connected: true, fired: false, reason: 'Bookmarks ribbon button not found' };
            }
            await robustClick(page, btn.selector, false);
            await poll(() => page.evaluate(F.bookmarksPaneOpen), (v) => v === true, 4000);
          }

          // Locate the leaf; expand group first if needed.
          let tag = await page.evaluate(F.tagBookmarkRow, { name, group });
          if (!tag.found && tag.needExpandGroup) {
            await robustClick(page, tag.needExpandGroup, false);
            await new Promise((r) => setTimeout(r, 400));
            tag = await page.evaluate(F.tagBookmarkRow, { name, group });
          }
          if (!tag.found) {
            return {
              connected: true,
              fired: false,
              reason: 'bookmark leaf not found',
              availableNames: (tag.names || []).map((n) => n.name),
            };
          }

          // Trusted coordinate click on the .title (synthetic clicks are ignored).
          const locator = page.locator(tag.selector);
          const box = await locator.boundingBox();
          if (!box) return { connected: true, fired: false, reason: 'row has no bounding box (virtualized?)' };
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

          const res = await poll(
            () => page.evaluate(F.activePageName),
            () => true,
            2500,
            250
          );
          const landedPage = res.value;
          if (expectPage && landedPage !== expectPage) {
            warning = `expected page "${expectPage}" but landed on "${landedPage}"`;
          }

          // Close the pane again and return ribbon to Home.
          const btnClose = await page.evaluate(F.tagRibbonButton, 'Bookmarks');
          if (btnClose.found) {
            await robustClick(page, btnClose.selector, false);
          }
          const home = await page.evaluate(F.tagRibbonTab, 'Home');
          if (home.found) await robustClick(page, home.selector, false);

          return { connected: true, fired: true, landedPage, warning };
        })
      )
  );

  /* 10. pbi_read_matrix --------------------------------------------------- */
  server.registerTool(
    'pbi_read_matrix',
    {
      description:
        'Read a matrix/grid fully as {columns, rows:[{header, cells}], ariaRowCount, ariaColCount, complete}. Scrolls virtualized grids and merges by row header.',
      inputSchema: {
        titleMatch: z.string().optional(),
        index: z.number().int().optional(),
      },
    },
    async ({ titleMatch, index }) =>
      ok(
        await withReport(async (page) => {
          const tag = await page.evaluate(F.tagMatrix, { titleMatch, index });
          if (!tag.found)
            return { connected: true, found: false, reason: 'no matrix matched', titles: tag.titles };
          let data = await page.evaluate(F.readTaggedMatrix);
          // Virtualized: scroll + re-read, merge by row header.
          if (!data.complete) {
            const byHeader = new Map();
            for (const r of data.rows) if (r.header != null) byHeader.set(r.header, r);
            for (let i = 0; i < 20 && byHeader.size < (data.ariaRowCount || 0); i++) {
              await page.evaluate(F.scrollTaggedMatrix, 400);
              await new Promise((r) => setTimeout(r, 250));
              // Re-tag (scroll may re-render) then re-read.
              await page.evaluate(F.tagMatrix, { titleMatch, index: tag.index });
              const more = await page.evaluate(F.readTaggedMatrix);
              if (!more.found) break;
              for (const r of more.rows) if (r.header != null && !byHeader.has(r.header)) byHeader.set(r.header, r);
              if (more.rows.length && data.columns.length === 0) data.columns = more.columns;
            }
            data = {
              found: true,
              columns: data.columns,
              rows: [...byHeader.values()],
              ariaRowCount: data.ariaRowCount,
              ariaColCount: data.ariaColCount,
              domRows: byHeader.size,
              complete: byHeader.size >= (data.ariaRowCount || 0),
            };
          }
          return { connected: true, ...data, titleIndex: tag.index };
        })
      )
  );

  /* 11. pbi_matrix_expand ------------------------------------------------- */
  server.registerTool(
    'pbi_matrix_expand',
    {
      description:
        'Expand or collapse a matrix hierarchy row (by rowHeader). Grid re-renders; returns {rowsBefore, rowsAfter}.',
      inputSchema: {
        rowHeader: z.string(),
        titleMatch: z.string().optional(),
        collapse: z.boolean().optional(),
      },
    },
    async ({ rowHeader, titleMatch, collapse }) =>
      ok(
        await withReport(async (page) => {
          const tag = await page.evaluate(F.tagMatrix, { titleMatch, index: 0 });
          if (!tag.found) return { connected: true, found: false, reason: 'no matrix matched' };
          const rowsBefore = await page.evaluate(F.taggedMatrixRowCount);
          const exp = await page.evaluate(F.tagMatrixExpander, rowHeader);
          if (!exp.found)
            return { connected: true, found: false, reason: 'row/expander not found', rowsBefore };
          await robustClick(page, exp.selector, false);
          // Re-locate grid (repaint) and poll row count for a change.
          const res = await poll(
            async () => {
              await page.evaluate(F.tagMatrix, { titleMatch, index: tag.index });
              return page.evaluate(F.taggedMatrixRowCount);
            },
            (v) => v != null && v !== rowsBefore,
            5000,
            300
          );
          return {
            connected: true,
            action: collapse ? 'collapse' : 'expand',
            rowsBefore,
            rowsAfter: res.value,
            changed: res.satisfied,
          };
        })
      )
  );

  /* 12. pbi_cross_filter_test --------------------------------------------- */
  server.registerTool(
    'pbi_cross_filter_test',
    {
      description:
        'Click a data point and judge whether a cross-filter FIRED (highlights rose OR card fingerprint changed). Optional restore re-clicks and verifies baseline. Returns {fired, highlightsBefore, highlightsAfter, changedCards, restored}.',
      inputSchema: {
        ariaLabel: z.string().optional(),
        selector: z.string().optional(),
        restore: z.boolean().optional(),
      },
    },
    async ({ ariaLabel, selector, restore = true }) =>
      ok(
        await withReport(async (page) => {
          const tag = await page.evaluate(F.tagForClick, { ariaLabel, selector });
          if (!tag.found) return { connected: true, fired: false, reason: 'target not found' };
          const before = await page.evaluate(F.crossFilterProbe);
          const cardsBefore = await page.evaluate(F.readCards);
          await robustClick(page, tag.selector, false);
          const res = await poll(
            () => page.evaluate(F.crossFilterProbe),
            (v) => v.highlights > before.highlights || v.fingerprint !== before.fingerprint,
            6000,
            300
          );
          const after = res.value;
          const cardsAfter = await page.evaluate(F.readCards);
          const fired = after.highlights > before.highlights || after.fingerprint !== before.fingerprint;
          const changedCards = [];
          const beforeMap = new Map(cardsBefore.map((c) => [c.title, c.value]));
          for (const c of cardsAfter) {
            const bv = beforeMap.get(c.title);
            if (bv !== undefined && bv !== c.value) changedCards.push({ title: c.title, before: bv, after: c.value });
          }
          let restored;
          if (restore && fired) {
            // Re-tag (repaint) and click again to deselect.
            const rtag = await page.evaluate(F.tagForClick, { ariaLabel, selector });
            if (rtag.found) {
              await robustClick(page, rtag.selector, false);
              const rres = await poll(
                () => page.evaluate(F.crossFilterProbe),
                (v) => v.fingerprint === before.fingerprint,
                5000,
                300
              );
              restored = rres.satisfied;
            }
          }
          return {
            connected: true,
            fired,
            highlightsBefore: before.highlights,
            highlightsAfter: after.highlights,
            changedCards,
            restored,
          };
        })
      )
  );

  /* 13. pbi_hover_tooltip ------------------------------------------------- */
  server.registerTool(
    'pbi_hover_tooltip',
    {
      description:
        'Trusted mouse-move hover to a point (offsetX/offsetY to aim off-center, e.g. donut ring) and read the tooltip text. Returns {tooltipText} or {tooltipText:null}.',
      inputSchema: {
        selector: z.string().optional(),
        ariaLabel: z.string().optional(),
        offsetX: z.number().optional(),
        offsetY: z.number().optional(),
      },
    },
    async ({ selector, ariaLabel, offsetX, offsetY }) =>
      ok(
        await withReport(async (page) => {
          const tag = await page.evaluate(F.tagForHover, { selector, ariaLabel });
          if (!tag.found) return { connected: true, tooltipText: null, reason: 'target not found' };
          const box = await page.locator(tag.selector).boundingBox();
          if (!box) return { connected: true, tooltipText: null, reason: 'no bounding box' };
          const px = box.x + (offsetX != null ? offsetX : box.width / 2);
          const py = box.y + (offsetY != null ? offsetY : box.height / 2);
          await page.mouse.move(px, py);
          const res = await poll(
            () => page.evaluate(F.readTooltip),
            (v) => v != null,
            2000,
            200
          );
          // Move to a neutral corner after.
          await page.mouse.move(5, 5);
          return { connected: true, tooltipText: res.value };
        })
      )
  );

  /* 14. pbi_scan_errors --------------------------------------------------- */
  server.registerTool(
    'pbi_scan_errors',
    {
      description:
        'Scan visible visuals for broken/errored surfaces + recent non-benign console errors. Excludes the permanent favicon.ico error (reported as benignFaviconCount).',
      inputSchema: {},
    },
    async () =>
      ok(
        await withReport(async (page) => {
          const scan = await page.evaluate(F.scanBrokenVisuals);
          const cs = consoleSnapshot();
          return {
            connected: true,
            brokenVisuals: scan.brokenVisuals,
            consoleErrors: cs.errors,
            benignFaviconCount: cs.benignFaviconCount,
            visibleVisualCount: scan.visibleVisualCount,
          };
        })
      )
  );

  /* 15. pbi_perf_analyzer ------------------------------------------------- */
  server.registerTool(
    'pbi_perf_analyzer',
    {
      description:
        'Run the Performance Analyzer lane: per-visual render ms; optional captureQueryFor grabs one visual DAX via clipboard (clobbers clipboard). Restores pane + ribbon.',
      inputSchema: { captureQueryFor: z.string().optional() },
    },
    async ({ captureQueryFor }) =>
      ok(
        await withReport(async (page) => {
          // Open Optimize ribbon tab -> Performance analyzer button.
          const opt = await page.evaluate(F.tagRibbonTab, 'Optimize');
          if (opt.found) {
            await robustClick(page, opt.selector, false);
            await new Promise((r) => setTimeout(r, 400));
          }
          const paneBtn = await page.evaluate(F.tagRibbonButton, 'Performance analyzer');
          if (!paneBtn.found)
            return { connected: true, reason: 'Performance analyzer button not found (is Optimize tab active?)' };
          await robustClick(page, paneBtn.selector, false);
          await poll(() => page.evaluate(F.tagPerfControl, 'start').then((r) => r.paneOpen), (v) => v === true, 4000);

          const startTag = await page.evaluate(F.tagPerfControl, 'start');
          if (startTag.found) await robustClick(page, startTag.selector, false);
          const refreshTag = await page.evaluate(F.tagPerfControl, 'refresh');
          if (refreshTag.found) await robustClick(page, refreshTag.selector, false);

          // Poll for rows to appear and count to stabilize (~3 stable reads, cap 45s).
          let last = -1;
          let stable = 0;
          let rows = [];
          const start = Date.now();
          while (Date.now() - start < 45000) {
            const r = await page.evaluate(F.readPerfRows);
            rows = r.rows;
            if (rows.length > 0 && rows.length === last) {
              stable++;
              if (stable >= 3) break;
            } else {
              stable = 0;
            }
            last = rows.length;
            await new Promise((res) => setTimeout(res, 800));
          }

          let capturedQuery;
          let clipboardClobbered;
          if (captureQueryFor) {
            const rowTag = await page.evaluate(F.tagPerfRow, captureQueryFor);
            if (rowTag.found) {
              await robustClick(page, rowTag.selector, false);
              await new Promise((r) => setTimeout(r, 500));
              const copyTag = await page.evaluate(F.tagPerfCopyQuery, captureQueryFor);
              if (copyTag.found) {
                await robustClick(page, copyTag.selector, false);
                await new Promise((r) => setTimeout(r, 400));
                try {
                  capturedQuery = await page.evaluate(() => navigator.clipboard.readText());
                  clipboardClobbered = true;
                } catch (e) {
                  capturedQuery = null;
                  clipboardClobbered = true;
                }
              }
            }
          }

          // Restore: stop -> Clear -> close pane -> Home.
          const stopTag = await page.evaluate(F.tagPerfControl, 'stop');
          if (stopTag.found) await robustClick(page, stopTag.selector, false);
          const clearTag = await page.evaluate(F.tagPerfControl, 'clear');
          if (clearTag.found) await robustClick(page, clearTag.selector, false);
          const closeBtn = await page.evaluate(F.tagRibbonButton, 'Performance analyzer');
          if (closeBtn.found) await robustClick(page, closeBtn.selector, false);
          const home = await page.evaluate(F.tagRibbonTab, 'Home');
          if (home.found) await robustClick(page, home.selector, false);

          const out = { connected: true, rows };
          if (captureQueryFor) {
            out.capturedQuery = capturedQuery;
            out.clipboardClobbered = clipboardClobbered;
          }
          return out;
        })
      )
  );

  /* 16. pbi_page_sweep ---------------------------------------------------- */
  server.registerTool(
    'pbi_page_sweep',
    {
      description:
        'Iterate pages (default all), goto each, wait canvas-ready (cap 30s/page), record loadMs + error scan + cards fingerprint. Restores the original page. Returns per-page array + {startedOn, restoredTo}.',
      inputSchema: {
        pages: z.array(z.string()).optional(),
        errorScan: z.boolean().optional(),
      },
    },
    async ({ pages, errorScan = true }) =>
      ok(
        await withReport(async (page) => {
          const all = await page.evaluate(F.listPages);
          const startedOn = (all.find((p) => p.active) || {}).name || null;
          const targets = pages && pages.length ? pages : all.map((p) => p.name);
          const results = [];
          for (const name of targets) {
            const tag = await page.evaluate(F.tagPageTab, name);
            if (!tag.found) {
              results.push({ page: name, navigated: false, reason: 'not-found' });
              continue;
            }
            const t0 = Date.now();
            await robustClick(page, tag.selector, false);
            const ready = await poll(
              () => page.evaluate(F.pageMetadata),
              (v) => v.activePage === name && v.canvasReady,
              30000,
              300
            );
            const loadMs = Date.now() - t0;
            const entry = { page: name, navigated: ready.value.activePage === name, loadMs, canvasReady: ready.value.canvasReady };
            if (errorScan) {
              const scan = await page.evaluate(F.scanBrokenVisuals);
              entry.brokenVisuals = scan.brokenVisuals;
              entry.visibleVisualCount = scan.visibleVisualCount;
            }
            const cards = await page.evaluate(F.readCards);
            entry.cardsFingerprint = cards.map((c) => `${c.title}=${c.value}`).join('|');
            results.push(entry);
          }
          // Restore original page.
          let restoredTo = startedOn;
          if (startedOn) {
            const bt = await page.evaluate(F.tagPageTab, startedOn);
            if (bt.found) {
              await robustClick(page, bt.selector, false);
              await poll(() => page.evaluate(F.activePageName), (v) => v === startedOn, 15000, 300);
              restoredTo = await page.evaluate(F.activePageName);
            }
          }
          return { connected: true, pages: results, startedOn, restoredTo };
        })
      )
  );

  /* 17. pbi_baseline ------------------------------------------------------ */
  server.registerTool(
    'pbi_baseline',
    {
      description:
        'Capture / compare / list value baselines. capture: store {cards, badges, visibleVisualCount} per page (default current; pages:["*"]=all) to <outputDir>/baselines/<name>.json. compare: re-capture + diff. list: available baseline names.',
      inputSchema: {
        action: z.enum(['capture', 'compare', 'list']),
        name: z.string().optional(),
        pages: z.array(z.string()).optional(),
      },
    },
    async ({ action, name, pages }) => {
      if (action === 'list') {
        ensureDir(BASELINE_DIR);
        const names = fs
          .readdirSync(BASELINE_DIR)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace(/\.json$/, ''));
        return ok({ connected: true, baselines: names });
      }
      if (!name) return ok({ connected: false, error: 'name is required for capture/compare' });

      return ok(
        await withReport(async (page) => {
          const all = await page.evaluate(F.listPages);
          const original = (all.find((p) => p.active) || {}).name || null;
          const wantAll = pages && pages.length === 1 && pages[0] === '*';
          const scope = wantAll ? all.map((p) => p.name) : pages && pages.length ? pages : original ? [original] : [];

          const captureScope = async () => {
            const snap = {};
            for (const pg of scope) {
              const tag = await page.evaluate(F.tagPageTab, pg);
              if (tag.found && !tag.active) {
                await robustClick(page, tag.selector, false);
                await poll(
                  () => page.evaluate(F.pageMetadata),
                  (v) => v.activePage === pg && v.canvasReady,
                  30000,
                  300
                );
              }
              const s = await page.evaluate(F.stateProbe);
              snap[pg] = { cards: s.cards, badges: s.badges, visibleVisualCount: s.visibleVisualCount };
            }
            // restore
            if (original) {
              const bt = await page.evaluate(F.tagPageTab, original);
              if (bt.found) {
                await robustClick(page, bt.selector, false);
                await poll(() => page.evaluate(F.activePageName), (v) => v === original, 15000, 300);
              }
            }
            return snap;
          };

          if (action === 'capture') {
            ensureDir(BASELINE_DIR);
            const snap = await captureScope();
            const payload = { name, capturedAt: new Date().toISOString(), scope, pages: snap };
            fs.writeFileSync(path.join(BASELINE_DIR, `${name}.json`), JSON.stringify(payload, null, 2));
            return { connected: true, action, name, pagesCaptured: scope, path: path.join(BASELINE_DIR, `${name}.json`) };
          }

          // compare
          const file = path.join(BASELINE_DIR, `${name}.json`);
          if (!fs.existsSync(file)) return { connected: true, action, error: `baseline "${name}" not found` };
          const base = JSON.parse(fs.readFileSync(file, 'utf8'));
          const now = await captureScope();
          const changed = [];
          const added = [];
          const removed = [];
          let pagesCompared = 0;
          for (const pg of Object.keys(base.pages)) {
            const b = base.pages[pg];
            const n = now[pg];
            if (!n) {
              removed.push({ page: pg });
              continue;
            }
            pagesCompared++;
            const bMap = new Map((b.cards || []).map((c) => [c.title, c.value]));
            const nMap = new Map((n.cards || []).map((c) => [c.title, c.value]));
            for (const [title, val] of bMap) {
              if (!nMap.has(title)) removed.push({ page: pg, card: title });
              else if (nMap.get(title) !== val) changed.push({ page: pg, card: title, before: val, after: nMap.get(title) });
            }
            for (const [title, val] of nMap) {
              if (!bMap.has(title)) added.push({ page: pg, card: title, after: val });
            }
          }
          return {
            connected: true,
            action,
            name,
            pagesCompared,
            changed,
            added,
            removed,
            identical: changed.length === 0 && added.length === 0 && removed.length === 0,
          };
        })
      );
    }
  );

  /* 18. pbi_wait_for ------------------------------------------------------ */
  server.registerTool(
    'pbi_wait_for',
    {
      description:
        'Poll body innerText until text appears (text) or disappears (textGone). Returns {satisfied, elapsedMs}.',
      inputSchema: {
        text: z.string().optional(),
        textGone: z.string().optional(),
        timeoutMs: z.number().int().optional(),
      },
    },
    async ({ text, textGone, timeoutMs = 8000 }) =>
      ok(
        await withReport(async (page) => {
          const res = await poll(
            () => page.evaluate(F.bodyText),
            (body) => {
              if (text && !body.includes(text)) return false;
              if (textGone && body.includes(textGone)) return false;
              return true;
            },
            timeoutMs,
            200
          );
          return { connected: true, satisfied: res.satisfied, elapsedMs: res.elapsedMs };
        })
      )
  );

  /* 19. pbi_eval ---------------------------------------------------------- */
  server.registerTool(
    'pbi_eval',
    {
      description:
        'Escape hatch: evaluate a function-body or arrow-fn string in the reportView page. Rejects any code referencing powerBIAccessToken. Returns the JSON-serialized result.',
      inputSchema: { js: z.string() },
    },
    async ({ js }) => {
      if (/powerBIAccessToken/i.test(js)) {
        return ok({
          connected: false,
          rejected: true,
          error: 'Refused: code references powerBIAccessToken (token access is forbidden).',
        });
      }
      return ok(
        await withReport(async (page) => {
          // Support both a bare expression/function-body and an arrow/function string.
          const trimmed = js.trim();
          const looksLikeFn = /^\s*(\(|async\s|function\b)/.test(trimmed) || /=>/.test(trimmed);
          let result;
          if (looksLikeFn) {
            result = await page.evaluate((code) => {
              // eslint-disable-next-line no-eval
              const fn = eval('(' + code + ')');
              return typeof fn === 'function' ? fn() : fn;
            }, trimmed);
          } else {
            result = await page.evaluate((code) => {
              // eslint-disable-next-line no-new-func
              return new Function('return (' + code + ')')();
            }, trimmed);
          }
          return { connected: true, result };
        })
      );
    }
  );

  /* 20. pbi_screenshot ---------------------------------------------------- */
  server.registerTool(
    'pbi_screenshot',
    {
      description:
        'Screenshot the reportView page to the output dir (never the repo). Optional filename + fullPage. Returns {path}.',
      inputSchema: {
        filename: z.string().optional(),
        fullPage: z.boolean().optional(),
      },
    },
    async ({ filename, fullPage }) =>
      ok(
        await withReport(async (page) => {
          ensureDir(OUTPUT_DIR);
          const fname = (filename || `shot-${Date.now()}.png`).replace(/[\\/]/g, '_');
          const abs = path.join(OUTPUT_DIR, fname);
          await page.screenshot({ path: abs, fullPage: !!fullPage });
          return { connected: true, path: abs };
        })
      )
  );
}

export { OUTPUT_DIR, BASELINE_DIR };
