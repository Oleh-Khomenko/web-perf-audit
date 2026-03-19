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

export function formatMetric(name, value, unit, good, poor, explanation) {
  const display = unit === 'ms' ? fmtMs(value) : (value ?? 0).toFixed(3);
  const { label, color } = rate(value, good, poor);
  const ansi = ANSI_COLORS[color];
  const nameStr = name.padEnd(28);
  const valStr = display.padStart(10);
  const ratingStr = `[${label}]`.padStart(14);
  return `  ${nameStr} ${valStr}  ${ansi}${ratingStr}${RESET}\n  ${DIM}${explanation}${RESET}\n`;
}

export function formatTiming(name, ms, explanation) {
  const nameStr = name.padEnd(28);
  const valStr = fmtMs(ms).padStart(10);
  let result = `  ${nameStr} ${valStr}\n`;
  if (explanation) result += `  ${DIM}${explanation}${RESET}\n`;
  return result;
}

export function printReport(data, meta = {}) {
  const lines = [];
  const log = (...args) => lines.push(args.join(' '));

  const { connectionInfo, nav, vitals, tbt, longTaskDetails = [], tbtByScript = [], resourceEntries, resourceSummary, jsCoverage, renderBlocking, lcpElement = null, clsEntries = [], inp = 0, inpMeasured = false, inpEntries = [], preloadLinks, serverTiming = [], fontsReady = 0, renderMetrics = null, memoryInfo = null } = data;

  // Emulation info
  if (meta.device) {
    log(`  ${DIM}Device: ${meta.device.label} (${meta.device.width}x${meta.device.height}${meta.device.mobile ? ', touch' : ''})${RESET}`);
  }
  if (meta.throttle) {
    log(`  ${YELLOW}Network: ${meta.throttle.label}${RESET} ${DIM}(latency ${meta.throttle.latency}ms, down ${meta.throttle.downloadThroughput / 1024} KB/s, up ${meta.throttle.uploadThroughput / 1024} KB/s)${RESET}`);
  }
  if (meta.cpuThrottle > 1) {
    log(`  ${YELLOW}CPU: ${meta.cpuThrottle}x slowdown${meta.calibration ? ' (calibrated)' : ''}${RESET}`);
  }
  if (meta.calibration) {
    log(`  ${DIM}Calibrated: benchmark ${meta.calibration.measuredMs}ms, reference ${meta.calibration.referenceMs}ms (${meta.calibration.deviceLabel})${RESET}`);
  }
  if (meta.device || meta.throttle || meta.cpuThrottle > 1) log('');

  // Connection info
  if (connectionInfo) {
    log(`  ${DIM}Connection: ${connectionInfo.effectiveType} | downlink: ${connectionInfo.downlink}Mbps | RTT: ${connectionInfo.rtt}ms${RESET}\n`);
  }

  // -- Navigation Timing --
  log(`${BOLD}── Navigation Timing Breakdown ──${RESET}`);
  if (nav.nextHopProtocol) {
    log(`  ${DIM}Protocol: ${nav.nextHopProtocol}${RESET}`);
  }
  log('');

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

  log(formatTiming('DNS Lookup', dns, 'Time to resolve domain name → affected by DNS provider & caching'));
  log(formatTiming('TCP Connection', tcp, 'Time to establish TCP handshake'));
  if (tls >= 0) log(formatTiming('TLS Negotiation', tls, 'Time for SSL/TLS handshake → affected by cert chain & protocol'));
  log(formatTiming('Server Response', ttfbVal, 'Time from request sent to first byte received (request → response, excludes redirects/DNS/TCP)'));
  log(formatTiming('Content Download', download, 'Time to download the HTML response body'));
  log(formatTiming('DOM Interactive', domInteractive, 'Time from response to DOM being interactive (HTML parsed)'));
  log(formatTiming('DOM Content Loaded', domContentLoaded, 'Time from response to DOMContentLoaded event (sync scripts done)'));
  log(formatTiming('DOM Complete', domComplete, 'Time from response to all subresources loaded'));
  log(formatTiming('Load Event Duration', loadEvent, 'Time spent in the load event handler'));
  log(formatTiming('Total Page Load', totalLoad, 'Full page load from navigation start to load event end'));

  // -- Performance Score --
  const overallScore = computeOverallScore({
    ttfb: nav.responseStart - nav.startTime,
    fcp: vitals.fcp,
    lcp: vitals.lcp,
    tbt: tbt,
    cls: vitals.cls,
    inp: inp,
    _inpMeasured: inpMeasured,
  });
  const scoreColor = overallScore >= 90 ? GREEN : overallScore >= 50 ? YELLOW : RED;
  log(`\n${BOLD}── Performance Score: ${scoreColor}${overallScore}/100${RESET}${BOLD} ──${RESET}\n`);

  // -- Web Vitals --
  log(`${BOLD}── Web Vitals ──${RESET}\n`);

  log(formatMetric('TTFB', nav.responseStart - nav.startTime, 'ms', 800, 1800,
    'Time to First Byte — server responsiveness. Affected by: server processing, network latency, redirects.'));
  log(formatMetric('FCP', vitals.fcp, 'ms', 1800, 3000,
    'First Contentful Paint — first text/image rendered. Affected by: render-blocking CSS/JS, font loading.'));
  log(formatMetric('LCP', vitals.lcp, 'ms', 2500, 4000,
    'Largest Contentful Paint — main content visible. Affected by: resource load time, render-blocking resources, client-side rendering.'));
  log(formatMetric('CLS', vitals.cls, 'score', 0.1, 0.25,
    'Cumulative Layout Shift — visual stability. Affected by: images without dimensions, dynamic content injection, web fonts.'));
  log(formatMetric('TBT', tbt, 'ms', 200, 600,
    'Total Blocking Time — main thread blocking after FCP. Affected by: heavy JS execution, large bundles, third-party scripts.'));
  if (inpMeasured) {
    log(formatMetric('INP', inp, 'ms', 200, 500,
      'Interaction to Next Paint — worst interaction latency (synthetic). Affected by: event handler complexity, main thread contention.'));
  } else {
    log(`  ${'INP'.padEnd(28)} ${'N/A'.padStart(10)}  ${DIM}[Not measured]${RESET}`);
    log(`  ${DIM}No interactions captured during audit.${RESET}`);
    log('');
  }

  // -- TTFB Breakdown --
  log(`${BOLD}── TTFB Breakdown ──${RESET}\n`);

  const ttfbTotal = nav.responseStart - nav.startTime;

  if (ttfbTotal < 1) {
    log(`  ${DIM}TTFB is near-zero (${fmtMs(ttfbTotal)}) — no breakdown to show.${RESET}`);
  }
  else {
    log(`  Total TTFB: ${BOLD}${fmtMs(ttfbTotal)}${RESET} (navigation start → first byte)\n`);

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
      log(`  ${name.padEnd(22)} ${phaseColor}${fmtMs(dur).padStart(8)}${resetColor}  ${phaseColor}${'█'.repeat(barLen)}${resetColor}`);
    }

    if (serverTiming.length > 0) {
      log(`\n  ${DIM}Server-Timing:${RESET}`);
      for (const st of serverTiming) {
        const label = st.description ? `${st.name} (${st.description})` : st.name;
        log(`    ${label.padEnd(20)} ${fmtMs(st.duration).padStart(8)}`);
      }
    }
  }
  log('');

  // -- FCP Breakdown --
  log(`${BOLD}── FCP Breakdown ──${RESET}\n`);

  if (vitals.fcp < 1) {
    log(`  ${DIM}FCP is near-zero (${fmtMs(vitals.fcp)}) — no breakdown to show.${RESET}`);
  }
  else {
    log(`  Total FCP: ${BOLD}${fmtMs(vitals.fcp)}${RESET} (navigation start → first contentful paint)\n`);

    const fcpPhases = computeFcpPhases(nav, vitals.fcp, resourceEntries);
    const fcpMaxDur = Math.max(...fcpPhases.map(p => p[1]));
    const fcpBarMax = 40;
    const { color: fcpColor } = rate(vitals.fcp, 1800, 3000);

    for (const [name, dur] of fcpPhases) {
      const barLen = fcpMaxDur > 0 ? Math.max(0, Math.round((dur / fcpMaxDur) * fcpBarMax)) : 0;
      const isLongest = dur === fcpMaxDur && fcpColor !== 'green';
      const phaseColor = isLongest ? (fcpColor === 'red' ? RED : YELLOW) : '';
      const resetColor = phaseColor ? RESET : '';
      log(`  ${name.padEnd(22)} ${phaseColor}${fmtMs(dur).padStart(8)}${resetColor}  ${phaseColor}${'█'.repeat(barLen)}${resetColor}`);
    }
  }
  log('');

  // -- LCP Breakdown --
  log(`${BOLD}── LCP Breakdown ──${RESET}\n`);

  if (vitals.lcpFallback) {
    log(`  ${YELLOW}LCP was not observed — using FCP (${fmtMs(vitals.fcp)}) as lower bound.${RESET}\n`);
  }

  if (vitals.lcp < 1) {
    log(`  ${DIM}LCP is near-zero (${fmtMs(vitals.lcp)}) — no breakdown to show.${RESET}`);
  }
  else {
    log(`  Total LCP: ${BOLD}${fmtMs(vitals.lcp)}${RESET} (navigation start → largest contentful paint)\n`);

    const lcpResult = computeLcpPhases(nav, vitals.lcp, lcpElement, resourceEntries, longTaskDetails, fontsReady);
    if (lcpResult.element) {
      const el = lcpResult.element;
      const sizeStr = el.size ? ` (${el.size.toLocaleString()} px²)` : '';
      const idStr = el.id ? ` id="${el.id}"` : '';
      const resourceStr = el.url ? `  Resource: ${truncUrl(el.url, 60)}` : '  (text, no resource)';
      log(`  LCP Element: <${el.tagName.toLowerCase()}>${idStr}${sizeStr}`);
      log(`  ${DIM}${resourceStr}${RESET}\n`);
    }

    const lcpMaxDur = Math.max(...lcpResult.phases.map(p => p[1]));
    const lcpBarMax = 40;
    const { color: lcpColor } = rate(vitals.lcp, 2500, 4000);

    for (const [name, dur] of lcpResult.phases) {
      const barLen = lcpMaxDur > 0 ? Math.max(0, Math.round((dur / lcpMaxDur) * lcpBarMax)) : 0;
      const isLongest = dur === lcpMaxDur && lcpColor !== 'green';
      const phaseColor = isLongest ? (lcpColor === 'red' ? RED : YELLOW) : '';
      const resetColor = phaseColor ? RESET : '';
      log(`  ${name.padEnd(22)} ${phaseColor}${fmtMs(dur).padStart(8)}${resetColor}  ${phaseColor}${'█'.repeat(barLen)}${resetColor}`);
    }

    if (renderMetrics && (renderMetrics.LayoutDuration > 0 || renderMetrics.RecalcStyleDuration > 0)) {
      log(`\n  ${DIM}Page-wide rendering cost: ${fmtMs(renderMetrics.LayoutDuration)} layout (×${renderMetrics.LayoutCount}), ${fmtMs(renderMetrics.RecalcStyleDuration)} style recalc (×${renderMetrics.RecalcStyleCount})${RESET}`);
    }
  }
  log('');

  // -- CLS Breakdown --
  log(`${BOLD}── CLS Breakdown ──${RESET}\n`);

  if (!vitals.cls || vitals.cls < 0.001) {
    log(`  ${DIM}CLS is near-zero (${(vitals.cls ?? 0).toFixed(4)}) — no breakdown to show.${RESET}`);
  }
  else {
    const windows = buildClsSessionWindows(clsEntries);
    const totalShifts = clsEntries.filter(e => !e.hadRecentInput).length;

    if (windows.length === 0) {
      log(`  ${DIM}No unexpected layout shifts (all shifts had recent input).${RESET}`);
    }
    else {
      log(`  Total CLS: ${BOLD}${vitals.cls.toFixed(3)}${RESET} across ${windows.length} session window${windows.length === 1 ? '' : 's'}, ${totalShifts} shift${totalShifts === 1 ? '' : 's'}\n`);

      log(`  ${'#'.padEnd(4)} ${'CLS Value'.padStart(10)} ${'Start'.padStart(8)} ${'Shifts'.padStart(7)} ${'Worst Source'}`);
      log(`  ${'─'.repeat(4)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(30)}`);

      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
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
        const { color: clsRating } = rate(w.value, 0.05, 0.1);
        const clsColor = ANSI_COLORS[clsRating];
        log(
          `  ${String(i + 1).padEnd(4)} ${clsColor}${w.value.toFixed(4).padStart(10)}${RESET} ${fmtMs(w.start).padStart(8)} ${String(w.shifts.length).padStart(7)} ${worstSource}`,
        );
      }
    }
  }
  log('');

  // -- INP Breakdown --
  log(`${BOLD}── INP Breakdown ──${RESET}\n`);

  if (!inpMeasured) {
    log(`  ${DIM}No interactions captured — INP could not be measured.${RESET}`);
  }
  else {
    const inpResult = computeInpPhases(inpEntries, longTaskDetails);
    if (!inpResult) {
      log(`  ${DIM}No interaction entries captured.${RESET}`);
    }
    else {
      const interaction = inpResult.interaction;
      log(`  Total INP: ${BOLD}${fmtMs(inp)}${RESET} (worst interaction latency, synthetic)\n`);
      log(`  Worst interaction: ${interaction.name}${interaction.target ? ` on <${interaction.target}>` : ''} at ${fmtMs(interaction.startTime)}\n`);

      const inpMaxDur = Math.max(...inpResult.phases.map(p => p[1]));
      const inpBarMax = 40;
      const { color: inpColor } = rate(inp, 200, 500);

      for (const [name, dur] of inpResult.phases) {
        const barLen = inpMaxDur > 0 ? Math.max(0, Math.round((dur / inpMaxDur) * inpBarMax)) : 0;
        const isLongest = dur === inpMaxDur && inpColor !== 'green';
        const phaseColor = isLongest ? (inpColor === 'red' ? RED : YELLOW) : '';
        const resetColor = phaseColor ? RESET : '';
        log(`  ${name.padEnd(22)} ${phaseColor}${fmtMs(dur).padStart(8)}${resetColor}  ${phaseColor}${'█'.repeat(barLen)}${resetColor}`);
      }

      if (inpResult.allInteractions.length > 1) {
        log(`\n  ${DIM}All interactions (${inpResult.allInteractions.length}):${RESET}`);
        log(`  ${'Event'.padEnd(16)} ${'Target'.padEnd(25)} ${'Duration'.padStart(10)} ${'Input'.padStart(8)} ${'Process'.padStart(8)} ${'Present'.padStart(8)}`);
        log(`  ${'─'.repeat(16)} ${'─'.repeat(25)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)}`);
        for (const e of inpResult.allInteractions) {
          const { color } = rate(e.duration, 200, 500);
          const clr = ANSI_COLORS[color];
          log(
            `  ${e.name.padEnd(16)} ${(e.target || '(unknown)').padEnd(25)} ${clr}${fmtMs(e.duration).padStart(10)}${RESET} ${fmtMs(e.inputDelay).padStart(8)} ${fmtMs(e.processingTime).padStart(8)} ${fmtMs(e.presentationDelay).padStart(8)}`,
          );
        }
      }
    }
  }
  log('');

  // -- TBT Breakdown --
  log(`${BOLD}── TBT Breakdown ──${RESET}\n`);

  if (longTaskDetails.length > 0) {
    log(`  Total TBT: ${fmtMs(tbt)} across ${longTaskDetails.length} long task${longTaskDetails.length === 1 ? '' : 's'}\n`);

    log(`  ${'Script URL'.padEnd(55)} ${'Blocking'.padStart(10)} ${'Tasks'.padStart(6)}`);
    log(`  ${'─'.repeat(55)} ${'─'.repeat(10)} ${'─'.repeat(6)}`);

    const hasInlineUnknown = tbtByScript.some(s => !s.scriptUrl);
    const hasInlineScript = tbtByScript.some(s => s.scriptUrl === '(inline <script>)');
    for (const s of tbtByScript) {
      const label = s.scriptUrl || '(unattributed)';
      const blockColor = s.totalBlockingTime > 100 ? RED : s.totalBlockingTime > 50 ? YELLOW : GREEN;
      log(
        `  ${truncUrl(label, 53).padEnd(55)} ${blockColor}${fmtMs(s.totalBlockingTime).padStart(10)}${RESET} ${String(s.count).padStart(6)}`,
      );
    }
    if (hasInlineScript || hasInlineUnknown) {
      log('');
      if (hasInlineScript) log(`  ${DIM}(inline <script>) = JavaScript embedded in the HTML document${RESET}`);
      if (hasInlineUnknown) log(`  ${DIM}(unattributed) = framework bootstrap, hydration, or microtask queues${RESET}`);
    }
    log('');

    const sorted = [...longTaskDetails].sort((a, b) => b.blockingTime - a.blockingTime);
    log(`  ${'Source'.padEnd(42)} ${'Start'.padStart(8)} ${'Duration'.padStart(10)} ${'Blocking'.padStart(10)}`);
    log(`  ${'─'.repeat(42)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

    for (const lt of sorted) {
      const label = lt.scriptUrl || lt.invoker || '(unattributed)';
      const blockColor = lt.blockingTime > 100 ? RED : lt.blockingTime > 50 ? YELLOW : GREEN;
      log(
        `  ${truncUrl(label, 40).padEnd(42)} ${fmtMs(lt.startTime).padStart(8)} ${fmtMs(lt.duration).padStart(10)} ${blockColor}${fmtMs(lt.blockingTime).padStart(10)}${RESET}`,
      );
    }
  }
  else {
    log(`  ${DIM}No long tasks detected (TBT = 0).${RESET}`);
  }
  log('');

  // -- Resource Summary --
  log(`${BOLD}── Resource Summary ──${RESET}\n`);
  log(`  ${'Type'.padEnd(14)} ${'Count'.padStart(6)} ${'Transfer'.padStart(10)} ${'Slowest'.padStart(10)}`);
  log(`  ${'─'.repeat(14)} ${'─'.repeat(6)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

  for (const [type, d] of Object.entries(resourceSummary).sort((a, b) => b[1].size - a[1].size)) {
    log(`  ${type.padEnd(14)} ${String(d.count).padStart(6)} ${fmtBytes(d.size).padStart(10)} ${fmtMs(d.time).padStart(10)}`);
  }
  log('');

  // -- Memory & DOM --
  if (memoryInfo && memoryInfo.jsHeapTotal > 0) {
    log(`${BOLD}── Memory & DOM ──${RESET}\n`);
    const heapPct = (memoryInfo.jsHeapUsed / memoryInfo.jsHeapTotal) * 100;
    const heapColor = heapPct > 80 ? RED : heapPct > 50 ? YELLOW : GREEN;
    log(`  JS Heap Used      ${heapColor}${fmtBytes(memoryInfo.jsHeapUsed)} / ${fmtBytes(memoryInfo.jsHeapTotal)} (${heapPct.toFixed(1)}%)${RESET}`);
    log(`  DOM Nodes          ${memoryInfo.domNodeCount.toLocaleString()}`);
    log('');
  }

  // -- JS Coverage & Execution Time --
  log(`${BOLD}── JS Coverage & Execution Time ──${RESET}\n`);
  const sortedCoverage = [...jsCoverage].sort((a, b) => b.unused - a.unused).slice(0, 15);

  if (sortedCoverage.length > 0) {
    log(`  ${'URL'.padEnd(55)} ${'Total'.padStart(8)} ${'Used'.padStart(8)} ${'Unused'.padStart(8)} ${'Unused%'.padStart(8)} ${'ExecTime'.padStart(9)}`);
    log(`  ${'─'.repeat(55)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${'─'.repeat(9)}`);

    for (const entry of sortedCoverage) {
      const pctColor = entry.unusedPct > 50 ? RED : entry.unusedPct > 25 ? YELLOW : GREEN;
      log(
        `  ${truncUrl(entry.url, 53).padEnd(55)} ${fmtBytes(entry.total).padStart(8)} ${fmtBytes(entry.used).padStart(8)} ${fmtBytes(entry.unused).padStart(8)} ${pctColor}${entry.unusedPct.toFixed(0).padStart(6)}%${RESET} ${fmtMs(entry.execTime).padStart(9)}`,
      );
    }

    const totalBytes = jsCoverage.reduce((s, e) => s + e.total, 0);
    const totalUnused = jsCoverage.reduce((s, e) => s + e.unused, 0);
    const totalExecTime = jsCoverage.reduce((s, e) => s + e.execTime, 0);
    const totalPct = totalBytes > 0 ? (totalUnused / totalBytes * 100) : 0;
    const pctColor = totalPct > 50 ? RED : totalPct > 25 ? YELLOW : GREEN;
    log('');
    log(`  ${BOLD}Total unused JS: ${fmtBytes(totalUnused)} / ${fmtBytes(totalBytes)} (${pctColor}${totalPct.toFixed(1)}%${RESET}${BOLD}) · Total exec: ${fmtMs(totalExecTime)}${RESET}`);
  }
  else {
    log(`  ${DIM}No JS coverage data available.${RESET}`);
  }
  log('');

  // -- Render-Blocking Resources --
  log(`${BOLD}── Render-Blocking Resources ──${RESET}\n`);

  if (renderBlocking.length > 0) {
    log(`  ${'URL'.padEnd(62)} ${'Type'.padStart(8)} ${'Transfer'.padStart(10)} ${'Duration'.padStart(10)}`);
    log(`  ${'─'.repeat(62)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

    for (const r of renderBlocking) {
      log(
        `  ${truncUrl(r.name, 60).padEnd(62)} ${(r.initiatorType || '').padStart(8)} ${fmtBytes(r.transferSize).padStart(10)} ${fmtMs(r.duration).padStart(10)}`,
      );
    }
  }
  else {
    log(`  ${DIM}No render-blocking resources detected.${RESET}`);
  }
  log('');

  // -- Preload Audit --
  log(`${BOLD}── Preload Audit ──${RESET}\n`);

  const resourceUrls = new Set(resourceEntries.map(r => r.name));

  if (preloadLinks.length > 0) {
    for (const link of preloadLinks) {
      const wasUsed = resourceUrls.has(link.href);
      const status = wasUsed ? `${GREEN}[used]${RESET}` : `${RED}[unused]${RESET}`;
      log(`  ${status} ${truncUrl(link.href, 70)} ${DIM}(as=${link.as})${RESET}`);
    }
  }
  else {
    log(`  ${DIM}No <link rel="preload"> tags found.${RESET}`);
  }

  const lcpImage = resourceEntries
    .filter(r => r.initiatorType === 'img' || r.initiatorType === 'css')
    .sort((a, b) => b.transferSize - a.transferSize)[0];

  if (lcpImage) {
    const hasPreload = preloadLinks.some(p => p.href === lcpImage.name);
    if (!hasPreload && vitals.lcp > 0) {
      log(`\n  ${YELLOW}⚠ Largest image resource (${truncUrl(lcpImage.name, 50)}) has no preload hint.${RESET}`);
      log(`  ${DIM}Consider adding: <link rel="preload" href="..." as="image">${RESET}`);
    }
  }
  log('');

  // -- Largest Resources (Top 10) --
  log(`${BOLD}── Largest Resources (Top 10) ──${RESET}\n`);

  const largest = [...resourceEntries].sort((a, b) => b.transferSize - a.transferSize).slice(0, 10);

  log(`  ${'URL'.padEnd(62)} ${'Type'.padStart(8)} ${'Transfer'.padStart(10)} ${'Duration'.padStart(10)}`);
  log(`  ${'─'.repeat(62)} ${'─'.repeat(8)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

  for (const r of largest) {
    log(
      `  ${truncUrl(r.name, 60).padEnd(62)} ${(r.initiatorType || '').padStart(8)} ${fmtBytes(r.transferSize).padStart(10)} ${fmtMs(r.duration).padStart(10)}`,
    );
  }
  log('');

  // -- Waterfall (load order) --
  log(`${BOLD}── Waterfall ──${RESET}\n`);

  const criticalTypes = new Set(['link', 'css', 'script']);
  const loadOrder = [...resourceEntries]
    .filter(r => criticalTypes.has(r.initiatorType))
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, 30);
  const waterfallEnd = loadOrder.reduce((max, r) => r.responseEnd > max ? r.responseEnd : max, 1);
  const wfBarWidth = 40;

  log(`  ${'Resource'.padEnd(36)} ${'Type'.padEnd(8)} ${'Start'.padStart(7)} ${'Dur'.padStart(7)}  ${''.padEnd(wfBarWidth)}`);
  log(`  ${'─'.repeat(36)} ${'─'.repeat(8)} ${'─'.repeat(7)} ${'─'.repeat(7)}  ${'─'.repeat(wfBarWidth)}`);

  for (const r of loadOrder) {
    const isBlocking = r.renderBlockingStatus === 'blocking';
    const blockTag = isBlocking ? ` ${RED}[RB]${RESET}` : '';

    const phases = computeResourcePhases(r);
    let bar;
    if (phases.length > 0) {
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

    log(
      `  ${truncUrl(r.name, 34).padEnd(36)} ${(r.initiatorType || '').padEnd(8)} ${fmtMs(r.startTime).padStart(7)} ${fmtMs(r.duration).padStart(7)}  ${bar}${blockTag}`,
    );
  }
  log('');

  const output = lines.join('\n');
  console.log(output);
  return output;
}
