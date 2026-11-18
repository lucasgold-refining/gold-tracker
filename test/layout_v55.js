// v55 layout: Group 99.8% on In stock. Phone 412×915 DPR 3.5 at 100% and 130% text,
// a 1366×768 window, and a 1480×820 window at 80% zoom. Screenshots are v55-*.png.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');
const { makeBackend, serve } = require('./real_backend');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
const CHROME = '/opt/google/chrome/chrome';
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

function seed(be) {
  [[12.345, 0.998, 1234567.89], [0.15, 0.9, 500], [7.75, 0.999, 84500.5], [1, 0.997999, 2100], [0.35, 1, 9999999.99]]
    .forEach((x, i) => be.add({ weightBhy: x[0], purity: x[1], cost: x[2], date: '2026-11-0' + (i + 1), at: '2026-11-0' + (i + 1) + 'T09:15:00+08:00' }));
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const holder = {}; const srv = await serve(ROOT, holder);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const origin = 'http://127.0.0.1:' + srv.port;
  const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true, timezoneId: 'Asia/Manila', locale: 'en-GB' };
  const start = async (be, opt) => {
    holder.cur = be;
    const context = await browser.newContext(opt);
    const page = await context.newPage();
    page.on('dialog', d => d.accept());
    page.on('pageerror', e => { console.log('PAGEERROR ' + e.message); fails++; });
    await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + be.token), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready());
    await page.waitForTimeout(400);
    return { context, page };
  };
  const zoom = (page, s) => page.evaluate(z => { document.documentElement.style.zoom = z === 100 ? '' : String(z / 100); }, s);
  const quiet = page => page.evaluate(() => { document.querySelectorAll('.toast,#toast').forEach(t => { t.classList.remove('show'); t.style.display = 'none'; }); document.activeElement && document.activeElement.blur(); });
  const fit = page => page.evaluate(() => {
    const de = document.documentElement, sh = document.querySelector('#modal .sheet'), btn = document.querySelector('#sellBtn');
    const go = document.querySelector('#gpGo');
    return {
      overflow: de.scrollWidth > innerWidth + 1,
      sheet: sh ? sh.scrollWidth > sh.clientWidth + 1 : false,
      label: btn ? btn.textContent.trim() : '',
      labelFit: btn ? btn.scrollWidth <= btn.clientWidth + 1 : true,
      sells: document.querySelectorAll('button.sell').length,
      goFit: !go || go.scrollWidth <= go.clientWidth + 1
    };
  });
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });

  const be = makeBackend(); seed(be);
  {
    const { context, page } = await start(be, phone);
    for (const s of [100, 130]) {
      await zoom(page, s);
      await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250); await quiet(page);
      let m = await fit(page);
      ok(!m.overflow && m.sells === 0 && m.label === 'Group 99.8%…' && m.labelFit, `phone stock @${s}%: Group 99.8% fits, no row Sell (${m.label})`);
      await shot(page, `v55-stock-412-${s}`);
      await page.click('#sellBtn'); await page.waitForSelector('#gpList'); await quiet(page);
      await page.click('#gpList input[data-no="1"]'); await page.click('#gpList input[data-no="5"]'); await quiet(page);
      await page.evaluate(() => document.querySelector('#gpGo').scrollIntoView({ block: 'center' }));
      m = await fit(page);
      ok(!m.overflow && !m.sheet && m.goFit, `phone group @${s}%: picker fits`);
      const onScreen = await page.evaluate(() => { const b = document.querySelector('#gpGo').getBoundingClientRect(); return b.height >= 44 && b.top >= 0 && b.bottom <= innerHeight + 1; });
      ok(onScreen, `phone group @${s}%: Group button is on screen`);
      await shot(page, `v55-group-412-${s}`);
      await page.evaluate(() => closeModal());
    }
    await context.close();
  }

  {
    const { context, page } = await start(be, { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, timezoneId: 'Asia/Manila', locale: 'en-GB' });
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250); await quiet(page);
    let m = await fit(page);
    ok(!m.overflow && m.label === 'Group 99.8%…' && m.sells === 0, '1366 stock: no horizontal scroll');
    await shot(page, 'v55-stock-1366');
    await page.click('#sellBtn'); await page.waitForSelector('#gpList');
    await page.click('#gpAll'); await quiet(page);
    m = await fit(page);
    ok(!m.overflow && !m.sheet, '1366 group: no horizontal scroll');
    await shot(page, 'v55-group-1366');
    await context.close();
  }

  {
    const { context, page } = await start(be, { viewport: { width: 1480, height: 820 }, deviceScaleFactor: 1, timezoneId: 'Asia/Manila', locale: 'en-GB' });
    await zoom(page, 80);
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250); await quiet(page);
    let m = await fit(page);
    ok(!m.overflow && m.labelFit && m.label === 'Group 99.8%…', '1480 @80%: stock fits');
    await shot(page, 'v55-stock-1480-80');
    await page.click('#sellBtn'); await page.waitForSelector('#gpList');
    await page.click('#gpList input[data-no="1"]'); await page.click('#gpList input[data-no="3"]'); await quiet(page);
    m = await fit(page);
    ok(!m.overflow && !m.sheet && m.goFit, '1480 @80%: group picker fits');
    await shot(page, 'v55-group-1480-80');
    await page.click('#gpGo');
    for (let i = 0; i < 40; i++) {
      const done = await page.evaluate(() => window.__goldOutbox.items().filter(x => !x.error && !x.hold).length === 0);
      if (done) break; await page.waitForTimeout(300);
    }
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(400); await quiet(page);
    await zoom(page, 80);
    m = await fit(page);
    const ready = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('#batchList [data-bid]')].map(x => x.getAttribute('data-bid'));
      return { ids, sell: !!document.querySelector('#sellRefBtn'), text: (document.querySelector('#batchList') || {}).innerText || '' };
    });
    ok(!m.overflow && ready.sell && ready.ids.some(id => id !== 'R-20261018'), '1480 @80%: grouped batch is on Refining and Sell refined is there (' + ready.ids.join() + ')');
    await shot(page, 'v55-refining-1480-80');
    await context.close();
  }

  {
    const ds = makeBackend();
    ds.add({ weightBhy: 2, purity: 0.998, cost: 8000, date: '2026-11-01' });
    ds.add({ weightBhy: 1.5, purity: 1, cost: 9000, date: '2026-11-02' });
    const sold = ds.post({ action: 'sellStock', rid: 'lay-ds', nos: [1, 2], sellDate: '2026-11-18', sellBase: 8250, actualAmt: 7770343.04 });
    ok(sold.ok && sold.saleId === 'DS-1.2', 'direct sale for the undo confirm (' + (sold.saleId || sold.error) + ')');
    const openUndo = async page => {
      await page.click('nav button[data-v=sales]');
      await page.waitForSelector('button.undo');
      await quiet(page);
      await page.click('button.undo');
      await page.waitForSelector('#undoTitle');
      await quiet(page);
    };
    const undoFit = page => page.evaluate(() => {
      const de = document.documentElement, sh = document.querySelector('#modal .sheet'), b = document.querySelector('#undoGo');
      const r = b ? b.getBoundingClientRect() : { height: 0, width: 0, top: 0, bottom: 0 };
      return {
        overflow: de.scrollWidth > innerWidth + 1,
        sheet: sh ? sh.scrollWidth > sh.clientWidth + 1 : true,
        h: r.height, w: r.width, on: r.top >= 0 && r.bottom <= innerHeight + 1,
        title: (document.querySelector('#undoTitle') || {}).textContent || '',
        who: (document.querySelector('#undoWho') || {}).textContent || ''
      };
    });
    {
      const { context, page } = await start(ds, phone);
      for (const s of [100, 130]) {
        await zoom(page, s);
        await openUndo(page);
        const m = await undoFit(page);
        ok(!m.overflow && !m.sheet && m.h >= 44 && m.w >= 44 && m.on && /Undo direct sale/.test(m.title) && /No\. 1, 2/.test(m.who), `undo confirm @${s}% fits (${m.w.toFixed(0)}x${m.h.toFixed(0)})`);
        await shot(page, `v55-undo-confirm-412-${s}`);
        await page.evaluate(() => closeModal());
        await page.click('button.cor');
        await page.waitForSelector('#corGo');
        await quiet(page);
        const c = await fit(page);
        ok(!c.overflow && !c.sheet, `correct direct @${s}% fits`);
        await shot(page, `v55-correct-direct-412-${s}`);
        await page.evaluate(() => closeModal());
      }
      await context.close();
    }
    {
      const { context, page } = await start(ds, { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, timezoneId: 'Asia/Manila', locale: 'en-GB' });
      await openUndo(page);
      const m = await undoFit(page);
      ok(!m.overflow && !m.sheet && m.on, 'laptop undo confirm fits');
      await shot(page, 'v55-undo-confirm-1366');
      await page.evaluate(() => closeModal());
      await page.click('button.cor');
      await page.waitForSelector('#corGo');
      await shot(page, 'v55-correct-direct-1366');
      await context.close();
    }
  }

  await browser.close(); srv.server.close();
  console.log(`\nSUMMARY layout_v55 ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
