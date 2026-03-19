/**
 * CLI argument parsing — extracted for testability.
 */

import { CALIBRATION_DEVICES, DEFAULT_CALIBRATION_DEVICE } from './calibrate.mjs';

// -- Throttle presets (matching Lighthouse/Chrome DevTools) --

export const THROTTLE_PRESETS = {
  'slow-3g': { latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 25 * 1024, label: 'Slow 3G' },
  'fast-3g': { latency: 150, downloadThroughput: 197 * 1024, uploadThroughput: 48 * 1024, label: 'Fast 3G' },
  '4g':      { latency: 20,  downloadThroughput: 1500 * 1024, uploadThroughput: 750 * 1024, label: '4G' },
};

// -- Device presets (matching Lighthouse) --

export const DEVICE_PRESETS = {
  desktop: {
    label: 'Desktop',
    width: 1440,
    height: 920,
    deviceScaleFactor: 1,
    mobile: false,
    userAgent: null,
  },
  tablet: {
    label: 'Tablet (iPad Air)',
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  mobile: {
    label: 'Mobile (Moto G Power)',
    width: 412,
    height: 823,
    deviceScaleFactor: 2.625,
    mobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
};

/**
 * Parse CLI arguments into a structured options object.
 * Throws on validation errors instead of calling process.exit.
 * @param {string[]} argv - Arguments (process.argv.slice(2))
 * @returns {object} Parsed options
 */
export function parseArgs(argv) {
  const opts = {
    url: 'http://localhost:3000',
    runs: 1,
    parallel: false,
    device: DEVICE_PRESETS.desktop,
    throttle: null,
    cpuThrottle: 1,
    cpuThrottleExplicit: false,
    calibrateDevice: null,
    calibrateCustomMs: null,
    headers: {},
    cookies: [],
    htmlOutput: null,
    help: false,
  };

  if (argv.includes('--help') || argv.includes('-h')) {
    opts.help = true;
    return opts;
  }

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs' && argv[i + 1]) {
      opts.runs = Math.max(1, parseInt(argv[i + 1], 10) || 1);
      i++;
    }
    else if (argv[i] === '--device' && argv[i + 1]) {
      const preset = argv[i + 1];
      if (!DEVICE_PRESETS[preset]) {
        throw new Error(`Unknown device preset: "${preset}"\nAvailable presets: ${Object.keys(DEVICE_PRESETS).join(', ')}`);
      }
      opts.device = DEVICE_PRESETS[preset];
      i++;
    }
    else if (argv[i] === '--throttle' && argv[i + 1]) {
      const preset = argv[i + 1];
      if (preset === 'none') {
        opts.throttle = null;
      }
      else if (!THROTTLE_PRESETS[preset]) {
        throw new Error(`Unknown throttle preset: "${preset}"\nAvailable presets: ${Object.keys(THROTTLE_PRESETS).join(', ')}, none`);
      }
      else {
        opts.throttle = THROTTLE_PRESETS[preset];
      }
      i++;
    }
    else if (argv[i] === '--cpu-throttle' && argv[i + 1]) {
      const rate = parseFloat(argv[i + 1]);
      if (isNaN(rate) || rate < 1) {
        throw new Error(`Invalid CPU throttle rate: "${argv[i + 1]}"\nMust be a number >= 1 (e.g. 4 = 4x slower)`);
      }
      opts.cpuThrottle = rate;
      opts.cpuThrottleExplicit = true;
      i++;
    }
    else if (argv[i] === '--calibrate') {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        const val = argv[i + 1];
        const ms = Number(val);
        if (!isNaN(ms) && ms > 0) {
          opts.calibrateDevice = 'custom';
          opts.calibrateCustomMs = ms;
        } else if (CALIBRATION_DEVICES[val]) {
          opts.calibrateDevice = val;
        } else {
          throw new Error(`Unknown calibration device: "${val}"\nAvailable: ${Object.keys(CALIBRATION_DEVICES).join(', ')} or a number in ms (e.g. 500)`);
        }
        i++;
      } else {
        opts.calibrateDevice = DEFAULT_CALIBRATION_DEVICE;
      }
    }
    else if (argv[i] === '--parallel') {
      opts.parallel = true;
    }
    else if (argv[i] === '--header' && argv[i + 1]) {
      const colonIdx = argv[i + 1].indexOf(':');
      if (colonIdx === -1) {
        throw new Error(`Invalid header format: "${argv[i + 1]}"\nExpected "Name: Value"`);
      }
      const name = argv[i + 1].slice(0, colonIdx).trim();
      const value = argv[i + 1].slice(colonIdx + 1).trim();
      opts.headers[name] = value;
      i++;
    }
    else if (argv[i] === '--cookie' && argv[i + 1]) {
      const eqIdx = argv[i + 1].indexOf('=');
      if (eqIdx === -1) {
        throw new Error(`Invalid cookie format: "${argv[i + 1]}"\nExpected "name=value"`);
      }
      const name = argv[i + 1].slice(0, eqIdx).trim();
      const value = argv[i + 1].slice(eqIdx + 1).trim();
      opts.cookies.push({ name, value });
      i++;
    }
    else if (argv[i] === '--html') {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        opts.htmlOutput = argv[i + 1];
        i++;
      }
      else {
        opts.htmlOutput = true;
      }
    }
    else if (!argv[i].startsWith('--')) {
      opts.url = argv[i];
    }
  }

  // Validate URL
  try { new URL(opts.url); }
  catch { throw new Error(`Invalid URL: "${opts.url}"`); }

  return opts;
}
