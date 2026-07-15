/**
 * Model-info DAX helpers — build the INFO.VIEW.* EVALUATE strings used by
 * pbi_model_info. Kept OUT of tools.js so the DAX-string construction lives in
 * one testable place. These strings run in the daxQueryView Monaco editor via
 * the same runOneDax path pbi_dax_query uses.
 *
 * VERIFIED LIVE (2026-07-15, Desktop 2.155): INFO.VIEW.MEASURES/TABLES/COLUMNS/
 * RELATIONSHIPS() all evaluate inside EVALUATE in the daxQueryView target and
 * expose a [Table] and [Name] column (among others) suitable for filtering.
 */

/** The four INFO.VIEW functions keyed by the pbi_model_info `object` enum. */
export const INFO_VIEW_DAX = {
  measures: 'INFO.VIEW.MEASURES()',
  tables: 'INFO.VIEW.TABLES()',
  columns: 'INFO.VIEW.COLUMNS()',
  relationships: 'INFO.VIEW.RELATIONSHIPS()',
};

/**
 * Escape a value for embedding inside a DAX double-quoted string literal:
 * DAX escapes a double-quote by DOUBLING it ("" ). No other escaping applies.
 */
function daxString(value) {
  return String(value).replace(/"/g, '""');
}

/**
 * Build the EVALUATE string for a model-info query.
 *
 * Base expression is the bare INFO.VIEW.<X>() call. Optional refinements, applied
 * so TOPN is OUTERMOST (it must wrap the already-filtered set):
 *   - table    → FILTER(<expr>, [Table] = "table")
 *   - nameLike → FILTER(<expr>, CONTAINSSTRING([Name], "nameLike"))
 *     (table + nameLike combine into a single FILTER with && )
 *   - top      → TOPN(top, <expr>)   [outermost]
 *
 * @param {string} object one of measures|tables|columns|relationships
 * @param {{table?:string, nameLike?:string, top?:number}} [opts]
 * @returns {string} an "EVALUATE ..." string
 */
export function buildInfoQuery(object, opts = {}) {
  const base = INFO_VIEW_DAX[object];
  if (!base) throw new Error(`unknown model-info object: ${object}`);
  const { table, nameLike, top } = opts;

  let expr = base;
  const conds = [];
  if (table != null && table !== '') conds.push(`[Table] = "${daxString(table)}"`);
  if (nameLike != null && nameLike !== '') conds.push(`CONTAINSSTRING([Name], "${daxString(nameLike)}")`);
  if (conds.length) {
    expr = `FILTER(${expr}, ${conds.join(' && ')})`;
  }
  // TOPN is applied LAST so it caps the already-filtered rows (outermost wrap).
  if (top != null && Number.isFinite(top) && top > 0) {
    expr = `TOPN(${Math.floor(top)}, ${expr})`;
  }
  return `EVALUATE ${expr}`;
}
