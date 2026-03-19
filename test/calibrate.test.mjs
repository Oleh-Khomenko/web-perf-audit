import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeMultiplier, CALIBRATION_DEVICES, DEFAULT_CALIBRATION_DEVICE } from '../src/calibrate.mjs';

// ── Constants ──

describe('CALIBRATION_DEVICES', () => {
  it('all devices have positive referenceMs', () => {
    for (const [key, device] of Object.entries(CALIBRATION_DEVICES)) {
      assert.ok(device.referenceMs > 0, `${key} has referenceMs <= 0`);
      assert.ok(device.label, `${key} missing label`);
    }
  });

  it('DEFAULT_CALIBRATION_DEVICE exists in CALIBRATION_DEVICES', () => {
    assert.ok(CALIBRATION_DEVICES[DEFAULT_CALIBRATION_DEVICE]);
  });
});

// ── computeMultiplier ──

describe('computeMultiplier', () => {
  it('returns 1.0 when measured equals reference', () => {
    assert.equal(computeMultiplier(480, 480), 1.0);
  });

  it('returns 10.0 when reference is 10x measured', () => {
    assert.equal(computeMultiplier(480, 48), 10.0);
  });

  it('clamps to 12.0 maximum', () => {
    assert.equal(computeMultiplier(480, 10), 12.0);
  });

  it('clamps to 1.0 minimum', () => {
    assert.equal(computeMultiplier(480, 10000), 1.0);
  });

  it('rounds to 1 decimal', () => {
    // 480 / 200 = 2.4
    assert.equal(computeMultiplier(480, 200), 2.4);
  });

  it('throws on measuredMs <= 0', () => {
    assert.throws(() => computeMultiplier(480, 0), /invalid/);
    assert.throws(() => computeMultiplier(480, -1), /invalid/);
  });
});
