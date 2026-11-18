// v54 audit remediation on the simulated sheet. Never calls a live spreadsheet.
// Covers rounding, URL-token refusal, backup still via POST, refine rollback, and a repeated group sale.
const fs = require('fs'), vm = require('vm'), path = require('path');
const { build } = require('./mock');
const SHEET = path.join(__dirname, '..', 'sheet');
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

function boot() {
  const env = build(); const ctx = vm.createContext(Object.assign({ console }, env.g));
  vm.runInContext(fs.readFileSync(path.join(SHEET, 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  vm.runInContext(fs.readFileSync(path.join(SHEET, 'Api.gs'), 'utf8'), ctx, { filename: 'Api.gs' });
  ctx.setupGoldApi(); const T = env.scriptProps.GOLD_API_TOKEN;
  const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: T }, o)) }, parameter: {} }).text);
  const get = p => JSON.parse(ctx.doGet({ parameter: Object.assign({ token: T }, p) }).text);
  env.sheets.Archive.d.splice(1);
  ctx.setupBatchNumbers_();
  let k = 0; const rid = () => 'v53-' + (++k);
  const add = o => { const r = post(Object.assign({ action: 'addPurchase', rid: rid(), weightBhy: 2, purity: 0.9, cost: 7000, lite: true, date: '2026-11-17', at: '2026-11-17T10:00:00+08:00' }, o)); if (!r.ok) throw new Error(r.error); return r; };
  const st = () => post({ action: 'getState' }).state;
  return { env, ctx, post, get, add, st, rid, T };
}
const purRow = (B, no) => B.env.sheets.Purchases.d.slice(1).find(r => Number(r[0]) === no);
const regIds = B => B.env.sheets.Refining.d.slice(18).map(r => String(r[12] || '')).filter(Boolean);
const itemIds = B => B.env.sheets.Refining.d.slice(18).map(r => String(r[0] || '')).filter(Boolean);

function armArchiveFail(env) {
  const ar = env.sheets.Archive;
  const orig = ar.getRange.bind(ar);
  ar.getRange = function () {
    const range = orig.apply(ar, arguments);
    const setValues = range.setValues.bind(range);
    range.setValues = function (v) {
      if (ar._failWrite) { ar._failWrite = false; throw new Error('sheet is full'); }
      return setValues(v);
    };
    return range;
  };
}

// ----- rounding matches the phone (half away from zero) and purity is cut the same way
{
  const B = boot();
  ok(B.ctx.round2_(1.005) === 1.01 && B.ctx.round2_(1.015) === 1.02, 'round2_ half away: 1.005 -> 1.01, 1.015 -> 1.02');
  ok(B.ctx.round2_(-1.005) === -1.01 && B.ctx.round2_(-1.015) === -1.02, 'round2_ half away on negatives');
  ok(B.ctx.round2_(0) === 0 && B.ctx.round2_(8233.5) === 8233.5, 'round2_ leaves exact cents alone');
  ok(B.ctx.toPurity_('85.356') === 0.8535 && B.ctx.toPurity_('85.356%') === 0.8535, 'toPurity_ cuts a percent the way the phone does (85.356 -> 0.8535)');
  ok(B.ctx.toPurity_(0.997999) === 0.997999 && B.ctx.toPurity_('0.85356') === 0.85356, 'a fraction is not rounded (0.997999 must stay below 99.8%)');
  ok(B.ctx.toPurity_('85.35') === 0.8535 && B.ctx.toPurity_('99.8') === 0.998 && B.ctx.toPurity_(1) === 1, 'toPurity_ keeps 85.35, 99.8 and 100');
  const api = B.add({ purity: '85.356', weightBhy: 7.5, cost: 1000 });
  ok(api.ok && Math.abs(purRow(B, api.no)[4] - 0.8535) < 1e-12, 'API addPurchase stores the cut purity');
  const menu = B.ctx.addPurchase({ date: '2026-11-17', weightBhy: 1, purity: '85.356', cost: 500 });
  ok(/No\./.test(menu) && B.env.sheets.Purchases.d.slice(1).some(r => Math.abs(Number(r[4]) - 0.8535) < 1e-12 && r[6] === 500), 'menu addPurchase uses the same cut and still writes');
}

// ----- token stays in the POST body; the URL cannot authorise; backup still works for the owner
{
  const B = boot();
  const ping = B.post({ action: 'ping' });
  ok(ping.ok && ping.version === 55, 'POST body token still works');
  const viaGet = B.get({ action: 'getState' });
  ok(viaGet.ok === false && viaGet.auth === false && !viaGet.state, 'GET ?token= cannot read the sheet');
  const viaQuery = JSON.parse(B.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'exportBackup' }) }, parameter: { token: B.T } }).text);
  ok(viaQuery.ok === false && !viaQuery.data, 'POST with the token only on the URL cannot export');
  const bak = B.post({ action: 'exportBackup' });
  ok(bak.ok && typeof bak.data === 'string' && bak.data.length > 20 && bak.mime.indexOf('spreadsheet') >= 0 && !/token/i.test(JSON.stringify({ name: bak.name, size: bak.size })), 'POST backup still returns the workbook for the owner');
  const kept = B.env.scriptProps.GOLD_API_TOKEN;
  B.ctx.setupGoldApi();
  ok(B.env.scriptProps.GOLD_API_TOKEN === kept && B.post({ action: 'ping' }).ok, 'setupGoldApi does not rotate the existing token');
  const fresh = B.ctx.goldApiNewToken();
  ok(B.env.scriptProps.GOLD_API_TOKEN !== kept && /Token:/.test(fresh), 'goldApiNewToken still rotates when the owner runs it');
  const oldPing = JSON.parse(B.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'ping', token: kept }) }, parameter: {} }).text);
  const neu = B.env.scriptProps.GOLD_API_TOKEN;
  const now = JSON.parse(B.ctx.doPost({ postData: { contents: JSON.stringify({ action: 'ping', token: neu }) }, parameter: {} }).text);
  ok(oldPing.ok === false && now.ok, 'after a manual rotation only the new token works');
}

// ----- a failed Archive step before any Purchases delete rolls the refine back; the same rid can then succeed
{
  const B = boot();
  B.add({ weightBhy: 2, purity: 0.85, cost: 4000 });
  B.add({ weightBhy: 1, purity: 0.9, cost: 2000 });
  const before = purRow(B, 1).slice();
  const regs = regIds(B).slice();
  armArchiveFail(B.env);
  B.env.sheets.Archive._failWrite = true;
  const bad = B.post({ action: 'batchRefine', rid: 'rf-1', batchId: 'R-FAIL', pickNos: [1] });
  ok(bad.ok === false && /Nothing was refined/.test(bad.error || '') && /sheet is full/.test(bad.error || ''), 'refine reports the archive failure and that nothing was refined (' + (bad.error || bad.message) + ')');
  const row = purRow(B, 1);
  ok(row && row[10] === 'In stock' && row[2] === before[2] && row[4] === before[4] && row[6] === before[6], 'the purchase is still In stock with the same weight, purity and cost');
  ok(regIds(B).join() === regs.join() && itemIds(B).indexOf('R-FAIL') < 0, 'no Refining register row and no item rows were left for R-FAIL');
  ok(!B.env.sheets.Archive.d.slice(1).some(r => String(r[14] || '') === 'R-FAIL'), 'Archive has no R-FAIL row');
  const again = B.post({ action: 'batchRefine', rid: 'rf-1', batchId: 'R-FAIL', pickNos: [1] });
  ok(again.ok && again.batchId === 'R-FAIL' && !purRow(B, 1) && purRow(B, 2) && purRow(B, 2)[10] === 'In stock', 'the same request id refines once the sheet can be written (' + (again.message || again.error) + ')');
  ok(B.env.sheets.Archive.d.slice(1).some(r => Number(r[0]) === 1 && String(r[14]) === 'R-FAIL'), 'the retried refine archived item 1');
}

// ----- a group sale that is already on Sales is not written again
{
  const B = boot();
  B.add({ weightBhy: 2, purity: 0.9, cost: 4000 });
  ok(B.post({ action: 'batchRefine', rid: 'mk', batchId: 'R-ONE', pickNos: [1] }).ok, 'setup refine');
  const ids = ['R-ONE', 'R-20261018'];
  const first = B.post({ action: 'sellBatches', rid: 'g1', batchIds: ids, sellDate: '2026-11-18', sellBase: 8250 });
  ok(first.ok && first.batchIds.join() === ids.slice().sort().join(), 'group sale recorded (' + (first.message || first.error) + ')');
  const count = () => B.env.sheets.Sales.d.slice(10).filter(r => ids.indexOf(String(r[8])) >= 0).length;
  const n1 = count();
  const second = B.post({ action: 'sellBatches', rid: 'g2', batchIds: ids, sellDate: '2026-11-18', sellBase: 9000 });
  ok(second.ok && /already on the Sales tab/.test(second.message || '') && count() === n1, 'a second group sale does not add rows (' + (second.message || second.error) + ')');
  const replay = B.post({ action: 'sellBatches', rid: 'g1', batchIds: ids, sellDate: '2026-11-18', sellBase: 8250 });
  ok(replay.ok && replay.duplicate === true && count() === n1, 'the original request id replays its receipt');
}

// ----- the unused helpers are gone; the shared sale body is what the API calls
{
  const B = boot();
  ok(typeof B.ctx.goldApiBatchSilver_ === 'undefined' && typeof B.ctx.goldApiDashVals_ === 'undefined', 'goldApiBatchSilver_ and goldApiDashVals_ are not defined');
  ok(typeof B.ctx.addPurchaseCore_ === 'function' && typeof B.ctx.addSaleCore_ === 'function' && typeof B.ctx.syncBatchSalesCore_ === 'function', 'purchase, sale and sync share one body');
  const sale = B.ctx.goldApiAddSale_({ date: '2026-11-18', cost: 10, actual: 25 });
  ok(/Sale added/.test(sale) && B.env.sheets.Sales.d.slice(10).some(r => r[4] === 10 && r[5] === 25), 'API other-sale uses the shared writer');
}

console.log(`\nSUMMARY v54 ${n - fails} passed, ${fails} failed, of ${n}`);
process.exit(fails ? 1 : 0);
