# web-perf-audit

Zero-dependency Chrome CDP performance auditor. Launches headless Chrome, collects Web Vitals, Navigation Timing, JS Coverage, resource waterfalls, and generates console + HTML reports.

## Features

- **Web Vitals** — TTFB, FCP, LCP, CLS, TBT, INP with Good/Needs work/Poor ratings
- **Performance Score** — Lighthouse v10-style weighted score (0–100)
- **Phase Breakdowns** — TTFB, FCP, LCP, CLS, INP broken into sub-phases with bar charts
- **JS Coverage & Execution Time** — unused bytes per script with CPU profile data
- **TBT Breakdown** — per-script blocking time via Long Animation Frames API
- **Resource Analysis** — render-blocking detection, preload audit, largest resources
- **Network Waterfall** — ASCII (console) and visual (HTML) timeline
- **Device & Network Emulation** — desktop, tablet, mobile presets + 3G/4G throttling
- **Multi-run Mode** — run N iterations, report median vitals (sequential or parallel)
- **HTML Reports** — self-contained HTML with inline CSS, no external dependencies
- **Zero dependencies** — uses system Chrome + CDP over Node built-ins

## Requirements

- **Node.js** >= 18
- **Chromium-based browser** installed — Google Chrome, Chromium, Brave, Microsoft Edge, or any other Chromium-based browser

### Supported platforms

| Platform | Browser discovery |
|---|---|
| **macOS** | Google Chrome, Chromium, Chrome Canary, Brave (standard `/Applications` paths) |
| **Linux** | `google-chrome`, `google-chrome-stable`, `chromium-browser`, `chromium` (resolved via `$PATH`) |
| **Windows** | `C:\Program Files\Google\Chrome\Application\chrome.exe`, `C:\Program Files (x86)\...\chrome.exe` |

The tool auto-detects the browser by trying known paths in order. If your browser is installed in a non-standard location, ensure it is available in your system `$PATH`.

> **Note:** Firefox and Safari are **not supported** — the tool communicates with the browser via Chrome DevTools Protocol (CDP), which is only available in Chromium-based browsers. Some features (Long Animation Frames API for TBT attribution) require **Chrome 123+**.

## Installation

```bash
npm install -g web-perf-audit
```

Or use directly with npx:

```bash
npx web-perf-audit https://example.com
```

## Usage

```bash
web-perf-audit [url] [options]
```

### Options

| Option | Description | Default |
|---|---|---|
| `--runs N` | Run audit N times, report median vitals | `1` |
| `--parallel` | Run iterations concurrently (with `--runs`) | `false` |
| `--device <preset>` | Device emulation: `desktop`, `tablet`, `mobile` | `desktop` |
| `--throttle <preset>` | Network: `slow-3g`, `fast-3g`, `4g`, `none` | `none` |
| `--cpu-throttle <N>` | CPU slowdown multiplier (e.g. `4` = 4x slower) | `1` |
| `--header "Name: Val"` | Add custom HTTP header (repeatable) | — |
| `--cookie "name=val"` | Add cookie for target domain (repeatable) | — |
| `--html [path]` | Save HTML report (auto-named if no path given) | — |
| `-h, --help` | Show help | — |

### Examples

```bash
# Basic audit
web-perf-audit https://example.com

# Mobile on 4G with 5 runs
web-perf-audit https://example.com --device mobile --throttle 4g --cpu-throttle 4 --runs 5

# Parallel runs with HTML output
web-perf-audit https://example.com --runs 5 --parallel --html

# Save HTML to specific file
web-perf-audit https://example.com --html report.html

# Audit a page behind authentication
web-perf-audit https://example.com --header "Authorization: Bearer tok123"

# Pass a session cookie
web-perf-audit https://example.com --cookie "session=abc123"

# Multiple headers and cookies
web-perf-audit https://example.com --header "Authorization: Bearer tok" --header "X-Custom: val" --cookie "sid=abc"
```

## Report Sections

| Section | Description |
|---|---|
| Navigation Timing | DNS, TCP, TLS, TTFB, download, DOM lifecycle, total load |
| Performance Score | Lighthouse-style 0–100 weighted score |
| Web Vitals | TTFB, FCP, LCP, CLS, TBT, INP with thresholds |
| TTFB Breakdown | Redirect, DNS, TCP, TLS, request/response phases |
| FCP Breakdown | TTFB, blocking resources, HTML parse, style/font load |
| LCP Breakdown | TTFB, resource delay/download, render delay sub-phases |
| CLS Breakdown | Session windows with source elements |
| INP Breakdown | Input delay, processing, presentation delay sub-phases |
| TBT Breakdown | Per-script blocking time with Long Animation Frames |
| Resource Summary | Count, transfer size, slowest time per type |
| JS Coverage | Used vs unused bytes per script, execution time |
| Render-Blocking | Resources with `renderBlockingStatus === 'blocking'` |
| Preload Audit | Cross-references `<link rel="preload">` with usage |
| Largest Resources | Top 10 by transfer size |
| Network Waterfall | Timeline of the 20 slowest resources |

## License

MIT
