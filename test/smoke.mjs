/**
 * Smoke test — must pass WITHOUT Power BI Desktop running.
 *
 * Spawns `node server.js`, speaks MCP over stdio (via the SDK client:
 * initialize -> notifications/initialized -> tools/list), asserts all 33 tool
 * names are present, then calls pbi_status and asserts the result parses and has
 * connected:false (Desktop is not running). Exit 0 on pass, 1 on failure.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'server.js');

const EXPECTED_TOOLS = [
  'pbi_launch',
  'pbi_status',
  'pbi_pages',
  'pbi_goto_page',
  'pbi_deselect',
  'pbi_state_probe',
  'pbi_read_cards',
  'pbi_click',
  'pbi_set_slicer',
  'pbi_fire_bookmark',
  'pbi_read_matrix',
  'pbi_matrix_expand',
  'pbi_cross_filter_test',
  'pbi_hover_tooltip',
  'pbi_scan_errors',
  'pbi_perf_analyzer',
  'pbi_page_sweep',
  'pbi_baseline',
  'pbi_wait_for',
  'pbi_eval',
  'pbi_run_code',
  'pbi_snapshot',
  'pbi_type',
  'pbi_search_slicer',
  'pbi_context_menu',
  'pbi_screenshot',
  'pbi_visuals',
  'pbi_read_dax_editor',
  'pbi_read_tmdl',
  'pbi_dax_query',
  'pbi_dialog',
  'pbi_deep_snapshot',
  'pbi_emulate_theme',
];

const fail = (msg) => {
  console.error('SMOKE FAIL:', msg);
  process.exit(1);
};

async function main() {
  // Point CDP at a dead port so the connect attempt fails fast (Desktop not running).
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, PBI_CDP_ENDPOINT: 'http://127.0.0.1:59999' },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'smoke-test', version: '0.0.1' }, { capabilities: {} });

  await client.connect(transport); // performs initialize + notifications/initialized
  console.log('OK  initialize handshake complete');

  // tools/list
  const listed = await client.listTools();
  const names = (listed.tools || []).map((t) => t.name).sort();
  console.log(`OK  tools/list returned ${names.length} tools`);

  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length) fail(`missing tools: ${missing.join(', ')}`);
  if (names.length !== EXPECTED_TOOLS.length)
    fail(`expected exactly ${EXPECTED_TOOLS.length} tools, got ${names.length}: ${names.join(', ')}`);
  console.log(`OK  all ${EXPECTED_TOOLS.length} expected tool names present`);

  // Call pbi_status — must return connected:false (Desktop not running).
  const res = await client.callTool({ name: 'pbi_status', arguments: {} });
  const text = res && res.content && res.content[0] && res.content[0].text;
  if (!text) fail('pbi_status returned no text content');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    fail(`pbi_status content is not valid JSON: ${text}`);
  }
  if (parsed.connected !== false)
    fail(`expected connected:false (Desktop not running), got: ${JSON.stringify(parsed)}`);
  if (!parsed.error || !parsed.hint) fail(`expected {error, hint} on disconnect, got: ${JSON.stringify(parsed)}`);
  console.log('OK  pbi_status returned connected:false with error+hint');
  console.log('    ', JSON.stringify(parsed));

  await client.close();
  console.log('\nSMOKE PASS');
  process.exit(0);
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
});
