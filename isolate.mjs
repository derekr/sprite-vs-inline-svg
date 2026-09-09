/** Isolation check: benchmark each variant in its own fresh browser process. */
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
const DIR = fileURLToPath(new URL('./', import.meta.url));
const ROWS = 1000, RUNS = 7;

for (const mode of ['inline', 'sprite']) {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + DIR + 'index.html', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => typeof benchVariant === 'function');
    const r = await page.evaluate(async (mode, ROWS, RUNS) => {
      currentMode = mode;
      const v = await benchVariant(ROWS, 0, 1, RUNS, document.getElementById('grid-holder'));
      return { morph: v.morphs.mean, morphMed: v.morphs.median, layout: v.layouts.mean, mount: v.mounts.mean };
    }, mode, ROWS, RUNS);
    console.log(`ISOLATED ${mode}: ` + JSON.stringify(r));
  } finally { await browser.close(); }
}
