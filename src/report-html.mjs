/**
 * HTML report generation — self-contained HTML with inline CSS.
 */

import { fmtMs, fmtBytes, truncUrl, rate, computeScore, computeOverallScore, METRIC_SCORING, computeFcpPhases, computeLcpPhases, buildClsSessionWindows, computeInpPhases, computeResourcePhases } from './format.mjs';

const CSS_COLORS = { green: '#16a34a', yellow: '#ca8a04', red: '#dc2626' };

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PHASE_DESCRIPTIONS = {
  // TTFB phases
  'Redirect': 'Time spent following HTTP redirects (3xx) before the final request begins.',
  'Unload': 'Time for the browser to unload the previous page before starting the fetch.',
  'Service Worker': 'Time spent in the Service Worker processing the request (if registered).',
  'Queue / Stale Check': 'Time between fetchStart and DNS lookup — includes HTTP cache checks and connection queueing.',
  'DNS Lookup': 'Time to resolve the domain name to an IP address via DNS.',
  'TCP Connection': 'Time to establish the TCP connection (SYN → SYN-ACK → ACK handshake).',
  'TLS Negotiation': 'Time for the TLS/SSL handshake after the TCP connection is established.',
  'Request → Response': 'Time from sending the HTTP request to receiving the first byte of the response (server processing time).',
  'Server Response (TTFB)': 'Time from sending the HTTP request to receiving the first byte of the response.',
  'Content Download': 'Time to download the full HTML response body after the first byte arrives.',
  'DOM Interactive': 'Time from response end until the DOM is fully parsed and interactive (scripts have executed).',
  'DOM Content Loaded': 'Time from response end until DOMContentLoaded fires — DOM is ready, deferred scripts have run.',
  'DOM Complete': 'Time from response end until all sub-resources (images, stylesheets, etc.) have finished loading.',
  'Load Event Duration': 'Time spent executing load event handlers (window.onload callbacks).',
  'Total Page Load': 'Total time from navigation start to the load event completing.',
  'Other': 'Unaccounted time gap between measured phases.',
  // FCP phases
  'TTFB': 'Time to First Byte — time until the browser receives the first byte of the HTML response.',
  'Blocking Resources': 'Time spent waiting for render-blocking CSS and synchronous JS to download and execute before painting can start.',
  'HTML Parse': 'Time for the browser to parse the HTML document and build the DOM tree.',
  'Style & Font Load': 'Time waiting for stylesheets and web fonts needed for the first contentful paint.',
  'Render Setup': 'Time for style calculation, layout, and compositing before the first pixels are painted.',
  // LCP phases
  'LCP Resource Delay': 'Time between TTFB and the browser starting to fetch the LCP resource (e.g. image). Indicates discovery delay — consider preloading.',
  'LCP Resource Download': 'Time to download the LCP resource (image, video, etc.). Optimize file size or use a CDN.',
  'DOM Wait': 'Time waiting for DOM construction before the LCP element can be rendered.',
  'Stylesheet Wait': 'Time waiting for critical stylesheets that block rendering of the LCP element.',
  'Font Wait': 'Time waiting for web fonts required to render the LCP text element.',
  'Long Tasks (JS)': 'Time the main thread was blocked by long JavaScript tasks, delaying LCP rendering.',
  'Render Work': 'Time for style recalculation, layout, and paint needed to render the LCP element.',
  'Element Render Delay': 'Time between resource load completion and the element actually being rendered — may indicate lazy loading, JS-driven insertion, or render-blocking work.',
  // INP phases
  'Input Delay': 'Time between the user interaction and the browser starting to run event handlers — caused by main thread being busy with other tasks.',
  'Processing Time': 'Time spent executing the event handler JavaScript code.',
  'Presentation Delay': 'Time from event handler completion to the next frame being painted on screen.',
  'Pre-render': 'Time between event handler completion and the start of the rendering pipeline.',
  'rAF & Observers': 'Time spent in requestAnimationFrame callbacks and other observer callbacks before rendering.',
  'Style, Layout & Paint': 'Time the browser spends recalculating styles, computing layout, and painting pixels to screen.',
};

function phaseLabel(name) {
  const desc = PHASE_DESCRIPTIONS[name];
  if (!desc) return escHtml(name);
  return `${escHtml(name)} <span class="info-icon" tabindex="0">i<span class="info-tip">${escHtml(desc)}</span></span>`;
}

function urlWithTooltip(url, maxLen) {
  const truncated = truncUrl(url, maxLen);
  const full = escHtml(url);
  if (truncated === url) return full;
  return `${escHtml(truncated)}<span class="tooltip">${full}</span>`;
}

/**
 * @param {object} data - Single audit run data
 * @param {object} meta - { url, date, numRuns, medianVitals, allResults }
 * @returns {string} Full HTML document string
 */
export function generateHtml(data, meta) {
  const { connectionInfo, nav, vitals, tbt, longTaskDetails = [], tbtByScript = [], resourceEntries, resourceSummary, jsCoverage, renderBlocking, lcpElement = null, clsEntries = [], inp = 0, inpEntries = [], preloadLinks, serverTiming = [], fontsReady = 0, renderMetrics = null, memoryInfo = null } = data;

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

  const timings = [
    ['DNS Lookup', dns],
    ['TCP Connection', tcp],
    ...(tls >= 0 ? [['TLS Negotiation', tls]] : []),
    ['Server Response (TTFB)', ttfbVal],
    ['Content Download', download],
    ['DOM Interactive', domInteractive],
    ['DOM Content Loaded', domContentLoaded],
    ['DOM Complete', domComplete],
    ['Load Event Duration', loadEvent],
    ['Total Page Load', totalLoad],
  ];

  const metricValues = {
    ttfb: nav.responseStart - nav.startTime,
    fcp: vitals.fcp,
    lcp: vitals.lcp,
    tbt: tbt,
    cls: vitals.cls,
    inp: inp,
  };

  const overallScore = computeOverallScore(metricValues);

  const vitalCards = METRIC_SCORING.map(m => ({
    name: m.name,
    value: metricValues[m.key],
    unit: m.key === 'cls' ? 'score' : 'ms',
    good: m.good,
    poor: m.poor,
    p10: m.p10,
    median: m.median,
    weight: m.weight,
    score: Math.round(computeScore(metricValues[m.key], m.p10, m.median) * 100),
  }));

  const sortedCoverage = [...jsCoverage].sort((a, b) => b.unused - a.unused).slice(0, 15);
  const totalJsBytes = jsCoverage.reduce((s, e) => s + e.total, 0);
  const totalJsUnused = jsCoverage.reduce((s, e) => s + e.unused, 0);
  const totalJsPct = totalJsBytes > 0 ? (totalJsUnused / totalJsBytes * 100) : 0;

  const largest = [...resourceEntries].sort((a, b) => b.transferSize - a.transferSize).slice(0, 10);
  const timelineEnd = resourceEntries.reduce((max, r) => r.responseEnd > max ? r.responseEnd : max, 1);
  const resourceUrls = new Set(resourceEntries.map(r => r.name));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Performance Audit — ${escHtml(meta.url)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.5; padding: 2rem; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .meta { color: #64748b; font-size: 0.875rem; margin-bottom: 2rem; }
  h2 { font-size: 1.125rem; margin: 2rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 2px solid #e2e8f0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; margin-bottom: 1rem; }
  th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #e2e8f0; }
  th { background: #f1f5f9; font-weight: 600; white-space: nowrap; }
  td { font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace; font-size: 0.8125rem; }
  .r { text-align: right; }
  .cards { display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
  .card { flex: 1; min-width: 150px; border-radius: 8px; padding: 1rem; background: #fff; border: 1px solid #e2e8f0; }
  .card-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 0.25rem; }
  .card-value { font-size: 1.5rem; font-weight: 700; font-family: 'SF Mono', 'Cascadia Code', monospace; }
  .card-rating { font-size: 0.75rem; font-weight: 600; margin-top: 0.25rem; }
  .bar-container { background: #e2e8f0; border-radius: 4px; height: 8px; width: 100%; position: relative; }
  .bar-fill { border-radius: 4px; height: 100%; position: absolute; left: 0; top: 0; }
  .waterfall-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; margin-bottom: 2px; }
  .waterfall-label { flex: 0 0 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; position: relative; cursor: default; }
  .waterfall-label:hover { overflow: visible; }
  .waterfall-label .tooltip { display: none; position: absolute; left: 0; top: 100%; z-index: 10; background: #1e293b; color: #f1f5f9; font-size: 0.75rem; padding: 0.375rem 0.5rem; border-radius: 4px; white-space: normal; word-break: break-all; max-width: 600px; min-width: 200px; box-shadow: 0 4px 12px rgba(0,0,0,.15); pointer-events: none; }
  .waterfall-label:hover .tooltip { display: block; }
  .waterfall-times { flex: 0 0 180px; text-align: right; font-family: monospace; color: #64748b; white-space: nowrap; }
  .waterfall-legend { display: flex; gap: 1rem; font-size: 0.75rem; color: #64748b; margin-bottom: 0.5rem; }
  .waterfall-legend span { display: inline-flex; align-items: center; gap: 0.3rem; }
  .waterfall-legend-dot { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .waterfall-track { flex: 1; height: 16px; background: #f1f5f9; border-radius: 3px; position: relative; }
  .waterfall-bar { position: absolute; height: 100%; background: #3b82f6; border-radius: 3px; min-width: 2px; }
  .waterfall-seg { position: absolute; height: 100%; min-width: 1px; }
  .waterfall-seg:first-child { border-radius: 3px 0 0 3px; }
  .waterfall-seg:last-child { border-radius: 0 3px 3px 0; }
  .waterfall-seg:only-child { border-radius: 3px; }
  .tag-good { color: #16a34a; }
  .tag-warn { color: #ca8a04; }
  .tag-poor { color: #dc2626; }
  .dim { color: #94a3b8; }
  .mono { font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace; }
  .url-cell { max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; position: relative; cursor: default; }
  .url-cell:hover { overflow: visible; }
  .url-cell .tooltip { display: none; position: absolute; left: 0; top: 100%; z-index: 10; background: #1e293b; color: #f1f5f9; font-size: 0.75rem; padding: 0.375rem 0.5rem; border-radius: 4px; white-space: normal; word-break: break-all; max-width: 600px; min-width: 200px; box-shadow: 0 4px 12px rgba(0,0,0,.15); pointer-events: none; }
  .url-cell:hover .tooltip { display: block; }
  .summary-stat { font-weight: 600; margin-top: 0.5rem; }
  .gauge-wrap { display: flex; align-items: center; gap: 2rem; margin-bottom: 1.5rem; }
  .gauge { position: relative; width: 120px; height: 120px; }
  .gauge svg { transform: rotate(-90deg); }
  .gauge-score { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 2rem; font-weight: 800; font-family: 'SF Mono', 'Cascadia Code', monospace; }
  .gauge-legend { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8125rem; }
  .gauge-legend span { display: inline-flex; align-items: center; gap: 0.4rem; }
  .gauge-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .score-badge { display: inline-block; font-size: 0.6875rem; font-weight: 700; padding: 0.125rem 0.375rem; border-radius: 4px; margin-left: 0.25rem; }
  .score-badge-green { background: #dcfce7; color: #16a34a; }
  .score-badge-yellow { background: #fef9c3; color: #ca8a04; }
  .score-badge-red { background: #fee2e2; color: #dc2626; }
  .info-icon { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; background: #e2e8f0; color: #64748b; font-size: 0.625rem; font-weight: 700; font-style: italic; font-family: Georgia, serif; cursor: help; position: relative; vertical-align: middle; margin-left: 0.25rem; flex-shrink: 0; }
  .info-icon:hover .info-tip, .info-icon:focus .info-tip { display: block; }
  .info-tip { display: none; position: absolute; left: calc(100% + 6px); top: 50%; transform: translateY(-50%); z-index: 20; background: #1e293b; color: #f1f5f9; font-size: 0.75rem; font-weight: 400; font-style: normal; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 0.5rem 0.75rem; border-radius: 6px; white-space: normal; width: 280px; line-height: 1.4; box-shadow: 0 4px 12px rgba(0,0,0,.2); pointer-events: none; }
  @media (max-width: 640px) { body { padding: 1rem; } .cards { flex-direction: column; } .waterfall-label { flex: 0 0 160px; } .gauge-wrap { flex-direction: column; align-items: flex-start; } }
</style>
</head>
<body>
<h1>Performance Audit</h1>
<p class="meta">
  ${escHtml(meta.url)}<br>
  ${escHtml(meta.date)}${meta.device ? ` · ${escHtml(meta.device.label)} (${meta.device.width}x${meta.device.height})` : ''}${meta.throttle ? ` · ${escHtml(meta.throttle.label)}` : ''}${meta.cpuThrottle > 1 ? ` · CPU ${meta.cpuThrottle}x` : ''}${meta.numRuns > 1 ? ` · ${meta.numRuns} runs (median)` : ''}${connectionInfo ? ` · ${escHtml(connectionInfo.effectiveType)} · ${escHtml(connectionInfo.downlink)}Mbps · RTT ${escHtml(connectionInfo.rtt)}ms` : ''}
</p>

<h2>Performance Score</h2>
${(() => {
    const scoreColor = overallScore >= 90 ? CSS_COLORS.green : overallScore >= 50 ? CSS_COLORS.yellow : CSS_COLORS.red;
    const r = 52; const circ = 2 * Math.PI * r;
    const dashOffset = circ * (1 - overallScore / 100);
    return `<div class="gauge-wrap">
  <div class="gauge">
    <svg width="120" height="120" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="8"/>
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="${scoreColor}" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${dashOffset.toFixed(1)}"/>
    </svg>
    <div class="gauge-score" style="color:${scoreColor}">${overallScore}</div>
  </div>
  <div class="gauge-legend">
    <span><span class="gauge-dot" style="background:${CSS_COLORS.green}"></span> 90–100 Good</span>
    <span><span class="gauge-dot" style="background:${CSS_COLORS.yellow}"></span> 50–89 Needs work</span>
    <span><span class="gauge-dot" style="background:${CSS_COLORS.red}"></span> 0–49 Poor</span>
  </div>
</div>`;
  })()}

<h2>Web Vitals</h2>
<div class="cards">
${vitalCards.map(v => {
    const { label, color } = rate(v.value, v.good, v.poor);
    const display = v.unit === 'ms' ? fmtMs(v.value) : (v.value ?? 0).toFixed(3);
    const tagClass = color === 'green' ? 'tag-good' : color === 'yellow' ? 'tag-warn' : 'tag-poor';
    const badgeClass = `score-badge-${color}`;
    return `  <div class="card">
    <div class="card-label">${v.name} <span class="score-badge ${badgeClass}">${v.score}</span></div>
    <div class="card-value" style="color:${CSS_COLORS[color]}">${display}</div>
    <div class="card-rating ${tagClass}">${label} · ${Math.round(v.weight * 100)}% weight</div>
  </div>`;
  }).join('\n')}
</div>

<h2>TTFB Breakdown</h2>
${(() => {
    const ttfbTotal = nav.responseStart - nav.startTime;
    if (ttfbTotal < 1) {
      return '<p class="dim">TTFB is near-zero — no breakdown to show.</p>';
    }

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

    const { color: ttfbRatingColor } = rate(ttfbTotal, 800, 1800);

    const segColors = { 'Redirect': '#94a3b8', 'Unload': '#a1a1aa', 'Service Worker': '#e879f9', 'Queue / Stale Check': '#fb923c', 'DNS Lookup': '#8b5cf6', 'TCP Connection': '#3b82f6', 'TLS Negotiation': '#06b6d4', 'Request → Response': '#f59e0b', 'Other': '#64748b' };

    // Stacked bar — use exact percentages, last segment absorbs rounding remainder
    const stackedSegments = (() => {
      let usedPct = 0;
      return phases.map(([name, dur], i) => {
        const isLast = i === phases.length - 1;
        const exactPct = ttfbTotal > 0 ? (dur / ttfbTotal * 100) : 0;
        const pct = isLast ? Math.max(0, 100 - usedPct) : exactPct;
        usedPct += exactPct;
        const bg = segColors[name] || '#94a3b8';
        return pct > 0 ? `<div style="width:${pct}%;background:${bg};height:100%;display:inline-block" title="${escHtml(name)}: ${fmtMs(dur)} (${exactPct.toFixed(1)}%)"></div>` : '';
      }).join('');
    })();

    const legend = phases.map(([name]) => {
      return `<span><span class="waterfall-legend-dot" style="background:${segColors[name] || '#94a3b8'}"></span> ${escHtml(name)}</span>`;
    }).join(' ');

    const rows = phases.map(([name, dur]) => {
      const share = ttfbTotal > 0 ? (dur / ttfbTotal * 100) : 0;
      const isHighlight = share > 50 && ttfbRatingColor !== 'green';
      const cellColor = isHighlight ? CSS_COLORS[ttfbRatingColor] : '';
      const styleAttr = cellColor ? ` style="color:${cellColor}"` : '';
      return `    <tr>
      <td>${phaseLabel(name)}</td>
      <td class="r"${styleAttr}>${fmtMs(dur)}</td>
      <td class="r">${share.toFixed(1)}%</td>
      <td><div class="bar-container"><div class="bar-fill" style="width:${share.toFixed(1)}%;background:${cellColor || '#3b82f6'}"></div></div></td>
    </tr>`;
    }).join('\n');

    const serverTimingHtml = serverTiming.length > 0 ? `
<details style="margin-top:0.75rem">
  <summary style="cursor:pointer;font-size:0.875rem;color:#64748b">Server-Timing headers (${serverTiming.length})</summary>
  <table style="margin-top:0.5rem">
    <thead><tr><th>Name</th><th>Description</th><th class="r">Duration</th></tr></thead>
    <tbody>
${serverTiming.map(st => `      <tr><td class="mono">${escHtml(st.name)}</td><td>${escHtml(st.description || '')}</td><td class="r">${fmtMs(st.duration)}</td></tr>`).join('\n')}
    </tbody>
  </table>
</details>` : '';

    return `<p>Total TTFB: <strong style="color:${CSS_COLORS[ttfbRatingColor]}">${fmtMs(ttfbTotal)}</strong> (navigation start → first byte)</p>
<div class="waterfall-legend" style="margin-top:0.75rem">${legend}</div>
<div style="background:#e2e8f0;border-radius:6px;height:20px;overflow:hidden;margin-bottom:1rem;font-size:0;line-height:0;white-space:nowrap">${stackedSegments}</div>
<table>
  <thead><tr><th>Phase</th><th class="r">Duration</th><th class="r">Share</th><th style="width:120px"></th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>${serverTimingHtml}`;
  })()}

<h2>FCP Breakdown</h2>
${(() => {
    if (vitals.fcp < 1) {
      return '<p class="dim">FCP is near-zero — no breakdown to show.</p>';
    }

    const fcpPhases = computeFcpPhases(nav, vitals.fcp, resourceEntries);
    const { color: fcpRatingColor } = rate(vitals.fcp, 1800, 3000);

    const segColors = { 'TTFB': '#8b5cf6', 'Blocking Resources': '#dc2626', 'HTML Parse': '#3b82f6', 'Style & Font Load': '#06b6d4', 'Render Setup': '#f59e0b' };

    const stackedSegments = (() => {
      let usedPct = 0;
      return fcpPhases.map(([name, dur], i) => {
        const isLast = i === fcpPhases.length - 1;
        const exactPct = vitals.fcp > 0 ? (dur / vitals.fcp * 100) : 0;
        const pct = isLast ? Math.max(0, 100 - usedPct) : exactPct;
        usedPct += exactPct;
        const bg = segColors[name] || '#94a3b8';
        return pct > 0 ? `<div style="width:${pct}%;background:${bg};height:100%;display:inline-block" title="${escHtml(name)}: ${fmtMs(dur)} (${exactPct.toFixed(1)}%)"></div>` : '';
      }).join('');
    })();

    const legend = fcpPhases.map(([name]) => {
      return `<span><span class="waterfall-legend-dot" style="background:${segColors[name] || '#94a3b8'}"></span> ${escHtml(name)}</span>`;
    }).join(' ');

    const rows = fcpPhases.map(([name, dur]) => {
      const share = vitals.fcp > 0 ? (dur / vitals.fcp * 100) : 0;
      const isHighlight = share > 50 && fcpRatingColor !== 'green';
      const cellColor = isHighlight ? CSS_COLORS[fcpRatingColor] : '';
      const styleAttr = cellColor ? ` style="color:${cellColor}"` : '';
      return `    <tr>
      <td>${phaseLabel(name)}</td>
      <td class="r"${styleAttr}>${fmtMs(dur)}</td>
      <td class="r">${share.toFixed(1)}%</td>
      <td><div class="bar-container"><div class="bar-fill" style="width:${share.toFixed(1)}%;background:${cellColor || '#3b82f6'}"></div></div></td>
    </tr>`;
    }).join('\n');

    return `<p>Total FCP: <strong style="color:${CSS_COLORS[fcpRatingColor]}">${fmtMs(vitals.fcp)}</strong> (navigation start → first contentful paint)</p>
<div class="waterfall-legend" style="margin-top:0.75rem">${legend}</div>
<div style="background:#e2e8f0;border-radius:6px;height:20px;overflow:hidden;margin-bottom:1rem;font-size:0;line-height:0;white-space:nowrap">${stackedSegments}</div>
<table>
  <thead><tr><th>Phase</th><th class="r">Duration</th><th class="r">Share</th><th style="width:120px"></th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
  })()}

<h2>LCP Breakdown</h2>
${(() => {
    if (vitals.lcp < 1) {
      return '<p class="dim">LCP is near-zero — no breakdown to show.</p>';
    }

    const lcpResult = computeLcpPhases(nav, vitals.lcp, lcpElement, resourceEntries, longTaskDetails, fontsReady);
    const { color: lcpRatingColor } = rate(vitals.lcp, 2500, 4000);

    const segColors = { 'TTFB': '#8b5cf6', 'LCP Resource Delay': '#fb923c', 'LCP Resource Download': '#3b82f6', 'DOM Wait': '#a855f7', 'Stylesheet Wait': '#ec4899', 'Font Wait': '#06b6d4', 'Long Tasks (JS)': '#dc2626', 'Render Work': '#f59e0b', 'Element Render Delay': '#f59e0b' };

    let elementHtml = '';
    if (lcpResult.element) {
      const el = lcpResult.element;
      const sizeStr = el.size ? ` (${el.size.toLocaleString()} px²)` : '';
      const idStr = el.id ? ` id="${escHtml(el.id)}"` : '';
      const resourceStr = el.url
        ? `<span class="dim">Resource: ${urlWithTooltip(el.url, 60)}</span>`
        : '<span class="dim">(text, no resource)</span>';
      elementHtml = `<div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem;font-size:0.875rem">
  <strong>LCP Element:</strong> &lt;${escHtml(el.tagName.toLowerCase())}&gt;${idStr}${sizeStr}<br>
  ${resourceStr}
</div>`;
    }

    const stackedSegments = (() => {
      let usedPct = 0;
      return lcpResult.phases.map(([name, dur], i) => {
        const isLast = i === lcpResult.phases.length - 1;
        const exactPct = vitals.lcp > 0 ? (dur / vitals.lcp * 100) : 0;
        const pct = isLast ? Math.max(0, 100 - usedPct) : exactPct;
        usedPct += exactPct;
        const bg = segColors[name] || '#94a3b8';
        return pct > 0 ? `<div style="width:${pct}%;background:${bg};height:100%;display:inline-block" title="${escHtml(name)}: ${fmtMs(dur)} (${exactPct.toFixed(1)}%)"></div>` : '';
      }).join('');
    })();

    const legend = lcpResult.phases.map(([name]) => {
      return `<span><span class="waterfall-legend-dot" style="background:${segColors[name] || '#94a3b8'}"></span> ${escHtml(name)}</span>`;
    }).join(' ');

    const rows = lcpResult.phases.map(([name, dur]) => {
      const share = vitals.lcp > 0 ? (dur / vitals.lcp * 100) : 0;
      const isHighlight = share > 50 && lcpRatingColor !== 'green';
      const cellColor = isHighlight ? CSS_COLORS[lcpRatingColor] : '';
      const styleAttr = cellColor ? ` style="color:${cellColor}"` : '';
      return `    <tr>
      <td>${phaseLabel(name)}</td>
      <td class="r"${styleAttr}>${fmtMs(dur)}</td>
      <td class="r">${share.toFixed(1)}%</td>
      <td><div class="bar-container"><div class="bar-fill" style="width:${share.toFixed(1)}%;background:${cellColor || '#3b82f6'}"></div></div></td>
    </tr>`;
    }).join('\n');

    return `<p>Total LCP: <strong style="color:${CSS_COLORS[lcpRatingColor]}">${fmtMs(vitals.lcp)}</strong> (navigation start → largest contentful paint)</p>
${elementHtml}
<div class="waterfall-legend" style="margin-top:0.75rem">${legend}</div>
<div style="background:#e2e8f0;border-radius:6px;height:20px;overflow:hidden;margin-bottom:1rem;font-size:0;line-height:0;white-space:nowrap">${stackedSegments}</div>
<table>
  <thead><tr><th>Phase</th><th class="r">Duration</th><th class="r">Share</th><th style="width:120px"></th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>${renderMetrics && (renderMetrics.LayoutDuration > 0 || renderMetrics.RecalcStyleDuration > 0) ? `<p class="dim" style="margin-top:0.5rem;font-size:0.75rem">Page-wide rendering cost: ${fmtMs(renderMetrics.LayoutDuration)} layout (&times;${renderMetrics.LayoutCount}), ${fmtMs(renderMetrics.RecalcStyleDuration)} style recalc (&times;${renderMetrics.RecalcStyleCount})</p>` : ''}`;
  })()}

<h2>CLS Breakdown</h2>
${(() => {
    if (!vitals.cls || vitals.cls < 0.001) {
      return '<p class="dim">CLS is near-zero — no breakdown to show.</p>';
    }

    const windows = buildClsSessionWindows(clsEntries);
    const totalShifts = clsEntries.filter(e => !e.hadRecentInput).length;

    if (windows.length === 0) {
      return '<p class="dim">No unexpected layout shifts (all shifts had recent input).</p>';
    }

    const windowRows = windows.map((w, i) => {
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
      const { color } = rate(w.value, 0.05, 0.1);
      return `    <tr>
      <td>${i + 1}</td>
      <td class="r" style="color:${CSS_COLORS[color]}">${w.value.toFixed(4)}</td>
      <td class="r">${fmtMs(w.start)}</td>
      <td class="r">${w.shifts.length}</td>
      <td class="mono">${escHtml(worstSource)}</td>
    </tr>`;
    }).join('\n');

    // Details for worst window
    const worstWindow = windows[0];
    const shiftDetails = worstWindow.shifts.map((s, i) => {
      const sourceStr = (s.sources || []).map(src => src.selector || '(no source)').join(', ') || '(no source)';
      return `      <tr>
        <td>${i + 1}</td>
        <td class="r">${s.value.toFixed(4)}</td>
        <td class="r">${fmtMs(s.startTime)}</td>
        <td class="mono">${escHtml(sourceStr)}</td>
      </tr>`;
    }).join('\n');

    return `<p>Total CLS: <strong>${vitals.cls.toFixed(3)}</strong> across ${windows.length} session window${windows.length === 1 ? '' : 's'}, ${totalShifts} shift${totalShifts === 1 ? '' : 's'}</p>
<table>
  <thead><tr><th>#</th><th class="r">CLS Value</th><th class="r">Start</th><th class="r">Shifts</th><th>Worst Source</th></tr></thead>
  <tbody>
${windowRows}
  </tbody>
</table>
<details style="margin-top:0.75rem">
  <summary style="cursor:pointer;font-size:0.875rem;color:#64748b">Shifts in worst window (${worstWindow.shifts.length})</summary>
  <table style="margin-top:0.5rem">
    <thead><tr><th>#</th><th class="r">Value</th><th class="r">Start</th><th>Sources</th></tr></thead>
    <tbody>
${shiftDetails}
    </tbody>
  </table>
</details>`;
  })()}

<h2>INP Breakdown</h2>
${(() => {
    if (inp < 1) {
      return '<p class="dim">INP is near-zero — no interactions captured or all were instant.</p>';
    }

    const inpResult = computeInpPhases(inpEntries, longTaskDetails);
    if (!inpResult) {
      return '<p class="dim">No interaction entries captured.</p>';
    }

    const { color: inpRatingColor } = rate(inp, 200, 500);
    const interaction = inpResult.interaction;

    const segColors = { 'Input Delay': '#8b5cf6', 'Processing Time': '#dc2626', 'Presentation Delay': '#f59e0b', 'Pre-render': '#fb923c', 'rAF & Observers': '#06b6d4', 'Style, Layout & Paint': '#f59e0b' };

    const infoHtml = `<div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem;font-size:0.875rem">
  <strong>Worst interaction:</strong> <code>${escHtml(interaction.name)}</code>${interaction.target ? ` on <code>&lt;${escHtml(interaction.target)}&gt;</code>` : ''} at ${fmtMs(interaction.startTime)}
</div>`;

    const stackedSegments = (() => {
      let usedPct = 0;
      return inpResult.phases.map(([name, dur], i) => {
        const isLast = i === inpResult.phases.length - 1;
        const exactPct = inp > 0 ? (dur / inp * 100) : 0;
        const pct = isLast ? Math.max(0, 100 - usedPct) : exactPct;
        usedPct += exactPct;
        const bg = segColors[name] || '#94a3b8';
        return pct > 0 ? `<div style="width:${pct}%;background:${bg};height:100%;display:inline-block" title="${escHtml(name)}: ${fmtMs(dur)} (${exactPct.toFixed(1)}%)"></div>` : '';
      }).join('');
    })();

    const legend = inpResult.phases.map(([name]) => {
      return `<span><span class="waterfall-legend-dot" style="background:${segColors[name] || '#94a3b8'}"></span> ${escHtml(name)}</span>`;
    }).join(' ');

    const rows = inpResult.phases.map(([name, dur]) => {
      const share = inp > 0 ? (dur / inp * 100) : 0;
      const isHighlight = share > 50 && inpRatingColor !== 'green';
      const cellColor = isHighlight ? CSS_COLORS[inpRatingColor] : '';
      const styleAttr = cellColor ? ` style="color:${cellColor}"` : '';
      return `    <tr>
      <td>${phaseLabel(name)}</td>
      <td class="r"${styleAttr}>${fmtMs(dur)}</td>
      <td class="r">${share.toFixed(1)}%</td>
      <td><div class="bar-container"><div class="bar-fill" style="width:${share.toFixed(1)}%;background:${cellColor || '#3b82f6'}"></div></div></td>
    </tr>`;
    }).join('\n');

    const allInteractionsHtml = inpResult.allInteractions.length > 1 ? `
<details style="margin-top:0.75rem">
  <summary style="cursor:pointer;font-size:0.875rem;color:#64748b">All interactions (${inpResult.allInteractions.length})</summary>
  <table style="margin-top:0.5rem">
    <thead><tr><th>Event</th><th>Target</th><th class="r">Duration</th><th class="r">Input Delay</th><th class="r">Processing</th><th class="r">Presentation</th></tr></thead>
    <tbody>
${inpResult.allInteractions.map(e => {
      const { color } = rate(e.duration, 200, 500);
      return `      <tr>
        <td class="mono">${escHtml(e.name)}</td>
        <td class="mono">${escHtml(e.target || '(unknown)')}</td>
        <td class="r" style="color:${CSS_COLORS[color]}">${fmtMs(e.duration)}</td>
        <td class="r">${fmtMs(e.inputDelay)}</td>
        <td class="r">${fmtMs(e.processingTime)}</td>
        <td class="r">${fmtMs(e.presentationDelay)}</td>
      </tr>`;
    }).join('\n')}
    </tbody>
  </table>
</details>` : '';

    return `<p>Total INP: <strong style="color:${CSS_COLORS[inpRatingColor]}">${fmtMs(inp)}</strong> (worst interaction latency, synthetic)</p>
${infoHtml}
<div class="waterfall-legend" style="margin-top:0.75rem">${legend}</div>
<div style="background:#e2e8f0;border-radius:6px;height:20px;overflow:hidden;margin-bottom:1rem;font-size:0;line-height:0;white-space:nowrap">${stackedSegments}</div>
<table>
  <thead><tr><th>Phase</th><th class="r">Duration</th><th class="r">Share</th><th style="width:120px"></th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>${allInteractionsHtml}`;
  })()}

<h2>TBT Breakdown</h2>
${longTaskDetails.length > 0 ? (() => {
    const sortedTasks = [...longTaskDetails].sort((a, b) => b.blockingTime - a.blockingTime);
    const hasInlineUnknown = tbtByScript.some(s => !s.scriptUrl);
    const hasInlineScript = tbtByScript.some(s => s.scriptUrl === '(inline <script>)');
    return `<p>Total TBT: <strong>${fmtMs(tbt)}</strong> across ${longTaskDetails.length} long task${longTaskDetails.length === 1 ? '' : 's'}</p>
<table>
  <thead><tr><th>Script URL</th><th class="r">Blocking Time</th><th class="r">Tasks</th><th style="width:120px">Share</th></tr></thead>
  <tbody>
${tbtByScript.map(s => {
      const label = s.scriptUrl || '(unattributed)';
      const { color } = rate(s.totalBlockingTime, 50, 100);
      const pct = tbt > 0 ? (s.totalBlockingTime / tbt * 100) : 0;
      return `    <tr>
      <td class="url-cell mono">${urlWithTooltip(label, 55)}</td>
      <td class="r" style="color:${CSS_COLORS[color]}">${fmtMs(s.totalBlockingTime)}</td>
      <td class="r">${s.count}</td>
      <td><div class="bar-container"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${CSS_COLORS[color]}"></div></div></td>
    </tr>`;
    }).join('\n')}
  </tbody>
</table>
<details style="margin-top:0.75rem">
  <summary style="cursor:pointer;font-size:0.875rem;color:#64748b">Individual long tasks (${sortedTasks.length})</summary>
  <table style="margin-top:0.5rem">
    <thead><tr><th>Source</th><th class="r">Start</th><th class="r">Duration</th><th class="r">Blocking</th></tr></thead>
    <tbody>
${sortedTasks.map(lt => {
      const label = lt.scriptUrl || lt.invoker || '(unattributed)';
      const { color } = rate(lt.blockingTime, 50, 100);
      return `      <tr>
        <td class="url-cell mono">${urlWithTooltip(label, 55)}</td>
        <td class="r">${fmtMs(lt.startTime)}</td>
        <td class="r">${fmtMs(lt.duration)}</td>
        <td class="r" style="color:${CSS_COLORS[color]}">${fmtMs(lt.blockingTime)}</td>
      </tr>`;
    }).join('\n')}
    </tbody>
  </table>
</details>
${hasInlineScript || hasInlineUnknown ? `<p class="dim" style="margin-top:0.5rem;font-size:0.75rem">${hasInlineScript ? '(inline &lt;script&gt;) = JavaScript embedded in the HTML document' : ''}${hasInlineScript && hasInlineUnknown ? '<br>' : ''}${hasInlineUnknown ? '(unattributed) = framework bootstrap, hydration, or microtask queues' : ''}</p>` : ''}`;
  })() : '<p class="dim">No long tasks detected (TBT = 0).</p>'}

<h2>Navigation Timing</h2>
${nav.nextHopProtocol ? `<p class="dim" style="margin-bottom:0.5rem">Protocol: ${escHtml(nav.nextHopProtocol)}</p>` : ''}
<table>
  <thead><tr><th>Phase</th><th class="r">Duration</th></tr></thead>
  <tbody>
${timings.map(([name, ms]) => `    <tr><td>${phaseLabel(name)}</td><td class="r">${fmtMs(ms)}</td></tr>`).join('\n')}
  </tbody>
</table>

<h2>Resource Summary</h2>
<table>
  <thead><tr><th>Type</th><th class="r">Count</th><th class="r">Transfer</th><th class="r">Slowest</th></tr></thead>
  <tbody>
${Object.entries(resourceSummary).sort((a, b) => b[1].size - a[1].size).map(([type, d]) =>
    `    <tr><td>${escHtml(type)}</td><td class="r">${d.count}</td><td class="r">${fmtBytes(d.size)}</td><td class="r">${fmtMs(d.time)}</td></tr>`
  ).join('\n')}
  </tbody>
</table>

${memoryInfo && memoryInfo.jsHeapTotal > 0 ? (() => {
  const heapPct = (memoryInfo.jsHeapUsed / memoryInfo.jsHeapTotal) * 100;
  const { color } = rate(heapPct, 50, 80);
  return `<h2>Memory &amp; DOM</h2>
<table>
  <thead><tr><th>Metric</th><th class="r">Value</th></tr></thead>
  <tbody>
    <tr><td>JS Heap Used</td><td class="r" style="color:${CSS_COLORS[color]}">${fmtBytes(memoryInfo.jsHeapUsed)} / ${fmtBytes(memoryInfo.jsHeapTotal)} (${heapPct.toFixed(1)}%)</td></tr>
    <tr><td>DOM Nodes</td><td class="r">${memoryInfo.domNodeCount.toLocaleString()}</td></tr>
  </tbody>
</table>`;
})() : ''}

<h2>JS Coverage &amp; Execution Time</h2>
${sortedCoverage.length > 0 ? `<table>
  <thead><tr><th>URL</th><th class="r">Total</th><th class="r">Used</th><th class="r">Unused</th><th class="r">Unused%</th><th class="r">Exec Time</th><th style="width:100px"></th></tr></thead>
  <tbody>
${sortedCoverage.map(e => {
    const { color } = rate(e.unusedPct, 25, 50);
    return `    <tr>
      <td class="url-cell mono">${urlWithTooltip(e.url, 55)}</td>
      <td class="r">${fmtBytes(e.total)}</td>
      <td class="r">${fmtBytes(e.used)}</td>
      <td class="r">${fmtBytes(e.unused)}</td>
      <td class="r" style="color:${CSS_COLORS[color]}">${e.unusedPct.toFixed(0)}%</td>
      <td class="r">${fmtMs(e.execTime)}</td>
      <td><div class="bar-container"><div class="bar-fill" style="width:${e.unusedPct.toFixed(1)}%;background:${CSS_COLORS[color]}"></div></div></td>
    </tr>`;
  }).join('\n')}
  </tbody>
</table>
<p class="summary-stat">Total unused JS: ${fmtBytes(totalJsUnused)} / ${fmtBytes(totalJsBytes)} (<span style="color:${CSS_COLORS[rate(totalJsPct, 25, 50).color]}">${totalJsPct.toFixed(1)}%</span>) · Total exec: ${fmtMs(jsCoverage.reduce((s, e) => s + e.execTime, 0))}</p>`
: '<p class="dim">No JS coverage data available.</p>'}

<h2>Render-Blocking Resources</h2>
${renderBlocking.length > 0 ? `<table>
  <thead><tr><th>URL</th><th>Type</th><th class="r">Transfer</th><th class="r">Duration</th></tr></thead>
  <tbody>
${renderBlocking.map(r => `    <tr><td class="url-cell mono">${urlWithTooltip(r.name, 55)}</td><td>${escHtml(r.initiatorType || '')}</td><td class="r">${fmtBytes(r.transferSize)}</td><td class="r">${fmtMs(r.duration)}</td></tr>`).join('\n')}
  </tbody>
</table>` : '<p class="dim">No render-blocking resources detected.</p>'}

<h2>Preload Audit</h2>
${preloadLinks.length > 0 ? `<table>
  <thead><tr><th>Status</th><th>URL</th><th>As</th></tr></thead>
  <tbody>
${preloadLinks.map(link => {
    const wasUsed = resourceUrls.has(link.href);
    return `    <tr><td class="${wasUsed ? 'tag-good' : 'tag-poor'}">${wasUsed ? 'used' : 'unused'}</td><td class="url-cell mono">${urlWithTooltip(link.href, 65)}</td><td>${escHtml(link.as)}</td></tr>`;
  }).join('\n')}
  </tbody>
</table>` : '<p class="dim">No &lt;link rel="preload"&gt; tags found.</p>'}

<h2>Largest Resources (Top 10)</h2>
<table>
  <thead><tr><th>URL</th><th>Type</th><th class="r">Transfer</th><th class="r">Duration</th></tr></thead>
  <tbody>
${largest.map(r => `    <tr><td class="url-cell mono">${urlWithTooltip(r.name, 55)}</td><td>${escHtml(r.initiatorType || '')}</td><td class="r">${fmtBytes(r.transferSize)}</td><td class="r">${fmtMs(r.duration)}</td></tr>`).join('\n')}
  </tbody>
</table>

<h2>Waterfall</h2>
<div class="waterfall-legend">
  <span><span class="waterfall-legend-dot" style="background:#94a3b8"></span> Queueing</span>
  <span><span class="waterfall-legend-dot" style="background:#fb923c"></span> Stalled</span>
  <span><span class="waterfall-legend-dot" style="background:#8b5cf6"></span> DNS</span>
  <span><span class="waterfall-legend-dot" style="background:#3b82f6"></span> TCP</span>
  <span><span class="waterfall-legend-dot" style="background:#06b6d4"></span> TLS</span>
  <span><span class="waterfall-legend-dot" style="background:#22c55e"></span> Waiting (TTFB)</span>
  <span><span class="waterfall-legend-dot" style="background:#60a5fa"></span> Content Download</span>
</div>
<div style="margin-bottom:1rem">
${(() => {
    // HTML document (navigation entry) as first row
    const navDuration = nav.responseEnd - nav.startTime;
    const navStartPct = 0;
    const navWidthPct = Math.max(0.5, (navDuration / timelineEnd * 100)).toFixed(2);
    const navRow = `  <div class="waterfall-row">
    <span class="waterfall-label">${urlWithTooltip(nav.name, 35)}</span>
    <span class="waterfall-times">document · ${fmtMs(0)} / ${fmtMs(navDuration)}</span>
    <div class="waterfall-track"><div class="waterfall-bar" style="left:${navStartPct}%;width:${navWidthPct}%;background:#16a34a" title="Document: ${fmtMs(navDuration)}"></div></div>
  </div>`;

    const criticalTypes = new Set(['link', 'css', 'script']);
    const resourceRows = [...resourceEntries].filter(r => criticalTypes.has(r.initiatorType)).sort((a, b) => a.startTime - b.startTime).slice(0, 30).map(r => {
      const phases = computeResourcePhases(r);
      const segments = phases.length > 0 ? phases.map(p => {
        const left = (p.start / timelineEnd * 100).toFixed(2);
        const width = Math.max(0.1, (p.duration / timelineEnd * 100)).toFixed(2);
        return `<div class="waterfall-seg" style="left:${left}%;width:${width}%;background:${p.color}" title="${escHtml(p.name)}: ${fmtMs(p.duration)}"></div>`;
      }).join('') : `<div class="waterfall-bar" style="left:${(r.startTime / timelineEnd * 100).toFixed(2)}%;width:${Math.max(0.5, (r.duration / timelineEnd * 100)).toFixed(2)}%;background:${r.renderBlockingStatus === 'blocking' ? '#dc2626' : '#3b82f6'}"></div>`;
      const blockTag = r.renderBlockingStatus === 'blocking' ? ' <span style="color:#dc2626;font-weight:600">[RB]</span>' : '';
      return `  <div class="waterfall-row">
    <span class="waterfall-label">${urlWithTooltip(r.name, 35)}</span>
    <span class="waterfall-times">${escHtml(r.initiatorType || '')} · ${fmtMs(r.startTime)} / ${fmtMs(r.duration)}${blockTag}</span>
    <div class="waterfall-track">${segments}</div>
  </div>`;
    });

    return [navRow, ...resourceRows].join('\n');
  })()}
</div>


${meta.numRuns > 1 && meta.allResults ? `<h2>All Runs</h2>
<table>
  <thead><tr><th>Run</th><th class="r">TTFB</th><th class="r">FCP</th><th class="r">LCP</th><th class="r">CLS</th><th class="r">TBT</th><th class="r">INP</th></tr></thead>
  <tbody>
${meta.allResults.map((r, i) => `    <tr><td>${i + 1}</td><td class="r">${fmtMs(r.nav.responseStart - r.nav.startTime)}</td><td class="r">${fmtMs(r.vitals.fcp)}</td><td class="r">${fmtMs(r.vitals.lcp)}</td><td class="r">${(r.vitals.cls ?? 0).toFixed(3)}</td><td class="r">${fmtMs(r.tbt)}</td><td class="r">${fmtMs(r.inp || 0)}</td></tr>`).join('\n')}
    <tr style="font-weight:700;border-top:2px solid #cbd5e1"><td>Median</td><td class="r">${fmtMs(meta.medianVitals.ttfb)}</td><td class="r">${fmtMs(meta.medianVitals.fcp)}</td><td class="r">${fmtMs(meta.medianVitals.lcp)}</td><td class="r">${(meta.medianVitals.cls ?? 0).toFixed(3)}</td><td class="r">${fmtMs(meta.medianVitals.tbt)}</td><td class="r">${fmtMs(meta.medianVitals.inp || 0)}</td></tr>
  </tbody>
</table>` : ''}

<p class="dim" style="margin-top:2rem;font-size:0.75rem">Generated by perf-audit · ${escHtml(meta.date)}</p>
</body>
</html>`;
}
