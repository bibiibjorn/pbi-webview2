/**
 * Launch Power BI Desktop with the WebView2 CDP debug port enabled — exposed as a
 * tool so no separate PowerShell/launcher step is needed.
 *
 * The CDP port only exists if WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is set in
 * PBIDesktop's OWN environment BEFORE it starts. We inject it into the spawned
 * child's env, so only Desktops launched through this tool expose the port.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CDP_HOST = '127.0.0.1'; // never localhost — binds IPv4 only, localhost resolves IPv6 first

const BRIDGE_OPEN_ARGS = (pbip) => ['open', pbip, '--timeout', '480000'];

/**
 * Resolve HOW to launch Desktop, tried in order. Returns one of:
 *   { kind:'bridge-env',  launcherPath, spawnCmd, spawnArgs }   — PBI_DESKTOP_BRIDGE
 *   { kind:'bridge-path', launcherPath, spawnCmd, spawnArgs }   — powerbi-desktop on PATH
 *   { kind:'direct',      launcherPath, spawnCmd, spawnArgs }   — PBIDesktop.exe fallback
 *   null                                                        — nothing found
 *
 * The Microsoft `powerbi-desktop` bridge CLI takes `open <pbip> --timeout <ms>`.
 * A `.js` entry must run under this Node (process.execPath); a `.cmd`/`.bat` must
 * go through `cmd.exe /c` (Windows won't spawn a batch file directly); an `.exe`
 * (or any other) spawns directly. The direct fallback needs no MS CLI at all — it
 * launches PBIDesktop.exe with the `.pbip` as its single argument.
 */
function resolveLauncher(pbip) {
  // Build the spawn cmd/args for a resolved bridge launcher path, honouring the
  // .js / .cmd|.bat / other distinction. `bridge` is an absolute path.
  const bridgeSpawn = (bridge) => {
    const ext = path.extname(bridge).toLowerCase();
    if (ext === '.js') {
      return { spawnCmd: process.execPath, spawnArgs: [bridge, ...BRIDGE_OPEN_ARGS(pbip)] };
    }
    if (ext === '.cmd' || ext === '.bat') {
      return { spawnCmd: 'cmd.exe', spawnArgs: ['/c', bridge, ...BRIDGE_OPEN_ARGS(pbip)] };
    }
    return { spawnCmd: bridge, spawnArgs: BRIDGE_OPEN_ARGS(pbip) };
  };

  // 1. Explicit bridge path from the env var.
  const envBridge = process.env.PBI_DESKTOP_BRIDGE;
  if (envBridge && fs.existsSync(envBridge)) {
    return { kind: 'bridge-env', launcherPath: envBridge, ...bridgeSpawn(envBridge) };
  }

  // 2. `powerbi-desktop` on PATH — resolve via `where.exe` (first line; prefer a
  //    .cmd match when where.exe reports several, since npm installs a .cmd shim).
  try {
    const w = spawnSync('where.exe', ['powerbi-desktop'], { windowsHide: true, encoding: 'utf8' });
    if (w.status === 0 && w.stdout) {
      const lines = w.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length) {
        const cmd = lines.find((l) => l.toLowerCase().endsWith('.cmd'));
        const resolved = cmd || lines[0];
        return { kind: 'bridge-path', launcherPath: resolved, ...bridgeSpawn(resolved) };
      }
    }
  } catch (e) { /* where.exe unavailable — fall through to direct spawn */ }

  // 3. Direct PBIDesktop.exe spawn (no MS CLI needed). Locate the exe in order:
  //    PBI_DESKTOP_EXE env → %ProgramFiles% install → %LOCALAPPDATA% Store alias.
  const exeCandidates = [
    process.env.PBI_DESKTOP_EXE,
    process.env.ProgramFiles &&
      path.join(process.env.ProgramFiles, 'Microsoft Power BI Desktop', 'bin', 'PBIDesktop.exe'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'PBIDesktop.exe'),
  ].filter(Boolean);
  for (const exe of exeCandidates) {
    if (fs.existsSync(exe)) {
      // PBIDesktop.exe opens a .pbip passed as its single positional argument.
      return { kind: 'direct', launcherPath: exe, spawnCmd: exe, spawnArgs: [pbip] };
    }
  }

  return null;
}

/**
 * Discover the PBIDesktop.exe process behind the CDP port so pbi_close can kill
 * the RIGHT instance (never a blind kill-by-name, which would take down other
 * Desktops). Strategy:
 *   1. Get-NetTCPConnection → the PID that OWNS the listening CDP port. That PID
 *      is a msedgewebview2 child of PBIDesktop (WebView2 hosts the debug port).
 *   2. Walk ParentProcessId via Get-CimInstance Win32_Process up the chain until
 *      a process named PBIDesktop.exe — that ancestor is the instance to kill.
 * Returns { pbiPid, portOwnerPid } when the ancestor is found, or
 * { portOwnerPid } only if the walk fails (caller taskkills the owner tree with
 * /T as a fallback). All-null on total failure.
 *
 * Synchronous (spawnSync) — pbi_close is a deliberate, one-shot teardown.
 */
export function findDesktopPid(port = 9222) {
  const ps = (script) => {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, encoding: 'utf8' }
    );
    return r.status === 0 && r.stdout ? r.stdout.trim() : '';
  };

  // 1. Port owner PID.
  const ownerOut = ps(
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty OwningProcess -First 1)`
  );
  const portOwnerPid = parseInt(ownerOut, 10);
  if (Number.isNaN(portOwnerPid)) return {};

  // 2. Walk parents to the PBIDesktop.exe ancestor (cap the walk defensively).
  let cur = portOwnerPid;
  for (let i = 0; i < 12 && cur; i++) {
    const infoOut = ps(
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${cur}" -ErrorAction SilentlyContinue; ` +
        `if ($p) { "$($p.Name)|$($p.ParentProcessId)" }`
    );
    if (!infoOut) break;
    const [name, parentStr] = infoOut.split('|');
    if ((name || '').toLowerCase() === 'pbidesktop.exe') {
      return { pbiPid: cur, portOwnerPid };
    }
    const parent = parseInt(parentStr, 10);
    if (Number.isNaN(parent) || parent === cur) break;
    cur = parent;
  }
  // Ancestor walk failed — return the owner only (caller kills its tree with /T).
  return { portOwnerPid };
}

/**
 * Terminate a process tree by PID. /T kills children (WebView2, msmdsrv) too;
 * /F forces it. Returns { killed, pid, method }.
 */
export function killDesktop(pid) {
  if (!pid) return { killed: false, pid: null, method: 'taskkill' };
  const r = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  return { killed: r.status === 0, pid, method: 'taskkill /T /F' };
}

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

  // Resolve a launcher: PBI_DESKTOP_BRIDGE → powerbi-desktop on PATH → PBIDesktop.exe.
  const launcher = resolveLauncher(pbip);
  if (!launcher) {
    return {
      launched: false,
      error:
        'no launcher found — Microsoft powerbi-desktop bridge CLI is not on PATH / PBI_DESKTOP_BRIDGE, and no PBIDesktop.exe was located.',
      hint: 'npm i -g @microsoft/powerbi-desktop-bridge-cli, or set PBI_DESKTOP_EXE to your PBIDesktop.exe',
      preflight: pre,
    };
  }

  // Spawn so Desktop outlives this tool call, injecting the CDP env var into the
  // CHILD environment (the whole point — the shell env of this server process is
  // irrelevant; PBIDesktop reads it from its own launch env).
  //
  // IMPORTANT — do NOT use detached:true on Windows. detached gives the child its
  // OWN console window, which OVERRIDES windowsHide:true and makes the cmd.exe
  // wrapper (bridge-path/.cmd launcher) flash a visible black console. PBIDesktop
  // is a GUI app that reparents to the OS on its own, so unref() alone is enough
  // to let it outlive us — and with windowsHide:true + stdio:'ignore' and no
  // detached console, nothing is shown. (verified: cmd flash on detached:true.)
  const child = spawn(launcher.spawnCmd, launcher.spawnArgs, {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    },
  });
  child.on('error', () => {});
  child.unref();

  const result = await portUp(port, waitPortMs);
  return {
    launched: true,
    launcher: launcher.kind,
    launcherPath: launcher.launcherPath,
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
