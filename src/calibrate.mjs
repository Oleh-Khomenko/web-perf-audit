/**
 * CPU calibration — runs a benchmark in Chrome V8 to compute a throttle
 * multiplier that normalizes results to a reference device (Moto G Power).
 *
 * The benchmark mixes JSON stringify/parse (allocation + GC pressure) with
 * numeric Math.sqrt/Math.sin loops (raw CPU). It runs 3 times and takes the
 * median to mitigate JIT warmup and GC variance.
 *
 * Reference value was determined by running the benchmark on a 2023 MacBook Pro
 * M2 with 4x CPU throttle applied via CDP — this approximates Moto G Power
 * single-core performance for mixed workloads.
 */

export const CALIBRATION_DEVICES = {
  'moto-g-power': { label: 'Moto G Power', referenceMs: 480 },
  'galaxy-a14':   { label: 'Galaxy A14',   referenceMs: 600 },
  'pixel-7a':     { label: 'Pixel 7a',     referenceMs: 320 },
  'iphone-se':    { label: 'iPhone SE',    referenceMs: 400 },
};
export const DEFAULT_CALIBRATION_DEVICE = 'moto-g-power';

const BENCHMARK_JS = `
(function() {
  const ITERATIONS = 50;

  function runOnce() {
    let acc = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      // Allocation + GC pressure: build and parse a non-trivial object
      const obj = {};
      for (let k = 0; k < 200; k++) {
        obj['key' + k] = Math.random();
      }
      const json = JSON.stringify(obj);
      const parsed = JSON.parse(json);
      acc += Object.keys(parsed).length;

      // Raw CPU: numeric math
      for (let j = 0; j < 5000; j++) {
        acc += Math.sqrt(j) + Math.sin(j);
      }
    }
    return acc;
  }

  const times = [];
  for (let run = 0; run < 3; run++) {
    const t0 = performance.now();
    runOnce();
    times.push(performance.now() - t0);
  }

  // Return median
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
})()
`;

/**
 * Run the CPU calibration benchmark in Chrome via CDP.
 *
 * @param {import('./cdp.mjs').CDPSession} cdp - Connected CDP session (page target)
 * @returns {Promise<{multiplier: number, measuredMs: number, referenceMs: number}>}
 */
export async function runCalibration(cdp, deviceKey = DEFAULT_CALIBRATION_DEVICE, customMs = null) {
  let referenceMs, deviceLabel;
  if (deviceKey === 'custom' && customMs > 0) {
    referenceMs = customMs;
    deviceLabel = `Custom (${customMs}ms)`;
  } else {
    const device = CALIBRATION_DEVICES[deviceKey];
    if (!device) {
      throw new Error(`Unknown calibration device: "${deviceKey}"\nAvailable devices: ${Object.keys(CALIBRATION_DEVICES).join(', ')}`);
    }
    referenceMs = device.referenceMs;
    deviceLabel = device.label;
  }
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: BENCHMARK_JS,
    returnByValue: true,
    awaitPromise: false,
  });

  if (result.type !== 'number' || typeof result.value !== 'number') {
    throw new Error(`Calibration benchmark failed: unexpected result type "${result.type}"`);
  }

  const measuredMs = result.value;
  if (measuredMs <= 0) {
    throw new Error(`Calibration benchmark returned ${measuredMs}ms — cannot compute multiplier`);
  }
  const raw = referenceMs / measuredMs;
  // Clamp to [1.0, 12.0], round to 1 decimal
  const multiplier = Math.round(Math.min(12.0, Math.max(1.0, raw)) * 10) / 10;

  return { multiplier, measuredMs: Math.round(measuredMs), referenceMs, deviceKey, deviceLabel };
}
