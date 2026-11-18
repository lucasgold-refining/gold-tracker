// v50 mobile layout check of the Batch refine pick list: 412x915 DPR 3.5 at 100% and 130% (Samsung larger font),
// long list (32 sheet items + 2 unsynced), long numbers; plus v15 fallback and a laptop view. Real Api.gs behind it.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright-core');
const { makeBackend, serve } = require('./real_backend');
const ROOT = path.resolve(process.env.APP_ROOT || path.join(__dirname, '..'));
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
const CHROME = '/opt/google/chrome/chrome';
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
function seed(be) {
  for (let i = 0; i < 32; i++) {
    const w = [5.15, 0.55, 12.35, 2.5, 0.15, 7.75][i % 6], p = [0.8535, 0.999, 0.75, 0.88125, 0.9165, 0.6][i % 6];
    const c = i === 7 ? 1234567.89 : Math.round(w / 2 * p * 7600 * 100) / 100;
    be.add({ weightBhy: w, purity: p, cost: c, date: '2026-11-1' + (i % 8), at: '2026-11-1' + (i % 8) + 'T1' + (i % 10) + ':2' + (i % 6) + ':00+08:00' });
  }
}
async function metrics(page) {
  return page.evaluate(() => {
    const de = document.documentElement, sh = document.querySelector('#modal .sheet');
    const out = { scroll: de.scrollWidth, inner: innerWidth, overflow: de.scrollWidth > innerWidth + 1, sheetOverflow: sh ? sh.scrollWidth > sh.clientWidth + 1 : false, rows: [], taps: [] };
    document.querySelectorAll('#rpList .pick').forEach(l => {
      const cb = l.querySelector('input').getBoundingClientRect(), body = l.querySelector('.body').getBoundingClientRect(), r = l.getBoundingClientRect();
      const ln = l.querySelector('.body').getClientRects();
      out.rows.push({ h: r.height, cbMid: cb.top + cb.height / 2, bodyTop: body.top, bodyBot: body.bottom, gap: body.left - cb.right, cbW: cb.width, right: r.right, sheetRight: document.querySelector('#rpList').getBoundingClientRect().right });
    });
    ['#rgo', '#rpAll', '#rid', '.modal .btn.light:not(#rpAll)'].forEach(sel => { const e = document.querySelector(sel); if (e) { const b = e.getBoundingClientRect(); out.taps.push({ sel, h: b.height, w: b.width }); } });
    // numbers in the totals must not wrap mid-number or overflow their row
    out.figs = [...document.querySelectorAll('#rpFigs > div')].map(d => { const b = d.querySelector('b'), r = d.getBoundingClientRect(), bb = b.getBoundingClientRect(); return { t: d.textContent.replace(/\s+/g, ' ').trim(), wrapB: b.getClientRects().length > 1, out: bb.right > r.right + 1 }; });
    return out;
  });
}
function check(m, tag) {
  ok(!m.overflow && !m.sheetOverflow, `${tag}: no horizontal scroll (page ${m.scroll}/${m.inner}, sheet ok=${!m.sheetOverflow})`);
  const bad = m.rows.filter(r => r.cbMid < r.bodyTop - 1 || r.cbMid > r.bodyBot + 1 || r.gap < 6 || r.gap > 14);
  ok(m.rows.length && bad.length === 0, `${tag}: every checkbox sits beside its text (${m.rows.length} rows, ${bad.length} off)`);
  const short = m.rows.filter(r => r.h < 44);
  ok(short.length === 0, `${tag}: each list row is a ≥44px tap target (min ${Math.min(...m.rows.map(r => r.h)).toFixed(1)}px)`);
  const tshort = m.taps.filter(t => t.h < 40);
  ok(tshort.length === 0, `${tag}: buttons tall enough (${m.taps.map(t => t.sel + ' ' + t.h.toFixed(0)).join(', ')})`);
  const fb = m.figs.filter(f => f.wrapB || f.out);
  ok(fb.length === 0, `${tag}: totals fit, no number wraps (${fb.map(f => f.t).join(' | ') || 'ok'})`);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const holder = {}; const srv = await serve(ROOT, holder);
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true, timezoneId: 'Asia/Manila', locale: 'en-GB',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' };
  const start = async (be, ctxOpt, offlineBuys) => {
    holder.cur = be;
    const context = await browser.newContext(ctxOpt); const page = await context.newPage();
    page.on('dialog', d => d.accept()); page.on('pageerror', e => { console.log('PAGEERROR ' + e.message); fails++; });
    const origin = 'http://127.0.0.1:' + srv.port;
    await page.goto(origin + '/index.html?test=1#setup=' + encodeURIComponent(origin + '/mock-api|' + be.token), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__goldOutbox); await page.evaluate(() => window.__goldOutbox.ready()); await page.waitForTimeout(500);
    if (offlineBuys) {
      await context.setOffline(true); await page.waitForTimeout(150);
      for (const [w, p, c] of offlineBuys) { await page.click('nav button[data-v=buy]'); await page.fill('#bw', w); await page.fill('#bp', p); await page.fill('#bc', c); await page.click('#bsave'); await page.waitForTimeout(250); }
    }
    return { context, page };
  };
  const openModal = async page => {
    await page.click('nav button[data-v=stock]'); await page.waitForTimeout(250);
    await page.click('#refineBtn'); await page.waitForSelector('#rgo'); await page.waitForTimeout(250);
    await page.evaluate(() => { document.querySelectorAll('.toast,#toast').forEach(t => { t.classList.remove('show'); t.style.display = 'none'; }); document.activeElement && document.activeElement.blur(); });
  };
  const zoom = (page, s) => page.evaluate(s => { document.documentElement.style.zoom = s === 100 ? '' : String(s / 100); }, s);

  // phone, v50, long list + 2 unsynced purchases (offline)
  {
    const be = makeBackend(); seed(be);
    const { page, context } = await start(be, phone, [['2.75', '91.25', '23456.78'], ['0.35', '58.5', '1200']]);
    for (const s of [100, 130]) {
      await zoom(page, s);
      await openModal(page);
      await page.click('#rpList input[data-i="1"]'); await page.click('#rpList input[data-i="4"]');   // a couple unticked
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      let m = await metrics(page); check(m, `phone v50 @${s}% top`);
      await page.screenshot({ path: path.join(SHOTS, `phone-refine-pick-${s}.png`) });
      await page.evaluate(() => { const l = document.getElementById('rpList'); l.scrollTop = l.scrollHeight; });
      await page.waitForTimeout(100);
      await page.screenshot({ path: path.join(SHOTS, `phone-refine-pick-listend-${s}.png`) });
      await page.evaluate(() => { const sh = document.querySelector('#modal .sheet'); sh.scrollTop = sh.scrollHeight; });
      await page.waitForTimeout(150);
      m = await metrics(page); check(m, `phone v50 @${s}% bottom`);
      const goVis = await page.evaluate(() => { const b = document.getElementById('rgo').getBoundingClientRect(); return b.bottom <= innerWidth * 10 && b.top >= 0 && b.bottom <= innerHeight; });
      ok(goVis, `phone v50 @${s}%: Refine button reachable on screen after scrolling the sheet`);
      await page.screenshot({ path: path.join(SHOTS, `phone-refine-pick-totals-${s}.png`) });
      await page.evaluate(() => closeModal());
    }
    await zoom(page, 100);
    await openModal(page); await page.click('#rpAll'); await page.waitForTimeout(100);
    await page.screenshot({ path: path.join(SHOTS, 'phone-refine-none.png') });
    await page.evaluate(() => closeModal());
    await context.close();
  }
  // phone, v50 online (the usual case): the hand-over shots
  {
    const be = makeBackend(); seed(be);
    const { page, context } = await start(be, phone);
    for (const s of [100, 130]) {
      await zoom(page, s); await openModal(page);
      await page.click('#rpList input[data-i="1"]'); await page.click('#rpList input[data-i="3"]');
      await page.evaluate(() => document.activeElement && document.activeElement.blur()); await page.waitForTimeout(100);
      const m = await metrics(page); check(m, `phone v50 online @${s}%`);
      await page.screenshot({ path: path.join(SHOTS, `phone-refine-online-${s}.png`) });
      await page.evaluate(() => { const sh = document.querySelector('#modal .sheet'); sh.scrollTop = sh.scrollHeight; }); await page.waitForTimeout(120);
      await page.screenshot({ path: path.join(SHOTS, `phone-refine-online-bottom-${s}.png`) });
      await page.evaluate(() => closeModal());
    }
    await context.close();
  }
  // phone, sheet still v15: read-only list + note
  {
    const be = makeBackend(path.join(__dirname, 'fixtures', 'Api-v15.gs')); seed(be);
    const { page, context } = await start(be, phone);
    for (const s of [100, 130]) {
      await zoom(page, s); await openModal(page);
      const m = await metrics(page); check(m, `phone v15 fallback @${s}%`);
      await page.screenshot({ path: path.join(SHOTS, `phone-refine-v15-${s}.png`) });
      await page.evaluate(() => closeModal());
    }
    await context.close();
  }
  // laptop
  {
    const be = makeBackend(); seed(be);
    const { page, context } = await start(be, { viewport: { width: 1366, height: 768 }, timezoneId: 'Asia/Manila', locale: 'en-GB' });
    await openModal(page); await page.click('#rpList input[data-i="2"]'); await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const m = await metrics(page); check(m, 'laptop 1366');
    await page.screenshot({ path: path.join(SHOTS, 'laptop-refine-pick.png') });
    await context.close();
  }
  await browser.close(); srv.server.close();
  console.log(`\nSUMMARY layout_v50 ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
