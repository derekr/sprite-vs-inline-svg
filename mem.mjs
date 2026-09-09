/** Clean heap-after-mount comparison with explicit GC. Usage: node mem.mjs [rows] */
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
const DIR = fileURLToPath(new URL('./', import.meta.url));
const ROWS = parseInt(process.argv[2] || '1000', 10);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
try {
  const page = await browser.newPage();
  await page.goto('file://' + DIR + 'index.html', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof tableHTML === 'function');
  for (const mode of ['inline', 'sprite']) {
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const r = await page.evaluate((mode, ROWS) => {
        gc();
        const holder = document.getElementById('grid-holder');
        holder.innerHTML = tableHTML(ROWS, 0, mode);
        void holder.offsetHeight;
        const nodes = holder.querySelectorAll('*').length;
        gc();
        return { heap: performance.memory.usedJSHeapSize, nodes };
      }, mode, ROWS);
      samples.push(r);
      await new Promise((r2) => setTimeout(r2, 300));
    }
    console.log(mode, JSON.stringify(samples));
  }
} finally { await browser.close(); }
