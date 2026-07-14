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
  _inFlight = 0; // pending evaluates died with the connection
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
    browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 8000 });
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
  return Number.isNaN(v) ? 10000 : v;
})();

// Single-flight gate: at most ONE of our evaluates may be pending against the
// renderer at any time. A busy canvas already has our previous evaluate queued;
// stacking more (poll loops, concurrent tools) piles work onto the exact main
// thread that is trying to render the visuals. Everything beyond the one
// in-flight evaluate answers renderer-busy WITHOUT touching the page.
let _inFlight = 0;
let _inFlightSince = 0;

function budgetedPage(page) {
  return new Proxy(page, {
    get(target, prop) {
      if (prop === 'evaluate') {
        return (fn, arg) => {
          if (_inFlight > 0) {
            // Self-heal: a pending evaluate older than 3x the budget is a zombie
            // (e.g. issued into a context the load-time navigation destroyed) —
            // the canvas can be fully idle and it still never settles. Recycle
            // the CDP connection: the disconnect kills the zombie, withReport's
            // disconnect handling reconnects fresh and retries the caller.
            if (Date.now() - _inFlightSince > EVAL_BUDGET_MS * 3) {
              reset();
              return Promise.reject(
                new Error('Target closed: recycled a stale pending evaluate; reconnecting')
              );
            }
            return Promise.reject(
              new Error(
                'renderer-busy: a previous evaluate is still queued behind the rendering canvas; retry in a few seconds'
              )
            );
          }
          _inFlight += 1;
          _inFlightSince = Date.now();
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
          // The underlying evaluate keeps _inFlight held until the renderer
          // actually answers it — even after we give up and report busy. That
          // is the point: it stops new evaluates from stacking meanwhile.
          const run = target.evaluate(fn, arg).finally(() => {
            _inFlight = Math.max(0, _inFlight - 1); // reset() may already have zeroed it
          });
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
