// v51 mobile layout: direct sale of 99.8% stock. Samsung 412×915 CSS px, DPR 3.5, touch,
// at 100% and 130% font scale, plus a 1366×768 laptop. Real Api.gs behind the page.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');
const { makeBackend, serve } = require('./real_backend');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
const CHROME = '/opt/google/chrome/chrome';
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

function seedMixed(be) {
  const rows = [
    [12.345, 0.998, 1234567.89, '2026-11-01T09:15:00+08:00'],
    [0.15, 0.9, 500, '2026-11-02T14:05:00+08:00'],
    [7.75, 0.999, 84500.5, '2026-11-03T08:00:00+08:00'],
    [1, 0.997999, 2100, '2026-11-04T11:45:00+08:00'],
    [0.35, 1, 9999999.99, '2026-11-05T16:20:00+08:00']
  ];
  rows.forEach((x, i) => be.add({ weightBhy: x[0], purity: x[1], cost: x[2], date: '2026-11-0' + (i + 1), at: x[3] }));
}
async function metrics(page, listSel) {
  return page.evaluate(sel => {
    const de = document.documentElement, sh = document.querySelector('#modal .sheet');
    const out = { scroll: de.scrollWidth, inner: innerWidth, overflow: de.scrollWidth > innerWidth + 1, sheetOverflow: sh ? sh.scrollWidth > sh.clientWidth + 1 : false, rows: [], taps: [], figs: [] };
    document.querySelectorAll(sel + ' .pick').forEach(l => {
      const cb = l.querySelector('input'), body = l.querySelector('.body'); if (!cb || !body) return;
      const c = cb.getBoundingClientRect(), b = body.getBoundingClientRect(), r = l.getBoundingClientRect();
      out.rows.push({ h: r.height, cbMid: c.top + c.height / 2, bodyTop: b.top, bodyBot: b.bottom, gap: b.left - c.right, right: r.right });
    });
    ['#sellBtn', '#sellRefBtn', '#gpAll', '#gpGo', '#gpid', '#bgAll', '#bgNext', '#bgGo', '#sd', '#sb', '#sa', '.modal .btn.light'].forEach(s => {
      document.querySelectorAll(s).forEach(e => {
        const b = e.getBoundingClientRect();
        if (b.width < 1 || b.height < 1) return;
        out.taps.push({ sel: s, h: b.height, w: b.width });
      });
    });
    document.querySelectorAll('#gpFigs > div, #bgFigs > div').forEach(d => {
      const b = d.querySelector('b'); if (!b) return; const r = d.getBoundingClientRect(), bb = b.getBoundingClientRect();
      out.figs.push({ t: d.textContent.replace(/\s+/g, ' ').trim(), wrapB: b.getClientRects().length > 1, out: bb.right > r.right + 1 });
    });
    return out;
  }, listSel);
}
function checkList(m, tag) {
  ok(!m.overflow && !m.sheetOverflow, `${tag}: no horizontal scroll (page ${m.scroll}/${m.inner}, sheet ok=${!m.sheetOverflow})`);
  const bad = m.rows.filter(r => r.cbMid < r.bodyTop - 1 || r.cbMid > r.bodyBot + 1 || r.gap < 6 || r.gap > 18);
  ok(m.rows.length && bad.length === 0, `${tag}: checkbox sits beside its text (${m.rows.length} rows, ${bad.length} off)`);
  const short = m.rows.filter(r => r.h < 44);
  ok(short.length === 0, `${tag}: each row is a ≥44px tap target (min ${Math.min(...m.rows.map(r => r.h)).toFixed(1)}px)`);
}
function checkTaps(m, tag) {
  const tshort = m.taps.filter(t => t.h < 44 || t.w < 44);
  ok(tshort.length === 0, `${tag}: controls are at least 44px (${m.taps.map(t => t.sel + ' ' + Math.round(t.h) + 'x' + Math.round(t.w)).join(', ') || 'none'})`);
}
function checkFigs(m, tag) {
  const fb = m.figs.filter(f => f.wrapB || f.out);
  ok(!m.figs.length || fb.length === 0, `${tag}: totals fit (${fb.map(f => f.t).join(' | ') || 'ok'})`);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const holder = {}; const srv = await serve(ROOT, holder);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true, timezoneId: 'Asia/Manila', locale: 'en-GB',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' };
  const origin = 'http://127.0.0.1:' + srv.port;
  const start = async (be, ctxOpt) => {
    holder.cur = be;
    const context = await browser.newContext(ctxOpt); const page = await context.newPage();
    page.on('dialog', d => d.accept()); page.on('pageerror', e => { console.log('PAGEERROR ' + e.message); fails++; });
    await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + be.token), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready()); await page.waitForTimeout(400);
    return { context, page };
  };
  const quiet = page => page.evaluate(() => { document.querySelectorAll('.toast,#toast').forEach(t => { t.classList.remove('show'); t.style.display = 'none'; }); document.activeElement && document.activeElement.blur(); });
  const zoom = (page, s) => page.evaluate(s => { document.documentElement.style.zoom = s === 100 ? '' : String(s / 100); }, s);
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });

  // phone, mixed stock, both font scales
  {
    const be = makeBackend(); seedMixed(be);
    const { page, context } = await start(be, phone);
    for (const s of [100, 130]) {
      await zoom(page, s);
      await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250); await quiet(page);
      const stock = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: innerWidth, sells: document.querySelectorAll('button.sell').length, label: document.querySelector('#sellBtn') ? document.querySelector('#sellBtn').textContent.trim() : '' }));
      ok(stock.scroll <= stock.inner + 1, `phone stock @${s}%: no horizontal scroll (${stock.scroll}/${stock.inner})`);
      ok(stock.sells === 0, `phone stock @${s}%: no per-item Sell button`);
      ok(stock.label === 'Group 99.8%…', `phone stock @${s}%: button label (${stock.label})`);
      const sellBtn = await page.$eval('#sellBtn', b => ({ h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width, fit: b.scrollWidth <= b.clientWidth + 1 }));
      ok(sellBtn.h >= 44 && sellBtn.w >= 44 && sellBtn.fit, `phone stock @${s}%: group button ${sellBtn.w.toFixed(0)}x${sellBtn.h.toFixed(0)} fits`);
      await shot(page, `phone-stock-sell-${s}`);
      await page.click('#sellBtn'); await page.waitForSelector('#gpList'); await quiet(page);
      let m = await metrics(page, '#gpList'); checkList(m, `phone picker empty @${s}%`); checkTaps(m, `phone picker empty @${s}%`);
      ok(await page.$eval('#gpGo', b => b.disabled), `phone picker @${s}%: Group stays disabled with nothing ticked`);
      await shot(page, `phone-sell-picker-empty-${s}`);
      await page.click('#gpList input[data-no="1"]'); await quiet(page);
      m = await metrics(page, '#gpList'); checkList(m, `phone picker one @${s}%`);
      await shot(page, `phone-sell-picker-one-${s}`);
      await page.click('#gpAll'); await quiet(page);
      m = await metrics(page, '#gpList'); checkList(m, `phone picker all @${s}%`); checkTaps(m, `phone picker all @${s}%`);
      await shot(page, `phone-sell-picker-all-${s}`);
      m = await metrics(page, '#gpList'); checkFigs(m, `phone group totals @${s}%`); checkTaps(m, `phone group totals @${s}%`);
      ok(!m.overflow && !m.sheetOverflow, `phone group totals @${s}%: no horizontal scroll`);
      ok(!/fee/i.test(await page.textContent('#gpFigs')), `phone group totals @${s}%: fee is not its own line`);
      await page.evaluate(() => document.querySelector('#gpGo').scrollIntoView({ block: 'center' }));
      const vis = await page.evaluate(() => { const b = document.querySelector('#gpGo').getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight + 1 && b.left >= 0 && b.right <= innerWidth + 1 && b.height >= 44; });
      ok(vis, `phone group @${s}%: Group button is on screen and at least 44px`);
      await shot(page, `phone-sell-review-${s}`);
      await page.evaluate(() => closeModal());
    }
    await context.close();
  }

  // phone, a single eligible item and an empty (none eligible) stock
  {
    const one = makeBackend(); one.add({ weightBhy: 2.5, purity: 0.998, cost: 1234567.89, date: '2026-11-12', at: '2026-11-12T10:00:00+08:00' });
    let ctx = await start(one, phone);
    await ctx.page.click('nav button[data-v=stock]'); await ctx.page.waitForTimeout(200); await quiet(ctx.page);
    await shot(ctx.page, 'phone-stock-single');
    ok(!(await ctx.page.$('button.sell')), 'phone single: no per-item Sell button');
    await ctx.page.click('#sellBtn'); await ctx.page.waitForSelector('#gpList'); await quiet(ctx.page);
    await ctx.page.click('#gpList input'); await quiet(ctx.page);
    const m = await metrics(ctx.page, '#gpList'); checkFigs(m, 'phone single group'); checkTaps(m, 'phone single group');
    await shot(ctx.page, 'phone-sell-review-single');
    await ctx.context.close();
    const none = makeBackend(); none.add({ weightBhy: 2, purity: 0.9, cost: 4000 }); none.add({ weightBhy: 1, purity: 0.997999, cost: 3000 });
    ctx = await start(none, phone);
    await ctx.page.click('nav button[data-v=stock]'); await ctx.page.waitForTimeout(200); await quiet(ctx.page);
    ok(!(await ctx.page.$('#sellBtn')) && !(await ctx.page.$('button.sell')), 'phone empty: no group action when nothing is actually 99.8%');
    await shot(ctx.page, 'phone-stock-none-eligible');
    await ctx.context.close();
  }

  // laptop 1366×768: stock, picker, review
  {
    const be = makeBackend(); seedMixed(be);
    const { page, context } = await start(be, { viewport: { width: 1366, height: 768 }, timezoneId: 'Asia/Manila', locale: 'en-GB' });
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250); await quiet(page);
    const stock = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: innerWidth }));
    ok(stock.scroll <= stock.inner + 1, `laptop stock: no horizontal scroll (${stock.scroll}/${stock.inner})`);
    await shot(page, 'laptop-stock-sell');
    ok((await page.textContent('#sellBtn')).trim() === 'Group 99.8%…', 'laptop stock: Group 99.8% label');
    await page.click('#sellBtn'); await page.waitForSelector('#gpList'); await quiet(page);
    await page.click('#gpList input[data-no="1"]'); await page.click('#gpList input[data-no="5"]');
    let m = await metrics(page, '#gpList'); checkList(m, 'laptop picker'); checkTaps(m, 'laptop picker');
    await shot(page, 'laptop-sell-picker');
    m = await metrics(page, '#gpList'); checkFigs(m, 'laptop group'); checkTaps(m, 'laptop group');
    await page.evaluate(() => document.querySelector('#gpGo').scrollIntoView({ block: 'center' }));
    const vis = await page.evaluate(() => { const b = document.querySelector('#gpGo').getBoundingClientRect(); return b.bottom <= innerHeight + 1 && b.height >= 44; });
    ok(vis, 'laptop group: Group button is reachable');
    await shot(page, 'laptop-sell-review');
    await context.close();
  }

  // phone: refined batches stay on the Refining list while a group sale is being chosen
  {
    const be = makeBackend();
    be.add({ weightBhy: 2, purity: 0.9, cost: 4000, date: '2026-11-10', at: '2026-11-10T09:00:00+08:00' });
    be.post({ action: 'batchRefine', rid: 'lay', batchId: 'R-KEEP', pickNos: [1] });
    const { page, context } = await start(be, phone);
    await page.click('nav button[data-v=sales]'); await page.waitForTimeout(300); await quiet(page);
    const stock = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: innerWidth, ids: [...document.querySelectorAll('#batchList .batch')].map(b => b.getAttribute('data-bid')) }));
    ok(stock.scroll <= stock.inner + 1, `phone refining list: no horizontal scroll (${stock.scroll}/${stock.inner})`);
    ok(stock.ids.indexOf('R-KEEP') >= 0 && stock.ids.indexOf('R-20261018') >= 0, 'phone refining list shows both batches (' + stock.ids.join() + ')');
    await shot(page, 'phone-refining-before-group');
    await page.click('#sellRefBtn'); await page.waitForSelector('#bgList'); await quiet(page);
    let m = await metrics(page, '#bgList'); checkList(m, 'phone refined picker'); checkTaps(m, 'phone refined picker');
    const still = await page.$$eval('#batchList .batch', a => a.map(x => x.getAttribute('data-bid')));
    ok(still.indexOf('R-KEEP') >= 0 && still.indexOf('R-20261018') >= 0, 'phone: batches stay listed behind the group picker');
    await shot(page, 'phone-refined-picker');
    await page.click('#bgAll'); await page.click('#bgNext'); await page.waitForSelector('#bgGo'); await quiet(page);
    m = await metrics(page, '#bgReview'); checkFigs(m, 'phone refined review'); checkTaps(m, 'phone refined review');
    await page.evaluate(() => document.querySelector('#bgGo').scrollIntoView({ block: 'center' }));
    const vis = await page.evaluate(() => { const b = document.querySelector('#bgGo').getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight + 1 && b.height >= 44; });
    ok(vis, 'phone refined review: Record sale is reachable');
    await shot(page, 'phone-refined-review');
    await context.close();
  }

  await browser.close(); srv.server.close();
  console.log(`\nSUMMARY layout_v51 ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
