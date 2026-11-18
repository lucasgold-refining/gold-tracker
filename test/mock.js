// Fake SpreadsheetApp etc. for testing Code.gs + Api.gs in node. Formula columns are recomputed on every read.
const crypto = require('crypto');
const calls = { reads: 0, byName: 0, namedList: 0, bySheet: {}, ranges: [] };   // spreadsheet read counters (tests take deltas)
function a1ToRC(a1) { const m = a1.match(/^([A-Z]+)(\d+)$/); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return [Number(m[2]), c]; }
function makeSheet(name, rows, cols, recalc) {
  const s = { name, d: [], recalc: recalc || null, hidden: new Set(), f: {} };
  for (let i = 0; i < rows; i++) s.d.push(new Array(cols).fill(''));
  const ensureCols = (n) => { s.d.forEach(r => { while (r.length < n) r.push(''); }); };
  const rc = () => { if (s.recalc) s.recalc(s); };
  Object.assign(s, {
    getName: () => name,
    getLastRow() { rc(); for (let i = s.d.length - 1; i >= 0; i--) if (s.d[i].some(v => v !== '' && v !== null)) return i + 1; return 0; },
    getMaxRows: () => s.d.length, getMaxColumns: () => s.d[0].length,
    insertColumnsAfter(after, n) { s.d.forEach(r => r.splice(after, 0, ...new Array(n).fill(''))); },   // v7
    insertRowsAfter(after, n) { const w = s.d[0].length; for (let i = 0; i < n; i++) s.d.splice(after, 0, new Array(w).fill('')); },
    deleteRow(r) { if (s.d.length <= 1) throw new Error('cannot delete all rows'); s.d.splice(r - 1, 1); },
    deleteRows(r, n) { if (s.d.length - n < 1) throw new Error('cannot delete all rows'); s.d.splice(r - 1, n); },
    hideColumns(c) { s.hidden.add(c); }, showColumns() { s.hidden.clear(); }, getColumnWidth: () => 100, setColumnWidth() {},
    setFrozenRows() {},
    hideSheet() { s._hiddenTab = true; }, showSheet() { s._hiddenTab = false; }, isSheetHidden() { return !!s._hiddenTab; },
    setName(n) { s.name = n; }, getSheetId() { return s._sheetId || Math.abs(s.name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)); },
    getLastColumn() { rc(); let m = 0; s.d.forEach(r => { for (let i = r.length - 1; i >= 0; i--) if (r[i] !== '' && r[i] !== null) { if (i + 1 > m) m = i + 1; break; } }); return m; },
    copyTo(ss) { const n = s.name + ' copy'; const c = makeSheet(n, s.d.length, s.d[0].length, s.recalc); c.d = s.d.map(r => r.slice()); c.f = Object.assign({}, s.f); if (ss && ss._addSheet) ss._addSheet(n, c); return c; },
    getRange(r, c, nr, nc) {
      if (typeof r === 'string') { [r, c] = a1ToRC(r); nr = 1; nc = 1; }
      nr = nr || 1; nc = nc || 1;
      if (r + nr - 1 > s.d.length) throw new Error(`${name}: range row ${r + nr - 1} beyond max ${s.d.length}`);
      if (s.strictCols && c + nc - 1 > s.d[0].length) throw new Error(`${name}: range column ${c + nc - 1} beyond max ${s.d[0].length}`);   // v7: like Apps Script
      ensureCols(c + nc - 1);
      return {
        getValues() { calls.reads++; calls.bySheet[name] = (calls.bySheet[name] || 0) + 1; calls.ranges.push({ name, r, c, nr, nc }); rc(); const o = []; for (let i = 0; i < nr; i++) o.push(s.d[r - 1 + i].slice(c - 1, c - 1 + nc)); return o; },
        getValue() { calls.reads++; rc(); return s.d[r - 1][c - 1]; },
        getSheet: () => s, getRow: () => r, getColumn: () => c, getNumRows: () => nr, getNumColumns: () => nc,
        setValues(v) { if (v.length !== nr || v.some(x => x.length !== nc)) throw new Error(`${name}: setValues size mismatch`); v.forEach((row, i) => row.forEach((x, j) => s.d[r - 1 + i][c - 1 + j] = x)); },
        setValue(x) { s.d[r - 1][c - 1] = x; },
        getFormulas() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(s.f[(r + i) + ',' + (c + j)] || ''); o.push(row); } return o; },
        setFormula(x) { s.f[r + ',' + c] = x; },
        clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) s.d[r - 1 + i][c - 1 + j] = ''; },
        copyFormatToRange() {}, setNumberFormat() {}
      };
    }
  });
  return s;
}
const blank = v => v === '' || v === null;
function build(opts) {
  opts = opts || {};
  // Named ranges live on Settings B3:B15, like the real sheet.
  const named = { BasePrice: 8250, QuoteMargin: 0.01, RefiningFee: 20000, BHYPerGram: 2, SilverDivisor: 0.23, SilverMultiplier: 1.05, TroyOzGrams: 31.1034768, FullBaseMinPurity: 0.998, WeekdayAdjust: -200, WeekendAdjust: -200 };
  const POS = { BasePrice: 3, QuoteMargin: 4, RefiningFee: 5, BHYPerGram: 6, SilverDivisor: 7, SilverMultiplier: 8, TroyOzGrams: 9, FullBaseMinPurity: 10, WeekdayAdjust: 14, WeekendAdjust: 15 };
  const N = k => set.d[POS[k] - 1][1];
  const purRecalc = (s) => { for (let i = 1; i < s.d.length; i++) { const r = s.d[i]; const C = r[2], E = r[4], G = r[6];
    r[3] = blank(C) ? '' : C / N('BHYPerGram'); r[5] = (blank(C) || blank(E)) ? '' : C / N('BHYPerGram') * E;
    r[7] = (blank(C) || blank(E) || blank(G)) ? '' : G / (C / N('BHYPerGram') * E);
    const base = s.name === 'Archive' ? r[15] : N('BasePrice');
    r[8] = (blank(C) || blank(E) || blank(base)) ? '' : base * E * C / N('BHYPerGram');
    r[9] = (r[8] === '' || blank(G)) ? '' : r[8] - G;
    r[13] = (r[10] === 'Sold' && !blank(r[12]) && !blank(G)) ? r[12] - G : '';
    if (s.name === 'Archive' && s.f['1,19'] && r.length >= 19) r[18] = (blank(r[14]) || blank(r[17])) ? '' : r[14] + ' · #' + r[17]; }   // v8 S Batch item
    if (s.name === 'Archive' && s.f['1,19'] && s.d[0].length >= 19) s.d[0][18] = 'Batch item'; };
  const pur = makeSheet('Purchases', 120, 14, purRecalc);
  pur.d[0] = ['No.', 'Date', 'Weight (BHY)', 'Grams', 'Purity %', 'Pure grams', 'Cost (PHP)', 'Cost per pure gram', 'Projected sell price', 'Projected profit', 'Status', 'Sold date', 'Sold amount', 'Realized profit'];
  const ar = makeSheet('Archive', 600, 17, purRecalc);
  ar.d[0] = pur.d[0].concat(['Batch ID', 'Base / g (frozen)', 'Archived on']);
  for (let i = 1; i <= 403; i++) { const r = ar.d[i]; r[0] = i; r[2] = 1; r[4] = 0.9; r[6] = 3600; r[10] = 'Refined'; r[14] = 'R-20261018'; r[15] = 8250; r[16] = new Date(2026, 9, 18); }
  const ref = makeSheet('Refining', 1200, 29, (s) => {
    for (let i = 18; i < s.d.length; i++) { const r = s.d[i]; const D = r[3], E = r[4], F = r[5], G = r[6];
      r[7] = blank(D) ? '' : D / 2; r[8] = (blank(D) || blank(E)) ? '' : D / 2 * E; r[9] = (blank(D) || blank(E) || blank(G)) ? '' : D / 2 * E * G; r[10] = r[9] === '' || blank(F) ? '' : r[9] - F; }
    const items = s.d.slice(18).filter(r => !blank(r[0]));
    for (let i = 18; i < s.d.length; i++) { const r = s.d[i]; const id = r[12];
      if (blank(id)) { for (let k = 15; k <= 22; k++) r[k] = ''; r[26] = ''; r[27] = ''; continue; }
      const mine = items.filter(x => x[0] === id);
      const raw = mine.reduce((t, x) => t + x[7], 0), refg = mine.reduce((t, x) => t + x[8], 0);
      r[15] = mine.length; r[16] = raw; r[17] = refg; r[18] = raw ? refg / raw : 0; r[19] = mine.reduce((t, x) => t + x[5], 0) + N('RefiningFee');
      r[20] = mine.reduce((t, x) => t + x[9], 0); r[21] = r[20] - r[19];
      const full = N('FullBaseMinPurity') || 0.998, below = mine.filter(x => !(Number(x[4]) + 1e-9 >= full));
      const sRaw = below.reduce((t, x) => t + (Number(x[7]) || 0), 0), sRef = below.reduce((t, x) => t + (Number(x[8]) || 0), 0);
      r[22] = sRaw && sRef ? (sRef * (sRef / sRaw) / N('SilverDivisor')) * N('SilverMultiplier') - sRef : 0;
      r[26] = !blank(r[25]) ? r[25] : (!blank(r[24]) ? refg * r[24] : ''); r[27] = r[26] === '' ? '' : r[26] - r[19]; } });
  ref.d[17] = ['Batch', 'Batch date', 'Item No.', 'Weight (BHY)', 'Purity %', 'Cost (PHP)', 'Base / gram at close', 'Grams', 'Refined grams', 'Value', 'Profit', '', 'Batch', 'Batch date', 'Base', 'Items', 'Raw grams', 'Refined grams', 'Raw %', 'Cost incl. fee', 'Est. value', 'Est. profit', 'Silver', 'Sell date', 'Sell base / gram', 'Actual amount received', 'Actual value', 'Actual profit', 'Recorded in Sales'];
  // existing batch R-20261018 with 3 items (keeps the test small)
  const bd = new Date(2026, 9, 18, 10, 38);
  [[1, 5.15, 0.8535, 17716], [2, 0.15, 0.859, 519], [3, 0.55, 0.853, 1883]].forEach((x, i) => { ref.d[18 + i].splice(0, 7, 'R-20261018', bd, x[0], x[1], x[2], x[3], 8250); });
  ref.d[18].splice(12, 3, 'R-20261018', bd, 8250);
  const sales = makeSheet('Sales', 60, 9, (s) => { for (let i = 10; i < s.d.length; i++) { const r = s.d[i]; r[6] = (blank(r[3]) || blank(r[4])) ? '' : r[3] - r[4]; r[7] = (blank(r[5]) || blank(r[4])) ? '' : r[5] - r[4]; } });
  sales.d[0][0] = 'SALES 2026'; sales.d[9] = ['Date', 'Base price / gram', 'Grams sold', 'Est. value (PHP)', 'Cost (PHP)', 'Actual received (PHP)', 'Est. margin', 'Realized profit', 'Refining batch'];
  const set = makeSheet('Settings', 30, 3);
  set.d[2] = ['Base price per gram (PHP)', 8250, ''];
  Object.keys(POS).forEach(k => { set.d[POS[k] - 1][0] = set.d[POS[k] - 1][0] || k; set.d[POS[k] - 1][1] = named[k]; }); set.d[15][1] = 'goldprice.org, morning'; set.d[16][1] = '2026-10-16 close'; set.d[21][1] = '2026-10-18 06:27 (Manila)'; set.d[22][1] = 'OK';
  const dash = makeSheet('Dashboard', 30, 6, (s) => {
    const sum = (sh, col) => { sh.recalc && sh.recalc(sh); return sh.d.slice(1).reduce((t, r) => t + (typeof r[col] === 'number' ? r[col] : 0), 0); };
    const tot = sheets['Archive Totals'];
    const linked = /'Archive Totals'!H2:H/.test(s.f['5,2'] || '');
    s.d[1][1] = N('BasePrice'); s.d[4][1] = sum(pur, 6) + sum(ar, 6) + (linked && tot ? sum(tot, 7) : 0);
    sales.recalc(sales); s.d[18][1] = 15802500 + sales.d.slice(10).reduce((t, r) => t + (typeof r[7] === 'number' ? r[7] : 0), 0);
    const ins = pur.d.slice(1).filter(r => r[10] === 'In stock');
    const refg = ins.reduce((t, r) => t + r[5], 0), cost = ins.reduce((t, r) => t + r[6], 0);
    s.d[28][1] = refg * N('BasePrice') - cost - (ins.length ? N('RefiningFee') : 0); });
  dash.f['5,2'] = '=SUM(Purchases!G2:G)+SUM(Archive!G2:G)';
  dash.d[0][0] = 'Gold Tracker Dashboard'; dash.d[1][0] = 'Base price / gram (PHP)'; dash.d[4][0] = 'Total cash used (PHP)'; dash.d[18][0] = 'TOTAL REALIZED PROFIT (PHP)'; dash.d[28][0] = 'Est. refining profit (PHP)';
  const sheets = { Purchases: pur, Archive: ar, Refining: ref, Sales: sales, Settings: set, Dashboard: dash };
  const namedCells = { BasePrice: () => set.d[2][1] };
  const exportCtl = { calls: [] };
  const ss = { getSheetByName: n => sheets[n] || null, getId: () => 'SHEETID123', getName: () => 'Gold Tracker (Improved)',
    getRangeByName: n => { calls.byName++; return n in POS ? set.getRange(POS[n], 2) : null; },
    getNamedRanges: () => { calls.namedList++; return Object.keys(POS).map(n => ({ getName: () => n, getRange: () => set.getRange(POS[n], 2) })); },
    setActiveSheet() {}, toast() {},
    insertSheet(n) { if (opts.noInsert && n === 'Archive Totals') throw new Error('insertSheet not expected: ' + n);
      if (n !== 'Archive Totals' && n !== 'ApiLog' && opts.strictInsert) throw new Error('insertSheet not expected: ' + n);
      const cols = n === 'ApiLog' ? 5 : 15, rows = n === 'ApiLog' ? 400 : 300;
      return (sheets[n] = sheets[n] || makeSheet(n, rows, cols)); } };
  const scriptProps = {}; const docProps = {}; const cache = {}; const cacheTtl = {}; const logs = [];
  const pad = n => String(n).padStart(2, '0');
  const g = {
    SpreadsheetApp: { getActive: () => ss, flush() {}, getUi() { throw new Error('No UI in web app'); } },
    LockService: { getDocumentLock: () => { const l = { held: false, waitLock() { if (g.__lockHeld) throw new Error('nested lock (would deadlock?)'); g.__lockHeld = true; }, releaseLock() { g.__lockHeld = false; } }; return l; } },
    Utilities: { getUuid: () => crypto.randomUUID(), base64Encode: b => Buffer.from(b.map(x => x & 255)).toString('base64'), formatDate(d, tz, f) { const x = new Date(d.getTime() + (tz === 'UTC' ? 0 : 8 * 3600e3));
      const Y = x.getUTCFullYear(), M = pad(x.getUTCMonth() + 1), D = pad(x.getUTCDate()), h = pad(x.getUTCHours()), m = pad(x.getUTCMinutes()), s = pad(x.getUTCSeconds());
      return f.replace("'T'", 'T').replace('yyyy', Y).replace('MM', M).replace('dd', D).replace('HH', h).replace('mm', m).replace('ss', s).replace(/^u$/, String(x.getUTCDay() || 7)); } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => scriptProps[k] ?? null, setProperty: (k, v) => { scriptProps[k] = v; } }),
      getDocumentProperties: () => ({ getProperty: k => docProps[k] ?? null, setProperty: (k, v) => { docProps[k] = String(v); }, deleteProperty: k => { delete docProps[k]; } }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v, ttl) => { cache[k] = v; cacheTtl[k] = ttl; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/exec' }), getOAuthToken: () => 'oauth-fake-token',
      _triggers: [], getProjectTriggers: () => g.ScriptApp._triggers, newTrigger(fn) { g.ScriptApp._newTriggerCalls = (g.ScriptApp._newTriggerCalls || []).concat([fn]); const t = { fn, timeBased() { return this; }, everyDays() { return this; }, atHour() { return this; }, inTimezone() { return this; }, create() { g.ScriptApp._triggers.push({ getHandlerFunction: () => fn }); return this; } }; return t; } },
    DriveApp: { getFileById: id => { if (exportCtl.noDrive) throw new Error('no Drive permission'); if (id !== ss.getId()) throw new Error('not found'); return { getName: () => ss.getName() }; } },
    Logger: { log: m => logs.push(m) },
    UrlFetchApp: { fetch(url, o) {
      const m = String(url).match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/]+)\/export\?format=xlsx$/);
      if (!m) throw new Error('no network in tests');
      exportCtl.calls.push({ url, auth: o && o.headers && o.headers.Authorization });
      const code = exportCtl.code || 200, bytes = exportCtl.bytes || Array.from(Buffer.from('PK\u0003\u0004' + 'x'.repeat(exportCtl.size || 4000))).map(b => b > 127 ? b - 256 : b);
      return { getResponseCode: () => code, getContent: () => code === 200 ? bytes : [] }; } }
  };
  return { g, sheets, named, scriptProps, docProps, exportCtl, cache, cacheTtl, logs, calls };
}
module.exports = { build };
