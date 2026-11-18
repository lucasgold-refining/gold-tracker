// Api.gs v50: batchRefine pickNos (choose items), Batch # after a partial refine, undo after a partial refine,
// legacy (no pickNos) identical to v15, pickRefine flag, batchPreview items. Run with TZ=Asia/Manila.
const fs = require('fs'), vm = require('vm'), path = require('path');
const { build } = require('./mock');
const SHEET = path.join(__dirname, '..', 'sheet');
const V15 = process.env.V15_API || path.join(__dirname, 'fixtures', 'Api-v15.gs');
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
  let k = 0; const rid = () => 'v50-' + (++k);
  const add = o => { const r = post(Object.assign({ action: 'addPurchase', rid: rid(), weightBhy: 2, purity: 0.9, cost: 7000, lite: true, date: '2026-11-17', at: '2026-11-17T10:00:00+08:00' }, o)); if (!r.ok) throw new Error(r.error); return r; };
  const st = () => get({ action: 'getState' }).state;
  return { env, ctx, post, get, add, st, rid };
}
// 5 items: #1..#5, purities chosen so one is 99.9% (no silver)
function seed(B) {
  [[2, 0.9, 7000], [1.5, 0.85, 5000], [3, 0.999, 12500], [0.8, 0.75, 2100], [2.2, 0.88, 7600]].forEach(x => B.add({ weightBhy: x[0], purity: x[1], cost: x[2] }));
}
const ser = (v, loose) => Object.prototype.toString.call(v) === '[object Date]' ? (loose ? 'D' : 'D' + v.getTime()) : v;
const rowsOf = (sh, loose) => JSON.stringify(sh.d.slice(1).filter(r => r.some(x => x !== '' && x !== null)).map(r => r.map(x => ser(x, loose))));
const snap = (B, loose) => ({
  pur: rowsOf(B.env.sheets.Purchases, loose), ref: rowsOf(B.env.sheets.Refining, loose), arc: rowsOf(B.env.sheets.Archive, loose),
  tot: B.env.sheets['Archive Totals'] ? rowsOf(B.env.sheets['Archive Totals'], loose) : '', bctr: B.env.docProps[Object.keys(B.env.docProps).find(k => /batch/i.test(k))]
});
const bnoKey = B => Object.keys(B.env.docProps).find(k => /batch/i.test(k));
const purRow = (B, no) => B.env.sheets.Purchases.d.slice(1).find(r => Number(r[0]) === no);
const refItems = (B, id) => B.env.sheets.Refining.d.slice(18).filter(r => r[0] === id).map(r => Number(r[2]));
const arcNos = B => B.env.sheets.Archive.d.slice(1).filter(r => r[0] !== '' && r[0] !== null).map(r => Number(r[0]));

// ===== 1) capability flag + batchPreview items
{
  const B = boot(); seed(B);
  const ping = B.post({ action: 'ping' });
  ok(ping.version === 51 && ping.receipts === true && ping.pickRefine === true, 'ping: version 50, receipts, pickRefine');
  const s = B.post({ action: 'getState' });
  ok(s.state.version === 51 && s.state.pickRefine === true, 'getState carries pickRefine');
  const gs = B.post({ action: 'getSettings' });
  ok(gs.pickRefine === true && gs.version === 51, 'getSettings carries pickRefine');
  const pv = B.post({ action: 'batchPreview' });
  ok(pv.ok && pv.pickRefine === true && pv.version === 51, 'batchPreview answer stamped (pickRefine)');
  const it = pv.preview.items || [];
  ok(it.length === 5 && it.map(x => x.no).join() === '1,2,3,4,5' && it.map(x => x.bno).join() === '1,2,3,4,5', 'batchPreview.items lists the 5 In stock items with No. and Batch #');
  ok(it[2].weightBhy === 3 && Math.abs(it[2].purity - 0.999) < 1e-9 && it[2].cost === 12500 && it[2].date === '2026-11-17', 'batchPreview item fields (weight, purity, cost, date)');
  ok(pv.preview.count === 5 && pv.preview.nos.join() === '1,2,3,4,5', 'batchPreview totals unchanged (count, nos)');
}

// ===== 2) legacy path (no pickNos) is identical to v15, sheet cell for cell
{
  const run = api => {
    const B = boot(api, { keepArchive: true }); seed(B);
    // one unnumbered In stock row typed on the sheet (legacy gives it a No.)
    const P = B.env.sheets.Purchases; const r = P.d[6]; r[1] = new Date(2026, 10, 16); r[2] = 1; r[4] = 0.8; r[6] = 3000; r[10] = 'In stock';
    const nos = B.st().stock.map(x => x.no).filter(x => x), nx = B.ctx.nextItemNo_();
    const bad = B.post({ action: 'batchRefine', rid: 'L-bad', expectNos: nos.slice(0, 3) });
    const good = B.post({ action: 'batchRefine', rid: 'L-1', batchId: 'R-TEST', expectNos: nos.concat([nx]) });
    const after = B.add({ weightBhy: 1, purity: 0.9, cost: 3000 });
    return { B, bad, good, after, S: snap(B, true) };
  };
  const a = run(V15), b = run();
  ok(a.bad.ok === false && b.bad.ok === false && a.bad.error === b.bad.error, 'legacy: expectNos mismatch refused the same way as v15 (' + b.bad.error + ')');
  ok(a.good.ok && b.good.ok && a.good.message === b.good.message, 'legacy: same answer as v15 (' + b.good.message + ')');
  ok(a.S.pur === b.S.pur, 'legacy: Purchases identical to v15');
  ok(a.S.ref === b.S.ref, 'legacy: Refining identical to v15');
  ok(a.S.arc === b.S.arc, 'legacy: Archive identical to v15 (older rows purged the same)');
  ok(a.S.tot === b.S.tot && b.S.tot.length > 2, 'legacy: Archive Totals identical to v15');
  ok(a.after.bno === 1 && b.after.bno === 1 && a.S.bctr === b.S.bctr, 'legacy: Batch # restarts at 1 after a full refine, as v15');
}

// ===== 3) pick a subset
{
  const B = boot(); seed(B);
  const before = { 1: purRow(B, 1).slice(), 3: purRow(B, 3).slice(), 5: purRow(B, 5).slice() };
  const r = B.post({ action: 'batchRefine', rid: 'P-1', batchId: 'R-PICK', pickNos: [4, 2] });
  ok(r.ok && r.batchId === 'R-PICK', 'subset: refined (' + (r.message || r.error) + ')');
  ok(/2 items/.test(r.message) && /3 items stay In stock/.test(r.message), 'subset: message says 2 refined, 3 stay');
  ok(refItems(B, 'R-PICK').join() === '2,4', 'subset: Refining has only #2 and #4');
  ok(arcNos(B).join() === '2,4', 'subset: Archive has only #2 and #4');
  const s = B.st();
  ok(s.stock.map(x => x.no).join() === '1,3,5' && s.stock.map(x => x.bno).join() === '1,3,5', 'subset: #1, #3, #5 still In stock with Batch # 1, 3, 5');
  ok([1, 3, 5].every(k => JSON.stringify(purRow(B, k).map(x => ser(x))) === JSON.stringify(before[k].map(x => ser(x)))), 'subset: leftover Purchases rows untouched (every cell)');
  const b = s.batches.find(x => x.id === 'R-PICK');
  ok(b && b.items === 2 && Math.abs(b.rawG - (1.5 + 0.8) / 2) < 1e-6, 'subset: batch has 2 items, raw g from #2 and #4 only');
  // batch numbers: continue after the highest given this round, no reuse
  ok(B.env.docProps[bnoKey(B)] === '5', 'subset: Batch # counter = 5 (highest this round)');
  const a6 = B.add({ weightBhy: 1, purity: 0.9, cost: 3000 });
  ok(a6.bno === 6, 'subset: next purchase is Batch #6, not #1 / #2 / #4 (got #' + a6.bno + ')');
  ok(B.st().nextBno === 7, 'subset: getState nextBno follows (7)');
  // same rid again: receipt, no second batch
  const again = B.post({ action: 'batchRefine', rid: 'P-1', batchId: 'R-PICK', pickNos: [4, 2] });
  ok(again.ok && again.duplicate === true && refItems(B, 'R-PICK').length === 2, 'subset: same rid retry is a duplicate, nothing written');
  for (const k of Object.keys(B.env.cache)) delete B.env.cache[k];
  const again2 = B.post({ action: 'batchRefine', rid: 'P-1', batchId: 'R-PICK', pickNos: [4, 2] });
  ok(again2.ok && again2.duplicate === true && B.st().stock.length === 4, 'subset: retry after cache eviction served from ApiLog, stock still 4');
}

// ===== 4) pick all via pickNos = same end state as legacy
{
  const A = boot(); seed(A); const B = boot(); seed(B);
  const ra = A.post({ action: 'batchRefine', rid: 'X', batchId: 'R-ALL', expectNos: [1, 2, 3, 4, 5] });
  const rb = B.post({ action: 'batchRefine', rid: 'X', batchId: 'R-ALL', pickNos: [1, 2, 3, 4, 5] });
  ok(ra.ok && rb.ok && ra.message === rb.message, 'pick all: same message as legacy (' + rb.message + ')');
  const sa = snap(A, true), sb = snap(B, true);
  ok(sa.pur === sb.pur && sa.ref === sb.ref && sa.arc === sb.arc, 'pick all: Purchases / Refining / Archive same as legacy');
  ok(sb.bctr === '0' && B.add({}).bno === 1, 'pick all: Batch # restarts at 1');
}

// ===== 5) pick none / bad lists are refused, nothing written
{
  const B = boot(); seed(B); const s0 = snap(B);
  const e1 = B.post({ action: 'batchRefine', rid: 'N-1', pickNos: [] });
  ok(!e1.ok && /Pick at least one/.test(e1.error), 'pick none refused (' + e1.error + ')');
  const e2 = B.post({ action: 'batchRefine', rid: 'N-2', pickNos: [2, 'abc'] });
  ok(!e2.ok && /not an item number/.test(e2.error), 'bad No. refused (' + e2.error + ')');
  const e3 = B.post({ action: 'batchRefine', rid: 'N-3', pickNos: { a: 1 } });
  ok(!e3.ok && /must be a list/.test(e3.error), 'non-list refused');
  const s1 = snap(B);
  ok(s0.pur === s1.pur && s0.ref === s1.ref && s0.arc === s1.arc && s0.bctr === s1.bctr, 'nothing written by refused picks');
  const log = B.env.sheets.ApiLog ? B.env.sheets.ApiLog.d.slice(1).filter(r => /^N-/.test(r[0])) : [];
  ok(log.length === 0, 'refused picks leave no receipt (a fixed retry can still run)');
}

// ===== 6) picked item vanished (deleted elsewhere) / refined elsewhere / duplicate No.
{
  const B = boot(); seed(B);
  ok(B.post({ action: 'deletePurchase', rid: 'D-3', no: 3 }).ok, 'setup: #3 deleted on another device');
  const s0 = snap(B);
  const e = B.post({ action: 'batchRefine', rid: 'V-1', pickNos: [2, 3] });
  ok(!e.ok && /No\. 3 is no longer In stock/.test(e.error) && /Nothing was refined/.test(e.error), 'vanished pick refused (' + e.error + ')');
  const s1 = snap(B);
  ok(s0.pur === s1.pur && s0.ref === s1.ref && s0.arc === s1.arc && s0.bctr === s1.bctr, 'vanished pick: nothing written');
  // two missing
  const e2 = B.post({ action: 'batchRefine', rid: 'V-2', pickNos: [3, 9] });
  ok(!e2.ok && /Items No\. 3, 9 are no longer In stock/.test(e2.error), 'two missing listed (' + e2.error + ')');
  // already refined in another batch
  ok(B.post({ action: 'batchRefine', rid: 'V-3', batchId: 'R-A', pickNos: [1] }).ok, 'setup: #1 refined in R-A');
  const e3 = B.post({ action: 'batchRefine', rid: 'V-4', batchId: 'R-B', pickNos: [1, 2] });
  ok(!e3.ok && /No\. 1 is no longer In stock/.test(e3.error) && refItems(B, 'R-B').length === 0, 'already-refined pick refused, R-B not created');
  // duplicate No. on two rows
  const P = B.env.sheets.Purchases; const free = P.d.findIndex((r, i) => i > 0 && r.every(x => x === '' || x === null));
  P.d[free][0] = 2; P.d[free][1] = new Date(2026, 10, 17); P.d[free][2] = 1; P.d[free][4] = 0.9; P.d[free][6] = 3000; P.d[free][10] = 'In stock';
  const e4 = B.post({ action: 'batchRefine', rid: 'V-5', pickNos: [2] });
  ok(!e4.ok && /more than one Purchases row/.test(e4.error), 'duplicate No. refused (' + e4.error + ')');
}

// ===== 7) unnumbered In stock row: pick mode leaves it alone; legacy numbers it
{
  const B = boot(); seed(B);
  const P = B.env.sheets.Purchases; const r = P.d[6]; r[1] = new Date(2026, 10, 16); r[2] = 1; r[4] = 0.8; r[6] = 3000; r[10] = 'In stock';
  const res = B.post({ action: 'batchRefine', rid: 'U-1', pickNos: [1, 2, 3, 4, 5] });
  ok(res.ok && /1 item stays In stock/.test(res.message), 'pick all numbered: the unnumbered row stays (' + res.message + ')');
  const left = P.d.slice(1).filter(x => x.some(v => v !== '' && v !== null));
  ok(left.length === 1 && left[0][0] === '' && left[0][10] === 'In stock' && left[0][2] === 1 && left[0][6] === 3000, 'unnumbered row untouched (still no No., In stock)');
  const s = B.st();
  ok(s.stock.length === 1 && s.stock[0].no === null, 'getState: one In stock item without a No.');
  ok(B.env.docProps[bnoKey(B)] === '5', 'counter kept at 5 while something is left');
}

// ===== 8) Batch # over several partial refines, a delete, then a full refine
{
  const B = boot(); seed(B);
  B.post({ action: 'batchRefine', rid: 'S-1', batchId: 'R-1', pickNos: [5] });   // highest refined, leftovers 1..4
  ok(B.env.docProps[bnoKey(B)] === '5' && B.add({}).bno === 6, 'refining the highest #5 still does not reuse 5 (next #6)');
  ok(B.post({ action: 'deletePurchase', rid: 'S-del', no: 6 }).ok, 'delete #6');
  const a7 = B.add({});
  ok(a7.bno === 7, 'after deleting #6 the next is Batch #7 (no reuse; item No. ' + a7.no + ')');
  const r2 = B.post({ action: 'batchRefine', rid: 'S-2', batchId: 'R-2', pickNos: [1, a7.no] });
  ok(r2.ok, 'second partial refine ok (' + (r2.message || r2.error) + ')');
  const s = B.st();
  ok(s.stock.map(x => x.bno).join() === '2,3,4', 'second partial (' + JSON.stringify(s.stock.map(x => [x.no, x.bno])) + '): #2, #3, #4 keep their numbers');
  ok(B.add({}).bno === 8, 'second partial: next is #8');
  const rest = B.st().stock.map(x => x.no);
  B.post({ action: 'batchRefine', rid: 'S-3', batchId: 'R-3', pickNos: rest });
  ok(B.st().stock.length === 0 && B.env.docProps[bnoKey(B)] === '0', 'refining everything left resets the counter');
  ok(B.add({}).bno === 1, 'after the stock is empty, Batch # starts at 1 again');
  // Archive keeps only the newest batch (older rows moved to totals)
  const ids = new Set(B.env.sheets.Archive.d.slice(1).filter(r => r[0] !== '').map(r => r[14]));
  ok(ids.size === 1 && ids.has('R-3'), 'Archive keeps only the newest batch rows after each refine');
}

// ===== 9) undo after a partial refine: nobody is renumbered
{
  const B = boot(); seed(B);
  B.post({ action: 'batchRefine', rid: 'UN-1', batchId: 'R-U', pickNos: [2, 4] });
  const a6 = B.add({});
  const u = B.post({ action: 'undoLastBatch', rid: 'UN-2', batchId: 'R-U', items: 2 });
  ok(u.ok && u.restored === 2 && u.shift === 0 && !/now ha/.test(u.message), 'undo partial: 2 back, no renumbering (' + u.message + ')');
  const s = B.st();
  ok(s.stock.map(x => x.no).join() === '1,2,3,4,5,6' && s.stock.map(x => x.bno).join() === '1,2,3,4,5,6', 'undo partial: Batch # 1..6 unchanged, in No. order');
  ok(B.add({}).bno === 7 && a6.bno === 6, 'undo partial: next purchase #7');
}

// ===== 10) undo after a full refine still renumbers clashing newer items (v15 rule)
{
  const B = boot(); seed(B);
  B.post({ action: 'batchRefine', rid: 'UF-1', batchId: 'R-F', expectNos: [1, 2, 3, 4, 5] });
  B.add({}); B.add({});
  const u = B.post({ action: 'undoLastBatch', rid: 'UF-2', batchId: 'R-F', items: 5 });
  ok(u.ok && u.shift === 5, 'undo full: newer items move after #5 (' + u.message + ')');
  ok(B.st().stock.map(x => x.bno).join() === '1,2,3,4,5,6,7' && B.add({}).bno === 8, 'undo full: 1..7 then #8');
}

// ===== 11) the pick runs under the document lock, and an old (v15) server ignores pickNos but refuses via expectNos
{
  const B = boot(); seed(B);
  let underLock = null; const orig = B.ctx.archiveRows_;
  B.ctx.archiveRows_ = function () { underLock = !!B.env.g.__lockHeld; return orig.apply(this, arguments); };
  B.post({ action: 'batchRefine', rid: 'LK', pickNos: [1] });
  ok(underLock === true, 'pick refine writes under the document lock');
  const O = boot(V15); seed(O); const s0 = snap(O);
  const r = O.post({ action: 'batchRefine', rid: 'OLD', pickNos: [2], expectNos: [2] });
  const s1 = snap(O);
  ok(!r.ok && /Stock changed/.test(r.error) && s0.pur === s1.pur && s0.ref === s1.ref, 'v15 server + v50 app (pickNos + expectNos subset): refused, nothing refined');
}

console.log(`\nSUMMARY v50 ${n - fails} passed, ${fails} failed, of ${n}`);
process.exit(fails ? 1 : 0);
