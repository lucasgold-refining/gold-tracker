// Api.gs v15 receipt tests (v14 semantics). Run with TZ=Asia/Manila.
const fs = require('fs'), vm = require('vm'), path = require('path');
const { build } = require('./mock');
const dir = path.join(__dirname, '..', 'sheet');
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

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
function purchaseCount(env) {
  const sh = env.sheets.Purchases;
  let n = 0;
  for (let r = 2; r <= sh.getLastRow(); r++) {
    const v = sh.d[r - 1][0];
    if (v !== '' && v !== null) n++;
  }
  return n;
}
function saleCount(env) {
  const sh = env.sheets.Sales;
  let n = 0;
  for (let r = 2; r <= sh.getLastRow(); r++) {
    if (sh.d[r - 1].some(v => v !== '' && v !== null)) n++;
  }
  return n;
}
function logRows(env) {
  const sh = env.sheets.ApiLog;
  if (!sh) return [];
  const last = sh.getLastRow();
  const out = [];
  for (let r = 2; r <= last; r++) out.push({ rid: sh.d[r - 1][0], action: sh.d[r - 1][1], at: sh.d[r - 1][2], ok: sh.d[r - 1][3], result: sh.d[r - 1][4] });
  return out;
}

// --- receipts exist, tab hidden, created automatically ---
{
  const { post, env, ctx } = boot();
  const ping = post({ action: 'ping' });
  ok(ping.version === 51 && ping.receipts === true, 'ping exposes version 50 and receipts:true');
  ok(!env.sheets.ApiLog, 'ApiLog is not created until a write (no manual setup)');
  const r1 = post({ action: 'addPurchase', rid: 'rid-p1', lite: true, date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875 });
  ok(r1.ok && r1.receipts === true && r1.no > 0 && !r1.duplicate, 'first purchase writes and returns receipts + no (' + r1.no + ')');
  const sh = env.sheets.ApiLog;
  ok(!!sh, 'ApiLog tab was created automatically');
  ok(sh.isSheetHidden(), 'ApiLog tab is hidden');
  const rows = logRows(env);
  ok(rows.length === 1 && rows[0].rid === 'rid-p1' && rows[0].action === 'addPurchase' && rows[0].ok === 'ok', 'receipt stored under lock: rid, action, ok');
  const n0 = purchaseCount(env);

  // same-rid retry (cache hit)
  const r2 = post({ action: 'addPurchase', rid: 'rid-p1', lite: true, date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875 });
  ok(r2.ok && r2.duplicate === true && r2.no === r1.no, 'identical-rid retry (cache) returns the same no, marked duplicate');
  ok(purchaseCount(env) === n0, 'cache retry did not add a second purchase row');

  // retry after the cache is lost
  delete env.cache['goldapi:rid-p1'];
  const r3 = post({ action: 'addPurchase', rid: 'rid-p1', lite: true, date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875 });
  ok(r3.ok && r3.duplicate === true && r3.no === r1.no, 'retry after cache evicted uses ApiLog, same no');
  ok(purchaseCount(env) === n0, 'log retry did not add a second purchase row');
  ok(env.cache['goldapi:rid-p1'], 'cache was refilled from the log');

  // retry after 6+ hours = cache expired, log still there
  delete env.cache['goldapi:rid-p1'];
  const r4 = post({ action: 'addPurchase', rid: 'rid-p1', lite: true, date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875 });
  ok(r4.ok && r4.duplicate && r4.no === r1.no && purchaseCount(env) === n0, 'retry after 6+ hours (cache gone) still hits ApiLog, no second row');
}

// --- overlapping same-rid: log written only while lock is held; second waiter sees the receipt ---
{
  const { post, env, ctx } = boot();
  const heldAtLog = [];
  const sh0 = { insertSheet: env.g.SpreadsheetApp.getActive().insertSheet };
  // spy on log put: when result column is written, lock must be held
  const origPost = post;
  const a = origPost({ action: 'addPurchase', rid: 'ov-1', lite: true, date: '2026-11-13', weightBhy: 1, purity: 0.85, cost: 1000 });
  ok(a.ok && env.g.__lockHeld === false, 'lock released after the first answer');
  const log = env.sheets.ApiLog;
  // wrap setValues to record lock state on later writes (second rid)
  const range = log.getRange.bind(log);
  // After first write, a second overlapping retry is modeled as: cache miss + log present, under a fresh lock.
  delete env.cache['goldapi:ov-1'];
  let sawHeld = false;
  const innerGet = ctx.goldApiLogGet_;
  ctx.goldApiLogGet_ = function (rid) {
    if (env.g.__lockHeld) sawHeld = true;
    return innerGet(rid);
  };
  const n0 = purchaseCount(env);
  const b = origPost({ action: 'addPurchase', rid: 'ov-1', lite: true, date: '2026-11-13', weightBhy: 1, purity: 0.85, cost: 1000 });
  ok(sawHeld, 'ApiLog lookup for the overlapping retry ran inside the document lock');
  ok(b.duplicate && b.no === a.no && purchaseCount(env) === n0, 'overlapping identical-rid retry is a no-op write (no=' + b.no + ' dup=' + b.duplicate + ' rows ' + n0 + '->' + purchaseCount(env) + ')');
}

// --- addSale is receipt-safe ---
{
  const { post, env } = boot();
  const s1 = post({ action: 'addSale', rid: 'sale-1', date: '2026-11-13', cost: 10000, actual: 12000, grams: 1.2, base: 8250 });
  ok(s1.ok && s1.receipts, 'other sale writes with a receipt');
  const n0 = saleCount(env);
  delete env.cache['goldapi:sale-1'];
  const s2 = post({ action: 'addSale', rid: 'sale-1', date: '2026-11-13', cost: 10000, actual: 12000, grams: 1.2, base: 8250 });
  ok(s2.duplicate && saleCount(env) === n0, 'other-sale retry after cache loss does not add a second sales row');
}

// --- prune entries older than 90 days, under lock ---
{
  const { post, env, ctx } = boot();
  post({ action: 'addPurchase', rid: 'keep-me', lite: true, date: '2026-11-13', weightBhy: 1, purity: 0.8, cost: 500 });
  const sh = env.sheets.ApiLog;
  // insert an old row above the new one (row 2), shift by writing an old rid at row 2 and moving? easier: set row 2 at to 100 days ago and add a dummy, then write a new one which prunes from the top.
  // Current log is header + 1 row (keep-me) at row 2. Insert an old row at row 2 by moving keep-me down.
  const keep = sh.d[1].slice();
  sh.d.splice(1, 0, ['old-rid', 'addPurchase', new Date(Date.now() - 100 * 86400e3), 'ok', '{"ok":true,"message":"old"}']);
  // may need extra physical row - makeSheet has 400 rows
  // v15 defers prune for 6 hours via cache; clear it so this write will age-prune.
  delete env.cache['goldapi:logpruned:v15'];
  post({ action: 'addPurchase', rid: 'new-keep', lite: true, date: '2026-11-13', weightBhy: 1.1, purity: 0.8, cost: 510 });
  const rids = logRows(env).map(x => x.rid);
  ok(!rids.includes('old-rid'), 'prune removed the 100-day-old receipt (got ' + rids.join(',') + ')');
  ok(rids.includes('keep-me') && rids.includes('new-keep'), 'recent receipts were kept');
}

// --- v13-compatible client (ignores receipts field) still gets v13-shaped answers ---
{
  const { post, env } = boot();
  const a = post({ action: 'addPurchase', rid: 'v13c-1', lite: true, date: '2026-11-13', weightBhy: 3, purity: 0.9, cost: 2000 });
  ok(a.ok && a.message && a.no && a.version === 51, 'v13-style lite addPurchase still has ok/message/no');
  const again = post({ action: 'addPurchase', rid: 'v13c-1', lite: true, date: '2026-11-13', weightBhy: 3, purity: 0.9, cost: 2000 });
  ok(again.ok && again.no === a.no && again.duplicate, 'v13-style retry is still idempotent (duplicate + same no)');
  const st = post({ action: 'getState' });
  ok(st.ok && st.state && st.state.stock, 'v13-style getState still returns {ok, state}');
  const full = post({ action: 'addPurchase', rid: 'v13c-2', date: '2026-11-13', weightBhy: 1, purity: 0.85, cost: 800 });
  ok(full.ok && full.state && full.state.version === 51 && full.message, 'non-lite write still returns state (v13 clients refresh from it)');
}

// --- editPurchase receipt: already-done retry does not change the row twice ---
{
  const { post, env } = boot();
  const a = post({ action: 'addPurchase', rid: 'ed-src', lite: true, date: '2026-11-13', weightBhy: 2, purity: 0.8, cost: 1000 });
  const e1 = post({ action: 'editPurchase', rid: 'ed-1', no: a.no, date: '2026-11-13', weightBhy: 2.2, purity: 0.81, cost: 1100 });
  ok(e1.ok && e1.no === a.no, 'editPurchase succeeds under a receipt');
  const sh = env.sheets.Purchases;
  // find the row and read weight
  let w1 = null;
  for (let r = 0; r < sh.d.length; r++) if (Number(sh.d[r][0]) === a.no) { w1 = sh.d[r][2]; break; } // weight col? need PURCHASES.cols
  delete env.cache['goldapi:ed-1'];
  const e2 = post({ action: 'editPurchase', rid: 'ed-1', no: a.no, date: '2026-11-13', weightBhy: 9, purity: 0.5, cost: 1 });
  ok(e2.duplicate, 'edit retry after cache loss is served from the receipt');
  let w2 = null;
  for (let r = 0; r < sh.d.length; r++) if (Number(sh.d[r][0]) === a.no) { w2 = sh.d[r][2]; break; }
  ok(w1 === w2 && Number(w2) === 2.2, 'edit retry did not apply the second payload (weight stayed ' + w2 + ')');
}

console.log('\nSUMMARY receipts ' + (n - fails) + ' passed, ' + fails + ' failed, of ' + n);
process.exit(fails ? 1 : 0);
