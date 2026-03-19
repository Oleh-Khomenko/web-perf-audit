/**
 * Shared test fixtures for report tests.
 */

export function makeReportData(overrides = {}) {
  return {
    connectionInfo: null,
    nav: {
      startTime: 0,
      redirectStart: 0,
      redirectEnd: 0,
      fetchStart: 1,
      workerStart: 0,
      domainLookupStart: 5,
      domainLookupEnd: 10,
      connectStart: 10,
      connectEnd: 15,
      secureConnectionStart: 0,
      requestStart: 15,
      responseStart: 50,
      responseEnd: 60,
      domInteractive: 80,
      domContentLoadedEventStart: 85,
      domContentLoadedEventEnd: 90,
      domComplete: 100,
      loadEventStart: 100,
      loadEventEnd: 105,
      name: 'http://localhost:3000',
    },
    vitals: { fcp: 120, lcp: 200, cls: 0.05, inp: 0, clsEntries: [], inpEntries: [], longTasks: [], renderBlocking: [], fontsReady: 100, lcpElement: null },
    tbt: 50,
    longTaskDetails: [],
    tbtByScript: [],
    resourceEntries: [],
    resourceSummary: {},
    jsCoverage: [],
    inp: 0,
    inpMeasured: false,
    inpEntries: [],
    renderBlocking: [],
    lcpElement: null,
    clsEntries: [],
    fontsReady: 100,
    preloadLinks: [],
    serverTiming: [],
    renderMetrics: null,
    memoryInfo: null,
    ...overrides,
  };
}

export function makeMeta(overrides = {}) {
  return {
    url: 'http://localhost:3000',
    date: '2025-01-01T00:00:00.000Z',
    numRuns: 1,
    medianVitals: null,
    allResults: null,
    throttle: null,
    cpuThrottle: 1,
    device: { label: 'Desktop', width: 1440, height: 920, mobile: false },
    calibration: null,
    ...overrides,
  };
}
