// v51 direct sale end to end: the app in Chromium talks to the real Code.gs + Api.gs (mock sheet).
// One item, a chosen group, valuation without a refining fee, offline queue + reload, stale rows, v50 sheet.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');
const { makeBackend, serve } = require('./real_backend');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const V50 = path.join(__dirname, 'fixtures', 'Api-v50.gs');
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
const CHROME = '/opt/google/chrome/chrome';
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
// #1 99.8%, #2 90%, #3 99.9% with a large cost, #4 99.7999% (looks like 99.80%), #5 100%
const SEED = [[2, 0.998, 8000], [2, 0.9, 4000], [3, 0.999, 1234567.89], [1, 0.997999, 3000], [1.5, 1, 9000]];
const inStock = be => be.env.sheets.Purchases.d.slice(1).filter(r => r[0] !== '' && r[2] !== '' && (r[10] === 'In stock' || r[10] === '')).map(r => Number(r[0]));
const saleIds = be => be.env.sheets.Sales.d.slice(10).map(r => r[8]).filter(x => x !== '' && x != null).map(String);
const batchIds = be => be.env.sheets.Refining.d.slice(18).map(r => r[12]).filter(x => x !== '' && x != null);

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
  document.querySelectorAll('#dsFigs > div').forEach(d => {
    const k = d.querySelector('span').childNodes[0].textContent.replace(/\s+/g, ' ').trim();
    o[k] = d.querySelector('b').textContent.trim();
  });
  return o;
});

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const holder = {}; const srv = await serve(ROOT, holder);

  // ===== A) one item from its Sell button
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    ok(await page.evaluate(() => window.__goldOutbox.meta().version === 51), 'A: app sees version 51');
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250);
    const labels = await page.$$eval('.mobile-only button.sell', a => a.map(b => b.getAttribute('aria-label')));
    ok(labels.join('|') === 'Sell #1|Sell #3|Sell #5', 'A: Sell only on actual 99.8%+ rows (' + labels.join('|') + ')');
    ok(!(await page.$('button.sell[aria-label="Sell #2"]')) && !(await page.$('button.sell[aria-label="Sell #4"]')), 'A: 90% and 99.7999% have no Sell button');
    await page.click('.mobile-only button.sell[aria-label="Sell #1"]'); await page.waitForSelector('#dsGo');
    ok((await page.textContent('#dsTitle')).includes('Review'), 'A: one item opens the review, not a silent sale');
    const lines = await page.$$eval('#dsReview .body', a => a.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
    ok(lines.length === 1 && /#1/.test(lines[0]) && /99\.80%/.test(lines[0]) && /₱8,000\.00/.test(lines[0]), 'A: review shows the original line (' + lines[0] + ')');
    const f = await figsOf(page);
    const expectCost = await page.evaluate(() => peso(8000));
    const expectVal = await page.evaluate(() => peso(Math.round(8250 * 0.998 * 1 * 100) / 100));
    ok(f['Cost'] === expectCost && f['Sale value'] === expectVal && f['Items'] === '1', 'A: totals are base × purity × grams, cost has no fee (' + JSON.stringify(f) + ')');
    ok(!/fee/i.test(await page.textContent('#dsFigs')) && !/refin/i.test(await page.textContent('#dsFigs')), 'A: no fee and no refining line in the totals');
    const before = srv.log.length;
    await page.click('#dsGo'); ok(await drain(page), 'A: sale synced');
    const req = srv.log.slice(before).find(x => x.action === 'sellStock');
    ok(req && JSON.stringify(req.body.nos) === '[1]' && req.out && req.out.ok && req.out.saleId === 'DS-1', 'A: sent nos [1], sheet recorded DS-1');
    ok(inStock(be).join() === '2,3,4,5', 'A: only #1 left stock');
    ok(!batchIds(be).some(id => String(id).startsWith('DS-')), 'A: no refining batch was created for the sale');
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(300);
    ok(/Direct sale · No\. 1/.test(await page.textContent('#salesRest')), 'A: recent sales calls it a direct sale');
    await browser.close();
  }

  // ===== B) group: nothing ticked, then a chosen pair, totals, record
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    ok((await page.textContent('#sellBtn')).trim() === 'Sell 99.8%…', 'B: group button');
    await page.click('#sellBtn'); await page.waitForSelector('#dsList');
    const boxes = await page.$$eval('#dsList input', a => a.map(x => x.checked));
    ok(boxes.length === 3 && boxes.every(c => !c), 'B: three eligible rows, none ticked');
    ok(/below 99\.8%/.test(await page.textContent('#dsBelow')), 'B: the two lower items are called out as staying');
    ok(await page.$eval('#dsNext', b => b.disabled), 'B: cannot review with nothing ticked');
    await page.click('#dsAll');
    ok((await page.textContent('#dsNext')).includes('Review 3'), 'B: select all offers all three');
    await page.click('#dsAll');
    await page.click('#dsList input[data-no="1"]'); await page.click('#dsList input[data-no="5"]');
    ok((await page.textContent('#dsSum')).includes('2 ticked'), 'B: two ticked (' + (await page.textContent('#dsSum')) + ')');
    await page.click('#dsNext'); await page.waitForSelector('#dsGo');
    const f = await figsOf(page);
    const exp = await page.evaluate(() => {
      const g = 2 / 2 + 1.5 / 2, pure = 1 * 0.998 + 0.75 * 1, cost = 8000 + 9000, est = Math.round(pure * 8250 * 100) / 100;
      return { items: '2', grams: grams(g) + ' g', pure: grams(pure) + ' g', cost: peso(cost), est: peso(est), profit: peso(Math.round((est - cost) * 100) / 100) };
    });
    ok(f['Items'] === exp.items && f['Grams (as bought)'] === exp.grams && f['Pure grams'] === exp.pure && f['Cost'] === exp.cost && f['Sale value'] === exp.est, 'B: review totals match base × each purity × grams (' + JSON.stringify(f) + ')');
    await page.evaluate(() => { setG('sales:calc', true); document.querySelector('#sb').dispatchEvent(new Event('input')); });
    const profitTxt = await page.evaluate(() => document.querySelector('#dsFigs .big b').textContent.trim());
    ok(profitTxt === exp.profit && exp.cost === '₱17,000.00', 'B: profit is value − cost, with no ₱20,000 fee (' + profitTxt + ' vs ' + exp.profit + ')');
    const before = srv.log.length;
    await page.click('#dsGo'); ok(await drain(page), 'B: group synced');
    const req = srv.log.slice(before).find(x => x.action === 'sellStock');
    ok(req && JSON.stringify(req.body.nos) === '[1,5]' && req.out.saleId === 'DS-1.5', 'B: sent [1,5]');
    ok(inStock(be).join() === '2,3,4', 'B: #2 #3 #4 stay In stock');
    const row = be.env.sheets.Sales.d.slice(10).find(r => String(r[8]) === 'DS-1.5');
    ok(row && row[4] === 17000, 'B: sheet cost is 8,000 + 9,000, not plus the refining fee');
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
    await page.click('#sellBtn'); await page.waitForSelector('#dsList');
    const pending = await page.$$eval('#dsList .badge', a => a.map(x => x.textContent.trim()));
    ok(pending.includes('waiting to sync'), 'C: the unsynced 99.8% purchase is in the picker');
    await page.click('#dsList input[data-no="3"]');
    await page.click('#dsList input[data-rid]');
    await page.click('#dsNext'); await page.waitForSelector('#dsGo');
    await page.click('#dsGo'); await page.waitForTimeout(400);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
    await page.waitForTimeout(300);
    const q = await page.evaluate(() => window.__goldOutbox.items().filter(x => x.action === 'sellStock' || x.action === 'addPurchase').map(x => x.action + ':' + (x.waitRids ? x.waitRids.length : 0)));
    ok(q.includes('addPurchase:0') && q.some(x => x.startsWith('sellStock:')), 'C: after reload the purchase and the direct sale are still queued (' + q.join() + ')');
    await context.setOffline(false); await page.waitForTimeout(200);
    ok(await drain(page, 15000), 'C: queue drained');
    const reqs = srv.log.filter(x => x.action === 'sellStock');
    const sent = reqs[reqs.length - 1];
    ok(sent && sent.body.nos.includes(3) && sent.body.nos.length === 2 && sent.out && sent.out.ok, 'C: sale nos include the new sheet No. (' + JSON.stringify(sent && sent.body.nos) + ')');
    ok(!inStock(be).includes(3) && inStock(be).includes(1) && inStock(be).includes(2), 'C: only the chosen sheet item left stock; #1 and the 90% item stay (' + inStock(be).join() + ')');
    await browser.close();
  }

  // ===== D) stale row: the whole group is refused, the other item stays
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    await page.click('#sellBtn'); await page.click('#dsList input[data-no="1"]'); await page.click('#dsList input[data-no="5"]');
    await page.click('#dsNext'); await page.waitForSelector('#dsGo');
    ok(be.post({ action: 'deletePurchase', rid: 'gone', no: 5 }).ok, 'D: #5 deleted on the sheet');
    const mark = srv.log.length;
    await page.click('#dsGo'); await page.waitForTimeout(1500); await drain(page, 4000);
    const q = await page.evaluate(() => window.__goldOutbox.items().find(x => x.action === 'sellStock'));
    ok(q && /No\. 5 is no longer In stock/.test(q.hold || '') && /Nothing was sold/.test(q.hold || ''), 'D: held with the sheet reason (' + (q && (q.hold || q.error)) + ')');
    ok(inStock(be).includes(1) && !saleIds(be).some(id => id.startsWith('DS-')), 'D: #1 still In stock and no direct sale was written');
    ok(srv.log.slice(mark).some(x => x.action === 'sellStock' && x.out && x.out.ok === false), 'D: the sheet refused the request');
    await browser.close();
  }

  // ===== E) v50 sheet never receives sellStock
  {
    const mark = srv.log.length;
    const be = makeBackend(V50); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250);
    ok(!(await page.$('#sellBtn')) && !(await page.$('button.sell')), 'E: v50 sheet shows no sell button');
    ok(/Api\.gs v51/.test(await page.textContent('#sellNote')), 'E: note says to update the sheet (' + (await page.textContent('#sellNote')) + ')');
    ok(srv.log.slice(mark).every(x => x.action !== 'sellStock'), 'E: no sellStock request was sent');
    await browser.close();
  }

  // ===== F) sale queued on v51, sheet rolled back to v50: held, not sent
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, context, page } = await open(srv, be);
    await context.setOffline(true); await page.waitForTimeout(200);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    await page.click('.mobile-only button.sell[aria-label="Sell #1"]'); await page.waitForSelector('#dsGo'); await page.click('#dsGo');
    await page.waitForTimeout(300);
    be.swapApi(V50); const mark = srv.log.length;
    await context.setOffline(false); await page.waitForTimeout(300);
    await page.evaluate(() => window.syncQueue && window.syncQueue()); await page.waitForTimeout(1500);
    const q = await page.evaluate(() => window.__goldOutbox.items().find(x => x.action === 'sellStock'));
    ok(q && /needs Api\.gs v51/.test(q.hold || ''), 'F: held for Api.gs v51 (' + (q && (q.hold || q.error)) + ')');
    ok(srv.log.slice(mark).every(x => x.action !== 'sellStock') && inStock(be).includes(1), 'F: sellStock was not sent to the v50 sheet');
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

  // ===== H) refined batches stay listed through grouping, review and a queued sale, and leave only once recorded
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
    await page.click('.mobile-only button.sell'); await page.waitForSelector('#dsGo'); await page.click('#dsGo');
    ok(await drain(page), 'H: direct sale of the unrefined 99.8% item synced');
    ok(reg().indexOf('DS-2') < 0 && reg().every(id => !String(id).startsWith('DS-')), 'H: that direct sale was not added to the Refining register (' + reg().join() + ')');
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(300);
    ok((await listed()).every(id => !String(id).startsWith('DS-')), 'H: direct sale did not appear as a refining batch');
    await browser.close();
  }

  srv.server.close();
  console.log(`\nSUMMARY sell_e2e ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
