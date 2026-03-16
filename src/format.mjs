/**
 * Pure formatting utilities for the performance audit.
 */

export function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function fmtBytes(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

export function truncUrl(url, maxLen = 60) {
  if (url.length <= maxLen) return url;
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    if (path.length <= maxLen) return path;
    return '...' + path.slice(path.length - maxLen + 3);
  }
  catch {
    return '...' + url.slice(url.length - maxLen + 3);
  }
}

export function rate(value, good, poor) {
  if (value <= good) return { label: 'Good', color: 'green' };
  if (value <= poor) return { label: 'Needs work', color: 'yellow' };
  return { label: 'Poor', color: 'red' };
}

/**
 * Log-normal CDF scoring (same approach as Lighthouse).
 * p10 = value at the 10th percentile ("good" threshold)
 * median = value at the 50th percentile
 * Returns a 0–1 score.
 */
export function computeScore(value, p10, median) {
  if (value <= 0) return 1;
  const ERFINV_0_8 = 0.9061938024368232;
  const mu = Math.log(median);
  const sigma = (Math.log(median) - Math.log(p10)) / (ERFINV_0_8 * Math.SQRT2);
  if (sigma <= 0) return value <= median ? 1 : 0;
  const u = (Math.log(value) - mu) / (sigma * Math.SQRT2);
  const x = Math.abs(u);
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = poly * Math.exp(-x * x);
  return u >= 0 ? erfc / 2 : 1 - erfc / 2;
}

/**
 * Lighthouse v10-style weighted performance score.
 * Weights: TTFB 10%, FCP 10%, LCP 25%, TBT 25%, CLS 20%, INP 10%
 * Scoring curves use p10/median from web.dev thresholds.
 */
export const METRIC_SCORING = [
  { key: 'ttfb', name: 'TTFB',  weight: 0.10, p10: 800,  median: 1800,  good: 800,  poor: 1800 },
  { key: 'fcp',  name: 'FCP',   weight: 0.10, p10: 1800, median: 3000,  good: 1800, poor: 3000 },
  { key: 'lcp',  name: 'LCP',   weight: 0.25, p10: 2500, median: 4000,  good: 2500, poor: 4000 },
  { key: 'tbt',  name: 'TBT',   weight: 0.25, p10: 200,  median: 600,   good: 200,  poor: 600 },
  { key: 'cls',  name: 'CLS',   weight: 0.20, p10: 0.1,  median: 0.25,  good: 0.1,  poor: 0.25 },
  { key: 'inp',  name: 'INP',   weight: 0.10, p10: 200,  median: 500,   good: 200,  poor: 500 },
];

export function computeOverallScore(metricValues) {
  let total = 0;
  for (const m of METRIC_SCORING) {
    const value = metricValues[m.key] ?? 0;
    total += computeScore(value, m.p10, m.median) * m.weight;
  }
  return Math.round(total * 100);
}

/**
 * FCP = TTFB + Blocking Resources + HTML Parse + Style & Font Load + Render Setup
 * Zero-value sub-phases (except TTFB) are filtered out.
 */
export function computeFcpPhases(nav, fcp, resourceEntries) {
  const ttfb = Math.max(0, nav.responseStart - nav.startTime);

  // Blocking resources phase
  const blockingResources = resourceEntries.filter(r => r.renderBlockingStatus === 'blocking');
  let blockingEnd = 0;
  for (const r of blockingResources) {
    if (r.responseEnd > blockingEnd) blockingEnd = r.responseEnd;
  }
  const blockingDuration = Math.max(0, Math.min(blockingEnd - ttfb, fcp - ttfb));

  // HTML Parse: responseEnd → domInteractive
  const htmlParse = Math.max(0, nav.domInteractive - nav.responseEnd);

  // Style & Font loading after blocking resources finish
  const afterBlocking = Math.max(ttfb + blockingDuration, nav.responseEnd);
  const styleAndFontResources = resourceEntries.filter(r =>
    (r.initiatorType === 'link' || r.initiatorType === 'css' || r.initiatorType === 'font') &&
    r.renderBlockingStatus !== 'blocking' &&
    r.responseEnd > afterBlocking &&
    r.responseEnd <= fcp
  );
  const lastStyleFont = styleAndFontResources.length > 0
    ? Math.max(...styleAndFontResources.map(r => r.responseEnd))
    : 0;
  const styleFontLoad = lastStyleFont > 0 ? Math.max(0, lastStyleFont - afterBlocking) : 0;

  // Render Setup: remainder
  const renderSetup = Math.max(0, fcp - ttfb - blockingDuration - htmlParse - styleFontLoad);

  const phases = [
    ['TTFB', ttfb],
    ['Blocking Resources', blockingDuration],
    ['HTML Parse', htmlParse],
    ['Style & Font Load', styleFontLoad],
    ['Render Setup', renderSetup],
  ];

  // Skip zero-value phases (except TTFB) to keep output clean
  return phases.filter(([name, dur]) => name === 'TTFB' || dur > 0);
}

/**
 * LCP = TTFB + LCP Resource Delay + LCP Resource Download + render delay sub-phases
 * Render delay is broken into: DOM Wait, Stylesheet Wait, Font Wait, Long Tasks (JS), Render Work.
 * Zero-value sub-phases are filtered out.
 */
export function computeLcpPhases(nav, lcp, lcpElement, resourceEntries, longTaskDetails = [], fontsReady = 0) {
  const ttfb = Math.max(0, nav.responseStart - nav.startTime);
  const element = lcpElement ? {
    tagName: lcpElement.tagName || '',
    id: lcpElement.id || '',
    size: lcpElement.size || 0,
    url: lcpElement.url || '',
  } : null;

  // Compute render delay sub-phases for a given window
  function computeRenderDelayPhases(windowStart, windowEnd) {
    const windowDur = Math.max(0, windowEnd - windowStart);
    if (windowDur < 1) return [];

    // 1. DOM Wait — time until DOMContentLoaded fires
    const domWait = Math.max(0, Math.min(nav.domContentLoadedEventEnd - windowStart, windowDur));

    // 2. Stylesheet Wait — non-blocking CSS completing after DOM milestone
    const styleMilestone = Math.max(windowStart, nav.domContentLoadedEventEnd);
    const nonBlockingStyles = resourceEntries.filter(r =>
      (r.initiatorType === 'link' || r.initiatorType === 'css') &&
      r.renderBlockingStatus !== 'blocking' &&
      r.responseEnd > styleMilestone && r.responseEnd <= windowEnd
    );
    const lastStyle = nonBlockingStyles.length > 0
      ? Math.max(...nonBlockingStyles.map(r => r.responseEnd)) : 0;
    const stylesheetWait = lastStyle > 0 ? Math.max(0, lastStyle - styleMilestone) : 0;

    // 3. Font Wait — font resources completing after stylesheet milestone
    const fontMilestone = Math.max(styleMilestone, lastStyle || styleMilestone);
    const fonts = resourceEntries.filter(r =>
      r.initiatorType === 'font' &&
      r.responseEnd > fontMilestone && r.responseEnd <= windowEnd
    );
    const lastFontResource = fonts.length > 0
      ? Math.max(...fonts.map(r => r.responseEnd)) : 0;
    const lastFontTime = Math.max(
      lastFontResource,
      fontsReady > fontMilestone && fontsReady <= windowEnd ? fontsReady : 0,
    );
    const fontWait = lastFontTime > 0 ? Math.max(0, lastFontTime - fontMilestone) : 0;

    // 4. Long Tasks (JS) — overlap in remaining window after font milestone
    const jsStart = Math.max(fontMilestone, lastFontTime || fontMilestone);
    let longTaskOverlap = 0;
    for (const lt of longTaskDetails) {
      const taskEnd = lt.startTime + lt.duration;
      const overlap = Math.min(taskEnd, windowEnd) - Math.max(lt.startTime, jsStart);
      if (overlap > 0) longTaskOverlap += overlap;
    }
    longTaskOverlap = Math.min(longTaskOverlap, Math.max(0, windowEnd - jsStart));

    // 5. Render Work — remainder
    const renderWork = Math.max(0, windowDur - domWait - stylesheetWait - fontWait - longTaskOverlap);

    return [
      ['DOM Wait', domWait],
      ['Stylesheet Wait', stylesheetWait],
      ['Font Wait', fontWait],
      ['Long Tasks (JS)', longTaskOverlap],
      ['Render Work', renderWork],
    ].filter(([, dur]) => dur > 0);
  }

  // Text node or no resource URL — TTFB + render delay sub-phases
  if (!element || !element.url) {
    const renderPhases = computeRenderDelayPhases(ttfb, lcp);
    return {
      phases: [
        ['TTFB', ttfb],
        ...renderPhases,
      ],
      element,
    };
  }

  // Find matching resource entry
  const res = resourceEntries.find(r => r.name === element.url);
  if (!res) {
    const renderPhases = computeRenderDelayPhases(ttfb, lcp);
    return {
      phases: [
        ['TTFB', ttfb],
        ...renderPhases,
      ],
      element,
    };
  }

  const resourceLoadDelay = Math.max(0, res.startTime - ttfb);
  const resourceLoadDuration = Math.max(0, res.responseEnd - res.startTime);
  const windowStart = ttfb + resourceLoadDelay + resourceLoadDuration;
  const renderPhases = computeRenderDelayPhases(windowStart, lcp);

  return {
    phases: [
      ['TTFB', ttfb],
      ['LCP Resource Delay', resourceLoadDelay],
      ['LCP Resource Download', resourceLoadDuration],
      ...renderPhases,
    ],
    element,
  };
}

/**
 * Groups non-input CLS shifts into session windows (gap ≤ 1s, max 5s duration).
 * Returns windows sorted by value descending.
 */
export function buildClsSessionWindows(clsEntries) {
  const shifts = clsEntries
    .filter(e => !e.hadRecentInput)
    .sort((a, b) => a.startTime - b.startTime);

  if (shifts.length === 0) return [];

  const windows = [];
  let current = { shifts: [shifts[0]], start: shifts[0].startTime, value: shifts[0].value };

  for (let i = 1; i < shifts.length; i++) {
    const s = shifts[i];
    const gap = s.startTime - (current.shifts[current.shifts.length - 1].startTime);
    const duration = s.startTime - current.start;

    if (gap <= 1000 && duration <= 5000) {
      current.shifts.push(s);
      current.value += s.value;
    }
    else {
      windows.push(current);
      current = { shifts: [s], start: s.startTime, value: s.value };
    }
  }
  windows.push(current);

  return windows.sort((a, b) => b.value - a.value);
}

/**
 * Computes INP phases for the worst interaction.
 * INP = Input Delay + Processing Time + Presentation Delay
 * Returns { phases, interaction } or null if no entries.
 */
/**
 * Break down Presentation Delay using a matching LoAF entry.
 * Returns sub-phases array or null if no matching LoAF found.
 *
 * LoAF timeline within the presentation window (processingEnd → nextPaint):
 *   processingEnd → renderStart         = Pre-render (microtasks, promises, queued tasks)
 *   renderStart → styleAndLayoutStart   = rAF & Observers (rAF callbacks, ResizeObserver, etc.)
 *   styleAndLayoutStart → frame end     = Style, Layout & Paint
 */
function breakdownPresentationDelay(worst, longTaskDetails) {
  const presentationDelay = Math.max(0, worst.presentationDelay);
  if (presentationDelay < 1 || !longTaskDetails || longTaskDetails.length === 0) return null;

  const processingEnd = worst.startTime + worst.duration - presentationDelay;
  const nextPaint = worst.startTime + worst.duration;

  // Find the best LoAF overlapping the presentation window.
  // The handler may be tiny (1ms) with the render frame starting AFTER processingEnd,
  // so we match any LoAF that overlaps [processingEnd, nextPaint] with 8ms tolerance
  // (Event Timing rounds duration to 8ms boundaries).
  const tolerance = 8;
  let bestLoaf = null;
  let bestOverlap = 0;
  for (const lt of longTaskDetails) {
    if (!lt.renderStart) continue;
    const frameEnd = lt.startTime + lt.duration;
    const overlapStart = Math.max(lt.startTime, processingEnd);
    const overlapEnd = Math.min(frameEnd, nextPaint + tolerance);
    const overlap = overlapEnd - overlapStart;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestLoaf = lt;
    }
  }

  if (!bestLoaf) return null;

  const frameEnd = bestLoaf.startTime + bestLoaf.duration;

  // Pre-render: processingEnd → renderStart (microtasks, promise chains, queued scripts)
  const renderStart = Math.max(bestLoaf.renderStart, processingEnd);
  const preRender = Math.max(0, renderStart - processingEnd);

  // rAF & Observers: renderStart → styleAndLayoutStart
  const styleStart = bestLoaf.styleAndLayoutStart > bestLoaf.renderStart
    ? bestLoaf.styleAndLayoutStart : bestLoaf.renderStart;
  const rafObservers = Math.max(0, Math.min(styleStart, nextPaint) - renderStart);

  // Style, Layout & Paint: styleAndLayoutStart → frame end
  const slpStart = Math.max(styleStart, processingEnd);
  const styleLayoutPaint = Math.max(0, Math.min(frameEnd, nextPaint) - slpStart);

  // Only return if we have meaningful sub-phases
  const phases = [
    ['Pre-render', preRender],
    ['rAF & Observers', rafObservers],
    ['Style, Layout & Paint', styleLayoutPaint],
  ].filter(([, dur]) => dur > 0);

  return phases.length > 0 ? phases : null;
}

export function computeInpPhases(inpEntries, longTaskDetails = []) {
  if (!inpEntries || inpEntries.length === 0) return null;

  // Group by interactionId, pick the worst duration per interaction
  const byInteraction = new Map();
  for (const e of inpEntries) {
    const existing = byInteraction.get(e.interactionId);
    if (!existing || e.duration > existing.duration) {
      byInteraction.set(e.interactionId, e);
    }
  }

  // Sort by duration descending, pick the worst (INP = p98-ish in real world, but for synthetic we take worst)
  const sorted = [...byInteraction.values()].sort((a, b) => b.duration - a.duration);
  const worst = sorted[0];

  // Try to break down Presentation Delay using LoAF data
  const presentationSubPhases = breakdownPresentationDelay(worst, longTaskDetails);

  const phases = [
    ['Input Delay', Math.max(0, worst.inputDelay)],
    ['Processing Time', Math.max(0, worst.processingTime)],
  ];

  if (presentationSubPhases) {
    phases.push(...presentationSubPhases);
  }
  else {
    phases.push(['Presentation Delay', Math.max(0, worst.presentationDelay)]);
  }

  return {
    phases,
    interaction: {
      duration: worst.duration,
      name: worst.name,
      target: worst.target || '',
      startTime: worst.startTime,
    },
    allInteractions: sorted.map(e => ({
      duration: e.duration,
      name: e.name,
      target: e.target || '',
      inputDelay: Math.max(0, e.inputDelay),
      processingTime: Math.max(0, e.processingTime),
      presentationDelay: Math.max(0, e.presentationDelay),
    })),
  };
}

/**
 * Computes timing phase segments for a resource entry (Chrome DevTools style).
 * Returns array of { name, start, duration, color }.
 */
export function computeResourcePhases(r) {
  const phases = [];
  const startTime = r.startTime || 0;
  const fetchStart = r.fetchStart || startTime;
  const domainLookupStart = r.domainLookupStart || 0;
  const domainLookupEnd = r.domainLookupEnd || 0;
  const connectStart = r.connectStart || 0;
  const connectEnd = r.connectEnd || 0;
  const secureConnectionStart = r.secureConnectionStart || 0;
  const requestStart = r.requestStart || 0;
  const responseStart = r.responseStart || 0;
  const responseEnd = r.responseEnd || 0;

  // Queueing: startTime → fetchStart
  const queueing = fetchStart - startTime;
  if (queueing >= 0.5) {
    phases.push({ name: 'Queueing', start: startTime, duration: queueing, color: '#94a3b8' });
  }

  // Stalled: fetchStart → domainLookupStart (or connectStart if no DNS)
  const stalledEnd = domainLookupStart > fetchStart ? domainLookupStart : connectStart > fetchStart ? connectStart : requestStart > fetchStart ? requestStart : fetchStart;
  const stalled = stalledEnd - fetchStart;
  if (stalled >= 0.5) {
    phases.push({ name: 'Stalled', start: fetchStart, duration: stalled, color: '#fb923c' });
  }

  // DNS Lookup
  const dns = domainLookupEnd - domainLookupStart;
  if (dns >= 0.5) {
    phases.push({ name: 'DNS Lookup', start: domainLookupStart, duration: dns, color: '#8b5cf6' });
  }

  // TCP + TLS
  if (connectEnd > connectStart && (connectEnd - connectStart) >= 0.5) {
    if (secureConnectionStart > 0 && secureConnectionStart >= connectStart) {
      // TCP portion
      const tcp = secureConnectionStart - connectStart;
      if (tcp >= 0.5) {
        phases.push({ name: 'TCP', start: connectStart, duration: tcp, color: '#3b82f6' });
      }
      // TLS portion
      const tls = connectEnd - secureConnectionStart;
      if (tls >= 0.5) {
        phases.push({ name: 'TLS', start: secureConnectionStart, duration: tls, color: '#06b6d4' });
      }
    } else {
      // No TLS, entire connect is TCP
      const tcp = connectEnd - connectStart;
      if (tcp >= 0.5) {
        phases.push({ name: 'TCP', start: connectStart, duration: tcp, color: '#3b82f6' });
      }
    }
  }

  // Waiting (TTFB): requestStart → responseStart
  const waiting = responseStart - requestStart;
  if (waiting >= 0.5) {
    phases.push({ name: 'Waiting (TTFB)', start: requestStart, duration: waiting, color: '#22c55e' });
  }

  // Content Download: responseStart → responseEnd
  const download = responseEnd - responseStart;
  if (download >= 0.5) {
    phases.push({ name: 'Content Download', start: responseStart, duration: download, color: '#60a5fa' });
  }

  return phases;
}

// Phase color → ANSI code mapping for console output
export const PHASE_ANSI_COLORS = {
  '#94a3b8': '\x1b[90m',  // gray - Queueing
  '#fb923c': '\x1b[33m',  // yellow/orange - Stalled
  '#8b5cf6': '\x1b[35m',  // magenta - DNS
  '#3b82f6': '\x1b[34m',  // blue - TCP
  '#06b6d4': '\x1b[36m',  // cyan - TLS
  '#22c55e': '\x1b[32m',  // green - Waiting
  '#60a5fa': '\x1b[94m',  // light blue - Content Download
};

export function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
