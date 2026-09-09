/** Extract exact benchmark payloads and compress with gzip + brotli (q11 static, q4 dynamic). */
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const DIR = fileURLToPath(new URL('./', import.meta.url));
const ROWS = parseInt(process.argv[2] || '1000', 10);

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  await page.goto('file://' + DIR + 'index.html', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => typeof tableHTML === 'function');
  for (const mode of ['inline', 'sprite']) {
    const html = await page.evaluate((m, n) => tableHTML(n, 0, m), mode, ROWS);
    writeFileSync(`${DIR}payload-${mode}.html`, html);
    const buf = Buffer.from(html, 'utf8');
    const gz = gzipSync(buf, { level: 6 });
    const br11 = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
    const br4 = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
    console.log(`${mode}: raw=${buf.length} gzip6=${gz.length} br11=${br11.length} br4=${br4.length}`);
  }
} finally { await browser.close(); }
