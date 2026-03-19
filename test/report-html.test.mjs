import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateHtml } from '../src/report-html.mjs';
import { makeReportData, makeMeta } from './fixtures.mjs';

// ── Basic rendering ──

describe('generateHtml', () => {
  it('returns valid HTML structure', () => {
    const html = generateHtml(makeReportData(), makeMeta());
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('</html>'));
    assert.ok(html.includes('<head>'));
    assert.ok(html.includes('<body'));
  });

  it('contains the target URL', () => {
    const html = generateHtml(makeReportData(), makeMeta({ url: 'https://example.com' }));
    assert.ok(html.includes('https://example.com'));
  });

  it('contains Web Vitals section', () => {
    const html = generateHtml(makeReportData(), makeMeta());
    assert.ok(html.includes('Web Vitals'));
  });

  it('contains metric values', () => {
    const html = generateHtml(makeReportData({ vitals: { fcp: 1500, lcp: 2500, cls: 0.12, inp: 0, clsEntries: [], inpEntries: [], longTasks: [], renderBlocking: [], fontsReady: 100, lcpElement: null } }), makeMeta());
    assert.ok(html.includes('1.50s') || html.includes('1500'));
  });

  it('contains score', () => {
    const html = generateHtml(makeReportData(), makeMeta());
    // Score should be a number somewhere in the HTML
    assert.ok(/\b\d{1,3}\b/.test(html));
  });
});

// ── Edge cases ──

describe('generateHtml edge cases', () => {
  it('does not crash with empty resourceEntries', () => {
    const html = generateHtml(makeReportData({ resourceEntries: [] }), makeMeta());
    assert.ok(html.includes('</html>'));
  });

  it('does not crash with null lcpElement', () => {
    const html = generateHtml(makeReportData({ lcpElement: null }), makeMeta());
    assert.ok(html.includes('</html>'));
  });

  it('does not crash with empty jsCoverage', () => {
    const html = generateHtml(makeReportData({ jsCoverage: [] }), makeMeta());
    assert.ok(html.includes('</html>'));
  });

  it('renders multi-run data', () => {
    const data = makeReportData();
    const allResults = [data, data, data];
    const meta = makeMeta({
      numRuns: 3,
      allResults,
      medianVitals: { ttfb: 50, fcp: 120, lcp: 200, cls: 0.05, tbt: 50, inp: null },
    });
    const html = generateHtml(data, meta);
    assert.ok(html.includes('</html>'));
    assert.ok(html.includes('Median') || html.includes('median') || html.includes('Run'));
  });
});

// ── HTML escaping ──

describe('generateHtml escaping', () => {
  it('escapes URL with HTML characters', () => {
    const meta = makeMeta({ url: 'https://example.com/<script>alert(1)</script>' });
    const html = generateHtml(makeReportData(), meta);
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});
