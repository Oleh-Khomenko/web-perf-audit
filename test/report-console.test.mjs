import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { printReport, formatMetric, formatTiming, GREEN, YELLOW, RED, DIM, RESET } from '../src/report-console.mjs';
import { makeReportData, makeMeta } from './fixtures.mjs';

// ── formatMetric ──

describe('formatMetric', () => {
  it('returns string with metric name and value', () => {
    const result = formatMetric('TTFB', 500, 'ms', 800, 1800, 'Time to First Byte');
    assert.ok(result.includes('TTFB'));
    assert.ok(result.includes('Time to First Byte'));
  });

  it('shows Good rating for good values', () => {
    const result = formatMetric('TTFB', 100, 'ms', 800, 1800, 'desc');
    assert.ok(result.includes('Good'));
    assert.ok(result.includes(GREEN));
  });

  it('shows Needs Work rating for moderate values', () => {
    const result = formatMetric('TTFB', 1000, 'ms', 800, 1800, 'desc');
    assert.ok(result.includes('Needs work'));
    assert.ok(result.includes(YELLOW));
  });

  it('shows Poor rating for poor values', () => {
    const result = formatMetric('TTFB', 2000, 'ms', 800, 1800, 'desc');
    assert.ok(result.includes('Poor'));
    assert.ok(result.includes(RED));
  });

  it('formats score unit with 3 decimal places', () => {
    const result = formatMetric('CLS', 0.05, 'score', 0.1, 0.25, 'desc');
    assert.ok(result.includes('0.050'));
  });
});

// ── formatTiming ──

describe('formatTiming', () => {
  it('returns string with name and formatted ms', () => {
    const result = formatTiming('DNS Lookup', 25, 'Time to resolve');
    assert.ok(result.includes('DNS Lookup'));
    assert.ok(result.includes('Time to resolve'));
  });

  it('works without explanation', () => {
    const result = formatTiming('TCP', 10);
    assert.ok(result.includes('TCP'));
    assert.ok(!result.includes(DIM));
  });
});

// ── printReport basic structure ──

describe('printReport', () => {
  it('returns non-empty string', () => {
    const output = printReport(makeReportData(), makeMeta());
    assert.ok(output.length > 0);
  });

  it('contains Navigation Timing section', () => {
    const output = printReport(makeReportData(), makeMeta());
    assert.ok(output.includes('Navigation Timing'));
  });

  it('contains Web Vitals section', () => {
    const output = printReport(makeReportData(), makeMeta());
    assert.ok(output.includes('Web Vitals'));
  });

  it('contains Score', () => {
    const output = printReport(makeReportData(), makeMeta());
    assert.ok(output.includes('Score'));
  });

  it('contains TTFB Breakdown', () => {
    const output = printReport(makeReportData(), makeMeta());
    assert.ok(output.includes('TTFB Breakdown'));
  });

  it('contains FCP Breakdown', () => {
    const output = printReport(makeReportData(), makeMeta());
    assert.ok(output.includes('FCP Breakdown'));
  });

  it('contains LCP Breakdown', () => {
    const output = printReport(makeReportData(), makeMeta());
    assert.ok(output.includes('LCP Breakdown'));
  });

  it('contains Resource Summary', () => {
    const output = printReport(makeReportData(), makeMeta());
    assert.ok(output.includes('Resource Summary'));
  });

  it('contains JS Coverage section', () => {
    const output = printReport(makeReportData(), makeMeta());
    assert.ok(output.includes('JS Coverage'));
  });

  it('contains Waterfall section', () => {
    const output = printReport(makeReportData(), makeMeta());
    assert.ok(output.includes('Waterfall'));
  });
});

// ── Sections with data ──

describe('printReport with data', () => {
  it('shows resource summary entries', () => {
    const output = printReport(makeReportData({
      resourceSummary: { script: { count: 3, size: 50000, time: 200 }, css: { count: 1, size: 10000, time: 50 } },
    }), makeMeta());
    assert.ok(output.includes('script'));
    assert.ok(output.includes('css'));
  });

  it('shows JS coverage entries', () => {
    const output = printReport(makeReportData({
      jsCoverage: [{ url: 'https://example.com/app.js', total: 10000, used: 6000, unused: 4000, unusedPct: 40, execTime: 15 }],
    }), makeMeta());
    assert.ok(output.includes('app.js'));
  });

  it('shows long task details in TBT section', () => {
    const output = printReport(makeReportData({
      tbt: 120,
      longTaskDetails: [{ scriptUrl: 'https://cdn.example.com/bundle.js', invoker: '', startTime: 200, duration: 170, blockingTime: 120 }],
      tbtByScript: [{ scriptUrl: 'https://cdn.example.com/bundle.js', totalBlockingTime: 120, count: 1 }],
    }), makeMeta());
    assert.ok(output.includes('bundle.js'));
    assert.ok(output.includes('120'));
  });

  it('shows render-blocking resources', () => {
    const output = printReport(makeReportData({
      renderBlocking: [{ name: 'https://example.com/style.css', initiatorType: 'link', transferSize: 5000, duration: 30 }],
    }), makeMeta());
    assert.ok(output.includes('style.css'));
  });

  it('shows LCP element info', () => {
    const output = printReport(makeReportData({
      lcpElement: { tagName: 'IMG', id: 'hero', size: 100000, url: 'https://example.com/hero.jpg' },
    }), makeMeta());
    assert.ok(output.includes('img'));
    assert.ok(output.includes('hero'));
  });

  it('shows CLS breakdown with shifts', () => {
    const output = printReport(makeReportData({
      vitals: { fcp: 120, lcp: 200, cls: 0.15, inp: 0, clsEntries: [], inpEntries: [], longTasks: [], renderBlocking: [], fontsReady: 100, lcpElement: null },
      clsEntries: [
        { value: 0.15, startTime: 500, hadRecentInput: false, sources: [{ selector: 'div.banner' }] },
      ],
    }), makeMeta());
    assert.ok(output.includes('div.banner'));
  });
});

// ── Edge cases ──

describe('printReport edge cases', () => {
  it('handles empty resourceEntries', () => {
    const output = printReport(makeReportData({ resourceEntries: [] }), makeMeta());
    assert.ok(output.includes('Resource Summary'));
  });

  it('handles empty longTaskDetails', () => {
    const output = printReport(makeReportData({ longTaskDetails: [], tbt: 0 }), makeMeta());
    assert.ok(output.includes('No long tasks'));
  });

  it('handles null lcpElement', () => {
    const output = printReport(makeReportData({ lcpElement: null }), makeMeta());
    assert.ok(output.includes('LCP Breakdown'));
  });

  it('shows INP not measured message', () => {
    const output = printReport(makeReportData({ inpMeasured: false }), makeMeta());
    assert.ok(output.includes('Not measured') || output.includes('N/A'));
  });

  it('handles empty clsEntries with near-zero CLS', () => {
    const output = printReport(makeReportData({
      vitals: { fcp: 120, lcp: 200, cls: 0, inp: 0, clsEntries: [], inpEntries: [], longTasks: [], renderBlocking: [], fontsReady: 100, lcpElement: null },
      clsEntries: [],
    }), makeMeta());
    assert.ok(output.includes('near-zero'));
  });

  it('skips Memory section when memoryInfo is null', () => {
    const output = printReport(makeReportData({ memoryInfo: null }), makeMeta());
    assert.ok(!output.includes('Memory & DOM'));
  });

  it('shows Memory section when memoryInfo is present', () => {
    const output = printReport(makeReportData({
      memoryInfo: { jsHeapUsed: 5000000, jsHeapTotal: 10000000, domNodeCount: 500 },
    }), makeMeta());
    assert.ok(output.includes('Memory & DOM'));
    assert.ok(output.includes('500'));
  });

  it('skips render metrics when null', () => {
    const output = printReport(makeReportData({ renderMetrics: null }), makeMeta());
    assert.ok(!output.includes('rendering cost'));
  });

  it('shows render metrics when present', () => {
    const output = printReport(makeReportData({
      renderMetrics: { LayoutDuration: 0.05, LayoutCount: 10, RecalcStyleDuration: 0.03, RecalcStyleCount: 5 },
    }), makeMeta());
    assert.ok(output.includes('rendering cost'));
  });
});

// ── Meta options ──

describe('printReport meta options', () => {
  it('shows device info', () => {
    const output = printReport(makeReportData(), makeMeta({
      device: { label: 'Mobile', width: 375, height: 812, mobile: true },
    }));
    assert.ok(output.includes('Mobile'));
    assert.ok(output.includes('touch'));
  });

  it('shows network throttle info', () => {
    const output = printReport(makeReportData(), makeMeta({
      throttle: { label: '3G', latency: 150, downloadThroughput: 204800, uploadThroughput: 76800 },
    }));
    assert.ok(output.includes('3G'));
    assert.ok(output.includes('Network'));
  });

  it('shows CPU throttle info', () => {
    const output = printReport(makeReportData(), makeMeta({ cpuThrottle: 4 }));
    assert.ok(output.includes('4x slowdown'));
  });

  it('shows calibration info', () => {
    const output = printReport(makeReportData(), makeMeta({
      cpuThrottle: 2,
      calibration: { measuredMs: 120, referenceMs: 60, deviceLabel: 'Pixel 5' },
    }));
    assert.ok(output.includes('Calibrated'));
    assert.ok(output.includes('Pixel 5'));
  });
});
