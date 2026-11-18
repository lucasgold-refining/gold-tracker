// v47 Phase 1: IndexedDB outbox, migration, offline buy+sale, export/import, persist fallback.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const SHOTS = path.join(__dirname, 'shots');
const CHROME = '/opt/google/chrome/chrome';
const TOKEN = 'testtoken0123456789abcdef0123456789abcdef';
const OTHER_TOKEN = 'othertoken0123456789abcdef0123456789abcdef';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

function state0() {
  return {
    version: 13, today: '2026-11-13', base: 8250, source: 'BSP', lastUpdated: '2026-11-13 18:00',
    nextNo: 4, nextBno: 4, batchNos: true,
    settings: { base: 8250, margin: 0.01, fullMin: 0.998, bhyPerGram: 2, refiningFee: 20000, silverDivisor: 0.23, silverMultiplier: 1.05 },
    stock: [
      { no: 1, bno: 1, date: '2026-11-13', weightBhy: 10, grams: 5, purity: 0.8535, cost: 35000, projSell: 35181.88, projProfit: 181.88, status: 'In stock', at: '2026-11-13T10:00:00+08:00' }
    ],
    batches: [{
      id: 'R-20261111', date: '2026-11-11', items: 2, rawG: 8, refinedG: 6.8, silverG: 1.4,
      status: 'Refining', costInclFee: 45000, itemsCost: 25000, base: 8200, canAdd: true,
      at: '2026-11-11T12:00:00+08:00'
    }],
    sales: [], daily: { '2026-11-13': 5 }, dailySold: {},
    dashboard: { cashUsed: 80000, totalRealized: 0 },
    month: { name: 'November 2026', realizedProfit: 0, purchasesCost: 35000 },
    realizedMonths: [{ month: '2026-11', profit: 0 }]
  };
}

function startServer(opts) {
  opts = opts || {};
  const apiLog = [];
  const purchases = [];
  let st = state0();
  let failNext = opts.failNext || null; // 'addPurchase'|'recordBatchSale'|null
  let soldOnce = false;
  const s = http.createServer((req, res) => {
    if (req.url.startsWith('/mock-api')) {
      let buf = '';
      req.on('data', c => buf += c);
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(buf || '{}'); } catch (e) {}
        apiLog.push({ action: body.action, rid: body.rid, body });
        if (failNext && body.action === failNext) {
          failNext = null;
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end('{"ok":false}');
          return;
        }
        let out = { ok: true, version: 13 };
        if (body.action === 'getState' || !body.action) {
          if (opts.markSold && soldOnce) {
            const b = st.batches[0];
            Object.assign(b, { status: 'Sold', recorded: true, sellDate: '2026-11-13', actualValue: 56000, actualProfit: 11000 });
            st.sales = [{ date: '2026-11-13', batch: b.id, actual: 56000, profit: 11000 }];
            st.dashboard.totalRealized = 11000; st.month.realizedProfit = 11000;
          }
          out = { ok: true, version: 13, state: JSON.parse(JSON.stringify(st)) };
        } else if (body.action === 'getSettings') {
          out = { ok: true, version: 13, base: st.base, settings: st.settings, source: st.source, today: st.today, lastUpdated: st.lastUpdated };
        } else if (body.action === 'addPurchase') {
          const no = st.nextNo++; const w = Number(body.weightBhy);
          const item = { no, bno: no, date: body.date, weightBhy: w, grams: w / 2, purity: Number(body.purity), cost: Number(body.cost), status: 'In stock', at: body.at || '', qid: body.qid || '', projSell: null, projProfit: null };
          st.stock.push(item); purchases.push(item);
          out = { ok: true, version: 13, no, bno: no, message: 'Purchase added.', item };
        } else if (body.action === 'recordBatchSale') {
          const b = st.batches.find(x => x.id === body.batchId);
          if (b) {
            b.sellDate = body.sellDate; b.sellBase = body.sellBase; b.actualAmt = body.actualAmt;
            b.status = 'Sold'; b.recorded = true;
            const val = body.actualAmt !== '' && body.actualAmt != null ? Number(body.actualAmt) : Number(body.sellBase) * Number(b.refinedG);
            b.actualValue = val; b.actualProfit = val - Number(b.costInclFee);
            const existing = st.sales.find(x => x.batch === b.id);
            const row = { date: body.sellDate, batch: b.id, actual: val, profit: b.actualProfit };
            if (existing) Object.assign(existing, row); else st.sales.push(row);
            st.dashboard.totalRealized = st.sales.reduce((t, x) => t + (x.profit || 0), 0);
            st.month.realizedProfit = st.dashboard.totalRealized;
            soldOnce = true;
            out = { ok: true, version: 13, message: existing ? 'Sale updated.' : 'Batch recorded in Sales.', batchId: b.id, state: JSON.parse(JSON.stringify(st)) };
          } else out = { ok: false, error: 'Batch not found.' };
        } else if (body.action === 'setBatchEstimate') {
          const b = st.batches.find(x => x.id === body.batchId);
          if (b) { if (body.sellBase !== undefined) b.estBase = body.sellBase === '' ? null : Number(body.sellBase); if (body.actualG !== undefined) b.actualG = body.actualG === '' ? null : Number(body.actualG); }
          out = { ok: true, version: 13, message: 'Saved.', batchId: body.batchId, estBase: b && b.estBase, actualG: b && b.actualG };
        }
        res.writeHead(out.ok === false ? 200 : 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    let pth = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pth === '/') pth = '/index.html';
    const fp = path.join(ROOT, pth);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('x'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(fp).pipe(res);
  });
  return new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, apiLog, purchases, getFail: () => failNext, setFail: v => { failNext = v; }, getState: () => st })));
}

async function launch(viewport, extra) {
  extra = extra || {};
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext(Object.assign({
    viewport, timezoneId: 'Asia/Manila', locale: 'en-GB',
    isMobile: !!extra.mobile, hasTouch: !!extra.mobile,
    deviceScaleFactor: extra.dpr || 1
  }, extra.ctx || {}));
  if (extra.init) await context.addInitScript(extra.init);
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
  return { browser, context, page, dialogs };
}

async function ready(page) {
  await page.waitForFunction(() => window.__goldOutbox);
  await page.evaluate(() => window.__goldOutbox.ready());
}

async function setup(page, origin, token) {
  const url = origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + token);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForTimeout(400);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { server, port, apiLog, purchases, setFail, getState } = await startServer();
  const origin = 'http://127.0.0.1:' + port;

  // ---------- persist() unavailable + migration + unit validate ----------
  {
    const { browser, context, page, dialogs } = await launch({ width: 412, height: 915 }, {
      mobile: true, dpr: 3.5,
      init: () => {
        try { Object.defineProperty(navigator, 'storage', { configurable: true, value: { persist: undefined, estimate: async () => ({ usage: 0, quota: 0 }) } }); } catch (e) {}
        const q = [
          { rid: 'legacyrid01abc', date: '2026-11-12', weightBhy: 1.5, purity: 0.9, cost: 6000, createdAt: '2026-11-12T10:00:00.000Z', tries: 0 }
        ];
        localStorage.setItem('gold-tracker-queue', JSON.stringify(q));
      }
    });
    await page.goto(origin + '/index.html?test=1', { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.waitForTimeout(300);
    const items = await page.evaluate(() => window.__goldOutbox.items());
    const ls = await page.evaluate(() => localStorage.getItem('gold-tracker-queue'));
    const persist = await page.evaluate(() => ({ asked: window.__goldOutbox.persistAsked(), result: window.__goldOutbox.persistResult() }));
    ok(items.some(x => x.rid === 'legacyrid01abc' && (x.action === 'addPurchase' || !x.action) && x.weightBhy === 1.5), 'migration: legacy purchase is in the outbox');
    ok(items.filter(x => x.rid === 'legacyrid01abc').length === 1, 'migration: no duplicate of the legacy rid');
    ok(ls == null || ls === '[]', 'migration: old localStorage key cleared after confirm (got ' + String(ls) + ')');
    ok(persist.asked === true && persist.result === false, 'persist() unavailable: asked, result false, no crash');

    await setup(page, origin, TOKEN);
    const meta = await page.evaluate(() => window.__goldOutbox.meta());
    const unit = await page.evaluate(async ({ url, fp }) => {
      const vBad = window.__goldOutbox.validate({ v: 1, kind: 'gold-tracker-pending', url, fp: 'deadbeef', items: [] }, url, fp);
      const vOk = window.__goldOutbox.validate({ v: 1, kind: 'gold-tracker-pending', url, fp, items: [{ rid: 'x1', action: 'addPurchase', date: '2026-11-13', weightBhy: 1, purity: 0.8, cost: 1 }] }, url, fp);
      const vJunk = window.__goldOutbox.validate({ foo: 1 }, url, fp);
      return { vBad, vOk, vJunk, fp };
    }, { url: meta.url, fp: meta.fp });
    ok(!unit.vBad.ok && /different/i.test(unit.vBad.reason), 'validate: other backend rejected');
    ok(unit.vOk.ok && unit.vOk.items.length === 1, 'validate: same backend accepted');
    ok(!unit.vJunk.ok, 'validate: junk file rejected');
    await browser.close();
  }

  // ---------- phone: offline buy + sale, reload, online ordered sync, no dupes ----------
  {
    const { browser, context, page, dialogs } = await launch({ width: 412, height: 915 }, { mobile: true, dpr: 3.5 });
    await setup(page, origin, TOKEN);
    await context.setOffline(true);
    await page.waitForTimeout(300);

    await page.click('nav button[data-v=buy]');
    await page.waitForTimeout(200);
    await page.fill('#bw', '2.5');
    await page.fill('#bp', '87.1');
    await page.fill('#bc', '8875');
    await page.click('#bsave');
    await page.waitForTimeout(500);
    const afterBuy = await page.evaluate(() => window.__goldOutbox.items());
    ok(afterBuy.length >= 1 && afterBuy.some(x => x.action === 'addPurchase' && x.weightBhy === 2.5), 'offline buy queued in IDB outbox');

    await page.click('nav button[data-v=sales]');
    await page.waitForTimeout(300);
    await page.click('button:has-text("Record sale")');
    await page.waitForTimeout(200);
    await page.fill('#sb', '8300');
    await page.fill('#sa', '56440');
    await page.click('#sgo');
    await page.waitForTimeout(500);
    const queued = await page.evaluate(() => window.__goldOutbox.items());
    const acts = queued.map(x => x.action);
    ok(acts.includes('addPurchase') && acts.includes('recordBatchSale'), 'offline sale queued with the purchase: ' + acts.join(','));
    const appSales = await page.innerText('#app');
    ok(/waiting to sync/i.test(appSales) && /not confirmed/i.test(appSales), 'pending sale shown as waiting, not confirmed');
    const callsBefore = apiLog.filter(x => x.action === 'addPurchase' || x.action === 'recordBatchSale').length;
    ok(callsBefore === 0, 'nothing reached the mock API while offline');

    await page.screenshot({ path: path.join(SHOTS, 'phone-sale-waiting.png'), full_page: false });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.waitForTimeout(400);
    const afterReload = await page.evaluate(() => window.__goldOutbox.items());
    ok(afterReload.length === queued.length && afterReload.every(x => queued.some(y => y.rid === x.rid)), 'reload offline: queue intact in IndexedDB');

    await page.click('nav button[data-v=dash]');
    await page.waitForTimeout(300);
    const dash = await page.innerText('#app');
    ok(/waiting to sync/i.test(dash) && /not included in profit totals/i.test(dash), 'dashboard: pending sale not in confirmed profit');
    await page.screenshot({ path: path.join(SHOTS, 'phone-dash-pending.png'), full_page: false });

    await page.click('nav button[data-v=stock]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'phone-stock-queue.png'), full_page: false });

    const rids = afterReload.map(x => x.rid);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => window.__goldOutbox.items().length === 0, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    const left = await page.evaluate(() => window.__goldOutbox.items());
    const writes = apiLog.filter(x => x.action === 'addPurchase' || x.action === 'recordBatchSale');
    const order = writes.map(x => x.action);
    ok(left.length === 0, 'back online: queue emptied (left ' + left.length + ')');
    ok(order[0] === 'addPurchase' && order.includes('recordBatchSale'), 'ordered sync: purchase then sale (got ' + order.join(' > ') + ')');
    ok(writes.filter(x => x.action === 'addPurchase').length === 1 && writes.filter(x => x.action === 'recordBatchSale').length === 1, 'no duplicate writes: ' + JSON.stringify(order));
    ok(rids.includes(writes.find(x => x.action === 'addPurchase').rid) && rids.includes(writes.find(x => x.action === 'recordBatchSale').rid), 'same rids reused on sync');
    await browser.close();
  }

  // ---------- mid-request failure -> uncertain; then hold when stock already has it ----------
  {
    setFail('addPurchase');
    const { browser, context, page } = await launch({ width: 1366, height: 768 });
    await setup(page, origin, TOKEN);
    await page.click('nav button[data-v=buy]');
    await page.fill('#bw', '3');
    await page.fill('#bp', '88');
    await page.fill('#bc', '10000');
    await page.click('#bsave');
    await page.waitForTimeout(1500);
    const mid = await page.evaluate(() => window.__goldOutbox.items().filter(x => x.action === 'addPurchase' && x.weightBhy === 3));
    ok(mid.length === 1 && mid[0].uncertainAt, 'mid-request 500: purchase kept with uncertainAt (' + JSON.stringify(mid[0] && { uncertainAt: mid[0].uncertainAt, error: mid[0].error, hold: mid[0].hold }) + ')');

    // Pretend the write landed: put a matching row in sheet stock via evaluate hook after getState — easier: mutate next getState by buying into mock? The 500 didn't add it.
    // Inject a matching stock row into the page's ST and expire the window, then run the hold path by also making getState return it.
    // Use a second server flag: we'll add the row by calling hook after manually updating via evaluate on a custom path.
    await page.evaluate(async () => {
      window.__goldOutbox.setDedupeMs(0);
      const it = window.__goldOutbox.items().find(x => x.weightBhy === 3);
      if (it) it.uncertainAt = Date.now() - 1000;
    });
    // Add matching stock on the mock by a one-off purchase isn't right. Patch getState through page? Instead POST won't help.
    // We'll append to stock by evaluating nothing — startServer getState uses st. Add a hidden admin? Simpler: page-side stockMatch uses ST.stock — seed ST.stock and intercept...
    // Easier path: use hook after injecting into ST, then call the hold branch by syncing while getState would wipe ST.
    // So I need the mock getState to include the matching row. I'll just push onto getState() from this closure... getState is the live `st`.
    getState().stock.push({ no: 99, bno: 99, date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) /* v50: today (Manila), was a fixed 2026-11-13 */, weightBhy: 3, grams: 1.5, purity: 0.88, cost: 10000, status: 'In stock' });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1500);
    const held = await page.evaluate(() => window.__goldOutbox.items().filter(x => x.weightBhy === 3));
    ok(held.length === 1 && held[0].hold && /already be saved/i.test(held[0].hold), 'expired uncertain + stock match: held for review (' + (held[0] && held[0].hold) + ')');
    await page.screenshot({ path: path.join(SHOTS, 'laptop-hold.png'), full_page: false });
    await browser.close();
  }

  // ---------- export, clear, import; import other backend rejected ----------
  {
    const { browser, context, page, dialogs } = await launch({ width: 1366, height: 768 });
    await setup(page, origin, TOKEN);
    await context.setOffline(true);
    await page.click('nav button[data-v=buy]');
    await page.fill('#bw', '1.1');
    await page.fill('#bp', '85');
    await page.fill('#bc', '4000');
    await page.click('#bsave');
    await page.waitForTimeout(400);
    const exported = await page.evaluate(() => window.__goldOutbox.exportObj());
    ok(exported && exported.v === 1 && exported.items.length >= 1 && !JSON.stringify(exported).includes(TOKEN), 'export JSON has items and no raw token');
    const before = exported.items.map(x => x.rid);
    await page.evaluate(async () => { await window.__goldOutbox.clear(); });
    const empty = await page.evaluate(() => window.__goldOutbox.items());
    ok(empty.length === 0, 'clear emptied the outbox');
    const restored = await page.evaluate(async obj => {
      const meta = window.__goldOutbox.meta();
      const v = window.__goldOutbox.validate(obj, meta.url, meta.fp);
      if (!v.ok) return v;
      return window.__goldOutbox.importItems(v.items);
    }, exported);
    const after = await page.evaluate(() => window.__goldOutbox.items());
    ok(restored.ok && restored.added >= 1 && after.some(x => before.includes(x.rid)), 'import restored the queue by rid');
    const again = await page.evaluate(async obj => {
      const meta = window.__goldOutbox.meta();
      const v = window.__goldOutbox.validate(obj, meta.url, meta.fp);
      return window.__goldOutbox.importItems(v.items);
    }, exported);
    const after2 = await page.evaluate(() => window.__goldOutbox.items());
    ok(again.ok && again.added === 0 && after2.filter(x => before.includes(x.rid)).length === before.length, 'import dedupes by rid (no extras)');

    const otherFp = await page.evaluate(async tok => {
      // compute would need tokenFp — instead fabricate a file with wrong fp
      return 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    }, OTHER_TOKEN);
    const rejected = await page.evaluate(({ obj, fp }) => {
      const meta = window.__goldOutbox.meta();
      return window.__goldOutbox.validate(Object.assign({}, obj, { fp }), meta.url, meta.fp);
    }, { obj: exported, fp: otherFp });
    ok(!rejected.ok && /different/i.test(rejected.reason), 'import rejected for another backend');

    await page.evaluate(() => { document.getElementById('setBtn').click(); });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, 'laptop-settings-pending.png'), full_page: false });
    await browser.close();
  }

  server.close();
  console.log('\nSUMMARY ' + (n - fails) + ' passed, ' + fails + ' failed, of ' + n);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
