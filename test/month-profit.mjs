// v42: monthly chart only when Api.gs v12 sends realizedMonths. Example figures, not real ones.
// Runs against the real page in Chromium.
// Mobile: 412x915 CSS px, DPR 3.5, isMobile, hasTouch, text 100/115/130%.
// Text scale multiplies the stylesheet's px font sizes (layout px stay), which is how
// Chrome on a Samsung phone grows text without changing the CSS viewport.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = '/opt/cursor/artifacts/gold-v42';
const PAGE_URL = process.env.GOLD_URL || 'http://127.0.0.1:8765/index.html#dash';
const fails = [];
const notes = [];
async function unstick(page) {
  await page.evaluate(() => { const h = document.querySelector('header'); if (h) h.style.position = 'relative'; });
}
async function restick(page) {
  await page.evaluate(() => { const h = document.querySelector('header'); if (h) h.style.position = ''; });
}
async function markExample(page, sel) {
  await page.evaluate(sel => {
    const tag = () => {
      const d = document.createElement('div');
      d.className = 'exMark';
      d.textContent = 'EXAMPLE DATA — not real figures';
      d.setAttribute('style', 'background:#111;color:#ffe08a;text-align:center;font:700 14px/1.3 sans-serif;padding:6px 8px;');
      return d;
    };
    if (!document.getElementById('exMarkTop')) {
      const t = tag(); t.id = 'exMarkTop';
      document.body.insertBefore(t, document.body.firstChild);
    }
    const host = sel ? document.querySelector(sel) : null;
    if (host && !host.querySelector('.exMark')) host.insertBefore(tag(), host.firstChild);
  }, sel || '');
}
const shot = async (page, name) => {
  const file = path.join(OUT, name + '.png');
  await unstick(page);
  await markExample(page, '');
  await page.screenshot({ path: file, fullPage: true });
  await restick(page);
  notes.push(file);
  return file;
};
const shotEl = async (page, sel, name) => {
  const file = path.join(OUT, name + '.png');
  await unstick(page);
  await markExample(page, sel);
  await page.locator(sel).first().screenshot({ path: file });
  await restick(page);
  notes.push(file);
  return file;
};
const check = (cond, msg) => { if (!cond) fails.push(msg); };

function settings(fee = 350) {
  return { base: 8054.91, fullMin: 0.998, margin: 0.01, bhyPerGram: 2, refiningFee: fee };
}
function state(extra) {
  return Object.assign({
    version: 11,
    base: 8054.91,
    source: 'Manual (app)',
    lastUpdated: '8 Nov 2026, 10:06 AM',
    settings: settings(),
    stock: [{ no: 12, bno: 3, date: '2026-11-08', weightBhy: 20, grams: 10, purity: 0.916, cost: 80000, status: 'In stock', at: '2026-11-08T08:15' }],
    batches: [],
    sales: [],
    daily: { '2026-11-02': 12.5, '2026-11-03': 4, '2026-11-04': 30.25, '2026-11-05': 8, '2026-11-06': 18.5, '2026-11-07': 6, '2026-11-08': 10 },
    dailySold: { '2026-11-04': 10 },
    dashboard: { totalRealized: 0, cashUsed: 80000 },
    month: { name: 'November 2026', realizedProfit: 0, purchasesCost: 80000 },
    _syncedAt: '2026-11-08T07:00:00.000Z'
  }, extra);
}
// Chart figures below are made-up examples. They are not taken from the live sheet.
const EXAMPLE_MONTHS = [
  { month: '2025-12', profit: 111111.11 },
  { month: '2026-01', profit: 5000.5 },
  { month: '2026-02', profit: 0 },
  { month: '2026-03', profit: -2500.25 },
  { month: '2026-04', profit: 0 },
  { month: '2026-05', profit: 0 },
  { month: '2026-06', profit: 800000 },
  { month: '2026-07', profit: 0 },
  { month: '2026-08', profit: -42000 },
  { month: '2026-09', profit: 0 },
  { month: '2026-10', profit: 0 },
  { month: '2026-11', profit: 200500.5 }
];
function fullState() {
  return state({
    version: 12,
    realizedMonths: EXAMPLE_MONTHS,
    // A sales-only figure must not appear on the chart. The series is the whole history.
    sales: [{ date: '2026-11-08', profit: 777777.77, actual: 1, batch: 'R-DECOY' }],
    month: { name: 'November', realizedProfit: 200500.5, purchasesCost: 2500000 },
    dashboard: { totalRealized: 1072111.86, cashUsed: 9000000 },
    batches: [
      { id: 'R-20261101', status: 'Sold', items: 40, rawG: 20, refinedG: 18, costInclFee: 750000, actualProfit: 150000, sellDate: '2026-11-02', actualValue: 900000, base: 8000 },
      { id: 'R-20261105', status: 'Sold', items: 3, actualProfit: 999999, sellDate: '2026-11-06', costInclFee: 10, base: 8000 }
    ]
  });
}
function longState() {
  return state({
    version: 12,
    realizedMonths: [{ month: '2026-10', profit: -12345678.9 }, { month: '2026-11', profit: 12345678.9 }],
    sales: [{ date: '2026-11-03', profit: 777777.77, actual: 200, batch: 'R-DECOY' }],
    stock: [{ no: 1, bno: 1, date: '2026-11-08', weightBhy: 24691.34, grams: 12345.67, purity: 0.9999, cost: 12345678.9, status: 'In stock' }],
    month: { name: 'November', realizedProfit: 12345678.9, purchasesCost: 12345678.9 },
    dashboard: { totalRealized: 12345678.9, cashUsed: 12345678.9 },
    daily: { '2026-11-08': 12345.67 }
  });
}
function emptyNone() {
  return state({ version: 12, realizedMonths: [], stock: [], sales: [], daily: {}, dailySold: {}, month: null, dashboard: { totalRealized: 0, cashUsed: 0 } });
}
function emptyZero() {
  return state({ version: 12, realizedMonths: [{ month: '2026-11', profit: 0 }], stock: [], sales: [], daily: {}, dailySold: {}, month: { name: 'November', realizedProfit: 0, purchasesCost: 0 }, dashboard: { totalRealized: 0, cashUsed: 0 } });
}
function v11State() {
  return state({
    version: 11,
    sales: [{ date: '2026-01-01', profit: 777777.77, actual: 1 }],
    month: { name: 'November', realizedProfit: 4242, purchasesCost: 100 }
  });
}

async function boot(browser, st, tm, opts) {
  const mobile = !opts.desktop;
  const context = await browser.newContext({
    viewport: mobile ? { width: 412, height: 915 } : { width: 1280, height: 800 },
    deviceScaleFactor: mobile ? 3.5 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    timezoneId: 'Asia/Manila',
    userAgent: mobile
      ? 'Mozilla/5.0 (Linux; Android 15; SM-S938B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  });
  await context.addInitScript(({ st, tm }) => {
    localStorage.setItem('gold-tracker-config', JSON.stringify({ url: 'https://script.google.com/macros/s/fake/exec', token: '0123456789abcdef' }));
    localStorage.setItem('gold-tracker-state', JSON.stringify(st));
    if (tm) localStorage.setItem('gold-tracker-tabmask', JSON.stringify(tm));
    else if (!sessionStorage.getItem('booted')) localStorage.removeItem('gold-tracker-tabmask');
    sessionStorage.setItem('booted', '1');
    if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new Error('sw off in test'));
  }, { st, tm: tm || null });
  await context.route('**/*', route => {
    const u = route.request().url();
    if (!u.includes('script.google.com')) return route.continue();
    let action = '';
    try { action = new URL(u).searchParams.get('action') || ''; } catch (e) {}
    const body = action === 'batchItems'
      ? { ok: true, items: [] }
      : { ok: true, state: st };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(PAGE_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#dWeek');
  return { context, page, errs };
}

async function openProfit(page) {
  const det = page.locator('#allTime');
  if (!(await det.evaluate(el => el.open))) await det.locator('summary').click();
  await page.waitForSelector('#dMonths');
}

async function textScale(page, factor) {
  if (factor === 1) return;
  await page.evaluate(factor => {
    const style = document.querySelector('style');
    let css = style.textContent;
    css = css.replace(/font-size:\s*clamp\(\s*([0-9.]+)px\s*,\s*([^,]+)\s*,\s*([0-9.]+)px\s*\)/g,
      (m, a, mid, b) => `font-size:clamp(${Math.round(a * factor * 10) / 10}px,${mid},${Math.round(b * factor * 10) / 10}px)`);
    css = css.replace(/font-size:\s*([0-9.]+)px/g, (m, n) => `font-size:${Math.round(n * factor * 10) / 10}px`);
    css = css.replace(/font:\s*([0-9.]+)px/g, (m, n) => m.replace(n, String(Math.round(n * factor * 10) / 10)));
    style.textContent = css;
    if (typeof fitNums === 'function') fitNums();
  }, factor);
}

async function layoutReport(page) {
  return page.evaluate(() => {
    const overflow = [];
    const nodes = [document.documentElement, document.body, document.querySelector('header'), document.querySelector('#app'), document.querySelector('#dMonths'), document.querySelector('#dWeek'), document.querySelector('#monthCard'), document.querySelector('#allTime')].filter(Boolean);
    nodes.forEach(el => {
      if (el.scrollWidth > el.clientWidth + 1) overflow.push((el.id || el.tagName) + ' scroll ' + el.scrollWidth + '>' + el.clientWidth);
    });
    const clipped = [];
    document.querySelectorAll('#app .fit .pv, #app .fit .fv, #dMonths .mpl, #basePill b, #basePill small').forEach(el => {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const p = el.parentElement.getBoundingClientRect();
      if (r.right > p.right + 1.5 || r.left < p.left - 1.5) clipped.push((el.id || el.className) + ' ' + Math.round(r.left) + '-' + Math.round(r.right) + ' parent ' + Math.round(p.left) + '-' + Math.round(p.right));
    });
    const taps = [];
    document.querySelectorAll('#dMonths .eye, #dMonths .wknav button, #monthCard .eye, #tabEye, #allTime .eye').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) taps.push((el.id || el.getAttribute('aria-label') || el.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    });
    const eye = document.querySelector('#dMonths .eye');
    let eyeAlign = null;
    if (eye) {
      const eb = eye.getBoundingClientRect(), svg = eye.querySelector('svg').getBoundingClientRect();
      const h = document.querySelector('#dMonths h3').getBoundingClientRect();
      eyeAlign = {
        svgDx: Math.abs((svg.left + svg.right) / 2 - (eb.left + eb.right) / 2),
        svgDy: Math.abs((svg.top + svg.bottom) / 2 - (eb.top + eb.bottom) / 2),
        rowDy: Math.abs((eb.top + eb.bottom) / 2 - (h.top + h.bottom) / 2)
      };
    }
    const bars = [...document.querySelectorAll('#dMonths .mpneg i, #dMonths .mppos i')].map(el => {
      const row = el.closest('.mprow');
      const track = el.closest('.mptrack').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { k: row && row.dataset.k, w: r.width, side: el.parentElement.className, outside: r.width > 0.5 && (r.left < track.left - 1 || r.right > track.right + 1) };
    });
    const text = (document.querySelector('#dMonths') || {}).innerText || '';
    const labels = [...document.querySelectorAll('#dMonths .mprow, #dMonths .mplist, #moEmpty')].map(el => el.getAttribute('aria-label') || '');
    const titles = [...document.querySelectorAll('#dMonths [title]')].map(el => el.getAttribute('title'));
    return { overflow, clipped, taps, eyeAlign, bars, text, labels, titles, fee: /fee/i.test((document.querySelector('#app') || {}).innerText || ''), baseTile: !!document.querySelector('#dBase'), week: !!document.querySelector('#dWeek'), headerBase: (document.querySelector('#basePill') || {}).innerText || '' };
  });
}

function assertLayout(rep, tag) {
  check(!rep.overflow.length, tag + ' overflow ' + rep.overflow.join('; '));
  check(!rep.clipped.length, tag + ' clipped ' + rep.clipped.join('; '));
  check(!rep.taps.length, tag + ' tap targets ' + rep.taps.join('; '));
  if (rep.eyeAlign) {
    check(rep.eyeAlign.svgDx < 2 && rep.eyeAlign.svgDy < 2, tag + ' eye icon off-center ' + JSON.stringify(rep.eyeAlign));
    check(rep.eyeAlign.rowDy < 6, tag + ' eye not aligned with title ' + JSON.stringify(rep.eyeAlign));
  }
  check(!rep.fee, tag + ' dashboard shows the word fee');
  check(!rep.baseTile, tag + ' Current base tile still present');
  check(rep.week, tag + ' weekly chart missing');
  check(rep.headerBase.includes('/ g base') || rep.headerBase.includes('Not connected'), tag + ' header base pill missing');
}

function assertHidden(rep, secrets, tag) {
  const blob = (rep.text + '\n' + rep.labels.join('\n') + '\n' + rep.titles.join('\n'));
  secrets.forEach(s => check(!blob.includes(s), tag + ' leaked ' + s));
  check(rep.labels.every(l => !l || /profit hidden|hidden/.test(l)), tag + ' aria not hidden: ' + rep.labels.filter(l => l && !/hidden/.test(l)).join(' | '));
  check(rep.titles.every(t => !/[0-9]/.test(t)), tag + ' tooltip has a figure: ' + rep.titles.join(' | '));
  const shown = rep.bars.filter(b => b.w > 0.5);
  check(!shown.length, tag + ' bar width leaked ' + JSON.stringify(shown));
  check(rep.bars.every(b => !b.outside), tag + ' bar outside track');
}

async function revealMonth(page) {
  // Individual eye: only dash:month. Master is not used, so all-time stays hidden.
  await page.locator('#dMonths .eye').click();
  await page.waitForTimeout(50);
}

const SHOWN = { dash: { m: 0, stock: 0, month: 0, all: 0 } };

async function run() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    // ----- pure aggregation, on the real functions -----
    {
      const { page, context, errs } = await boot(browser, fullState(), null, {});
      const math = await page.evaluate(() => {
        const out = {};
        const first = profitMonthMap();
        const decoy = monthChartHTML();
        out.hadSeries = !!(first && first['2025-12'] === 111111.11 && first['2026-11'] === 200500.5 && !decoy.includes('777'));
        delete ST.realizedMonths;
        ST.sales = [{ date: '2026-01-01', profit: 777777.77 }];
        out.v11 = profitMonthMap();
        out.v11html = monthChartHTML();
        ST.realizedMonths = [{ month: '2026-01', profit: 0 }, { month: '2026-02', profit: -20 }, { month: '2026-03', realizedProfit: '1,500.50' }];
        ST.sales = [{ date: '2026-04-01', profit: 5, cost: 9999 }];
        out.series = profitMonthMap();
        out.ignoredSale = monthChartHTML().includes('5.00') || monthChartHTML().includes('777');
        const series = [];
        for (let y = 2024, m = 10; y < 2026 || m <= 11; ) {
          series.push({ month: y + '-' + String(m).padStart(2, '0'), profit: m === 1 ? -5000 : 1000 * m });
          m++; if (m > 12) { m = 1; y++; }
        }
        ST.realizedMonths = series;
        ST.sales = [{ date: '2026-11-01', profit: 1 }];
        dashMo = 0;
        const pages = [];
        for (let i = 0; i < 5; i++) {
          const w = profitMonthWindow(profitMonthMap());
          const keys = [];
          for (let k = w.start; k <= w.end; k++) keys.push(keyFromIndex(k));
          pages.push({ keys, moreBefore: w.moreBefore, moreAfter: w.moreAfter });
          if (!w.moreBefore) break;
          dashMo += 1;
        }
        out.pages = pages;
        return out;
      });
      check(!errs.length, 'page errors ' + errs.join('; '));
      check(math.v11 === null, 'v11 payload must not build a month map');
      check(/id="moNeed"/.test(math.v11html) && !/777,777\.77/.test(math.v11html), 'v11 chart must be the note, not sales: ' + math.v11html.slice(0, 240));
      check(math.series['2026-01'] === 0 && math.series['2026-02'] === -20 && math.series['2026-03'] === 1500.5 && math.series['2026-04'] === undefined, 'series only ' + JSON.stringify(math.series));
      check(!math.ignoredSale, 'a sales row was drawn on top of the series');
      check(math.hadSeries, 'example series missing from the chart html');
      check(math.pages.length === 3, 'expected 3 month pages, got ' + math.pages.length);
      const flat = math.pages.flatMap(p => p.keys);
      const uniq = new Set(flat);
      check(uniq.size === flat.length, 'month pages overlap');
      check(math.pages[0].keys[0] === '2025-12' && math.pages[0].keys.at(-1) === '2026-11', 'latest page ' + math.pages[0].keys.join(','));
      check(math.pages[0].keys.includes('2026-02'), 'internal zero month missing from the window');
      check(math.pages.at(-1).keys[0] === '2024-10', 'earliest month dropped ' + math.pages.at(-1).keys.join(','));
      check(math.pages[0].moreAfter === false && math.pages.at(-1).moreBefore === false, 'page arrows');
      // rules that must stay: fee included in cost, fee word absent, refined batch counts as one item
      const rules = await page.evaluate(() => {
        ST.stock = [{ no: 1, date: '2026-11-08', weightBhy: 2, grams: 1, purity: 0.9, cost: 100, status: 'In stock' }];
        ST.batches = [];
        ST.settings.refiningFee = 350;
        ST.sales = [];
        const withFee = stockBoxesHTML();
        ST.stock = [];
        ST.batches = [{ id: 'R-20261108', status: 'Refining', items: 300, rawG: 12, refinedG: 10, costInclFee: 5000, base: 8000, at: 't1' }];
        const batch = stockBoxesHTML();
        const sales = salesRestHTML();
        const dash = dashHTML();
        return {
          feeInCost: /₱450\.00/.test(withFee),
          feeWord: /fee/i.test(withFee + dash),
          oneItem: /id="sCount"[\s\S]*?>1</.test(batch) || />1<\/span>/.test(batch),
          from300: /from 300 items/.test(batch),
          refinedG: /10\.00 g/.test(batch),
          asBought: /12\.00 g as bought/.test(batch),
          baseOnBatch: /Base/.test(sales),
          noCurrentBase: !/Current base/.test(dash),
          chart: /Profit by month/.test(dash),
          week: /Gold bought per day/.test(dash)
        };
      });
      check(rules.feeInCost, 'in-stock cost should include one refining fee (100 + 350)');
      check(!rules.feeWord, 'fee is visible on the dashboard');
      check(rules.from300, 'refined batch should say from 300 items');
      check(rules.refinedG && rules.asBought, 'refined grams / as bought caption');
      check(rules.baseOnBatch, 'refining screen lost its Base field');
      check(rules.noCurrentBase && rules.chart && rules.week, 'dashboard chrome ' + JSON.stringify(rules));
      // count the total-in-stock item figure directly
      const count = await page.evaluate(() => {
        ST.stock = [];
        ST.batches = [{ id: 'R-20261108', status: 'Refining', items: 300, rawG: 12, refinedG: 10, costInclFee: 5000, base: 8000, at: 't1' }];
        const html = stockBoxesHTML();
        const m = html.match(/id="sCount"[^]*?<span class="fv">([^<]*)/);
        return m && m[1];
      });
      check(count === '1', 'refined batch should count as 1 item, got ' + count);
      await context.close();
    }

    async function scenario(name, st, tm, opts) {
      const { page, context, errs } = await boot(browser, st, tm, opts);
      check(!errs.length, name + ' page errors ' + errs.join('; '));
      await openProfit(page);
      await textScale(page, opts.scale || 1);
      if (opts.reveal) await revealMonth(page);
      if (opts.earlier) {
        await page.locator('#moPrev').click();
        await page.waitForTimeout(30);
      }
      const rep = await layoutReport(page);
      assertLayout(rep, name);
      if (opts.secrets) assertHidden(rep, opts.secrets, name);
      if (opts.scale && opts.scale !== 1) {
        const bodyPx = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
        check(Math.abs(bodyPx - 17 * opts.scale) < 0.6, name + ' text scale body ' + bodyPx);
      }
      await shot(page, name);
      if (await page.locator('#dMonths').count()) await shotEl(page, '#dMonths', name + '-chart');
      await shotEl(page, 'header', name + '-header');
      const result = { name, rep, errs };
      await context.close();
      return result;
    }

    const secretsFull = ['111,111.11', '5,000.50', '2,500.25', '800,000.00', '42,000.00', '200,500.50', '150,000.00', '50,500.50'];
    const secretsLong = ['12,345,678.90'];

    const v11 = await scenario('mobile-100-v11-note', v11State(), null, { secrets: ['777,777.77'] });
    check(/Api\.gs v12/.test(v11.rep.text) && !v11.rep.bars.length, 'v11 should explain the missing history, not draw bars');
    await scenario('mobile-130-v11-note', v11State(), null, { scale: 1.3, secrets: ['777,777.77'] });
    await scenario('desktop-100-v11-note', v11State(), null, { desktop: true, secrets: ['777,777.77'] });
    await scenario('mobile-100-empty-none-masked', emptyNone(), null, { secrets: ['₱0.00'] });
    await scenario('mobile-100-empty-zero-masked', emptyZero(), null, { secrets: ['0.00'] });
    await scenario('mobile-100-empty-zero-revealed', emptyZero(), SHOWN, {});
    const fullMasked = await scenario('mobile-100-full-masked', fullState(), null, { secrets: secretsFull });
    check(/Dec 2025/.test(fullMasked.rep.text) && /Nov 2026/.test(fullMasked.rep.text), 'masked chart should still name the months');
    check(!/₱\s*[0-9]/.test(fullMasked.rep.text), 'masked chart text has a peso amount: ' + fullMasked.rep.text);
    const fullShown = await scenario('mobile-100-full-revealed', fullState(), SHOWN, {});
    check(fullShown.rep.text.includes('111,111.11'), 'revealed chart missing Dec profit');
    check(fullShown.rep.text.includes('5,000.50'), 'revealed chart missing January sum');
    check(fullShown.rep.text.includes('2,500.25'), 'revealed chart missing negative March');
    check(!fullShown.rep.text.includes('777,777.77'), 'sales-only decoy was drawn as monthly profit');
    check(/Feb 2026[\s\S]{0,40}₱0\.00/.test(fullShown.rep.text), 'February should show as zero profit');
    const pos = fullShown.rep.bars.filter(b => b.side === 'mppos' && b.w > 0.5);
    const neg = fullShown.rep.bars.filter(b => b.side === 'mpneg' && b.w > 0.5);
    check(pos.length >= 2 && neg.length >= 1, 'expected positive and negative bars, got ' + JSON.stringify(fullShown.rep.bars.filter(b => b.w > 0.5)));
    // June 800000 vs January 5000.5: June's bar should be much longer
    const june = fullShown.rep.bars.find(b => b.k === '2026-06' && b.side === 'mppos');
    const jan = fullShown.rep.bars.find(b => b.k === '2026-01' && b.side === 'mppos');
    check(june && jan && june.w > jan.w * 10, 'bar scale June vs January ' + JSON.stringify({ june, jan }));
    check(fullShown.rep.bars.every(b => !b.outside), 'a bar draws outside its track');

    await scenario('mobile-115-full-revealed', fullState(), SHOWN, { scale: 1.15 });
    await scenario('mobile-130-full-revealed', fullState(), SHOWN, { scale: 1.3 });
    await scenario('mobile-130-full-masked', fullState(), null, { scale: 1.3, secrets: secretsFull });

    await scenario('mobile-100-long-masked', longState(), null, { secrets: secretsLong });
    const longShown = await scenario('mobile-100-long-revealed', longState(), SHOWN, {});
    check(longShown.rep.text.includes('12,345,678.90'), 'long profit not shown');
    check(longShown.rep.bars.some(b => b.k === '2026-10' && b.side === 'mpneg' && b.w > 0.5), 'October negative bar missing');
    check(longShown.rep.bars.some(b => b.k === '2026-11' && b.side === 'mppos' && b.w > 0.5), 'November positive bar missing');
    await scenario('mobile-115-long-revealed', longState(), SHOWN, { scale: 1.15 });
    await scenario('mobile-130-long-revealed', longState(), SHOWN, { scale: 1.3 });
    await scenario('mobile-130-long-masked', longState(), null, { scale: 1.3, secrets: secretsLong });

    // Individual eye vs master, and per-device memory.
    {
      const { page, context } = await boot(browser, fullState(), null, {});
      await openProfit(page);
      const before = await page.evaluate(() => ({
        month: gShown('dash:month'), all: gShown('dash:all'), stock: gShown('dash:stock'),
        week: document.querySelector('#wkTotal').textContent
      }));
      check(!before.month && !before.all && !before.stock, 'default should be hidden');
      await page.locator('#dMonths .eye').click();
      const mid = await page.evaluate(() => ({
        month: gShown('dash:month'), all: gShown('dash:all'), stock: gShown('dash:stock'),
        chart: document.querySelector('#moList').getAttribute('aria-label'),
        total: document.querySelector('#dReal .pv').textContent,
        bars: [...document.querySelectorAll('#dMonths .mppos i')].some(el => el.getBoundingClientRect().width > 1)
      }));
      check(mid.month && !mid.all && !mid.stock, 'month eye changed other groups ' + JSON.stringify(mid));
      check(/Monthly realized profit$/.test(mid.chart), 'chart aria after reveal ' + mid.chart);
      check(mid.total.includes('••••'), 'all-time profit revealed by the month eye: ' + mid.total);
      check(mid.bars, 'revealed chart has no bar width');
      await page.locator('#tabEye').click(); // master was hidden; tap shows ALL
      // Wait: default master is hidden. toggleTab flips master and forces every group.
      // After the individual eye, master label is still "Hidden" (eyes don't change it).
      // Tapping it flips to shown and forces every group shown — including month, which was already shown.
      const afterMaster = await page.evaluate(() => ({ month: gShown('dash:month'), all: gShown('dash:all'), stock: gShown('dash:stock'), st: tabState('dash') }));
      check(afterMaster.st === 'shown' && afterMaster.month && afterMaster.all && afterMaster.stock, 'master show ' + JSON.stringify(afterMaster));
      await page.locator('#tabEye').click();
      const hiddenAgain = await page.evaluate(() => ({ month: gShown('dash:month'), all: gShown('dash:all'), bars: [...document.querySelectorAll('#dMonths i')].every(el => el.getBoundingClientRect().width < 0.5) }));
      check(!hiddenAgain.month && !hiddenAgain.all && hiddenAgain.bars, 'master hide ' + JSON.stringify(hiddenAgain));
      // show only all-time, chart stays hidden
      await page.locator('#allTime .eyerow .eye').click();
      const onlyAll = await page.evaluate(() => ({
        month: gShown('dash:month'), all: gShown('dash:all'),
        chart: document.querySelector('.mprow').getAttribute('aria-label'),
        bars: [...document.querySelectorAll('#dMonths i')].every(el => el.getBoundingClientRect().width < 0.5)
      }));
      check(onlyAll.all && !onlyAll.month && onlyAll.bars && /profit hidden/.test(onlyAll.chart), 'all-time eye leaked into the chart ' + JSON.stringify(onlyAll));
      const weekAfter = await page.evaluate(() => document.querySelector('#wkTotal').textContent);
      check(weekAfter === before.week, 'weekly chart changed');
      await page.reload({ waitUntil: 'networkidle' });
      await openProfit(page);
      const kept = await page.evaluate(() => ({ all: gShown('dash:all'), month: gShown('dash:month'), stock: gShown('dash:stock') }));
      check(kept.all && !kept.month && !kept.stock, 'per-device mask was not kept ' + JSON.stringify(kept));
      await shot(page, 'mobile-100-individual-all-shown');
      await context.close();
    }

    await scenario('desktop-100-full-revealed', fullState(), SHOWN, { desktop: true });
    await scenario('desktop-100-full-masked', fullState(), null, { desktop: true, secrets: secretsFull });
    await scenario('desktop-100-long-revealed', longState(), SHOWN, { desktop: true });
    await scenario('desktop-130-long-revealed', longState(), SHOWN, { desktop: true, scale: 1.3 });
    await scenario('desktop-100-empty-zero-revealed', emptyZero(), SHOWN, { desktop: true });

    // earlier page still has month and year, and no horizontal overflow
    await scenario('mobile-100-earlier-page', (() => {
      const realizedMonths = [];
      for (let y = 2024, m = 10; y < 2026 || m <= 11; ) {
        realizedMonths.push({ month: y + '-' + String(m).padStart(2, '0'), profit: m === 1 ? -5000 : 1000 * m });
        m++; if (m > 12) { m = 1; y++; }
      }
      return state({ version: 12, realizedMonths, sales: [{ date: '2026-11-01', profit: 777777.77 }], month: { name: 'November', realizedProfit: 11000, purchasesCost: 0 }, dashboard: { totalRealized: 1, cashUsed: 0 } });
    })(), SHOWN, { earlier: true });
  } finally {
    await browser.close();
  }
  const report = { fails, shots: notes, when: new Date().toISOString() };
  await writeFile(path.join(OUT, 'results.json'), JSON.stringify(report, null, 2));
  if (fails.length) {
    console.error(fails.map(f => 'FAIL ' + f).join('\n'));
    process.exit(1);
  }
  console.log('PASS ' + notes.length + ' screenshots');
}

run().catch(e => { console.error(e); process.exit(1); });
