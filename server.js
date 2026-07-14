#!/usr/bin/env node
/**
 * pbi-webview2 — MCP server that drives Power BI Desktop's WebView2 report canvas
 * over CDP, encoding the verified pbi-ui-test recipes as first-class tools.
 *
 * Transport: stdio. Lazy connect (first tool call). Never connects at startup so
 * the server boots with Desktop closed (smoke test relies on this).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './src/tools.js';

const server = new McpServer(
  { name: 'pbi-webview2', version: '0.1.0' },
  {
    instructions:
      'Drives the LIVE Power BI Desktop report canvas over CDP (WebView2). ' +
      'Launch Desktop first via ~/.claude/scripts/pbi-desktop-debug.ps1 (CDP port is ' +
      'launch-time only; endpoint http://127.0.0.1:9222, never localhost). Tools connect ' +
      'lazily and return {connected:false,...} when Desktop is unreachable. Never save the ' +
      'report after test clicks; restore slicers/page when done.',
  }
);

registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP channel.
  process.stderr.write('pbi-webview2 MCP server ready (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`pbi-webview2 fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
