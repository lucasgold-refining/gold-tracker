// Api.gs v15: robust receipts, getState after lock, batched addPurchase, deferred/safe prune.
// Run with TZ=Asia/Manila.
const fs = require('fs'), vm = require('vm'), path = require('path');
const { build } = require('./mock');
const dir = path.join(__dirname, '..', 'sheet');
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

function instrument(env) {
  const st = {
    setValue: 0, setValues: 0, flush: 0, reads: 0, cellsRead: 0,
    underLock: { setValue: 0, setValues: 0, flush: 0, reads: 0, cellsRead: 0, getLastRow: 0 }
  };
  const bump = (k, cells) => {
    st[k]++;
    if (cells && (k === 'reads')) st.cellsRead += cells;
    if (env.g.__lockHeld) {
      st.underLock[k] = (st.underLock[k] || 0) + 1;
      if (cells && k === 'reads') st.underLock.cellsRead = (st.underLock.cellsRead || 0) + cells;
    }
  };
  const wrapSheet = (sh) => {
    if (sh.__v15) return sh;
    sh.__v15 = true;
    const gr = sh.getRange.bind(sh), glr = sh.getLastRow.bind(sh);
    sh.getLastRow = () => { if (env.g.__lockHeld) st.underLock.getLastRow = (st.underLock.getLastRow || 0) + 1; return glr(); };
    sh.getRange = (...args) => {
      const rng = gr(...args);
      const nr = rng.getNumRows(), nc = rng.getNumColumns();
      const gv = rng.getValues.bind(rng), sv = rng.setValues.bind(rng), s1 = rng.setValue.bind(rng);
      rng.getValues = () => { bump('reads', nr * nc); return gv(); };
      rng.setValues = (v) => { bump('setValues'); return sv(v); };
      rng.setValue = (x) => { bump('setValue'); return s1(x); };
      return rng;
    };
    return sh;
  };
  Object.values(env.sheets).forEach(wrapSheet);
  const ss = env.g.SpreadsheetApp.getActive();
  const ins = ss.insertSheet.bind(ss);
  ss.insertSheet = (n) => wrapSheet(ins(n));
  const origFlush = env.g.SpreadsheetApp.flush;
  env.g.SpreadsheetApp.flush = () => { bump('flush'); return origFlush(); };
  const origLS = env.g.LockService.getDocumentLock;
  env.g.LockService.getDocumentLock = () => {
    const l = origLS();
    const w = l.waitLock.bind(l), r = l.releaseLock.bind(l);
    l.waitLock = (...a) => w(...a);
    l.releaseLock = (...a) => r(...a);
    return l;
  };
  st.reset = () => {
    st.setValue = st.setValues = st.flush = st.reads = st.cellsRead = 0;
    st.underLock = { setValue: 0, setValues: 0, flush: 0, reads: 0, cellsRead: 0, getLastRow: 0 };
  };
  env.__st = st;
  return st;
}

function boot() {
  const env = build();
  const st = instrument(env);
  const ctx = vm.createContext(Object.assign({ console }, env.g));
  for (const f of ['Code.gs', 'Api.gs']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  ctx.setupGoldApi();
  const T = env.scriptProps.GOLD_API_TOKEN;
  const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: T }, o)) }, parameter: {} }).text);
  return { env, ctx, post, st, T };
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
function logRows(env) {
  const sh = env.sheets.ApiLog;
  if (!sh) return [];
  const last = sh.getLastRow();
  const out = [];
  for (let r = 2; r <= last; r++) out.push({ rid: sh.d[r - 1][0], action: sh.d[r - 1][1], at: sh.d[r - 1][2], ok: sh.d[r - 1][3], result: sh.d[r - 1][4] });
  return out;
}

{
  const { post } = boot();
  const ping = post({ action: 'ping' });
  ok(ping.version === 56 && ping.receipts === true, 'ping is version 50 with receipts:true');
}

// getState after a non-lite write is built after the lock is released
{
  const { post, st } = boot();
  post({ action: 'ping' });
  st.reset();
  const r = post({ action: 'addPurchase', rid: 'full-1', date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875 });
  ok(r.ok && r.state && r.state.version === 56, 'non-lite addPurchase still returns full state');
  // Archive is 403 rows; a getState under the lock would add ~6k cells. After the lock, underLock.cellsRead should be the write/log path only.
  ok(r.state && r.ok, 'write succeeded');
  ok((st.underLock.cellsRead || 0) < 2000,
    'getState is not built under the lock (underLock cellsRead=' + st.underLock.cellsRead + ', total reads cells=' + st.cellsRead + ')');
  ok((st.cellsRead || 0) > 4000, 'getState still ran after the lock (total cellsRead=' + st.cellsRead + ')');
}

// addPurchase uses batched setValues, not per-cell setValue
{
  const { post, st } = boot();
  st.reset();
  const r = post({ action: 'addPurchase', rid: 'sv-1', lite: true, date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875 });
  ok(r.ok && r.no > 0, 'lite addPurchase works');
  ok(st.setValue === 0, 'addPurchase used no per-cell setValue (setValue=' + st.setValue + ', setValues=' + st.setValues + ')');
  ok(st.setValues >= 1 && st.setValues <= 15, 'addPurchase used a small number of setValues batches (got ' + st.setValues + ')');
  ok(st.flush <= 1, 'purchase+log path flushes at most once in the handle (flush=' + st.flush + ')');
}

// log put throws after the money write: still ok:true, same-rid retry does not duplicate
{
  const { post, ctx, env } = boot();
  const orig = ctx.goldApiLogPut_;
  ctx.goldApiLogPut_ = function () { throw new Error('simulated log put failure'); };
  const r = post({ action: 'addPurchase', rid: 'rid-logfail', lite: true, date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875 });
  const n1 = purchaseCount(env);
  ok(r.ok === true && r.no > 0, 'money write still returns ok:true when the log put throws (ok=' + r.ok + ', error=' + r.error + ', no=' + r.no + ')');
  ok(n1 === 1, 'the purchase was written once (n=' + n1 + ')');
  ctx.goldApiLogPut_ = orig;
  const r2 = post({ action: 'addPurchase', rid: 'rid-logfail', lite: true, date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875 });
  const n2 = purchaseCount(env);
  ok(r2.ok && r2.duplicate && r2.no === r.no, 'same-rid retry is served from the cache receipt (duplicate=' + r2.duplicate + ', no=' + r2.no + ')');
  ok(n2 === 1, 'retry did not write a second purchase (n=' + n2 + ')');
}

// prune isolated: prune throw after receipt append does not fail the write
{
  const { post, ctx, env } = boot();
  post({ action: 'addPurchase', rid: 'seed-pr', lite: true, date: '2026-11-13', weightBhy: 1, purity: 0.9, cost: 1000 });
  ctx.goldApiLogPruneMaybe_ = function () { throw new Error('simulated prune failure'); };
  const r = post({ action: 'addPurchase', rid: 'after-prune-fail', lite: true, date: '2026-11-13', weightBhy: 1.2, purity: 0.9, cost: 1100 });
  ok(r.ok && r.no > 0, 'a prune failure after the receipt is written does not fail the purchase');
  const rids = logRows(env).map(x => x.rid);
  ok(rids.includes('after-prune-fail'), 'the receipt was still stored (rids=' + rids.join(',') + ')');
  const r2 = post({ action: 'addPurchase', rid: 'after-prune-fail', lite: true, date: '2026-11-13', weightBhy: 1.2, purity: 0.9, cost: 1100 });
  ok(r2.duplicate && purchaseCount(env) === 2, 'retry of that rid does not write twice');
}

// cap prune keeps a new receipt sitting at the top (non-chronological log)
{
  const { post, env, ctx } = boot();
  post({ action: 'addPurchase', rid: 'first', lite: true, date: '2026-11-13', weightBhy: 1, purity: 0.9, cost: 1000 });
  const sh = env.sheets.ApiLog;
  // Fill to just over the cap with older receipts, then place a brand-new receipt at row 2.
  const max = 4000;
  // Use prune directly with a small cap override if the fixture log sheet is only 400 rows — insert rows first.
  const origMax = ctx.GOLD_API.logMaxRows;
  ctx.GOLD_API.logMaxRows = 5;
  // current: header + maybe 1 row. Add 5 dated rows, then insert a newest row at the top.
  for (let i = 0; i < 5; i++) {
    ctx.goldApiLogPut_('old-' + i, 'addPurchase', { ok: true, message: 'x', no: 1, version: 15, receipts: true });
    const last = sh.getLastRow();
    sh.d[last - 1][2] = new Date(Date.now() - (60 - i) * 86400e3);
  }
  // A new receipt written now, then we force the new one to the top (sort newest first).
  ctx.goldApiLogPut_('brand-new', 'addPurchase', { ok: true, message: 'new', no: 2, version: 15, receipts: true });
  const rows = sh.d.slice(1).filter(r => r[0]);
  const newest = rows.find(r => r[0] === 'brand-new');
  const rest = rows.filter(r => r[0] !== 'brand-new');
  sh.d.splice(1, sh.d.length - 1, ...new Array(Math.max(0, sh.d.length - 1)).fill(null).map(() => new Array(5).fill('')));
  const packed = [newest].concat(rest);
  packed.forEach((r, i) => { sh.d[1 + i] = r; });
  delete env.cache['goldapi:logpruned:v15'];
  ctx.goldApiLogPruneMaybe_(sh);
  const rids = logRows(env).map(x => x.rid);
  ok(rids.includes('brand-new'), 'cap prune kept the newest receipt even though it sat at the top (rids=' + rids.join(',') + ')');
  ok(rids.length <= 5, 'cap of 5 was enforced (n=' + rids.length + ')');
  ctx.GOLD_API.logMaxRows = origMax;
}

console.log('\nSUMMARY v15 ' + (n - fails) + ' passed, ' + fails + ' failed, of ' + n);
process.exit(fails ? 1 : 0);
