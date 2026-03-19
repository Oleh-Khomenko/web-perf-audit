#!/usr/bin/env node

/**
 * Performance Navigation Metrics & Web Vitals audit script.
 * Zero dependencies — uses system Chrome + CDP over Node built-ins.
 *
 * Usage: web-perf-audit [url] [options]
 * Default: http://localhost:3000
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { CDPSession, httpJson } from './cdp.mjs';
import { runAudit } from './audit.mjs';
import { runCalibration, CALIBRATION_DEVICES, DEFAULT_CALIBRATION_DEVICE } from './calibrate.mjs';
import { fmtMs, median } from './format.mjs';
import { printReport, BOLD, DIM, RESET } from './report-console.mjs';
import { generateHtml } from './report-html.mjs';
import { parseArgs, DEVICE_PRESETS, THROTTLE_PRESETS } from './cli.mjs';

// -- CLI args parsing --

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (parsed.help) {
  console.log(`
  web-perf-audit — zero-dep Chrome CDP performance profiler

  Usage:
    web-perf-audit [url] [options]

  Arguments:
    url                  Target URL to audit (default: http://localhost:3000)

  Options:
    --runs N             Run the audit N times and report median Web Vitals (default: 1)
    --parallel           Run all iterations concurrently (use with --runs)
    --device <preset>    Device emulation: desktop, tablet, mobile (default: desktop)
    --throttle <preset>  Simulate network conditions: slow-3g, fast-3g, 4g, none (default: 4g)
    --cpu-throttle <N>   CPU slowdown multiplier, e.g. 4 = 4x slower (default: 1, no throttle)
    --calibrate [device|ms] Auto-detect CPU throttle (devices: ${Object.keys(CALIBRATION_DEVICES).join(', ')}; or custom ms e.g. 500; default: ${DEFAULT_CALIBRATION_DEVICE})
    --header "Name: Val"  Add a custom HTTP header (repeatable)
    --cookie "name=val"  Add a cookie for the target domain (repeatable)
    --html [path]        Save report as HTML file (default: perf-audit-{timestamp}.html in cwd)
    -h, --help           Show this help message

  Sections reported:
    Navigation Timing    DNS, TCP, TLS, TTFB, download, DOM lifecycle, total load
    Web Vitals           TTFB, FCP, LCP, CLS, TBT with Good/Needs work/Poor ratings
    Resource Summary     Request count, transfer size, and slowest time per resource type
    JS Coverage          Used vs unused bytes per script (top 15), total unused percentage
    Render-Blocking      Resources with renderBlockingStatus === 'blocking'
    Preload Audit        Cross-references <link rel="preload"> with actual resource usage
    Largest Resources    Top 10 resources by transfer size


  Environment variables:
    CHROME_PATH              Path to a custom Chrome/Chromium binary

  Examples:
    web-perf-audit
    web-perf-audit https://example.com
    web-perf-audit https://example.com --runs 5
    web-perf-audit https://example.com --html
    web-perf-audit https://example.com --html report.html
    web-perf-audit https://example.com --throttle slow-3g
    web-perf-audit https://example.com --cpu-throttle 4
    web-perf-audit https://example.com --device mobile --throttle fast-3g --cpu-throttle 4
    web-perf-audit https://example.com --calibrate
    web-perf-audit https://example.com --runs 5 --parallel
    web-perf-audit https://example.com --header "Authorization: Bearer tok"
    web-perf-audit https://example.com --cookie "session=abc123"
`);
  process.exit(0);
}

let TARGET_URL = parsed.url;
let NUM_RUNS = parsed.runs;
let HTML_OUTPUT = parsed.htmlOutput;
let THROTTLE = parsed.throttle;
let CPU_THROTTLE = parsed.cpuThrottle;
let DEVICE = parsed.device;
let PARALLEL = parsed.parallel;
let CALIBRATE_DEVICE = parsed.calibrateDevice;
let CALIBRATE_CUSTOM_MS = parsed.calibrateCustomMs;
let EXTRA_HEADERS = parsed.headers;
let EXTRA_COOKIES = parsed.cookies;

// -- Conflict warning --
if (CALIBRATE_DEVICE && parsed.cpuThrottleExplicit) {
  console.warn('Warning: --calibrate and --cpu-throttle both set. --calibrate will override the manual value.');
}

// -- Chrome discovery --

const CHROME_PATHS_BY_PLATFORM = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    'google-chrome',
    'google-chrome-stable',
    'chromium-browser',
    'chromium',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

/**
 * Try to spawn a bare command name (e.g. 'google-chrome') and resolve
 * with the ChildProcess on success, or reject on error.
 */
function trySpawn(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, opts);
    proc.on('spawn', () => resolve(proc));
    proc.on('error', (err) => reject(err));
  });
}

/**
 * Find a working Chrome binary. Checks CHROME_PATH env var first,
 * then platform-specific candidates.
 */
async function findChrome(chromeArgs, spawnOpts) {
  // 1. Check CHROME_PATH env var
  if (process.env.CHROME_PATH) {
    const p = process.env.CHROME_PATH;
    if (!existsSync(p)) {
      console.error(`CHROME_PATH is set to "${p}" but the file does not exist.`);
      process.exit(1);
    }
    return trySpawn(p, chromeArgs, spawnOpts);
  }

  // 2. Get platform-specific candidates (fall back to all paths if platform unknown)
  const candidates = CHROME_PATHS_BY_PLATFORM[process.platform] ||
    Object.values(CHROME_PATHS_BY_PLATFORM).flat();

  for (const p of candidates) {
    const isAbsolute = p.startsWith('/') || /^[a-zA-Z]:\\/.test(p);

    if (isAbsolute) {
      // For absolute paths, check existence first to avoid ENOENT
      if (existsSync(p)) {
        return trySpawn(p, chromeArgs, spawnOpts);
      }
    } else {
      // For bare command names (linux), try spawning and await result
      try {
        return await trySpawn(p, chromeArgs, spawnOpts);
      } catch {
        // not found, try next
      }
    }
  }

  return null;
}

// -- Cleanup on interrupt --

let _chromeProc = null;
let _userDataDir = null;

function cleanup() {
  if (_chromeProc) {
    _chromeProc.kill('SIGKILL');
    _chromeProc = null;
  }
  if (_userDataDir) {
    try { rmSync(_userDataDir, { recursive: true, force: true }); } catch {}
    _userDataDir = null;
  }
}

process.on('SIGINT', () => {
  console.log(`\n${DIM}Interrupted — cleaning up...${RESET}`);
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

// -- Main --

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'perf-audit-'));
  _userDataDir = userDataDir;
  const debugPort = 9222 + Math.floor(Math.random() * 23000);

  // Launch Chrome
  const chromeArgs = [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    'about:blank',
  ];
  const chromeProc = await findChrome(chromeArgs, { stdio: 'ignore' });
  _chromeProc = chromeProc;

  if (!chromeProc) {
    const candidates = CHROME_PATHS_BY_PLATFORM[process.platform] ||
      Object.values(CHROME_PATHS_BY_PLATFORM).flat();
    console.error('Could not find Chrome. Looked in:\n' + candidates.join('\n'));
    console.error('\nYou can set the CHROME_PATH environment variable to your Chrome binary.');
    process.exit(1);
  }

  try {
  // Wait for CDP to be ready
  let wsUrl;
  let chromeCrashed = null;
  chromeProc.on('exit', (code) => { chromeCrashed = code; });
  for (let i = 0; i < 50; i++) {
    if (chromeCrashed !== null || chromeProc.exitCode !== null) {
      throw new Error(`Chrome exited with code ${chromeCrashed ?? chromeProc.exitCode} before CDP was ready`);
    }
    try {
      const info = await httpJson(`http://127.0.0.1:${debugPort}/json/version`, 'GET', 500);
      wsUrl = info.webSocketDebuggerUrl;
      break;
    }
    catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (!wsUrl) {
    throw new Error('Chrome started but CDP not reachable.');
  }
  console.log(`\n${BOLD}Performance Audit: ${TARGET_URL}${RESET}`);
  console.log(`${DIM}Device: ${DEVICE.label} (${DEVICE.width}x${DEVICE.height}${DEVICE.mobile ? ', touch' : ''})${RESET}`);
  if (THROTTLE) console.log(`${DIM}Network: ${THROTTLE.label} (latency ${THROTTLE.latency}ms, down ${THROTTLE.downloadThroughput / 1024} KB/s, up ${THROTTLE.uploadThroughput / 1024} KB/s)${RESET}`);
  if (CPU_THROTTLE > 1) console.log(`${DIM}CPU: ${CPU_THROTTLE}x slowdown${RESET}`);
  if (NUM_RUNS > 1) console.log(`${DIM}Running ${NUM_RUNS} iterations${PARALLEL ? ' in parallel' : ''}, will report median vitals.${RESET}`);
  console.log();

  // Browser-level CDP session for creating isolated contexts
  let browser;
  browser = new CDPSession(wsUrl);
  await browser.connect();

  // Close the default about:blank page from Chrome launch
  const initialTargets = await httpJson(`http://127.0.0.1:${debugPort}/json`);
  for (const t of initialTargets) {
    if (t.type === 'page') {
      try { await httpJson(`http://127.0.0.1:${debugPort}/json/close/${t.id}`, 'PUT'); } catch { /* ok */ }
    }
  }

  // CPU calibration (before audit loop)
  let calibrationResult = null;
  if (CALIBRATE_DEVICE) {
    const { browserContextId } = await browser.send('Target.createBrowserContext');
    try {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
      const calCdp = new CDPSession(`ws://127.0.0.1:${debugPort}/devtools/page/${targetId}`);
      await calCdp.connect();
      try {
        calibrationResult = await runCalibration(calCdp, CALIBRATE_DEVICE, CALIBRATE_CUSTOM_MS);
        CPU_THROTTLE = calibrationResult.multiplier;
        console.log(`${BOLD}CPU Calibration:${RESET} benchmark ${calibrationResult.measuredMs}ms → ${calibrationResult.multiplier}x throttle (ref: ${calibrationResult.referenceMs}ms ${calibrationResult.deviceLabel})`);
      } finally {
        calCdp.close();
      }
    } finally {
      await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    }
  }

  // Derive cookie domains from TARGET_URL now that URL is known
  const targetDomain = new URL(TARGET_URL).hostname;
  const resolvedCookies = EXTRA_COOKIES.map(c => {
    const isLocalOrIp = targetDomain === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(targetDomain);
    return { ...c, ...(isLocalOrIp ? {} : { domain: targetDomain }), path: '/', url: TARGET_URL };
  });

  const auditOpts = { throttle: THROTTLE, cpuThrottle: CPU_THROTTLE, device: DEVICE, extraHeaders: EXTRA_HEADERS, extraCookies: resolvedCookies };

  async function executeRun(runIndex) {
    // Create an isolated browser context (incognito-like) per run
    // This gives a fresh DNS cache, connection pool, cookies, and storage
    const { browserContextId } = await browser.send('Target.createBrowserContext');
    try {
      const { targetId } = await browser.send('Target.createTarget', {
        url: 'about:blank',
        browserContextId,
      });

      // Construct the WS URL directly to avoid a race with the /json HTTP endpoint
      const cdp = new CDPSession(`ws://127.0.0.1:${debugPort}/devtools/page/${targetId}`);
      await cdp.connect();
      try {
        const result = await runAudit(cdp, TARGET_URL, auditOpts);

        if (NUM_RUNS > 1) {
          const r = result;
          console.log(`  ${DIM}[Run ${runIndex + 1}]${RESET} TTFB: ${fmtMs(r.nav.responseStart - r.nav.startTime)} | FCP: ${fmtMs(r.vitals.fcp)} | LCP: ${fmtMs(r.vitals.lcp)} | CLS: ${r.vitals.cls.toFixed(3)} | TBT: ${fmtMs(r.tbt)}`);
        }

        return result;
      } finally {
        cdp.close();
      }
    } finally {
      await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    }
  }

  let allResults;

  if (PARALLEL && NUM_RUNS > 1) {
    // Run all iterations concurrently; collect partial results on failure
    const settled = await Promise.allSettled(
      Array.from({ length: NUM_RUNS }, (_, i) => executeRun(i)),
    );
    const failures = settled.filter(r => r.status === 'rejected');
    for (const f of failures) console.error(`  Run failed: ${f.reason.message}`);
    allResults = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (allResults.length === 0) throw new Error('All runs failed');
  }
  else {
    // Run sequentially
    allResults = [];
    const failures = [];
    for (let run = 0; run < NUM_RUNS; run++) {
      if (NUM_RUNS > 1) console.log(`${DIM}── Run ${run + 1}/${NUM_RUNS} ──${RESET}`);
      try {
        allResults.push(await executeRun(run));
      } catch (err) {
        failures.push({ run: run + 1, message: err.message });
        console.error(`  Run ${run + 1} failed: ${err.message}`);
      }
    }
    if (failures.length > 0 && allResults.length > 0) {
      console.warn(`Warning: ${failures.length}/${NUM_RUNS} run(s) failed. Reporting from ${allResults.length} successful run(s).`);
    }
    if (allResults.length === 0) throw new Error('All runs failed');
  }

  browser.close();
  browser = null;

  console.log();

  // Compute medians for multi-run
  let medianVitals = null;
  if (NUM_RUNS > 1) {
    console.log(`${BOLD}── Median Web Vitals (${NUM_RUNS} runs) ──${RESET}\n`);

    const ttfbs = allResults.map(r => r.nav.responseStart - r.nav.startTime);
    const fcps = allResults.map(r => r.vitals.fcp);
    const lcps = allResults.map(r => r.vitals.lcp);
    const clss = allResults.map(r => r.vitals.cls);
    const tbts = allResults.map(r => r.tbt);
    const inpsMeasured = allResults.map(r => r.inpMeasured);
    const measuredInps = allResults.filter(r => r.inpMeasured).map(r => r.inp);
    const inps = allResults.map(r => r.inp || 0);

    medianVitals = {
      ttfb: median(ttfbs),
      fcp: median(fcps),
      lcp: median(lcps),
      cls: median(clss),
      tbt: median(tbts),
      inp: measuredInps.length > 0 ? median(measuredInps) : null,
    };

    console.log(`  ${'Run'.padEnd(6)} ${'TTFB'.padStart(10)} ${'FCP'.padStart(10)} ${'LCP'.padStart(10)} ${'CLS'.padStart(10)} ${'TBT'.padStart(10)} ${'INP'.padStart(10)}`);
    console.log(`  ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

    for (let i = 0; i < NUM_RUNS; i++) {
      console.log(
        `  ${String(i + 1).padEnd(6)} ${fmtMs(ttfbs[i]).padStart(10)} ${fmtMs(fcps[i]).padStart(10)} ${fmtMs(lcps[i]).padStart(10)} ${clss[i].toFixed(3).padStart(10)} ${fmtMs(tbts[i]).padStart(10)} ${(inpsMeasured[i] ? fmtMs(inps[i]) : 'N/A').padStart(10)}`,
      );
    }

    console.log(`  ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);
    console.log(
      `  ${BOLD}${'Median'.padEnd(6)} ${fmtMs(medianVitals.ttfb).padStart(10)} ${fmtMs(medianVitals.fcp).padStart(10)} ${fmtMs(medianVitals.lcp).padStart(10)} ${medianVitals.cls.toFixed(3).padStart(10)} ${fmtMs(medianVitals.tbt).padStart(10)} ${(inpsMeasured.some(Boolean) ? fmtMs(medianVitals.inp) : 'N/A').padStart(10)}${RESET}`,
    );
    console.log();
  }

  // Pick the run closest to median LCP for detailed report
  let reportData;
  if (NUM_RUNS === 1) {
    reportData = allResults[0];
  }
  else {
    const lcps = allResults.map(r => r.vitals.lcp);
    const medianLCP = median(lcps);
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < allResults.length; i++) {
      const diff = Math.abs(allResults[i].vitals.lcp - medianLCP);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    reportData = allResults[bestIdx];
    console.log(`${DIM}Detailed report from run ${bestIdx + 1} (closest to median LCP).${RESET}\n`);
  }

  printReport(reportData, { throttle: THROTTLE, cpuThrottle: CPU_THROTTLE, device: DEVICE, calibration: calibrationResult });

  // HTML report
  if (HTML_OUTPUT !== null) {
    const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const htmlPath = HTML_OUTPUT === true
      ? resolve(`perf-audit-${date}.html`)
      : resolve(HTML_OUTPUT);

    const html = generateHtml(reportData, {
      url: TARGET_URL,
      date: new Date().toISOString(),
      numRuns: NUM_RUNS,
      medianVitals,
      allResults: NUM_RUNS > 1 ? allResults : null,
      throttle: THROTTLE,
      cpuThrottle: CPU_THROTTLE,
      device: DEVICE,
      calibration: calibrationResult,
    });

    writeFileSync(htmlPath, html, 'utf-8');
    console.log(`${BOLD}HTML report saved: ${htmlPath}${RESET}\n`);
  }

  } finally {
    try { if (browser) browser.close(); } catch { /* ok */ }
    console.log(`${DIM}Shutting down Chrome...${RESET}`);
    chromeProc.kill();
    _chromeProc = null;
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ok */ }
    _userDataDir = null;
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
