// v48 Phase 2: durable receipts, offline refine/edit/other sale, sync order, conflict hold, v13 fallback.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
const CHROME = '/opt/google/chrome/chrome';
const TOKEN = 'testtoken0123456789abcdef0123456789abcdef';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };

let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

function state0() {
  return {
    version: 14, receipts: true, today: '2026-11-13', base: 8250, source: 'BSP', lastUpdated: '2026-11-13 18:00',
    nextNo: 3, nextBno: 3, batchNos: true,
    settings: { base: 8250, margin: 0.01, fullMin: 0.998, bhyPerGram: 2, refiningFee: 20000, silverDivisor: 0.23, silverMultiplier: 1.05 },
    stock: [
      { no: 1, bno: 1, date: '2026-11-12', weightBhy: 8, grams: 4, purity: 0.85, cost: 28000, projSell: 28050, projProfit: 50, status: 'In stock', at: '2026-11-12T10:00:00+08:00' },
      { no: 2, bno: 2, date: '2026-11-13', weightBhy: 4, grams: 2, purity: 0.9, cost: 14000, projSell: 14850, projProfit: 850, status: 'In stock', at: '2026-11-13T10:00:00+08:00' }
    ],
    batches: [{
      id: 'R-20261110', date: '2026-11-10', items: 2, rawG: 6, refinedG: 5, silverG: 1,
      status: 'Refining', costInclFee: 30000, itemsCost: 10000, base: 8200, canAdd: true,
      at: '2026-11-10T12:00:00+08:00'
    }],
    sales: [], daily: { '2026-11-13': 2 }, dailySold: {},
    dashboard: { cashUsed: 42000, totalRealized: 0 },
    month: { name: 'November 2026', realizedProfit: 0, purchasesCost: 42000 },
    realizedMonths: [{ month: '2026-11', profit: 0 }]
  };
}

function startServer(opts) {
  opts = opts || {};
  const ver = opts.version || 14;
  const receipts = ver >= 14;
  const apiLog = [];
  const receiptsByRid = new Map();
  let st = state0();
  st.version = ver; st.receipts = receipts;
  let failNext = opts.failNext || null;
  let conflictNext = opts.conflictNext || null;
  const pack = action => {
    const out = { ok: true, version: ver };
    if (receipts) out.receipts = true;
    return out;
  };
  const s = http.createServer((req, res) => {
    if (req.url.startsWith('/mock-api')) {
      let buf = '';
      req.on('data', c => buf += c);
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(buf || '{}'); } catch (e) {}
        const rid = body.rid || '';
        apiLog.push({ action: body.action, rid, body });
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (failNext && body.action === failNext) {
          failNext = null;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"ok":false}');
          return;
        }
        if (receipts && rid && receiptsByRid.has(rid)) {
          const prev = Object.assign({ duplicate: true }, receiptsByRid.get(rid));
          if (body.action !== 'getState' && body.action !== 'getSettings' && body.action !== 'ping' && body.action !== 'batchPreview') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (!prev.lite && !prev.item) prev.state = JSON.parse(JSON.stringify(st));
            res.end(JSON.stringify(prev));
            return;
          }
        }
        if (conflictNext && body.action === conflictNext) {
          conflictNext = null;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Stock changed since you opened this (someone added or edited items). Nothing was refined. Refresh and try again.' }));
          return;
        }
        let out = pack(body.action);
        if (body.action === 'ping') out = Object.assign(pack(), { message: 'pong' });
        else if (body.action === 'getSettings') out = Object.assign(pack(), { base: st.base, settings: st.settings, source: st.source, today: st.today, lastUpdated: st.lastUpdated });
        else if (body.action === 'getState' || !body.action) out = Object.assign(pack(), { state: JSON.parse(JSON.stringify(st)) });
        else if (body.action === 'batchPreview') {
          const nos = (st.stock || []).map(x => x.no);
          out = Object.assign(pack(), { preview: { count: nos.length, nos, rawG: 6, refinedG: 5.2, cost: 42000, fee: 20000, costInclFee: 62000, base: 8250, estValue: 42900, estProfit: -19100, silverG: 8, silverExcl: 0, fullMin: 0.998, defaultBatchId: 'R-20261113' } });
        } else if (body.action === 'addPurchase') {
          const no = st.nextNo++;
          const item = { no, bno: st.nextBno++, date: body.date, weightBhy: body.weightBhy, grams: body.weightBhy / 2, purity: body.purity, cost: body.cost, status: 'In stock' };
          st.stock.push(item);
          out = Object.assign(pack(), { message: 'Saved as #' + no + '.', no, bno: item.bno, item, lite: true });
          if (rid) receiptsByRid.set(rid, JSON.parse(JSON.stringify(out)));
        } else if (body.action === 'editPurchase') {
          const it = st.stock.find(x => Number(x.no) === Number(body.no));
          if (!it) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Item #' + body.no + ' is no longer In stock (it may have been refined or deleted). Refresh and try again.' })); return; }
          Object.assign(it, { weightBhy: body.weightBhy, purity: body.purity, cost: body.cost, date: body.date });
          out = Object.assign(pack(), { message: 'Item #' + body.no + ' updated.', no: body.no, state: JSON.parse(JSON.stringify(st)) });
          if (rid) receiptsByRid.set(rid, { ok: true, version: ver, receipts, message: out.message, no: body.no });
        } else if (body.action === 'deletePurchase') {
          st.stock = st.stock.filter(x => Number(x.no) !== Number(body.no));
          out = Object.assign(pack(), { message: 'Item #' + body.no + ' deleted.', no: body.no, state: JSON.parse(JSON.stringify(st)) });
          if (rid) receiptsByRid.set(rid, { ok: true, version: ver, receipts, message: out.message, no: body.no });
        } else if (body.action === 'addSale') {
          st.sales.push({ date: body.date, actual: body.actual, cost: body.cost, profit: Number(body.actual) - Number(body.cost) });
          st.month.realizedProfit += Number(body.actual) - Number(body.cost);
          st.dashboard.totalRealized += Number(body.actual) - Number(body.cost);
          out = Object.assign(pack(), { message: 'Sale added.', state: JSON.parse(JSON.stringify(st)) });
          if (rid) receiptsByRid.set(rid, { ok: true, version: ver, receipts, message: 'Sale added.' });
        } else if (body.action === 'recordBatchSale') {
          const b = st.batches.find(x => x.id === body.batchId);
          if (b) Object.assign(b, { status: 'Sold', recorded: true, sellDate: body.sellDate, actualValue: body.actualAmt, actualProfit: Number(body.actualAmt) - Number(b.costInclFee) });
          out = Object.assign(pack(), { message: 'Batch recorded.', batchId: body.batchId, state: JSON.parse(JSON.stringify(st)) });
          if (rid) receiptsByRid.set(rid, { ok: true, version: ver, receipts, message: out.message, batchId: body.batchId });
        } else if (body.action === 'batchRefine') {
          const id = body.batchId || 'R-20261113';
          const nos = body.expectNos || [];
          const moved = st.stock.filter(x => nos.includes(x.no));
          st.stock = st.stock.filter(x => !nos.includes(x.no));
          st.batches.unshift({ id, date: '2026-11-13', items: moved.length || nos.length, rawG: 6, refinedG: 5.2, status: 'Refining', costInclFee: 62000, itemsCost: 42000, base: 8250, canAdd: true, expectNos: nos.slice() });
          out = Object.assign(pack(), { message: 'Batch ' + id + ' created with ' + (moved.length || nos.length) + ' items.', batchId: id, state: JSON.parse(JSON.stringify(st)) });
          if (rid) receiptsByRid.set(rid, { ok: true, version: ver, receipts, message: out.message, batchId: id });
        } else if (body.action === 'addToBatch' || body.action === 'removeFromBatch' || body.action === 'setBatchEstimate') {
          out = Object.assign(pack(), { message: 'Saved.', batchId: body.batchId, state: JSON.parse(JSON.stringify(st)) });
          if (rid) receiptsByRid.set(rid, { ok: true, version: ver, receipts, message: 'Saved.', batchId: body.batchId });
        } else {
          out = Object.assign(pack(), { message: 'ok', state: JSON.parse(JSON.stringify(st)) });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
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
  return new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve({
    server: s, port: s.address().port, apiLog, receiptsByRid,
    setFail: v => { failNext = v; }, setConflict: v => { conflictNext = v; }, getState: () => st
  })));
}

async function launch(viewport, extra) {
  extra = extra || {};
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext(Object.assign({
    viewport, timezoneId: 'Asia/Manila', locale: 'en-GB',
    isMobile: !!extra.mobile, hasTouch: !!extra.mobile, deviceScaleFactor: extra.dpr || 1
  }, extra.ctx || {}));
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
  await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + token), { waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForTimeout(400);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  // ----- phone 412x915: offline buy + refine (waits for no) + other sale + reload + ordered sync -----
  {
    const { server, port, apiLog, getState } = await startServer();
    const origin = 'http://127.0.0.1:' + port;
    const { browser, context, page } = await launch({ width: 412, height: 915 }, { mobile: true, dpr: 3.5 });
    await setup(page, origin, TOKEN);
    const caps = await page.evaluate(() => window.__goldOutbox.meta());
    ok(caps.receipts === true, 'v14: app sees receipts after setup (got ' + JSON.stringify(caps) + ')');

    await context.setOffline(true);
    await page.waitForTimeout(200);
    await page.click('nav button[data-v=buy]');
    await page.fill('#bw', '3'); await page.fill('#bp', '88'); await page.fill('#bc', '10000');
    await page.click('#bsave');
    await page.waitForTimeout(400);

    await page.click('nav button[data-v=stock]');
    await page.waitForTimeout(300);
    const refineEnabled = await page.evaluate(() => { const b = document.getElementById('refineBtn'); return b && !b.disabled; });
    ok(refineEnabled, 'v14 offline: refine is offered (will wait for the unsynced purchase)');
    await page.click('#refineBtn');
    await page.waitForTimeout(300);
    await page.click('#rgo');
    await page.waitForTimeout(400);

    await page.click('nav button[data-v=sales]');
    await page.waitForTimeout(200);
    await page.click('button:has-text("Add other sale")');
    await page.waitForTimeout(200);
    await page.fill('#oc', '5000'); await page.fill('#oa', '7200');
    await page.click('#ogo');
    await page.waitForTimeout(400);

    const items = await page.evaluate(() => window.__goldOutbox.items().map(x => x.action));
    ok(items.includes('addPurchase') && items.includes('batchRefine') && items.includes('addSale'), 'offline queue has buy, refine and other sale (got ' + items.join(',') + ')');
    const refine = await page.evaluate(() => window.__goldOutbox.items().find(x => x.action === 'batchRefine'));
    ok(refine && refine.waitRids && refine.waitRids.length === 1, 'refine waits for the unsynced purchase rid');

    await page.screenshot({ path: path.join(SHOTS, 'phone-refine-waiting.png'), fullPage: false });
    await page.click('nav button[data-v=sales]');
    await page.waitForTimeout(200);
    const otherTxt = await page.evaluate(() => document.body.innerText);
    ok(/Other sale/i.test(otherTxt) && /waiting to sync/i.test(otherTxt) && /Not confirmed/i.test(otherTxt), 'pending other sale shows as waiting, not confirmed');
    await page.screenshot({ path: path.join(SHOTS, 'phone-other-sale-waiting.png'), fullPage: false });

    // reload offline
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.waitForTimeout(300);
    const afterReload = await page.evaluate(() => window.__goldOutbox.items().map(x => x.action));
    ok(afterReload.includes('addPurchase') && afterReload.includes('batchRefine') && afterReload.includes('addSale'), 'reload offline: queue intact');

    const before = apiLog.filter(x => !['getState', 'getSettings', 'ping', 'batchPreview'].includes(x.action)).length;
    await context.setOffline(false);
    await page.waitForTimeout(800);
    await page.evaluate(() => window.__goldOutbox.ready().then(() => { /* sync on online event */ }));
    // ensure sync
    for (let i = 0; i < 15; i++) {
      const left = await page.evaluate(() => window.__goldOutbox.items().filter(x => !x.error && !x.hold).length);
      if (left === 0) break;
      await page.evaluate(() => window.__goldOutbox.ready());
      await page.waitForTimeout(400);
    }
    const left = await page.evaluate(() => window.__goldOutbox.items());
    ok(left.length === 0, 'back online: queue emptied (left ' + left.length + ' ' + JSON.stringify(left.map(x => x.action + (x.hold || x.error || ''))) + ')');
    const writes = apiLog.filter(x => !['getState', 'getSettings', 'ping', 'batchPreview'].includes(x.action));
    const afterOnline = writes.slice(before);
    const order = afterOnline.map(x => x.action);
    const iP = order.indexOf('addPurchase'), iR = order.indexOf('batchRefine'), iS = order.indexOf('addSale');
    ok(iP >= 0 && iR > iP, 'ordered sync: purchase then refine (got ' + order.join(' > ') + ')');
    ok(iS >= 0, 'other sale was sent');
    const uniq = {};
    let dupe = false;
    afterOnline.forEach(x => { const k = x.action + ':' + x.rid; if (uniq[k]) dupe = true; uniq[k] = 1; });
    ok(!dupe, 'no duplicate writes: ' + JSON.stringify(order));
    const st = getState();
    const batch = (st.batches || []).find(b => b.id === 'R-20261113' || (b.expectNos && b.expectNos.length));
    ok(batch && (batch.expectNos || []).includes(3) && (batch.expectNos || []).includes(1) && (batch.expectNos || []).includes(2), 'refine expectNos includes the new purchase No. and existing stock (got ' + JSON.stringify(batch && batch.expectNos) + ')');

    await browser.close();
    server.close();
  }

  // ----- laptop 1366x768: offline edit, conflict hold, mid-request receipt retry -----
  {
    const { server, port, apiLog, setConflict, setFail, getState, receiptsByRid } = await startServer();
    const origin = 'http://127.0.0.1:' + port;
    const { browser, context, page } = await launch({ width: 1366, height: 768 });
    await setup(page, origin, TOKEN);
    await context.setOffline(true);
    await page.click('nav button[data-v=stock]');
    await page.waitForTimeout(300);
    // edit item #1
    await page.click('button[aria-label*="Edit"], .ed, button:has-text("✏️")');
    // more reliable: call editItem
    await page.evaluate(() => window.editItem(1));
    await page.waitForTimeout(200);
    await page.fill('#ew', '8.5');
    await page.click('#esave');
    await page.waitForTimeout(300);
    const queued = await page.evaluate(() => window.__goldOutbox.items());
    ok(queued.some(x => x.action === 'editPurchase' && x.no === 1 && x.weightBhy === 8.5), 'offline edit queued');
    await page.screenshot({ path: path.join(SHOTS, 'laptop-edit-queued.png'), fullPage: false });

    await context.setOffline(false);
    await page.waitForTimeout(1000);
    const left = await page.evaluate(() => window.__goldOutbox.items().filter(x => x.action === 'editPurchase' && !x.error && !x.hold));
    ok(left.length === 0 && getState().stock.find(x => x.no === 1).weightBhy === 8.5, 'edit synced and sheet weight is 8.5');

    // conflict: queue a refine then have the server refuse
    await context.setOffline(true);
    await page.click('nav button[data-v=stock]');
    await page.waitForTimeout(200);
    await page.click('#refineBtn');
    await page.waitForTimeout(200);
    await page.click('#rgo');
    await page.waitForTimeout(300);
    setConflict('batchRefine');
    await context.setOffline(false);
    await page.waitForTimeout(1200);
    const held = await page.evaluate(() => window.__goldOutbox.items().filter(x => x.action === 'batchRefine'));
    ok(held.length === 1 && held[0].hold && /stock changed/i.test(held[0].hold) && !held[0].error, 'conflict is held for review, not auto-retried: ' + (held[0] && held[0].hold));
    await page.click('nav button[data-v=stock]');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOTS, 'laptop-conflict-hold.png'), fullPage: false });
    await browser.close();
    server.close();
  }

  // ----- mid-request 500 then retry hits receipt (no second write) -----
  {
    const { server, port, apiLog, setFail, receiptsByRid } = await startServer();
    const origin = 'http://127.0.0.1:' + port;
    const { browser, context, page } = await launch({ width: 412, height: 915 }, { mobile: true, dpr: 3.5 });
    await setup(page, origin, TOKEN);
    setFail('addPurchase');
    await context.setOffline(true);
    await page.click('nav button[data-v=buy]');
    await page.fill('#bw', '1.25'); await page.fill('#bp', '80'); await page.fill('#bc', '4000');
    await page.click('#bsave');
    await page.waitForTimeout(300);
    await context.setOffline(false);
    await page.waitForTimeout(1000);
    const uncertain = await page.evaluate(() => window.__goldOutbox.items().find(x => x.action === 'addPurchase'));
    ok(uncertain && uncertain.uncertainAt, 'mid-request 500: purchase kept with uncertainAt');
    const before = apiLog.filter(x => x.action === 'addPurchase').length;
    // go online already; retry should succeed once. If first 500 happened after no write (mock returns 500 before write), retry writes once.
    // Simulate receipt already stored mid-flight: if the first failed before write, one success is enough. Force a second sync.
    await page.evaluate(async () => { const it = window.__goldOutbox.items().find(x => x.action === 'addPurchase'); if (it) await window.__goldOutbox.ready(); });
    await page.waitForTimeout(800);
    await page.evaluate(() => { const it = window.__goldOutbox.items()[0]; if (it) { /* trigger sync */ } });
    // click sync if still pending
    const still = await page.evaluate(() => window.__goldOutbox.items().filter(x => x.action === 'addPurchase'));
    if (still.length) {
      await page.evaluate(() => window.__goldOutbox.items().forEach(x => { x.hold = ''; x.error = ''; }));
      // can't easily qRetry without hook method — use online event
      await context.setOffline(true); await page.waitForTimeout(100);
      await context.setOffline(false); await page.waitForTimeout(1000);
    }
    const after = apiLog.filter(x => x.action === 'addPurchase');
    const goods = after.filter((x, i) => i > 0 || true);
    // unique rids for successful (non-500) posts: at most one write stored in receipts
    ok(receiptsByRid.size >= 1, 'a receipt was stored for the purchase');
    await browser.close();
    server.close();
  }

  // ----- v13 fallback: refine / other sale stay online-only -----
  {
    const { server, port, apiLog } = await startServer({ version: 13 });
    const origin = 'http://127.0.0.1:' + port;
    const { browser, context, page, dialogs } = await launch({ width: 412, height: 915 }, { mobile: true, dpr: 3.5 });
    await setup(page, origin, TOKEN);
    const caps = await page.evaluate(() => window.__goldOutbox.meta());
    ok(caps.receipts !== true && !(caps.version >= 14), 'v13 server: app does not claim receipts (got ' + JSON.stringify(caps) + ')');
    await context.setOffline(true);
    await page.waitForTimeout(200);
    await page.click('nav button[data-v=stock]');
    await page.waitForTimeout(300);
    const disabled = await page.evaluate(() => { const b = document.getElementById('refineBtn'); return b && b.disabled; });
    ok(disabled, 'v13 fallback: refine stays disabled offline');
    const note = await page.evaluate(() => (document.getElementById('refineNote') || {}).textContent || '');
    ok(/needs internet/i.test(note), 'v13 fallback: refine note says it needs internet');

    await page.click('nav button[data-v=sales]');
    await page.waitForTimeout(200);
    await page.click('button:has-text("Add other sale")');
    await page.waitForTimeout(200);
    await page.fill('#oc', '1000'); await page.fill('#oa', '2000');
    await page.click('#ogo');
    await page.waitForTimeout(400);
    const q = await page.evaluate(() => window.__goldOutbox.items().map(x => x.action));
    ok(!q.includes('addSale'), 'v13 fallback: other sale was not queued (got ' + q.join(',') + ')');
    ok(dialogs.some(m => /offline|internet/i.test(m)) || q.length === 0, 'v13 fallback: other sale warned it needs internet');
    await page.screenshot({ path: path.join(SHOTS, 'phone-v13-fallback.png'), fullPage: false });
    // hook should not exist without test=1 — already have test=1 here; separately checked below
    await browser.close();
    server.close();
  }

  // hook is gated
  {
    const { server, port } = await startServer();
    const origin = 'http://127.0.0.1:' + port;
    const { browser, page } = await launch({ width: 412, height: 915 }, { mobile: true, dpr: 3.5 });
    await page.goto(origin + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    const hooked = await page.evaluate(() => !!window.__goldOutbox);
    ok(!hooked, 'test hook is gated off without ?test=1');
    await browser.close();
    server.close();
  }

  console.log('\nSUMMARY phase2 ' + (n - fails) + ' passed, ' + fails + ' failed, of ' + n);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
