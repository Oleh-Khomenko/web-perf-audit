import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, DEVICE_PRESETS, THROTTLE_PRESETS } from '../src/cli.mjs';

// ── Basic parsing ──

describe('parseArgs', () => {
  it('parses URL', () => {
    const opts = parseArgs(['http://example.com']);
    assert.equal(opts.url, 'http://example.com');
  });

  it('uses default URL when no args', () => {
    const opts = parseArgs([]);
    assert.equal(opts.url, 'http://localhost:3000');
  });

  it('parses --runs', () => {
    const opts = parseArgs(['--runs', '5']);
    assert.equal(opts.runs, 5);
  });

  it('clamps --runs to minimum 1', () => {
    const opts = parseArgs(['--runs', '0']);
    assert.equal(opts.runs, 1);
  });

  it('parses --parallel', () => {
    const opts = parseArgs(['--parallel']);
    assert.equal(opts.parallel, true);
  });

  it('parses --device mobile', () => {
    const opts = parseArgs(['--device', 'mobile']);
    assert.equal(opts.device, DEVICE_PRESETS.mobile);
  });

  it('parses --device tablet', () => {
    const opts = parseArgs(['--device', 'tablet']);
    assert.equal(opts.device, DEVICE_PRESETS.tablet);
  });

  it('parses --throttle 4g', () => {
    const opts = parseArgs(['--throttle', '4g']);
    assert.equal(opts.throttle, THROTTLE_PRESETS['4g']);
  });

  it('parses --throttle none', () => {
    const opts = parseArgs(['--throttle', 'none']);
    assert.equal(opts.throttle, null);
  });

  it('parses --cpu-throttle', () => {
    const opts = parseArgs(['--cpu-throttle', '4']);
    assert.equal(opts.cpuThrottle, 4);
    assert.equal(opts.cpuThrottleExplicit, true);
  });

  it('parses -h', () => {
    const opts = parseArgs(['-h']);
    assert.equal(opts.help, true);
  });

  it('parses --help', () => {
    const opts = parseArgs(['--help']);
    assert.equal(opts.help, true);
  });

  it('parses --html without path', () => {
    const opts = parseArgs(['--html']);
    assert.equal(opts.htmlOutput, true);
  });

  it('parses --html with path', () => {
    const opts = parseArgs(['--html', 'report.html']);
    assert.equal(opts.htmlOutput, 'report.html');
  });

  it('parses --calibrate without device', () => {
    const opts = parseArgs(['--calibrate']);
    assert.equal(opts.calibrateDevice, 'moto-g-power');
  });

  it('parses --calibrate with device', () => {
    const opts = parseArgs(['--calibrate', 'pixel-7a']);
    assert.equal(opts.calibrateDevice, 'pixel-7a');
  });

  it('parses --calibrate with custom ms', () => {
    const opts = parseArgs(['--calibrate', '500']);
    assert.equal(opts.calibrateDevice, 'custom');
    assert.equal(opts.calibrateCustomMs, 500);
  });
});

// ── Headers and cookies ──

describe('parseArgs headers/cookies', () => {
  it('parses --header', () => {
    const opts = parseArgs(['--header', 'Authorization: Bearer tok']);
    assert.deepEqual(opts.headers, { Authorization: 'Bearer tok' });
  });

  it('parses multiple --cookie', () => {
    const opts = parseArgs(['--cookie', 'a=1', '--cookie', 'b=2']);
    assert.equal(opts.cookies.length, 2);
    assert.deepEqual(opts.cookies[0], { name: 'a', value: '1' });
    assert.deepEqual(opts.cookies[1], { name: 'b', value: '2' });
  });
});

// ── Validation errors ──

describe('parseArgs validation', () => {
  it('throws on unknown device preset', () => {
    assert.throws(() => parseArgs(['--device', 'unknown']), /Unknown device preset/);
  });

  it('throws on unknown throttle preset', () => {
    assert.throws(() => parseArgs(['--throttle', 'unknown']), /Unknown throttle preset/);
  });

  it('throws on cpu-throttle < 1', () => {
    assert.throws(() => parseArgs(['--cpu-throttle', '0.5']), /Invalid CPU throttle rate/);
  });

  it('throws on invalid cpu-throttle', () => {
    assert.throws(() => parseArgs(['--cpu-throttle', 'abc']), /Invalid CPU throttle rate/);
  });

  it('throws on invalid header format', () => {
    assert.throws(() => parseArgs(['--header', 'NoColon']), /Invalid header format/);
  });

  it('throws on invalid cookie format', () => {
    assert.throws(() => parseArgs(['--cookie', 'NoEquals']), /Invalid cookie format/);
  });

  it('throws on invalid URL', () => {
    assert.throws(() => parseArgs(['not-a-url']), /Invalid URL/);
  });

  it('throws on unknown calibration device', () => {
    assert.throws(() => parseArgs(['--calibrate', 'unknown-device']), /Unknown calibration device/);
  });
});

// ── Defaults ──

describe('parseArgs defaults', () => {
  it('has correct defaults', () => {
    const opts = parseArgs([]);
    assert.equal(opts.runs, 1);
    assert.equal(opts.parallel, false);
    assert.equal(opts.device, DEVICE_PRESETS.desktop);
    assert.equal(opts.throttle, null);
    assert.equal(opts.cpuThrottle, 1);
    assert.equal(opts.cpuThrottleExplicit, false);
    assert.equal(opts.calibrateDevice, null);
    assert.equal(opts.htmlOutput, null);
    assert.equal(opts.help, false);
    assert.deepEqual(opts.headers, {});
    assert.deepEqual(opts.cookies, []);
  });
});

// ── Combined args ──

describe('parseArgs combined', () => {
  it('parses all options together', () => {
    const opts = parseArgs([
      'https://example.com',
      '--runs', '3',
      '--parallel',
      '--device', 'mobile',
      '--throttle', 'fast-3g',
      '--html', 'out.html',
      '--header', 'X-Test: yes',
      '--cookie', 'sid=abc',
    ]);
    assert.equal(opts.url, 'https://example.com');
    assert.equal(opts.runs, 3);
    assert.equal(opts.parallel, true);
    assert.equal(opts.device, DEVICE_PRESETS.mobile);
    assert.equal(opts.throttle, THROTTLE_PRESETS['fast-3g']);
    assert.equal(opts.htmlOutput, 'out.html');
    assert.deepEqual(opts.headers, { 'X-Test': 'yes' });
    assert.equal(opts.cookies.length, 1);
  });
});
