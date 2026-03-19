# Benchmark Expected Ranges

When running against `bench/index.html` served locally:

| Metric | Expected Range | Notes |
|--------|---------------|-------|
| TTFB   | <20ms         | Localhost, no network latency |
| FCP    | <200ms        | Minimal render-blocking CSS |
| LCP    | <500ms        | 500x500 div, no image load |
| CLS    | 0.05–0.15     | JS-injected layout shift at 500ms |
| TBT    | 50–150ms      | Sync busy-wait ~100ms |
| INP    | 0 (unmeasured) | No user interactions in audit |
| Score  | 70–95         | Depends on TBT/CLS variance |

## Running

```bash
npm run bench &
node src/index.mjs http://localhost:3000 --runs 3 --html bench-report.html
kill %1
```
