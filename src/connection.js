/**
 * Lazy CDP connection to Power BI Desktop's WebView2 report canvas.
 *
 * - Never connects at startup — connect() runs on first tool call.
 * - Finds the report page by url().includes('reportView'); caches browser+page.
 * - Attaches console + pageerror listeners into a ring buffer.
 * - withReport(fn) wraps every tool: connect if needed, run fn(page), and on a
 *   disconnect-class error reset + reconnect + retry ONCE. Unreachable Desktop
 *   returns a structured {connected:false, ...} — never throws to the MCP layer.
 */
import { chromium } from 'playwright-core';

const CDP_ENDPOINT = process.env.PBI_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const CONSOLE_CAP = 200;
const DISCONNECT_RE = /Target.*closed|disconnected|browser has been closed|Session closed/i;

const HINT =
  'Launch Desktop via ~/.claude/scripts/pbi-desktop-debug.ps1 (CDP port is launch-time only); ' +
  'health: http://127.0.0.1:9222/json/version';

let _browser = null;
let _page = null;
const _console = []; // ring buffer of {type, text, benign}

function pushConsole(entry) {
  _console.push(entry);
  if (_console.length > CONSOLE_CAP) _console.shift();
}

function isBenignFavicon(text) {
  return /favicon\.ico/i.test(text) && /ERR_FILE_NOT_FOUND/i.test(text);
}

function attachListeners(page) {
  page.on('console', (msg) => {
    let text = '';
    try { text = msg.text(); } catch (e) { text = String(e); }
    pushConsole({ type: msg.type(), text, benign: isBenignFavicon(text) });
  });
  page.on('pageerror', (err) => {
    const text = (err && err.message) || String(err);
    pushConsole({ type: 'pageerror', text, benign: isBenignFavicon(text) });
  });
}

function findReportPage(browser) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      let url = '';
      try { url = p.url(); } catch (e) { url = ''; }
      if (url.includes('reportView')) return p;
    }
  }
  return null;
}

/** Reset cached handles (does NOT close Desktop). */
export function reset() {
  if (_browser) {
    try { _browser.close(); } catch (e) { /* connectOverCDP close only disconnects */ }
  }
  _browser = null;
  _page = null;
}

/**
 * Ensure a live browser + report page. Throws a plain Error tagged .unreachable
 * on failure so withReport can convert it to a structured result.
 */
async function connect() {
  if (_page && _browser && _browser.isConnected() && !_page.isClosed()) return _page;
  // stale handles
  _browser = null;
  _page = null;
  let browser;
  try {
    // Attach to this WebView2 costs ~8s on a heavy report (measured raw-CDP:
    // first Runtime.evaluate 7.7s, subsequent 13ms) — 8s timeout raced it.
    browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 30000 });
  } catch (e) {
    const err = new Error(`CDP connect failed at ${CDP_ENDPOINT}: ${e.message || e}`);
    err.unreachable = true;
    throw err;
  }
  const page = findReportPage(browser);
  if (!page) {
    try { browser.close(); } catch (e) { /* ignore */ }
    const err = new Error(
      `Connected to CDP at ${CDP_ENDPOINT} but no reportView page found (open a report in Desktop).`
    );
    err.unreachable = true;
    throw err;
  }
  _browser = browser;
  _page = page;
  attachListeners(page);
  // Warm-up: the FIRST evaluate on a fresh attach pays ~8s of context discovery
  // (measured); pay it here once so tool calls start from the 13ms warm path.
  try {
    await page.evaluate(() => 1);
  } catch (e) {
    /* non-fatal — the first tool call just pays the cost instead */
  }
  return page;
}

/**
 * Budget every page.evaluate: an evaluate queues BEHIND the renderer's main
 * thread, so a "cheap" read against a canvas that is mid-render blocks for the
 * whole render (observed: minutes). Convert that into a fast structured
 * "renderer-busy" error instead. Override via PBI_EVAL_BUDGET_MS.
 */
const EVAL_BUDGET_MS = (() => {
  const v = parseInt(process.env.PBI_EVAL_BUDGET_MS || '', 10);
  return Number.isNaN(v) ? 30000 : v; // first-touch after attach ≈8s; renders can hold the thread longer
})();

function budgetedPage(page) {
  return new Proxy(page, {
    get(target, prop) {
      if (prop === 'evaluate') {
        return (fn, arg) => {
          // A single time budget so a call can never hang forever if it lands
          // mid-render. The page functions themselves are cheap and scoped (no
          // canvas-wide scans — that was the real freeze, fixed in pagefns), so
          // this is a safety net, not the primary defense. No self-heal recycle:
          // recycling churned the connection; a plain timeout is enough.
          let t;
          const timeout = new Promise((_, reject) => {
            t = setTimeout(
              () =>
                reject(
                  new Error(
                    `renderer-busy: the report canvas did not yield within ${EVAL_BUDGET_MS}ms ` +
                      '(page switch or visual queries in flight); retry in a few seconds'
                  )
                ),
              EVAL_BUDGET_MS
            );
          });
          const run = target.evaluate(fn, arg);
          run.catch(() => {}); // avoid unhandled rejection after we bail on the race
          return Promise.race([run, timeout]).finally(() => clearTimeout(t));
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * Run fn(page) with connect + one reconnect-retry on disconnect-class errors.
 * On unreachable Desktop, returns a structured object (does NOT throw).
 */
export async function withReport(fn) {
  let page;
  try {
    page = await connect();
  } catch (e) {
    if (e.unreachable) {
      return { connected: false, error: e.message, hint: HINT };
    }
    return { connected: false, error: String(e.message || e), hint: HINT };
  }
  try {
    return await fn(budgetedPage(page));
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (DISCONNECT_RE.test(msg)) {
      reset();
      try {
        page = await connect();
      } catch (e2) {
        return { connected: false, error: String((e2 && e2.message) || e2), hint: HINT };
      }
      try {
        return await fn(budgetedPage(page));
      } catch (e3) {
        // second failure: surface as structured error, not a thrown MCP error
        return { connected: false, error: String((e3 && e3.message) || e3), hint: HINT };
      }
    }
    // Non-disconnect error: rethrow so the tool wrapper can format it.
    throw e;
  }
}

/** Snapshot of the console ring buffer (non-benign + benign favicon count). */
export function consoleSnapshot() {
  const all = _console.slice();
  const benignFaviconCount = all.filter((e) => e.benign).length;
  const errors = all
    .filter((e) => !e.benign && (e.type === 'error' || e.type === 'pageerror'))
    .map((e) => ({ type: e.type, text: e.text }));
  return { errors, benignFaviconCount };
}

export { CDP_ENDPOINT, HINT };
