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
import { fmtMs, median } from './format.mjs';
import { printReport, BOLD, DIM, RESET } from './report-console.mjs';
import { generateHtml } from './report-html.mjs';

// -- Throttle presets (matching Lighthouse/Chrome DevTools) --

const THROTTLE_PRESETS = {
  'slow-3g': { latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 25 * 1024, label: 'Slow 3G' },
  'fast-3g': { latency: 150, downloadThroughput: 197 * 1024, uploadThroughput: 48 * 1024, label: 'Fast 3G' },
  '4g':      { latency: 20,  downloadThroughput: 1500 * 1024, uploadThroughput: 750 * 1024, label: '4G' },
};

// -- Device presets (matching Lighthouse) --

const DEVICE_PRESETS = {
  desktop: {
    label: 'Desktop',
    width: 1440,
    height: 920,
    deviceScaleFactor: 1,
    mobile: false,
    userAgent: null, // use Chrome's default
  },
  tablet: {
    label: 'Tablet (iPad Air)',
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  mobile: {
    label: 'Mobile (Moto G Power)',
    width: 412,
    height: 823,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
};

// -- CLI args parsing --

let TARGET_URL = 'http://localhost:3000';
let NUM_RUNS = 1;
let HTML_OUTPUT = null; // null = no HTML, true = auto-name, string = path
let THROTTLE = null; // default: no throttling
let CPU_THROTTLE = 1; // multiplier: 1 = no slowdown
let DEVICE = DEVICE_PRESETS.desktop; // default: desktop
let PARALLEL = false;
let EXTRA_HEADERS = {};
let EXTRA_COOKIES = [];

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
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
    web-perf-audit https://example.com --runs 5 --parallel
    web-perf-audit https://example.com --header "Authorization: Bearer tok"
    web-perf-audit https://example.com --cookie "session=abc123"
`);
  process.exit(0);
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runs' && args[i + 1]) {
    NUM_RUNS = Math.max(1, parseInt(args[i + 1], 10) || 1);
    i++;
  }
  else if (args[i] === '--device' && args[i + 1]) {
    const preset = args[i + 1];
    if (!DEVICE_PRESETS[preset]) {
      console.error(`Unknown device preset: "${preset}"\nAvailable presets: ${Object.keys(DEVICE_PRESETS).join(', ')}`);
      process.exit(1);
    }
    DEVICE = DEVICE_PRESETS[preset];
    i++;
  }
  else if (args[i] === '--throttle' && args[i + 1]) {
    const preset = args[i + 1];
    if (preset === 'none') {
      THROTTLE = null;
    }
    else if (!THROTTLE_PRESETS[preset]) {
      console.error(`Unknown throttle preset: "${preset}"\nAvailable presets: ${Object.keys(THROTTLE_PRESETS).join(', ')}, none`);
      process.exit(1);
    }
    else {
      THROTTLE = THROTTLE_PRESETS[preset];
    }
    i++;
  }
  else if (args[i] === '--cpu-throttle' && args[i + 1]) {
    const rate = parseFloat(args[i + 1]);
    if (isNaN(rate) || rate < 1) {
      console.error(`Invalid CPU throttle rate: "${args[i + 1]}"\nMust be a number >= 1 (e.g. 4 = 4x slower)`);
      process.exit(1);
    }
    CPU_THROTTLE = rate;
    i++;
  }
  else if (args[i] === '--parallel') {
    PARALLEL = true;
  }
  else if (args[i] === '--header' && args[i + 1]) {
    const colonIdx = args[i + 1].indexOf(':');
    if (colonIdx === -1) {
      console.error(`Invalid header format: "${args[i + 1]}"\nExpected "Name: Value"`);
      process.exit(1);
    }
    const name = args[i + 1].slice(0, colonIdx).trim();
    const value = args[i + 1].slice(colonIdx + 1).trim();
    EXTRA_HEADERS[name] = value;
    i++;
  }
  else if (args[i] === '--cookie' && args[i + 1]) {
    const eqIdx = args[i + 1].indexOf('=');
    if (eqIdx === -1) {
      console.error(`Invalid cookie format: "${args[i + 1]}"\nExpected "name=value"`);
      process.exit(1);
    }
    const name = args[i + 1].slice(0, eqIdx).trim();
    const value = args[i + 1].slice(eqIdx + 1).trim();
    EXTRA_COOKIES.push({ name, value });
    i++;
  }
  else if (args[i] === '--html') {
    // Next arg is either a path or another flag (or nothing)
    if (args[i + 1] && !args[i + 1].startsWith('--')) {
      HTML_OUTPUT = args[i + 1];
      i++;
    }
    else {
      HTML_OUTPUT = true; // auto-generate filename
    }
  }
  else if (!args[i].startsWith('--')) {
    TARGET_URL = args[i];
  }
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

// -- Main --

async function main() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'perf-audit-'));
  const debugPort = 9222 + Math.floor(Math.random() * 1000);

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

  if (!chromeProc) {
    const candidates = CHROME_PATHS_BY_PLATFORM[process.platform] ||
      Object.values(CHROME_PATHS_BY_PLATFORM).flat();
    console.error('Could not find Chrome. Looked in:\n' + candidates.join('\n'));
    console.error('\nYou can set the CHROME_PATH environment variable to your Chrome binary.');
    process.exit(1);
  }

  // Wait for CDP to be ready
  let wsUrl;
  for (let i = 0; i < 50; i++) {
    try {
      const info = await httpJson(`http://127.0.0.1:${debugPort}/json/version`);
      wsUrl = info.webSocketDebuggerUrl;
      break;
    }
    catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (!wsUrl) {
    console.error('Chrome started but CDP not reachable.');
    chromeProc.kill();
    process.exit(1);
  }

  console.log(`\n${BOLD}Performance Audit: ${TARGET_URL}${RESET}`);
  console.log(`${DIM}Device: ${DEVICE.label} (${DEVICE.width}x${DEVICE.height}${DEVICE.mobile ? ', touch' : ''})${RESET}`);
  if (THROTTLE) console.log(`${DIM}Network: ${THROTTLE.label} (latency ${THROTTLE.latency}ms, down ${THROTTLE.downloadThroughput / 1024} KB/s, up ${THROTTLE.uploadThroughput / 1024} KB/s)${RESET}`);
  if (CPU_THROTTLE > 1) console.log(`${DIM}CPU: ${CPU_THROTTLE}x slowdown${RESET}`);
  if (NUM_RUNS > 1) console.log(`${DIM}Running ${NUM_RUNS} iterations${PARALLEL ? ' in parallel' : ''}, will report median vitals.${RESET}`);
  console.log();

  // Browser-level CDP session for creating isolated contexts
  const browser = new CDPSession(wsUrl);
  await browser.connect();

  // Close the default about:blank page from Chrome launch
  const initialTargets = await httpJson(`http://127.0.0.1:${debugPort}/json`);
  for (const t of initialTargets) {
    if (t.type === 'page') {
      try { await httpJson(`http://127.0.0.1:${debugPort}/json/close/${t.id}`, 'PUT'); } catch { /* ok */ }
    }
  }

  // Derive cookie domains from TARGET_URL now that URL is known
  const targetDomain = new URL(TARGET_URL).hostname;
  const resolvedCookies = EXTRA_COOKIES.map(c => ({ ...c, domain: targetDomain, path: '/' }));

  const auditOpts = { throttle: THROTTLE, cpuThrottle: CPU_THROTTLE, device: DEVICE, extraHeaders: EXTRA_HEADERS, extraCookies: resolvedCookies };

  async function executeRun(runIndex) {
    // Create an isolated browser context (incognito-like) per run
    // This gives a fresh DNS cache, connection pool, cookies, and storage
    const { browserContextId } = await browser.send('Target.createBrowserContext');
    const { targetId } = await browser.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });

    // Find the page WebSocket URL for the new target
    const targets = await httpJson(`http://127.0.0.1:${debugPort}/json`);
    const pageTarget = targets.find((t) => t.id === targetId);
    if (!pageTarget) throw new Error('Could not find page target for isolated context');

    const cdp = new CDPSession(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();

    const result = await runAudit(cdp, TARGET_URL, auditOpts);

    cdp.close();
    await browser.send('Target.disposeBrowserContext', { browserContextId });

    if (NUM_RUNS > 1) {
      const r = result;
      console.log(`  ${DIM}[Run ${runIndex + 1}]${RESET} TTFB: ${fmtMs(r.nav.responseStart - r.nav.startTime)} | FCP: ${fmtMs(r.vitals.fcp)} | LCP: ${fmtMs(r.vitals.lcp)} | CLS: ${r.vitals.cls.toFixed(3)} | TBT: ${fmtMs(r.tbt)}`);
    }

    return result;
  }

  let allResults;

  if (PARALLEL && NUM_RUNS > 1) {
    // Run all iterations concurrently
    allResults = await Promise.all(
      Array.from({ length: NUM_RUNS }, (_, i) => executeRun(i)),
    );
  }
  else {
    // Run sequentially
    allResults = [];
    for (let run = 0; run < NUM_RUNS; run++) {
      if (NUM_RUNS > 1) console.log(`${DIM}── Run ${run + 1}/${NUM_RUNS} ──${RESET}`);
      allResults.push(await executeRun(run));
    }
  }

  browser.close();

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
    const inps = allResults.map(r => r.inp || 0);

    medianVitals = {
      ttfb: median(ttfbs),
      fcp: median(fcps),
      lcp: median(lcps),
      cls: median(clss),
      tbt: median(tbts),
      inp: median(inps),
    };

    console.log(`  ${'Run'.padEnd(6)} ${'TTFB'.padStart(10)} ${'FCP'.padStart(10)} ${'LCP'.padStart(10)} ${'CLS'.padStart(10)} ${'TBT'.padStart(10)} ${'INP'.padStart(10)}`);
    console.log(`  ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

    for (let i = 0; i < NUM_RUNS; i++) {
      console.log(
        `  ${String(i + 1).padEnd(6)} ${fmtMs(ttfbs[i]).padStart(10)} ${fmtMs(fcps[i]).padStart(10)} ${fmtMs(lcps[i]).padStart(10)} ${clss[i].toFixed(3).padStart(10)} ${fmtMs(tbts[i]).padStart(10)} ${fmtMs(inps[i]).padStart(10)}`,
      );
    }

    console.log(`  ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);
    console.log(
      `  ${BOLD}${'Median'.padEnd(6)} ${fmtMs(medianVitals.ttfb).padStart(10)} ${fmtMs(medianVitals.fcp).padStart(10)} ${fmtMs(medianVitals.lcp).padStart(10)} ${medianVitals.cls.toFixed(3).padStart(10)} ${fmtMs(medianVitals.tbt).padStart(10)} ${fmtMs(medianVitals.inp).padStart(10)}${RESET}`,
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

  printReport(reportData, { throttle: THROTTLE, cpuThrottle: CPU_THROTTLE, device: DEVICE });

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
    });

    writeFileSync(htmlPath, html, 'utf-8');
    console.log(`${BOLD}HTML report saved: ${htmlPath}${RESET}\n`);
  }

  // Cleanup
  chromeProc.kill();
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ok */ }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
