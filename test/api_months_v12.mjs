// Example rows only. These are not Iyam's figures.
// Checks goldApiMonthsFromRows_ (Api.gs v12) against the Dashboard month formula:
// 2026 compilation (Sales B4:B9 / G4:G9) + sales H from row 11 by sale date
// + Purchases/Archive N by sold date L + Archive Totals realized by sold month.
// The Dashboard cell replaces that sum when the month's row is present.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = readFileSync(path.join(root, 'sheet/Api.gs'), 'utf8');
const fails = [];
const check = (cond, msg) => { if (!cond) fails.push(msg); };

const sandbox = {
  console,
  SALES: { sheet: 'Sales', firstDataRow: 11, batchCol: 9 },
  ARCHIVE_TOTALS: { cols: { buyMonth: 3, soldMonth: 4, cost: 8, realized: 14 } },
  round2_: x => Math.round(x * 100) / 100,
  Utilities: { formatDate: () => '2026-11' },
  TZ: 'Asia/Manila'
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const months = (sales, pur, arc, tot, dash, today) => sandbox.goldApiMonthsFromRows_(sales, pur, arc, tot, dash, today || '2026-11');
const by = list => Object.fromEntries(list.map(r => [r.month, r]));
const blank = n => Array.from({ length: n }, () => []);
function salesSheet(summary, dataRows) {
  const rows = blank(10);
  Object.entries(summary || {}).forEach(([m, cell]) => {
    const mo = +m;
    const idx = (mo <= 6 ? 3 + mo : mo - 3) - 1;
    const col = mo <= 6 ? 1 : 6;
    rows[idx][col] = cell.value;
    if (cell.trapH != null) rows[idx][7] = cell.trapH;   // summary column H must NOT be added again
  });
  (dataRows || []).forEach(r => {
    const row = blank(1)[0];
    row[0] = r.date; row[4] = r.cost == null ? '' : r.cost; row[5] = r.actual == null ? '' : r.actual;
    row[7] = r.profit == null ? '' : r.profit;
    rows.push(row);
  });
  return rows;
}
const item = (date, cost, sold, profit) => {
  const r = blank(14);
  r[1] = date || ''; r[6] = cost == null ? '' : cost; r[11] = sold || ''; r[13] = profit == null ? '' : profit;
  return r;
};
const totRow = (buy, sold, cost, profit) => {
  const r = blank(14);
  r[2] = buy || ''; r[3] = sold || ''; r[7] = cost == null ? '' : cost; r[13] = profit == null ? '' : profit;
  return r;
};
function dash(rows) {
  const vals = [['', '', '', 'Month', 'Purchases cost', 'Sales received (new Sales entries)', 'Realized profit']];
  rows.forEach(r => vals.push(['', '', '', r.month + '-01', r.cost, '', r.profit]));
  vals.push(['', '', '', 'Total', 0, 0, 0]);
  return { last: vals.length, vals };
}

// Compilation only, and summary column H is not counted a second time.
{
  const list = months(salesSheet({ 1: { value: 1000, trapH: 5000 }, 7: { value: 700 } }, []), [], [], [], null, '2026-11');
  const m = by(list);
  check(m['2026-01'].profit === 1000 && m['2026-01'].from === 'computed', 'Jan compilation ' + JSON.stringify(m['2026-01']));
  check(m['2026-07'].profit === 700, 'Jul compilation ' + JSON.stringify(m['2026-07']));
  check(!m['2026-02'], 'zero compilation must not invent a month without the dashboard row');
  check(m['2026-11'].profit === 0 && m['2026-11'].from === 'computed', 'current month is present at zero');
}

// Sales add by sale date. 31 Dec and 1 Jan stay apart. Blank H uses actual − cost. Summary is not a sale row.
{
  const list = months(salesSheet(
    { 1: { value: 1000 } },
    [
      { date: '2025-12-31', profit: 10 },
      { date: '2026-01-01', profit: 50 },
      { date: '2026-01-20', cost: 30, actual: 80 },
      { date: 'not-a-date', profit: 888 }
    ]
  ), [], [], [], null, '2026-11');
  const m = by(list);
  check(m['2025-12'].profit === 10, 'Dec 2025 sale ' + JSON.stringify(m['2025-12']));
  check(m['2026-01'].profit === 1100, 'Jan is compilation 1000 + 50 + (80−30), got ' + m['2026-01'].profit);
  check(!Object.values(m).some(r => r.profit === 888), 'a non-date leaked into a month');
}

// Item and archive realized profit by sold date, cost by purchase date. A sale in the same month is added, not dropped:
// the sheet formula sums both columns. A batch register is not an input, so it cannot be counted twice.
{
  const pur = [item('2026-01-05', 80, '2026-03-02', 7), item('2026-03-01', 5, '2026-03-09', -2)];
  const arc = [item('2025-11-01', 40, '2026-03-15', 4)];
  const tot = [totRow('2026-01-01', '2026-04-01', 15, 3)];
  const list = months(salesSheet({}, [{ date: '2026-03-20', profit: 10 }, { date: '2026-04-02', profit: 3 }]), pur, arc, tot, null, '2026-11');
  const m = by(list);
  check(m['2026-01'].purchasesCost === 95 && m['2026-01'].profit === 0, 'Jan cost is purchases + archive totals, profit stays 0: ' + JSON.stringify(m['2026-01']));
  check(m['2025-11'].purchasesCost === 40 && (m['2025-11'].profit || 0) === 0, 'Nov 2025 cost only');
  check(m['2026-03'].profit === 19, 'March is items 7 + -2 + archive 4 + sale 10, got ' + m['2026-03'].profit);
  check(m['2026-03'].purchasesCost === 5, 'March cost is the purchase dated in March only');
  check(m['2026-04'].profit === 6, 'April is archive-totals 3 + sale 3, got ' + m['2026-04'].profit);
}

// A 2027 month does not receive the 2026 compilation.
{
  const list = months(salesSheet({ 1: { value: 1000 } }, [{ date: '2027-01-04', profit: 5 }]), [], [], [], null, '2027-01');
  const m = by(list);
  check(m['2026-01'].profit === 1000, '2026 compilation remains on Jan 2026');
  check(m['2027-01'].profit === 5, '2027 sale is only the sale');
}

// Dashboard cells replace the computed sum, including a zero, and still equal the current month.
{
  const sales = salesSheet({ 1: { value: 1000 } }, [{ date: '2026-01-02', profit: 50 }, { date: '2026-11-03', profit: 12 }]);
  const table = dash([
    { month: '2026-01', cost: 1, profit: 999 },
    { month: '2026-02', cost: 0, profit: 0 },
    { month: '2026-11', cost: 4, profit: 12 }
  ]);
  const list = months(sales, [item('2026-01-01', 80, '2026-01-08', 25)], [], [], table, '2026-11');
  const m = by(list);
  check(m['2026-01'].profit === 999 && m['2026-01'].from === 'dashboard', 'dashboard cell replaces compilation + sale + item');
  check(m['2026-01'].purchasesCost === 1, 'dashboard cost replaces the item cost');
  check(m['2026-02'].profit === 0 && m['2026-02'].from === 'dashboard', 'dashboard zero month is kept');
  check(m['2026-11'].profit === 12 && m['2026-11'].purchasesCost === 4, 'current month equals its dashboard row');
  const cur = list.find(r => r.month === '2026-11');
  check(cur.profit === m['2026-11'].profit, 'list current month is the card figure');
}

// No dashboard table: current month with no rows is still on the list at zero, and negatives net.
{
  const list = months(salesSheet({}, [{ date: '2026-05-01', profit: 100 }, { date: '2026-05-20', profit: -40 }]), [item('', '', '2026-05-02', -7)], [], [], null, '2026-08');
  const m = by(list);
  check(m['2026-05'].profit === 53, 'May nets 100 − 40 − 7, got ' + m['2026-05'].profit);
  check(m['2026-08'].profit === 0, 'empty current month is zero, not missing');
}

// Two cents that need one round at the end, same round2_ as Code.gs.
{
  const list = months(salesSheet({}, [{ date: '2026-06-01', profit: 1.004 }, { date: '2026-06-02', profit: 1.004 }]), [], [], [], null, '2026-06');
  check(by(list)['2026-06'].profit === 2.01, 'sum then round ' + by(list)['2026-06'].profit);
}

if (fails.length) {
  console.error(fails.map(f => 'FAIL ' + f).join('\n'));
  process.exit(1);
}
console.log('PASS api months v12 (' + fails.length + ' fails)');
