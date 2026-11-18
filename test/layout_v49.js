// Mobile layout check: 412x915, DPR 3.5, font 100% and 130%.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
const CHROME = '/opt/google/chrome/chrome';
const TOKEN = 'testtoken0123456789abcdef0123456789abcdef';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

function state0() {
  return {
    version: 14, receipts: true, today: '2026-11-13', base: 8250, source: 'BSP', lastUpdated: '2026-11-13 18:00',
    nextNo: 4, nextBno: 4, batchNos: true,
    settings: { base: 8250, margin: 0.01, fullMin: 0.998, bhyPerGram: 2, refiningFee: 20000, silverDivisor: 0.23, silverMultiplier: 1.05 },
    stock: [
      { no: 1, bno: 1, date: '2026-11-13', weightBhy: 10, grams: 5, purity: 0.8535, cost: 35000, projSell: 35181.88, projProfit: 181.88, status: 'In stock', at: '2026-11-13T10:00:00+08:00' }
    ],
    batches: [{ id: 'R-20261111', date: '2026-11-11', items: 2, rawG: 8, refinedG: 6.8, silverG: 1.4, status: 'Refining', costInclFee: 45000, itemsCost: 25000, base: 8200, canAdd: true, at: '2026-11-11T12:00:00+08:00' }],
    sales: [{ date: '2026-11-05', batch: 'R-20261001', actual: 180000, profit: 22000 }],
    daily: { '2026-11-13': 5 }, dailySold: {},
    dashboard: { cashUsed: 83629430.77, totalRealized: 17319703.23 },
    month: { name: 'November 2026', realizedProfit: 843628.23, purchasesCost: 35415015.77 },
    realizedMonths: [{ month: '2026-10', profit: 1657309 }, { month: '2026-11', profit: 843628.23 }]
  };
}

function startServer() {
  return new Promise(resolve => {
    const st = state0();
    const s = http.createServer((req, res) => {
      if (req.url.startsWith('/mock-api')) {
        let buf = '';
        req.on('data', c => buf += c);
        req.on('end', () => {
          let body = {};
          try { body = JSON.parse(buf || '{}'); } catch (e) {}
          let out = { ok: true, version: 14, receipts: true, state: Object.assign({ version: 14, receipts: true }, st) };
          if (body.action === 'getSettings' || body.action === 'ping') out = { ok: true, version: 14, receipts: true, message: 'pong', base: st.base, settings: st.settings, source: st.source, today: st.today, lastUpdated: st.lastUpdated };
          if (body.action === 'batchPreview') out = { ok: true, version: 14, receipts: true, preview: { count: 1, nos: [1], rawG: 5, refinedG: 4.26, cost: 35000, fee: 20000, costInclFee: 55000, base: 8250, estValue: 35181, estProfit: -19819, silverG: 6, silverExcl: 0, fullMin: 0.998, defaultBatchId: 'R-20261113' } };
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(out));
        });
        return;
      }
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = path.join(ROOT, p);
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('x'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(fp).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

async function metrics(page) {
  return page.evaluate(() => {
    const taps = [...document.querySelectorAll('button, a, .netbar, input')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width && r.height && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    }).map(el => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), id: el.id || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40), short: r.height < 44 || r.width < 44 };
    });
    return {
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      shortTaps: taps.filter(t => t.short && t.h < 44)
    };
  });
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { server, port } = await startServer();
  const origin = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true,
    timezoneId: 'Asia/Manila', locale: 'en-GB',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
  });
  const page = await context.newPage();
  page.on('dialog', d => d.accept());
  await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + TOKEN), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__goldOutbox);
  await page.evaluate(() => window.__goldOutbox.ready());
  await page.waitForTimeout(400);
  await context.setOffline(true);
  await page.waitForTimeout(200);
  await page.click('nav button[data-v=buy]');
  await page.fill('#bw', '2.50'); await page.fill('#bp', '87.1'); await page.fill('#bc', '8875'); await page.click('#bsave');
  await page.waitForTimeout(300);
  await page.click('nav button[data-v=sales]');
  await page.waitForTimeout(200);
  const rec = await page.$('button:has-text("Record sale")');
  if (rec) { await rec.click(); await page.fill('#sb', '8300'); await page.fill('#sa', '56440'); await page.click('#sgo'); await page.waitForTimeout(4000); }
  const add = await page.$('button:has-text("Add other sale")');
  if (add) { await add.click(); await page.fill('#oc', '5000'); await page.fill('#oa', '7200'); await page.click('#ogo'); await page.waitForTimeout(4000); }
  await page.click('nav button[data-v=stock]');
  await page.waitForTimeout(250);
  const rb = await page.$('#refineBtn');
  if (rb) { const dis = await rb.getAttribute('disabled'); if (dis==null) { await rb.click(); await page.waitForTimeout(300); const go = await page.$('#rgo'); if (go) { await go.click(); await page.waitForTimeout(4000); } } }

  const screens = [
    ['checkstock', async () => {
      await page.click('nav button[data-v=stock]');
      await page.evaluate(() => {
        const it = window.__goldOutbox.items().find(x => x.action === 'addPurchase');
        if (it) { it.uncertainAt = Date.now(); window.qDel(it.rid); }
      });
      await page.waitForTimeout(250);
    }],
    ['stock', async () => { await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250); }],
    ['sales', async () => { await page.click('nav button[data-v=sales]'); await page.waitForTimeout(250); }],
    ['dash', async () => { await page.click('nav button[data-v=dash]'); await page.waitForTimeout(250); }],
    ['settings', async () => { await page.click('#setBtn'); await page.waitForTimeout(300); await page.evaluate(() => { const b = document.getElementById('obBox'); if (b) b.scrollIntoView({ block: 'center' }); }); await page.waitForTimeout(150); }]
  ];

  // dismiss leftover toast / blur so screenshots stay clean
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.classList.remove('show'); document.activeElement && document.activeElement.blur(); });

  for (const scale of [100, 130]) {
    await page.evaluate(s => {
      document.documentElement.style.fontSize = '';
      document.documentElement.style.zoom = s === 100 ? '' : '1.3';
    }, scale);
    for (const [name, go] of screens) {
      if (name !== 'settings') await page.evaluate(() => { const m = document.getElementById('modal'); if (m) m.remove(); });
      await go();
      if (name === 'sales') {
        await page.evaluate(() => {
          const b = [...document.querySelectorAll('button')].find(x => /Sale waiting to sync/i.test(x.textContent || ''));
          if (b) b.scrollIntoView({ block: 'center' });
        });
        await page.waitForTimeout(200);
      }
      const m = await metrics(page);
      ok(!m.overflow, `${name} @${scale}% no horizontal scroll (scroll=${m.scroll} inner=${m.inner})`);
      const primaryShort = m.shortTaps.filter(t => /Export|Import|Save|Record|waiting to sync|Sync now|Download/i.test(t.id) && t.h < 44);
      ok(primaryShort.length === 0, `${name} @${scale}% primary taps >= 44px (${primaryShort.map(t => t.id + ' h' + t.h).join('; ') || 'ok'})`);
      await page.screenshot({ path: path.join(SHOTS, `layout-${name}-${scale}.png`), full_page: false });
    }
  }

  await browser.close();
  server.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
