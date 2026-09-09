/**
 * Headless Chrome benchmark driver using the DevTools Protocol (via puppeteer-core).
 *
 * Captures, per variant (inline SVG vs sprite <use>):
 *  - in-page timing stats (mount, fat-morph, single-row morph, layout) over N runs
 *  - HTML payload bytes + gzip bytes
 *  - CDP page metrics: DOM Nodes, JSEventListeners, LayoutCount, RecalcStyleCount,
 *    LayoutDuration, RecalcStyleDuration, ScriptDuration, TaskDuration (deltas),
 *    JSHeapUsedSize / JSHeapTotalSize
 *  - DevTools timeline traces (openable in chrome://tracing / DevTools Performance
 *    panel) + main-thread busy-time breakdown by category
 */
import puppeteer from 'puppeteer-core';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./', import.meta.url));
const ROWS = parseInt(process.env.ROWS || '1000', 10);
const RUNS = parseInt(process.env.RUNS || '7', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tracedWindow(page, tracePath, fn) {
  await page.tracing.start({ path: tracePath, categories: ['devtools.timeline', 'blink', 'cc', 'v8', 'blink.user_timing'] });
  const out = await fn();
  await page.tracing.stop();
  return out;
}

// Summarize main-thread (CrRendererMain) devtools.timeline events from a trace file.
function summarizeTrace(tracePath) {
  const raw = JSON.parse(readFileSync(tracePath, 'utf8'));
  const events = raw.traceEvents || raw;
  // find renderer main thread with most events
  const byThread = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
    const k = `${e.pid}:${e.tid}`;
    byThread.set(k, (byThread.get(k) || 0) + e.dur);
  }
  // Heuristic: CrRendererMain hosts devtools.timeline events like EvaluateScript/Layout.
  const hasTimeline = (k) => events.some((e) => `${e.pid}:${e.tid}` === k && e.cat?.includes('devtools.timeline'));
  let mainKey = [...byThread.keys()].filter(hasTimeline).sort((a, b) => byThread.get(b) - byThread.get(a))[0]
    || [...byThread.keys()].sort((a, b) => byThread.get(b) - byThread.get(a))[0];

  const GROUPS = {
    Scripting: new Set(['EvaluateScript', 'FunctionCall', 'MajorGC', 'MinorGC', 'RunTask', 'TimerFire', 'EventDispatch', 'v8.compile', 'UpdateCounters']),
    Rendering: new Set(['Layout', 'UpdateLayoutTree', 'RecalculateStyles', 'InvalidateLayout', 'ScheduleStyleRecalculation']),
    Painting: new Set(['Paint', 'PrePaint', 'PaintImage', 'Rasterize', 'CompositeLayers', 'DrawFrame', 'ActivateLayerTree']),
    Loading: new Set(['ParseHTML', 'ParseAuthorStyleSheet', 'ResourceSendRequest', 'ResourceReceiveResponse', 'ResourceFinish']),
    Other: new Set(),
  };
  const groupOf = (name) => Object.keys(GROUPS).find((g) => GROUPS[g].has(name)) || 'Other';
  // Self-time: assign parents by interval containment so nested slices
  // (e.g. Layout inside UpdateStyleAndLayout) are not double-counted.
  const xs = events
    .filter((e) => `${e.pid}:${e.tid}` === mainKey && e.ph === 'X' && typeof e.dur === 'number')
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const roots = [];
  const stack = [];
  for (const e of xs) {
    const s = e.ts, f = e.ts + e.dur;
    while (stack.length && stack[stack.length - 1].f <= s) stack.pop();
    const rec = { s, f, dur: e.dur, name: e.name, kids: [] };
    if (stack.length) stack[stack.length - 1].kids.push(rec);
    else roots.push(rec);
    stack.push(rec);
  }
  const selfByName = {};
  const walk = (r) => {
    const kidMs = r.kids.reduce((a, k) => a + k.dur, 0);
    selfByName[r.name] = (selfByName[r.name] || 0) + (r.dur - kidMs) / 1000;
    r.kids.forEach(walk);
  };
  roots.forEach(walk);
  const sums = { Scripting: 0, Rendering: 0, Painting: 0, Loading: 0, Other: 0 };
  for (const [name, ms] of Object.entries(selfByName)) sums[groupOf(name)] += ms;
  const wallMs = roots.length ? (Math.max(...roots.map((r) => r.f)) - Math.min(...roots.map((r) => r.s))) / 1000 : 0;
  const busyMs = Object.values(sums).reduce((a, b) => a + b, 0);
  const top = Object.entries(selfByName).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { mainThread: mainKey, selfTime: true, wallMs: +wallMs.toFixed(2), busyMs: +busyMs.toFixed(2), groupsMs: Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, +v.toFixed(2)])), topEventsMs: Object.fromEntries(top.map(([k, v]) => [k, +v.toFixed(2)])) };
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900', '--enable-precise-memory-info'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('BENCH_JSON:') || t.startsWith('TRACE_')) console.log(t.slice(0, 400)); });
  await page.goto('file://' + DIR + 'index.html', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(() => typeof Idiomorph !== 'undefined' && typeof tableHTML === 'function', { timeout: 30000 });

  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');

  // ---- Phase A: full multi-run benchmark inside the page ----
  // REVERSE=1 runs sprite first to adversarially check ordering bias
  // (JIT/GC warmup otherwise always favors the second variant).
  const ORDER = process.env.REVERSE === '1' ? ['sprite', 'inline'] : ['inline', 'sprite'];
  const benchJson = await page.evaluate(async (ROWS, RUNS, ORDER) => {
    document.getElementById('rows').value = String(ROWS);
    document.getElementById('runs').value = String(RUNS);
    if (ORDER[0] === 'inline') return await runAll();
    const holder = document.getElementById('grid-holder');
    const out = {};
    for (const mode of ORDER) {
      currentMode = mode;
      out[mode] = await benchVariant(ROWS, 0, 1, RUNS, holder);
      out[mode].svgInstances = ROWS * 4;
    }
    renderResults(out, ROWS, RUNS);
    holder.innerHTML = '';
    return out;
  }, ROWS, RUNS, ORDER);
  writeFileSync(DIR + 'results.json', JSON.stringify({ rows: ROWS, runs: RUNS, order: ORDER, ua: await browser.userAgent(), ...benchJson }, null, 2));

  // ---- Adversarial sanity assertions: icons actually render, morphs actually apply ----
  const checks = await page.evaluate((ROWS) => {
    const holder = document.getElementById('grid-holder');
    const res = {};
    for (const mode of ['inline', 'sprite']) {
      holder.innerHTML = tableHTML(ROWS, 0, mode);
      const svg = holder.querySelector('#row-5 svg');
      const r = svg.getBoundingClientRect();
      const before = holder.querySelector('#row-0 .badge').textContent;
      Idiomorph.morph(holder.firstElementChild, tableHTML(ROWS, 1, mode));
      const after = holder.querySelector('#row-0 .badge').textContent;
      res[mode] = {
        svgRenderedWidth: r.width,
        useCount: holder.querySelectorAll('use').length,
        pathCount: holder.querySelectorAll('path,polygon,polyline,circle,line').length,
        morphChangedGrid: holder.querySelector('#app').dataset.tick === '1',
        rowCount: holder.querySelectorAll('tbody tr').length,
      };
      holder.innerHTML = '';
    }
    return res;
  }, ROWS);
  console.log('CHECKS: ' + JSON.stringify(checks));
  const assert = (c, m) => { if (!c) throw new Error('ASSERT FAILED: ' + m); };
  assert(checks.inline.svgRenderedWidth === 16, 'inline svg renders at 16px');
  assert(checks.sprite.svgRenderedWidth === 16, 'sprite svg renders at 16px');
  assert(checks.sprite.useCount === ROWS * 4, 'sprite has 4000 use refs');
  assert(checks.inline.useCount === 0 && checks.inline.pathCount > 0, 'inline has real paths, no use');
  assert(checks.sprite.morphChangedGrid && checks.inline.morphChangedGrid, 'morph applies tick');
  assert(checks.inline.rowCount === ROWS && checks.sprite.rowCount === ROWS, 'row count intact');

  // ---- Phase B: per-variant traced mount+morph with CDP metrics ----
  const traced = {};
  for (const mode of ['inline', 'sprite']) {
    const tracePath = `${DIR}trace-${mode}.json`;
    const mBefore = await page.metrics();
    await tracedWindow(page, tracePath, () => page.evaluate((mode, ROWS) => {
      const holder = document.getElementById('grid-holder');
      const htmlA = tableHTML(ROWS, 0, mode);
      const htmlB = tableHTML(ROWS, 1, mode);
      const t0 = performance.now();
      holder.innerHTML = htmlA;
      const nodes = holder.querySelectorAll('*').length;
      void holder.offsetHeight;
      const mountMs = performance.now() - t0;
      const t1 = performance.now();
      Idiomorph.morph(holder.firstElementChild, htmlB);
      const morphMs = performance.now() - t1;
      const t2 = performance.now();
      void holder.offsetHeight;
      const layoutMs = performance.now() - t2;
      const svgCount = holder.querySelectorAll('svg').length;
      const useCount = holder.querySelectorAll('use').length;
      holder.innerHTML = '';
      return { mountMs, morphMs, layoutMs, nodes, svgCount, useCount, bytes: new TextEncoder().encode(htmlA).length };
    }, mode, ROWS));
    const mAfter = await page.metrics();
    const delta = (k) => +(mAfter[k] - mBefore[k]).toFixed(4);
    traced[mode] = {
      metricsDelta: {
        Nodes: delta('Nodes'), JSEventListeners: delta('JSEventListeners'),
        LayoutCount: delta('LayoutCount'), RecalcStyleCount: delta('RecalcStyleCount'),
        LayoutDuration: delta('LayoutDuration'), RecalcStyleDuration: delta('RecalcStyleDuration'),
        ScriptDuration: delta('ScriptDuration'), TaskDuration: delta('TaskDuration'),
        JSHeapUsedSize: mAfter.JSHeapUsedSize, JSHeapTotalSize: mAfter.JSHeapTotalSize,
      },
      trace: summarizeTrace(tracePath),
    };
    console.log(`TRACE_${mode}: ` + JSON.stringify(traced[mode].trace));
    await sleep(500);
  }

  const combined = JSON.parse(readFileSync(DIR + 'results.json', 'utf8'));
  combined.traced = traced;
  writeFileSync(DIR + 'results.json', JSON.stringify(combined, null, 2));
  console.log('WROTE results.json, trace-inline.json, trace-sprite.json');
} finally {
  await browser.close();
}
