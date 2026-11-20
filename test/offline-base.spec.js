const { test, expect } = require('@playwright/test');

const SHEET = 7425.39;
const STATE = {
  base: SHEET,
  source: 'BSP',
  lastUpdated: '20 Nov 14:30',
  settings: { base: SHEET, fullMin: 0.998, bhyPerGram: 2, quoteMargin: 0.01, refiningFee: 350 },
  version: 56,
  receipts: true,
  directSale: true,
  pickRefine: true,
  stock: [],
  batches: [{ id: 'R-1', status: 'Refining', refinedG: 10.5, costInclFee: 80000, items: 1, rawG: 12, base: 7400, canAdd: true, date: '2026-11-19' }],
  nextNo: 2,
  dashboard: { totalRealized: 0, cashUsed: 0 },
  _syncedAt: '2026-11-20T06:00:00.000Z',
};

function liveBody(source, base) {
  const state = JSON.parse(JSON.stringify(STATE));
  state.base = base;
  state.source = source;
  state.settings.base = base;
  return JSON.stringify({ ok: true, state });
}

async function install(page, net) {
  await page.addInitScript((state) => {
    localStorage.setItem('gold-tracker-config', JSON.stringify({ url: 'https://sheet.test/exec', token: '1234567890abcdef' }));
    localStorage.setItem('gold-tracker-state', JSON.stringify(state));
    window.__goldApiTimeout = 700;
  }, STATE);
  await page.route('https://sheet.test/**', async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    net.calls.push(body);
    if (net.mode === 'abort') return route.abort('failed');
    if (net.mode === 'late') {
      await new Promise((r) => setTimeout(r, 2000));
      try { await route.abort('timedout'); } catch (e) {}
      return;
    }
    if (net.mode === 'empty') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, message: 'ok' }) });
    }
    if (net.mode === 'spot') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: liveBody('goldprice.org', 7600.5) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: liveBody('BSP', SHEET) });
  });
  page.on('dialog', (d) => d.accept());
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  net.errors = errors;
}

async function openApp(page) {
  await page.goto('http://127.0.0.1:8765/index.html?test=1#quote');
  await page.waitForFunction(() => window.__goldOutbox && window.__goldOff);
  await page.evaluate(() => window.__goldOutbox.ready());
  await page.waitForFunction(() => !window.__goldOff.busy());
}

async function setOfflineBase(page, text) {
  await page.locator('#basePill').click();
  await page.locator('#bb').fill(text);
  await page.locator('#bbOff').click();
  await expect(page.locator('#offTag')).toHaveText('Offline');
}

test('offline base, queued purchase and sale, failed sync, then a live sheet base', async ({ page }) => {
  const net = { mode: 'abort', calls: [] };
  await install(page, net);
  await openApp(page);
  await page.context().setOffline(true);
  await page.waitForFunction(() => window.__goldOff.offline());

  await test.step('setting an offline base while offline never calls setBase', async () => {
    await page.locator('#basePill').click();
    await expect(page.locator('#bbOff')).toBeVisible();
    await expect(page.locator('#bbsave')).toHaveCount(0);
    await expect(page.locator('#modal')).toContainText('sheet is not changed');
    await page.locator('#bb').fill('7100');
    await page.locator('#bbOff').click();
    await expect(page.locator('#offTag')).toHaveText('Offline');
    await expect(page.locator('#basePill')).toContainText('7,100.00');
    await expect(page.locator('#basePill')).toContainText('7,425.39');
    const stored = await page.evaluate(() => ({
      off: JSON.parse(localStorage.getItem('gold-tracker-offbase')),
      st: JSON.parse(localStorage.getItem('gold-tracker-state')),
    }));
    expect(stored.off.base).toBe(7100);
    expect(stored.st.base).toBe(SHEET);
    expect(stored.st.settings.base).toBe(SHEET);
    expect(stored.st.source).toBe('BSP');
    expect(net.calls.map((c) => c.action)).not.toContain('setBase');
  });

  await test.step('quote and queue a purchase at the offline base, exact peso cost', async () => {
    await page.locator('#qp').fill('87.1');
    await expect(page.locator('#qPrice')).toHaveText('₱3,055');
    const quoted = await page.evaluate(() => quoteFor(0.871));
    expect(quoted.perBhy).toBe(3055);
    await page.locator('#qbuy').click();
    await page.locator('#bw').fill('2');
    await expect(page.locator('#chint')).toBeVisible();
    await page.locator('#chint').click();
    await expect(page.locator('#bc')).toHaveValue('6110');
    await page.locator('#bsave').click();
    await page.waitForFunction(() => window.__goldOutbox.items().some((x) => x.action === 'addPurchase'));
    const item = await page.evaluate(() => window.__goldOutbox.items().find((x) => x.action === 'addPurchase'));
    expect(item.cost).toBe(6110);
    expect(item.weightBhy).toBe(2);
    expect(item.purity).toBeCloseTo(0.871, 4);
    expect(item.base).toBeUndefined();
    expect(Object.keys(item)).not.toContain('sellBase');
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem('gold-tracker-state')));
    expect(st.base).toBe(SHEET);
    expect(net.calls.map((c) => c.action)).not.toContain('setBase');
    expect(net.calls.map((c) => c.action)).not.toContain('addPurchase');
  });

  await test.step('a sale queues the sell base typed in the modal', async () => {
    await page.locator('nav button[data-v="sales"]').click();
    await page.getByRole('button', { name: 'Record sale' }).click();
    await page.locator('#sb').fill('8000.50');
    await page.locator('#sgo').click();
    await page.waitForFunction(() => window.__goldOutbox.items().some((x) => x.action === 'recordBatchSale'));
    const sale = await page.evaluate(() => window.__goldOutbox.items().find((x) => x.action === 'recordBatchSale'));
    expect(sale.sellBase).toBe(8000.5);
    expect(sale.batchId).toBe('R-1');
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem('gold-tracker-state')));
    expect(st.base).toBe(SHEET);
    expect(st.source).toBe('BSP');
    expect(net.calls.map((c) => c.action)).not.toContain('setBase');
    expect(net.calls.map((c) => c.action)).not.toContain('recordBatchSale');
  });

  await test.step('offline mark is visible and Use sheet base restores the sheet base', async () => {
    await page.locator('nav button[data-v="quote"]').click();
    const tag = page.locator('#offTag');
    await expect(tag).toBeVisible();
    const fit = await page.evaluate(() => {
      const t = document.getElementById('offTag').getBoundingClientRect();
      const p = document.getElementById('basePill').getBoundingClientRect();
      return { tagW: t.width, past: t.right - p.right, above: p.top - t.top, below: t.bottom - p.bottom };
    });
    expect(fit.tagW).toBeGreaterThan(40);
    expect(fit.past).toBeLessThanOrEqual(1);
    expect(fit.above).toBeLessThanOrEqual(1);
    expect(fit.below).toBeLessThanOrEqual(1);
    await page.locator('#setBtn').click();
    await page.locator('#cbase').click();
    await expect(page.locator('#bbSheet')).toHaveText('Use sheet base');
    await page.locator('#bbSheet').click();
    await expect(page.locator('#offTag')).toHaveCount(0);
    await expect(page.locator('#basePill')).toContainText('7,425.39');
    await expect(page.locator('#basePill')).toContainText('BSP');
    expect(await page.evaluate(() => localStorage.getItem('gold-tracker-offbase'))).toBeNull();
    expect(await page.evaluate(() => window.__goldOff.active())).toBeNull();
    expect(await page.evaluate(() => window.__goldOff.sheet())).toBe(SHEET);
  });

  await test.step('a failed refresh while offline keeps the offline base', async () => {
    await setOfflineBase(page, '7100');
    const before = net.calls.length;
    await page.locator('#refreshBtn').click();
    await page.waitForFunction(() => !window.__goldOff.busy());
    expect(await page.evaluate(() => window.__goldOff.active())).toBe(7100);
    await expect(page.locator('#offTag')).toBeVisible();
    expect(net.calls.length).toBe(before);
    expect(net.calls.map((c) => c.action)).not.toContain('setBase');
  });

  await test.step('a timed-out sync and a reply with no base leave the offline base in place', async () => {
    net.mode = 'late';
    await page.context().setOffline(false);
    await page.waitForFunction(() => !window.__goldOff.busy(), null, { timeout: 8000 });
    expect(await page.evaluate(() => window.__goldOff.active())).toBe(7100);
    await expect(page.locator('#offTag')).toBeVisible();
    await expect(page.locator('#toast')).not.toContainText('Back online');
    const queued = await page.evaluate(() => window.__goldOutbox.items().map((x) => x.action));
    expect(queued).toContain('addPurchase');
    expect(queued).toContain('recordBatchSale');

    net.mode = 'abort';
    await page.locator('#refreshBtn').click();
    await page.waitForFunction(() => !window.__goldOff.busy());
    expect(await page.evaluate(() => window.__goldOff.active())).toBe(7100);
    await expect(page.locator('#offTag')).toBeVisible();
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem('gold-tracker-state')));
    expect(st.base).toBe(SHEET);
    expect(st.source).toBe('BSP');
  });

  await test.step('a live sync clears the offline base and shows the sheet source', async () => {
    net.mode = 'bsp';
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#toast')).toHaveText('Back online · base updated to ₱7,425.39 (BSP)');
    const sent = net.calls.filter((c) => c.action === 'addPurchase').pop();
    const sold = net.calls.filter((c) => c.action === 'recordBatchSale').pop();
    expect(sent.cost).toBe(6110);
    expect(sent.action).toBe('addPurchase');
    expect(sold.sellBase).toBe(8000.5);
    expect(sold.action).toBe('recordBatchSale');
    await expect(page.locator('#offTag')).toHaveCount(0);
    await expect(page.locator('#basePill')).toContainText('7,425.39');
    expect(await page.evaluate(() => window.__goldOff.active())).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('gold-tracker-offbase'))).toBeNull();
    expect(await page.evaluate(() => window.__goldOff.source())).toBe('BSP');

    await page.locator('#basePill').click();
    await expect(page.locator('#bbsave')).toHaveText('Save to sheet');
    await expect(page.locator('#bbOff')).toHaveText('Use offline on this device only');
    await page.locator('#bb').fill('7000');
    await page.locator('#bbOff').click();
    await expect(page.locator('#offTag')).toBeVisible();
    net.mode = 'empty';
    await page.locator('#refreshBtn').click();
    await page.waitForFunction(() => !window.__goldOff.busy());
    await expect(page.locator('#toast')).toHaveText('Updated from the sheet');
    expect(await page.evaluate(() => window.__goldOff.active())).toBe(7000);
    await expect(page.locator('#offTag')).toBeVisible();
    net.mode = 'spot';
    await page.locator('#refreshBtn').click();
    await expect(page.locator('#toast')).toHaveText('Back online · base updated to ₱7,600.50 (Gold spot)');
    await expect(page.locator('#offTag')).toHaveCount(0);
    await expect(page.locator('#basePill')).toContainText('7,600.50');
    expect(await page.evaluate(() => window.__goldOff.active())).toBeNull();
    expect(await page.evaluate(() => window.__goldOff.source())).toBe('goldprice.org');
    const st = await page.evaluate(() => JSON.parse(localStorage.getItem('gold-tracker-state')));
    expect(st.base).toBe(7600.5);
    expect(st.settings.base).toBe(7600.5);
    expect(net.calls.map((c) => c.action)).not.toContain('setBase');
    expect(net.errors).toEqual([]);
  });
});

test('offline mark does not clip at 125% font scale on a 412px phone', async ({ page }) => {
  const net = { mode: 'abort', calls: [] };
  await install(page, net);
  await page.addInitScript(() => {
    localStorage.setItem('gold-tracker-offbase', JSON.stringify({ base: 7100, at: '2026-11-20T06:00:00.000Z' }));
  });
  await openApp(page);
  await page.context().setOffline(true);
  await expect(page.locator('#offTag')).toBeVisible();
  await page.locator('#qp').fill('87.1');
  await page.evaluate((factor) => {
    const els = [document.body, ...document.body.querySelectorAll('*')];
    const sizes = els.map((el) => parseFloat(getComputedStyle(el).fontSize) || 0);
    els.forEach((el, i) => { if (sizes[i]) el.style.setProperty('font-size', (sizes[i] * factor) + 'px', 'important'); });
  }, 1.25);
  const fit = await page.evaluate(() => {
    const tag = document.getElementById('offTag');
    const pill = document.getElementById('basePill');
    const t = tag.getBoundingClientRect();
    const p = pill.getBoundingClientRect();
    const doc = document.documentElement;
    return {
      text: tag.textContent,
      tagW: t.width,
      scrollClip: tag.scrollWidth - tag.clientWidth,
      past: t.right - Math.min(p.right, window.innerWidth),
      above: p.top - t.top,
      below: t.bottom - p.bottom,
      overflowX: doc.scrollWidth - doc.clientWidth,
    };
  });
  expect(fit.text).toBe('Offline');
  expect(fit.tagW).toBeGreaterThan(48);
  expect(fit.scrollClip).toBeLessThanOrEqual(1);
  expect(fit.past).toBeLessThanOrEqual(1);
  expect(fit.above).toBeLessThanOrEqual(1);
  expect(fit.below).toBeLessThanOrEqual(1);
  expect(fit.overflowX).toBeLessThanOrEqual(1);
});
