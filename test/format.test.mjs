import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeScore,
  computeOverallScore,
  rate,
  fmtMs,
  fmtBytes,
  truncUrl,
  buildClsSessionWindows,
  computeFcpPhases,
  computeLcpPhases,
  computeInpPhases,
  computeResourcePhases,
  median,
} from '../src/format.mjs';

// ── computeScore ──

describe('computeScore', () => {
  it('returns 1 for value=0', () => {
    assert.equal(computeScore(0, 200, 600), 1);
  });

  it('returns ~0.5 for value=median', () => {
    const score = computeScore(600, 200, 600);
    assert.ok(Math.abs(score - 0.5) < 0.05, `expected ~0.5, got ${score}`);
  });

  it('returns ~0.9 for value=p10', () => {
    const score = computeScore(200, 200, 600);
    assert.ok(Math.abs(score - 0.9) < 0.05, `expected ~0.9, got ${score}`);
  });

  it('returns ~0 for very large value', () => {
    const score = computeScore(100000, 200, 600);
    assert.ok(score < 0.05, `expected ~0, got ${score}`);
  });

  it('handles p10 === median (sigma=0)', () => {
    assert.equal(computeScore(100, 500, 500), 1);
    assert.equal(computeScore(500, 500, 500), 1);
    assert.equal(computeScore(600, 500, 500), 0);
  });
});

// ── computeOverallScore ──

describe('computeOverallScore', () => {
  it('returns ~100 for all good metrics', () => {
    const score = computeOverallScore({
      ttfb: 0, fcp: 0, lcp: 0, tbt: 0, cls: 0, inp: 0, _inpMeasured: true,
    });
    assert.ok(score >= 95, `expected ~100, got ${score}`);
  });

  it('returns <50 for all poor metrics', () => {
    const score = computeOverallScore({
      ttfb: 5000, fcp: 8000, lcp: 10000, tbt: 2000, cls: 1.0, inp: 2000, _inpMeasured: true,
    });
    assert.ok(score < 50, `expected <50, got ${score}`);
  });

  it('skips INP when unmeasured (inp=0, _inpMeasured=false)', () => {
    const withInp = computeOverallScore({
      ttfb: 100, fcp: 1000, lcp: 2000, tbt: 100, cls: 0.05, inp: 0, _inpMeasured: true,
    });
    const withoutInp = computeOverallScore({
      ttfb: 100, fcp: 1000, lcp: 2000, tbt: 100, cls: 0.05, inp: 0, _inpMeasured: false,
    });
    // Both should be high but may differ slightly due to weight redistribution
    assert.ok(withInp >= 80);
    assert.ok(withoutInp >= 80);
  });

  it('returns 0 for all null metrics', () => {
    assert.equal(computeOverallScore({}), 0);
  });

  it('scores with only one metric', () => {
    const score = computeOverallScore({ fcp: 1000 });
    assert.ok(score > 0 && score <= 100, `expected valid score, got ${score}`);
  });
});

// ── rate ──

describe('rate', () => {
  it('returns Good for value <= good', () => {
    assert.deepEqual(rate(100, 200, 400), { label: 'Good', color: 'green' });
  });

  it('returns Good at boundary value === good', () => {
    assert.deepEqual(rate(200, 200, 400), { label: 'Good', color: 'green' });
  });

  it('returns Needs work for good < value <= poor', () => {
    assert.deepEqual(rate(300, 200, 400), { label: 'Needs work', color: 'yellow' });
  });

  it('returns Needs work at boundary value === poor', () => {
    assert.deepEqual(rate(400, 200, 400), { label: 'Needs work', color: 'yellow' });
  });

  it('returns Poor for value > poor', () => {
    assert.deepEqual(rate(500, 200, 400), { label: 'Poor', color: 'red' });
  });
});

// ── fmtMs ──

describe('fmtMs', () => {
  it('returns dash for null', () => assert.equal(fmtMs(null), '—'));
  it('returns dash for NaN', () => assert.equal(fmtMs(NaN), '—'));
  it('returns dash for Infinity', () => assert.equal(fmtMs(Infinity), '—'));
  it('formats ms under 1s', () => assert.equal(fmtMs(500), '500ms'));
  it('formats ms at 1s boundary', () => assert.equal(fmtMs(1000), '1.00s'));
  it('formats ms over 1s', () => assert.equal(fmtMs(2500), '2.50s'));
});

// ── fmtBytes ──

describe('fmtBytes', () => {
  it('returns dash for null', () => assert.equal(fmtBytes(null), '—'));
  it('returns dash for NaN', () => assert.equal(fmtBytes(NaN), '—'));
  it('formats bytes', () => assert.equal(fmtBytes(500), '500B'));
  it('formats KB', () => assert.equal(fmtBytes(2048), '2.0KB'));
  it('formats MB', () => assert.equal(fmtBytes(2 * 1024 * 1024), '2.0MB'));
});

// ── truncUrl ──

describe('truncUrl', () => {
  it('returns short URL unchanged', () => {
    assert.equal(truncUrl('https://example.com'), 'https://example.com');
  });

  it('truncates long URL with ellipsis', () => {
    const long = 'https://example.com/' + 'a'.repeat(100);
    const result = truncUrl(long, 60);
    assert.ok(result.length <= 60);
    assert.ok(result.startsWith('...'));
  });
});

// ── buildClsSessionWindows ──

describe('buildClsSessionWindows', () => {
  it('returns empty for empty array', () => {
    assert.deepEqual(buildClsSessionWindows([]), []);
  });

  it('filters out entries with hadRecentInput', () => {
    const entries = [
      { startTime: 100, value: 0.1, hadRecentInput: true },
    ];
    assert.deepEqual(buildClsSessionWindows(entries), []);
  });

  it('creates new window on gap > 1s', () => {
    const entries = [
      { startTime: 100, value: 0.05, hadRecentInput: false, duration: 0 },
      { startTime: 2000, value: 0.1, hadRecentInput: false, duration: 0 },
    ];
    const windows = buildClsSessionWindows(entries);
    assert.equal(windows.length, 2);
  });

  it('creates new window on span > 5s', () => {
    const entries = [
      { startTime: 0, value: 0.05, hadRecentInput: false, duration: 0 },
      { startTime: 500, value: 0.05, hadRecentInput: false, duration: 0 },
      { startTime: 5500, value: 0.1, hadRecentInput: false, duration: 0 },
    ];
    const windows = buildClsSessionWindows(entries);
    assert.equal(windows.length, 2);
  });

  it('sorts windows by value descending', () => {
    const entries = [
      { startTime: 0, value: 0.01, hadRecentInput: false, duration: 0 },
      { startTime: 5000, value: 0.2, hadRecentInput: false, duration: 0 },
    ];
    const windows = buildClsSessionWindows(entries);
    assert.ok(windows[0].value >= windows[1].value);
  });
});

// ── computeFcpPhases ──

describe('computeFcpPhases', () => {
  const nav = {
    startTime: 0,
    responseStart: 50,
    responseEnd: 60,
    domInteractive: 80,
    domContentLoadedEventEnd: 90,
  };

  it('computes TTFB = responseStart - startTime', () => {
    const phases = computeFcpPhases(nav, 100, []);
    const ttfb = phases.find(([n]) => n === 'TTFB');
    assert.equal(ttfb[1], 50);
  });

  it('phases sum to FCP', () => {
    const phases = computeFcpPhases(nav, 100, []);
    const sum = phases.reduce((s, [, dur]) => s + dur, 0);
    assert.ok(Math.abs(sum - 100) < 0.01, `sum ${sum} !== fcp 100`);
  });

  it('has no blocking resources phase when none exist', () => {
    const phases = computeFcpPhases(nav, 100, []);
    const blocking = phases.find(([n]) => n === 'Blocking Resources');
    assert.equal(blocking, undefined);
  });

  it('htmlParse does not exceed fcp - ttfb - blockingDuration', () => {
    const phases = computeFcpPhases(nav, 100, []);
    const htmlParse = phases.find(([n]) => n === 'HTML Parse');
    if (htmlParse) {
      assert.ok(htmlParse[1] <= 100 - 50);
    }
  });
});

// ── computeLcpPhases ──

describe('computeLcpPhases', () => {
  const nav = {
    startTime: 0,
    responseStart: 50,
    responseEnd: 60,
    domInteractive: 80,
    domContentLoadedEventEnd: 90,
  };

  it('handles text node (no URL)', () => {
    const result = computeLcpPhases(nav, 200, { tagName: 'H1', size: 1000, url: '' }, [], []);
    const ttfb = result.phases.find(([n]) => n === 'TTFB');
    assert.equal(ttfb[1], 50);
    const sum = result.phases.reduce((s, [, dur]) => s + dur, 0);
    assert.ok(Math.abs(sum - 200) < 0.01, `sum ${sum} !== lcp 200`);
  });

  it('handles image with resource entry', () => {
    const lcpElement = { tagName: 'IMG', size: 5000, url: 'https://example.com/img.jpg' };
    const resources = [
      { name: 'https://example.com/img.jpg', startTime: 60, responseEnd: 150 },
    ];
    const result = computeLcpPhases(nav, 300, lcpElement, resources, []);
    const delay = result.phases.find(([n]) => n === 'LCP Resource Delay');
    const download = result.phases.find(([n]) => n === 'LCP Resource Download');
    assert.ok(delay, 'should have resource delay phase');
    assert.ok(download, 'should have resource download phase');
    const sum = result.phases.reduce((s, [, dur]) => s + dur, 0);
    assert.ok(Math.abs(sum - 300) < 0.01, `sum ${sum} !== lcp 300`);
  });

  it('phases sum to LCP', () => {
    const result = computeLcpPhases(nav, 200, null, [], []);
    const sum = result.phases.reduce((s, [, dur]) => s + dur, 0);
    assert.ok(Math.abs(sum - 200) < 0.01, `sum ${sum} !== lcp 200`);
  });
});

// ── computeInpPhases ──

describe('computeInpPhases', () => {
  it('returns null for empty array', () => {
    assert.equal(computeInpPhases([]), null);
    assert.equal(computeInpPhases(null), null);
  });

  it('returns phases for a single interaction', () => {
    const entries = [{
      interactionId: 1,
      duration: 100,
      inputDelay: 20,
      processingTime: 50,
      presentationDelay: 30,
      startTime: 1000,
      name: 'click',
      target: 'button',
    }];
    const result = computeInpPhases(entries);
    assert.ok(result);
    assert.equal(result.phases.length, 3);
    assert.equal(result.phases[0][0], 'Input Delay');
    assert.equal(result.phases[1][0], 'Processing Time');
    assert.equal(result.phases[2][0], 'Presentation Delay');
  });

  it('picks worst duration among multiple interactions', () => {
    const entries = [
      { interactionId: 1, duration: 50, inputDelay: 10, processingTime: 30, presentationDelay: 10, startTime: 1000, name: 'click' },
      { interactionId: 2, duration: 200, inputDelay: 50, processingTime: 100, presentationDelay: 50, startTime: 2000, name: 'keydown' },
    ];
    const result = computeInpPhases(entries);
    assert.equal(result.interaction.duration, 200);
    assert.equal(result.interaction.name, 'keydown');
  });
});

// ── computeResourcePhases ──

describe('computeResourcePhases', () => {
  it('computes all phases for a full resource', () => {
    const r = {
      startTime: 0,
      fetchStart: 2,
      domainLookupStart: 5,
      domainLookupEnd: 10,
      connectStart: 10,
      secureConnectionStart: 12,
      connectEnd: 15,
      requestStart: 15,
      responseStart: 25,
      responseEnd: 50,
    };
    const phases = computeResourcePhases(r);
    const names = phases.map(p => p.name);
    assert.ok(names.includes('Queueing'));
    assert.ok(names.includes('DNS Lookup'));
    assert.ok(names.includes('TCP'));
    assert.ok(names.includes('TLS'));
    assert.ok(names.includes('Waiting (TTFB)'));
    assert.ok(names.includes('Content Download'));
  });

  it('omits TLS when no secure connection', () => {
    const r = {
      startTime: 0,
      fetchStart: 0,
      domainLookupStart: 0,
      domainLookupEnd: 0,
      connectStart: 0,
      secureConnectionStart: 0,
      connectEnd: 5,
      requestStart: 5,
      responseStart: 15,
      responseEnd: 30,
    };
    const phases = computeResourcePhases(r);
    const names = phases.map(p => p.name);
    assert.ok(!names.includes('TLS'));
  });

  it('filters phases < 0.5ms', () => {
    const r = {
      startTime: 0,
      fetchStart: 0,
      domainLookupStart: 0,
      domainLookupEnd: 0.3,
      connectStart: 0.3,
      secureConnectionStart: 0,
      connectEnd: 0.3,
      requestStart: 0.3,
      responseStart: 10,
      responseEnd: 20,
    };
    const phases = computeResourcePhases(r);
    const names = phases.map(p => p.name);
    assert.ok(!names.includes('DNS Lookup'));
  });
});

// ── median ──

describe('median', () => {
  it('returns median of odd-length array', () => {
    assert.equal(median([3, 1, 2]), 2);
  });

  it('returns average of middle two for even-length array', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  it('returns 0 for empty array', () => {
    assert.equal(median([]), 0);
  });
});
