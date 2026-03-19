/**
 * Pure utility functions extracted from audit.mjs for testability.
 */

export function safeJsonParse(value, fallback = null) {
  try { return JSON.parse(value); }
  catch { return fallback; }
}

/**
 * Compute CLS per spec: largest session window value (gap <= 1s, max 5s span).
 * @param {Array} clsEntries - Layout shift entries from PerformanceObserver
 * @returns {number} Max session window CLS value
 */
export function computeClsFromEntries(clsEntries) {
  const shifts = clsEntries
    .filter(e => !e.hadRecentInput)
    .sort((a, b) => a.startTime - b.startTime);
  let maxWindowValue = 0;
  if (shifts.length === 0) return 0;

  let winStart = shifts[0].startTime;
  let winValue = shifts[0].value;
  let prevEnd = shifts[0].startTime + (shifts[0].duration || 0);
  for (let i = 1; i < shifts.length; i++) {
    const s = shifts[i];
    const gap = s.startTime - prevEnd;
    const span = (s.startTime + (s.duration || 0)) - winStart;
    if (gap <= 1000 && span <= 5000) {
      winValue += s.value;
    } else {
      if (winValue > maxWindowValue) maxWindowValue = winValue;
      winStart = s.startTime;
      winValue = s.value;
    }
    prevEnd = s.startTime + (s.duration || 0);
  }
  if (winValue > maxWindowValue) maxWindowValue = winValue;
  return maxWindowValue;
}

/**
 * Compute TBT blocking time for a single long task, clipped to FCP boundary.
 */
export function tbtBlockingTime(lt, fcp) {
  const taskEnd = lt.startTime + lt.duration;
  if (taskEnd <= fcp) return 0;
  const clippedDuration = taskEnd - Math.max(lt.startTime, fcp);
  return Math.max(0, clippedDuration - 50);
}

/**
 * Compute TBT and per-script aggregation from long task details.
 * @returns {{ tbt: number, tbtByScript: Array }}
 */
export function computeTbt(longTasks, fcp) {
  const tbt = longTasks.reduce((sum, lt) => sum + tbtBlockingTime(lt, fcp), 0);

  const longTasksAfterFcp = longTasks.filter(lt => lt.startTime + lt.duration > fcp);
  const tbtByScriptMap = new Map();
  for (const lt of longTasksAfterFcp) {
    const key = lt.scriptUrl || lt.invoker || '';
    const entry = tbtByScriptMap.get(key) || { scriptUrl: key, totalBlockingTime: 0, count: 0 };
    entry.totalBlockingTime += tbtBlockingTime(lt, fcp);
    entry.count++;
    tbtByScriptMap.set(key, entry);
  }
  const tbtByScript = [...tbtByScriptMap.values()].sort((a, b) => b.totalBlockingTime - a.totalBlockingTime);

  return { tbt, tbtByScript };
}

/**
 * Merge overlapping JS coverage ranges and compute used/unused bytes.
 */
export function processCoverageEntry(entry, execTimeUs = 0) {
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
  const estimatedTotal = total || allRanges.reduce((max, r) => r[1] > max ? r[1] : max, 0);
  used = Math.min(used, estimatedTotal);
  const unused = estimatedTotal - used;

  return {
    url: entry.url,
    total: estimatedTotal,
    used,
    unused,
    unusedPct: estimatedTotal > 0 ? (unused / estimatedTotal * 100) : 0,
    execTime: execTimeUs / 1000,
  };
}

/**
 * Aggregate inline scripts that share the page URL into a single entry.
 */
export function aggregateInlineScripts(jsCoverage, pageUrls) {
  const grouped = [];
  const inlineEntries = [];
  for (const e of jsCoverage) {
    if (pageUrls.has(e.url)) {
      inlineEntries.push(e);
    } else {
      grouped.push(e);
    }
  }
  if (inlineEntries.length > 0) {
    const total = inlineEntries.reduce((s, e) => s + e.total, 0);
    const used = inlineEntries.reduce((s, e) => s + e.used, 0);
    const unused = total - used;
    const execTime = inlineEntries.reduce((s, e) => s + e.execTime, 0);
    grouped.push({
      url: `(inline <script>) × ${inlineEntries.length}`,
      total,
      used,
      unused,
      unusedPct: total > 0 ? (unused / total * 100) : 0,
      execTime,
    });
  }
  return grouped;
}

/**
 * Build resource summary aggregated by initiatorType.
 */
export function buildResourceSummary(resourceEntries) {
  const summary = {};
  for (const r of resourceEntries) {
    const type = r.initiatorType || 'other';
    if (!summary[type]) summary[type] = { count: 0, size: 0, time: 0 };
    summary[type].count++;
    summary[type].size += r.transferSize;
    summary[type].time = Math.max(summary[type].time, r.duration);
  }
  return summary;
}
