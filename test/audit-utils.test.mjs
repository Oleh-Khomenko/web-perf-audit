import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeJsonParse,
  computeClsFromEntries,
  tbtBlockingTime,
  computeTbt,
  processCoverageEntry,
  aggregateInlineScripts,
  buildResourceSummary,
} from '../src/audit-utils.mjs';

// ── safeJsonParse ──

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
  });

  it('returns fallback for invalid JSON', () => {
    assert.equal(safeJsonParse('not json', 'fallback'), 'fallback');
  });

  it('returns null fallback by default', () => {
    assert.equal(safeJsonParse(undefined), null);
  });

  it('parses arrays', () => {
    assert.deepEqual(safeJsonParse('[1,2,3]'), [1, 2, 3]);
  });
});

// ── computeClsFromEntries ──

describe('computeClsFromEntries', () => {
  it('returns 0 for empty entries', () => {
    assert.equal(computeClsFromEntries([]), 0);
  });

  it('filters out entries with hadRecentInput', () => {
    const entries = [
      { startTime: 100, value: 0.5, hadRecentInput: true, duration: 0 },
    ];
    assert.equal(computeClsFromEntries(entries), 0);
  });

  it('returns single shift value', () => {
    const entries = [
      { startTime: 100, value: 0.1, hadRecentInput: false, duration: 0 },
    ];
    assert.equal(computeClsFromEntries(entries), 0.1);
  });

  it('sums shifts within same session window', () => {
    const entries = [
      { startTime: 100, value: 0.05, hadRecentInput: false, duration: 0 },
      { startTime: 600, value: 0.03, hadRecentInput: false, duration: 0 },
    ];
    const result = computeClsFromEntries(entries);
    assert.ok(Math.abs(result - 0.08) < 0.001);
  });

  it('starts new window on gap > 1s', () => {
    const entries = [
      { startTime: 0, value: 0.02, hadRecentInput: false, duration: 0 },
      { startTime: 2000, value: 0.1, hadRecentInput: false, duration: 0 },
    ];
    assert.equal(computeClsFromEntries(entries), 0.1);
  });

  it('starts new window on span > 5s', () => {
    const entries = [
      { startTime: 0, value: 0.01, hadRecentInput: false, duration: 0 },
      { startTime: 500, value: 0.01, hadRecentInput: false, duration: 0 },
      { startTime: 5500, value: 0.05, hadRecentInput: false, duration: 0 },
    ];
    assert.equal(computeClsFromEntries(entries), 0.05);
  });
});

// ── tbtBlockingTime ──

describe('tbtBlockingTime', () => {
  it('returns 0 for task ending before FCP', () => {
    assert.equal(tbtBlockingTime({ startTime: 0, duration: 100 }, 200), 0);
  });

  it('returns blocking time for task after FCP', () => {
    // 150ms task, blocking = 150-50 = 100ms
    assert.equal(tbtBlockingTime({ startTime: 300, duration: 150 }, 200), 100);
  });

  it('clips task straddling FCP', () => {
    // Task 100-200, FCP=150. Clipped duration = 200-150 = 50ms. Blocking = 0ms.
    assert.equal(tbtBlockingTime({ startTime: 100, duration: 100 }, 150), 0);
  });

  it('returns 0 for short task (<=50ms)', () => {
    assert.equal(tbtBlockingTime({ startTime: 300, duration: 50 }, 200), 0);
  });
});

// ── computeTbt ──

describe('computeTbt', () => {
  it('returns 0 for no long tasks', () => {
    const { tbt, tbtByScript } = computeTbt([], 100);
    assert.equal(tbt, 0);
    assert.equal(tbtByScript.length, 0);
  });

  it('computes TBT from one long task', () => {
    const tasks = [{ startTime: 200, duration: 150, scriptUrl: 'app.js', invoker: '' }];
    const { tbt } = computeTbt(tasks, 100);
    assert.equal(tbt, 100);
  });

  it('aggregates by scriptUrl', () => {
    const tasks = [
      { startTime: 200, duration: 100, scriptUrl: 'a.js', invoker: '' },
      { startTime: 400, duration: 200, scriptUrl: 'a.js', invoker: '' },
      { startTime: 700, duration: 80, scriptUrl: 'b.js', invoker: '' },
    ];
    const { tbtByScript } = computeTbt(tasks, 100);
    assert.equal(tbtByScript.length, 2);
    const aEntry = tbtByScript.find(e => e.scriptUrl === 'a.js');
    assert.equal(aEntry.count, 2);
    assert.equal(aEntry.totalBlockingTime, 50 + 150); // (100-50) + (200-50)
  });

  it('sorts by totalBlockingTime descending', () => {
    const tasks = [
      { startTime: 200, duration: 80, scriptUrl: 'small.js', invoker: '' },
      { startTime: 400, duration: 300, scriptUrl: 'big.js', invoker: '' },
    ];
    const { tbtByScript } = computeTbt(tasks, 100);
    assert.equal(tbtByScript[0].scriptUrl, 'big.js');
  });
});

// ── processCoverageEntry ──

describe('processCoverageEntry', () => {
  it('computes used/unused from non-overlapping ranges', () => {
    const entry = {
      url: 'app.js',
      source: null,
      functions: [
        { ranges: [{ startOffset: 0, endOffset: 50 }] },
        { ranges: [{ startOffset: 60, endOffset: 100 }] },
      ],
    };
    const result = processCoverageEntry(entry);
    assert.equal(result.used, 90);
    assert.equal(result.total, 100);
    assert.equal(result.unused, 10);
  });

  it('merges overlapping ranges', () => {
    const entry = {
      url: 'app.js',
      source: null,
      functions: [
        { ranges: [{ startOffset: 0, endOffset: 60 }] },
        { ranges: [{ startOffset: 40, endOffset: 100 }] },
      ],
    };
    const result = processCoverageEntry(entry);
    assert.equal(result.used, 100);
  });

  it('handles nested ranges', () => {
    const entry = {
      url: 'app.js',
      source: null,
      functions: [
        { ranges: [{ startOffset: 0, endOffset: 100 }] },
        { ranges: [{ startOffset: 20, endOffset: 50 }] },
      ],
    };
    const result = processCoverageEntry(entry);
    assert.equal(result.used, 100);
  });

  it('converts exec time from microseconds to ms', () => {
    const entry = {
      url: 'app.js',
      source: null,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 100 }] }],
    };
    const result = processCoverageEntry(entry, 5000);
    assert.equal(result.execTime, 5);
  });

  it('uses source.length for total if available', () => {
    const entry = {
      url: 'app.js',
      source: 'x'.repeat(200),
      functions: [{ ranges: [{ startOffset: 0, endOffset: 50 }] }],
    };
    const result = processCoverageEntry(entry);
    assert.equal(result.total, 200);
    assert.equal(result.unused, 150);
  });
});

// ── aggregateInlineScripts ──

describe('aggregateInlineScripts', () => {
  it('groups inline scripts with same page URL', () => {
    const coverage = [
      { url: 'https://example.com', total: 100, used: 60, unused: 40, execTime: 5 },
      { url: 'https://example.com', total: 50, used: 30, unused: 20, execTime: 3 },
      { url: 'https://cdn.example.com/lib.js', total: 200, used: 180, unused: 20, execTime: 10 },
    ];
    const pageUrls = new Set(['https://example.com']);
    const result = aggregateInlineScripts(coverage, pageUrls);

    assert.equal(result.length, 2); // lib.js + aggregated inline
    const inline = result.find(e => e.url.includes('inline'));
    assert.ok(inline);
    assert.equal(inline.total, 150);
    assert.equal(inline.used, 90);
    assert.equal(inline.execTime, 8);
    assert.ok(inline.url.includes('× 2'));
  });

  it('returns unchanged if no inline scripts', () => {
    const coverage = [
      { url: 'https://cdn.example.com/lib.js', total: 200, used: 180, unused: 20, execTime: 10 },
    ];
    const result = aggregateInlineScripts(coverage, new Set(['https://example.com']));
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://cdn.example.com/lib.js');
  });
});

// ── buildResourceSummary ──

describe('buildResourceSummary', () => {
  it('returns empty object for no entries', () => {
    assert.deepEqual(buildResourceSummary([]), {});
  });

  it('aggregates by initiatorType', () => {
    const entries = [
      { initiatorType: 'script', transferSize: 1000, duration: 100 },
      { initiatorType: 'script', transferSize: 2000, duration: 200 },
      { initiatorType: 'img', transferSize: 5000, duration: 50 },
    ];
    const summary = buildResourceSummary(entries);
    assert.equal(summary.script.count, 2);
    assert.equal(summary.script.size, 3000);
    assert.equal(summary.script.time, 200);
    assert.equal(summary.img.count, 1);
    assert.equal(summary.img.size, 5000);
  });

  it('uses "other" for missing initiatorType', () => {
    const entries = [{ transferSize: 100, duration: 10 }];
    const summary = buildResourceSummary(entries);
    assert.equal(summary.other.count, 1);
  });
});
