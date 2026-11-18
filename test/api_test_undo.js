// Api.gs v13 + Code.gs v11: undoLastBatch (must still pass). Run with TZ=Asia/Manila.
const fs = require('fs'), vm = require('vm'), path = require('path');
const { build } = require('./mock');
const dir = path.join(__dirname, '..', 'sheet');
let fails = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
function boot() {
  const env = build(); const ctx = vm.createContext(Object.assign({ console }, env.g));
  for (const f of ['Code.gs', 'Api.gs']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  ctx.setupGoldApi(); const T = env.scriptProps.GOLD_API_TOKEN;
  const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: T }, o)) }, parameter: {} }).text);
  // v53: state reads use the POST body. A token on the URL is refused.
  const get = p => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: T }, p)) }, parameter: {} }).text);
  env.sheets.Archive.d.splice(1);
  return { env, ctx, post, get };
}
const pad = x => String(x).padStart(2, '0');
const manila = d => { const x = new Date(d.getTime() + 8 * 3600e3); return x.getUTCFullYear() + '-' + pad(x.getUTCMonth() + 1) + '-' + pad(x.getUTCDate()); };
const today = manila(new Date()), dayB = manila(new Date(Date.now() - 2 * 86400e3));
let k = 0; const rid = () => 'v11-' + (++k);
const ser = v => Object.prototype.toString.call(v) === '[object Date]' ? 'D' + v.getTime() : v;
function setup() {
  const B = boot(), { post, get, env, ctx } = B;
  ctx.setupBatchNumbers_();
  const add = o => { const r = post(Object.assign({ action: 'addPurchase', rid: rid(), weightBhy: 2, purity: 0.9, cost: 7000, lite: true, date: today, at: new Date(Date.now() - 600000).toISOString() }, o)); if (!r.ok) throw new Error(r.error); return r; };
  B.add = add;
  B.st = () => get({ action: 'getState' }).state;
  B.purSnap = () => env.sheets.Purchases.d.slice(1).filter(r => r[0] !== '' && r[0] != null).map(r => [0, 1, 2, 4, 6, 10, 11, 12, 14, 15, 16].map(i => ser(r[i])).join('|'));
  B.stockSnap = s => JSON.stringify((s || B.st()).stock.map(x => [x.no, x.bno, x.date, x.at, x.qid, x.weightBhy, x.purity, x.cost]));
  B.refSnap = () => JSON.stringify(env.sheets.Refining.d.slice(18).map(r => r.slice(0, 7).concat(r.slice(12, 15), r.slice(23, 26), r.slice(29, 31)).map(ser)));
  B.arcSnap = () => JSON.stringify(env.sheets.Archive.d.slice(1).filter(r => r[0] !== '').map(r => r.map(ser)));
  B.dash = () => { const D = env.sheets.Dashboard; D.recalc(D); return [D.d[4][1], D.d[18][1], D.d[28][1]]; };
  return B;
}

// ===== A) batch -> buy new -> undo -> exact state; then batch again
{
  const B = setup(), { post, add, st, env } = B;
  const Q = 'q-grp1';
  add({ date: dayB, at: '', weightBhy: 5.15, purity: 0.8535, cost: 17716 });
  [1, 2, 3].forEach(i => add({ qid: Q, weightBhy: i, purity: 0.9 + i / 100, cost: 3000 * i }));
  add({ weightBhy: 0.55, purity: 0.853, cost: 1883 });
  const s0 = st(), P0 = B.purSnap(), S0 = B.stockSnap(s0), R0 = B.refSnap(), A0 = B.arcSnap(), D0 = B.dash();
  const nos0 = s0.stock.map(x => x.no), bno0 = s0.stock.map(x => x.bno);
  ok(bno0.join() === '1,2,3,4,5', 'before: Batch # 1..5 (' + bno0 + ')');
  const b = post({ action: 'batchRefine', rid: rid(), expectNos: nos0 });
  ok(b.ok, 'batch made ' + b.batchId);
  const id = b.batchId;
  // buy new items after the batch (one group of 2 + a single)
  const n1 = add({ qid: 'q-grp2', weightBhy: 1.1, purity: 0.88, cost: 3500 }), n2 = add({ qid: 'q-grp2', weightBhy: 1.2, purity: 0.87, cost: 3600 }), n3 = add({ weightBhy: 0.4, purity: 0.75, cost: 900 });
  const s1 = st();
  ok(s1.stock.map(x => x.bno).join() === '1,2,3', 'newer items got Batch # 1..3');
  const newerBefore = s1.stock.map(x => ({ no: x.no, date: x.date, at: x.at, qid: x.qid, w: x.weightBhy, p: x.purity, c: x.cost }));
  // refused: wrong id, not newest, sold, item count changed
  let r = post({ action: 'undoLastBatch', rid: rid(), batchId: 'R-NOPE' });
  ok(!r.ok && /not on the sheet/.test(r.error), 'unknown batch refused: ' + r.error);
  r = post({ action: 'undoLastBatch', rid: rid(), batchId: 'R-20261018' });
  ok(!r.ok && /not the newest/.test(r.error), 'older batch refused: ' + r.error);
  r = post({ action: 'undoLastBatch', rid: rid(), batchId: id, items: 9 });
  ok(!r.ok && /changed since/.test(r.error), 'item count mismatch refused');
  ok(B.refSnap() !== R0 && st().stock.length === 3, 'refusals changed nothing');
  const U = rid();
  r = post({ action: 'undoLastBatch', rid: U, batchId: id, items: 5 });
  ok(r.ok, 'undo: ' + (r.message || r.error));
  ok(r.restored === 5 && r.newer === 3 && r.shift === 5, 'answer restored 5, newer 3, shift 5');
  const s2 = st();
  ok(s2.stock.length === 8, '8 In stock now');
  ok(s2.stock.map(x => x.no).join() === nos0.concat([n1.no, n2.no, n3.no]).join(), 'item No.s unchanged, order by No. (' + s2.stock.map(x => x.no) + ')');
  ok(new Set(s2.stock.map(x => x.no)).size === 8 && new Set(s2.stock.map(x => x.bno)).size === 8, 'no duplicate No. or Batch #');
  ok(s2.stock.map(x => x.bno).join() === '1,2,3,4,5,6,7,8', 'Batch #: restored keep 1..5, newer 6..8 (gap-free)');
  ok(JSON.stringify(s2.stock.slice(0, 5).map(x => [x.no, x.bno, x.date, x.at, x.qid, x.weightBhy, x.purity, x.cost])) === S0, 'restored items exactly as before batching (No, #, date, time, group, weight, purity, cost)');
  ok(B.purSnap().slice(0, 5).join('\n') === P0.join('\n'), 'Purchases rows of restored items identical cell by cell');
  ok(JSON.stringify(s2.stock.slice(5).map(x => ({ no: x.no, date: x.date, at: x.at, qid: x.qid, w: x.weightBhy, p: x.purity, c: x.cost }))) === JSON.stringify(newerBefore), 'newer items untouched (No, date, time, group, weight, purity, cost)');
  ok(s2.stock.filter(x => x.qid === Q).length === 3 && s2.stock.filter(x => x.qid === 'q-grp2').length === 2, 'Bought together groups intact');
  ok(B.refSnap() === R0, 'Refining items + register exactly as before the batch');
  ok(B.arcSnap() === A0, 'Archive exactly as before the batch');
  ok(!(s2.batches || []).some(x => x.id === id), 'batch gone from getState');
  const costSum = s2.stock.reduce((t, x) => t + x.cost, 0);
  ok(Math.abs(costSum - (s0.stock.reduce((t, x) => t + x.cost, 0) + 3500 + 3600 + 900)) < 0.005, 'In stock cost = before + newer, counted once');
  const D2 = B.dash();
  ok(Math.abs(D2[0] - (D0[0] + 8000)) < 0.01, 'Dashboard cash used = before + newer only (no double count)');
  ok(env.docProps.batchNoLast === '8', 'Batch # counter now 8 (' + env.docProps.batchNoLast + ')');
  // idempotent
  const again = post({ action: 'undoLastBatch', rid: U, batchId: id, items: 5 });
  ok(again.ok && again.duplicate && st().stock.length === 8, 'same request again: no second change');
  const again2 = post({ action: 'undoLastBatch', rid: rid(), batchId: id });
  ok(!again2.ok && st().stock.length === 8, 'new request for the undone batch refused (already undone)');
  // next purchase + batch again: same ID reused, no gap
  const n4 = add({ weightBhy: 0.3, purity: 0.8, cost: 700 });
  ok(st().stock.find(x => x.no === n4.no).bno === 9, 'next purchase gets Batch # 9');
  ok(n4.no === n3.no + 1, 'next item No. continues (' + n4.no + ')');
  const b2 = post({ action: 'batchRefine', rid: rid(), expectNos: st().stock.map(x => x.no) });
  ok(b2.ok && b2.batchId === id, 'batch again today reuses the ID ' + b2.batchId);
  const bs = st().batches; ok(bs.filter(x => x.id === id).length === 1 && bs[0].id === id && bs[0].items === 9, 'one batch with 9 items, no duplicate');
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(bs[0].at || ''), 'batches carry at (batch time): ' + bs[0].at);
  ok(env.docProps.batchNoLast === '0', 'counter reset after the new batch');
}
// ===== B) sold batch refused; add-from-stock item comes back; only-latest untouched
{
  const B = setup(), { post, add, st, env } = B;
  [1, 2].forEach(() => add({}));
  const b1 = post({ action: 'batchRefine', rid: rid(), batchId: 'R-A', expectNos: st().stock.map(x => x.no) });
  ok(b1.ok, 'R-A made');
  add({}); add({});
  const b2 = post({ action: 'batchRefine', rid: rid(), batchId: 'R-B', expectNos: st().stock.map(x => x.no) });
  const late = add({ weightBhy: 3 }), keep = add({ weightBhy: 4 });
  const at = post({ action: 'addToBatch', rid: rid(), batchId: 'R-B', nos: [late.no] });
  ok(at.ok, 'added one from stock to R-B');
  const refA = JSON.stringify(env.sheets.Refining.d.slice(18).filter(r => r[0] === 'R-A' || r[12] === 'R-A').map(r => r.map(ser)));
  const r = post({ action: 'undoLastBatch', rid: rid(), batchId: 'R-B', items: 3 });
  ok(r.ok && r.restored === 3, 'R-B undone with its added item: ' + (r.message || r.error));
  const s = st();
  ok(s.stock.length === 4, '4 In stock');
  ok(s.stock.some(x => x.no === late.no) && s.stock.some(x => x.no === keep.no), 'added-later item back, untouched newer one there');
  ok(s.stock.map(x => x.bno).join() === '1,2,3,4', 'Batch #s unique, gap-free: ' + s.stock.map(x => x.bno));
  ok(JSON.stringify(env.sheets.Refining.d.slice(18).filter(r => r[0] === 'R-A' || r[12] === 'R-A').map(r => r.map(ser))) === refA, 'R-A untouched');
  ok(s.batches.length === 2 && s.batches[0].id === 'R-A', 'R-A is now the newest');
  // sell R-A -> undo refused
  const sale = post({ action: 'recordBatchSale', rid: rid(), batchId: 'R-A', sellDate: today, sellBase: 8300 });
  ok(sale.ok, 'R-A sold');
  const snap = B.purSnap().join('\n');
  const r2 = post({ action: 'undoLastBatch', rid: rid(), batchId: 'R-A' });
  ok(!r2.ok && /sold/.test(r2.error), 'sold newest batch refused: ' + r2.error);
  ok(B.purSnap().join('\n') === snap, 'refusal changed nothing');
}
// ===== C) no batch at all
{
  const B = setup(); B.env.sheets.Refining.d.slice(18).forEach(r => r.fill(''));
  const r = B.post({ action: 'undoLastBatch', rid: rid(), batchId: 'R-X' });
  ok(!r.ok && /no refining batch/.test(r.error), 'no batch: ' + r.error);
}
console.log(`${n - fails}/${n} passed`); process.exit(fails ? 1 : 0);
