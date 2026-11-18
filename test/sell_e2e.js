// v55: Group 99.8% moves ticked 99.8%+ stock into one refining batch (batchRefine pickNos).
// It does not sell. The owner sells that batch with Sell refined. A sale already queued as
// sellStock still syncs. The app talks to the real Code.gs + Api.gs on a mock sheet only.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');
const { makeBackend, serve } = require('./real_backend');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const V50 = path.join(__dirname, 'fixtures', 'Api-v50.gs');
const V15 = path.join(__dirname, 'fixtures', 'Api-v15.gs');
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
const CHROME = '/opt/google/chrome/chrome';
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
// #1 99.8%, #2 90%, #3 99.9% with a large cost, #4 99.7999% (looks like 99.80%), #5 100%
const SEED = [[2, 0.998, 8000], [2, 0.9, 4000], [3, 0.999, 1234567.89], [1, 0.997999, 3000], [1.5, 1, 9000]];
const inStock = be => be.env.sheets.Purchases.d.slice(1).filter(r => r[0] !== '' && r[2] !== '' && (r[10] === 'In stock' || r[10] === '')).map(r => Number(r[0]));
const saleIds = be => be.env.sheets.Sales.d.slice(10).map(r => r[8]).filter(x => x !== '' && x != null).map(String);
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.0005;
const openBatch = (be, id) => {
  const st = be.post({ action: 'getState' }).state;
  return (st.batches || []).find(b => b.id === id);
};

async function open(srv, be) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true, timezoneId: 'Asia/Manila', locale: 'en-GB' });
  const page = await context.newPage();
  page.on('dialog', async d => { await d.accept(); });
  page.on('pageerror', e => { console.log('PAGEERROR ' + e.message); fails++; });
  const origin = 'http://127.0.0.1:' + srv.port;
  await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + be.token), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
  await page.waitForTimeout(500);
  return { browser, context, page };
}
async function drain(page, ms) {
  for (let i = 0; i < (ms || 12000) / 300; i++) {
    const left = await page.evaluate(() => window.__goldOutbox.items().filter(x => !x.error && !x.hold).length);
    if (!left) return true; await page.waitForTimeout(300);
  }
  return false;
}
const figsOf = page => page.evaluate(() => {
  const o = {};
  document.querySelectorAll('#gpFigs > div').forEach(d => {
    const k = d.querySelector('span').childNodes[0].textContent.replace(/\s+/g, ' ').trim();
    o[k] = d.querySelector('b').textContent.trim();
  });
  return o;
});

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const holder = {}; const srv = await serve(ROOT, holder);

  // ===== A) no per-item sell; the picker is only real 99.8%+ rows, and one item becomes a batch
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    ok(await page.evaluate(() => window.__goldOutbox.meta().version === 56), 'A: sheet script is version 56');
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250);
    ok((await page.$$('button.sell')).length === 0, 'A: no Sell button on a stock row');
    ok((await page.textContent('#sellBtn')).trim() === 'Group 99.8%…', 'A: the stock action is Group 99.8%');
    await page.click('#sellBtn'); await page.waitForSelector('#gpList');
    const labels = await page.$$eval('#gpList input', a => a.map(x => x.getAttribute('aria-label')));
    ok(labels.join('|') === 'Group #1|Group #3|Group #5', 'A: picker is only actual 99.8%+ rows (' + labels.join('|') + ')');
    ok(!(await page.$('#gpList input[data-no="2"]')) && !(await page.$('#gpList input[data-no="4"]')), 'A: 90% and 99.7999% are not listed');
    ok(!(await page.$('#dsGo')) && !(await page.$('#sd')), 'A: the picker is not a sale form');
    const boxes = await page.$$eval('#gpList input', a => a.map(x => x.checked));
    ok(boxes.length === 3 && boxes.every(c => !c), 'A: nothing starts ticked');
    await page.click('#gpList input[data-no="1"]');
    const f = await figsOf(page);
    const exp = await page.evaluate(() => ({ items: '1', raw: grams(1) + ' g', ref: grams(0.998) + ' g', cost: peso(8000) }));
    ok(f['Items'] === exp.items && f['Raw grams'] === exp.raw && f['Refined grams'] === exp.ref && f['Total cost'] === exp.cost, 'A: one item shows combined refined grams and the items-only cost (' + JSON.stringify(f) + ')');
    ok(!/fee/i.test(await page.textContent('#gpFigs')), 'A: the fee is not its own line');
    const before = srv.log.length;
    await page.click('#gpGo'); ok(await drain(page), 'A: group synced');
    const req = srv.log.slice(before).find(x => x.action === 'batchRefine');
    ok(req && req.body.pickNos && JSON.stringify(req.body.pickNos) === '[1]' && req.out && req.out.ok, 'A: sent batchRefine pickNos [1]');
    ok(!srv.log.slice(before).some(x => x.action === 'sellStock'), 'A: no sellStock was sent');
    ok(inStock(be).join() === '2,3,4,5', 'A: only #1 left stock');
    const b = openBatch(be, req.body.batchId);
    ok(b && b.noFee === true && b.fee === 0 && b.status === 'Refining' && b.items === 1 && near(b.refinedG, 0.998) && near(b.rawG, 1) && near(b.costInclFee, 8000) && b.actualG == null && near(b.silverG, 0), 'A: one refining batch, ready to sell, no fee (' + JSON.stringify(b && { id: b.id, items: b.items, raw: b.rawG, ref: b.refinedG, cost: b.costInclFee, fee: b.fee, noFee: b.noFee, actual: b.actualG, silver: b.silverG, status: b.status }) + ')');
    ok(!saleIds(be).some(id => id.startsWith('DS-')), 'A: no direct sale was written');
    await browser.close();
  }

  // ===== B) a chosen pair becomes one batch, then Sell refined records it without a typed weight
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    await page.click('#sellBtn'); await page.waitForSelector('#gpList');
    ok(await page.$eval('#gpGo', b => b.disabled), 'B: cannot group with nothing ticked');
    ok(/below 99\.8%/.test(await page.textContent('#gpBelow')), 'B: the two lower items are called out as staying');
    await page.click('#gpAll');
    ok((await page.textContent('#gpGo')).includes('Group 3'), 'B: select all offers all three');
    await page.click('#gpAll');
    await page.click('#gpList input[data-no="1"]'); await page.click('#gpList input[data-no="5"]');
    ok((await page.textContent('#gpSum')).includes('2 ticked'), 'B: two ticked (' + (await page.textContent('#gpSum')) + ')');
    const f = await figsOf(page);
    const exp = await page.evaluate(() => {
      const raw = 2 / 2 + 1.5 / 2, ref = 1 * 0.998 + 0.75 * 1, cost = 8000 + 9000;
      return { items: '2', raw: grams(raw) + ' g', ref: grams(ref) + ' g', cost: peso(cost) };
    });
    ok(f['Items'] === exp.items && f['Raw grams'] === exp.raw && f['Refined grams'] === exp.ref && f['Total cost'] === exp.cost, 'B: totals are combined grams × purity, cost is the items only (' + JSON.stringify(f) + ')');
    const before = srv.log.length;
    await page.click('#gpGo'); ok(await drain(page), 'B: group synced');
    const req = srv.log.slice(before).find(x => x.action === 'batchRefine');
    ok(req && JSON.stringify(req.body.pickNos) === '[1,5]' && req.out && req.out.ok, 'B: sent pickNos [1,5]');
    ok(!srv.log.slice(before).some(x => x.action === 'sellStock'), 'B: no sellStock');
    ok(inStock(be).join() === '2,3,4', 'B: #2 #3 #4 stay In stock');
    const b = openBatch(be, req.body.batchId);
    ok(b && b.noFee === true && b.fee === 0 && b.status === 'Refining' && b.items === 2 && near(b.refinedG, 1.748) && near(b.costInclFee, 17000) && b.actualG == null, 'B: one batch, refined weight 1.748 g, cost 17,000 with no fee (' + (b && b.refinedG) + ')');
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(300);
    ok(await page.$(`#batchList [data-bid="${req.body.batchId}"]`), 'B: the batch is on Refining');
    await page.click('#sellRefBtn'); await page.waitForSelector('#bgList');
    await page.click(`#bgList input[data-bid="${req.body.batchId}"]`);
    await page.click('#bgNext'); await page.waitForSelector('#bgGo');
    const mark = srv.log.length;
    await page.click('#bgGo'); ok(await drain(page), 'B: Sell refined synced');
    const sale = srv.log.slice(mark).find(x => x.action === 'sellBatches');
    ok(sale && JSON.stringify(sale.body.batchIds) === JSON.stringify([req.body.batchId]) && sale.out && sale.out.ok, 'B: sold that batch with the existing group sale');
    ok(openBatch(be, req.body.batchId).status === 'Sold', 'B: the batch is Sold only after the sale is recorded');
    const row = be.env.sheets.Sales.d.slice(10).find(r => String(r[8]) === req.body.batchId);
    ok(row && near(row[4], 17000) && !saleIds(be).some(id => String(id).startsWith('DS-')), 'B: the sale cost is the items only, with no refining fee, and is not a DS- direct sale');
    await browser.close();
  }

  // ===== C) offline group including an unsynced 99.8% purchase survives reload
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, context, page } = await open(srv, be);
    await context.setOffline(true); await page.waitForTimeout(200);
    await page.click('nav button[data-v=buy]');
    await page.fill('#bw', '2.50'); await page.fill('#bp', '99.8'); await page.fill('#bc', '11111'); await page.click('#bsave');
    await page.waitForTimeout(400);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(300);
    await page.click('#sellBtn'); await page.waitForSelector('#gpList');
    const pending = await page.$$eval('#gpList .badge', a => a.map(x => x.textContent.trim()));
    ok(pending.includes('waiting to sync'), 'C: the unsynced 99.8% purchase is in the picker');
    await page.click('#gpList input[data-no="3"]');
    await page.click('#gpList input[data-rid]');
    await page.click('#gpGo'); await page.waitForTimeout(400);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
    await page.waitForTimeout(300);
    const q = await page.evaluate(() => window.__goldOutbox.items().filter(x => x.action === 'batchRefine' || x.action === 'addPurchase').map(x => x.action + ':' + (x.waitRids ? x.waitRids.length : 0) + ':' + (x.pick ? 'pick' : '')));
    ok(q.includes('addPurchase:0:') && q.some(x => x.startsWith('batchRefine:1:pick')), 'C: after reload the purchase and the group refine are still queued (' + q.join() + ')');
    await context.setOffline(false); await page.waitForTimeout(200);
    ok(await drain(page, 15000), 'C: queue drained');
    const reqs = srv.log.filter(x => x.action === 'batchRefine');
    const sent = reqs[reqs.length - 1];
    ok(sent && sent.body.pickNos.includes(3) && sent.body.pickNos.length === 2 && sent.out && sent.out.ok, 'C: refine nos include the new sheet No. (' + JSON.stringify(sent && sent.body.pickNos) + ')');
    ok(!inStock(be).includes(3) && inStock(be).includes(1) && inStock(be).includes(2), 'C: only the chosen sheet item left stock; #1 and the 90% item stay (' + inStock(be).join() + ')');
    ok(!srv.log.some(x => x.action === 'sellStock'), 'C: the offline group did not become a direct sale');
    await browser.close();
  }

  // ===== D) stale row: the whole group is refused, the other item stays
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    await page.click('#sellBtn'); await page.click('#gpList input[data-no="1"]'); await page.click('#gpList input[data-no="5"]');
    ok(be.post({ action: 'deletePurchase', rid: 'gone', no: 5 }).ok, 'D: #5 deleted on the sheet');
    const mark = srv.log.length;
    const beforeIds = saleIds(be).slice();
    await page.click('#gpGo'); await page.waitForTimeout(1500); await drain(page, 4000);
    const q = await page.evaluate(() => window.__goldOutbox.items().find(x => x.action === 'batchRefine'));
    ok(q && /No\. 5 is no longer In stock/.test(q.hold || '') && /Nothing was refined/.test(q.hold || ''), 'D: held with the sheet reason (' + (q && (q.hold || q.error)) + ')');
    ok(inStock(be).includes(1), 'D: #1 still In stock');
    ok(JSON.stringify(saleIds(be)) === JSON.stringify(beforeIds), 'D: no sale was written');
    ok(srv.log.slice(mark).some(x => x.action === 'batchRefine' && x.out && x.out.ok === false), 'D: the sheet refused the refine');
    await browser.close();
  }

  // ===== E) a sheet without pick-refine shows no group button and is not sent a partial refine
  {
    const mark = srv.log.length;
    const be = makeBackend(V15); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250);
    ok(!(await page.$('#sellBtn')) && !(await page.$('button.sell')), 'E: v15 sheet shows no group button');
    ok(srv.log.slice(mark).every(x => x.action !== 'sellStock' && x.action !== 'batchRefine'), 'E: no sell or refine was sent');
    await browser.close();
  }

  // ===== E2) v50 can group (pickNos) and still never receives sellStock from this button
  {
    const be = makeBackend(V50); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250);
    ok((await page.textContent('#sellBtn')).trim() === 'Group 99.8%…', 'E2: v50 sheet can group 99.8% items');
    const mark = srv.log.length;
    await page.click('#sellBtn'); await page.click('#gpList input[data-no="1"]'); await page.click('#gpGo');
    ok(await drain(page), 'E2: group synced on v50');
    ok(srv.log.slice(mark).some(x => x.action === 'batchRefine' && JSON.stringify(x.body.pickNos) === '[1]' && x.out && x.out.ok), 'E2: v50 received batchRefine');
    ok(srv.log.slice(mark).every(x => x.action !== 'sellStock'), 'E2: v50 was not sent sellStock');
    await browser.close();
  }

  // ===== F) group queued on v54, sheet rolled back below pick-refine: held, not sent
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, context, page } = await open(srv, be);
    await context.setOffline(true); await page.waitForTimeout(200);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    await page.click('#sellBtn'); await page.waitForSelector('#gpGo');
    await page.click('#gpList input[data-no="1"]'); await page.click('#gpGo');
    await page.waitForTimeout(300);
    be.swapApi(V15); const mark = srv.log.length;
    await context.setOffline(false); await page.waitForTimeout(300);
    await page.evaluate(() => window.syncQueue && window.syncQueue()); await page.waitForTimeout(1500);
    const q = await page.evaluate(() => window.__goldOutbox.items().find(x => x.action === 'batchRefine'));
    ok(q && /needs Api\.gs v50/.test(q.hold || ''), 'F: held for Api.gs v50 (' + (q && (q.hold || q.error)) + ')');
    ok(srv.log.slice(mark).every(x => x.action !== 'batchRefine' && x.action !== 'sellStock') && inStock(be).includes(1), 'F: the ticked refine was not sent to the old sheet');
    await browser.close();
  }

  // ===== G) capability rule
  {
    const be = makeBackend(); holder.cur = be;
    const { browser, page } = await open(srv, be);
    const r = await page.evaluate(() => [51, 50, 49, 16, 15, 14, 13].map(v => {
      const T = {}; applyServerCaps(T, { version: v }); return v + ':' + T.directSale + '/' + T.pickRefine;
    }).join(' '));
    ok(r === '51:true/true 50:false/true 49:false/false 16:false/false 15:false/false 14:false/false 13:false/false', 'G: version caps ' + r);
    const r2 = await page.evaluate(() => {
      const T = {}; applyServerCaps(T, { version: 51, directSale: false, pickRefine: true });
      const U = {}; applyServerCaps(U, { version: 50, directSale: true });
      return [T.directSale, U.directSale].join();
    });
    ok(r2 === 'false,true', 'G: explicit directSale flag wins');
    await browser.close();
  }

  // ===== H) refined batches stay listed through grouping, review and a queued sale
  {
    const be = makeBackend(); holder.cur = be;
    be.add({ weightBhy: 2, purity: 0.9, cost: 4000 });
    be.add({ weightBhy: 2, purity: 0.998, cost: 8000 });
    const made = be.post({ action: 'batchRefine', rid: 'mk', batchId: 'R-KEEP', pickNos: [1] });
    ok(made.ok, 'H setup: R-KEEP refined (' + (made.message || made.error) + ')');
    const reg = () => be.env.sheets.Refining.d.slice(18).map(r => String(r[12] || '')).filter(Boolean);
    const before = reg().slice().sort();
    const { browser, context, page } = await open(srv, be);
    const listed = () => page.$$eval('#batchList [data-bid]', a => a.map(x => x.getAttribute('data-bid')).sort());
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(300);
    let ids = await listed();
    ok(ids.indexOf('R-20261018') >= 0 && ids.indexOf('R-KEEP') >= 0, 'H: both refined batches are listed (' + ids.join() + ')');
    await page.click('#sellRefBtn'); await page.waitForSelector('#bgList');
    ids = await listed();
    ok(ids.indexOf('R-KEEP') >= 0 && ids.indexOf('R-20261018') >= 0, 'H: still listed while the group picker is open');
    const boxes = await page.$$eval('#bgList input', a => a.map(x => x.checked));
    ok(boxes.length === 2 && boxes.every(c => !c), 'H: both batches start unticked');
    await page.click('#bgList input[data-bid="R-KEEP"]');
    await page.click('#bgList input[data-bid="R-20261018"]');
    await page.click('#bgNext'); await page.waitForSelector('#bgGo');
    ok(/stay on the Refining tab until/.test(await page.textContent('#modal')), 'H: review says they stay until the sale is recorded');
    ids = await listed();
    ok(ids.indexOf('R-KEEP') >= 0 && ids.indexOf('R-20261018') >= 0, 'H: still listed on the review step');
    await context.setOffline(true); await page.waitForTimeout(200);
    await page.click('#bgGo'); await page.waitForTimeout(400);
    ids = await listed();
    ok(ids.indexOf('R-KEEP') >= 0 && ids.indexOf('R-20261018') >= 0, 'H: still listed after the sale is only queued (' + ids.join() + ')');
    ok(/sale waiting|waiting to sync/i.test(await page.textContent('#batchList')), 'H: queued sale is marked waiting, not sold');
    const q0 = await page.evaluate(() => window.__goldOutbox.items().find(x => x.action === 'sellBatches'));
    ok(q0 && q0.batchIds.slice().sort().join() === 'R-20261018,R-KEEP', 'H: queue holds both batch ids');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
    await page.waitForTimeout(400);
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(300);
    ids = await listed();
    ok(ids.indexOf('R-KEEP') >= 0 && ids.indexOf('R-20261018') >= 0, 'H: still listed after reload while offline (' + ids.join() + ')');
    ok(JSON.stringify(reg().slice().sort()) === JSON.stringify(before), 'H: sheet Refining register was not touched while the sale was queued');
    await context.setOffline(false); await page.waitForTimeout(200);
    ok(await drain(page, 15000), 'H: group sale synced');
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(400);
    ids = await listed();
    ok(ids.indexOf('R-KEEP') < 0 && ids.indexOf('R-20261018') < 0, 'H: both leave the Refining list only after the sale is recorded (' + ids.join() + ')');
    ok(JSON.stringify(reg().slice().sort()) === JSON.stringify(before), 'H: register rows remain on the sheet after the sale (not deleted)');
    const st = be.post({ action: 'getState' }).state;
    ok(st.batches.filter(b => b.id === 'R-KEEP' || b.id === 'R-20261018').every(b => b.status === 'Sold'), 'H: sheet status is Sold');
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    ok(!(await page.$('button.sell')), 'H: the remaining 99.8% item has no Sell button');
    await page.click('#sellBtn'); await page.waitForSelector('#gpGo'); await page.click('#gpList input'); await page.click('#gpGo');
    ok(await drain(page), 'H: grouping the unrefined 99.8% item synced');
    const added = reg().filter(id => before.indexOf(id) < 0);
    ok(added.length === 1 && added.every(id => !String(id).startsWith('DS-')), 'H: that group was added as a refining batch (' + added.join() + ')');
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(300);
    ok((await listed()).indexOf(added[0]) >= 0, 'H: the new batch is on Refining, ready to sell');
    await browser.close();
  }

  // ===== I) a direct sale already waiting in the queue still records, and does not become a batch
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    const before = regIds(be);
    await page.evaluate(() => enqueue({ action: 'sellStock', sellDate: '2026-11-18', sellBase: 8250, items: [{ no: 1, weightBhy: 2, purity: 0.998, cost: 8000 }], expectSheetNos: [1] }).then(() => syncQueue()));
    ok(await drain(page), 'I: queued direct sale synced');
    const req = srv.log.filter(x => x.action === 'sellStock').pop();
    ok(req && JSON.stringify(req.body.nos) === '[1]' && req.out && req.out.ok && req.out.saleId === 'DS-1', 'I: the stored sellStock still records DS-1');
    ok(!inStock(be).includes(1) && inStock(be).includes(2), 'I: only that item left stock');
    ok(JSON.stringify(regIds(be).slice().sort()) === JSON.stringify(before.slice().sort()), 'I: the old direct sale did not add a refining batch');
    await browser.close();
  }

  srv.server.close();
  console.log(`\nSUMMARY sell_e2e ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

function regIds(be) {
  return be.env.sheets.Refining.d.slice(18).map(r => String(r[12] || '')).filter(Boolean);
}
