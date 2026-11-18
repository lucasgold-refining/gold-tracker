// v56: Group 99.8% has no refining fee. A normal refine still has one.
// An existing unsold all-99.8% batch can drop the fee it picked up under v55.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');
const { makeBackend, serve } = require('./real_backend');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const CHROME = '/opt/google/chrome/chrome';
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.02;
const batch = (be, id) => be.post({ action: 'getState' }).state.batches.find(b => b.id === id);

(async () => {
  // Group 99.8% costs the items only. A normal refine of lower gold still adds the fee.
  {
    const be = makeBackend();
    be.add({ weightBhy: 2, purity: 0.998, cost: 8000 });
    be.add({ weightBhy: 1.5, purity: 1, cost: 9000 });
    be.add({ weightBhy: 2, purity: 0.9, cost: 4000 });
    const g = be.post({ action: 'batchRefine', rid: 'g', batchId: 'G-998', pickNos: [1, 2], noFee: true });
    ok(g.ok, 'group refine (' + (g.message || g.error) + ')');
    const gb = batch(be, 'G-998');
    ok(gb && gb.noFee === true && gb.fee === 0 && near(gb.costInclFee, 17000) && near(gb.itemsCost, 17000), 'group cost is 8,000 + 9,000, fee 0 (' + JSON.stringify(gb && { cost: gb.costInclFee, items: gb.itemsCost, fee: gb.fee, noFee: gb.noFee }) + ')');
    const nrm = be.post({ action: 'batchRefine', rid: 'n', batchId: 'R-LOW', pickNos: [3] });
    ok(nrm.ok, 'normal refine (' + (nrm.message || nrm.error) + ')');
    const nb = batch(be, 'R-LOW');
    ok(nb && nb.noFee !== true && near(nb.costInclFee, 24000) && near(nb.fee, 20000), 'normal refine still adds the 20,000 fee (' + (nb && nb.costInclFee) + ')');
    ok(near(batch(be, 'G-998').costInclFee, 17000), 'the normal refine did not put a fee on the 99.8% group');
    const sale = be.post({ action: 'sellBatches', rid: 'sg', batchIds: ['G-998'], sellDate: '2026-11-18', sellBase: 8250 });
    ok(sale.ok, 'group sale (' + (sale.message || sale.error) + ')');
    const row = be.env.sheets.Sales.d.slice(10).find(r => String(r[8]) === 'G-998');
    ok(row && near(row[4], 17000), 'the recorded sale cost has no fee (' + (row && row[4]) + ')');
    const low = be.post({ action: 'sellBatches', rid: 'sl', batchIds: ['R-LOW'], sellDate: '2026-11-18', sellBase: 8250 });
    ok(low.ok, 'normal sale (' + (low.message || low.error) + ')');
    const lrow = be.env.sheets.Sales.d.slice(10).find(r => String(r[8]) === 'R-LOW');
    ok(lrow && near(lrow[4], 24000), 'the normal sale still includes the fee (' + (lrow && lrow[4]) + ')');
  }

  // A v55-style group (no marker) can drop its fee. A mixed batch cannot. A second tap does nothing.
  {
    const be = makeBackend();
    be.add({ weightBhy: 2, purity: 0.998, cost: 8000 });
    be.add({ weightBhy: 2, purity: 0.999, cost: 7000 });
    be.add({ weightBhy: 1, purity: 0.9, cost: 3000 });
    be.add({ weightBhy: 1, purity: 1, cost: 5000 });
    ok(be.post({ action: 'batchRefine', rid: 'old', batchId: 'R-OLD', pickNos: [1, 2] }).ok, 'v55-style group, fee included');
    ok(be.post({ action: 'batchRefine', rid: 'mix', batchId: 'R-MIX', pickNos: [3] }).ok, 'mixed batch');
    const beforeMix = batch(be, 'R-MIX').costInclFee;
    ok(near(batch(be, 'R-OLD').costInclFee, 35000), 'old group cost includes the 20,000 fee');
    const bad = be.post({ action: 'waiveBatchFee', rid: 'bad', batchId: 'R-MIX' });
    ok(!bad.ok && /below 99\.8%/.test(bad.error || '') && near(batch(be, 'R-MIX').costInclFee, beforeMix), 'a batch with lower gold keeps its fee (' + (bad.error || '') + ')');
    const w = be.post({ action: 'waiveBatchFee', rid: 'w', batchId: 'R-OLD' });
    ok(w.ok && /no refining fee/.test(w.message), 'fee removed (' + (w.message || w.error) + ')');
    const fixed = batch(be, 'R-OLD');
    ok(fixed.noFee === true && fixed.fee === 0 && near(fixed.costInclFee, 15000) && near(fixed.itemsCost, 15000), 'old group cost is now 8,000 + 7,000 (' + fixed.costInclFee + ')');
    ok(near(batch(be, 'R-MIX').costInclFee, beforeMix), 'the other batch was not changed');
    const again = be.post({ action: 'waiveBatchFee', rid: 'w', batchId: 'R-OLD' });
    ok(again.duplicate === true && near(batch(be, 'R-OLD').costInclFee, 15000), 'the same request does not change the cost again');
    const later = be.post({ action: 'waiveBatchFee', rid: 'w2', batchId: 'R-OLD' });
    ok(later.ok && later.already === true && near(batch(be, 'R-OLD').costInclFee, 15000), 'a later tap finds the fee already gone');
    ok(be.post({ action: 'addToBatch', rid: 'add', batchId: 'R-OLD', nos: [4] }).ok, 'a later 99.8% item can join');
    ok(near(batch(be, 'R-OLD').costInclFee, 20000) && batch(be, 'R-OLD').fee === 0, 'adding an item does not bring the fee back (' + batch(be, 'R-OLD').costInclFee + ')');
  }

  // Undo of a 99.8% group clears the no-fee mark, so the next normal refine keeps its fee.
  {
    const be = makeBackend();
    be.add({ weightBhy: 2, purity: 0.998, cost: 8000 });
    be.add({ weightBhy: 2, purity: 0.85, cost: 4000 });
    ok(be.post({ action: 'batchRefine', rid: 'ug', batchId: 'G-UNDO', pickNos: [1], noFee: true }).ok, 'undo setup: group');
    const row = be.env.sheets.Refining.d.findIndex(r => r[12] === 'G-UNDO');
    ok(row > 0 && (be.env.sheets.Refining.d[row][38] === 1 || be.env.sheets.Refining.d[row][38] === '1'), 'undo setup: the register row is marked');
    const u = be.post({ action: 'undoLastBatch', rid: 'uu', batchId: 'G-UNDO', items: 1 });
    ok(u.ok, 'undo of the group (' + (u.message || u.error) + ')');
    ok(be.env.sheets.Refining.d[row][38] === '' || be.env.sheets.Refining.d[row][38] == null, 'undo cleared the no-fee mark');
    be.env.sheets.Refining.d[row][38] = 1;   // a mark left behind, as the old undo did
    const nrm = be.post({ action: 'batchRefine', rid: 'un', batchId: 'R-NEXT', pickNos: [2] });
    ok(nrm.ok, 'normal refine after the undo (' + (nrm.message || nrm.error) + ')');
    const nb = batch(be, 'R-NEXT');
    ok(nb && nb.noFee !== true && near(nb.costInclFee, 24000) && near(nb.fee, 20000), 'the next normal batch keeps its fee (' + (nb && nb.costInclFee) + ')');
    const used = be.env.sheets.Refining.d.find(r => r[12] === 'R-NEXT');
    ok(used && (used[38] === '' || used[38] == null), 'the normal refine cleared the mark on the row it used');
  }

  // Trim freezes a marked batch's item cost without subtracting a fee that was never added.
  {
    const be = makeBackend();
    be.add({ weightBhy: 2, purity: 0.998, cost: 8000 });
    be.add({ weightBhy: 2, purity: 0.85, cost: 4000 });
    ok(be.post({ action: 'batchRefine', rid: 'tg', batchId: 'G-TRIM', pickNos: [1], noFee: true }).ok, 'trim setup: marked batch');
    ok(be.post({ action: 'batchRefine', rid: 'tn', batchId: 'R-TRIM', pickNos: [2] }).ok, 'trim setup: normal batch');
    ok(be.post({ action: 'sellBatches', rid: 'ts1', batchIds: ['G-TRIM'], sellDate: '2026-11-18', sellBase: 8250 }).ok, 'trim setup: sell the marked batch');
    ok(be.post({ action: 'sellBatches', rid: 'ts2', batchIds: ['R-TRIM'], sellDate: '2026-11-18', sellBase: 8250 }).ok, 'trim setup: sell the normal batch');
    const snap = be.ctx.trimSoldSnapshot_(be.env.sheets.Refining);
    const marked = snap.batches.filter(b => b.id === 'G-TRIM')[0];
    const plain = snap.batches.filter(b => b.id === 'R-TRIM')[0];
    ok(marked && marked.noFee === true && near(marked.costInclFee, 8000) && near(marked.itemsCost, 8000), 'marked batch freezes item cost 8,000, not 8,000 minus the fee (' + (marked && marked.itemsCost) + ')');
    ok(plain && plain.noFee !== true && near(plain.costInclFee, 24000) && near(plain.itemsCost, 4000), 'a normal sold batch still freezes item cost as cost minus the fee (' + (plain && plain.itemsCost) + ')');
  }

  const holder = {}; const srv = await serve(ROOT, holder);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const be = makeBackend(); holder.cur = be;
  be.add({ weightBhy: 2, purity: 0.998, cost: 8000 });
  be.add({ weightBhy: 2, purity: 0.9, cost: 4000 });
  ok(be.post({ action: 'batchRefine', rid: 'ui', batchId: 'R-LIVE', pickNos: [1] }).ok, 'phone: v55-style batch');
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true, timezoneId: 'Asia/Manila', locale: 'en-GB' });
  const page = await context.newPage();
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => { console.log('PAGEERROR ' + e.message); fails++; });
  const origin = 'http://127.0.0.1:' + srv.port;
  await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + be.token), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
  await page.waitForTimeout(400);
  await context.setOffline(true); await page.waitForTimeout(150);
  await page.click('nav button[data-v=sales]'); await page.waitForTimeout(300);
  ok(await page.$('button.nofee[data-bid="R-LIVE"]'), 'phone: the 99.8% batch offers No fee');
  ok(!(await page.$('button.nofee[data-bid="R-20261018"]')), 'phone: the older mixed batch has no No fee button');
  await page.click('button.nofee[data-bid="R-LIVE"]'); await page.waitForSelector('#nfGo');
  ok(/sum of the items/.test(await page.textContent('#modal')), 'phone: the confirm says the cost becomes the items only');
  await page.click('#nfGo'); await page.waitForTimeout(300);
  const rid = await page.evaluate(() => { const it = Q.find(x => x.action === 'waiveBatchFee'); return it && it.rid + ':' + it.batchId; });
  ok(rid && rid.endsWith(':R-LIVE'), 'offline: one fee change is queued (' + rid + ')');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
  const q = await page.evaluate(() => window.__goldOutbox.items().filter(x => x.action === 'waiveBatchFee').map(x => x.rid));
  ok(q.length === 1 && q[0] === rid.split(':')[0], 'offline: reload kept that one request');
  await context.setOffline(false); await page.waitForTimeout(200);
  for (let i = 0; i < 40 && await page.evaluate(() => window.__goldOutbox.items().filter(x => !x.error && !x.hold).length); i++) await page.waitForTimeout(300);
  const live = batch(be, 'R-LIVE'), keep = batch(be, 'R-20261018');
  ok(live && live.noFee === true && near(live.costInclFee, 8000), 'phone: R-LIVE cost is now 8,000 (' + (live && live.costInclFee) + ')');
  ok(keep && keep.noFee !== true && keep.costInclFee > 8000, 'phone: the other batch still has its fee (' + (keep && keep.costInclFee) + ')');
  await browser.close(); srv.server.close();
  console.log(`\nSUMMARY nofee_e2e ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
