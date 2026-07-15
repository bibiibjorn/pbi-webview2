/**
 * Render-stable wait — decide when the report canvas has finished repainting.
 *
 * Power BI Desktop has no "render done" event reachable over CDP. The empirical
 * signal (verified live 2026-07-15, Desktop 2.155): the CDP Performance domain's
 * LayoutCount + RecalcStyleCount CLIMB while a page repaints (measured 0→102→105
 * on a page switch) then go FLAT once render settles (~1000ms). A SECONDARY idle
 * signal is the count of `[aria-busy="true"]` nodes (0 when idle).
 *
 * CRITICAL: a NEW CDP session RESETS the Performance counters to 0. So waitStable
 * opens ONE session and compares DELTAS across its OWN sampling loop — never
 * across sessions. The raw CDP session also bypasses the budgetedPage evaluate
 * proxy, which is fine here: the reads are tiny and the loop is time-bounded.
 */

/**
 * Wait until the report canvas render settles (or timeoutMs elapses).
 *
 * Each tick reads {LayoutCount, RecalcStyleCount} from Performance.getMetrics via
 * a single persistent CDP session AND {busy, vis} from a warm page.evaluate. A
 * tick is "quiet" when Layout+Recalc are UNCHANGED from the previous tick AND
 * busy===0; the FIRST tick has no previous sample so it can never be quiet. When
 * consecutive quiet ticks reach quietTicks, the canvas is stable.
 *
 * @param {import('playwright-core').Page} page reportView page
 * @param {{timeoutMs?:number, quietTicks?:number, intervalMs?:number}} [opts]
 * @returns {Promise<{stable:boolean, elapsedMs:number, ticks:number,
 *   lastLayoutCount:number|null, visibleVisualCount:number|null, busy:number|null}>}
 */
export async function waitStable(page, { timeoutMs = 15000, quietTicks = 2, intervalMs = 350 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const start = Date.now();
  let ticks = 0;
  let quiet = 0;
  let prev = null; // { L, R } from the previous tick
  let lastLayoutCount = null;
  let visibleVisualCount = null;
  let busy = null;
  let stable = false;

  // Pull LayoutCount + RecalcStyleCount out of the Performance.getMetrics array.
  const readMetrics = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const by = (name) => {
      const m = (metrics || []).find((x) => x.name === name);
      return m ? m.value : null;
    };
    return { L: by('LayoutCount'), R: by('RecalcStyleCount') };
  };

  try {
    while (Date.now() - start < timeoutMs) {
      const m = await readMetrics();
      const dom = await page.evaluate(() => ({
        busy: document.querySelectorAll('[aria-busy="true"]').length,
        vis: document.querySelectorAll('.visualContainer').length,
      }));
      ticks++;
      lastLayoutCount = m.L;
      visibleVisualCount = dom.vis;
      busy = dom.busy;

      // The first tick has no previous sample, so it can never be "quiet".
      if (prev && m.L === prev.L && m.R === prev.R && dom.busy === 0) {
        quiet++;
        if (quiet >= quietTicks) {
          stable = true;
          break;
        }
      } else {
        quiet = 0;
      }
      prev = m;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  } finally {
    await cdp.detach().catch(() => {});
  }

  return {
    stable,
    elapsedMs: Date.now() - start,
    ticks,
    lastLayoutCount,
    visibleVisualCount,
    busy,
  };
}
