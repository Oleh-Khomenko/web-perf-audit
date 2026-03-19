import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HTML_PATH = join(tmpdir(), `bench-report-${Date.now()}.html`);

// Check if Chrome is available
function chromeAvailable() {
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  if (process.env.CHROME_PATH) return true;
  for (const p of paths) {
    if (existsSync(p)) return true;
  }
  // Try linux names
  try {
    execSync('which google-chrome || which chromium-browser || which chromium', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasChrome = chromeAvailable();

describe('integration: benchmark audit', { skip: !hasChrome && 'Chrome not found' }, () => {
  let server;

  before(() => {
    // Start benchmark server
    server = spawn('node', [join(ROOT, 'bench/serve.mjs')], {
      stdio: 'pipe',
      env: { ...process.env, PORT: '3987' },
    });
    // Wait for server to be ready
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 5000);
      server.stdout.on('data', (data) => {
        if (data.toString().includes('running')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      server.on('error', reject);
    });
  });

  after(() => {
    if (server) {
      server.kill();
      server = null;
    }
    try { unlinkSync(HTML_PATH); } catch {}
  });

  it('runs audit on benchmark page and produces valid output', { timeout: 60000 }, async () => {
    const result = await new Promise((resolve, reject) => {
      const proc = spawn('node', [
        join(ROOT, 'src/index.mjs'),
        'http://localhost:3987',
        '--html', HTML_PATH,
      ], { stdio: 'pipe', timeout: 55000 });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });

      proc.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
      proc.on('error', reject);
    });

    // Should exit successfully
    assert.equal(result.code, 0, `Exit code ${result.code}. stderr: ${result.stderr}`);

    // HTML report should be created
    assert.ok(existsSync(HTML_PATH), 'HTML report file should exist');

    // Stdout should contain key metric labels
    assert.ok(result.stdout.includes('TTFB'), 'stdout should mention TTFB');
    assert.ok(result.stdout.includes('FCP'), 'stdout should mention FCP');
    assert.ok(result.stdout.includes('LCP'), 'stdout should mention LCP');

    // Stdout should contain score
    assert.ok(result.stdout.includes('Score'), 'stdout should mention Score');
  });
});
