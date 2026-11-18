// v50 + Api.gs v50 end to end: the app in Chromium talks to the REAL Code.gs + Api.gs (vm, mock sheet).
// Pick subset, pick all / none, picked item vanished, offline subset with unsynced purchases, v15 fallback, rollback hold.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');
const { makeBackend, serve } = require('./real_backend');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const V15 = path.join(__dirname, 'fixtures', 'Api-v15.gs');
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
const CHROME = '/opt/google/chrome/chrome';
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const SEED = [[2, 0.9, 7000], [1.5, 0.85, 5000], [3, 0.999, 12500], [0.8, 0.75, 2100], [2.2, 0.88, 7600]];

function totals(items) {   // the sheet's maths (goldApiBatchPreview_), written out again independently
  const bhy = 2, fee = items.length ? 20000 : 0, base = 8250, div = 0.23, mul = 1.05, fullMin = 0.998;
  let raw = 0, ref = 0, cost = 0, sRaw = 0, sRef = 0, high = 0;
  items.forEach(([w, p, c]) => { const g = w / bhy; raw += g; ref += g * p; cost += c; if (p + 1e-9 >= fullMin) high++; else { sRaw += g; sRef += g * p; } });
  const silver = sRef && sRaw ? (sRef * (sRef / sRaw) / div) * mul - sRef : 0;
  return { raw, ref, cost, fee, incl: cost + fee, silver, high, profit: ref * base - cost - fee };
}
const inStock = be => be.env.sheets.Purchases.d.slice(1).filter(r => r[0] !== '' && r[2] !== '' && (r[10] === 'In stock' || r[10] === '')).map(r => Number(r[0]));
const refItems = (be, id) => be.env.sheets.Refining.d.slice(18).filter(r => r[0] === id).map(r => Number(r[2]));
const batchIds = be => be.env.sheets.Refining.d.slice(18).map(r => r[12]).filter(x => x !== '' && x != null);

async function open(srv, be, opt) {
  opt = opt || {};
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: opt.vp || { width: 412, height: 915 }, deviceScaleFactor: opt.dpr || 3.5, isMobile: opt.vp ? false : true, hasTouch: opt.vp ? false : true, timezoneId: 'Asia/Manila', locale: 'en-GB' });
  const page = await context.newPage(); const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
  page.on('pageerror', e => { console.log('PAGEERROR ' + e.message); fails++; });
  const origin = 'http://127.0.0.1:' + srv.port;
  await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + be.token), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
  await page.waitForTimeout(500);
  return { browser, context, page, dialogs };
}
async function openModal(page) {
  await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250);
  await page.click('#refineBtn'); await page.waitForSelector('#rgo', { timeout: 8000 }); await page.waitForTimeout(150);
}
const figs = page => page.evaluate(() => { const o = {}; document.querySelectorAll('#rpFigs > div').forEach(d => { const k = d.querySelector('span').textContent.replace(/\s+/g, ' ').trim(); o[k] = d.querySelector('b').textContent.trim(); }); return o; });
const fmt = (page, t) => page.evaluate(t => ({ raw: grams(t.raw) + ' g', ref: grams(t.ref) + ' g', cost: peso(t.cost), fee: peso(t.fee), incl: peso(t.incl), silver: grams(t.silver) + ' g' }), t);
// Standing rule: no fee line of its own; the fee is inside Total cost.
const figsMatch = (f, e) => f['Raw grams'] === e.raw && f['Refined grams (est.)'] === e.ref && f['Total cost'] === e.incl && !('Refining fee' in f) && !('Cost of items' in f) && !('Cost incl. fee' in f) && (Object.keys(f).find(k => /^Silver needed/.test(k)) ? f[Object.keys(f).find(k => /^Silver needed/.test(k))] === e.silver : false);
async function drain(page, ms) {
  for (let i = 0; i < (ms || 12000) / 300; i++) {
    const left = await page.evaluate(() => window.__goldOutbox.items().filter(x => !x.error && !x.hold).length);
    if (!left) return true; await page.waitForTimeout(300);
  }
  return false;
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const holder = {}; const srv = await serve(ROOT, holder);

  // ===== A) v50 online: list, live totals, select none / all, refine a subset
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    ok(await page.evaluate(() => window.__goldOutbox.meta().version === 54), 'A: app sees version 54');
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    ok((await page.textContent('#refineBtn')).trim() === '🔥 Batch refine…', 'A: button reads "Batch refine…" (not "all N items")');
    await openModal(page);
    const boxes = await page.$$eval('#rpList input', a => a.map(x => ({ c: x.checked, d: x.disabled })));
    ok(boxes.length === 5 && boxes.every(b => b.c && !b.d), 'A: 5 items listed, all ticked, tickable');
    const lines = await page.$$eval('#rpList .pick .body', a => a.map(x => x.textContent.replace(/\s+/g, ' ').trim()));
    ok(/^#1 · 2\.00 BHY · 90\.00% · ₱7,000\.00/.test(lines[0]) && /^#3 · 3\.00 BHY · 99\.90% · ₱12,500\.00/.test(lines[2]), 'A: lines read #No · BHY · purity · cost (' + lines[0] + ')');
    ok((await page.textContent('#rgo')).trim() === 'Refine 5 items', 'A: Refine 5 items');
    const pv = be.post({ action: 'batchPreview' }).preview;
    let f = await figs(page), e = await fmt(page, { raw: pv.rawG, ref: pv.refinedG, cost: pv.cost, fee: pv.fee, incl: pv.costInclFee, silver: pv.silverG });
    ok(figsMatch(f, e), 'A: all ticked = the sheet\'s own preview (' + JSON.stringify(f) + ')');
    const e5 = await fmt(page, totals(SEED));
    ok(figsMatch(f, e5), 'A: all ticked = independent maths');
    await page.click('#rpAll');   // select none
    ok(await page.$eval('#rgo', b => b.disabled && b.textContent.trim() === 'Refine 0 items'), 'A: select none -> Refine 0 items, disabled');
    ok((await page.textContent('#rpAll')).trim() === 'Select all' && (await page.textContent('#rpSum')).trim() === 'Nothing ticked', 'A: Select all offered, "Nothing ticked"');
    f = await figs(page); ok(f['Total cost'] === (await fmt(page, totals([]))).incl && f['Total cost'] === '₱0.00' && f['Items'] === '0', 'A: nothing ticked -> Total cost ₱0.00 (no fee), 0 items');
    await page.click('#rpAll'); await page.click('#rpAll'); await page.click('#rpList input[data-i="0"]');
    f = await figs(page); ok(f['Total cost'] === (await fmt(page, totals([SEED[0]]))).incl && f['Total cost'] === '₱27,000.00', 'A: one item ticked -> Total cost includes the one fee (₱7,000 + ₱20,000)');
    await page.click('#rpList input[data-i="0"]');   // back to none
    await page.click('#rpAll');   // select all
    ok((await page.textContent('#rgo')).trim() === 'Refine 5 items' && (await page.textContent('#rpAll')).trim() === 'Select none', 'A: select all -> 5 again');
    await page.click('#rpList input[data-i="1"]'); await page.click('#rpList input[data-i="3"]');   // untick #2, #4
    f = await figs(page); const e3 = await fmt(page, totals([SEED[0], SEED[2], SEED[4]]));
    ok(figsMatch(f, e3) && f['Items'] === '3', 'A: unticking #2 and #4 recalculates (' + f['Raw grams'] + ', ' + f['Cost incl. fee'] + ')');
    ok((await page.textContent('#rgo')).trim() === 'Refine 3 items' && /3 of 5 ticked/.test(await page.textContent('#rpSum')), 'A: Refine 3 items, 3 of 5 ticked');
    await page.screenshot({ path: path.join(SHOTS, 'e2e-phone-pick.png') });
    const before = srv.log.length;
    await page.click('#rgo'); ok(await drain(page), 'A: refine synced');
    const req = srv.log.slice(before).find(x => x.action === 'batchRefine');
    ok(req && JSON.stringify(req.body.pickNos) === '[1,3,5]' && JSON.stringify(req.body.expectNos) === '[1,3,5]', 'A: sent pickNos [1,3,5] (+ same expectNos)');
    ok(req && req.out && req.out.ok && /3 items/.test(req.out.message) && /2 items stay In stock/.test(req.out.message), 'A: sheet answered ' + (req && req.out && (req.out.message || req.out.error)));
    const id = req.out.batchId;
    ok(refItems(be, id).join() === '1,3,5' && inStock(be).join() === '2,4', 'A: sheet: batch has #1 #3 #5; #2 #4 still In stock');
    await page.waitForTimeout(400);
    const appStock = await page.evaluate(() => (window.ST || {}).stock ? ST.stock.map(x => x.no) : null).catch(() => null);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250);
    const listTxt = await page.textContent('#stockCard');
    ok(/#2/.test(listTxt) && /#4/.test(listTxt) && !/#1\b/.test(listTxt), 'A: app stock list now shows #2 and #4 only');
    // the next purchase continues the round's numbering
    await page.click('nav button[data-v=buy]'); await page.fill('#bw', '1'); await page.fill('#bp', '90'); await page.fill('#bc', '3000'); await page.click('#bsave');
    ok(await drain(page), 'A: purchase synced');
    const last = be.env.sheets.Purchases.d.slice(1).filter(r => r[0] !== '').pop();
    ok(Number(last[14]) === 6, 'A: next purchase got Batch #6 (got #' + last[14] + ')');
    await browser.close();
  }

  // ===== B) offline: tick a subset incl. one of two unsynced purchases, reload, then sync
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, context, page } = await open(srv, be);
    await context.setOffline(true); await page.waitForTimeout(200);
    for (const [w, p, c] of [[1.2, 92, 4000], [0.6, 80, 1500]]) {
      await page.click('nav button[data-v=buy]'); await page.fill('#bw', String(w)); await page.fill('#bp', String(p)); await page.fill('#bc', String(c)); await page.click('#bsave'); await page.waitForTimeout(300);
    }
    await openModal(page);
    const rows = await page.$$eval('#rpList input', a => a.map(x => ({ i: x.dataset.i, rid: x.dataset.rid, c: x.checked, d: x.disabled })));
    ok(rows.length === 7 && rows.filter(r => r.rid).length === 2 && rows.every(r => r.c && !r.d), 'B offline: 5 sheet items + 2 unsynced, all ticked');
    ok(/wait for the 2 unsynced purchases/.test(await page.textContent('#rWait')), 'B: says it waits for the 2 unsynced purchases');
    const rids = rows.filter(r => r.rid).map(r => r.rid);
    await page.click('#rpList input[data-i="1"]');                 // untick #2
    await page.click(`#rpList input[data-rid="${rids[1]}"]`);      // untick the 2nd unsynced purchase
    const f = await figs(page), e = await fmt(page, totals([SEED[0], SEED[2], SEED[3], SEED[4], [1.2, 0.92, 4000]]));
    ok(figsMatch(f, e) && f['Items'] === '5', 'B: totals include the ticked unsynced purchase (' + f['Raw grams'] + ')');
    ok(/wait for the 1 unsynced purchase /.test(await page.textContent('#rWait')), 'B: now waits for 1');
    await page.click('#rgo'); await page.waitForTimeout(400);
    let q = await page.evaluate(() => window.__goldOutbox.items().find(x => x.action === 'batchRefine'));
    ok(q && q.pick === true && JSON.stringify(q.expectSheetNos) === '[1,3,4,5]' && q.waitRids.length === 1 && q.waitRids[0] === rids[0], 'B: queued pick refine: nos [1,3,4,5], waits for the ticked purchase only');
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    ok(/Refine/.test(await page.textContent('body')) && /items? ticked/.test(await page.textContent('body')), 'B: waiting row says "ticked"');
    await page.screenshot({ path: path.join(SHOTS, 'e2e-phone-offline-queued.png') });
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.evaluate(() => window.__goldOutbox.ready()); await page.waitForTimeout(300);
    q = await page.evaluate(() => window.__goldOutbox.items().find(x => x.action === 'batchRefine'));
    ok(q && q.pick === true && q.waitRids[0] === rids[0], 'B: reload offline: pick refine intact');
    const before = srv.log.length;
    await context.setOffline(false); await page.waitForTimeout(300);
    await page.evaluate(() => window.syncQueue && window.syncQueue());
    ok(await drain(page, 15000), 'B: back online, queue drained');
    const writes = srv.log.slice(before).filter(x => ['addPurchase', 'batchRefine'].includes(x.action)).map(x => x.action + (x.body.pickNos ? JSON.stringify(x.body.pickNos) : ''));
    const p1 = srv.log.slice(before).filter(x => x.action === 'addPurchase').map(x => x.out && x.out.no);
    ok(writes[0] === 'addPurchase' && /^batchRefine/.test(writes[writes.length - 1]) || writes.indexOf(writes.find(w => /^batchRefine/.test(w))) > writes.indexOf('addPurchase'), 'B: purchase synced before the refine (' + writes.join(' > ') + ')');
    const ref = srv.log.slice(before).find(x => x.action === 'batchRefine');
    ok(ref && JSON.stringify(ref.body.pickNos) === JSON.stringify([1, 3, 4, 5, p1[0]].sort((a, b) => a - b)), 'B: pickNos = [1,3,4,5] + the ticked purchase\'s new No. ' + p1[0] + ' (got ' + JSON.stringify(ref && ref.body.pickNos) + ')');
    ok(ref && ref.out && ref.out.ok, 'B: sheet refined (' + (ref && ref.out && (ref.out.message || ref.out.error)) + ')');
    ok(inStock(be).join() === [2, p1[1]].join(), 'B: sheet: #2 and the unticked purchase (No. ' + p1[1] + ') stay In stock (got ' + inStock(be) + ')');
    await browser.close();
  }

  // ===== C) picked item vanished (deleted on another device after the list opened): held, nothing refined
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    await openModal(page);
    be.post({ action: 'deletePurchase', rid: 'other-device', no: 3 });
    await page.click('#rpList input[data-i="4"]');   // untick #5, keep #3 ticked
    const ids0 = batchIds(be).length;
    await page.click('#rgo'); await page.waitForTimeout(1500); await drain(page, 4000);
    const q = await page.evaluate(() => window.__goldOutbox.items().find(x => x.action === 'batchRefine'));
    ok(q && q.hold && /No\. 3 is no longer In stock/.test(q.hold) && /Nothing was refined/.test(q.hold), 'C: refine held with the sheet\'s reason (' + (q && (q.hold || q.error)) + ')');
    ok(batchIds(be).length === ids0 && inStock(be).join() === '1,2,4,5', 'C: sheet unchanged (no batch, #1 #2 #4 #5 In stock)');
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOTS, 'e2e-phone-vanished-held.png') });
    await browser.close();
  }

  // ===== D) sheet still on v15: read-only list, note, refines all (old request shape)
  {
    const be = makeBackend(V15); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    ok(await page.evaluate(() => window.__goldOutbox.meta().version === 15), 'D: app sees version 15');
    await openModal(page);
    const boxes = await page.$$eval('#rpList input', a => a.map(x => ({ c: x.checked, d: x.disabled })));
    ok(boxes.length === 5 && boxes.every(b => b.c && b.d), 'D v15: list shown read-only (ticked, not tickable)');
    ok(!(await page.$('#rpAll')) && /Update the sheet script \(Api\.gs v50\) to pick items/.test(await page.textContent('#rpOld')), 'D v15: no Select all; note asks to update the sheet script');
    const f = await figs(page), pv = be.post({ action: 'batchPreview' }).preview;
    ok(figsMatch(f, await fmt(page, { raw: pv.rawG, ref: pv.refinedG, cost: pv.cost, fee: pv.fee, incl: pv.costInclFee, silver: pv.silverG })), 'D v15: totals are the sheet\'s preview, as before');
    ok((await page.textContent('#rgo')).trim() === 'Refine 5 items', 'D v15: Refine 5 items');
    await page.screenshot({ path: path.join(SHOTS, 'e2e-phone-v15-fallback.png') });
    const before = srv.log.length;
    await page.click('#rgo'); ok(await drain(page), 'D: synced');
    const req = srv.log.slice(before).find(x => x.action === 'batchRefine');
    ok(req && req.body.pickNos === undefined && JSON.stringify(req.body.expectNos) === '[1,2,3,4,5]' && req.out.ok, 'D v15: old request (expectNos all, no pickNos), refined');
    ok(inStock(be).length === 0, 'D v15: everything refined');
    await browser.close();
  }

  // ===== E) pick refine queued under v50, sheet rolled back to v15 before it syncs: held, not refined
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, context, page } = await open(srv, be);
    await context.setOffline(true); await page.waitForTimeout(200);
    await openModal(page); await page.click('#rpList input[data-i="0"]'); await page.click('#rgo'); await page.waitForTimeout(300);
    be.swapApi(V15); const mark = srv.log.length;
    ok(be.post({ action: 'ping' }).version === 15, 'E: sheet now answers v15');
    await context.setOffline(false); await page.waitForTimeout(300);
    await page.evaluate(() => window.syncQueue && window.syncQueue()); await page.waitForTimeout(1500);
    const q = await page.evaluate(() => window.__goldOutbox.items().find(x => x.action === 'batchRefine'));
    ok(q && /needs Api\.gs v50/.test(q.hold || ''), 'E: held: needs Api.gs v50 (' + (q && (q.hold || q.error)) + ')');
    ok(inStock(be).length === 5 && srv.log.slice(mark).every(x => x.action !== 'batchRefine'), 'E: nothing refined, no refine sent to the v15 sheet');
    await browser.close();
  }

  // ===== G) capability rule without the flag: version 50 = can pick, 15 / 49 = old, receipts from 14
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    const r = await page.evaluate(() => [50, 49, 16, 15, 14, 13].map(v => { const T = {}; applyServerCaps(T, { version: v }); return v + ':' + T.receipts + '/' + T.pickRefine; }).join(' '));
    ok(r === '50:true/true 49:true/false 16:true/false 15:true/false 14:true/false 13:false/false', 'G: version-only caps: ' + r);
    const r2 = await page.evaluate(() => { const T = {}; applyServerCaps(T, { version: 15, receipts: true, pickRefine: false }); const U = {}; applyServerCaps(U, { version: 50, receipts: true, pickRefine: true }); return [T.pickRefine, U.pickRefine].join(); });
    ok(r2 === 'false,true', 'G: explicit flags win (15 old, 50 picks)');
    await browser.close();
  }

  // ===== F) filter note (v50)
  {
    const be = makeBackend(); holder.cur = be; SEED.forEach(x => be.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
    const { browser, page } = await open(srv, be);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    await page.evaluate(() => { SF.p = '90'; SF.open = true; render(); });
    await page.waitForTimeout(200);
    const t = await page.textContent('#sfRefNote');
    ok(/lists all 5 In stock items ticked/.test(t) && /Untick the ones to leave out/.test(t), 'F: filter note explains the pick list (' + t + ')');
    await browser.close();
  }

  srv.server.close();
  console.log(`\nSUMMARY pick_e2e ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
