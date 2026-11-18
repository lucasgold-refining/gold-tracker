// Touched v53 screens at 412×915 DPR 3.5, 100% and 130% text, plus a desktop window.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');
const { makeBackend, serve } = require('./real_backend');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
const CHROME = '/opt/google/chrome/chrome';
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const holder = {}; const srv = await serve(ROOT, holder);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true, timezoneId: 'Asia/Manila', locale: 'en-GB' };
  const desk = { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, timezoneId: 'Asia/Manila', locale: 'en-GB' };
  const origin = 'http://127.0.0.1:' + srv.port;
  const start = async (be, opt) => {
    holder.cur = be;
    const context = await browser.newContext(opt);
    const page = await context.newPage();
    page.on('dialog', d => d.accept());
    page.on('pageerror', e => { console.log('PAGEERROR ' + e.message); fails++; });
    await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + be.token), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
    await page.waitForTimeout(350);
    return { context, page };
  };
  const zoom = (page, s) => page.evaluate(s => { document.documentElement.style.zoom = s === 100 ? '' : String(s / 100); }, s);
  const fit = page => page.evaluate(() => {
    const de = document.documentElement, sh = document.querySelector('#modal .sheet');
    const btns = [...document.querySelectorAll('#modal .btn, #modal button')].filter(b => b.getBoundingClientRect().width > 1);
    return {
      overflow: de.scrollWidth > innerWidth + 1,
      sheet: sh ? sh.scrollWidth > sh.clientWidth + 1 : false,
      short: btns.filter(b => b.getBoundingClientRect().height < 44).map(b => b.textContent.trim().slice(0, 40))
    };
  });

  const be = makeBackend();
  be.add({ weightBhy: 2, purity: 0.998, cost: 8000 });
  be.add({ weightBhy: 2, purity: 0.9, cost: 4000 });
  be.post({ action: 'batchRefine', rid: 'lay', batchId: 'R-KEEP', pickNos: [2] });

  {
    const { context, page } = await start(be, phone);
    await page.evaluate(() => enqueue({ action: 'sellBatches', batchIds: ['R-KEEP', 'R-20261018'], sellDate: '2026-11-18', sellBase: 8250 }));
    await page.evaluate(() => { const it = Q.find(x => x.action === 'sellStock'); });
    for (const s of [100, 130]) {
      await zoom(page, s);
      await page.click('nav button[data-v=sales]'); await page.waitForTimeout(250);
      await page.click('#batchList [data-bid="R-KEEP"] button.gold');
      await page.waitForSelector('#bgTitle');
      const m = await fit(page);
      ok(!m.overflow && !m.sheet && m.short.length === 0, `phone group review @${s}%: no overflow, buttons ≥44px (${m.short.join('|') || 'ok'})`);
      await page.screenshot({ path: path.join(SHOTS, `v54-group-review-${s}.png`) });
      await page.evaluate(() => closeModal());
    }
    await page.evaluate(() => enqueue({ action: 'sellStock', sellDate: '2026-11-18', sellBase: 8250, items: [{ no: 1, weightBhy: 2, purity: 0.998, cost: 8000 }], expectSheetNos: [1], nos: [1] }));
    await page.evaluate(() => { const it = Q.find(x => x.action === 'sellStock'); it.uncertainAt = Date.now(); render(); });
    await zoom(page, 130);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(200);
    await page.evaluate(() => qDel(Q.find(x => x.action === 'sellStock').rid));
    await page.waitForSelector('#qNotSheet');
    const m = await fit(page);
    ok(!m.overflow && !m.sheet && m.short.length === 0, 'phone sale check @130%: no overflow, buttons ≥44px (' + (m.short.join('|') || 'ok') + ')');
    ok(/Check Sales first/.test(await page.textContent('#modal')), 'phone sale check names Sales');
    await page.screenshot({ path: path.join(SHOTS, 'v54-sale-check-130.png') });
    await context.close();
  }

  {
    const { context, page } = await start(be, desk);
    await page.evaluate(() => enqueue({ action: 'sellBatches', batchIds: ['R-KEEP', 'R-20261018'], sellDate: '2026-11-18', sellBase: 8250 }));
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(250);
    await page.click('#batchList [data-bid="R-KEEP"] button.gold');
    await page.waitForSelector('#bgTitle');
    const m = await fit(page);
    ok(!m.overflow && !m.sheet, 'desktop group review: no horizontal overflow');
    await page.screenshot({ path: path.join(SHOTS, 'v54-group-review-desktop.png') });
    await context.close();
  }

  await browser.close(); srv.server.close();
  console.log(`\nSUMMARY layout_v54 ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
