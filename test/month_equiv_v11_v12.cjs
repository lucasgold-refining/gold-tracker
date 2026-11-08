// Blast radius: v11 goldApiMonth_ vs v12 goldApiMonthPack_.month on the same rows.
// Example figures only. Also counts sheet reads inside the v12 month build.
const fs = require('fs'), vm = require('vm'), path = require('path');
const v11src = fs.readFileSync('/home/ubuntu/.cursor/projects/workspace/uploads/Api_284c.gs', 'utf8');
const v12src = fs.readFileSync(path.join(__dirname, '..', 'sheet/Api.gs'), 'utf8');
const base = {
  SALES: { sheet: 'Sales', firstDataRow: 11, batchCol: 9 },
  ARCHIVE_TOTALS: { sheet: 'Archive Totals', firstDataRow: 2, headers: new Array(16), cols: { buyMonth: 3, soldMonth: 4, cost: 8, realized: 14, maxNo: 15 } },
  round2_: x => Math.round(x * 100) / 100,
  TZ: 'Asia/Manila'
};
function load(src, todayYm) {
  const sandbox = Object.assign({ console }, base, {
    Utilities: { formatDate: (d, tz, fmt) => fmt === 'yyyy-MM' ? todayYm : 'unused' }
  });
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'Api.gs' });
  return sandbox;
}
const blankRow = n => Array.from({ length: n }, () => '');
function salesSheet(summary, dataRows) {
  const rows = Array.from({ length: 10 }, () => blankRow(9));
  Object.entries(summary || {}).forEach(([m, cell]) => {
    const mo = +m, idx = (mo <= 6 ? 3 + mo : mo - 3) - 1, col = mo <= 6 ? 1 : 6;
    rows[idx][col] = cell.value;
    if (cell.trapH != null) rows[idx][7] = cell.trapH;
  });
  (dataRows || []).forEach(r => {
    const row = blankRow(9);
    row[0] = r.date; row[4] = r.cost == null ? '' : r.cost; row[5] = r.actual == null ? '' : r.actual; row[7] = r.profit == null ? '' : r.profit;
    rows.push(row);
  });
  return rows;
}
const item = (date, cost, sold, profit) => { const r = blankRow(14); r[1] = date || ''; r[6] = cost == null ? '' : cost; r[11] = sold || ''; r[13] = profit == null ? '' : profit; return r; };
const totRow = (buy, sold, cost, profit) => { const r = blankRow(14); r[2] = buy || ''; r[3] = sold || ''; r[7] = cost == null ? '' : cost; r[13] = profit == null ? '' : profit; return r; };
function dash(rows) {
  const vals = [['', '', '', 'Month', 'Purchases cost', 'Sales received (new Sales entries)', 'Realized profit']];
  rows.forEach(r => vals.push(['', '', '', r.date, r.cost, '', r.profit]));
  vals.push(['', '', '', 'Total', 0, 0, 0]);
  return { last: vals.length, vals };
}
function run(today, sales, pur, arc, tot, dashObj) {
  const a = load(v11src, today), b = load(v12src, today);
  const C11 = { sheet: n => (n === 'Sales' ? (sales ? {} : null) : (n === 'Dashboard' && dashObj ? {} : null)), rows: n => n === 'Sales' ? sales : [], dash: dashObj || null };
  const reads = { sales: 0, dashRange: 0 };
  const C12 = {
    sheet(n) {
      if (n === 'Sales') return sales ? {} : null;
      if (n === 'Dashboard') return dashObj ? { getLastRow: () => dashObj.last, getMaxColumns: () => 12, getRange: () => ({ getValues: () => { reads.dashRange++; return dashObj.vals; } }) } : null;
      return null;
    },
    rows(n) { if (n === 'Sales') { reads.sales++; return sales; } return []; }
  };
  const oldM = a.goldApiMonth_(C11, pur, arc, tot);
  const pack = b.goldApiMonthPack_(C12, pur, arc, tot);
  return { oldM, pack, reads };
}
const fails = [];
const check = (c, m) => { if (!c) fails.push(m); console.log((c ? 'PASS ' : 'FAIL ') + m); };
function sameMonth(label, today, sales, pur, arc, tot, dashObj) {
  const { oldM, pack, reads } = run(today, sales, pur, arc, tot, dashObj);
  const neu = pack.month;
  const fields = ['ym', 'name', 'realizedProfit', 'purchasesCost', 'from'];
  fields.forEach(k => check(JSON.stringify(oldM[k]) === JSON.stringify(neu[k]), label + ' month.' + k + ' v11=' + JSON.stringify(oldM[k]) + ' v12=' + JSON.stringify(neu[k])));
  const hit = pack.realizedMonths.find(r => r.month === neu.ym);
  check(!!hit && hit.profit === neu.realizedProfit, label + ' series current profit equals month.realizedProfit');
  check(reads.sales <= 1 && reads.dashRange <= 1, label + ' reads sales=' + reads.sales + ' dash=' + reads.dashRange);
  return { oldM, pack, reads };
}

// 1. 2026 compilation only, summary column H must not be added twice. Today November.
sameMonth('compilation', '2026-11', salesSheet({ 1: { value: 1000, trapH: 5000 }, 11: { value: 40 } }, []), [], [], [], null);

// 2. Sales across the year boundary, blank H = received − cost, plus items, archive, archive totals.
sameMonth('mixed', '2026-03',
  salesSheet({ 1: { value: 1000 }, 3: { value: 20 } }, [
    { date: '2025-12-31', profit: 10 },
    { date: '2026-01-01', profit: 50 },
    { date: '2026-01-20', cost: 30, actual: 80 },
    { date: '2026-03-04', profit: -4 },
    { date: 'not-a-date', profit: 888 }
  ]),
  [item('2026-01-05', 80, '2026-03-02', 7), item('2026-03-01', 5, '', null)],
  [item('2025-11-02', 40, '2026-03-15', -2)],
  [totRow('2026-01-01', '2026-03-01', 15, 3)],
  null);

// 3. Dashboard cell replaces the computed current month, including a zero profit.
sameMonth('override', '2026-01',
  salesSheet({ 1: { value: 1000 } }, [{ date: '2026-01-02', profit: 50 }]),
  [item('2026-01-01', 80, '2026-01-08', 25)], [], [],
  dash([{ date: '2026-01-01', cost: 1, profit: 999 }, { date: '2026-02-01', cost: 0, profit: 0 }]));

// 4. Empty sheets. Current month still zero / computed.
sameMonth('empty', '2026-08', null, [], [], [], null);

// 5. Several years. Compilation stays on 2026, not on the 2025 or 2027 current-style months.
sameMonth('years', '2027-02',
  salesSheet({ 2: { value: 300 } }, [
    { date: '2025-12-15', profit: 8 },
    { date: '2026-02-02', profit: 4 },
    { date: '2027-02-02', profit: -6 }
  ]),
  [item('2024-05-01', 12, '2024-06-01', 1.004), item('2024-06-02', 0, '2024-06-03', 1.004)],
  [], [totRow('2024-06-01', '2025-01-01', 9, -1.5)],
  null);

// 6. Today is not 2026, so the current month does not receive the compilation.
sameMonth('not2026', '2025-06', salesSheet({ 6: { value: 777 } }, [{ date: '2025-06-30', profit: 2 }]), [], [], [], null);

// 7. Second dashboard row for the same month must not change the current-month fields versus v11 (first row wins).
sameMonth('dup-row', '2026-11',
  salesSheet({}, [{ date: '2026-11-01', profit: 5 }]), [], [], [],
  dash([{ date: '2026-11-01', cost: 3, profit: 11 }, { date: '2026-11-01', cost: 99, profit: 77 }]));

const dup = run('2026-11', salesSheet({}, [{ date: '2026-11-01', profit: 5 }]), [], [], [], dash([{ date: '2026-11-01', cost: 3, profit: 11 }, { date: '2026-11-01', cost: 99, profit: 77 }]));
check(dup.pack.month.realizedProfit === 11 && dup.pack.month.purchasesCost === 3, 'duplicate dashboard month keeps the first row in the series too (' + JSON.stringify(dup.pack.month) + ')');

if (fails.length) { console.log(fails.length + ' equivalence failures'); process.exit(1); }
console.log('equivalence ok');
