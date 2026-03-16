/**
 * Console report output with ANSI colors.
 */

import { fmtMs, fmtBytes, truncUrl, rate, computeOverallScore, computeFcpPhases, computeLcpPhases, buildClsSessionWindows, computeInpPhases, computeResourcePhases, PHASE_ANSI_COLORS } from './format.mjs';

// ANSI color constants
export const RESET = '\x1b[0m';
export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const RED = '\x1b[31m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const CYAN = '\x1b[36m';

const ANSI_COLORS = { green: GREEN, yellow: YELLOW, red: RED };

function printMetric(name, value, unit, good, poor, explanation) {
  const display = unit === 'ms' ? fmtMs(value) : (value ?? 0).toFixed(3);
  const { label, color } = rate(value, good, poor);
  const ansi = ANSI_COLORS[color];
  const nameStr = name.padEnd(28);
  const valStr = display.padStart(10);
  const ratingStr = `[${label}]`.padStart(14);
  console.log(`  ${nameStr} ${valStr}  ${ansi}${ratingStr}${RESET}`);
  console.log(`  ${DIM}${explanation}${RESET}`);
  console.log();
}

function printTiming(name, ms, explanation) {
  const nameStr = name.padEnd(28);
  const valStr = fmtMs(ms).padStart(10);
  console.log(`  ${nameStr} ${valStr}`);
  if (explanation) console.log(`  ${DIM}${explanation}${RESET}`);
  console.log();
}

export function printReport(data, meta = {}) {
  const { connectionInfo, nav, vitals, tbt, longTaskDetails = [], tbtByScript = [], resourceEntries, resourceSummary, jsCoverage, renderBlocking, lcpElement = null, clsEntries = [], inp = 0, inpEntries = [], preloadLinks, serverTiming = [], fontsReady = 0, renderMetrics = null, memoryInfo = null } = data;

  // Emulation info
  if (meta.device) {
    console.log(`  ${DIM}Device: ${meta.device.label} (${meta.device.width}x${meta.device.height}${meta.device.mobile ? ', touch' : ''})${RESET}`);
  }
  if (meta.throttle) {
    console.log(`  ${YELLOW}Network: ${meta.throttle.label}${RESET} ${DIM}(latency ${meta.throttle.latency}ms, down ${meta.throttle.downloadThroughput / 1024} KB/s, up ${meta.throttle.uploadThroughput / 1024} KB/s)${RESET}`);
  }
  if (meta.cpuThrottle > 1) {
    console.log(`  ${YELLOW}CPU: ${meta.cpuThrottle}x slowdown${RESET}`);
  }
  if (meta.device || meta.throttle || meta.cpuThrottle > 1) console.log();

  // Connection info
  if (connectionInfo) {
    console.log(`  ${DIM}Connection: ${connectionInfo.effectiveType} | downlink: ${connectionInfo.downlink}Mbps | RTT: ${connectionInfo.rtt}ms${RESET}\n`);
  }

  // -- Navigation Timing --
  console.log(`${BOLD}── Navigation Timing Breakdown ──${RESET}`);
  if (nav.nextHopProtocol) {
    console.log(`  ${DIM}Protocol: ${nav.nextHopProtocol}${RESET}`);
  }
  console.log();

  const dns = nav.domainLookupEnd - nav.domainLookupStart;
  const tcp = nav.connectEnd - nav.connectStart;
  const tls = nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : -1;
  const ttfbVal = nav.responseStart - nav.requestStart;
  const download = nav.responseEnd - nav.responseStart;
  const domInteractive = nav.domInteractive - nav.responseEnd;
  const domContentLoaded = nav.domContentLoadedEventEnd - nav.responseEnd;
  const domComplete = nav.domComplete - nav.responseEnd;
  const loadEvent = nav.loadEventEnd - nav.loadEventStart;
  const totalLoad = nav.loadEventEnd - nav.startTime;

  printTiming('DNS Lookup', dns, 'Time to resolve domain name → affected by DNS provider & caching');
  printTiming('TCP Connection', tcp, 'Time to establish TCP handshake');
  if (tls >= 0) printTiming('TLS Negotiation', tls, 'Time for SSL/TLS handshake → affected by cert chain & protocol');
  printTiming('Server Response (TTFB)', ttfbVal, 'Time from request sent to first byte received');
  printTiming('Content Download', download, 'Time to download the HTML response body');
  printTiming('DOM Interactive', domInteractive, 'Time from response to DOM being interactive (HTML parsed)');
  printTiming('DOM Content Loaded', domContentLoaded, 'Time from response to DOMContentLoaded event (sync scripts done)');
  printTiming('DOM Complete', domComplete, 'Time from response to all subresources loaded');
  printTiming('Load Event Duration', loadEvent, 'Time spent in the load event handler');
  printTiming('Total Page Load', totalLoad, 'Full page load from navigation start to load event end');

  // -- Performance Score --
  const overallScore = computeOverallScore({
    ttfb: nav.responseStart - nav.startTime,
    fcp: vitals.fcp,
    lcp: vitals.lcp,
    tbt: tbt,
    cls: vitals.cls,
    inp: inp,
  });
  const scoreColor = overallScore >= 90 ? GREEN : overallScore >= 50 ? YELLOW : RED;
  console.log(`\n${BOLD}── Performance Score: ${scoreColor}${overallScore}/100${RESET}${BOLD} ──${RESET}\n`);

  // -- Web Vitals --
  console.log(`${BOLD}── Web Vitals ──${RESET}\n`);

  printMetric('TTFB', nav.responseStart - nav.startTime, 'ms', 800, 1800,
    'Time to First Byte — server responsiveness. Affected by: server processing, network latency, redirects.');
  printMetric('FCP', vitals.fcp, 'ms', 1800, 3000,
    'First Contentful Paint — first text/image rendered. Affected by: render-blocking CSS/JS, font loading.');
  printMetric('LCP', vitals.lcp, 'ms', 2500, 4000,
    'Largest Contentful Paint — main content visible. Affected by: resource load time, render-blocking resources, client-side rendering.');
  printMetric('CLS', vitals.cls, 'score', 0.1, 0.25,
    'Cumulative Layout Shift — visual stability. Affected by: images without dimensions, dynamic content injection, web fonts.');
  printMetric('TBT', tbt, 'ms', 200, 600,
    'Total Blocking Time — main thread blocking after FCP. Affected by: heavy JS execution, large bundles, third-party scripts.');
  printMetric('INP', inp, 'ms', 200, 500,
    'Interaction to Next Paint — worst interaction latency (synthetic). Affected by: event handler complexity, main thread contention.');

  // -- TTFB Breakdown --
  console.log(`${BOLD}── TTFB Breakdown ──${RESET}\n`);

  const ttfbTotal = nav.responseStart - nav.startTime;

  if (ttfbTotal < 1) {
    console.log(`  ${DIM}TTFB is near-zero (${fmtMs(ttfbTotal)}) — no breakdown to show.${RESET}`);
  }
  else {
    console.log(`  Total TTFB: ${BOLD}${fmtMs(ttfbTotal)}${RESET} (navigation start → first byte)\n`);

    const redirect = nav.redirectEnd - nav.redirectStart;
    const unload = nav.fetchStart - nav.startTime;
    const swTime = nav.workerStart > 0 ? nav.domainLookupStart - nav.workerStart : 0;
    const queueCache = nav.domainLookupStart - nav.fetchStart - swTime;
    const dnsLookup = nav.domainLookupEnd - nav.domainLookupStart;
    const tcpRaw = nav.connectEnd - nav.connectStart;
    const tlsNeg = nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0;
    const tcpOnly = Math.max(0, tcpRaw - tlsNeg);
    const reqResp = nav.responseStart - nav.requestStart;
    const accounted = redirect + unload + swTime + queueCache + dnsLookup + tcpOnly + tlsNeg + reqResp;
    const other = Math.max(0, ttfbTotal - accounted);

    const phases = [
      ...(redirect > 1 ? [['Redirect', redirect]] : []),
      ...(unload > 5 ? [['Unload', unload]] : []),
      ...(swTime > 1 ? [['Service Worker', swTime]] : []),
      ...(queueCache > 5 ? [['Queue / Stale Check', queueCache]] : []),
      ['DNS Lookup', dnsLookup],
      ['TCP Connection', tcpOnly],
      ...(tlsNeg > 0 ? [['TLS Negotiation', tlsNeg]] : []),
      ['Request → Response', reqResp],
      ...(other > 5 ? [['Other', other]] : []),
    ];

    const maxDur = Math.max(...phases.map(p => p[1]));
    const barMax = 40;
    const { color: ttfbColor } = rate(ttfbTotal, 800, 1800);

    for (const [name, dur] of phases) {
      const barLen = maxDur > 0 ? Math.max(0, Math.round((dur / maxDur) * barMax)) : 0;
      const isLongest = dur === maxDur && ttfbColor !== 'green';
      const phaseColor = isLongest ? (ttfbColor === 'red' ? RED : YELLOW) : '';
      const resetColor = phaseColor ? RESET : '';
      console.log(`  ${name.padEnd(22)} ${phaseColor}${fmtMs(dur).padStart(8)}${resetColor}  ${phaseColor}${'█'.repeat(barLen)}${resetColor}`);
    }

    if (serverTiming.length > 0) {
      console.log(`\n  ${DIM}Server-Timing:${RESET}`);
      for (const st of serverTiming) {
        const label = st.description ? `${st.name} (${st.description})` : st.name;
        console.log(`    ${label.padEnd(20)} ${fmtMs(st.duration).padStart(8)}`);
      }
    }
  }
  console.log();

  // -- FCP Breakdown --
  console.log(`${BOLD}── FCP Breakdown ──${RESET}\n`);

  if (vitals.fcp < 1) {
    console.log(`  ${DIM}FCP is near-zero (${fmtMs(vitals.fcp)}) — no breakdown to show.${RESET}`);
  }
  else {
    console.log(`  Total FCP: ${BOLD}${fmtMs(vitals.fcp)}${RESET} (navigation start → first contentful paint)\n`);

    const fcpPhases = computeFcpPhases(nav, vitals.fcp, resourceEntries);
    const fcpMaxDur = Math.max(...fcpPhases.map(p => p[1]));
    const fcpBarMax = 40;
    const { color: fcpColor } = rate(vitals.fcp, 1800, 3000);

    for (const [name, dur] of fcpPhases) {
      const barLen = fcpMaxDur > 0 ? Math.max(0, Math.round((dur / fcpMaxDur) * fcpBarMax)) : 0;
      const isLongest = dur === fcpMaxDur && fcpColor !== 'green';
      const phaseColor = isLongest ? (fcpColor === 'red' ? RED : YELLOW) : '';
      const resetColor = phaseColor ? RESET : '';
      console.log(`  ${name.padEnd(22)} ${phaseColor}${fmtMs(dur).padStart(8)}${resetColor}  ${phaseColor}${'█'.repeat(barLen)}${resetColor}`);
    }
  }
  console.log();

  // -- LCP Breakdown --
  console.log(`${BOLD}── LCP Breakdown ──${RESET}\n`);

  if (vitals.lcp < 1) {
    console.log(`  ${DIM}LCP is near-zero (${fmtMs(vitals.lcp)}) — no breakdown to show.${RESET}`);
  }
  else {
    console.log(`  Total LCP: ${BOLD}${fmtMs(vitals.lcp)}${RESET} (navigation start → largest contentful paint)\n`);

    const lcpResult = computeLcpPhases(nav, vitals.lcp, lcpElement, resourceEntries, longTaskDetails, fontsReady);
    if (lcpResult.element) {
      const el = lcpResult.element;
      const sizeStr = el.size ? ` (${el.size.toLocaleString()} px²)` : '';
      const idStr = el.id ? ` id="${el.id}"` : '';
      const resourceStr = el.url ? `  Resource: ${truncUrl(el.url, 60)}` : '  (text, no resource)';
      console.log(`  LCP Element: <${el.tagName.toLowerCase()}>${idStr}${sizeStr}`);
      console.log(`  ${DIM}${resourceStr}${RESET}\n`);
    }

    const lcpMaxDur = Math.max(...lcpResult.phases.map(p => p[1]));
    const lcpBarMax = 40;
    const { color: lcpColor } = rate(vitals.lcp, 2500, 4000);

    for (const [name, dur] of lcpResult.phases) {
      const barLen = lcpMaxDur > 0 ? Math.max(0, Math.round((dur / lcpMaxDur) * lcpBarMax)) : 0;
      const isLongest = dur === lcpMaxDur && lcpColor !== 'green';
      const phaseColor = isLongest ? (lcpColor === 'red' ? RED : YELLOW) : '';
      const resetColor = phaseColor ? RESET : '';
      console.log(`  ${name.padEnd(22)} ${phaseColor}${fmtMs(dur).padStart(8)}${resetColor}  ${phaseColor}${'█'.repeat(barLen)}${resetColor}`);
    }

    if (renderMetrics && (renderMetrics.LayoutDuration > 0 || renderMetrics.RecalcStyleDuration > 0)) {
      console.log(`\n  ${DIM}Page-wide rendering cost: ${fmtMs(renderMetrics.LayoutDuration)} layout (×${renderMetrics.LayoutCount}), ${fmtMs(renderMetrics.RecalcStyleDuration)} style recalc (×${renderMetrics.RecalcStyleCount})${RESET}`);
    }
  }
  console.log();

  // -- CLS Breakdown --
  console.log(`${BOLD}── CLS Breakdown ──${RESET}\n`);

  if (!vitals.cls || vitals.cls < 0.001) {
    console.log(`  ${DIM}CLS is near-zero (${(vitals.cls ?? 0).toFixed(4)}) — no breakdown to show.${RESET}`);
  }
  else {
    const windows = buildClsSessionWindows(clsEntries);
    const totalShifts = clsEntries.filter(e => !e.hadRecentInput).length;

    if (windows.length === 0) {
      console.log(`  ${DIM}No unexpected layout shifts (all shifts had recent input).${RESET}`);
    }
    else {
      console.log(`  Total CLS: ${BOLD}${vitals.cls.toFixed(3)}${RESET} across ${windows.length} session window${windows.length === 1 ? '' : 's'}, ${totalShifts} shift${totalShifts === 1 ? '' : 's'}\n`);

      console.log(`  ${'#'.padEnd(4)} ${'CLS Value'.padStart(10)} ${'Start'.padStart(8)} ${'Shifts'.padStart(7)} ${'Worst Source'}`);
      console.log(`  ${'─'.repeat(4)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(30)}`);

      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        // Find worst source across shifts in this window
        let worstSource = '(no source)';
        let worstValue = 0;
        for (const s of w.shifts) {
          if (s.value > worstValue && s.sources && s.sources.length > 0) {
            const src = s.sources.find(src => src.selector);
            if (src) {
              worstSource = src.selector;
              worstValue = s.value;
            }
          }
        }
        const clsColor = w.value > 0.1 ? RED : w.value > 0.05 ? YELLOW : GREEN;
        console.log(
          `  ${String(i + 1).padEnd(4)} ${clsColor}${w.value.toFixed(4).padStart(10)}${RESET} ${fmtMs(w.start).padStart(8)} ${String(w.shifts.length).padStart(7)} ${worstSource}`,
        );
      }
    }
  }
  console.log();

  // -- INP Breakdown --
  console.log(`${BOLD}── INP Breakdown ──${RESET}\n`);

  if (inp < 1) {
    console.log(`  ${DIM}INP is near-zero (${fmtMs(inp)}) — no interactions captured or all were instant.${RESET}`);
  }
  else {
    const inpResult = computeInpPhases(inpEntries, longTaskDetails);
    if (!inpResult) {
      console.log(`  ${DIM}No interaction entries captured.${RESET}`);
    }
    else {
      const interaction = inpResult.interaction;
      console.log(`  Total INP: ${BOLD}${fmtMs(inp)}${RESET} (worst interaction latency, synthetic)\n`);
      console.log(`  Worst interaction: ${interaction.name}${interaction.target ? ` on <${interaction.target}>` : ''} at ${fmtMs(interaction.startTime)}\n`);

      const inpMaxDur = Math.max(...inpResult.phases.map(p => p[1]));
      const inpBarMax = 40;
      const { color: inpColor } = rate(inp, 200, 500);

      for (const [name, dur] of inpResult.phases) {
        const barLen = inpMaxDur > 0 ? Math.max(0, Math.round((dur / inpMaxDur) * inpBarMax)) : 0;
        const isLongest = dur === inpMaxDur && inpColor !== 'green';
        const phaseColor = isLongest ? (inpColor === 'red' ? RED : YELLOW) : '';
        const resetColor = phaseColor ? RESET : '';
        console.log(`  ${name.padEnd(22)} ${phaseColor}${fmtMs(dur).padStart(8)}${resetColor}  ${phaseColor}${'█'.repeat(barLen)}${resetColor}`);
      }

      if (inpResult.allInteractions.length > 1) {
        console.log(`\n  ${DIM}All interactions (${inpResult.allInteractions.length}):${RESET}`);
        console.log(`  ${'Event'.padEnd(16)} ${'Target'.padEnd(25)} ${'Duration'.padStart(10)} ${'Input'.padStart(8)} ${'Process'.padStart(8)} ${'Present'.padStart(8)}`);
        console.log(`  ${'─'.repeat(16)} ${'─'.repeat(25)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);
        for (const e of inpResult.allInteractions) {
          const { color } = rate(e.duration, 200, 500);
          const clr = ANSI_COLORS[color];
          console.log(
            `  ${e.name.padEnd(16)} ${(e.target || '(unknown)').padEnd(25)} ${clr}${fmtMs(e.duration).padStart(10)}${RESET} ${fmtMs(e.inputDelay).padStart(8)} ${fmtMs(e.processingTime).padStart(8)} ${fmtMs(e.presentationDelay).padStart(8)}`,
          );
        }
      }
    }
  }
  console.log();

  // -- TBT Breakdown --
  console.log(`${BOLD}── TBT Breakdown ──${RESET}\n`);

  if (longTaskDetails.length > 0) {
    console.log(`  Total TBT: ${fmtMs(tbt)} across ${longTaskDetails.length} long task${longTaskDetails.length === 1 ? '' : 's'}\n`);

    // Per-script table
    console.log(`  ${'Script URL'.padEnd(55)} ${'Blocking'.padStart(10)} ${'Tasks'.padStart(6)}`);
    console.log(`  ${'─'.repeat(55)} ${'─'.repeat(10)} ${'─'.repeat(6)}`);

    const hasInlineUnknown = tbtByScript.some(s => !s.scriptUrl);
    const hasInlineScript = tbtByScript.some(s => s.scriptUrl === '(inline <script>)');
    for (const s of tbtByScript) {
      const label = s.scriptUrl || '(unattributed)';
      const blockColor = s.totalBlockingTime > 100 ? RED : s.totalBlockingTime > 50 ? YELLOW : GREEN;
      console.log(
        `  ${truncUrl(label, 53).padEnd(55)} ${blockColor}${fmtMs(s.totalBlockingTime).padStart(10)}${RESET} ${String(s.count).padStart(6)}`,
      );
    }
    if (hasInlineScript || hasInlineUnknown) {
      console.log();
      if (hasInlineScript) console.log(`  ${DIM}(inline <script>) = JavaScript embedded in the HTML document${RESET}`);
      if (hasInlineUnknown) console.log(`  ${DIM}(unattributed) = framework bootstrap, hydration, or microtask queues${RESET}`);
    }
    console.log();

    // Individual long tasks
    const sorted = [...longTaskDetails].sort((a, b) => b.blockingTime - a.blockingTime);
    console.log(`  ${'Source'.padEnd(42)} ${'Start'.padStart(8)} ${'Duration'.padStart(10)} ${'Blocking'.padStart(10)}`);
    console.log(`  ${'─'.repeat(42)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

    for (const lt of sorted) {
      const label = lt.scriptUrl || lt.invoker || '(unattributed)';
      const blockColor = lt.blockingTime > 100 ? RED : lt.blockingTime > 50 ? YELLOW : GREEN;
      console.log(
        `  ${truncUrl(label, 40).padEnd(42)} ${fmtMs(lt.startTime).padStart(8)} ${fmtMs(lt.duration).padStart(10)} ${blockColor}${fmtMs(lt.blockingTime).padStart(10)}${RESET}`,
      );
    }
  }
  else {
    console.log(`  ${DIM}No long tasks detected (TBT = 0).${RESET}`);
  }
  console.log();

  // -- Resource Summary --
  console.log(`${BOLD}── Resource Summary ──${RESET}\n`);
  console.log(`  ${'Type'.padEnd(14)} ${'Count'.padStart(6)} ${'Transfer'.padStart(10)} ${'Slowest'.padStart(10)}`);
  console.log(`  ${'─'.repeat(14)} ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

  for (const [type, d] of Object.entries(resourceSummary).sort((a, b) => b[1].size - a[1].size)) {
    console.log(`  ${type.padEnd(14)} ${String(d.count).padStart(6)} ${fmtBytes(d.size).padStart(10)} ${fmtMs(d.time).padStart(10)}`);
  }
  console.log();

  // -- Memory & DOM --
  if (memoryInfo && memoryInfo.jsHeapTotal > 0) {
    console.log(`${BOLD}── Memory & DOM ──${RESET}\n`);
    const heapPct = (memoryInfo.jsHeapUsed / memoryInfo.jsHeapTotal) * 100;
    const heapColor = heapPct > 80 ? RED : heapPct > 50 ? YELLOW : GREEN;
    console.log(`  JS Heap Used      ${heapColor}${fmtBytes(memoryInfo.jsHeapUsed)} / ${fmtBytes(memoryInfo.jsHeapTotal)} (${heapPct.toFixed(1)}%)${RESET}`);
    console.log(`  DOM Nodes          ${memoryInfo.domNodeCount.toLocaleString()}`);
    console.log();
  }

  // -- JS Coverage & Execution Time --
  console.log(`${BOLD}── JS Coverage & Execution Time ──${RESET}\n`);
  const sortedCoverage = [...jsCoverage].sort((a, b) => b.unused - a.unused).slice(0, 15);

  if (sortedCoverage.length > 0) {
    console.log(`  ${'URL'.padEnd(55)} ${'Total'.padStart(8)} ${'Used'.padStart(8)} ${'Unused'.padStart(8)} ${'Unused%'.padStart(8)} ${'ExecTime'.padStart(9)}`);
    console.log(`  ${'─'.repeat(55)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(9)}`);

    for (const entry of sortedCoverage) {
      const pctColor = entry.unusedPct > 50 ? RED : entry.unusedPct > 25 ? YELLOW : GREEN;
      console.log(
        `  ${truncUrl(entry.url, 53).padEnd(55)} ${fmtBytes(entry.total).padStart(8)} ${fmtBytes(entry.used).padStart(8)} ${fmtBytes(entry.unused).padStart(8)} ${pctColor}${entry.unusedPct.toFixed(0).padStart(6)}%${RESET} ${fmtMs(entry.execTime).padStart(9)}`,
      );
    }

    const totalBytes = jsCoverage.reduce((s, e) => s + e.total, 0);
    const totalUnused = jsCoverage.reduce((s, e) => s + e.unused, 0);
    const totalExecTime = jsCoverage.reduce((s, e) => s + e.execTime, 0);
    const totalPct = totalBytes > 0 ? (totalUnused / totalBytes * 100) : 0;
    const pctColor = totalPct > 50 ? RED : totalPct > 25 ? YELLOW : GREEN;
    console.log();
    console.log(`  ${BOLD}Total unused JS: ${fmtBytes(totalUnused)} / ${fmtBytes(totalBytes)} (${pctColor}${totalPct.toFixed(1)}%${RESET}${BOLD}) · Total exec: ${fmtMs(totalExecTime)}${RESET}`);
  }
  else {
    console.log(`  ${DIM}No JS coverage data available.${RESET}`);
  }
  console.log();

  // -- Render-Blocking Resources --
  console.log(`${BOLD}── Render-Blocking Resources ──${RESET}\n`);

  if (renderBlocking.length > 0) {
    console.log(`  ${'URL'.padEnd(62)} ${'Type'.padStart(8)} ${'Transfer'.padStart(10)} ${'Duration'.padStart(10)}`);
    console.log(`  ${'─'.repeat(62)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

    for (const r of renderBlocking) {
      console.log(
        `  ${truncUrl(r.name, 60).padEnd(62)} ${(r.initiatorType || '').padStart(8)} ${fmtBytes(r.transferSize).padStart(10)} ${fmtMs(r.duration).padStart(10)}`,
      );
    }
  }
  else {
    console.log(`  ${DIM}No render-blocking resources detected.${RESET}`);
  }
  console.log();

  // -- Preload Audit --
  console.log(`${BOLD}── Preload Audit ──${RESET}\n`);

  const resourceUrls = new Set(resourceEntries.map(r => r.name));

  if (preloadLinks.length > 0) {
    for (const link of preloadLinks) {
      const wasUsed = resourceUrls.has(link.href);
      const status = wasUsed ? `${GREEN}[used]${RESET}` : `${RED}[unused]${RESET}`;
      console.log(`  ${status} ${truncUrl(link.href, 70)} ${DIM}(as=${link.as})${RESET}`);
    }
  }
  else {
    console.log(`  ${DIM}No <link rel="preload"> tags found.${RESET}`);
  }

  // Check if LCP image lacks preload
  const lcpImage = resourceEntries
    .filter(r => r.initiatorType === 'img' || r.initiatorType === 'css')
    .sort((a, b) => b.transferSize - a.transferSize)[0];

  if (lcpImage) {
    const hasPreload = preloadLinks.some(p => p.href === lcpImage.name);
    if (!hasPreload && vitals.lcp > 0) {
      console.log(`\n  ${YELLOW}⚠ Largest image resource (${truncUrl(lcpImage.name, 50)}) has no preload hint.${RESET}`);
      console.log(`  ${DIM}Consider adding: <link rel="preload" href="..." as="image">${RESET}`);
    }
  }
  console.log();

  // -- Largest Resources (Top 10) --
  console.log(`${BOLD}── Largest Resources (Top 10) ──${RESET}\n`);

  const largest = [...resourceEntries].sort((a, b) => b.transferSize - a.transferSize).slice(0, 10);

  console.log(`  ${'URL'.padEnd(62)} ${'Type'.padStart(8)} ${'Transfer'.padStart(10)} ${'Duration'.padStart(10)}`);
  console.log(`  ${'─'.repeat(62)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

  for (const r of largest) {
    console.log(
      `  ${truncUrl(r.name, 60).padEnd(62)} ${(r.initiatorType || '').padStart(8)} ${fmtBytes(r.transferSize).padStart(10)} ${fmtMs(r.duration).padStart(10)}`,
    );
  }
  console.log();

  // -- Waterfall (load order) --
  console.log(`${BOLD}── Waterfall ──${RESET}\n`);

  const criticalTypes = new Set(['link', 'css', 'script']);
  const loadOrder = [...resourceEntries]
    .filter(r => criticalTypes.has(r.initiatorType))
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, 30);
  const waterfallEnd = resourceEntries.reduce((max, r) => r.responseEnd > max ? r.responseEnd : max, 1);
  const wfBarWidth = 40;

  console.log(`  ${'Resource'.padEnd(36)} ${'Type'.padEnd(8)} ${'Start'.padStart(7)} ${'Dur'.padStart(7)}  ${''.padEnd(wfBarWidth)}`);
  console.log(`  ${'─'.repeat(36)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(7)}  ${'─'.repeat(wfBarWidth)}`);

  for (const r of loadOrder) {
    const isBlocking = r.renderBlockingStatus === 'blocking';
    const blockTag = isBlocking ? ` ${RED}[RB]${RESET}` : '';

    const phases = computeResourcePhases(r);
    let bar;
    if (phases.length > 0) {
      // Build multi-colored bar from phases
      const chars = new Array(wfBarWidth).fill(' ');
      const colors = new Array(wfBarWidth).fill('');
      for (const p of phases) {
        const pStart = Math.round((p.start / waterfallEnd) * wfBarWidth);
        const pLen = Math.max(1, Math.round((p.duration / waterfallEnd) * wfBarWidth));
        const ansi = PHASE_ANSI_COLORS[p.color] || CYAN;
        for (let i = pStart; i < Math.min(pStart + pLen, wfBarWidth); i++) {
          chars[i] = '█';
          colors[i] = ansi;
        }
      }
      bar = '';
      let currentColor = '';
      for (let i = 0; i < wfBarWidth; i++) {
        if (chars[i] === '█') {
          if (colors[i] !== currentColor) {
            bar += colors[i];
            currentColor = colors[i];
          }
          bar += '█';
        } else {
          if (currentColor !== '') {
            bar += RESET;
            currentColor = '';
          }
          bar += ' ';
        }
      }
      if (currentColor !== '') bar += RESET;
    } else {
      const barColor = isBlocking ? RED : CYAN;
      const startFrac = r.startTime / waterfallEnd;
      const endFrac = r.responseEnd / waterfallEnd;
      const barStart = Math.round(startFrac * wfBarWidth);
      const barLen = Math.max(1, Math.round((endFrac - startFrac) * wfBarWidth));
      bar = ' '.repeat(barStart) + barColor + '█'.repeat(barLen) + RESET + ' '.repeat(Math.max(0, wfBarWidth - barStart - barLen));
    }

    console.log(
      `  ${truncUrl(r.name, 34).padEnd(36)} ${(r.initiatorType || '').padEnd(8)} ${fmtMs(r.startTime).padStart(7)} ${fmtMs(r.duration).padStart(7)}  ${bar}${blockTag}`,
    );
  }
  console.log();

}
