/**
 * Launch Power BI Desktop with the WebView2 CDP debug port enabled — the
 * in-process equivalent of scripts/pbi-desktop-debug.ps1, exposed as a tool so
 * no separate PowerShell step is needed.
 *
 * The CDP port only exists if WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is set in
 * PBIDesktop's OWN environment BEFORE it starts. We inject it into the spawned
 * child's env, so only Desktops launched through this tool expose the port.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CDP_HOST = '127.0.0.1'; // never localhost — binds IPv4 only, localhost resolves IPv6 first

// The `powerbi-desktop` CLI resolves to this Node entry (see the shim on PATH).
const BRIDGE_CLI = path.join(
  os.homedir(),
  'node-v22.20.0-win-x64',
  'node_modules',
  '@microsoft',
  'powerbi-desktop-bridge-cli',
  'dist',
  'index.js'
);

async function portUp(port, timeoutMs) {
  const start = Date.now();
  const url = `http://${CDP_HOST}:${port}/json/version`;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const v = await res.json();
        return { up: true, browser: v.Browser || null, elapsedMs: Date.now() - start };
      }
    } catch (e) {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { up: false, elapsedMs: Date.now() - start };
}

/**
 * Pre-flight: orphaned PBIDesktop / msmdsrv from earlier debug launches starve
 * memory and make the new instance render like it is frozen. Report, never kill.
 */
async function preflight() {
  const warnings = [];
  const count = async (name) =>
    new Promise((resolve) => {
      const p = spawn(
        'powershell.exe',
        ['-NoProfile', '-Command', `@(Get-Process ${name} -ErrorAction SilentlyContinue).Count`],
        { windowsHide: true }
      );
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => resolve(parseInt(out.trim(), 10) || 0));
      p.on('error', () => resolve(0));
    });
  const pbi = await count('PBIDesktop');
  const as = await count('msmdsrv');
  if (pbi > 0)
    warnings.push(
      `${pbi} PBIDesktop instance(s) already running — a second instance competes for AS memory; close the old one first (DON'T SAVE if it has test-click state).`
    );
  if (as > pbi)
    warnings.push(
      `${as} msmdsrv (AS engine) process(es) for ${pbi} Desktop instance(s) — orphaned engines from earlier launches hold RAM; end the msmdsrv processes with no matching Desktop, or reboot, before blaming the report.`
    );
  return { pbiRunning: pbi, asRunning: as, warnings };
}

/**
 * Launch Desktop on a .pbip with the CDP port, wait until the port answers.
 * Returns structured status; does NOT wait for the canvas to finish rendering
 * (that is the report's own multi-minute load — poll pbi_wait_for after).
 */
export async function launchDesktop({ pbip, port = 9222, waitPortMs = 240000, skipIfPortUp = true }) {
  if (!pbip || typeof pbip !== 'string') {
    return { launched: false, error: 'pbip path is required' };
  }
  if (!fs.existsSync(pbip)) {
    return { launched: false, error: `.pbip not found: ${pbip}` };
  }
  if (!/\.pbip$/i.test(pbip)) {
    return { launched: false, error: `not a .pbip file: ${pbip}` };
  }

  // Already up? Attaching to a second instance on the same port is impossible;
  // just report the existing one so the caller can proceed to connect.
  if (skipIfPortUp) {
    const existing = await portUp(port, 2500);
    if (existing.up) {
      return {
        launched: false,
        alreadyRunning: true,
        port,
        cdp: `http://${CDP_HOST}:${port}`,
        browser: existing.browser,
        note: 'CDP port already up — using the running Desktop (did not launch a second instance).',
      };
    }
  }

  const pre = await preflight();

  if (!fs.existsSync(BRIDGE_CLI)) {
    return { launched: false, error: `powerbi-desktop bridge CLI not found at ${BRIDGE_CLI}` };
  }

  // Spawn detached so Desktop outlives this tool call; inject the CDP env var
  // into the CHILD environment (the whole point — the shell env of this server
  // process is irrelevant; PBIDesktop reads it from its own launch env).
  const child = spawn(
    process.execPath,
    [BRIDGE_CLI, 'open', pbip, '--timeout', '480000'],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      },
    }
  );
  child.on('error', () => {});
  child.unref();

  const result = await portUp(port, waitPortMs);
  return {
    launched: true,
    port,
    cdp: `http://${CDP_HOST}:${port}`,
    cdpUp: result.up,
    browser: result.browser || null,
    portWaitMs: result.elapsedMs,
    preflight: pre,
    warnings: pre.warnings,
    note: result.up
      ? 'CDP port is up. The report canvas is still rendering — call pbi_wait_for {text:"<a page name>"} before reading values.'
      : `CDP port did not answer within ${waitPortMs}ms; the WebView2 canvas may still be starting — retry pbi_status in ~30s.`,
  };
}
