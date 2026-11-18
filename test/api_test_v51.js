// Api.gs v51: direct sale of In stock items whose purity is actually >= 99.8%.
// No refining batch, no refining fee, original weight/purity/cost, one Sales row, leftovers not renumbered.
// Run with TZ=Asia/Manila. Never calls a live sheet.
const fs = require('fs'), vm = require('vm'), path = require('path');
const { build } = require('./mock');
const SHEET = path.join(__dirname, '..', 'sheet');
const V50 = path.join(__dirname, 'fixtures', 'Api-v50.gs');
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

function boot(apiPath, opt) {
  opt = opt || {};
  const env = build(); const ctx = vm.createContext(Object.assign({ console }, env.g));
  vm.runInContext(fs.readFileSync(path.join(SHEET, 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  vm.runInContext(fs.readFileSync(apiPath || path.join(SHEET, 'Api.gs'), 'utf8'), ctx, { filename: 'Api.gs' });
  ctx.setupGoldApi(); const T = env.scriptProps.GOLD_API_TOKEN;
  const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: T }, o)) }, parameter: {} }).text);
  const get = p => JSON.parse(ctx.doGet({ parameter: Object.assign({ token: T }, p) }).text);
  if (!opt.keepArchive) env.sheets.Archive.d.splice(1);
  ctx.setupBatchNumbers_();
  let k = 0; const rid = () => 'v51-' + (++k);
  const add = o => { const r = post(Object.assign({ action: 'addPurchase', rid: rid(), weightBhy: 2, purity: 0.9, cost: 7000, lite: true, date: '2026-11-17', at: '2026-11-17T10:00:00+08:00' }, o)); if (!r.ok) throw new Error(r.error); return r; };
  const st = () => get({ action: 'getState' }).state;
  return { env, ctx, post, get, add, st, rid };
}
const ser = v => Object.prototype.toString.call(v) === '[object Date]' ? 'D' + v.getTime() : v;
const rowsOf = sh => JSON.stringify(sh.d.slice(1).filter(r => r.some(x => x !== '' && x !== null)).map(r => r.map(ser)));
// Formula columns fill in when a read recalc runs, so compare after one read of each tab.
const touch = B => ['Purchases', 'Archive', 'Refining', 'Sales'].forEach(name => B.env.sheets[name].getLastRow());
const snap = B => { touch(B); return {
  pur: rowsOf(B.env.sheets.Purchases), ref: rowsOf(B.env.sheets.Refining), arc: rowsOf(B.env.sheets.Archive),
  sales: rowsOf(B.env.sheets.Sales), bctr: B.env.docProps[Object.keys(B.env.docProps).find(k => /batchNo/i.test(k)) || '']
}; };
const purRow = (B, no) => B.env.sheets.Purchases.d.slice(1).find(r => Number(r[0]) === no);
const arcRows = B => B.env.sheets.Archive.d.slice(1).filter(r => r[0] !== '' && r[0] != null && r[2] !== '' && r[2] != null);
const saleRows = B => B.env.sheets.Sales.d.slice(10).filter(r => r[0] !== '' && r[0] != null);
const refIds = B => B.env.sheets.Refining.d.slice(18).map(r => r[12]).filter(x => x !== '' && x != null);
const bnoKey = B => Object.keys(B.env.docProps).find(k => /batchNo/i.test(k));
const logRids = (B, re) => (B.env.sheets.ApiLog ? B.env.sheets.ApiLog.d.slice(1) : []).filter(r => re.test(String(r[0] || '')));

function seed(B) {
  // #1 99.8% exactly, #2 90%, #3 99.9%, #4 99.7999% (displays near 99.80%, not eligible), #5 100%
  [[2, 0.998, 8000], [2, 0.9, 4000], [3, 0.999, 12500], [1, 0.997999, 3000], [4, 1, 16000]].forEach(x => B.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
}
const sell = (B, o) => B.post(Object.assign({ action: 'sellStock', rid: B.rid(), sellDate: '2026-11-18', sellBase: 8250 }, o));

// ===== 1) capability
{
  const B = boot(); seed(B);
  const ping = B.post({ action: 'ping' });
  ok(ping.version === 51 && ping.receipts === true && ping.pickRefine === true && ping.directSale === true, 'ping: version 51, receipts, pickRefine, directSale');
  const s = B.st();
  ok(s.version === 51 && s.directSale === true && s.pickRefine === true, 'getState carries directSale and pickRefine');
  const gs = B.post({ action: 'getSettings' });
  ok(gs.directSale === true && gs.version === 51, 'getSettings carries directSale');
}

// ===== 2) one eligible item: accounting, no fee, no batch, leftovers untouched
{
  const B = boot(); seed(B);
  const before2 = purRow(B, 2).slice(), before4 = purRow(B, 4).slice();
  const bctr = B.env.docProps[bnoKey(B)];
  const refNos = () => B.env.sheets.Refining.d.slice(18).filter(r => r[0] !== '' && r[0] != null).map(r => r[0] + ':' + r[2]).join();
  const ref0 = refNos();
  const m0 = B.st();
  const r = sell(B, { nos: [1] });
  ok(r.ok && r.saleId === 'DS-1' && /Profit/.test(r.message) && /4 items stay In stock/.test(r.message), 'single: recorded (' + (r.message || r.error) + ')');
  const s = B.st();
  ok(s.stock.map(x => x.no).join() === '2,3,4,5', 'single: only #1 left the stock');
  ok(s.stock.map(x => x.bno).join() === '2,3,4,5', 'single: leftover Batch # unchanged');
  ok(B.env.docProps[bnoKey(B)] === bctr, 'single: Batch # counter not restarted (' + B.env.docProps[bnoKey(B)] + ')');
  ok([2, 4].every(no => JSON.stringify((no === 2 ? before2 : before4).map(ser)) === JSON.stringify(purRow(B, no).map(ser))), 'single: lower-purity rows untouched cell for cell');
  ok(refNos() === ref0 && refIds(B).join() === 'R-20261018', 'single: no refining batch added');
  const sale = s.sales.find(x => x.batch === 'DS-1');
  const grams = 2 / 2, est = Math.round(8250 * 0.998 * grams * 100) / 100;
  ok(sale && sale.grams === grams && sale.estValue === est && sale.cost === 8000 && sale.actual === est && sale.profit === Math.round((est - 8000) * 100) / 100, 'single: value = base × purity × grams, cost has no fee (' + JSON.stringify(sale) + ')');
  ok(Math.abs((s.month.realizedProfit - m0.month.realizedProfit) - sale.profit) < 0.02, 'single: monthly realized profit rose by the sale profit only (' + (s.month.realizedProfit - m0.month.realizedProfit) + ')');
  const arc = arcRows(B).find(r => Number(r[0]) === 1);
  ok(arc && arc[2] === 2 && Math.abs(Number(arc[4]) - 0.998) < 1e-12 && arc[6] === 8000 && arc[10] === 'Sold' && (arc[12] === '' || arc[12] == null) && String(arc[14]) === 'DS-1', 'single: archive keeps weight, purity, cost; sold amount blank; id DS-1');
  ok(s.dailySold['2026-11-17'] >= grams - 1e-6, 'single: purchase-day grams count as sold (' + s.dailySold['2026-11-17'] + ')');
  const sheet = saleRows(B).filter(r => String(r[8]) === 'DS-1');
  ok(sheet.length === 1, 'single: one Sales row');
}

// ===== 3) group, including 100%, actual amount override, sale month
{
  const B = boot(); seed(B);
  const m0 = B.st().realizedMonths.slice();
  const r = sell(B, { nos: [5, 1], sellDate: '2026-10-15', sellBase: 8000, actualAmt: 30000 });
  ok(r.ok && r.saleId === 'DS-1.5', 'group: id is sorted Nos (' + (r.saleId || r.error) + ')');
  const s = B.st();
  ok(s.stock.map(x => x.no).join() === '2,3,4' && s.stock.map(x => x.bno).join() === '2,3,4', 'group: #2 #3 #4 stay, Batch # not renumbered');
  const sale = s.sales.find(x => x.batch === 'DS-1.5');
  const grams = 2 / 2 + 4 / 2, est = Math.round((8000 * 0.998 * 1 + 8000 * 1 * 2) * 100) / 100;
  ok(sale && Math.abs(sale.grams - grams) < 1e-9 && sale.estValue === est && sale.cost === 24000 && sale.actual === 30000 && sale.profit === 6000 && sale.date === '2026-10-15', 'group: est value uses each purity, received is the typed amount (' + JSON.stringify(sale) + ')');
  const before = m => (m0.find(x => x.month === m) || { profit: 0 }).profit;
  const after = m => (s.realizedMonths.find(x => x.month === m) || { profit: 0 }).profit;
  ok(Math.abs((after('2026-10') - before('2026-10')) - 6000) < 0.02 && Math.abs(after('2026-11') - before('2026-11')) < 0.02, 'group: profit sits in the sell month (October), not the purchase month');
  ok(refIds(B).join() === 'R-20261018', 'group: refining register unchanged');
}

// ===== 4) amount only (no base): allowed, est value blank, no fee
{
  const B = boot(); seed(B);
  const r = sell(B, { nos: [3], sellBase: '', actualAmt: 20000 });
  ok(r.ok && r.saleId === 'DS-3', 'amount only: recorded (' + (r.message || r.error) + ')');
  const sale = B.st().sales.find(x => x.batch === 'DS-3');
  ok(sale && (sale.base == null || sale.base === '') && (sale.estValue == null || sale.estValue === '') && sale.cost === 12500 && sale.actual === 20000 && sale.profit === 7500, 'amount only: cost is the purchase cost, profit = received − cost (' + JSON.stringify(sale) + ')');
}

// ===== 5) rejections write nothing and leave no receipt
{
  const B = boot(); seed(B); const s0 = snap(B);
  const cases = [
    [{ nos: [] }, /at least one/i],
    [{ nos: [1, 1] }, /listed twice/],
    [{ nos: [1, 'x'] }, /not an item number/],
    [{ nos: { a: 1 } }, /must be a list/],
    [{ nos: [4] }, /below 99\.8%/],
    [{ nos: [2, 1] }, /below 99\.8%/],
    [{ nos: [1, 9] }, /no longer In stock/],
    [{ nos: [1], sellBase: '', actualAmt: '' }, /sell base|amount received/i]
  ];
  cases.forEach((c, i) => {
    const r = sell(B, Object.assign({ rid: 'bad-' + i }, c[0]));
    ok(!r.ok && c[1].test(r.error || '') && /Nothing was sold/.test(r.error || ''), 'refused ' + JSON.stringify(c[0]) + ' (' + r.error + ')');
  });
  ok(snap(B).pur === s0.pur && snap(B).sales === s0.sales && snap(B).arc === s0.arc && snap(B).ref === s0.ref, 'refusals wrote nothing');
  ok(logRids(B, /^bad-/).length === 0, 'refusals leave no receipt');
  ok(B.st().stock.length === 5, 'refusals: all five still In stock');
}

// ===== 6) 0.997999 is not treated as 99.8%; 0.998 and 1 are
{
  const B = boot(); seed(B);
  const show = B.st().stock.find(x => x.no === 4);
  const shown = (Number(show.purity) * 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  ok(shown === '99.80' || shown === '99.8', '0.997999 displays as ' + shown + ' (the trap)');
  const r = sell(B, { nos: [4] });
  ok(!r.ok && /99\.7999%|below 99\.8%/.test(r.error) && B.st().stock.some(x => x.no === 4), 'displayed-as-99.8 but actually 0.997999 is refused');
  ok(sell(B, { nos: [1] }).ok && sell(B, { nos: [5] }).ok, 'exact 0.998 and 1.0 are eligible');
}

// ===== 7) stale / duplicate sheet rows: no partial sale
{
  const B = boot(); seed(B);
  ok(B.post({ action: 'deletePurchase', rid: 'del3', no: 3 }).ok, 'setup: #3 deleted on another device');
  const s0 = snap(B);
  const r = sell(B, { nos: [1, 3] });
  ok(!r.ok && /No\. 3 is no longer In stock/.test(r.error) && /Nothing was sold/.test(r.error), 'stale member refuses the whole group (' + r.error + ')');
  ok(snap(B).pur === s0.pur && snap(B).sales === s0.sales && B.st().stock.some(x => x.no === 1), 'stale: #1 still In stock, nothing written');
  const P = B.env.sheets.Purchases; const free = P.d.findIndex((row, i) => i > 0 && row.every(x => x === '' || x === null));
  P.d[free][0] = 1; P.d[free][1] = new Date(2026, 10, 17); P.d[free][2] = 1; P.d[free][4] = 0.998; P.d[free][6] = 1000; P.d[free][10] = 'In stock';
  const r2 = sell(B, { nos: [1] });
  ok(!r2.ok && /more than one Purchases row/.test(r2.error), 'duplicate No. refused (' + r2.error + ')');
  ok(saleRows(B).length === 0, 'duplicate No.: no Sales row');
}

// ===== 8) retry, cache eviction, already-recorded identity
{
  const B = boot(); seed(B);
  const r = B.post({ action: 'sellStock', rid: 'same', nos: [1], sellDate: '2026-11-18', sellBase: 8250 });
  ok(r.ok, 'setup sale');
  const again = B.post({ action: 'sellStock', rid: 'same', nos: [1], sellDate: '2026-11-18', sellBase: 8250 });
  ok(again.ok && again.duplicate === true && saleRows(B).filter(x => String(x[8]) === 'DS-1').length === 1, 'same rid is a duplicate, one Sales row');
  for (const k of Object.keys(B.env.cache)) delete B.env.cache[k];
  const again2 = B.post({ action: 'sellStock', rid: 'same', nos: [1], sellDate: '2026-11-18', sellBase: 8250 });
  ok(again2.ok && again2.duplicate === true && saleRows(B).filter(x => String(x[8]) === 'DS-1').length === 1, 'retry after cache eviction is served from ApiLog');
  const other = sell(B, { nos: [1] });
  ok(other.ok && /already recorded/.test(other.message) && saleRows(B).filter(x => String(x[8]) === 'DS-1').length === 1, 'a new rid for the same finished sale does not write again');
}

// ===== 9) a failed delete rolls back; no partial sale
{
  const B = boot(); seed(B); const s0 = snap(B);
  B.env.sheets.Purchases.deleteRows = () => { throw new Error('disk full'); };
  const r = sell(B, { rid: 'roll', nos: [1, 5] });
  ok(!r.ok && /Nothing was sold/.test(r.error), 'delete failure refuses (' + r.error + ')');
  const s1 = snap(B);
  ok(s1.pur === s0.pur && s1.sales === s0.sales && s1.arc === s0.arc && s1.ref === s0.ref, 'delete failure: Purchases, Sales, Archive and Refining unchanged');
  ok(logRids(B, /^roll/).length === 0, 'rolled-back sale leaves no receipt');
  ok(B.st().stock.length === 5, 'rolled-back sale: all five still In stock');
}

// ===== 10) partial sale, then refine: fee only on the refine, DS rows kept, undo still works
{
  const B = boot(); seed(B);
  ok(sell(B, { nos: [1] }).ok, 'setup: sell #1');
  const r = B.post({ action: 'batchRefine', rid: 'rf', batchId: 'R-AFTER', pickNos: [2, 4] });
  ok(r.ok, 'refine leftovers #2 and #4 (' + (r.message || r.error) + ')');
  const s = B.st();
  ok(s.stock.map(x => [x.no, x.bno]).join() === '3,5,3,5' || s.stock.map(x => x.no).join() === '3,5', 'after refine: #3 and #5 still In stock (' + JSON.stringify(s.stock.map(x => [x.no, x.bno])) + ')');
  ok(s.stock.map(x => x.bno).join() === '3,5', 'after refine: their Batch # was not renumbered');
  const batch = s.batches.find(b => b.id === 'R-AFTER');
  ok(batch && Math.abs(batch.costInclFee - (4000 + 3000 + 20000)) < 0.02, 'refine fee is charged once on the batch, not on the direct sale (' + (batch && batch.costInclFee) + ')');
  const ids = new Set(arcRows(B).map(r => String(r[14])));
  ok(ids.has('DS-1') && ids.has('R-AFTER'), 'Archive keeps the direct sale and the new batch (' + [...ids].join() + ')');
  const ds = arcRows(B).find(r => String(r[14]) === 'DS-1');
  ok(ds && ds[2] === 2 && Math.abs(Number(ds[4]) - 0.998) < 1e-12 && ds[6] === 8000, 'direct-sale archive row still has the original weight, purity and cost');
  const sale = saleRows(B).find(r => String(r[8]) === 'DS-1');
  ok(sale && sale[4] === 8000, 'direct-sale cost was not rewritten with a fee');
  const u = B.post({ action: 'undoLastBatch', rid: 'un', batchId: 'R-AFTER', items: 2 });
  ok(u.ok && u.shift === 0, 'undo of the later batch does not renumber (' + (u.message || u.error) + ')');
  const s2 = B.st();
  ok(s2.stock.map(x => x.no).sort((a, b) => a - b).join() === '2,3,4,5', 'undo restored the refined items, not the direct sale');
  ok(arcRows(B).some(r => String(r[14]) === 'DS-1' && Number(r[0]) === 1), 'undo left the direct-sale archive row');
  ok(saleRows(B).some(r => String(r[8]) === 'DS-1'), 'undo left the direct-sale Sales row');
}

// ===== 11) selling every In stock item does not restart Batch #
{
  const B = boot();
  B.add({ weightBhy: 2, purity: 0.998, cost: 1000 });
  B.add({ weightBhy: 2, purity: 0.998, cost: 1000 });
  ok(sell(B, { nos: [1, 2] }).ok && B.st().stock.length === 0, 'sell all: stock empty');
  ok(B.env.docProps[bnoKey(B)] !== '0', 'sell all: counter was not reset to 0 (' + B.env.docProps[bnoKey(B)] + ')');
  const nxt = B.add({ weightBhy: 1, purity: 0.9, cost: 500 });
  ok(nxt.bno === 3, 'next purchase continues at Batch #3, not #1 (got #' + nxt.bno + ')');
}

// ===== 12) direct sale and a refined-batch sale do not collide; DS- cannot be a batch id
{
  const B = boot(); seed(B);
  ok(sell(B, { nos: [5] }).ok, 'setup direct sale');
  const bad = B.post({ action: 'batchRefine', rid: 'dsb', batchId: 'DS-5', pickNos: [2] });
  ok(!bad.ok && /reserved for direct sales/.test(bad.error) && B.st().stock.some(x => x.no === 2), 'batch id DS-5 refused, #2 still In stock (' + bad.error + ')');
  const rec = B.post({ action: 'recordBatchSale', rid: 'rbs', batchId: 'R-20261018', sellDate: '2026-11-18', sellBase: 8250 });
  ok(rec.ok, 'existing refined batch can still be sold (' + (rec.message || rec.error) + ')');
  const rows = saleRows(B);
  const ds = rows.find(r => String(r[8]) === 'DS-5');
  const batch = rows.find(r => String(r[8]) === 'R-20261018');
  ok(ds && ds[4] === 16000 && batch && batch[4] !== ds[4], 'batch sale did not overwrite the direct sale; batch cost includes its fee (' + (batch && batch[4]) + ')');
  ok(B.st().batches.find(b => b.id === 'R-20261018').status === 'Sold', 'refined batch still sells as one batch');
}

// ===== 13) runs under the lock; a v50 sheet rejects the action and writes nothing
{
  const B = boot(); seed(B);
  let under = false; const orig = B.env.sheets.Sales.getRange;
  B.env.sheets.Sales.getRange = function () { if (B.env.g.__lockHeld) under = true; return orig.apply(this, arguments); };
  sell(B, { nos: [1] });
  ok(under === true, 'direct sale writes under the document lock');
  const O = boot(V50); O.add({ weightBhy: 2, purity: 0.998, cost: 8000 });
  const s0 = snap(O);
  const r = O.post({ action: 'sellStock', rid: 'old', nos: [1], sellDate: '2026-11-18', sellBase: 8250 });
  ok(!r.ok && /Unknown action/.test(r.error) && snap(O).pur === s0.pur && snap(O).sales === s0.sales, 'v50 sheet: unknown action, nothing written (' + r.error + ')');
  ok(O.post({ action: 'ping' }).directSale !== true && O.post({ action: 'ping' }).version === 50, 'v50 ping has no directSale flag');
}

// ===== 14) a group of refined batches stays on the Refining register until the sale is recorded,
// and a direct sale of unrefined 99.8% stock does not create a refining batch
{
  const B = boot();
  B.add({ weightBhy: 2, purity: 0.9, cost: 4000 });
  B.add({ weightBhy: 2, purity: 0.998, cost: 8000 });
  const made = B.post({ action: 'batchRefine', rid: 'mk', batchId: 'R-KEEP', pickNos: [1] });
  ok(made.ok && made.batchId === 'R-KEEP', 'setup: refined #1 into R-KEEP (' + (made.message || made.error) + ')');
  const reg = () => B.env.sheets.Refining.d.slice(18).map(r => String(r[12] || '')).filter(Boolean);
  const items = id => B.env.sheets.Refining.d.slice(18).filter(r => r[0] === id).map(r => Number(r[2]));
  const before = reg().slice().sort();
  ok(before.indexOf('R-20261018') >= 0 && before.indexOf('R-KEEP') >= 0, 'both batches are on the Refining register');
  const open = B.st().batches.filter(b => b.status === 'Refining').map(b => b.id).sort();
  ok(open.indexOf('R-KEEP') >= 0 && open.indexOf('R-20261018') >= 0, 'both are unsold on getState');
  const mixed = B.post({ action: 'sellBatches', rid: 'mix', batchIds: ['R-KEEP', 'R-MISSING'], sellDate: '2026-11-18', sellBase: 8250 });
  ok(!mixed.ok && /not on the Refining tab/.test(mixed.error) && /Nothing was sold/.test(mixed.error), 'missing batch refuses the whole group (' + mixed.error + ')');
  ok(B.st().batches.find(b => b.id === 'R-KEEP').status === 'Refining', 'refused group: R-KEEP is still unsold');
  ok(JSON.stringify(reg().slice().sort()) === JSON.stringify(before), 'refused group: register ids unchanged');
  const dup = B.post({ action: 'sellBatches', rid: 'dup', batchIds: ['R-KEEP', 'R-KEEP'], sellDate: '2026-11-18', sellBase: 8250 });
  ok(!dup.ok && /listed twice/.test(dup.error) && B.st().batches.find(b => b.id === 'R-KEEP').status === 'Refining', 'duplicate batch id refused, nothing sold');
  const sold = B.post({ action: 'sellBatches', rid: 'grp', batchIds: ['R-20261018', 'R-KEEP'], sellDate: '2026-11-18', sellBase: 8250 });
  ok(sold.ok && sold.batchIds && sold.batchIds.join() === 'R-20261018,R-KEEP', 'group sale recorded (' + (sold.message || sold.error) + ')');
  ok(JSON.stringify(reg().slice().sort()) === JSON.stringify(before), 'recorded group: the Refining register still has the same batches (rows were not removed)');
  ok(items('R-KEEP').join() === '1', 'R-KEEP item rows are still on the Refining tab');
  const st = B.st();
  ok(st.batches.filter(b => b.id === 'R-KEEP' || b.id === 'R-20261018').every(b => b.status === 'Sold'), 'both batches are Sold only after the sale is recorded');
  const keep = st.batches.find(b => b.id === 'R-KEEP');
  ok(keep && keep.costInclFee > 4000, 'refined-batch cost still includes its refining fee (' + (keep && keep.costInclFee) + ')');
  ok(st.stock.some(x => x.no === 2 && Math.abs(x.purity - 0.998) < 1e-9), 'the unrefined 99.8% purchase is still In stock, not on a batch');
  const ds = sell(B, { nos: [2] });
  ok(ds.ok && ds.saleId === 'DS-2', 'direct sale of that purchase (' + (ds.message || ds.error) + ')');
  ok(reg().indexOf('DS-2') < 0 && JSON.stringify(reg().slice().sort()) === JSON.stringify(before), 'direct sale did not fabricate a Refining batch');
  const again = B.post({ action: 'sellBatches', rid: 'grp' , batchIds: ['R-KEEP'], sellDate: '2026-11-18', sellBase: 1 });
  ok(again.ok && again.duplicate === true && reg().filter(id => id === 'R-KEEP').length === 1, 'same rid replays and does not write the batch twice');
}

console.log(`\nSUMMARY v51 ${n - fails} passed, ${fails} failed, of ${n}`);
process.exit(fails ? 1 : 0);
