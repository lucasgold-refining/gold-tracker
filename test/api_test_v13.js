// Api.gs v15 + Code.gs v11 efficiency tests (v13 behaviour, version 15 + receipts). Run with TZ=Asia/Manila.
const fs = require('fs'), vm = require('vm'), path = require('path');
const { build } = require('./mock');
const dir = path.join(__dirname, '..', 'sheet');
const expectedPath = path.join(__dirname, '..', 'fixtures', 'expected-dashboard.json');
const expected = fs.existsSync(expectedPath) ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')) : null;
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const close = (a, b, tol) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= (tol || 0.05);

function boot() {
  const env = build();
  const ctx = vm.createContext(Object.assign({ console }, env.g));
  for (const f of ['Code.gs', 'Api.gs']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  ctx.setupGoldApi();
  const T = env.scriptProps.GOLD_API_TOKEN;
  const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: T }, o)) }, parameter: {} }).text);
  const get = p => JSON.parse(ctx.doGet({ parameter: Object.assign({ token: T }, p) }).text);
  return { env, ctx, post, get, T };
}

function resetCalls(env) {
  env.calls.reads = 0; env.calls.bySheet = {}; env.calls.ranges = [];
}

// ----- version, POST/GET, getSettings, batchPreview, itemsCost, projections, no Dashboard read
{
  const B = boot(), { post, get, env, ctx } = B;
  const ping = post({ action: 'ping' });
  ok(ping.ok && ping.version === 56 && ping.receipts === true, 'ping version 50 with receipts (got ' + ping.version + ', receipts=' + ping.receipts + ')');

  resetCalls(env);
  const lite = post({ action: 'getSettings' });
  ok(lite.ok && lite.version === 56 && lite.receipts === true && lite.base === 8250 && lite.settings && lite.settings.refiningFee === 20000, 'getSettings returns base + settings + receipts');
  ok(!lite.state && !lite.stock && !lite.batches, 'getSettings does not return full state');
  ok(!(env.calls.bySheet.Purchases) && !(env.calls.bySheet.Archive) && !(env.calls.bySheet.Dashboard) && !(env.calls.bySheet.Sales),
     'getSettings does not read Purchases / Archive / Dashboard / Sales (reads: ' + JSON.stringify(env.calls.bySheet) + ')');

  resetCalls(env);
  const st = post({ action: 'getState' }).state;
  ok(st && st.version === 56 && st.receipts === true, 'POST getState returns version 50 with receipts');
  ok(!(env.calls.bySheet.Dashboard), 'getState does not read the Dashboard tab (bySheet=' + JSON.stringify(env.calls.bySheet) + ')');
  ok(st.dashboard && close(st.dashboard.cashUsed, (st.stock || []).reduce((t, x) => t + (x.cost || 0), 0) + 403 * 3600, 0.05),
     'cashUsed is summed from rows (stock + the 403 mock Archive items), not from Dashboard cells: ' + (st.dashboard && st.dashboard.cashUsed));
  ok(st.dashboard.estRefiningProfit === undefined, 'estRefiningProfit is not sent');
  ok(Array.isArray(st.realizedMonths), 'realizedMonths still present');

  const open = (st.batches || []).filter(b => b.status === 'Refining');
  // mock seed batch R-20261018 is unsold
  const b0 = (st.batches || []).find(x => x.id === 'R-20261018');
  ok(b0 && close(b0.itemsCost, b0.costInclFee - 20000, 0.01) && b0.fee === 20000,
     'itemsCost = costInclFee − fee (' + (b0 && b0.itemsCost) + ' = ' + (b0 && b0.costInclFee) + ' − 20000)');
  ok(b0 && b0.silverG != null && isFinite(b0.silverG), 'silverG comes from the register (no item-scan function): ' + (b0 && b0.silverG));

  if (st.stock && st.stock[0] && st.base) {
    const it = st.stock[0];
    const want = st.base * it.purity * (it.weightBhy / (st.settings.bhyPerGram || 2));
    ok(close(it.projSell, want, 0.02), 'projSell = base × purity × grams (' + it.projSell + ' vs ' + want + ')');
  } else ok(true, 'no in-stock item in default mock (projSell skipped)');

  const prev = post({ action: 'batchPreview' });
  ok(prev.ok && prev.preview && prev.preview.count >= 0 && prev.state === undefined, 'batchPreview has preview and no state');

  const viaGet = get({ action: 'getState' });
  ok(viaGet.ok === false && viaGet.auth === false && !viaGet.state, 'GET ?token= is refused (v53). The token is not read from the URL.');
  const viaPost = post({ action: 'getState' });
  ok(viaPost.ok && viaPost.state && viaPost.state.version === 56 && viaPost.state.receipts === true, 'POST getState still works for the phone');

  const msg = ctx.installDailyTrigger();
  ok(/Not installed/.test(msg) && !(env.g.ScriptApp._newTriggerCalls && env.g.ScriptApp._newTriggerCalls.length),
     'installDailyTrigger refuses and creates no trigger: ' + msg);
}

// ----- batchItems reads only the requested batch's item span
{
  const B = boot(), { post, env } = B;
  const ref = env.sheets.Refining;
  // Two bigger blocks: keep R-20261018 (3 items at rows 19-21), add R-NEW (50 items) then R-TAIL (20 items)
  const start = 21; // 0-index row 21 = sheet row 22, after the 3 seed items
  for (let i = 0; i < 50; i++) ref.d[start + i].splice(0, 7, 'R-NEW', new Date(2026, 9, 20), 100 + i, 1, 0.9, 1000, 8000);
  ref.d[start].splice(12, 3, 'R-NEW', new Date(2026, 9, 20), 8000);
  for (let i = 0; i < 20; i++) ref.d[start + 50 + i].splice(0, 7, 'R-TAIL', new Date(2026, 9, 21), 200 + i, 1, 0.9, 1000, 8000);
  ref.d[start + 50].splice(12, 3, 'R-TAIL', new Date(2026, 9, 21), 8000);
  resetCalls(env);
  const j = post({ action: 'batchItems', batchId: 'R-NEW' });
  ok(j.ok && j.items && j.items.length === 50, 'batchItems R-NEW returns 50 items (got ' + (j.items && j.items.length) + ')');
  const itemReads = env.calls.ranges.filter(r => r.name === 'Refining' && r.c === 1 && r.nc >= 6);
  const wide = itemReads.filter(r => r.nr > 60); // a full-tab 6-col read would be hundreds of rows
  ok(itemReads.length >= 1 && !wide.length,
     'batchItems does not read all item rows 6-wide (reads=' + JSON.stringify(itemReads) + ')');
  const nos = (j.items || []).map(x => x.no);
  ok(nos[0] === 100 && nos[49] === 149, 'only R-NEW item numbers were returned');
}

// ----- live realizedMonths: same maths as the Dashboard MONTHLY column (Sales compilation + new sales)
if (!expected) {
  console.log('SKIP realizedMonths vs live Dashboard: fixtures/expected-dashboard.json was not in the v50 archive');
} else {
  const B = boot(), { ctx } = B;
  const sales = [];
  for (let i = 0; i < 20; i++) sales.push(new Array(9).fill(''));
  sales[0][0] = 'SALES 2026';
  sales[1][1] = 'GRAND TOTAL'; sales[1][2] = expected.totalRealized;
  const comp = expected.salesCompilation2026;
  for (let m = 1; m <= 6; m++) { sales[3 + m - 1][1] = comp[m - 1]; }
  for (let m = 7; m <= 12; m++) { sales[m - 3 - 1][6] = comp[m - 1]; }
  expected.salesRows.forEach((row, i) => {
    const r = sales[10 + i] || (sales[10 + i] = new Array(9).fill(''));
    r[0] = row.serial; r[7] = row.profit; r[8] = row.batch;
  });
  const built = ctx.goldApiMonthsFromRows_(sales, [], [], [], null, '2026-11');
  const map = {};
  built.forEach(x => { map[x.month] = x.profit; });
  let allOk = true, detail = [];
  Object.keys(expected.realizedMonths).forEach(ym => {
    const want = expected.realizedMonths[ym], got = map[ym] || 0;
    const pass = close(got, want, 0.05);
    if (!pass) allOk = false;
    detail.push(ym + ' got ' + got + ' want ' + want);
  });
  const year = built.reduce((t, x) => t + (x.month.startsWith('2026') ? x.profit : 0), 0);
  ok(allOk, 'realizedMonths match the live Dashboard MONTHLY figures: ' + detail.join('; '));
  ok(close(year, expected.totalRealized, 0.05), 'sum of months = live total realized ' + expected.totalRealized + ' (got ' + year + ')');

  const dash = ctx.goldApiDashboard_([], [], [], [], built.map(x => ({ month: x.month, profit: x.profit })), { base: expected.base });
  ok(close(dash.totalRealized, expected.totalRealized, 0.05) && dash.estRefiningProfit === undefined && dash.base === expected.base,
     'goldApiDashboard_ totalRealized from months, no estRefiningProfit');
}

// ----- trim helpers: sold vs unsold, check function, formula fallbacks, preview is read-only
{
  const B = boot(), { ctx, env } = B;
  ok(ctx.trimSoldIsSold_(new Date(), 8300, '') === true, 'sold when sell date + sell base');
  ok(ctx.trimSoldIsSold_('', '', '') === false, 'unsold when sale columns are blank');
  const F = ctx.trimSoldFormulas_();
  ok(/AF19:AF/.test(F.P) && /COUNTIF/.test(F.P), 'Items formula falls back to frozen AF when no item rows');
  ok(F.C6 === '=SUM(P19:P)' && F.C12 === '=SUM(T19:T)', 'All-batches column C sums the register');
  const before = {
    batches: [
      { id: 'R-SOLD', items: 10, rawG: 5, refinedG: 4, costInclFee: 100000, estValue: 110000, silverG: 1 },
      { id: 'R-OPEN', items: 2, rawG: 1, refinedG: 0.9, costInclFee: 30000, estValue: 32000, silverG: 0.2 }
    ],
    allBatches: { items: 12, rawG: 6, refinedG: 4.9, costInclFee: 130000, estValue: 142000 },
    itemsByBatch: { 'R-SOLD': [1, 2], 'R-OPEN': [1, 2] },
    unsoldIds: ['R-OPEN'], soldIds: ['R-SOLD']
  };
  const afterGood = {
    batches: before.batches.map(b => Object.assign({}, b)),
    allBatches: Object.assign({}, before.allBatches),
    itemsByBatch: { 'R-SOLD': [], 'R-OPEN': [1, 2] },
    unsoldIds: ['R-OPEN'], soldIds: ['R-SOLD']
  };
  ok(ctx.trimSoldCheck_(before, afterGood, 't').length === 0, 'trimSoldCheck_ accepts identical register + unsold items kept');
  const afterBad = JSON.parse(JSON.stringify(afterGood));
  afterBad.batches[0].costInclFee = 1;
  ok(ctx.trimSoldCheck_(before, afterBad, 't').some(x => /costInclFee/.test(x)), 'trimSoldCheck_ catches a changed register total');

  const beforeReads = env.calls.reads;
  const msg = ctx.trimSoldBatchItemsPreview();
  ok(/sold/i.test(String(msg)) && env.sheets.Refining.d[18][0] === 'R-20261018', 'preview returns a summary and does not clear item rows');
  // preview is read-only: seed item still there
  ok(env.sheets.Refining.d[18][2] === 1, 'preview did not move item rows');
}

console.log(`${n - fails}/${n} passed`);
process.exit(fails ? 1 : 0);
