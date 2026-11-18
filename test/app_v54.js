// v54 phone behaviour: group-sale button, sale check, save-all quota, queued edits.
// The page talks to the real scripts on a simulated sheet. Nothing here calls a live sheet.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');
const { makeBackend, serve } = require('./real_backend');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const CHROME = '/opt/google/chrome/chrome';
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

async function open(srv, be) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true, timezoneId: 'Asia/Manila', locale: 'en-GB' });
  const page = await context.newPage();
  page.on('dialog', d => d.accept());
  page.on('pageerror', e => { console.log('PAGEERROR ' + e.message); fails++; });
  const origin = 'http://127.0.0.1:' + srv.port;
  await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + be.token), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
  await page.waitForTimeout(400);
  return { browser, context, page };
}
const actions = page => page.evaluate(() => window.__goldOutbox.items().map(x => x.action));

(async () => {
  const holder = {}; const srv = await serve(ROOT, holder);

  // A) a queued group sale opens that review, and does not queue a second sale
  {
    const be = makeBackend(); holder.cur = be;
    be.add({ weightBhy: 2, purity: 0.9, cost: 4000 });
    ok(be.post({ action: 'batchRefine', rid: 'mk', batchId: 'R-KEEP', pickNos: [1] }).ok, 'A setup: batch refined');
    const { browser, context, page } = await open(srv, be);
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(300);
    await context.setOffline(true); await page.waitForTimeout(150);
    await page.click('#sellRefBtn'); await page.waitForSelector('#bgList');
    await page.click('#bgList input[data-bid="R-KEEP"]');
    await page.click('#bgList input[data-bid="R-20261018"]');
    await page.click('#bgNext'); await page.waitForSelector('#bgGo');
    await page.click('#bgGo'); await page.waitForTimeout(400);
    const before = await page.evaluate(() => window.__goldOutbox.items().filter(x => x.action === 'sellBatches').map(x => x.rid));
    ok(before.length === 1, 'A: one group sale is queued');
    await page.click('#batchList [data-bid="R-KEEP"] button.gold');
    await page.waitForSelector('#bgTitle');
    const title = await page.textContent('#bgTitle');
    ok(/Sale waiting to sync/.test(title) && await page.$('#bgGo') && !(await page.$('#sgo')), 'A: the waiting button opens the group review (' + title + ')');
    ok(/R-KEEP/.test(await page.textContent('#bgReview')) && /R-20261018/.test(await page.textContent('#bgReview')), 'A: the review is the group, not one batch');
    await page.evaluate(() => openSale('R-KEEP'));
    await page.waitForTimeout(200);
    ok(await page.$('#bgGo') && !(await page.$('#sgo')), 'A: openSale refuses a second Record sale while the group is queued');
    await page.click('#bgGo'); await page.waitForTimeout(300);
    const after = await page.evaluate(() => window.__goldOutbox.items().map(x => x.action + ':' + x.rid));
    ok(after.filter(x => x.startsWith('sellBatches:')).length === 1 && after.join() === 'sellBatches:' + before[0] && !after.some(x => x.startsWith('recordBatchSale')), 'A: saving again keeps the same group sale (' + after.join() + ')');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
    const reloaded = await actions(page);
    ok(reloaded.indexOf('sellBatches') >= 0, 'A: the group sale is still queued after reload');
    await browser.close();
  }

  // B) an uncertain direct sale: still In stock means send the same request, not drop it
  {
    const be = makeBackend(); holder.cur = be;
    be.add({ weightBhy: 2, purity: 0.998, cost: 8000 });
    const { browser, context, page } = await open(srv, be);
    await context.setOffline(true); await page.waitForTimeout(150);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    await page.evaluate(() => enqueue({ action: 'sellStock', sellDate: '2026-11-18', sellBase: 8250, items: [{ no: 1, weightBhy: 2, purity: 0.998, cost: 8000 }], expectSheetNos: [1] }));
    await page.waitForTimeout(200);
    const rid = await page.evaluate(() => { const it = Q.find(x => x.action === 'sellStock'); it.uncertainAt = Date.now(); return it.rid; });
    await page.evaluate(() => { render(); });
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(200);
    const hint = await page.textContent('#qCard');
    ok(/Check Sales/.test(hint) && !/Check Refining before deleting/.test(hint), 'B: the waiting row points at Sales');
    await page.evaluate(rid => qDel(rid), rid);
    const modal = await page.textContent('#modal');
    ok(/Check Sales first/.test(modal) && /Still In stock — send this sale again/.test(modal) && !/Check Stock first/.test(modal), 'B: the check says still In stock means the sale was not saved');
    await page.click('#qNotSheet'); await page.waitForTimeout(300);
    const still = await page.evaluate(rid => { const it = Q.find(x => x.rid === rid); return it && it.action === 'sellStock' && it.rid === rid; }, rid);
    ok(still, 'B: sending again keeps the same request id');
    await browser.close();
  }

  // C) Save all keeps the rows that did not fit
  {
    const be = makeBackend(); holder.cur = be;
    const { browser, context, page } = await open(srv, be);
    await context.setOffline(true); await page.waitForTimeout(150);
    await page.click('nav button[data-v=buy]'); await page.waitForTimeout(150);
    await page.evaluate(() => bbStart()); await page.waitForTimeout(150);
    await page.fill('#bbw0', '1'); await page.fill('#bbp0', '85'); await page.fill('#bbc0', '111');
    await page.fill('#bbw1', '2'); await page.fill('#bbp1', '90'); await page.fill('#bbc1', '222');
    await page.fill('#bbw2', '3'); await page.fill('#bbp2', '80'); await page.fill('#bbc2', '333');
    await page.evaluate(() => {
      const orig = persistOutbox;
      window.persistOutbox = async function (opt) {
        if (Q.filter(x => x.cost === 222 || x.cost === 333).length) return false;
        return orig(opt);
      };
    });
    await page.click('#bbSaveAll'); await page.waitForTimeout(500);
    const queued = await page.evaluate(() => Q.filter(x => x.action === 'addPurchase').map(x => x.cost));
    const left = await page.evaluate(() => BB.rows.map(r => r.cost).filter(Boolean));
    ok(queued.join() === '111' && left.join() === '222,333', 'C: the saved row is queued and the rest stay in the draft (' + queued.join() + ' / ' + left.join() + ')');
    const toast = await page.evaluate(() => { const t = document.querySelector('#toast'); return t ? t.textContent : ''; });
    ok(/still in the list/.test(toast), 'C: the message says the rest are still in the list (' + toast + ')');
    await browser.close();
  }

  // D) a waiting edit blocks a direct sale until it is deleted
  {
    const be = makeBackend(); holder.cur = be;
    be.add({ weightBhy: 2, purity: 0.998, cost: 8000 });
    be.add({ weightBhy: 1, purity: 0.9, cost: 1000 });
    const { browser, context, page } = await open(srv, be);
    await context.setOffline(true); await page.waitForTimeout(150);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    await page.click('.mobile-only button[aria-label="Edit #1"]'); await page.waitForSelector('#ec');
    await page.fill('#ec', '8001'); await page.click('#esave'); await page.waitForTimeout(300);
    ok((await actions(page)).indexOf('editPurchase') >= 0, 'D: the edit is queued');
    await page.click('#sellBtn'); await page.waitForSelector('#gpGo');
    await page.click('#gpList input[data-no="1"]'); await page.click('#gpGo'); await page.waitForTimeout(300);
    const q = await actions(page);
    ok(q.indexOf('batchRefine') < 0 && q.indexOf('sellStock') < 0 && q.indexOf('editPurchase') >= 0, 'D: the group was not queued over the waiting edit (' + q.join() + ')');
    await page.evaluate(() => closeModal());
    const rid = await page.evaluate(() => Q.find(x => x.action === 'editPurchase').rid);
    await page.evaluate(rid => qRemove(rid), rid); await page.waitForTimeout(200);
    await page.click('#sellBtn'); await page.waitForSelector('#gpGo');
    await page.click('#gpList input[data-no="1"]'); await page.click('#gpGo'); await page.waitForTimeout(300);
    ok((await actions(page)).indexOf('batchRefine') >= 0, 'D: after the edit is deleted the group can be queued');
    await browser.close();
  }

  // E) a waiting delete blocks Batch refine
  {
    const be = makeBackend(); holder.cur = be;
    be.add({ weightBhy: 2, purity: 0.85, cost: 4000 });
    be.add({ weightBhy: 1, purity: 0.9, cost: 2000 });
    const { browser, context, page } = await open(srv, be);
    await context.setOffline(true); await page.waitForTimeout(150);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    await page.evaluate(() => enqueue({ action: 'deletePurchase', no: 1 }));
    await page.click('#refineBtn'); await page.waitForSelector('#rgo'); await page.click('#rgo'); await page.waitForTimeout(300);
    ok((await actions(page)).indexOf('batchRefine') < 0, 'E: refine is not queued while a delete of a ticked item is waiting');
    await browser.close();
  }

  srv.server.close();
  console.log(`\nSUMMARY app_v54 ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
