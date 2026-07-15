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

  // Title bar text: "My Report· Last saved: Today at 5:09 PM (Power BI Project)".
  // CRITICAL: never scan q('*') + textContent here — that is an O(n²) walk over the
  // ENTIRE report canvas (tens of thousands of nodes) that pins the WebView2 main
  // thread and freezes the report. The title lives in the app title bar, a tiny
  // scoped region. Query only known title-bar containers, and read the LEAF text
  // nodes there via a shallow, bounded scan.
  // The title-bar container's textContent is a run-on of ALL toolbar text, e.g.
  // "SaveUndo…Redo…My Report· Last saved: Today at 5:09 PM  (Power
  // BI Project)Jane Doe…". Don't rely on element boundaries — isolate the
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

  // Dirty state is NOT detectable over CDP. VERIFIED (2026-07-15, Desktop 2.155):
  // a real definition edit (select a visual, nudge it 1px with ArrowRight) changes
  // NOTHING reachable from any WebView target — the "· Last saved: …" title-bar
  // segment does NOT drop, no "*" appears anywhere across all 6 CDP targets
  // (reportView/modelView/daxQueryView/tmdlView/dataExploreView/desktopDialogHost),
  // the Save button is ALWAYS enabled, and window.powerbi exposes no isDirty /
  // hasUnsavedChanges. The dirty flag + real title bar live in the native WPF host
  // shell, which CDP cannot see. So report dirty:null (UNKNOWN) — never a false
  // "clean". Destructive tools (pbi_close/pbi_reload) gate on the caller's explicit
  // intent flag, NOT on this value.
  const dirty = null;

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
    dirty,
  };
}

/**
 * CHEAP metadata for the agentic hot loop: ONLY {activePage, canvasReady,
 * visibleVisualCount}. Same tab / visualContainer logic as pageMetadata but
 * SKIPS the title-bar regex scan and the zoom lookup entirely (those walk extra
 * scoped regions and are the bulk of pageMetadata's cost). Use for pbi_status
 * {light:true} and pbi_health where the title/zoom/build aren't needed.
 */
export function pageMetadataLight() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const tabs = q('[role="tab"]')
    .map((t) => (t.textContent || '').trim())
    .filter((t) => t.endsWith('x'));
  const activeTabEl = q('[role="tab"][aria-selected="true"]').find((t) =>
    (t.textContent || '').trim().endsWith('x')
  );
  const activePage = activeTabEl ? (activeTabEl.textContent || '').trim().replace(/x$/, '') : null;
  const visibleVisualCount = q('.visualContainer').length;
  const canvasReady = tabs.length > 0 && visibleVisualCount > 0;
  return { activePage, canvasReady, visibleVisualCount };
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

/* ---------------------------------------------------------------- visuals */

/**
 * List every visible visual on the active page as
 * [{title, type, x, y, width, height, hasError}].
 *
 * - type: derived by scanning descendant class names for the visual-host token.
 *   The visual host is a div carrying "visual visual-<type>" (e.g.
 *   "visual-barChart", "visual-slicer", "visual-card", "visual-tableEx",
 *   "visual-pivotTable", "visual-donutChart"). We take the FIRST descendant
 *   matching [class*="visual-"] and pull the token via /visual-([A-Za-z0-9]+)/;
 *   null when nothing matches.
 * - title: container's own aria-label (raw), else first descendant [aria-label],
 *   else '.visualTitle' text, else null.
 * - hasError: same errorSel + errRe as scanBrokenVisuals (duplicated inline —
 *   page functions are self-contained).
 * - coordinates: getBoundingClientRect(), Math.round-ed. Only width>0 && height>0.
 */
export function listVisuals() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  // Duplicated from scanBrokenVisuals on purpose (self-contained page fn).
  const errRe =
    /can.?t display this visual|couldn.?t (load|retrieve)|something went wrong|see details|error code|out of memory|Resource Governing/i;
  const errorSel =
    '.errorContainer, .visualError, .cardError, .warningIcon, [class*="error" i]:not([class*="errorbar" i])';
  const typeOf = (c) => {
    // Look at the container itself, then the first descendant carrying a
    // visual-<type> class token. className may be an SVGAnimatedString, so
    // coerce to string first.
    const cls = (el) => ((el.className || '').toString());
    const hostCls = /visual-([A-Za-z0-9]+)/.exec(cls(c));
    if (hostCls) return hostCls[1];
    const host = c.querySelector('[class*="visual-"]');
    if (host) {
      const m = /visual-([A-Za-z0-9]+)/.exec(cls(host));
      if (m) return m[1];
    }
    return null;
  };
  const titleOf = (c) => {
    const own = (c.getAttribute('aria-label') || '').trim();
    if (own) return own;
    const desc = c.querySelector('[aria-label]');
    if (desc && (desc.getAttribute('aria-label') || '').trim()) return (desc.getAttribute('aria-label') || '').trim();
    const t = c.querySelector('.visualTitle');
    if (t && (t.textContent || '').trim()) return (t.textContent || '').trim();
    return null;
  };
  const out = [];
  for (const c of q('.visualContainer')) {
    const r = c.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const txt = (c.textContent || '').replace('Press Enter to edit', '');
    const hasError = !!c.querySelector(errorSel) || errRe.test(txt);
    out.push({
      title: titleOf(c),
      type: typeOf(c),
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      hasError,
    });
  }
  return out;
}

/**
 * Find a visible visual whose title matches `title` (same title logic as
 * listVisuals): EXACT match first, then case-insensitive CONTAINS. Returns
 * {found, x, y, width, height, matchedTitle, candidates} — candidates lists ALL
 * visible visual titles when not found (so the caller can report near-misses).
 * Coordinates are Math.round-ed and suitable for a Playwright screenshot clip.
 */
export function tagVisualByTitle(title) {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const titleOf = (c) => {
    const own = (c.getAttribute('aria-label') || '').trim();
    if (own) return own;
    const desc = c.querySelector('[aria-label]');
    if (desc && (desc.getAttribute('aria-label') || '').trim()) return (desc.getAttribute('aria-label') || '').trim();
    const t = c.querySelector('.visualTitle');
    if (t && (t.textContent || '').trim()) return (t.textContent || '').trim();
    return null;
  };
  const visible = q('.visualContainer').filter((c) => {
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const withTitle = visible.map((c) => ({ el: c, title: titleOf(c) })).filter((o) => o.title);
  const lc = title.toLowerCase();
  let hit = withTitle.find((o) => o.title === title);
  if (!hit) hit = withTitle.find((o) => o.title.toLowerCase().includes(lc));
  if (!hit) {
    return { found: false, candidates: withTitle.map((o) => o.title) };
  }
  const r = hit.el.getBoundingClientRect();
  return {
    found: true,
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
    matchedTitle: hit.title,
  };
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

/* -------------------------------------------------------------- typing/input */

/**
 * Focus a tagged editable IN-PAGE and clear it WITHOUT a global select-all.
 * CRITICAL SAFETY: never rely on a mouse click to focus a text input before
 * sending Ctrl+A / Delete — if the click misses and focus is on the report
 * canvas, Ctrl+A selects every VISUAL and Delete DELETES them (this exact bug
 * emptied a page). Instead call el.focus() directly, confirm document.activeElement
 * IS our input, and clear via the input's own value/selection. Returns
 * {focused, isActive, cleared}. If not focused/active, the caller MUST NOT type.
 */
export function focusAndClearEditable(doClear) {
  const el = document.querySelector('[data-pw="pw-type"], [data-pw="pw-slicersearch"]');
  if (!el) return { focused: false, isActive: false, cleared: false, reason: 'no tagged input' };
  try { el.focus(); } catch (e) { /* ignore */ }
  const isActive = document.activeElement === el;
  if (!isActive) {
    // Do NOT proceed — typing/clearing now would hit the canvas.
    return { focused: false, isActive: false, cleared: false, reason: 'input did not take focus' };
  }
  let cleared = false;
  if (doClear) {
    if ('value' in el) {
      // Native input/textarea: set value + fire input so the slicer re-filters,
      // then place caret at end. No global select-all anywhere.
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      cleared = true;
    } else if (el.isContentEditable) {
      el.textContent = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      cleared = true;
    }
  }
  return { focused: true, isActive: true, cleared };
}

/**
 * Tag an editable target for trusted keyboard typing. Resolution order:
 *  explicit `selector` > element whose aria-label includes `ariaLabel` >
 *  first VISIBLE search/text input in the DOM.
 * Editable = input / textarea / [contenteditable] / [role=searchbox] /
 * [role=textbox]. Returns {found, selector, matchedLabel}.
 */
export function tagEditable(arg) {
  const { selector, ariaLabel } = arg || {};
  const q = (s) => Array.from(document.querySelectorAll(s));
  const editableSel =
    'input:not([type=hidden]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=submit]), ' +
    'textarea, [contenteditable=""], [contenteditable="true"], [role="searchbox"], [role="textbox"]';
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  let el = null;
  if (selector) {
    try { el = document.querySelector(selector); } catch (e) { el = null; }
  } else if (ariaLabel) {
    const cands = q(editableSel).filter(isVisible);
    el =
      cands.find((e) => (e.getAttribute('aria-label') || '').trim() === ariaLabel) ||
      cands.find((e) => (e.getAttribute('aria-label') || '').includes(ariaLabel)) ||
      null;
  } else {
    const cands = q(editableSel).filter(isVisible);
    // Prefer a search-flavoured input first, then any text input.
    el =
      cands.find(
        (e) =>
          e.getAttribute('type') === 'search' ||
          e.getAttribute('role') === 'searchbox' ||
          /search/i.test(e.getAttribute('aria-label') || '') ||
          /search/i.test(e.className || '')
      ) ||
      cands[0] ||
      null;
  }
  if (!el) return { found: false, selector: null, matchedLabel: null };
  document.querySelectorAll('[data-pw="pw-type"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-type');
  return {
    found: true,
    selector: '[data-pw="pw-type"]',
    matchedLabel: (el.getAttribute('aria-label') || '').trim() || null,
  };
}

/* ----------------------------------------------------------- slicer search */

/**
 * Tag a slicer's search box. PBI search inputs are typically `input.searchInput`,
 * `input[type=search]`, or `[aria-label*="Search" i]` inside a `.slicer` /
 * `.slicerContainer` / `.visualContainer`. If `container` given, scope to the
 * visual whose title/aria-label includes it. Returns {found, selector}.
 */
export function tagSlicerSearch(arg) {
  const { container } = arg || {};
  const q = (s) => Array.from(document.querySelectorAll(s));
  const searchSel =
    'input.searchInput, input[type="search"], [aria-label*="Search" i]';
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelOf = (host) =>
    (host.getAttribute('aria-label') || '') +
    ' ' +
    ((host.querySelector('[aria-label]') && host.querySelector('[aria-label]').getAttribute('aria-label')) || '') +
    ' ' +
    ((host.querySelector('.visualTitle, .title') && host.querySelector('.visualTitle, .title').textContent) || '');
  // Candidate slicer hosts.
  let hosts = q('.slicer, .slicerContainer, .visualContainer');
  if (container) {
    const lc = container.toLowerCase();
    hosts = hosts.filter((h) => labelOf(h).toLowerCase().includes(lc));
  }
  let box = null;
  for (const h of hosts) {
    const inp = Array.from(h.querySelectorAll(searchSel)).find(isVisible);
    if (inp) { box = inp; break; }
  }
  // Fallback: any visible search box on the page (no container filter given).
  if (!box && !container) {
    box = q(searchSel).find(isVisible) || null;
  }
  if (!box) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-slicersearch"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  box.setAttribute('data-pw', 'pw-slicersearch');
  return { found: true, selector: '[data-pw="pw-slicersearch"]' };
}

/** Read the currently visible slicer items as [{label}] (aria-label else text). */
export function readSlicerItems() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  return q('.slicerItemContainer')
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((el) => ({
      label: (el.getAttribute('aria-label') || '').trim() || (el.textContent || '').trim(),
    }))
    .filter((o) => o.label);
}

/**
 * Tag a slicer item (from a search-filtered list) by exact label, then contains.
 * Matches against aria-label, then textContent. Returns {found, selector, pickedLabel}.
 */
export function tagSlicerSearchPick(value) {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const items = q('.slicerItemContainer').filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const labelOf = (el) => (el.getAttribute('aria-label') || '').trim() || (el.textContent || '').trim();
  let el =
    items.find((it) => labelOf(it) === value) ||
    items.find((it) => labelOf(it).includes(value));
  if (!el) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-slicerpick"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-slicerpick');
  return { found: true, selector: '[data-pw="pw-slicerpick"]', pickedLabel: labelOf(el) };
}

/* --------------------------------------------------------- context menu */

/**
 * Tag a target for a right-click context menu. Match priority:
 *  selector (querySelectorAll first) > ariaLabel (exact, then contains) >
 *  text (exact, then contains). SVG data points included. Stamps `pw-ctx`.
 * Returns {found, selector, matchedLabel}.
 */
export function tagForContext(arg) {
  const { text, ariaLabel, selector } = arg || {};
  const q = (s) => Array.from(document.querySelectorAll(s));
  let el = null;
  if (selector) {
    try { el = document.querySelector(selector); } catch (e) { el = null; }
  } else if (ariaLabel) {
    const all = q('[aria-label]');
    el =
      all.find((e) => (e.getAttribute('aria-label') || '').trim() === ariaLabel) ||
      all.find((e) => (e.getAttribute('aria-label') || '').includes(ariaLabel)) ||
      null;
  } else if (text) {
    const all = q('[role="button"], button, [role="tab"], .slicerItemContainer, a, span, div, path, rect, circle');
    let matches = all.filter((e) => (e.textContent || '').trim() === text);
    if (!matches.length) {
      matches = all.filter((e) => (e.textContent || '').trim().includes(text));
      matches.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    }
    el = matches[0] || null;
  }
  if (!el) return { found: false, selector: null, matchedLabel: null };
  document.querySelectorAll('[data-pw="pw-ctx"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-ctx');
  return {
    found: true,
    selector: '[data-pw="pw-ctx"]',
    matchedLabel:
      (el.getAttribute && el.getAttribute('aria-label')) || (el.textContent || '').trim().slice(0, 120) || null,
  };
}

/** Read the visible context-menu item texts ([role=menuitem], visible only). */
export function readMenuItems() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const menuOpen = q('[role="menu"]').some((m) => {
    const r = m.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const items = q('[role="menuitem"]')
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })
    .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
    .filter(Boolean);
  return { menuOpen, items };
}

/** Tag a context-menu item by text: exact then contains. Returns {found, selector, matchedItem}. */
export function tagMenuItem(text) {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const items = q('[role="menuitem"]').filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const textOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim();
  let el =
    items.find((it) => textOf(it) === text) ||
    items.find((it) => textOf(it).includes(text));
  if (!el) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-menuitem"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-menuitem');
  return { found: true, selector: '[data-pw="pw-menuitem"]', matchedItem: textOf(el) };
}

/* ------------------------------------------------------- monaco (dax/tmdl) */
// NB: these run in the daxQueryView / tmdlView page targets (NOT reportView) —
// the tool resolves the sibling CDP page and passes it to page.evaluate. Both
// targets carry window.monaco with monaco.editor.getModels()/getEditors()
// (Desktop 2.155, verified). getEditors()[0] is the ACTIVE editor.

/** Read the Monaco editor text: prefer the active editor's model, fallback to models[0]. */
export function readMonacoText() {
  if (!window.monaco || !monaco.editor) return { monaco: false };
  const editors = monaco.editor.getEditors ? monaco.editor.getEditors() : [];
  const models = monaco.editor.getModels ? monaco.editor.getModels() : [];
  let text = null;
  if (editors.length && editors[0].getModel && editors[0].getModel()) {
    text = editors[0].getModel().getValue();
  } else if (models.length) {
    text = models[0].getValue();
  }
  return { monaco: true, found: text != null, text, modelCount: models.length };
}

/** Set the active Monaco editor's model value + focus it (for the DAX run). Returns {took}. */
export function setMonacoText(dax) {
  if (!window.monaco || !monaco.editor) return { monaco: false, took: false };
  const editors = monaco.editor.getEditors ? monaco.editor.getEditors() : [];
  if (!editors.length || !editors[0].getModel || !editors[0].getModel()) {
    return { monaco: true, took: false, reason: 'no active editor' };
  }
  const ed = editors[0];
  ed.getModel().setValue(dax);
  ed.focus();
  return { monaco: true, took: ed.getModel().getValue() === dax };
}

/**
 * Read the DAX query view results grid + any inline error banner. The results
 * render in a `[role="grid"]` (ag-grid `.ag-root`); errors show inline in a
 * message region. Caps at ~200 rows. Returns {hasResult, columns, rows, rowCount, error}.
 */
export function readDaxResults() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Error banner: match a visible message/error region whose text looks like a query error.
  const errRe = /error|failed|cannot|syntax|invalid|couldn.?t/i;
  let error = null;
  const errScopes = q(
    '[class*="error" i], [class*="message" i], [role="alert"], [class*="queryStatus" i]'
  ).filter(isVisible);
  for (const s of errScopes) {
    const t = (s.textContent || '').trim();
    if (t && t.length < 800 && errRe.test(t)) { error = t; break; }
  }

  // Results grid. The DAX query view (Desktop 2.155, verified 2026-07-15) has NO
  // `.ag-root` / `[role="grid"]` wrapper and NO `[role="columnheader"]` — it renders
  // ARIA rows of `[role="gridcell"]` directly, with the HEADER row's cells holding the
  // bracketed column names like `[check]` / `[build]`. So: collect ALL visible
  // `[role="row"]` that contain `[role="gridcell"]`, scoped to a results container if
  // one is identifiable, and treat a leading all-`[...]` row as the column headers.
  const rowEls = q('[role="row"]')
    .filter(isVisible)
    .filter((r) => r.querySelector('[role="gridcell"]'));
  if (!rowEls.length) return { hasResult: false, error };

  let rowValues = rowEls.map((r) =>
    Array.from(r.querySelectorAll('[role="gridcell"]')).map((c) => (c.textContent || '').trim())
  );

  // This build prefixes each row with a row-NUMBER cell: the header row looks like
  // ["", "[col1]", "[col2]"] and data rows like ["1", "v1", "v2"]. Detect + drop that
  // leading ordinal column when the header's first cell is blank and the rest are
  // `[name]` tokens.
  let columns = [];
  const explicitHeaders = q('[role="columnheader"]').filter(isVisible).map((c) => (c.textContent || '').trim());
  const isHeaderCells = (cells) => {
    const nonEmpty = cells.filter((c) => c !== '');
    return nonEmpty.length > 0 && nonEmpty.every((c) => /^\[.*\]$/.test(c));
  };
  if (explicitHeaders.length) {
    columns = explicitHeaders;
  } else if (rowValues.length && isHeaderCells(rowValues[0])) {
    const headerRow = rowValues.shift();
    // Drop a leading blank ordinal cell from the header AND every data row.
    const dropLead = headerRow.length && headerRow[0] === '';
    columns = (dropLead ? headerRow.slice(1) : headerRow).map((c) => c.replace(/^\[|\]$/g, ''));
    if (dropLead) rowValues = rowValues.map((r) => r.slice(1));
  }

  const rows = rowValues.slice(0, 200);
  return {
    hasResult: columns.length > 0 || rows.length > 0,
    columns,
    rows,
    rowCount: rows.length,
    error,
  };
}

/** Tag a visible "Run" button in the DAX query view (aria-label/text === "Run"). Returns {found, selector}. */
export function tagDaxRunButton() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const cands = q('button, [role="button"], [role="menuitem"]').filter(isVisible);
  const labelOf = (el) => ((el.getAttribute('aria-label') || '') || (el.textContent || '')).trim();
  const el = cands.find((b) => labelOf(b) === 'Run') || cands.find((b) => /^run\b/i.test(labelOf(b)));
  if (!el) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-daxrun"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-daxrun');
  return { found: true, selector: '[data-pw="pw-daxrun"]' };
}

/**
 * Run Monaco's built-in "Format Document" on the active DAX editor and return the
 * reformatted text. VERIFIED (2026-07-15): 'editor.action.formatDocument' IS a
 * supported action in the daxQueryView editor (getSupportedActions lists it).
 * ASYNC: the action's run() returns a promise — return it so page.evaluate awaits.
 */
export function runMonacoFormat() {
  if (!window.monaco || !monaco.editor) return { ok: false, reason: 'no monaco' };
  const eds = monaco.editor.getEditors ? monaco.editor.getEditors() : [];
  if (!eds.length) return { ok: false, reason: 'no editor' };
  const a = eds[0].getAction('editor.action.formatDocument');
  if (!a) return { ok: false, reason: 'no format action' };
  return a.run().then(() => ({ ok: true, text: eds[0].getModel().getValue() }));
}

/* --------------------------------------------------------- role resolver */

/**
 * Version-drift-resilient resolver: find an element by ARIA role + accessible
 * name, tag it, and report the candidate set. Preferred over brittle CSS-class
 * selectors by the newer tools. arg = {role, name, nameExact}.
 *  - els = all [role="<role>"].
 *  - accessible name = aria-label (trimmed) else textContent (trimmed).
 *  - with name: exact match first; if none AND !nameExact, case-insensitive
 *    CONTAINS. Without name: the first element of the role.
 * Tags the pick `data-pw="pw-role"` (clearing any prior). Returns
 * {found, selector, matchedName, role, candidateCount, candidates} on a hit, or
 * {found:false, role, candidateCount, candidates} otherwise. candidates lists up
 * to the first 12 non-empty accessible names (for near-miss reporting).
 */
export function resolveByRole(arg) {
  const { role, name, nameExact } = arg || {};
  const q = (s) => Array.from(document.querySelectorAll(s));
  const els = q('[role="' + role + '"]');
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || '').trim() || (el.textContent || '').trim();
  const candidates = els.slice(0, 12).map(nameOf).filter(Boolean);
  let pick = null;
  let matchedName = null;
  if (name) {
    pick = els.find((el) => nameOf(el) === name) || null;
    if (!pick && !nameExact) {
      const lc = name.toLowerCase();
      pick = els.find((el) => nameOf(el).toLowerCase().includes(lc)) || null;
    }
  } else {
    pick = els[0] || null;
  }
  if (!pick) {
    return { found: false, role, candidateCount: els.length, candidates };
  }
  matchedName = nameOf(pick);
  document.querySelectorAll('[data-pw="pw-role"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  pick.setAttribute('data-pw', 'pw-role');
  return {
    found: true,
    selector: '[data-pw="pw-role"]',
    matchedName,
    role,
    candidateCount: els.length,
    candidates,
  };
}

/* ---------------------------------------------------------------- dialog */
// Runs in the desktopDialogHost page target (only exists while a dialog shows).

/**
 * Read a Desktop dialog's visible text + button labels. The desktopDialogHost
 * target is PERSISTENT (exists even when no dialog is up — then its body has
 * zero height / no content), so `visible` reports whether a dialog is actually
 * showing. Returns {visible, text, buttons}.
 */
export function readDialog() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const bodyRect = document.body ? document.body.getBoundingClientRect() : { width: 0, height: 0 };
  const text = (document.body ? document.body.textContent || '' : '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  const buttons = q('button, [role="button"]')
    .filter(isVisible)
    .map((b) => ((b.getAttribute('aria-label') || '') || (b.textContent || '')).trim())
    .filter(Boolean);
  const visible = bodyRect.height > 0 && (text.length > 0 || buttons.length > 0);
  return { visible, text, buttons };
}

/** Tag a dialog button by label: exact then contains (case-insensitive). Returns {found, selector, matchedLabel, buttons}. */
export function tagDialogButton(label) {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const btns = q('button, [role="button"]').filter(isVisible);
  const labelOf = (b) => ((b.getAttribute('aria-label') || '') || (b.textContent || '')).trim();
  const all = btns.map(labelOf).filter(Boolean);
  let el =
    btns.find((b) => labelOf(b) === label) ||
    btns.find((b) => labelOf(b).toLowerCase() === label.toLowerCase()) ||
    btns.find((b) => labelOf(b).toLowerCase().includes(label.toLowerCase()));
  if (!el) return { found: false, selector: null, buttons: all };
  document.querySelectorAll('[data-pw="pw-dialogbtn"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-dialogbtn');
  return { found: true, selector: '[data-pw="pw-dialogbtn"]', matchedLabel: labelOf(el), buttons: all };
}

/* ----------------------------------------------------------------- tableEx */

/**
 * Tag a table (tableEx) visual's grid and report its visible titles. UNLIKE
 * tagMatrix (which targets any [role="grid"] and is used for matrices/pivots),
 * this is scoped to the tableEx visual type (`[class*="visual-tableEx"]`, NOT
 * pivotTable) — a flat table has columns but no row headers. Pick order:
 * titleMatch (aria-label/title contains, case-insensitive) > index > first
 * tableEx. Tags the picked container's [role="grid"] with `pw-table`. Returns
 * {found, selector, index, titles, pickedTitle}.
 */
export function tagTableGrid(arg) {
  const { titleMatch, index } = arg || {};
  const q = (s) => Array.from(document.querySelectorAll(s));
  const containers = q('.visualContainer').filter((c) => {
    const r = c.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    // tableEx host token on a descendant (or the container itself). Exclude
    // pivotTable — that is a matrix, handled by tagMatrix/pbi_read_matrix.
    const cls = (el) => ((el.className || '').toString());
    if (/visual-tableEx/.test(cls(c))) return !!c.querySelector('[role="grid"]');
    const host = c.querySelector('[class*="visual-tableEx"]');
    return !!host && !!c.querySelector('[role="grid"]');
  });
  const gridOf = (c) => c.querySelector('[role="grid"]');
  const titleOf = (c) => {
    const g = gridOf(c);
    return (
      (g && (g.getAttribute('aria-label') || '').trim()) ||
      (c.getAttribute('aria-label') || '').trim() ||
      ((c.querySelector('.visualTitle') && (c.querySelector('.visualTitle').textContent || '').trim())) ||
      ''
    );
  };
  const titles = containers.map(titleOf);
  let picked = -1;
  if (titleMatch) {
    picked = containers.findIndex((c) => titleOf(c).toLowerCase().includes(titleMatch.toLowerCase()));
  } else if (index != null) {
    picked = Math.min(index, containers.length - 1);
  } else {
    picked = containers.length ? 0 : -1;
  }
  if (picked < 0 || !containers[picked]) return { found: false, selector: null, titles };
  const grid = gridOf(containers[picked]);
  document.querySelectorAll('[data-pw="pw-table"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  grid.setAttribute('data-pw', 'pw-table');
  return {
    found: true,
    selector: '[data-pw="pw-table"]',
    index: picked,
    titles,
    pickedTitle: titleOf(containers[picked]),
  };
}

/**
 * Read the tagged table grid ('[data-pw="pw-table"]') fully as JSON. Tables have
 * NO row headers (unlike readTaggedMatrix): columns come from the first row's
 * [role="columnheader"] cells, and each data [role="row"] yields a FLAT cells
 * array of its [role="gridcell"] texts (no header field). Returns
 * {found, columns, rows:[{cells}], ariaRowCount, ariaColCount, domRows, complete}.
 */
export function readTaggedTable() {
  const grid = document.querySelector('[data-pw="pw-table"]');
  if (!grid) return { found: false };
  const q = (root, s) => Array.from(root.querySelectorAll(s));
  const ariaRowCount = parseInt(grid.getAttribute('aria-rowcount') || '0', 10) || null;
  const ariaColCount = parseInt(grid.getAttribute('aria-colcount') || '0', 10) || null;
  const rowEls = q(grid, '[role="row"]');
  const columns = [];
  const rows = [];
  for (const r of rowEls) {
    const headerCells = q(r, '[role="columnheader"]');
    // A header row (holds columnheaders) defines the columns once.
    if (headerCells.length && !columns.length) {
      for (const c of headerCells) columns.push((c.textContent || '').trim());
      continue;
    }
    const cellEls = q(r, '[role="gridcell"]');
    if (!cellEls.length) continue;
    rows.push({ cells: cellEls.map((c) => (c.textContent || '').trim()) });
  }
  const domRows = rows.length;
  const complete = !ariaRowCount || rowEls.length >= ariaRowCount;
  return { found: true, columns, rows, ariaRowCount, ariaColCount, domRows, complete };
}

/** Scroll the tagged table by dy (px) to reveal virtualized rows (mirrors scrollTaggedMatrix). */
export function scrollTaggedTable(dy) {
  const grid = document.querySelector('[data-pw="pw-table"]');
  if (!grid) return { scrolled: false };
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

/* ------------------------------------------------------- show-as-table */

/**
 * Tag the FIRST data-point mark inside the visual whose title matches
 * `visualTitle` (same title logic as tagVisualByTitle, inlined per the
 * self-contained page-fn rule). A data point is a `[role="option"]` mark (donut
 * arc, column rect, matrix cell, …). Tags it `data-pw="pw-dp"`. On a hit returns
 * {found:true, selector, pointCount, matchedTitle}; if the visual matched but has
 * NO role=option marks (canvas/image/custom visual) returns
 * {found:false, reason, candidates:[titles]}; if no visual matched returns
 * {found:false, reason:'visual not found', candidates:[titles]}.
 */
export function tagDataPoint(visualTitle) {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const titleOf = (c) => {
    const own = (c.getAttribute('aria-label') || '').trim();
    if (own) return own;
    const desc = c.querySelector('[aria-label]');
    if (desc && (desc.getAttribute('aria-label') || '').trim()) return (desc.getAttribute('aria-label') || '').trim();
    const t = c.querySelector('.visualTitle');
    if (t && (t.textContent || '').trim()) return (t.textContent || '').trim();
    return null;
  };
  const visible = q('.visualContainer').filter((c) => {
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const withTitle = visible.map((c) => ({ el: c, title: titleOf(c) })).filter((o) => o.title);
  const lc = (visualTitle || '').toLowerCase();
  let hit = withTitle.find((o) => o.title === visualTitle);
  if (!hit) hit = withTitle.find((o) => o.title.toLowerCase().includes(lc));
  if (!hit) {
    return { found: false, reason: 'visual not found', candidates: withTitle.map((o) => o.title) };
  }
  const marks = Array.from(hit.el.querySelectorAll('[role="option"]')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!marks.length) {
    return {
      found: false,
      reason: 'no data point (canvas/image/custom visual?)',
      matchedTitle: hit.title,
      candidates: withTitle.map((o) => o.title),
    };
  }
  const dp = marks[0];
  document.querySelectorAll('[data-pw="pw-dp"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  dp.setAttribute('data-pw', 'pw-dp');
  return { found: true, selector: '[data-pw="pw-dp"]', pointCount: marks.length, matchedTitle: hit.title };
}

/**
 * Read the Show-data ("Show as a table") overlay grid. That view renders a visible
 * [role="grid"] (often a full-width overlay) — pick the LARGEST visible one and read
 * its columns ([role="columnheader"], else the first row's cells) + rows
 * ([role="row"] > [role="gridcell"]). Returns {found, columns, rows, rowCount}.
 */
export function readShowAsTableGrid() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const grids = q('[role="grid"]').filter((g) => {
    const r = g.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!grids.length) return { found: false, columns: [], rows: [], rowCount: 0 };
  // Largest visible grid by area.
  let grid = grids[0];
  let bestArea = -1;
  for (const g of grids) {
    const r = g.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) { bestArea = area; grid = g; }
  }
  const rowEls = Array.from(grid.querySelectorAll('[role="row"]'));
  let columns = Array.from(grid.querySelectorAll('[role="columnheader"]')).map((c) => (c.textContent || '').trim());
  const rows = [];
  for (const r of rowEls) {
    if (r.querySelector('[role="columnheader"]')) {
      // A header row: adopt as columns if we have none yet, then skip it.
      if (!columns.length) {
        columns = Array.from(r.querySelectorAll('[role="columnheader"]')).map((c) => (c.textContent || '').trim());
      }
      continue;
    }
    const cells = Array.from(r.querySelectorAll('[role="gridcell"]')).map((c) => (c.textContent || '').trim());
    if (cells.length) rows.push(cells);
  }
  return { found: rows.length > 0 || columns.length > 0, columns, rows: rows.slice(0, 500), rowCount: rows.length };
}

/**
 * Find + tag the "Back to report" control that dismisses the Show-data overlay.
 * Matches a visible button/[role=button]/[role=menuitem] whose aria-label or text
 * matches /back to report/i. Tags it `data-pw="pw-back"`. Returns {found, selector}.
 */
export function tagBackToReport() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const re = /back to report/i;
  const labelOf = (el) => ((el.getAttribute('aria-label') || '') || (el.textContent || '')).trim();
  const el = q('button, [role="button"], [role="menuitem"]')
    .filter(isVisible)
    .find((b) => re.test(labelOf(b)));
  if (!el) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-back"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-back');
  return { found: true, selector: '[data-pw="pw-back"]' };
}

/* --------------------------------------------------------------- slicer state */

/**
 * Read a slicer's full state (selections + available values). Locate slicer
 * host(s) (.slicer / .slicerContainer / .visualContainer), optionally filtered by
 * `container` (its title/aria-label contains the string). Detect kind:
 *  - BUTTON slicer: buttonSlicerVisual buttons → kind='button'; each item is
 *    {text, pressed:aria-pressed==='true'}; selected = the pressed ones.
 *  - LIST slicer: .slicerItemContainer items → kind='list'; each item
 *    {label:(aria-label||text), selected:(aria-selected==='true' || an inner
 *    checked checkbox)}; available = all labels, selected = the selected ones.
 * hasSearch = a search input is present in the host. Returns
 * {found, kind, selected:[...], available:[...], hasSearch, itemCount}.
 */
export function readSlicerState(arg) {
  const { container } = arg || {};
  const q = (s) => Array.from(document.querySelectorAll(s));
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelOf = (host) =>
    (host.getAttribute('aria-label') || '') +
    ' ' +
    ((host.querySelector('[aria-label]') && host.querySelector('[aria-label]').getAttribute('aria-label')) || '') +
    ' ' +
    ((host.querySelector('.visualTitle, .title') && host.querySelector('.visualTitle, .title').textContent) || '');
  let hosts = q('.slicer, .slicerContainer, .visualContainer').filter(isVisible);
  if (container) {
    const lc = container.toLowerCase();
    hosts = hosts.filter((h) => labelOf(h).toLowerCase().includes(lc));
  }
  // Pick the first host that actually looks like a slicer (has button/list items).
  const isButtonBtn = (el) => (el.className || '').toString().includes('buttonSlicerVisual');
  let host = null;
  let kind = null;
  for (const h of hosts) {
    const btns = Array.from(h.querySelectorAll('[role="button"]')).filter(isButtonBtn);
    if (btns.length) { host = h; kind = 'button'; break; }
    if (h.querySelector('.slicerItemContainer')) { host = h; kind = 'list'; break; }
  }
  if (!host) return { found: false, kind: null, selected: [], available: [], hasSearch: false, itemCount: 0 };

  const hasSearch = !!Array.from(
    host.querySelectorAll('input.searchInput, input[type="search"], [aria-label*="Search" i], [role="searchbox"]')
  ).find(isVisible);

  if (kind === 'button') {
    const btns = Array.from(host.querySelectorAll('[role="button"]')).filter((b) => isButtonBtn(b) && isVisible(b));
    const items = btns.map((b) => ({
      text: (b.textContent || '').trim(),
      pressed: b.getAttribute('aria-pressed') === 'true',
    }));
    return {
      found: true,
      kind: 'button',
      selected: items.filter((i) => i.pressed).map((i) => i.text),
      available: items.map((i) => i.text),
      hasSearch,
      itemCount: items.length,
    };
  }

  // list
  const items = Array.from(host.querySelectorAll('.slicerItemContainer')).filter(isVisible);
  const parsed = items.map((el) => {
    const label = (el.getAttribute('aria-label') || '').trim() || (el.textContent || '').trim();
    const ariaSel = el.getAttribute('aria-selected') === 'true';
    const box = el.querySelector('input[type="checkbox"], [role="checkbox"]');
    const boxChecked =
      !!box && (box.checked === true || box.getAttribute('aria-checked') === 'true');
    return { label, selected: ariaSel || boxChecked };
  }).filter((o) => o.label);
  return {
    found: true,
    kind: 'list',
    selected: parsed.filter((i) => i.selected).map((i) => i.label),
    available: parsed.map((i) => i.label),
    hasSearch,
    itemCount: parsed.length,
  };
}

/* --------------------------------------------------------------- filters pane */

/** Is the Filters pane open with at least one filter-card element? */
export function filterPaneOpen() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const panes = q('.filterPane').filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  for (const p of panes) {
    if (p.querySelector('[class*="filterCard" i], [class*="card" i][aria-label], .filterContainer > *')) {
      return true;
    }
  }
  return false;
}

/**
 * Best-effort read of the filter cards inside the Filters pane. Enumerates card
 * containers (several candidate selectors) and returns for each:
 *  {field, scope:'visual'|'page'|'report'|null, condition, values:[], isLocked, isHidden}.
 * field = a card aria-label or a title element's text; scope inferred from a
 * nearby section header when determinable, else null; condition = card text when
 * short, else null. Unknown → nulls. Returns an array (possibly empty).
 */
export function readFilterCards() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const pane = q('.filterPane').filter(isVisible)[0];
  if (!pane) return [];
  // Candidate card containers, de-duplicated (a node might match >1 selector).
  const raw = [
    ...pane.querySelectorAll('[class*="filterCard" i]'),
    ...pane.querySelectorAll('[class*="card" i][aria-label]'),
    ...Array.from(pane.querySelectorAll('.filterContainer')).flatMap((fc) => Array.from(fc.children)),
  ];
  const seen = new Set();
  const cards = raw.filter((el) => {
    if (!isVisible(el)) return false;
    if (seen.has(el)) return false;
    seen.add(el);
    return true;
  });
  // Infer scope from a preceding section header ("Filters on this visual" /
  // "…this page" / "…all pages"). Best-effort: scan the pane text once for the
  // presence of each header — not per-card positioning.
  const scopeFor = (el) => {
    let node = el;
    for (let i = 0; i < 8 && node; i++) {
      // Look for a heading sibling above this card.
      let sib = node.previousElementSibling;
      while (sib) {
        const t = (sib.textContent || '').trim();
        if (/this visual/i.test(t)) return 'visual';
        if (/this page/i.test(t)) return 'page';
        if (/all pages/i.test(t)) return 'report';
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return null;
  };
  return cards.map((el) => {
    const field =
      (el.getAttribute('aria-label') || '').trim() ||
      ((el.querySelector('[class*="title" i], .cardName, .fieldName') &&
        (el.querySelector('[class*="title" i], .cardName, .fieldName').textContent || '').trim())) ||
      null;
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      field,
      scope: scopeFor(el),
      condition: txt && txt.length < 200 ? txt : null,
      values: [],
      isLocked: false,
      isHidden: false,
    };
  });
}

/* ------------------------------------------------------- matrix row header */

/**
 * Tag a [role="rowheader"] inside the tagged matrix ('[data-pw="pw-matrix"]')
 * whose text matches `text` (exact first, then startsWith, then contains). The
 * caller MUST have run tagMatrix first to set pw-matrix. Used by pbi_expand_all
 * to right-click a specific row's header for the Expand/Collapse context menu.
 * Tags it `data-pw="pw-rowhdr"`. Returns {found, selector, matched}.
 */
export function tagRowHeaderByText(text) {
  const grid = document.querySelector('[data-pw="pw-matrix"]');
  if (!grid) return { found: false, selector: null };
  const headers = Array.from(grid.querySelectorAll('[role="rowheader"]')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const textOf = (el) => (el.textContent || '').trim();
  let el =
    headers.find((h) => textOf(h) === text) ||
    headers.find((h) => textOf(h).startsWith(text)) ||
    headers.find((h) => textOf(h).includes(text));
  if (!el) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-rowhdr"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-rowhdr');
  return { found: true, selector: '[data-pw="pw-rowhdr"]', matched: textOf(el) };
}

/**
 * Tag the FIRST visible [role="rowheader"] inside the tagged matrix
 * ('[data-pw="pw-matrix"]') — used by pbi_expand_all when no rowHeader is given
 * (right-click any row header opens the same Expand/Collapse menu). Tags it
 * `data-pw="pw-rowhdr"`. Returns {found, selector, matched}.
 */
export function tagFirstRowHeader() {
  const grid = document.querySelector('[data-pw="pw-matrix"]');
  if (!grid) return { found: false, selector: null };
  const visible = Array.from(grid.querySelectorAll('[role="rowheader"]')).filter((h) => {
    const r = h.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  // Prefer a row header that is an EXPANDABLE hierarchy parent — one carrying an
  // expand/collapse affordance (its row has .expandCollapseButton). Right-clicking
  // a leaf/Total row only offers Group/Summarize (no Expand/Collapse menu), so the
  // literal first row (often "Total") is the wrong target. Fall back to the first
  // visible header if none looks expandable (single-level grid).
  const isExpandable = (h) => {
    const row = h.closest('[role="row"]') || h.parentElement;
    return !!(row && row.querySelector('.expandCollapseButton'));
  };
  const el = visible.find(isExpandable) || visible[0];
  if (!el) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-rowhdr"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-rowhdr');
  return {
    found: true,
    selector: '[data-pw="pw-rowhdr"]',
    matched: (el.textContent || '').trim(),
    expandable: isExpandable(el),
  };
}

/**
 * Tag the NEXT collapsed (expand) or expanded (collapse) expand/collapse button
 * inside the tagged matrix, for iterative expand-all/collapse-all. Power BI matrix
 * hierarchy rows carry a `.expandCollapseButton` whose `aria-expanded` is "false"
 * when collapsed / "true" when expanded. A LEFT-click toggles it (verified 2026-07-15 —
 * this is the same affordance pbi_matrix_expand uses; the row-header RIGHT-click
 * menu does NOT offer Expand/Collapse on this build). To expand-all: repeatedly tag
 * + click the first aria-expanded="false" button until none remain. Returns
 * {found, selector, remaining} where remaining = count of still-togglable buttons
 * in the wanted direction.
 */
export function tagNextExpander(collapse) {
  const grid = document.querySelector('[data-pw="pw-matrix"]');
  if (!grid) return { found: false, selector: null, remaining: 0 };
  const wantExpanded = collapse ? 'true' : 'false'; // to collapse, target expanded ones
  const btns = Array.from(grid.querySelectorAll('.expandCollapseButton')).filter((b) => {
    const r = b.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    // aria-expanded may live on the button or its row.
    const own = b.getAttribute('aria-expanded');
    const row = b.closest('[role="row"]');
    const state = own != null ? own : row ? row.getAttribute('aria-expanded') : null;
    return state === wantExpanded;
  });
  if (!btns.length) return { found: false, selector: null, remaining: 0 };
  const el = btns[0];
  document.querySelectorAll('[data-pw="pw-expall"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-expall');
  return { found: true, selector: '[data-pw="pw-expall"]', remaining: btns.length };
}

/* ------------------------------------------------------- column header sort */

/**
 * Tag a [role="columnheader"] inside a tagged grid ('[data-pw="pw-matrix"]', set
 * by tagMatrix which the caller runs first) whose text matches `column` (exact
 * first, then case-insensitive contains). Column headers carry an `aria-sort`
 * attribute ("ascending"/"descending"/"none") that flips on a sort click. Tags it
 * `data-pw="pw-colhdr"`. Returns {found, selector, matched, ariaSort}.
 */
export function tagColumnHeader(arg) {
  const { column } = arg || {};
  const grid = document.querySelector('[data-pw="pw-matrix"]');
  if (!grid) return { found: false, selector: null };
  const headers = Array.from(grid.querySelectorAll('[role="columnheader"]')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const textOf = (el) => (el.textContent || '').trim();
  const lc = (column || '').toLowerCase();
  let el =
    headers.find((h) => textOf(h) === column) ||
    headers.find((h) => textOf(h).toLowerCase().includes(lc));
  if (!el) return { found: false, selector: null };
  document.querySelectorAll('[data-pw="pw-colhdr"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  el.setAttribute('data-pw', 'pw-colhdr');
  return { found: true, selector: '[data-pw="pw-colhdr"]', matched: textOf(el), ariaSort: el.getAttribute('aria-sort') };
}

/* --------------------------------------------------------------- drill */

/**
 * Tag a visual-header drill control on the visual whose title matches
 * `visualTitle` (same title logic as tagVisualByTitle, inlined per the
 * self-contained page-fn rule; without a title uses the first visible visual with
 * a matching control). action 'down' matches a control whose aria-label ~
 * /drill down|expand to next level|go to the next level/i; 'up' ~ /drill up/i.
 * These header buttons ARE in the DOM even when data points are not. Tags it
 * `data-pw="pw-drill"`. Returns {found, selector, matchedLabel, candidates}.
 */
export function tagDrillControl(arg) {
  const { action, visualTitle } = arg || {};
  const q = (s) => Array.from(document.querySelectorAll(s));
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const titleOf = (c) => {
    const own = (c.getAttribute('aria-label') || '').trim();
    if (own) return own;
    const desc = c.querySelector('[aria-label]');
    if (desc && (desc.getAttribute('aria-label') || '').trim()) return (desc.getAttribute('aria-label') || '').trim();
    const t = c.querySelector('.visualTitle');
    if (t && (t.textContent || '').trim()) return (t.textContent || '').trim();
    return null;
  };
  const re =
    action === 'up'
      ? /drill up/i
      : /drill down|expand to next level|go to the next level/i;
  const visible = q('.visualContainer').filter(isVisible);
  const withTitle = visible.map((c) => ({ el: c, title: titleOf(c) }));
  // Scope to the matching visual when a title is given; else scan all visuals.
  let scopes = visible;
  if (visualTitle) {
    const lc = visualTitle.toLowerCase();
    const hit =
      withTitle.find((o) => o.title === visualTitle) ||
      withTitle.find((o) => o.title && o.title.toLowerCase().includes(lc));
    if (!hit) {
      return { found: false, selector: null, candidates: withTitle.map((o) => o.title).filter(Boolean) };
    }
    scopes = [hit.el];
  }
  const labelOf = (el) => (el.getAttribute('aria-label') || '').trim();
  let btn = null;
  for (const scope of scopes) {
    btn = Array.from(scope.querySelectorAll('[aria-label]'))
      .filter(isVisible)
      .find((el) => re.test(labelOf(el)));
    if (btn) break;
  }
  if (!btn) {
    return { found: false, selector: null, candidates: withTitle.map((o) => o.title).filter(Boolean) };
  }
  document.querySelectorAll('[data-pw="pw-drill"]').forEach(function (e) { e.removeAttribute('data-pw'); });
  btn.setAttribute('data-pw', 'pw-drill');
  return { found: true, selector: '[data-pw="pw-drill"]', matchedLabel: labelOf(btn) };
}

/* -------------------------------------------------------------- page digest */

/**
 * ONE-evaluate page digest for the agentic act→observe→judge loop: returns
 * EVERYTHING needed to judge a page in a SINGLE round-trip so an autonomous loop
 * never has to fan out across listVisuals + readCards + stateProbe +
 * scanBrokenVisuals. All of those helpers' logic is COMPOSED INLINE here — page
 * functions cannot call each other (each is serialized in isolation), so the
 * shared selectors/regexes are intentionally DUPLICATED. Returns:
 *   {activePage, canvasReady, visibleVisualCount,
 *    visuals:[{title,type,x,y,width,height,hasError}],  // like listVisuals
 *    cards:[{title,value}],                              // like readCards
 *    badges:[...],                                       // Filters Applied / Filtering by
 *    slicerSelections:[{text,pressed}],                  // buttonSlicer aria-pressed
 *    brokenVisuals:[{label,via}]}                        // like scanBrokenVisuals
 * Coordinates are Math.round-ed; the visual / broken scans use only visible
 * visuals (width>0 && height>0).
 */
export function pageDigestBatch() {
  const q = (s) => Array.from(document.querySelectorAll(s));

  // --- active page + canvas (pageMetadataLight logic, inlined) --------------
  const tabs = q('[role="tab"]')
    .map((t) => (t.textContent || '').trim())
    .filter((t) => t.endsWith('x'));
  const activeTabEl = q('[role="tab"][aria-selected="true"]').find((t) =>
    (t.textContent || '').trim().endsWith('x')
  );
  const activePage = activeTabEl ? (activeTabEl.textContent || '').trim().replace(/x$/, '') : null;

  // Shared error detection (duplicated from scanBrokenVisuals / listVisuals).
  const errRe =
    /can.?t display this visual|couldn.?t (load|retrieve)|something went wrong|see details|error code|out of memory|Resource Governing/i;
  const errorSel =
    '.errorContainer, .visualError, .cardError, .warningIcon, [class*="error" i]:not([class*="errorbar" i])';

  // --- visuals (listVisuals logic, inlined) --------------------------------
  const cls = (el) => ((el.className || '').toString());
  const typeOf = (c) => {
    const hostCls = /visual-([A-Za-z0-9]+)/.exec(cls(c));
    if (hostCls) return hostCls[1];
    const host = c.querySelector('[class*="visual-"]');
    if (host) {
      const m = /visual-([A-Za-z0-9]+)/.exec(cls(host));
      if (m) return m[1];
    }
    return null;
  };
  const titleOf = (c) => {
    const own = (c.getAttribute('aria-label') || '').trim();
    if (own) return own;
    const desc = c.querySelector('[aria-label]');
    if (desc && (desc.getAttribute('aria-label') || '').trim()) return (desc.getAttribute('aria-label') || '').trim();
    const t = c.querySelector('.visualTitle');
    if (t && (t.textContent || '').trim()) return (t.textContent || '').trim();
    return null;
  };
  const visible = q('.visualContainer').filter((c) => {
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const visuals = [];
  const brokenVisuals = [];
  for (const c of visible) {
    const r = c.getBoundingClientRect();
    const txt = (c.textContent || '').replace('Press Enter to edit', '');
    const iconErr = !!c.querySelector(errorSel);
    const textErr = errRe.test(txt);
    const hasError = iconErr || textErr;
    visuals.push({
      title: titleOf(c),
      type: typeOf(c),
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      hasError,
    });
    if (hasError) {
      const label =
        (c.querySelector('[aria-label]') && c.querySelector('[aria-label]').getAttribute('aria-label')) ||
        (c.getAttribute('aria-label') || '').trim() ||
        (c.textContent || '').replace('Press Enter to edit', '').trim().slice(0, 80) ||
        '(unlabeled)';
      brokenVisuals.push({ label, via: iconErr ? 'icon' : 'text' });
    }
  }
  const visibleVisualCount = visible.length;
  const canvasReady = tabs.length > 0 && q('.visualContainer').length > 0;

  // --- cards (readCards logic, inlined) ------------------------------------
  const cards = [
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

  // --- badges (stateProbe logic, inlined) ----------------------------------
  const badges = [
    ...new Set(
      q('.visualContainer')
        .map((el) => (el.textContent || '').replace('Press Enter to edit', '').trim())
        .filter((t) => /Filters Applied|Filtering by/.test(t))
    ),
  ];

  // --- slicer selections (button slicer aria-pressed, inlined) -------------
  const slicerSelections = q('[role="button"]')
    .filter((el) => cls(el).includes('buttonSlicerVisual'))
    .map((el) => ({ text: (el.textContent || '').trim(), pressed: el.getAttribute('aria-pressed') }));

  return {
    activePage,
    canvasReady,
    visibleVisualCount,
    visuals,
    cards,
    badges,
    slicerSelections,
    brokenVisuals,
  };
}

/* ---------------------------------------------------------- annotate overlays */

/**
 * Inject numbered overlay boxes over every visible visual (listVisuals-style
 * rect + title logic, inlined per the self-contained page-fn rule). Builds a
 * single fixed-position container div `#pw-annot`; for each visual adds a 2px
 * outlined box at its screen rect plus a small numbered label in the corner.
 * The overlay is `pointer-events:none` so it never intercepts a later click.
 * Returns the legend [{n, title, type, hasError}] (n is 1-based, matching the
 * label drawn on the box). removeOverlays() tears it down again.
 */
export function injectOverlays() {
  const q = (s) => Array.from(document.querySelectorAll(s));
  const errRe =
    /can.?t display this visual|couldn.?t (load|retrieve)|something went wrong|see details|error code|out of memory|Resource Governing/i;
  const errorSel =
    '.errorContainer, .visualError, .cardError, .warningIcon, [class*="error" i]:not([class*="errorbar" i])';
  const cls = (el) => ((el.className || '').toString());
  const typeOf = (c) => {
    const hostCls = /visual-([A-Za-z0-9]+)/.exec(cls(c));
    if (hostCls) return hostCls[1];
    const host = c.querySelector('[class*="visual-"]');
    if (host) {
      const m = /visual-([A-Za-z0-9]+)/.exec(cls(host));
      if (m) return m[1];
    }
    return null;
  };
  const titleOf = (c) => {
    const own = (c.getAttribute('aria-label') || '').trim();
    if (own) return own;
    const desc = c.querySelector('[aria-label]');
    if (desc && (desc.getAttribute('aria-label') || '').trim()) return (desc.getAttribute('aria-label') || '').trim();
    const t = c.querySelector('.visualTitle');
    if (t && (t.textContent || '').trim()) return (t.textContent || '').trim();
    return null;
  };

  // Remove any prior overlay first (idempotent).
  const prior = document.getElementById('pw-annot');
  if (prior) prior.remove();

  const container = document.createElement('div');
  container.id = 'pw-annot';
  container.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';

  const visible = q('.visualContainer').filter((c) => {
    const r = c.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const legend = [];
  let n = 0;
  for (const c of visible) {
    n++;
    const r = c.getBoundingClientRect();
    const txt = (c.textContent || '').replace('Press Enter to edit', '');
    const hasError = !!c.querySelector(errorSel) || errRe.test(txt);

    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;box-sizing:border-box;pointer-events:none;' +
      'left:' + Math.round(r.x) + 'px;top:' + Math.round(r.y) + 'px;' +
      'width:' + Math.round(r.width) + 'px;height:' + Math.round(r.height) + 'px;' +
      'outline:2px solid ' + (hasError ? '#e00' : '#0a7') + ';outline-offset:-2px;';

    const label = document.createElement('div');
    label.textContent = String(n);
    label.style.cssText =
      'position:fixed;pointer-events:none;font:bold 12px/1 sans-serif;color:#fff;' +
      'background:' + (hasError ? '#e00' : '#0a7') + ';padding:2px 5px;border-radius:0 0 4px 0;' +
      'left:' + Math.round(r.x) + 'px;top:' + Math.round(r.y) + 'px;';

    container.appendChild(box);
    container.appendChild(label);
    legend.push({ n, title: titleOf(c), type: typeOf(c), hasError });
  }
  document.body.appendChild(container);
  return { legend };
}

/** Remove the numbered overlay container injected by injectOverlays. */
export function removeOverlays() {
  const el = document.getElementById('pw-annot');
  if (el) el.remove();
  return { removed: !!el };
}
