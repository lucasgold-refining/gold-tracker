// v49 bug regressions. APP_ROOT=/path/to/app EXPECT_FIXED=1 (default) or 0 (v48 should fail some).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const EXPECT = process.env.EXPECT_FIXED !== '0';
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
    batches: [{ id: 'R-20261110', date: '2026-11-10', items: 2, rawG: 6, refinedG: 5, silverG: 1, status: 'Refining', costInclFee: 30000, itemsCost: 10000, base: 8200, canAdd: true, at: '2026-11-10T12:00:00+08:00' }],
    sales: [], daily: { '2026-11-13': 2 }, dailySold: {},
    dashboard: { cashUsed: 42000, totalRealized: 0 },
    month: { name: 'November 2026', realizedProfit: 0, purchasesCost: 42000 },
    realizedMonths: [{ month: '2026-11', profit: 0 }]
  };
}

function startServer(opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const verWrap = { version: opts.version || 14 };
    const receiptsOf = () => verWrap.version >= 14;
    const apiLog = [];
    const receiptsByRid = new Map();
    let st = state0();
    st.version = verWrap.version; st.receipts = receiptsOf();
    let failAfterWrite = null, failNoWrite = null;
    const pack = () => {
      const out = { ok: true, version: verWrap.version };
      if (receiptsOf()) out.receipts = true;
      return out;
    };
    const ctl = {
      apiLog, getState: () => st,
      setVersion(v) { verWrap.version = v; st.version = v; st.receipts = v >= 14; },
      setFail(action, afterWrite) { if (afterWrite) failAfterWrite = action; },
      setFailNoWrite(action) { failNoWrite = action; },
      clearFailNoWrite() { failNoWrite = null; }
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
          const send = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
          };
          if (failNoWrite && body.action === failNoWrite) return send(500, { ok: false });
          if (receiptsOf() && rid && receiptsByRid.has(rid) && !['getState','getSettings','ping','batchPreview'].includes(body.action)) {
            return send(200, Object.assign({ duplicate: true }, receiptsByRid.get(rid)));
          }
          let out = pack();
          const writeThenMaybeFail = () => {
            if (failAfterWrite && body.action === failAfterWrite) { failAfterWrite = null; send(500, { ok: false }); return true; }
            return false;
          };
          if (body.action === 'ping') out = Object.assign(pack(), { message: 'pong' });
          else if (body.action === 'getSettings') out = Object.assign(pack(), { base: st.base, settings: st.settings, source: st.source, today: st.today, lastUpdated: st.lastUpdated });
          else if (body.action === 'getState' || !body.action) out = Object.assign(pack(), { state: JSON.parse(JSON.stringify(st)) });
          else if (body.action === 'batchPreview') out = Object.assign(pack(), { preview: { count: (st.stock||[]).length, nos: (st.stock||[]).map(x => x.no), rawG: 6, refinedG: 5.2, cost: 42000, fee: 20000, costInclFee: 62000, base: 8250, estValue: 42900, estProfit: -19100, silverG: 8, silverExcl: 0, fullMin: 0.998, defaultBatchId: 'R-20261113' } });
          else if (body.action === 'addPurchase') {
            const no = st.nextNo++;
            const item = { no, bno: st.nextBno++, date: body.date, weightBhy: body.weightBhy, grams: body.weightBhy / 2, purity: body.purity, cost: body.cost, status: 'In stock' };
            st.stock.push(item);
            out = Object.assign(pack(), { message: 'Saved as #' + no + '.', no, bno: item.bno, item, lite: true });
            if (rid && receiptsOf()) receiptsByRid.set(rid, JSON.parse(JSON.stringify(out)));
            if (writeThenMaybeFail()) return;
          } else if (body.action === 'addSale') {
            st.sales.push({ date: body.date, actual: body.actual, cost: body.cost });
            out = Object.assign(pack(), { message: 'Sale added.', state: JSON.parse(JSON.stringify(st)) });
            if (rid && receiptsOf()) receiptsByRid.set(rid, { ok: true, version: verWrap.version, receipts: receiptsOf(), message: 'Sale added.' });
            if (writeThenMaybeFail()) return;
          } else if (body.action === 'batchRefine') {
            const nos = (body.expectNos || []).slice().map(Number).sort((a,b)=>a-b);
            const have = (st.stock || []).map(x => x.no).sort((a,b)=>a-b);
            if (Array.isArray(body.expectNos) && nos.join(',') !== have.join(',')) {
              return send(200, { ok: false, error: 'Stock changed since you opened this (someone added or edited items). Nothing was refined. Refresh and try again.' });
            }
            out = Object.assign(pack(), { message: 'Refined.', state: JSON.parse(JSON.stringify(st)) });
          } else out = Object.assign(pack(), { message: 'ok', state: JSON.parse(JSON.stringify(st)) });
          send(200, out);
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
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port, ctl }));
  });
}

async function launch() {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, isMobile: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
  });
  const page = await context.newPage();
  page.on('dialog', async d => { try { await d.accept(); } catch (e) {} });
  return { browser, context, page };
}
async function ready(page) {
  await page.waitForFunction(() => window.__goldOutbox && typeof window.__goldOutbox.ready === 'function');
  await page.evaluate(() => window.__goldOutbox.ready());
}
async function setup(page, origin) {
  await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + TOKEN), { waitUntil: 'domcontentloaded' });
  await ready(page);
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => window.__goldOutbox.meta().version)) return;
    await page.waitForTimeout(150);
  }
  throw new Error('setup did not connect');
}

console.log('bugs_regress ROOT=' + ROOT + ' EXPECT_FIXED=' + EXPECT);

(async () => {
  // 1. Save-all double-tap
  {
    const { server, port } = await startServer();
    const origin = 'http://127.0.0.1:' + port;
    const { browser, context, page } = await launch();
    await setup(page, origin);
    await context.setOffline(true);
    await page.click('nav button[data-v=buy]');
    await page.waitForTimeout(200);
    await page.evaluate(() => window.bbStart());
    await page.waitForTimeout(200);
    await page.fill('#bbw0', '3'); await page.fill('#bbp0', '85'); await page.fill('#bbc0', '9000');
    await page.evaluate(() => { window.saveAll(); window.saveAll(); });
    await page.waitForTimeout(600);
    const batch = await page.evaluate(() => window.__goldOutbox.items().filter(x => x.action === 'addPurchase' && x.cost === 9000));
    ok(EXPECT ? batch.length === 1 : batch.length === 2,
      (EXPECT ? 'v49: Save all double-invoke enqueues 1 row (got ' : 'v48: Save all double-invoke enqueues 2 rows (got ') + batch.length + ')');
    await browser.close(); server.close();
  }

  // 2. Uncertain delete is gated (does not delete on first confirm / weak wording)
  {
    const { server, port, ctl } = await startServer();
    const origin = 'http://127.0.0.1:' + port;
    const { browser, context, page } = await launch();
    await setup(page, origin);
    await context.setOffline(true);
    await page.evaluate(async () => {
      await window.enqueue({ action: 'addPurchase', rid: 'rid-unc', date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875, createdAt: new Date().toISOString(), tries: 0 });
    });
    ctl.setFail('addPurchase', true);
    await context.setOffline(false);
    for (let i = 0; i < 20; i++) {
      if (await page.evaluate(() => { const it = window.__goldOutbox.items().find(x => x.rid === 'rid-unc'); return it && it.uncertainAt; })) break;
      await page.waitForTimeout(200);
    }
    await page.evaluate(() => window.qDel('rid-unc'));
    await page.waitForTimeout(250);
    const gated = await page.evaluate(() => {
      const modal = document.getElementById('modal');
      const still = window.__goldOutbox.items().some(x => x.rid === 'rid-unc');
      return { still, hasModal: !!(modal && /Check Stock first/i.test(modal.textContent || '')) };
    });
    if (EXPECT) ok(gated.still && gated.hasModal, 'v49: uncertain delete opens Check Stock and does not drop the item yet (got ' + JSON.stringify(gated) + ')');
    else ok(!gated.still, 'v48: uncertain delete with auto-confirm removes the item immediately (still=' + gated.still + ')');
    await browser.close(); server.close();
  }

  // 3+6. synced nos persist on dependents after reload
  {
    const { server, port, ctl } = await startServer();
    const origin = 'http://127.0.0.1:' + port;
    const { browser, context, page } = await launch();
    await setup(page, origin);
    await context.setOffline(true);
    await page.evaluate(async () => {
      await window.enqueue({ action: 'addPurchase', rid: 'rid-new', date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875, createdAt: new Date().toISOString(), tries: 0 });
      await window.enqueue({ action: 'batchRefine', batchId: 'R-20261113', expectSheetNos: [1, 2], waitRids: ['rid-new'] });
    });
    ctl.setFailNoWrite('batchRefine');
    await context.setOffline(false);
    for (let i = 0; i < 25; i++) {
      const q = await page.evaluate(() => window.__goldOutbox.items().map(x => x.action));
      if (ctl.apiLog.some(x => x.action === 'addPurchase') && !q.includes('addPurchase')) break;
      await page.waitForTimeout(200);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => {
      const ref = window.__goldOutbox.items().find(x => x.action === 'batchRefine');
      return ref ? window.resolveNos(ref) : null;
    });
    if (EXPECT) ok(after && after.includes(1) && after.includes(2) && after.includes(3), 'v49: after reload resolveNos still has the new No. (got ' + JSON.stringify(after) + ')');
    else ok(after && after.join(',') === '1,2', 'v48: after reload resolveNos dropped the new No. (got ' + JSON.stringify(after) + ')');
    await browser.close(); server.close();
  }

  // 4. qEdit uncertain is gated
  {
    const { server, port, ctl } = await startServer();
    const origin = 'http://127.0.0.1:' + port;
    const { browser, context, page } = await launch();
    await setup(page, origin);
    await context.setOffline(true);
    await page.evaluate(async () => {
      await window.enqueue({ action: 'addPurchase', rid: 'rid-edit', date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875, createdAt: new Date().toISOString(), tries: 0 });
    });
    ctl.setFail('addPurchase', true);
    await context.setOffline(false);
    for (let i = 0; i < 20; i++) {
      if (await page.evaluate(() => { const it = window.__goldOutbox.items().find(x => x.rid === 'rid-edit'); return it && it.uncertainAt; })) break;
      await page.waitForTimeout(200);
    }
    await page.evaluate(() => window.qEdit('rid-edit'));
    await page.waitForTimeout(250);
    const gated = await page.evaluate(() => {
      const modal = document.getElementById('modal');
      return { hasGate: !!(modal && /Check Stock first/i.test(modal.textContent || '')), hasForm: !!(modal && document.getElementById('qw')) };
    });
    if (EXPECT) ok(gated.hasGate && !gated.hasForm, 'v49: uncertain edit opens Check Stock, not the edit form (got ' + JSON.stringify(gated) + ')');
    else ok(gated.hasForm && !gated.hasGate, 'v48: uncertain edit opens the form immediately (got ' + JSON.stringify(gated) + ')');
    await browser.close(); server.close();
  }

  // 5. caps downgrade on ping
  {
    const { server, port, ctl } = await startServer();
    const origin = 'http://127.0.0.1:' + port;
    const { browser, context, page } = await launch();
    await setup(page, origin);
    await context.setOffline(true);
    await page.evaluate(async () => {
      await window.enqueue({ action: 'addSale', rid: 'rid-os', date: '2026-11-13', cost: 5000, actual: 7200, createdAt: new Date().toISOString(), tries: 0 });
    });
    ctl.setVersion(13);
    await context.setOffline(false);
    await page.evaluate(() => window.syncQueue());
    await page.waitForTimeout(800);
    const caps = await page.evaluate(() => window.__goldOutbox.meta());
    const sent = ctl.apiLog.some(x => x.action === 'addSale');
    const held = await page.evaluate(() => {
      const it = window.__goldOutbox.items().find(x => x.rid === 'rid-os');
      return it ? (it.hold || '') : '';
    });
    if (EXPECT) ok(!sent && (caps.version === 13 || caps.receipts !== true),
      'v49: v13 ping drops caps and holds the v48 action (sent=' + sent + ', caps=' + JSON.stringify(caps) + ', hold=' + held + ')');
    else ok(sent, 'v48: v13 ping still sends the v48 action (sent=' + sent + ', caps=' + JSON.stringify(caps) + ')');
    await browser.close(); server.close();
  }

  // 7. lightOrFullRefresh inflight guard
  {
    const { server, port, ctl } = await startServer();
    const origin = 'http://127.0.0.1:' + port;
    const { browser, page } = await launch();
    await setup(page, origin);
    const before = ctl.apiLog.length;
    await page.evaluate(() => Promise.all([window.lightOrFullRefresh(), window.lightOrFullRefresh()]));
    await page.waitForTimeout(800);
    const settings = ctl.apiLog.slice(before).filter(x => x.action === 'getSettings').length;
    if (EXPECT) ok(settings === 1, 'v49: overlapping light refresh is 1 getSettings (got ' + settings + ')');
    else ok(settings === 2, 'v48: overlapping light refresh fires 2 getSettings (got ' + settings + ')');
    await browser.close(); server.close();
  }

  console.log('\nbugs_regress ' + (n - fails) + '/' + n + ' passed, fails=' + fails + ' ROOT=' + ROOT);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
