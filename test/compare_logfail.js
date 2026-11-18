const fs = require('fs'), vm = require('vm'), path = require('path');
const { build } = require('./mock');
function boot(sheetDir) {
  const env = build();
  const ctx = vm.createContext(Object.assign({ console }, env.g));
  for (const f of ['Code.gs', 'Api.gs']) {
    const p = f === 'Code.gs' && !fs.existsSync(path.join(sheetDir, f))
      ? '/workspace/gold-v49-work/sheet/Code.gs'
      : path.join(sheetDir, f);
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
  }
  ctx.setupGoldApi();
  const T = env.scriptProps.GOLD_API_TOKEN;
  const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ token: T }, o)) }, parameter: {} }).text);
  return { env, ctx, post };
}
function purchaseCount(env) {
  const sh = env.sheets.Purchases; let n = 0;
  for (let r = 2; r <= sh.getLastRow(); r++) if (sh.d[r-1][0] !== '' && sh.d[r-1][0] != null) n++;
  return n;
}
function run(label, sheetDir, expectOk, expectDup) {
  const { post, ctx, env } = boot(sheetDir);
  ctx.goldApiLogPut_ = function () { throw new Error('simulated log put failure'); };
  const r = post({ action: 'addPurchase', rid: 'rid-logfail', lite: true, date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875 });
  const n1 = purchaseCount(env);
  // restore and retry
  // (leave throwing? retry would still fail log on v15 if we leave it throwing — but cache should serve)
  const r2 = post({ action: 'addPurchase', rid: 'rid-logfail', lite: true, date: '2026-11-13', weightBhy: 2.5, purity: 0.871, cost: 8875 });
  const n2 = purchaseCount(env);
  const okWrite = r.ok === expectOk;
  const okDup = expectDup ? (n2 > n1) : (n2 === n1 && n1 === 1);
  console.log((okWrite && okDup ? 'PASS ' : 'FAIL ') + label + ': first ok=' + r.ok + ' n1=' + n1 + ' retry ok=' + r2.ok + ' dup=' + r2.duplicate + ' n2=' + n2);
  return okWrite && okDup;
}
const v14 = '/workspace/gold-v48-work/sheet';
const v15 = fs.existsSync('/workspace/gold-v49-work/sheet/Api.gs') ? '/workspace/gold-v49-work/sheet' : path.join(__dirname, '..', 'sheet');
let a = true;
if (fs.existsSync(path.join(v14, 'Api.gs'))) a = run('v14 log-fail duplicates', v14, false, true);
else console.log('SKIP v14 log-fail duplicates: /workspace/gold-v48-work/sheet was not in the v50 archive');
const b = run('v15 log-fail is success, no duplicate', v15, true, false);
process.exit(a && b ? 0 : 1);
