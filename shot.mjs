/** Render the benchmark page, run it, and capture a full-page screenshot. */
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
const DIR = fileURLToPath(new URL('./', import.meta.url));
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('file://' + DIR + 'index.html?rows=1000&runs=7', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof runAll === 'function');
  await page.evaluate(() => runAll());
  await page.waitForFunction(() => document.title === 'BENCH_DONE', { timeout: 300000 });
  await new Promise((r) => setTimeout(r, 400));
  // Clip to header + results table (skip the raw JSON dump below it).
  const clip = await page.evaluate(() => {
    const table = document.querySelector('table.bench');
    const r = table.getBoundingClientRect();
    return { x: 0, y: 0, width: 1440, height: Math.ceil(r.bottom + 24) };
  });
  await page.screenshot({ path: DIR + 'screenshot.png', clip });
  console.log('WROTE screenshot.png');
} finally { await browser.close(); }
