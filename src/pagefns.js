/**
 * Page-side functions — plain functions serialized and run INSIDE the WebView2
 * report page via `page.evaluate(fn, arg)`. Single source of truth for every DOM
 * probe/selector; never inline-duplicate these as strings elsewhere.
 *
 * Each function must be self-contained (no closure over module scope) because
 * Playwright serializes the function body and re-parses it in the page. Helpers
 * are defined INSIDE each function for that reason. All selectors/traps here are
 * verified against Power BI Desktop 2.155 (2026-07-14) — see the pbi-ui-test skill
 * and UI-Testing-CDP.md canon.
 */

/* ------------------------------------------------------------------ helpers */
// NB: these are duplicated inside each evaluate below on purpose — a page.evaluate
// fn cannot reference module-scope symbols. Kept here only as documentation of the
// canonical selector semantics.

/* ---------------------------------------------------------------- metadata */

/** Zero-click metadata sweep: report name, save state, build, zoom, pages, canvas-ready. */
export function pageMetadata() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const tabs = q('[role="tab"]')
    .map((t) => (t.textContent || '').trim())
    .filter((t) => t.endsWith('x'));
  const activeTabEl = q('[role="tab"][aria-selected="true"]').find((t) =>
    (t.textContent || '').trim().endsWith('x')
  );
  const activePage = activeTabEl ? (activeTabEl.textContent || '').trim().replace(/x$/, '') : null;

  // Title bar text: "R0105-Wealth Reporting· Last saved: Today at 5:09 PM (Power BI Project)".
  // CRITICAL: never scan q('*') + textContent here — that is an O(n²) walk over the
  // ENTIRE report canvas (tens of thousands of nodes) that pins the WebView2 main
  // thread and freezes the report. The title lives in the app title bar, a tiny
  // scoped region. Query only known title-bar containers, and read the LEAF text
  // nodes there via a shallow, bounded scan.
  // The title-bar container's textContent is a run-on of ALL toolbar text, e.g.
  // "SaveUndo…Redo…R0105-Wealth Reporting· Last saved: Today at 5:09 PM  (Power
  // BI Project)Bjorn Braet…". Don't rely on element boundaries — isolate the
  // "<name>· Last saved: <…>(… Project)" window with a regex on the raw text.
  // Bounded scopes only (never a canvas-wide scan — that was the freeze).
  const hasSaved = (t) => /·\s*Last saved:/.test(t);
  let rawTitle = null;
  const titleScopes = q(
    '[class*="titlebar" i], [class*="title-bar" i], [class*="appTitle" i], [aria-label*="Last saved" i], [title*="Last saved" i]'
  );
  for (const scope of titleScopes) {
    const t = (scope.textContent || '').trim();
    if (hasSaved(t) && t.length < 600) {
      rawTitle = t;
      break;
    }
  }
  if (!rawTitle && hasSaved(document.title || '')) rawTitle = (document.title || '').trim();

  let reportName = null;
  let lastSaved = null;
  let titleBar = null;
  if (rawTitle) {
    // name = the token run immediately before "·"; the toolbar words before it
    // ("…Redo the last action you undid.") end in a period, so cut at the last
    // sentence boundary. saved = between "Last saved:" and the "(… Project)" tag.
    const m = rawTitle.match(/([^.·]+?)\s*·\s*Last saved:\s*(.*?)\s*\(([^)]*Project[^)]*)\)/i);
    if (m) {
      reportName = m[1].trim() || null;
      lastSaved = m[2].trim() || null;
      titleBar = `${reportName}· Last saved: ${lastSaved}  (${m[3].trim()})`;
    } else {
      titleBar = rawTitle.slice(0, 200);
    }
  }

  let desktopBuild = null;
  try {
    desktopBuild = (window.powerbi && window.powerbi.build) || null;
  } catch (e) { /* ignore */ }

  // Zoom: the status-bar zoom button (aria-label starts "Zoom level"); its text
  // is the clean value like "42%". Extract with /\d+%/.
  let zoom = null;
  const zoomBtn = q('[aria-label]').find((el) =>
    /^Zoom level/i.test((el.getAttribute('aria-label') || '').trim())
  );
  if (zoomBtn) {
    const m = (zoomBtn.textContent || '').match(/\d+%/);
    if (m) zoom = m[0];
    else {
      const am = (zoomBtn.getAttribute('aria-label') || '').match(/\d+%/);
      if (am) zoom = am[0];
    }
  }
  if (!zoom) {
    const zt = q('[class*="zoom" i]')
      .map((el) => (el.textContent || ''))
      .map((t) => (t.match(/\d+%/) || [])[0])
      .find(Boolean);
    if (zt) zoom = zt;
  }

  const visibleVisualCount = q('.visualContainer').length;
  const canvasReady = tabs.length > 0 && visibleVisualCount > 0;

  return {
    titleBar,
    reportName,
    lastSaved,
    desktopBuild,
    activePage,
    pageCount: tabs.length,
    zoom,
    canvasReady,
    visibleVisualCount,
  };
}

/* -------------------------------------------------------------------- pages */

/** All page tabs as [{name, active}]. */
export function listPages() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  return q('[role="tab"]')
    .map((t) => ({ el: t, txt: (t.textContent || '').trim() }))
    .filter((o) => o.txt.endsWith('x'))
    .map((o) => ({
      name: o.txt.replace(/x$/, ''),
      active: o.el.getAttribute('aria-selected') === 'true',
    }));
}

/** The active page name (or null). */
export function activePageName() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const el = q('[role="tab"][aria-selected="true"]').find((t) =>
    (t.textContent || '').trim().endsWith('x')
  );
  return el ? (el.textContent || '').trim().replace(/x$/, '') : null;
}

/**
 * Tag a page tab by EXACT name (textContent === name + 'x'). Returns
 * {found, selector, active, candidates}. candidates = case-insensitive contains.
 */
export function tagPageTab(name) {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const tabs = q('[role="tab"]')
    .map((t) => ({ el: t, txt: (t.textContent || '').trim() }))
    .filter((o) => o.txt.endsWith('x'));
  const want = name + 'x';
  const exact = tabs.find((o) => o.txt === want);
  if (exact) {
    document.querySelectorAll('[data-pw="pw-pagetab"]').forEach(function (e) { e.removeAttribute('data-pw'); });
    exact.el.setAttribute('data-pw', 'pw-pagetab');
    return {
      found: true,
      selector: '[data-pw="pw-pagetab"]',
      active: exact.el.getAttribute('aria-selected') === 'true',
      candidates: [],
    };
  }
  const lc = name.toLowerCase();
  const candidates = tabs
    .map((o) => o.txt.replace(/x$/, ''))
    .filter((n) => n.toLowerCase().includes(lc) || lc.includes(n.toLowerCase()));
  return { found: false, selector: null, active: false, candidates };
}

/* ----------------------------------------------------------------- probing */

/** The batched scorecard — one call = the whole state. */
export function stateProbe() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const activeTab = q('[role="tab"][aria-selected="true"]')
    .map((t) => (t.textContent || '').trim())
    .filter((t) => t.endsWith('x'))
    .map((t) => t.replace(/x$/, ''));
  const toggles = q('[role="button"]')
    .filter((el) => ((el.className || '').toString().includes('buttonSlicerVisual')))
    .map((el) => ({ text: (el.textContent || '').trim(), pressed: el.getAttribute('aria-pressed') }));
  const cards = [
    ...new Set(
      q('.visualContainer [aria-label]')
        .map((el) => el.getAttribute('aria-label'))
        .filter((t) => t && / card$/.test(t))
    ),
  ].map((label) => {
    // "Net Asset Value, 672,756,295 card" → title before FIRST comma, value = rest.
    const core = label.replace(/ card$/, '').trim();
    const idx = core.indexOf(',');
    if (idx > -1) {
      return { title: core.slice(0, idx).trim(), value: core.slice(idx + 1).trim() };
    }
    return { title: core.trim(), value: null };
  });
  const badges = [
    ...new Set(
      q('.visualContainer')
        .map((el) => (el.textContent || '').replace('Press Enter to edit', '').trim())
        .filter((t) => /Filters Applied|Filtering by/.test(t))
    ),
  ];
  const selectedCount = q('.transformElement.selected, .visualContainerHost.selected').length;
  const slicerItemsVisible = q('.slicerItemContainer').length;
  const visibleVisualCount = q('.visualContainer').filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).length;

  return {
    activePage: activeTab[0] || null,
    toggles,
    cards,
    badges,
    selectedCount,
    slicerItemsVisible,
    visibleVisualCount,
  };
}

/** Parsed cards only. */
export function readCards() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  return [
    ...new Set(
      q('.visualContainer [aria-label]')
        .map((el) => el.getAttribute('aria-label'))
        .filter((t) => t && / card$/.test(t))
    ),
  ].map((label) => {
    // Split at the FIRST comma: title before it, value = the rest.
    const core = label.replace(/ card$/, '').trim();
    const idx = core.indexOf(',');
    if (idx > -1) {
      return { title: core.slice(0, idx).trim(), value: core.slice(idx + 1).trim() };
    }
    return { title: core.trim(), value: null };
  });
}

/* -------------------------------------------------------------- generic click */

/**
 * Locate + tag a node for a generic click. Match priority:
 *  selector (querySelectorAll) > ariaLabel (exact, then contains) > text (exact, then contains).
 * `index` disambiguates multiple matches. Returns {found, selector, matchedLabel, candidateCount}.
 */
export function tagForClick(arg) {
  const { text, ariaLabel, selector, index } = arg;
  const q = (s) => Array.from(document.querySelectorAll(s));
  let matches = [];
  if (selector) {
    try { matches = q(selector); } catch (e) { matches = []; }
    // When BOTH selector AND ariaLabel are given, narrow the selector set to the
    // element whose aria-label matches (exact, then contains) — this targets e.g.
    // the "Real Estate" donut arc among many `path.slice` elements.
    if (ariaLabel && matches.length) {
      const own = (el) => (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
      // aria-label may live on the element itself or a nearest labelled ancestor/descendant.
      const labelText = (el) => {
        if (own(el).trim()) return own(el);
        const anc = el.closest && el.closest('[aria-label]');
        if (anc && (anc.getAttribute('aria-label') || '').trim()) return anc.getAttribute('aria-label');
        const desc = el.querySelector && el.querySelector('[aria-label]');
        return desc ? (desc.getAttribute('aria-label') || '') : '';
      };
      let narrowed = matches.filter((el) => labelText(el).trim() === ariaLabel);
      if (!narrowed.length) narrowed = matches.filter((el) => labelText(el).includes(ariaLabel));
      if (narrowed.length) matches = narrowed;
    }
  } else if (ariaLabel) {
    const all = q('[aria-label]');
    matches = all.filter((el) => (el.getAttribute('aria-label') || '').trim() === ariaLabel);
    if (!matches.length) {
      matches = all.filter((el) => (el.getAttribute('aria-label') || '').includes(ariaLabel));
    }
  } else if (text) {
    const all = q('[role="button"], button, [role="tab"], .slicerItemContainer, a, span, div');
    matches = all.filter((el) => (el.textContent || '').trim() === text);
    if (!matches.length) {
      matches = all.filter((el) => (el.textContent || '').trim().includes(text));
      // Prefer the smallest matching element (leaf) to avoid huge container hits.
      matches.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    }
  }
  const candidateCount = matches.length;
  if (!candidateCount) return { found: false, selector: null, matchedLabel: null, candidateCount: 0 };
  const el = matches[Math.min(index || 0, matches.length - 1)];
  document.querySelectorAll('[data-pw="pw-click"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-click');
  return {
    found: true,
    selector: '[data-pw="pw-click"]',
    matchedLabel:
      (el.getAttribute && el.getAttribute('aria-label')) || (el.textContent || '').trim().slice(0, 120),
    candidateCount,
  };
}

/* ----------------------------------------------------------------- slicers */

/** Tag a button slicer by exact text; returns {found, selector, pressed}. */
export function tagButtonSlicer(value) {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const btns = q('[role="button"]').filter((el) =>
    (el.className || '').toString().includes('buttonSlicerVisual')
  );
  let el = btns.find((b) => (b.textContent || '').trim() === value);
  if (!el) el = btns.find((b) => (b.textContent || '').trim().includes(value));
  if (!el) return { found: false, selector: null, pressed: null };
  document.querySelectorAll('[data-pw="pw-slicer"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-slicer');
  return { found: true, selector: '[data-pw="pw-slicer"]', pressed: el.getAttribute('aria-pressed') };
}

/** Tag a list slicer item by aria-label / text (popup must be open). */
export function tagSlicerItem(value) {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const items = q('.slicerItemContainer');
  let el = items.find(
    (it) =>
      (it.getAttribute('aria-label') || '').trim() === value ||
      (it.textContent || '').trim() === value
  );
  if (!el) {
    el = items.find(
      (it) =>
        (it.getAttribute('aria-label') || '').includes(value) ||
        (it.textContent || '').includes(value)
    );
  }
  if (!el) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-sloiitem"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-sloiitem');
  return { found: true, selector: '[data-pw="pw-sloiitem"]' };
}

/** Read the aria-pressed of a button slicer by text (re-read after a click). */
export function buttonSlicerState(value) {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const btns = q('[role="button"]').filter((el) =>
    (el.className || '').toString().includes('buttonSlicerVisual')
  );
  let el = btns.find((b) => (b.textContent || '').trim() === value);
  if (!el) el = btns.find((b) => (b.textContent || '').trim().includes(value));
  return el ? el.getAttribute('aria-pressed') : null;
}

/* --------------------------------------------------------------- bookmarks */

/** Is the Bookmarks pane currently open (any bookmark rows present)? */
export function bookmarksPaneOpen() {
  return document.querySelectorAll('.dropzone.bookmark').length > 0;
}

/** Tag a ribbon tab (View/Home/Optimize/...) by exact text; returns {found, selector}. */
export function tagRibbonTab(name) {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const el = q('[role="tab"]').find((t) => (t.textContent || '').trim() === name);
  if (!el) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-ribbontab"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-ribbontab');
  return { found: true, selector: '[data-pw="pw-ribbontab"]' };
}

/** Tag a ribbon button by aria-label; returns {found, selector}. */
export function tagRibbonButton(ariaLabel) {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const el = q('[aria-label]').find(
    (b) => (b.getAttribute('aria-label') || '').trim() === ariaLabel
  );
  if (!el) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-ribbonbtn"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-ribbonbtn');
  return { found: true, selector: '[data-pw="pw-ribbonbtn"]' };
}

/**
 * Find a bookmark leaf row by name (optionally within a group), scroll into view,
 * tag its .title. Returns {found, selector, isGroup, needExpandGroup, groupExpanded, available}.
 *
 * Desktop 2.155+ puts a `.caret` node in EVERY `.dropzone.bookmark` row (leaves too),
 * so caret-presence no longer discriminates. The reliable discriminator is
 * `aria-expanded`: GROUP rows carry it ("true"/"false"); LEAF rows have it === null.
 */
export function tagBookmarkRow(arg) {
  const { name, group } = arg;
  const rows = Array.from(document.querySelectorAll('.dropzone.bookmark')).filter(
    (el) => el.getBoundingClientRect().width > 0
  );
  const titleOf = (el) => (el.querySelector('.title')?.textContent || '').trim();
  // Group rows have an aria-expanded attribute; leaf rows have it === null.
  const expandedAttr = (el) => {
    const own = el.getAttribute('aria-expanded');
    if (own !== null) return own;
    const inner = el.querySelector('[aria-expanded]');
    return inner ? inner.getAttribute('aria-expanded') : null;
  };
  const isGroup = (el) => expandedAttr(el) !== null;
  const available = rows.map((el) => ({ name: titleOf(el), isGroup: isGroup(el) }));

  const leaf = rows.find((el) => titleOf(el) === name && !isGroup(el));
  if (leaf) {
    leaf.scrollIntoView({ block: 'center' });
    const t = leaf.querySelector('.title') || leaf;
    document.querySelectorAll('[data-pw="pw-bmfire"]').forEach(function (e) { e.removeAttribute('data-pw'); });
    t.setAttribute('data-pw', 'pw-bmfire');
    return { found: true, selector: '[data-pw="pw-bmfire"]', isGroup: false, available };
  }
  // Not found as a leaf. If a group was named (or any collapsed group exists), offer to expand.
  const grp = group
    ? rows.find((el) => titleOf(el) === group && isGroup(el))
    : rows.find((el) => isGroup(el) && expandedAttr(el) === 'false');
  if (grp) {
    grp.scrollIntoView({ block: 'center' });
    const groupExpanded = expandedAttr(grp) === 'true';
    // Tag the caret so the caller can expand ONLY when collapsed.
    const t = grp.querySelector('.caret') || grp.querySelector('.title') || grp;
    document.querySelectorAll('[data-pw="pw-bmgroup"]').forEach(function (e) { e.removeAttribute('data-pw'); });
    t.setAttribute('data-pw', 'pw-bmgroup');
    return {
      found: false,
      selector: null,
      isGroup: true,
      groupExpanded,
      needExpandGroup: groupExpanded ? null : '[data-pw="pw-bmgroup"]',
      groupName: titleOf(grp),
      available,
    };
  }
  return { found: false, selector: null, isGroup: false, available };
}

/* ----------------------------------------------------------------- matrix */

/**
 * Tag a matrix/grid by title match / index; returns {found, selector, index, titles, pickedTitle}.
 * With no titleMatch/index the DEFAULT pick is the visible grid with the largest
 * (aria-rowcount × aria-colcount), requiring rowcount > 1 (avoids 1×1 Info-Card grids).
 */
export function tagMatrix(arg) {
  const { titleMatch, index } = arg;
  const containers = Array.from(document.querySelectorAll('.visualContainer')).filter((c) => {
    if (!c.querySelector('[role="grid"]')) return false;
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const gridOf = (c) => c.querySelector('[role="grid"]');
  const titleOf = (c) => {
    const g = gridOf(c);
    return (
      (g && g.getAttribute('aria-label')) ||
      (c.getAttribute('aria-label') || '').trim() ||
      ''
    );
  };
  const rowsOf = (c) => parseInt((gridOf(c) || {}).getAttribute?.('aria-rowcount') || '0', 10) || 0;
  const colsOf = (c) => parseInt((gridOf(c) || {}).getAttribute?.('aria-colcount') || '0', 10) || 0;
  const titles = containers.map(titleOf);
  let picked = -1;
  if (titleMatch) {
    picked = containers.findIndex((c) =>
      titleOf(c).toLowerCase().includes(titleMatch.toLowerCase())
    );
  } else if (index != null) {
    picked = Math.min(index, containers.length - 1);
  } else {
    // Default: largest rowcount×colcount grid with rowcount > 1.
    let best = -1;
    let bestArea = -1;
    for (let i = 0; i < containers.length; i++) {
      const rc = rowsOf(containers[i]);
      const cc = colsOf(containers[i]);
      if (rc <= 1) continue;
      const area = rc * cc;
      if (area > bestArea) {
        bestArea = area;
        best = i;
      }
    }
    picked = best;
  }
  if (picked < 0 || !containers[picked]) return { found: false, selector: null, titles };
  const grid = gridOf(containers[picked]);
  document.querySelectorAll('[data-pw="pw-matrix"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  grid.setAttribute('data-pw', 'pw-matrix');
  return {
    found: true,
    selector: '[data-pw="pw-matrix"]',
    index: picked,
    titles,
    pickedTitle: titleOf(containers[picked]),
  };
}

/** Read a tagged grid ('[data-pw="pw-matrix"]') fully as JSON. */
export function readTaggedMatrix() {
  const grid = document.querySelector('[data-pw="pw-matrix"]');
  if (!grid) return { found: false };
  const q = (root, s) => Array.from(root.querySelectorAll(s));
  const ariaRowCount = parseInt(grid.getAttribute('aria-rowcount') || '0', 10) || null;
  const ariaColCount = parseInt(grid.getAttribute('aria-colcount') || '0', 10) || null;
  const rowEls = q(grid, '[role="row"]');
  const columns = [];
  const rows = [];
  for (const r of rowEls) {
    const headerEl = r.querySelector('[role="rowheader"]');
    const header = headerEl ? (headerEl.textContent || '').trim() : null;
    const cellEls = q(r, '[role="gridcell"], [role="columnheader"]');
    const cells = cellEls.map((c) => (c.textContent || '').trim());
    // A header row (all columnheader, no rowheader) defines columns.
    if (!header && r.querySelector('[role="columnheader"]') && !columns.length) {
      for (const c of cells) columns.push(c);
      continue;
    }
    rows.push({ header, cells });
  }
  const domRows = rowEls.length;
  const complete = !ariaRowCount || domRows >= ariaRowCount;
  return { found: true, columns, rows, ariaRowCount, ariaColCount, domRows, complete };
}

/** Scroll the tagged grid by dy (px) to reveal virtualized rows. */
export function scrollTaggedMatrix(dy) {
  const grid = document.querySelector('[data-pw="pw-matrix"]');
  if (!grid) return { scrolled: false };
  // Scroll the grid itself and any scrollable ancestor.
  let node = grid;
  for (let i = 0; i < 4 && node; i++) {
    if (node.scrollHeight > node.clientHeight + 2) {
      node.scrollTop = node.scrollTop + dy;
      return { scrolled: true, scrollTop: node.scrollTop };
    }
    node = node.parentElement;
  }
  grid.scrollTop = (grid.scrollTop || 0) + dy;
  return { scrolled: true, scrollTop: grid.scrollTop };
}

/** Row count of the tagged grid (for expand/collapse before/after). */
export function taggedMatrixRowCount() {
  const grid = document.querySelector('[data-pw="pw-matrix"]');
  if (!grid) return null;
  return grid.querySelectorAll('[role="row"]').length;
}

/**
 * Tag the expand/collapse button of the row whose rowheader matches rowHeader,
 * inside the tagged grid. Row headers look like "BNK001 | Crescent Fund", so match
 * exact first, then startsWith, then includes. Returns {found, selector, expandable, matchedHeader}.
 */
export function tagMatrixExpander(rowHeader) {
  const grid = document.querySelector('[data-pw="pw-matrix"]');
  if (!grid) return { found: false, selector: null };
  const rows = Array.from(grid.querySelectorAll('[role="row"]'));
  const headerText = (r) => {
    const h = r.querySelector('[role="rowheader"]');
    return h ? (h.textContent || '').trim() : null;
  };
  let target =
    rows.find((r) => headerText(r) === rowHeader) ||
    rows.find((r) => (headerText(r) || '').startsWith(rowHeader)) ||
    rows.find((r) => (headerText(r) || '').includes(rowHeader));
  if (!target) return { found: false, selector: null };
  const matchedHeader = headerText(target);
  const btn = target.querySelector('.expandCollapseButton.clickable, .expandCollapseButton');
  if (!btn) return { found: false, selector: null, expandable: false, matchedHeader };
  document.querySelectorAll('[data-pw="pw-expander"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  btn.setAttribute('data-pw', 'pw-expander');
  return { found: true, selector: '[data-pw="pw-expander"]', expandable: true, matchedHeader };
}

/* ---------------------------------------------------------- on-path click point */

/**
 * Compute a trusted click point for a tagged element. Center-of-bbox misses thin
 * SVG arcs (e.g. a 29×32px donut slice) — the bbox center is off the stroke. When
 * the element is an SVGGeometryElement, use the on-path midpoint transformed to
 * screen coords. Otherwise fall back to bbox center. offsetX/offsetY are added on
 * top of the resolved point. Returns {found, x, y, onPath}.
 */
export function clickPointForSelector(arg) {
  const { selector, offsetX, offsetY } = arg;
  const el = selector ? document.querySelector(selector) : null;
  if (!el) return { found: false };
  let x = null;
  let y = null;
  let onPath = false;
  if (typeof el.getTotalLength === 'function') {
    try {
      const len = el.getTotalLength();
      const mid = el.getPointAtLength(len / 2);
      const ctm = el.getScreenCTM();
      if (ctm) {
        const sp = new DOMPoint(mid.x, mid.y).matrixTransform(ctm);
        x = sp.x;
        y = sp.y;
        onPath = true;
      }
    } catch (e) { /* fall through to bbox */ }
  }
  if (x == null || y == null) {
    const r = el.getBoundingClientRect();
    x = r.x + r.width / 2;
    y = r.y + r.height / 2;
  }
  if (offsetX != null) x += offsetX;
  if (offsetY != null) y += offsetY;
  return { found: true, x, y, onPath };
}

/* -------------------------------------------------------------- cross-filter */

/** Highlight/fingerprint probe for cross-filter verdict. */
export function crossFilterProbe() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const highlights = q('.highlight, [class*="highlight"]').length;
  const fingerprint = [
    ...new Set(
      q('.visualContainer [aria-label]')
        .map((el) => el.getAttribute('aria-label'))
        .filter((t) => t && / card$/.test(t))
    ),
  ].join('|');
  return { highlights, fingerprint };
}

/* ----------------------------------------------------------------- errors */

/** Broken/errored visible visual scan + console context. */
export function scanBrokenVisuals() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const visible = q('.visualContainer').filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const errRe =
    /can.?t display this visual|couldn.?t (load|retrieve)|something went wrong|see details|error code|out of memory|Resource Governing/i;
  const errorSel =
    '.errorContainer, .visualError, .cardError, .warningIcon, [class*="error" i]:not([class*="errorbar" i])';
  const hits = [];
  for (const c of visible) {
    let label =
      (c.querySelector('[aria-label]') && c.querySelector('[aria-label]').getAttribute('aria-label')) ||
      (c.getAttribute('aria-label') || '').trim() ||
      (c.textContent || '').replace('Press Enter to edit', '').trim().slice(0, 80) ||
      '(unlabeled)';
    if (c.querySelector(errorSel)) {
      hits.push({ label, via: 'icon' });
      continue;
    }
    const txt = (c.textContent || '').replace('Press Enter to edit', '');
    if (errRe.test(txt)) hits.push({ label, via: 'text' });
  }
  return { brokenVisuals: hits, visibleVisualCount: visible.length };
}

/* -------------------------------------------------------------- perf pane */

/** Tag the .performancePane control by kind: 'start'|'refresh'|'stop'|'clear'. */
export function tagPerfControl(kind) {
  const pane = document.querySelector('.performancePane');
  if (!pane) return { found: false, selector: null, paneOpen: false };
  let el = null;
  if (kind === 'clear') {
    el = Array.from(pane.querySelectorAll('button')).find((b) =>
      /clear/i.test((b.textContent || '').trim())
    );
  } else {
    el = pane.querySelector('button.' + kind);
    if (!el) {
      el = Array.from(pane.querySelectorAll('button')).find((b) =>
        new RegExp(kind, 'i').test((b.textContent || '').trim())
      );
    }
  }
  if (!el) return { found: false, selector: null, paneOpen: true };
  document.querySelectorAll('[data-pw="pw-perf-' + kind + '"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-perf-' + kind);
  return { found: true, selector: '[data-pw="pw-perf-' + kind + '"]', paneOpen: true };
}

/** Read Performance Analyzer rows; returns {rows:[{visual,totalMs}], stable-count usable by caller}. */
export function readPerfRows() {
  const pane = document.querySelector('.performancePane');
  if (!pane) return { paneOpen: false, rows: [] };
  const rowEls = Array.from(pane.querySelectorAll('tr.visualLifecycle'));
  const rows = rowEls.map((tr) => {
    const nameCell = tr.querySelector('td.nameCol');
    const name = nameCell ? (nameCell.textContent || '').trim() : null;
    const tds = Array.from(tr.querySelectorAll('td'));
    // total ms = the sibling td after nameCol (first numeric-looking cell)
    let totalMs = null;
    for (const td of tds) {
      if (td === nameCell) continue;
      const t = (td.textContent || '').trim().replace(/[, ]/g, '');
      if (/^\d+(\.\d+)?$/.test(t)) {
        totalMs = parseFloat(t);
        break;
      }
    }
    return { visual: name, totalMs };
  });
  return { paneOpen: true, rows };
}

/** Tag a perf row's .nameCol by visual name (to expand it). */
export function tagPerfRow(visualName) {
  const pane = document.querySelector('.performancePane');
  if (!pane) return { found: false, selector: null };
  const rows = Array.from(pane.querySelectorAll('tr.visualLifecycle'));
  const target = rows.find((tr) => {
    const nc = tr.querySelector('td.nameCol');
    return nc && (nc.textContent || '').trim() === visualName;
  }) || rows.find((tr) => {
    const nc = tr.querySelector('td.nameCol');
    return nc && (nc.textContent || '').trim().includes(visualName);
  });
  if (!target) return { found: false, selector: null };
  const nc = target.querySelector('td.nameCol');
  document.querySelectorAll('[data-pw="pw-perfrow"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  nc.setAttribute('data-pw', 'pw-perfrow');
  return { found: true, selector: '[data-pw="pw-perfrow"]' };
}

/** Tag the 'Copy query' button inside the expanded perf row's activity block. */
export function tagPerfCopyQuery(visualName) {
  const pane = document.querySelector('.performancePane');
  if (!pane) return { found: false, selector: null };
  const rows = Array.from(pane.querySelectorAll('tr.visualLifecycle'));
  const target = rows.find((tr) => {
    const nc = tr.querySelector('td.nameCol');
    return nc && (nc.textContent || '').trim() === visualName;
  }) || rows.find((tr) => {
    const nc = tr.querySelector('td.nameCol');
    return nc && (nc.textContent || '').trim().includes(visualName);
  });
  if (!target) return { found: false, selector: null };
  // The activity breakdown lives in a following <performance-lifecycle-activity>.
  let scope = target.parentElement || pane;
  const btns = Array.from(scope.querySelectorAll('performance-lifecycle-activity button, button')).filter(
    (b) => /copy query/i.test((b.textContent || '').trim())
  );
  const btn = btns[0];
  if (!btn) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-perfcopy"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  btn.setAttribute('data-pw', 'pw-perfcopy');
  return { found: true, selector: '[data-pw="pw-perfcopy"]' };
}

/* ---------------------------------------------------------- generic helpers */

/** body textContent (reflow-free) (for wait_for text polling). */
export function bodyText() {
  return document.body ? document.body.textContent || '' : '';
}

/** Tag an element for hover by selector or ariaLabel; returns {found, selector}. */
export function tagForHover(arg) {
  const { selector, ariaLabel } = arg;
  const q = (s) => Array.from(document.querySelectorAll(s));
  let el = null;
  if (selector) {
    try { el = document.querySelector(selector); } catch (e) { el = null; }
  } else if (ariaLabel) {
    el = q('[aria-label]').find((e) => (e.getAttribute('aria-label') || '').trim() === ariaLabel);
    if (!el) el = q('[aria-label]').find((e) => (e.getAttribute('aria-label') || '').includes(ariaLabel));
  }
  if (!el) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-hover"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-hover');
  return { found: true, selector: '[data-pw="pw-hover"]' };
}

/**
 * Read tooltip text from ONLY the tooltip surfaces that are VISIBLE right now
 * (getBoundingClientRect width>0 && height>0). Desktop keeps ~40 hidden chrome
 * tooltips mounted; reading all of them concatenated garbage. Also drop the
 * pure-chrome labels 'Press Enter to edit', 'Page navigation', 'Bookmark'.
 */
export function readTooltip() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const drop = new Set(['Press Enter to edit', 'Page navigation', 'Bookmark']);
  const txt = q('.tooltip-container, [role="tooltip"]')
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((e) => (e.textContent || '').trim())
    .filter((t) => t && !drop.has(t))
    .join(' | ');
  return txt || null;
}
