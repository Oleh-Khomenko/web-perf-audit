/**
 * CDP data collection logic — runs a single performance audit.
 */

function safeJsonParse(value, fallback = null) {
  try { return JSON.parse(value); }
  catch { return fallback; }
}

export async function runAudit(cdp, targetUrl, options = {}) {
  // Enable domains
  await cdp.send('Page.enable');
  await cdp.send('Performance.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  // Device emulation (viewport, DPR, user agent, touch)
  if (options.device) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: options.device.width,
      height: options.device.height,
      deviceScaleFactor: options.device.deviceScaleFactor,
      mobile: options.device.mobile,
      screenWidth: options.device.width,
      screenHeight: options.device.height,
    });
    if (options.device.mobile) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    }
    if (options.device.userAgent) {
      await cdp.send('Emulation.setUserAgentOverride', { userAgent: options.device.userAgent });
    }
  }

  // Enable JS coverage + CPU profiling via Profiler
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.startPreciseCoverage', { callCount: false, detailed: true });
  await cdp.send('Profiler.start');

  // Inject PerformanceObservers BEFORE navigation
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__perfData = { fcp: 0, lcp: 0, cls: 0, inp: 0, lcpElement: null, clsEntries: [], inpEntries: [], longTasks: [], renderBlocking: [], fontsReady: 0 };

      document.fonts.ready.then(() => {
        window.__perfData.fontsReady = performance.now();
      });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') window.__perfData.fcp = entry.startTime;
        }
      }).observe({ type: 'paint', buffered: true });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__perfData.lcp = entry.startTime;
          window.__perfData.lcpElement = {
            startTime: entry.startTime,
            renderTime: entry.renderTime,
            loadTime: entry.loadTime,
            size: entry.size,
            url: entry.url || '',
            id: entry.id || '',
            tagName: entry.element ? entry.element.tagName : '',
          };
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__perfData.cls += entry.value;
          window.__perfData.clsEntries.push({
            value: entry.value,
            startTime: entry.startTime,
            hadRecentInput: entry.hadRecentInput,
            sources: (entry.sources || []).slice(0, 5).map(s => {
              let selector = '';
              try {
                const el = s.node;
                if (el) {
                  selector = el.tagName.toLowerCase();
                  if (el.id) selector += '#' + el.id;
                  else if (el.className && typeof el.className === 'string')
                    selector += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
                }
              } catch (_) {}
              return {
                selector,
                previousRect: s.previousRect ? { x: s.previousRect.x, y: s.previousRect.y, width: s.previousRect.width, height: s.previousRect.height } : null,
                currentRect: s.currentRect ? { x: s.currentRect.x, y: s.currentRect.y, width: s.currentRect.width, height: s.currentRect.height } : null,
              };
            }),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.interactionId) continue;
          const duration = entry.duration;
          const inputDelay = entry.processingStart - entry.startTime;
          const processingTime = entry.processingEnd - entry.processingStart;
          const presentationDelay = entry.startTime + entry.duration - entry.processingEnd;
          window.__perfData.inpEntries.push({
            duration,
            inputDelay,
            processingTime,
            presentationDelay,
            interactionId: entry.interactionId,
            name: entry.name,
            startTime: entry.startTime,
            target: (() => {
              try {
                const el = entry.target;
                if (!el) return '';
                let sel = el.tagName.toLowerCase();
                if (el.id) sel += '#' + el.id;
                else if (el.className && typeof el.className === 'string')
                  sel += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
                return sel;
              } catch (_) { return ''; }
            })(),
          });
          if (duration > window.__perfData.inp) {
            window.__perfData.inp = duration;
          }
        }
      }).observe({ type: 'event', buffered: true, durationThreshold: 0 });

      // Prefer Long Animation Frames API (Chrome 123+) for rich script attribution,
      // fall back to basic longtask observer if unavailable.
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration <= 50) continue;
            const scripts = (entry.scripts || []).map(s => ({
              sourceUrl: s.sourceURL || '',
              invoker: s.invoker || '',
              invokerType: s.invokerType || '',
              duration: s.duration || 0,
            }));
            // Pick the most meaningful source URL from scripts
            const primaryScript = scripts.find(s => s.sourceUrl) || scripts[0] || {};
            // If sourceUrl matches the page URL, it's an inline <script> in the HTML
            var srcUrl = primaryScript.sourceUrl || '';
            if (srcUrl && srcUrl === location.href) srcUrl = '(inline <script>)';
            window.__perfData.longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
              blockingTime: entry.duration - 50,
              scriptUrl: srcUrl,
              invoker: primaryScript.invoker || '',
              invokerType: primaryScript.invokerType || '',
              scripts: scripts,
              renderStart: entry.renderStart || 0,
              styleAndLayoutStart: entry.styleAndLayoutStart || 0,
            });
          }
        }).observe({ type: 'long-animation-frame', buffered: true });
      } catch (_e) {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__perfData.longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
              blockingTime: entry.duration - 50,
              scriptUrl: (entry.attribution && entry.attribution[0] && entry.attribution[0].containerSrc) || '',
              invoker: '',
              invokerType: '',
              scripts: [],
            });
          }
        }).observe({ type: 'longtask', buffered: true });
      }

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.renderBlockingStatus === 'blocking') {
            window.__perfData.renderBlocking.push({
              name: entry.name,
              initiatorType: entry.initiatorType,
              transferSize: entry.transferSize || 0,
              duration: entry.duration,
            });
          }
        }
      }).observe({ type: 'resource', buffered: true });
    `,
  });

  // Clear caches and storage before navigation
  // Note: cookies are not cleared globally — each run uses a fresh browser context
  // which already has no cookies. Clearing globally would break parallel runs with --cookie.
  await cdp.send('Network.clearBrowserCache');
  const origin = new URL(targetUrl).origin;
  await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });

  // Set extra HTTP headers before navigation
  if (options.extraHeaders && Object.keys(options.extraHeaders).length > 0) {
    await cdp.send('Network.setExtraHTTPHeaders', { headers: options.extraHeaders });
  }

  // Set cookies before navigation
  if (options.extraCookies && options.extraCookies.length > 0) {
    for (const cookie of options.extraCookies) {
      await cdp.send('Network.setCookie', cookie);
    }
  }

  // Force-close all sockets (kills keep-alive connections, TCP/TLS pool, and DNS cache)
  // Toggling offline drops every open socket; going back online forces fresh DNS + TCP + TLS
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });

  if (options.throttle) {
    // Apply throttle preset after socket reset
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: options.throttle.latency,
      downloadThroughput: options.throttle.downloadThroughput,
      uploadThroughput: options.throttle.uploadThroughput,
    });
  }
  else {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
  }

  // CPU throttling
  if (options.cpuThrottle && options.cpuThrottle > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpuThrottle });
  }

  // Navigate — wrap the rest in try/finally to ensure profiler cleanup
  let _profilerStarted = true;
  try {
  const navPromise = new Promise((resolve) => {
    cdp.on('Page.loadEventFired', () => resolve());
  });

  const navResponse = await cdp.send('Page.navigate', { url: targetUrl });
  if (navResponse.errorText) {
    throw new Error(`Navigation to ${targetUrl} failed: ${navResponse.errorText}`);
  }
  let navTimer;
  const navTimeout = new Promise((_, reject) =>
    navTimer = setTimeout(() => reject(new Error('Page load timed out after 30s')), 30000)
  );
  try {
    await Promise.race([navPromise, navTimeout]);
  } finally {
    clearTimeout(navTimer);
  }

  // Wait for LCP and layout shifts to settle
  await new Promise((r) => setTimeout(r, 3000));

  // Simulate interactions to measure INP
  // Find the largest interactive element and click it, then press a key
  const { result: interactiveResult } = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [tabindex]');
      let best = null, bestArea = 0;
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.top < 0 || rect.top > window.innerHeight) continue;
        const area = rect.width * rect.height;
        if (area > bestArea) { bestArea = area; best = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; }
      }
      return JSON.stringify(best);
    })()`,
    returnByValue: false,
  });

  const interactiveEl = safeJsonParse(interactiveResult.value);
  if (interactiveEl) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: interactiveEl.x, y: interactiveEl.y, button: 'left', clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: interactiveEl.x, y: interactiveEl.y, button: 'left', clickCount: 1,
    });
  }

  // Press and release a key (Tab)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });

  // Wait for interaction events to be processed and observed
  await new Promise((r) => setTimeout(r, 1000));

  // -- Collect data --

  // Connection info
  const { result: connResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify(navigator.connection ? {
      effectiveType: navigator.connection.effectiveType,
      downlink: navigator.connection.downlink,
      rtt: navigator.connection.rtt,
    } : null)`,
    returnByValue: false,
  });
  const connectionInfo = safeJsonParse(connResult.value);

  // Navigation timing
  const { result: navResult } = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify(performance.getEntriesByType("navigation")[0].toJSON())',
    returnByValue: false,
  });
  const nav = safeJsonParse(navResult.value, {});

  // Server-Timing headers (toJSON() strips serverTiming array)
  const { result: serverTimingResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify((performance.getEntriesByType('navigation')[0].serverTiming || []).map(s => ({
      name: s.name,
      description: s.description,
      duration: s.duration,
    })))`,
    returnByValue: false,
  });
  const serverTiming = safeJsonParse(serverTimingResult.value);

  // Web vitals
  const { result: vitalsResult } = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify(window.__perfData)',
    returnByValue: false,
  });
  const vitals = safeJsonParse(vitalsResult.value, {});
  if (!vitals.longTasks) vitals.longTasks = [];
  if (!vitals.inpEntries) vitals.inpEntries = [];
  if (!vitals.renderBlocking) vitals.renderBlocking = [];
  if (!vitals.clsEntries) vitals.clsEntries = [];
  const tbt = vitals.longTasks.reduce((sum, lt) => sum + lt.blockingTime, 0);

  // Aggregate long tasks by script URL (fall back to invoker for grouping)
  const tbtByScriptMap = new Map();
  for (const lt of vitals.longTasks) {
    const key = lt.scriptUrl || lt.invoker || '';
    const entry = tbtByScriptMap.get(key) || { scriptUrl: key, totalBlockingTime: 0, count: 0 };
    entry.totalBlockingTime += lt.blockingTime;
    entry.count++;
    tbtByScriptMap.set(key, entry);
  }
  const tbtByScript = [...tbtByScriptMap.values()].sort((a, b) => b.totalBlockingTime - a.totalBlockingTime);
  const longTaskDetails = vitals.longTasks;

  // Resource entries (full)
  const { result: resEntriesResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify(performance.getEntriesByType('resource').map(r => ({
      name: r.name,
      initiatorType: r.initiatorType,
      transferSize: r.transferSize || 0,
      encodedBodySize: r.encodedBodySize || 0,
      decodedBodySize: r.decodedBodySize || 0,
      duration: r.duration,
      startTime: r.startTime,
      fetchStart: r.fetchStart,
      domainLookupStart: r.domainLookupStart,
      domainLookupEnd: r.domainLookupEnd,
      connectStart: r.connectStart,
      connectEnd: r.connectEnd,
      secureConnectionStart: r.secureConnectionStart || 0,
      requestStart: r.requestStart,
      responseStart: r.responseStart || 0,
      responseEnd: r.responseEnd,
      renderBlockingStatus: r.renderBlockingStatus || '',
    })))`,
    returnByValue: false,
  });
  const resourceEntries = safeJsonParse(resEntriesResult.value, []);

  // Resource summary (aggregated)
  const resourceSummary = {};
  for (const r of resourceEntries) {
    const type = r.initiatorType || 'other';
    if (!resourceSummary[type]) resourceSummary[type] = { count: 0, size: 0, time: 0 };
    resourceSummary[type].count++;
    resourceSummary[type].size += r.transferSize;
    resourceSummary[type].time = Math.max(resourceSummary[type].time, r.duration);
  }

  // CPU profile (per-script execution time)
  const { profile } = await cdp.send('Profiler.stop');
  _profilerStarted = false;

  const nodeMap = new Map();
  for (const node of profile.nodes) {
    nodeMap.set(node.id, node);
  }

  // Aggregate sample time per script URL from profile samples + timeDeltas
  const execTimeByUrl = new Map();
  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      const node = nodeMap.get(profile.samples[i]);
      if (!node) continue;
      const url = node.callFrame.url;
      if (!url) continue;
      // timeDeltas are in microseconds
      const us = profile.timeDeltas[i] || 0;
      execTimeByUrl.set(url, (execTimeByUrl.get(url) || 0) + us);
    }
  }

  // JS Coverage
  const coverageResult = await cdp.send('Profiler.takePreciseCoverage');
  await cdp.send('Profiler.stopPreciseCoverage');
  await cdp.send('Profiler.disable');

  const jsCoverage = coverageResult.result.map((entry) => {
    // Collect all ranges and merge overlapping ones to avoid double-counting
    const allRanges = [];
    for (const fn of entry.functions) {
      for (const range of fn.ranges) {
        allRanges.push([range.startOffset, range.endOffset]);
      }
    }
    allRanges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    let used = 0;
    let mergedEnd = 0;
    for (const [start, end] of allRanges) {
      const effectiveStart = Math.max(start, mergedEnd);
      if (effectiveStart < end) {
        used += end - effectiveStart;
        mergedEnd = end;
      }
    }

    const total = entry.source ? entry.source.length : 0;
    // If source not available, estimate from max end offset
    const estimatedTotal = total || allRanges.reduce((max, r) => r[1] > max ? r[1] : max, 0);
    used = Math.min(used, estimatedTotal);
    const unused = estimatedTotal - used;
    // Execution time in ms (from CPU profile, microseconds → ms)
    const execTimeUs = execTimeByUrl.get(entry.url) || 0;
    return {
      url: entry.url,
      total: estimatedTotal,
      used,
      unused,
      unusedPct: estimatedTotal > 0 ? (unused / estimatedTotal * 100) : 0,
      execTime: execTimeUs / 1000,
    };
  }).filter(e => e.url && e.total > 0 && !e.url.startsWith('chrome-error://') && !e.url.startsWith('chrome-extension://'));

  // Aggregate inline scripts that share the page URL into a single entry
  const jsCoverageGrouped = [];
  const inlineEntries = [];
  const pageUrls = new Set([targetUrl, nav.name]);
  for (const e of jsCoverage) {
    // Inline scripts have the page URL rather than a separate .js URL
    if (pageUrls.has(e.url)) {
      inlineEntries.push(e);
    } else {
      jsCoverageGrouped.push(e);
    }
  }
  if (inlineEntries.length > 0) {
    const total = inlineEntries.reduce((s, e) => s + e.total, 0);
    const used = inlineEntries.reduce((s, e) => s + e.used, 0);
    const unused = total - used;
    const execTime = inlineEntries.reduce((s, e) => s + e.execTime, 0);
    jsCoverageGrouped.push({
      url: `(inline <script>) × ${inlineEntries.length}`,
      total,
      used,
      unused,
      unusedPct: total > 0 ? (unused / total * 100) : 0,
      execTime,
    });
  }

  // Preload links from DOM
  const { result: preloadResult } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify(Array.from(document.querySelectorAll('link[rel=preload]')).map(l => ({
      href: l.href,
      as: l.getAttribute('as') || '',
    })))`,
    returnByValue: false,
  });
  const preloadLinks = safeJsonParse(preloadResult.value);

  // Rendering metrics from CDP Performance domain
  const { metrics: perfMetrics } = await cdp.send('Performance.getMetrics');
  const renderMetrics = {};
  const memoryInfo = { jsHeapUsed: 0, jsHeapTotal: 0, domNodeCount: 0 };
  for (const m of perfMetrics) {
    if (['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration',
      'LayoutCount', 'RecalcStyleCount'].includes(m.name)) {
      // Durations are in seconds, convert to ms
      renderMetrics[m.name] = m.name.endsWith('Duration') ? m.value * 1000 : m.value;
    }
    if (m.name === 'JSHeapUsedSize') memoryInfo.jsHeapUsed = m.value;
    if (m.name === 'JSHeapTotalSize') memoryInfo.jsHeapTotal = m.value;
  }

  // DOM node count
  const { result: domCountResult } = await cdp.send('Runtime.evaluate', {
    expression: 'document.querySelectorAll("*").length',
    returnByValue: true,
  });
  memoryInfo.domNodeCount = domCountResult.value || 0;

  // Reset CPU throttling
  if (options.cpuThrottle && options.cpuThrottle > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }

  return {
    connectionInfo,
    nav,
    vitals,
    tbt,
    longTaskDetails,
    tbtByScript,
    resourceEntries,
    resourceSummary,
    jsCoverage: jsCoverageGrouped,
    inp: vitals.inp,
    inpEntries: vitals.inpEntries,
    renderBlocking: vitals.renderBlocking,
    lcpElement: vitals.lcpElement,
    clsEntries: vitals.clsEntries,
    fontsReady: vitals.fontsReady || 0,
    preloadLinks,
    serverTiming,
    renderMetrics,
    memoryInfo,
  };

  } finally {
    // Clean up profiler/throttle if we exited early (timeout, error)
    if (_profilerStarted) {
      try { await cdp.send('Profiler.stop'); } catch {}
      try { await cdp.send('Profiler.stopPreciseCoverage'); } catch {}
      try { await cdp.send('Profiler.disable'); } catch {}
      if (options.cpuThrottle && options.cpuThrottle > 1) {
        try { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); } catch {}
      }
    }
  }
}
