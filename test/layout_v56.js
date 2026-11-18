// v56: the No fee (99.8%) control on an unsold 99.8% batch. 412×915 at 100% and 130%, plus a laptop.
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
  const be = makeBackend(); holder.cur = be;
  be.add({ weightBhy: 2, purity: 0.998, cost: 8000, date: '2026-11-18' });
  be.add({ weightBhy: 1.5, purity: 1, cost: 9000, date: '2026-11-18' });
  ok(be.post({ action: 'batchRefine', rid: 'lay', batchId: 'R-998', pickNos: [1, 2] }).ok, 'batch with a fee, all 99.8%+');
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const origin = 'http://127.0.0.1:' + srv.port;
  const phone = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, isMobile: true, hasTouch: true, timezoneId: 'Asia/Manila', locale: 'en-GB' };
  const start = async opt => {
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
  const show = async page => {
    await page.click('nav button[data-v=sales]');
    await page.waitForSelector('button.nofee[data-bid="R-998"]');
    await page.evaluate(() => document.querySelector('button.nofee').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(150);
  };
  const fit = page => page.evaluate(() => {
    const de = document.documentElement, b = document.querySelector('button.nofee');
    const r = b.getBoundingClientRect();
    return { overflow: de.scrollWidth > innerWidth + 1, h: r.height, w: r.width, on: r.top >= 0 && r.bottom <= innerHeight + 1, t: b.textContent.trim(), fit: b.scrollWidth <= b.clientWidth + 1 };
  });
  {
    const { context, page } = await start(phone);
    for (const s of [100, 130]) {
      await zoom(page, s);
      await show(page);
      const m = await fit(page);
      ok(!m.overflow && m.h >= 44 && m.w >= 44 && m.on && m.fit && m.t === 'No fee (99.8%)', `No fee button @${s}% ${m.w.toFixed(0)}x${m.h.toFixed(0)}`);
      await page.screenshot({ path: path.join(SHOTS, `v56-nofee-412-${s}.png`) });
    }
    await context.close();
  }
  {
    const { context, page } = await start({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, timezoneId: 'Asia/Manila', locale: 'en-GB' });
    await show(page);
    const m = await fit(page);
    ok(!m.overflow && m.on && m.t === 'No fee (99.8%)', 'laptop No fee button fits');
    await page.screenshot({ path: path.join(SHOTS, 'v56-nofee-1366.png') });
    await context.close();
  }
  await browser.close(); srv.server.close();
  console.log(`\nSUMMARY layout_v56 ${n - fails} passed, ${fails} failed, of ${n}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
