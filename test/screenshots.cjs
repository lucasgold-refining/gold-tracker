const { chromium } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = '/opt/cursor/artifacts';
const STATE = {
  base: 7425.39,
  source: 'BSP',
  lastUpdated: '20 Nov 14:30',
  settings: { base: 7425.39, fullMin: 0.998, bhyPerGram: 2, quoteMargin: 0.01, refiningFee: 350 },
  version: 56,
  receipts: true,
  stock: [],
  batches: [],
  nextNo: 2,
  dashboard: {},
  _syncedAt: '2026-11-20T06:00:00.000Z',
};

function serve(port) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (url.pathname === '/') file = path.join(ROOT, 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('no'); return; }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function scaleFonts(page, factor) {
  await page.evaluate((factor) => {
    const els = [document.body, ...document.body.querySelectorAll('*')];
    const sizes = els.map((el) => parseFloat(getComputedStyle(el).fontSize) || 0);
    els.forEach((el, i) => { if (sizes[i]) el.style.setProperty('font-size', (sizes[i] * factor) + 'px', 'important'); });
  }, factor);
}

async function prepare(page) {
  await page.addInitScript((state) => {
    localStorage.setItem('gold-tracker-config', JSON.stringify({ url: 'https://sheet.test/exec', token: '1234567890abcdef' }));
    localStorage.setItem('gold-tracker-state', JSON.stringify(state));
    localStorage.setItem('gold-tracker-offbase', JSON.stringify({ base: 7100, at: '2026-11-20T06:00:00.000Z' }));
    window.__goldApiTimeout = 700;
  }, STATE);
  await page.route('https://sheet.test/**', (route) => route.abort('failed'));
  await page.goto('http://127.0.0.1:8765/index.html?test=1#quote', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__goldOff && !window.__goldOff.busy() && window.__goldOff.active() === 7100);
  await page.context().setOffline(true);
  await page.locator('#qp').fill('87.1');
  await page.locator('#qPrice').waitFor();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve(8765);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const phone = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 });
    const page = await phone.newPage();
    await prepare(page);
    await page.screenshot({ path: path.join(OUT, 'v57-phone-412-offline-pill.png') });

    await page.locator('#basePill').click();
    await page.locator('#bbSheet').waitFor();
    await page.screenshot({ path: path.join(OUT, 'v57-phone-412-base-modal.png') });
    await page.locator('#bbCancel').click();
    await page.locator('#modal').waitFor({ state: 'detached' });
    await page.locator('#qPrice').waitFor();
    await scaleFonts(page, 1.25);
    await page.screenshot({ path: path.join(OUT, 'v57-phone-412-largefont.png') });
    const clip = await page.evaluate(() => {
      const tag = document.getElementById('offTag');
      const pill = document.getElementById('basePill');
      const t = tag.getBoundingClientRect();
      const p = pill.getBoundingClientRect();
      return {
        text: tag.textContent,
        past: t.right - Math.min(p.right, window.innerWidth),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        scrollClip: tag.scrollWidth - tag.clientWidth,
      };
    });
    if (clip.text !== 'Offline' || clip.past > 1 || clip.overflowX > 1 || clip.scrollClip > 1) {
      throw new Error('Large-font layout clipped: ' + JSON.stringify(clip));
    }
    await phone.close();

    const laptop = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 });
    const desk = await laptop.newPage();
    await prepare(desk);
    await desk.screenshot({ path: path.join(OUT, 'v57-laptop-80pct.png') });
    const deskFit = await desk.evaluate(() => {
      const tag = document.getElementById('offTag');
      const pill = document.getElementById('basePill');
      const t = tag.getBoundingClientRect();
      const p = pill.getBoundingClientRect();
      return { text: tag.textContent, past: t.right - p.right, overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    if (deskFit.text !== 'Offline' || deskFit.past > 1 || deskFit.overflowX > 1) {
      throw new Error('Laptop layout clipped: ' + JSON.stringify(deskFit));
    }
    await laptop.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log('screenshots written');
})().catch((e) => { console.error(e); process.exit(1); });
