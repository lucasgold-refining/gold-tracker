// v55: undo and correct an existing direct sale (DS-), then group the items on Refining.
// The page talks to the real Api.gs on a mock sheet. Nothing calls a live sheet.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');
const { makeBackend, serve } = require('./real_backend');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const CHROME = '/opt/google/chrome/chrome';
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const pur = (be, no) => be.env.sheets.Purchases.d.slice(1).find(r => Number(r[0]) === no);
const arcFor = (be, id) => be.env.sheets.Archive.d.slice(1).filter(r => String(r[14] || '') === id && r[0] !== '' && r[0] != null);
const salesFor = (be, id) => be.env.sheets.Sales.d.slice(10).filter(r => String(r[8] || '') === id && r[0] !== '' && r[0] != null);
const stockNos = be => be.post({ action: 'getState' }).state.stock.map(x => x.no).sort((a, b) => a - b);

function seed(be) {
  be.add({ weightBhy: 2, purity: 0.998, cost: 8000, date: '2026-11-01', at: '2026-11-01T09:00:00+08:00' });
  be.add({ weightBhy: 1.5, purity: 1, cost: 9000, date: '2026-11-02', at: '2026-11-02T09:00:00+08:00' });
  be.add({ weightBhy: 2, purity: 0.9, cost: 4000, date: '2026-11-03', at: '2026-11-03T09:00:00+08:00' });
}
function sameItem(row, weight, purity, cost) {
  return !!row && Number(row[2]) === weight && Math.abs(Number(row[4]) - purity) < 1e-12 && Number(row[6]) === cost
    && row[10] === 'In stock' && (row[11] === '' || row[11] == null) && (row[12] === '' || row[12] == null);
}

(async () => {
  // ===== API: single undo restores the original row and leaves the other sale alone
  {
    const be = makeBackend(); seed(be);
    const keep = pur(be, 3).slice();
    ok(be.post({ action: 'sellStock', rid: 's1', nos: [1], sellDate: '2026-11-18', sellBase: 8250 }).ok, 'single sale recorded');
    ok(be.post({ action: 'sellStock', rid: 's5', nos: [2], sellDate: '2026-11-18', sellBase: 8250, actualAmt: 5000 }).saleId === 'DS-2', 'the other direct sale stays for the untouched check');
    const u = be.post({ action: 'undoDirectSale', rid: 'u1', saleId: 'DS-1' });
    ok(u.ok && /In stock again/.test(u.message), 'single undo (' + (u.message || u.error) + ')');
    ok(sameItem(pur(be, 1), 2, 0.998, 8000), 'single: #1 is back with its number, weight, purity and cost');
    ok(!salesFor(be, 'DS-1').length && !arcFor(be, 'DS-1').length, 'single: that Sales row and its Archive rows are gone');
    ok(salesFor(be, 'DS-2').length === 1 && arcFor(be, 'DS-2').length === 1, 'single: the other direct sale was not touched');
    ok(JSON.stringify(pur(be, 3).slice()) === JSON.stringify(keep), 'single: the 90% item was not rewritten');
    const again = be.post({ action: 'undoDirectSale', rid: 'u1', saleId: 'DS-1' });
    ok(again.ok && again.duplicate === true && stockNos(be).filter(x => x === 1).length === 1, 'single: same request id does not restore a second copy');
    const later = be.post({ action: 'undoDirectSale', rid: 'u1b', saleId: 'DS-1' });
    ok(later.ok && later.already === true && stockNos(be).filter(x => x === 1).length === 1, 'single: a later undo of a finished sale changes nothing');
  }

  // ===== API: group undo, then a failed blank rolls back
  {
    const be = makeBackend(); seed(be);
    ok(be.post({ action: 'sellStock', rid: 'sg', nos: [1, 2], sellDate: '2026-11-18', sellBase: 8250, actualAmt: 7770343.04 }).saleId === 'DS-1.2', 'group sale id is DS-1.2');
    const u = be.post({ action: 'undoDirectSale', rid: 'ug', saleId: 'DS-1.2' });
    ok(u.ok, 'group undo (' + (u.message || u.error) + ')');
    ok(sameItem(pur(be, 1), 2, 0.998, 8000) && sameItem(pur(be, 2), 1.5, 1, 9000), 'group: both items are back exactly');
    ok(!salesFor(be, 'DS-1.2').length && !arcFor(be, 'DS-1.2').length, 'group: sale and archive rows for DS-1.2 are gone');
    ok(be.post({ action: 'sellStock', rid: 'sg2', nos: [1], sellDate: '2026-11-18', sellBase: 8250 }).ok, 'resold #1 for the rollback check');
    const orig = be.ctx.goldApiBlankSaleRow_;
    be.ctx.goldApiBlankSaleRow_ = function () { throw new Error('boom'); };
    const bad = be.post({ action: 'undoDirectSale', rid: 'bad', saleId: 'DS-1' });
    be.ctx.goldApiBlankSaleRow_ = orig;
    ok(!bad.ok && /Nothing was undone/.test(bad.error || ''), 'rollback: the sheet refused (' + (bad.error || '') + ')');
    ok(!pur(be, 1) && salesFor(be, 'DS-1').length === 1 && arcFor(be, 'DS-1').length === 1, 'rollback: #1 is not In stock and the sale is still there');
    const fixed = be.post({ action: 'undoDirectSale', rid: 'bad2', saleId: 'DS-1' });
    ok(fixed.ok && sameItem(pur(be, 1), 2, 0.998, 8000), 'after the failure, a new undo still restores #1');
  }

  // ===== API: correct rewrites the one sales row and leaves the item cost alone
  {
    const be = makeBackend(); seed(be);
    be.post({ action: 'sellStock', rid: 'sc', nos: [1], sellDate: '2026-11-18', sellBase: 8250 });
    const beforeArc = arcFor(be, 'DS-1')[0].slice();
    const c = be.post({ action: 'correctDirectSale', rid: 'cc', saleId: 'DS-1', sellDate: '2026-11-19', sellBase: 8300, actualAmt: 9000 });
    ok(c.ok && /updated/.test(c.message), 'correct (' + (c.message || c.error) + ')');
    const row = salesFor(be, 'DS-1');
    ok(row.length === 1 && row[0][4] === 8000 && row[0][5] === 9000 && row[0][1] === 8300, 'correct: one row, cost unchanged, amount and base updated');
    ok(Number(beforeArc[2]) === Number(arcFor(be, 'DS-1')[0][2]) && Number(beforeArc[6]) === Number(arcFor(be, 'DS-1')[0][6]), 'correct: archive weight and cost were not rewritten');
    const dup = be.post({ action: 'correctDirectSale', rid: 'cc', saleId: 'DS-1', sellDate: '2026-11-20', sellBase: 1, actualAmt: 1 });
    ok(dup.duplicate === true && salesFor(be, 'DS-1').length === 1 && salesFor(be, 'DS-1')[0][5] === 9000, 'correct: same request id does not write a second row or the later figures');
  }

  const holder = {}; const srv = await serve(ROOT, holder);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  async function open(be) {
    holder.cur = be;
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true, timezoneId: 'Asia/Manila', locale: 'en-GB' });
    const page = await context.newPage();
    page.on('dialog', d => d.accept());
    page.on('pageerror', e => { console.log('PAGEERROR ' + e.message); fails++; });
    const origin = 'http://127.0.0.1:' + srv.port;
    await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + be.token), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
    await page.waitForTimeout(400);
    return { context, page };
  }
  async function drain(page) {
    for (let i = 0; i < 40; i++) {
      const left = await page.evaluate(() => window.__goldOutbox.items().filter(x => !x.error && !x.hold).length);
      if (!left) return true;
      await page.waitForTimeout(300);
    }
    return false;
  }

  // ===== phone: undo one direct sale, then group that item onto Refining
  {
    const be = makeBackend(); seed(be);
    ok(be.post({ action: 'sellStock', rid: 'ps', nos: [1], sellDate: '2026-11-18', sellBase: 8250 }).saleId === 'DS-1', 'phone single sale');
    const { context, page } = await open(be);
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(300);
    ok(await page.$('button.undo[data-sale="DS-1"]') && await page.$('button.cor[data-sale="DS-1"]'), 'phone: the direct sale has Correct and Undo');
    await page.click('button.undo'); await page.waitForSelector('#undoGo');
    ok(/original number, weight, purity and cost/.test(await page.textContent('#modal')), 'phone: the confirm says the original item data comes back');
    await page.click('#undoGo');
    ok(await drain(page), 'phone single undo synced');
    ok(sameItem(pur(be, 1), 2, 0.998, 8000) && !salesFor(be, 'DS-1').length, 'phone: #1 is back and DS-1 is gone');
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250);
    ok(!(await page.$('button.sell')) && (await page.textContent('#sellBtn')).includes('Group 99.8%'), 'phone: the restored item is grouped, not sold, from In stock');
    await page.click('#sellBtn'); await page.waitForSelector('#gpList');
    await page.click('#gpList input[data-no="1"]'); await page.click('#gpGo');
    ok(await drain(page), 'phone: group synced');
    const ref = be.post({ action: 'getState' }).state.batches.find(b => b.id !== 'R-20261018' && b.status === 'Refining');
    ok(ref && ref.items === 1 && !salesFor(be, 'DS-1').length, 'phone: #1 is one refining batch and not a direct sale (' + (ref && ref.id) + ')');
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(200);
    await page.click('#sellRefBtn'); await page.click(`#bgList input[data-bid="${ref.id}"]`);
    await page.click('#bgNext'); await page.click('#bgGo');
    ok(await drain(page), 'phone: the grouped batch was sold with Sell refined');
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(300);
    const acts = await page.$$eval('.sale', rows => rows.map(r => ({ t: r.innerText.replace(/\s+/g, ' ').trim(), undo: !!r.querySelector('button.undo'), cor: !!r.querySelector('button') })));
    const line = acts.find(a => a.t.includes(ref.id));
    ok(line && !line.undo && /Correct/.test(line.t), 'phone: the refining-batch sale has Correct and no Undo (' + (line && line.t) + ')');
    await context.close();
  }

  // ===== phone: offline undo of a group sale, reload, one request, then group both onto Refining
  {
    const be = makeBackend(); seed(be);
    ok(be.post({ action: 'sellStock', rid: 'pg', nos: [1, 2], sellDate: '2026-11-18', sellBase: 8250, actualAmt: 7770343.04 }).saleId === 'DS-1.2', 'phone group sale');
    const { context, page } = await open(be);
    await context.setOffline(true); await page.waitForTimeout(150);
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(250);
    await page.click('button.undo'); await page.waitForSelector('#undoGo'); await page.click('#undoGo');
    await page.waitForTimeout(300);
    const rid = await page.evaluate(() => { const it = Q.find(x => x.action === 'undoDirectSale'); return it && it.rid; });
    ok(!!rid, 'offline: the undo is queued');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
    await page.waitForTimeout(300);
    const q = await page.evaluate(() => window.__goldOutbox.items().filter(x => x.action === 'undoDirectSale').map(x => x.rid + ':' + x.saleId));
    ok(q.length === 1 && q[0] === rid + ':DS-1.2', 'offline: reload kept one undo (' + q.join() + ')');
    await context.setOffline(false); await page.waitForTimeout(200);
    ok(await drain(page), 'offline undo synced');
    ok(sameItem(pur(be, 1), 2, 0.998, 8000) && sameItem(pur(be, 2), 1.5, 1, 9000), 'group: both items are back exactly after the queued undo');
    ok(stockNos(be).filter(x => x === 1).length === 1 && stockNos(be).filter(x => x === 2).length === 1, 'group: neither item was restored twice');
    ok(!salesFor(be, 'DS-1.2').length && sameItem(pur(be, 3), 2, 0.9, 4000), 'group: the sale is gone and the 90% item is unchanged');
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250);
    await page.click('#sellBtn'); await page.waitForSelector('#gpList');
    await page.click('#gpList input[data-no="1"]'); await page.click('#gpList input[data-no="2"]');
    await page.click('#gpGo');
    ok(await drain(page), 'group: the restored items were grouped');
    const req = srv.log.filter(x => x.action === 'batchRefine').pop();
    ok(req && JSON.stringify(req.body.pickNos) === '[1,2]' && req.out && req.out.ok, 'group: batchRefine got [1,2]');
    const b = be.post({ action: 'getState' }).state.batches.find(x => x.id === req.body.batchId);
    ok(b && b.status === 'Refining' && b.items === 2 && !salesFor(be, 'DS-1.2').length, 'group: one refining batch, not a direct sale');
    await context.close();
  }

  await browser.close(); srv.server.close();
  console.log(`\nSUMMARY undo_direct_e2e ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
