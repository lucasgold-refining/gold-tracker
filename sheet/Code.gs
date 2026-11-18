/**
 * Gold Tracker (Improved) - Apps Script  (v56: a batch marked in column AM has no refining fee;
 *                                        v54: money rounding matches the phone, and purchase / sale / batch-sale
 *                                        share one body with Api.gs; v51: direct sales of already-99.8% stock keep
 *                                        their Archive rows, and DS- ids are reserved for them; v11: maintenance
 *                                        migrations + no daily base-price trigger on this live sheet)
 *
 * v54 (shared number with the app and Api.gs):
 *      round2_ uses the same half-away-from-zero rounding as the phone (1.005 -> 1.01, -1.005 -> -1.01).
 *      toPurity_ cuts a percent the way the phone does (85.356 -> 0.8535). A fraction already
 *      between 0 and 1 is kept, so 0.997999 still displays near 99.80% and is not sold as 99.8%.
 *      Numbers already stored on the sheet are not rewritten.
 *      addPurchase, addSale and syncBatchSales_ are the one copy. The menu still takes its own lock.
 *      A purchase from the menu is still written one cell at a time. The API passes a batched writer
 *      and does not take a second lock (a second waitLock would drop the outer one).
 *
 * v51 (shared number with the app and Api.gs; this file was v11 until now):
 *      A direct sale (Api.gs sellStock) moves the chosen Purchases rows to Archive with Batch ID DS-<item Nos>
 *      and does not create a refining batch. purgeOldArchiveRows_ keeps those DS- rows when a later batch is
 *      refined, so the original weight, purity and cost stay on Archive. Batch IDs starting with DS- cannot be
 *      used for a refining batch, and Record batch sale will not overwrite a Sales row that uses one.
 *
 * v11 (Iyam's live sheet only — do not paste this file into Chin's copy or the blank template):
 *      The "Install daily base-price update" menu item is gone. installDailyTrigger() refuses to
 *      create a trigger: the Gold Price Reports bot already sets the base, and a second 6pm write
 *      would overwrite it. "Update base price now" is unchanged.
 *      Gold Tracker > Maintenance holds Iyam-run, never-automatic tools, each with Preview / Apply
 *      (backup first) / Verify, like TzFix: archive the hidden TZ fix log off this workbook, and
 *      trim sold refining-batch item rows (register values are frozen first; unsold items stay).
 * v10: Every new purchase also keeps WHEN it was bought and, for the app's "Save all" of a batch purchase, a group ID
 *      shared by the rows saved together. Two hidden columns: Purchases P "Bought at" (date + time, Manila) and
 *      Q "Quote ID"; Archive T / U carry them along when items are refined. Column B (Date) is unchanged and stays a
 *      plain date, so every Dashboard / Archive Totals / daily-chart formula and figure is exactly as before.
 *      The columns are added on the first purchase (or with Gold Tracker > "Set up purchase times"); nothing old is
 *      changed: older rows simply have no time. The time is only kept when it is on the purchase date itself
 *      (a purchase entered for an earlier day gets no made-up time).
 * v8: Every purchase also gets a "Batch #" (Purchases column O) that restarts at 1 after each Batch
 *     refining, for showing to people. The real item No. (column A) is unchanged, still unique and
 *     never reused, and everything still links by it (Refining item No., Archive, the app). Column A
 *     is hidden on Purchases and Archive; Archive keeps the Batch # in column R (hidden) and shows
 *     "R-20261022 · #3" in column S (Batch item, a row-1 formula).
 *     Run Gold Tracker > "Set up batch numbers" once (safe to run again): it adds the columns and
 *     numbers the In stock items 1..n in purchase order (and Archive rows per batch). Until then
 *     nothing gets a Batch # and the app keeps showing the item No.
 * Paste into Extensions > Apps Script of the "Gold Tracker (Improved)" spreadsheet
 * (replace the whole Code.gs; Form.html stays as before).
 *
 * Menu "Gold Tracker":
 *   Quick quote                        - pop-up buying-price calculator (like the old '2025' tab)
 *   Add purchase / Add sale            - forms that write only input cells
 *   Batch refining                     - moves all In stock purchases into a new Refining batch,
 *                                        then moves those rows from Purchases to the Archive tab
 *   Archive refined/sold rows          - moves any Refined / Sold rows left on Purchases to Archive
 *   (v7) After a new batch is archived, older batches' raw rows are removed from Archive. Their
 *        totals are first saved as fixed numbers on the "Archive Totals" tab (one row per batch and
 *        month), and the Dashboard adds those totals back, so no total changes. Refining keeps every
 *        batch's register row and summaries.
 *   Set up Archive Totals              - creates the tab and links the Dashboard (also automatic)
 *   Record batch sale                  - copies sold refining batches into the Sales tab (once)
 *   (also automatic: editing a batch's yellow Sell cells records/updates its Sales row)
 *   Fill blank statuses (In stock)     - sets blank Purchases Status to In stock and blank No. to the next
 *                                        item number (also automatic on edit/paste)
 *   Show / hide extra Purchases columns
 *   Update base price now              - weekday BSP method / weekend goldprice.org method
 *   Install daily base-price update    - time trigger ~6pm Asia/Manila
 *
 * Project Settings > Time zone: set to "(GMT+08:00) Manila" (Asia/Manila).
 */

var TZ = 'Asia/Manila';

// ---------- Layout (must match the sheet) ----------
var PURCHASES = {
  sheet: 'Purchases',
  firstDataRow: 2,
  lastCol: 14, // A..N  (Description column removed)
  cols: {          // INPUT columns (1-based)
    no: 1,          // A  No. (static item number, continues after the Archive)
    date: 2,        // B  Date
    weightBhy: 3,   // C  Weight (BHY)
    purity: 5,      // E  Purity %
    cost: 7,        // G  Cost (PHP)
    status: 11,     // K  Status
    soldDate: 12,   // L  Sold date
    soldAmount: 13  // M  Sold amount
  },
  // Formula columns, never written: D Grams, F Pure grams, H Cost/pure g,
  // I Projected sell price, J Projected profit, N Realized profit.
  // Columns kept visible (like the original '2025' tab): A, C, E, G, I, J.
  hideCols: [1, 2, 4, 6, 8, 11, 12, 13, 14, 16, 17],   // v8: A (real item No.) hidden too; O Batch # shown. v10: P, Q hidden
  shownWidth: 110
};

/** Archive: same A..N layout as Purchases (D, F, H, I, J, N are row-1 ARRAYFORMULAs), plus O..Q. */
var ARCHIVE = {
  sheet: 'Archive',
  firstDataRow: 2,
  lastCol: 18,   // A..R  (v8: R Batch #; S "Batch item" is a row-1 formula)
  cols: { batch: 15, base: 16, archivedOn: 17, bno: 18 },   // O Batch ID, P Base / g (frozen), Q Archived on, R Batch #
  // I = P * Purity * Weight / BHYPerGram (projected sell at the frozen base), J = I - G.
  hideCols: [1, 2, 4, 6, 8, 12, 13, 14, 18, 20, 21]   // shown: C, E, G, I, J, K Status, O, P, Q, S Batch item (v8: A No. and R hidden; v10: T, U hidden)
};
var ARCHIVE_STATUSES = ['Refined', 'Sold'];

/** v8: per-batch display number. Purchases O, Archive R (+ S label). Counter: Document property. */
var BATCHNO = {
  purCol: 15, arcCol: 18, arcLabelCol: 19,
  header: 'Batch #', labelHeader: 'Batch item',
  labelFormula: '={"Batch item";ARRAYFORMULA(IF((O2:O="")+(R2:R=""),"",O2:O&" · #"&R2:R))}',
  prop: 'batchNoLast'   // highest Batch # given since the last Batch refining; missing = not set up yet
};

/** v10: purchase time + batch-quote group ID. Purchases P / Q, Archive T / U (all hidden). */
var BUYINFO = {
  purAt: 16, purQid: 17, arcAt: 20, arcQid: 21,
  headers: ['Bought at', 'Quote ID'],
  format: 'yyyy-mm-dd hh:mm',
  prop: 'buyInfoCols'   // '1' once the columns exist
};

/**
 * Archive Totals (v7): fixed-number totals of Archive rows that were removed when a newer batch
 * was created. One row per (batch, purchase month, sold month). Values only, never formulas.
 * The Dashboard adds these columns to its Purchases + Archive sums.
 */
var ARCHIVE_TOTALS = {
  sheet: 'Archive Totals',
  firstDataRow: 2,
  headers: ['Removed on', 'Batch ID', 'Purchase month', 'Sold month', 'Items', 'Grams', 'Pure grams',
            'Cost (PHP)', 'Est. sell value (PHP)', 'Est. profit (PHP)', 'Losses (count)', 'Losses (PHP)',
            'Sold amount (PHP)', 'Realized profit (PHP)', 'Highest No.', 'Purchase date'],
  cols: { removedOn: 1, batch: 2, buyMonth: 3, soldMonth: 4, items: 5, grams: 6, pure: 7, cost: 8,
          sell: 9, profit: 10, lossN: 11, lossAmt: 12, soldAmt: 13, realized: 14, maxNo: 15,
          buyDay: 16 }   // v9: rows are per purchase DAY (was per month) so the app's daily grams chart keeps removed rows;
                         // every Dashboard link is a SUM / SUMIFS by month, so smaller rows add up to the same figures
};

var SALES = {
  sheet: 'Sales',
  firstDataRow: 11,       // rows 1-9 = 2026 summary (from COMPILATION 2026), row 10 = table header
  cols: { date: 1, base: 2, grams: 3, estValue: 4, cost: 5, actual: 6 }, // G, H are formulas
  batchCol: 9   // I  Refining batch (filled only for rows created by Record batch sale). v51: also DS-<item Nos> for a direct sale.
};

/** v51: column I / Archive batch ids that start with DS- are direct sales, never refining batches. */
function reservedDirectId_(id) { return /^DS-/.test(String(id || '').trim()); }
/** v51: DS- plus one or more item Nos (DS-3, DS-1.4.12). */
function directSaleId_(id) { return /^DS-[1-9]\d*(?:\.[1-9]\d*)*$/.test(String(id || '').trim()); }

var REFINING = {
  sheet: 'Refining',
  selectorCell: 'B3',      // blank = latest batch
  firstDataRow: 19,
  // Item table A..G are inputs written by Batch refining; H..K are formulas.
  itemCols: 7,             // A Batch, B Batch date, C Item No. (stable; matches Purchases/Archive col A),
                           // D Weight (BHY), E Purity, F Cost, G Base/gram at batch
  regFirstCol: 13,         // M  Batch register: M Batch, N Batch date, O Base at batch
  regCols: 3,              // P..W formulas; X Sell date, Y Sell base, Z Actual received = user inputs
  reg: {                   // 1-based columns of the batch register
    id: 13, refinedG: 18, costInclFee: 20, estValue: 21,
    sellDate: 24, sellBase: 25, actualAmt: 26, actualValue: 27, recorded: 29 // AC Recorded in Sales
  }
};

var SETTINGS = {
  sheet: 'Settings',
  basePriceName: 'BasePrice',        // B3
  troyOzName: 'TroyOzGrams',         // B11
  weekdayAdjName: 'WeekdayAdjust',   // B14 (e.g. -200)
  weekendAdjName: 'WeekendAdjust',   // B15 (e.g. -200)
  sourceCell: 'B16',
  priceDateCell: 'B17',
  goldUsdCell: 'B18',
  bspRateCell: 'B19',
  goldPhpOzCell: 'B20',
  perGramRawCell: 'B21',
  lastUpdatedCell: 'B22',
  statusCell: 'B23'
};

var STATUSES = ['In stock', 'Sold', 'Refined'];
var TROY_OZ_GRAMS_DEFAULT = 31.1034768;
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------- Menu ----------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Gold Tracker')
    .addItem('Quick quote', 'showQuickQuote')
    .addSeparator()
    .addItem('Add purchase', 'showPurchaseForm')
    .addItem('Add sale', 'showSaleForm')
    .addSeparator()
    .addItem('Batch refining', 'batchRefining')
    .addItem('Record batch sale', 'recordBatchSales')
    .addItem('Archive refined/sold rows', 'archiveRefinedSold')
    .addItem('Set up Archive Totals (keeps totals when old rows are removed)', 'setupArchiveTotals')
    .addItem('Set up batch numbers (Batch # restarts at 1 after each batch)', 'setupBatchNumbers')
    .addItem('Set up purchase times (time bought + batch groups for the app)', 'setupPurchaseTimes')
    .addSeparator()
    .addItem('Fill blank statuses (In stock)', 'fillBlankStatuses')
    .addItem('Show / hide extra Purchases columns', 'togglePurchaseColumns')
    .addSeparator()
    .addItem('Update base price now', 'updateBasePriceNow')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('Maintenance')
      .addItem('Preview: archive TZ fix log', 'archiveTzFixLogPreview')
      .addItem('Archive TZ fix log (copies it out, then removes the tab)', 'archiveTzFixLogApply')
      .addItem('Verify TZ fix log archive', 'archiveTzFixLogVerify')
      .addItem('Rollback TZ fix log archive', 'archiveTzFixLogRollback')
      .addSeparator()
      .addItem('Preview: trim sold batch item rows', 'trimSoldBatchItemsPreview')
      .addItem('Trim sold batch item rows (makes a backup tab first)', 'trimSoldBatchItemsApply')
      .addItem('Verify trimmed sold batch items', 'trimSoldBatchItemsVerify')
      .addItem('Rollback trim sold batch items', 'trimSoldBatchItemsRollback'))
    .addToUi();
  try {
    var shown = PropertiesService.getDocumentProperties().getProperty('purchasesExtraShown') === '1';
    if (!shown) hideExtraPurchaseColumns();
  } catch (e) { /* ignore in limited auth mode */ }
}

function showPurchaseForm() { showForm_('purchase', 'Add purchase'); }
function showQuickQuote() { showForm_('quote', 'Quick quote'); }
function showSaleForm() { showForm_('sale', 'Add sale'); }

function showForm_(mode, title) {
  var t = HtmlService.createTemplateFromFile('Form');
  t.mode = mode;
  t.today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  t.basePrice = getNamed_(SETTINGS.basePriceName) || '';
  t.statuses = STATUSES;
  t.quoteMargin = getNamed_('QuoteMargin');
  t.fullBaseMin = getNamed_('FullBaseMinPurity');
  var h = mode === 'purchase' ? 600 : (mode === 'quote' ? 470 : 520);
  var html = t.evaluate().setWidth(420).setHeight(h);
  if (mode === 'quote') SpreadsheetApp.getUi().showModelessDialog(html, title); // stays open while you work
  else SpreadsheetApp.getUi().showModalDialog(html, title);
}

/** Called once by the Quick quote dialog (and by its Refresh button). */
function getQuoteSettings() {
  var base = getNamed_(SETTINGS.basePriceName);
  var margin = getNamed_('QuoteMargin');          // buy deduction below threshold (purity points)
  var fullMin = getNamed_('FullBaseMinPurity');   // at/above this purity, pay full base
  if (base === null || !isFinite(base)) throw new Error('Settings base price (BasePrice) is empty.');
  if (margin === null || !isFinite(margin)) margin = 0.01;
  if (margin >= 1) margin = margin / 100; // 1 typed instead of 1%
  if (fullMin === null || !isFinite(fullMin) || fullMin <= 0) fullMin = 0.998;
  if (fullMin > 1) fullMin = fullMin / 100; // 99.8 typed instead of 0.998
  return { base: base, margin: margin, fullMin: fullMin, at: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm') };
}

// ---------- Purchases column visibility ----------
function hideExtraPurchaseColumns() {
  var sh = SpreadsheetApp.getActive().getSheetByName(PURCHASES.sheet);
  if (!sh) return;
  sh.showColumns(1, sh.getMaxColumns()); // reset first, so stale hidden columns never pile up
  hideColsNow_(PURCHASES.hideCols).forEach(function (c) { if (c <= sh.getMaxColumns()) sh.hideColumns(c); });
  hideArchiveColumns_();
  PropertiesService.getDocumentProperties().setProperty('purchasesExtraShown', '0');
}

/** Archive: same reset-then-hide; also gives O1:Q1 the Purchases header look. */
function hideArchiveColumns_() {
  var ar = SpreadsheetApp.getActive().getSheetByName(ARCHIVE.sheet);
  if (!ar) return;
  ar.showColumns(1, ar.getMaxColumns());
  hideColsNow_(ARCHIVE.hideCols).forEach(function (c) { if (c <= ar.getMaxColumns()) ar.hideColumns(c); });
  ar.getRange(1, 14).copyFormatToRange(ar, ARCHIVE.cols.batch, ARCHIVE.cols.archivedOn, 1, 1);
}

/** v8: the item No. (A) and Archive R are hidden only once batch numbers are set up (so a number is always shown). */
function hideColsNow_(cols) {
  var on = false; try { on = batchNoOn_(); } catch (e) { on = false; }
  return on ? cols : cols.filter(function (c) { return c !== 1 && c !== BATCHNO.arcCol; });
}

function showExtraPurchaseColumns() {
  var sh = SpreadsheetApp.getActive().getSheetByName(PURCHASES.sheet);
  if (!sh) return;
  sh.showColumns(1, sh.getMaxColumns()); // unhide everything, including stale hidden columns
  PURCHASES.hideCols.forEach(function (c) {
    if (c <= sh.getMaxColumns() && sh.getColumnWidth(c) < 40) sh.setColumnWidth(c, PURCHASES.shownWidth);
  });
  var ar = SpreadsheetApp.getActive().getSheetByName(ARCHIVE.sheet);
  if (ar) {
    ar.showColumns(1, ar.getMaxColumns());
    ARCHIVE.hideCols.forEach(function (c) {
      if (c <= ar.getMaxColumns() && ar.getColumnWidth(c) < 40) ar.setColumnWidth(c, PURCHASES.shownWidth);
    });
  }
  PropertiesService.getDocumentProperties().setProperty('purchasesExtraShown', '1');
}

function togglePurchaseColumns() {
  var shown = PropertiesService.getDocumentProperties().getProperty('purchasesExtraShown') === '1';
  if (shown) hideExtraPurchaseColumns(); else showExtraPurchaseColumns();
}

// ---------- Helpers ----------
function getNamed_(name) {
  var r = SpreadsheetApp.getActive().getRangeByName(name);
  if (!r) return null;
  var v = r.getValue();
  return (v === '' || v === null) ? null : Number(v);
}

function toNumber_(v, label, opts) {
  opts = opts || {};
  if (v === null || v === undefined || String(v).trim() === '') {
    if (opts.optional) return '';
    throw new Error(label + ' is required.');
  }
  var n = Number(String(v).replace(/[,\s]|PHP|₱/gi, ''));
  if (!isFinite(n)) throw new Error(label + ' must be a number.');
  if (opts.min !== undefined && n < opts.min) throw new Error(label + ' must be at least ' + opts.min + '.');
  if (opts.positive && n <= 0) throw new Error(label + ' must be greater than 0.');
  return n;
}

/** Cut extra purity decimals the way the phone does, before any rounding. 85.356 -> 85.35; 0.85356 -> 0.8535. */
function purTrunc_(v) {
  var s = String(v == null ? '' : v);
  var m = s.match(/^(\s*[+-]?)(\d*)(\.)(\d*)([\s\S]*)$/);
  if (!m) return s;
  var max = /%/.test(m[5]) || !(m[2] === '' || /^0+$/.test(m[2])) ? 2 : 4;
  return m[4].length > max ? m[1] + m[2] + m[3] + m[4].substring(0, max) + m[5] : s;
}
/** Half away from zero at `places` decimals. The e-notation form avoids 1.005 * 100 becoming 100.49999999999999. */
function roundAway_(n, places) {
  n = Number(n);
  if (!isFinite(n)) return n;
  var a = Math.abs(n);
  var r = Number(Math.round(a + 'e' + places) + 'e-' + places);
  var v = (n < 0 ? -1 : 1) * (isFinite(r) ? r : Math.round(a * Math.pow(10, places)) / Math.pow(10, places));
  return v === 0 ? 0 : v;
}
/**
 * Accepts 85.35, 85.35%, or 0.8535 and returns 0.8535.
 * A percent (above 1, or with %) is cut to 2 decimal places first, the same cut the phone makes
 * while you type (85.356 -> 0.8535). A fraction that is already between 0 and 1 is kept as given:
 * rounding it to 4 places would turn 0.997999 into 0.998 and sell gold that is below 99.8%.
 * The phone cuts a fraction before it sends, so a purchase from the phone is unchanged.
 */
function toPurity_(v) {
  var raw = String(v === undefined || v === null ? '' : v).trim();
  if (raw === '') throw new Error('Purity % is required.');
  var hadPct = /%$/.test(raw);
  var bare = raw.replace('%', '');
  var asPct = hadPct || Number(String(bare).replace(/[,\s]/g, '')) > 1;
  var s = asPct ? purTrunc_(raw) : raw;
  var n = toNumber_(String(s).replace('%', ''), 'Purity %');
  if (hadPct || n > 1) n = n / 100;
  if (asPct) n = roundAway_(n, 4);
  if (n <= 0 || n > 1) throw new Error('Purity must be between 0 and 100% (e.g. 85.35 or 0.8535).');
  return n;
}

function toDate_(v, label, optional) {
  if (!v) {
    if (optional) return '';
    throw new Error(label + ' is required.');
  }
  var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(label + ' must be a date (yyyy-mm-dd).');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** First row (>= firstDataRow) after the last row that has anything in the given columns. */
function firstEmptyRow_(sheet, firstDataRow, colNums) {
  var last = sheet.getLastRow();
  if (last < firstDataRow) return firstDataRow;
  var maxCol = Math.max.apply(null, colNums);
  var values = sheet.getRange(firstDataRow, 1, last - firstDataRow + 1, maxCol).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    for (var j = 0; j < colNums.length; j++) {
      var v = values[i][colNums[j] - 1];
      if (v !== '' && v !== null) return firstDataRow + i + 1;
    }
  }
  return firstDataRow;
}

function range_(from, count) { var a = []; for (var i = 0; i < count; i++) a.push(from + i); return a; }

function ensureRows_(sheet, lastNeededRow) {
  var max = sheet.getMaxRows();
  if (lastNeededRow > max) sheet.insertRowsAfter(max, lastNeededRow - max + 100);
}

function colValues_(cols) { return Object.keys(cols).map(function (k) { return cols[k]; }); }

function todayStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

/** Highest number in column A (No.) of a tab, 0 if none. */
function maxNo_(sh) {
  if (!sh) return 0;
  var last = sh.getLastRow();
  if (last < 2) return 0;
  var m = 0;
  sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (v) {
    var n = Number(v[0]);
    if (v[0] !== '' && v[0] !== null && isFinite(n) && n > m) m = n;
  });
  return m;
}

/** Next item No.: continues after everything on Purchases, Archive and removed Archive rows. */
function nextItemNo_() {
  var ss = SpreadsheetApp.getActive();
  return Math.max(maxNo_(ss.getSheetByName(PURCHASES.sheet)), maxNo_(ss.getSheetByName(ARCHIVE.sheet)),
                  archiveTotalsMaxNo_(ss.getSheetByName(ARCHIVE_TOTALS.sheet))) + 1;
}

// ---------- v8: Batch # (display number, restarts at 1 after each Batch refining) ----------
function batchNoProps_() { return PropertiesService.getDocumentProperties(); }
/** True once "Set up batch numbers" ran (or a batch was refined with v8): new purchases then get a Batch #. */
function batchNoOn_() { var v = batchNoProps_().getProperty(BATCHNO.prop); return v !== null && v !== undefined && v !== ''; }
function setBatchNoLast_(n) { batchNoProps_().setProperty(BATCHNO.prop, String(Number(n) || 0)); }
/** Next Batch #: after the highest given since the last batch (counter) and any on Purchases (never reused after a delete). */
function nextBatchNo_(pur) {
  var m = Number(batchNoProps_().getProperty(BATCHNO.prop)) || 0;
  var last = pur.getLastRow();
  if (last >= PURCHASES.firstDataRow && pur.getMaxColumns() >= BATCHNO.purCol) {
    pur.getRange(PURCHASES.firstDataRow, BATCHNO.purCol, last - PURCHASES.firstDataRow + 1, 1).getValues().forEach(function (v) {
      var n = Number(v[0]); if (v[0] !== '' && v[0] !== null && isFinite(n) && n > m) m = n;
    });
  }
  return m + 1;
}
/**
 * Adds Purchases O "Batch #" and Archive R "Batch #" + S "Batch item" when missing (idempotent).
 * Refuses (throws) if one of those cells already holds something else, so nothing is overwritten.
 * Remembered for 6 hours so purchases do not re-check every time.
 */
function ensureBatchNoCols_(force) {
  var cache = null, key = 'gold:batchnocols:v8';
  try { cache = CacheService.getScriptCache(); if (!force && cache.get(key)) return; } catch (e) { cache = null; }
  var ss = SpreadsheetApp.getActive();
  var fit = function (sh, col) { var m = sh.getMaxColumns(); if (m < col) sh.insertColumnsAfter(m, col - m); };
  var head = function (sh, col, text, formula) {
    var cell = sh.getRange(1, col), v = String(cell.getValue() === null ? '' : cell.getValue()).trim();
    if (v === text) return false;
    if (v !== '') throw new Error(sh.getName() + ' column ' + String.fromCharCode(64 + col) + ' already holds "' + v + '". Batch numbers need it empty; nothing was changed.');
    if (formula) cell.setFormula(formula); else cell.setValue(text);
    try { sh.getRange(1, 14).copyFormatToRange(sh, col, col, 1, 1); } catch (e) { /* format only */ }
    return true;
  };
  var pur = ss.getSheetByName(PURCHASES.sheet);
  if (pur) {
    fit(pur, BATCHNO.purCol);
    if (head(pur, BATCHNO.purCol, BATCHNO.header)) { try { pur.getRange(2, BATCHNO.purCol, Math.max(pur.getMaxRows() - 1, 1), 1).setNumberFormat('"#"0'); } catch (e) {} }
  }
  var ar = ss.getSheetByName(ARCHIVE.sheet);
  if (ar) {
    fit(ar, BATCHNO.arcLabelCol);
    head(ar, BATCHNO.arcCol, BATCHNO.header);
    var lab = ar.getRange(1, BATCHNO.arcLabelCol), lf = '';
    try { lf = String((lab.getFormulas()[0] || [''])[0] || ''); } catch (e) { lf = ''; }
    if (lf.indexOf('Batch item') < 0) head(ar, BATCHNO.arcLabelCol, BATCHNO.labelHeader, BATCHNO.labelFormula);
  }
  if (cache) { try { cache.put(key, '1', 21600); } catch (e) {} }
}

/**
 * Menu "Set up batch numbers" (one-time; safe to run again).
 *  - adds the columns (Purchases O, Archive R + S label) and hides the real item No. columns
 *  - first run: numbers the In stock purchases 1..n in purchase order (by item No.)
 *    later runs: only fills a blank Batch #, continuing after the highest one
 *  - Archive rows without a Batch #: numbered per batch in item-No. order
 * Item No.s, Refining, Archive Totals and every formula are not touched.
 */
function setupBatchNumbers() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  var msg;
  try { msg = setupBatchNumbers_().message; }
  catch (e) { msg = 'Batch numbers: ' + e.message; }
  finally { lock.releaseLock(); }
  try { SpreadsheetApp.getUi().alert('Set up batch numbers', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}
function setupBatchNumbers_() {
  var ss = SpreadsheetApp.getActive();
  ensureBatchNoCols_(true);
  var first = !batchNoOn_(), c = PURCHASES.cols, res = { purchases: 0, archive: 0, first: first };
  var blank = function (v) { return v === '' || v === null || (typeof v === 'string' && v.trim() === ''); };
  var pur = ss.getSheetByName(PURCHASES.sheet), maxB = 0;
  if (pur && pur.getLastRow() >= PURCHASES.firstDataRow) {
    var n = pur.getLastRow() - PURCHASES.firstDataRow + 1;
    var v = pur.getRange(PURCHASES.firstDataRow, 1, n, BATCHNO.purCol).getValues();
    var todo = [];
    v.forEach(function (r, i) {
      var st = String(r[c.status - 1] || '').trim(), has = !blank(r[c.weightBhy - 1]);
      var b = r[BATCHNO.purCol - 1];
      if (!first && !blank(b) && isFinite(Number(b))) maxB = Math.max(maxB, Number(b));
      if (has && (st === 'In stock' || st === '') && (first || blank(b))) todo.push(i);
      else if (first && !blank(b)) v[i][BATCHNO.purCol - 1] = b;   // other rows keep what they have
    });
    var key = function (i) { var x = Number(v[i][c.no - 1]); return blank(v[i][c.no - 1]) || !isFinite(x) ? Infinity : x; };
    todo.sort(function (a, b) { return key(a) - key(b) || a - b; });
    todo.forEach(function (i) { v[i][BATCHNO.purCol - 1] = ++maxB; });
    if (todo.length) pur.getRange(PURCHASES.firstDataRow, BATCHNO.purCol, n, 1).setValues(v.map(function (r) { return [r[BATCHNO.purCol - 1]]; }));
    res.purchases = todo.length;
  }
  var last = Math.max(maxB, nextBatchNoRaw_(pur) - 1);
  setBatchNoLast_(last);
  var ar = ss.getSheetByName(ARCHIVE.sheet);
  if (ar && ar.getLastRow() >= ARCHIVE.firstDataRow) {
    var an = ar.getLastRow() - ARCHIVE.firstDataRow + 1;
    var av = ar.getRange(ARCHIVE.firstDataRow, 1, an, BATCHNO.arcCol).getValues();
    var per = {}, groups = {};
    av.forEach(function (r, i) {
      var id = String(r[ARCHIVE.cols.batch - 1] || '').trim(); if (!id || blank(r[2])) return;
      var b = r[BATCHNO.arcCol - 1];
      if (!blank(b) && isFinite(Number(b))) per[id] = Math.max(per[id] || 0, Number(b));
      else (groups[id] = groups[id] || []).push(i);
    });
    var changed = 0;
    Object.keys(groups).forEach(function (id) {
      groups[id].sort(function (a, b) { return (Number(av[a][0]) || Infinity) - (Number(av[b][0]) || Infinity) || a - b; });
      groups[id].forEach(function (i) { av[i][BATCHNO.arcCol - 1] = (per[id] = (per[id] || 0) + 1); changed++; });
    });
    if (changed) ar.getRange(ARCHIVE.firstDataRow, BATCHNO.arcCol, an, 1).setValues(av.map(function (r) { return [r[BATCHNO.arcCol - 1]]; }));
    res.archive = changed;
  }
  SpreadsheetApp.flush();
  try { if (PropertiesService.getDocumentProperties().getProperty('purchasesExtraShown') !== '1') hideExtraPurchaseColumns(); } catch (e) { /* column display only */ }
  res.message = (first ? 'Batch numbers are set up. ' : 'Batch numbers checked. ') +
    res.purchases + ' In stock item' + (res.purchases === 1 ? '' : 's') + ' numbered on Purchases (column O), ' +
    res.archive + ' Archive row' + (res.archive === 1 ? '' : 's') + ' numbered. Next purchase: #' + (last + 1) + '.';
  return res;
}
function nextBatchNoRaw_(pur) { return pur ? nextBatchNo_(pur) : 1; }

// ---------- v10: purchase time ("Bought at") + batch-quote group ("Quote ID") ----------
function buyInfoOn_() { try { return batchNoProps_().getProperty(BUYINFO.prop) === '1'; } catch (e) { return false; } }
/**
 * Adds Purchases P "Bought at" / Q "Quote ID" and Archive T / U (same headers) when missing, hidden like the
 * other extra columns (idempotent). Throws, changing nothing more, if one of those header cells holds something
 * else. Remembered for 6 hours so purchases do not re-check every time.
 */
function ensureBuyInfoCols_(force) {
  var cache = null, key = 'gold:buyinfocols:v10';
  var ss = SpreadsheetApp.getActive(), added = [];
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  if (!force && cache && buyInfoOn_()) {   // remembered: still check the columns exist (they may have been deleted since)
    var hit = null; try { hit = cache.get(key); } catch (e) {}
    var pS = ss.getSheetByName(PURCHASES.sheet), aS = ss.getSheetByName(ARCHIVE.sheet);
    if (hit && pS && pS.getMaxColumns() >= BUYINFO.purQid && (!aS || aS.getMaxColumns() >= BUYINFO.arcQid)) return true;
  }
  var tabs = [[ss.getSheetByName(PURCHASES.sheet), BUYINFO.purAt], [ss.getSheetByName(ARCHIVE.sheet), BUYINFO.arcAt]];
  tabs.forEach(function (t) {   // check every header first: nothing is written if one is taken
    var sh = t[0]; if (!sh || sh.getMaxColumns() < t[1]) return;
    var hv = sh.getRange(1, t[1], 1, Math.min(2, sh.getMaxColumns() - t[1] + 1)).getValues()[0];
    BUYINFO.headers.forEach(function (h, i) {
      var v = String(hv[i] === undefined || hv[i] === null ? '' : hv[i]).trim();
      if (v !== '' && v !== h) throw new Error(sh.getName() + ' column ' + String.fromCharCode(64 + t[1] + i) + ' already holds "' + v + '". Purchase times need it empty; nothing was changed.');
    });
  });
  var shown = false; try { shown = PropertiesService.getDocumentProperties().getProperty('purchasesExtraShown') === '1'; } catch (e) {}
  tabs.forEach(function (t) {
    var sh = t[0], col = t[1]; if (!sh) return;
    var m = sh.getMaxColumns(); if (m < col + 1) sh.insertColumnsAfter(m, col + 1 - m);
    var hdr = sh.getRange(1, col, 1, 2), hv = hdr.getValues()[0];
    if (hv[0] === BUYINFO.headers[0] && hv[1] === BUYINFO.headers[1]) return;
    hdr.setValues([BUYINFO.headers]); added.push(sh.getName());
    try { sh.getRange(1, 14).copyFormatToRange(sh, col, col + 1, 1, 1); } catch (e) { /* format only */ }
    try { sh.getRange(2, col, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat(BUYINFO.format); } catch (e) {}
    if (!shown) { try { sh.hideColumns(col, 2); } catch (e) {} }
  });
  batchNoProps_().setProperty(BUYINFO.prop, '1');
  if (cache) { try { cache.put(key, '1', 21600); } catch (e) {} }
  return added;
}
/** Menu "Set up purchase times" (safe to run again). Old rows are not changed: they just have no time. */
function setupPurchaseTimes() {
  var msg;
  try {
    var lock = LockService.getDocumentLock(); lock.waitLock(30000);
    try { var a = ensureBuyInfoCols_(true); msg = (a && a.length ? 'Added "Bought at" and "Quote ID" (hidden) on ' + a.join(' and ') + '. ' : 'Purchase time columns are already set up. ') +
      'New purchases now keep the time they were bought; older rows have no time.'; }
    finally { lock.releaseLock(); }
  } catch (e) { msg = 'Purchase times: ' + e.message; }
  try { SpreadsheetApp.getUi().alert('Set up purchase times', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}
/**
 * The time to keep for a purchase on day `date` (a Date at midnight): the app's entry time `at` (ISO text) when it
 * is on that same Manila day and not in the future (more than 10 min ahead = the phone clock is off: now, if the
 * purchase is for today); with no `at`, now if the purchase is for today. Else '' (no
 * made-up time for a purchase entered for another day).
 */
function buyAt_(at, date) {
  var day = Utilities.formatDate(date, TZ, 'yyyy-MM-dd'), now = new Date();
  if (at !== undefined && at !== null && String(at).trim() !== '') {
    var d = new Date(String(at).trim());
    if (isNaN(d.getTime())) return '';
    if (d.getTime() > now.getTime() + 10 * 60000) return day === Utilities.formatDate(now, TZ, 'yyyy-MM-dd') ? now : '';   // clock ahead: now, if bought today
    return Utilities.formatDate(d, TZ, 'yyyy-MM-dd') === day ? d : '';
  }
  return day === Utilities.formatDate(now, TZ, 'yyyy-MM-dd') ? now : '';
}
/** A batch-quote group ID from the app: short, letters / digits / - _ . : only, else ''. */
function quoteId_(v) { var s = String(v === undefined || v === null ? '' : v).trim(); return /^[A-Za-z0-9._:-]{1,40}$/.test(s) ? s : ''; }

// ---------- Refining: shared by the menu and the app (Api.gs) ----------
/** Every batch ID already used on Refining (item table A and register M). */
function existingBatchIds_(ref) {
  var ids = {}, last = ref.getLastRow();
  if (last >= REFINING.firstDataRow) {
    var n = last - REFINING.firstDataRow + 1;
    ref.getRange(REFINING.firstDataRow, 1, n, 1).getValues().forEach(function (v) { if (v[0]) ids[String(v[0])] = true; });
    ref.getRange(REFINING.firstDataRow, REFINING.regFirstCol, n, 1).getValues().forEach(function (v) { if (v[0]) ids[String(v[0])] = true; });
  }
  return ids;
}
/** R-YYYYMMDD (Manila), with -2, -3 ... when taken. */
function defaultBatchId_(existing) {
  var def = 'R-' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd'), k = 2, cand = def;
  while (existing[cand]) cand = def + '-' + (k++);
  return cand;
}

/** Highest item No. among Archive rows that were removed (Archive Totals col O), 0 if none. */
function archiveTotalsMaxNo_(sh) {
  if (!sh) return 0;
  var last = sh.getLastRow();
  if (last < ARCHIVE_TOTALS.firstDataRow) return 0;
  var m = 0;
  sh.getRange(ARCHIVE_TOTALS.firstDataRow, ARCHIVE_TOTALS.cols.maxNo, last - ARCHIVE_TOTALS.firstDataRow + 1, 1).getValues()
    .forEach(function (v) { var n = Number(v[0]); if (v[0] !== '' && v[0] !== null && isFinite(n) && n > m) m = n; });
  return m;
}

/** Returns the Archive tab, creating it (headers + formulas, Purchases header style) if missing. */
function getArchive_() {
  var ss = SpreadsheetApp.getActive();
  var ar = ss.getSheetByName(ARCHIVE.sheet);
  if (ar) return ar;
  ar = ss.insertSheet(ARCHIVE.sheet);
  var bhy = 'BHYPerGram';
  ar.getRange(1, 1, 1, ARCHIVE.lastCol).setValues([[
    'No.', 'Date', 'Weight (BHY)',
    '={"Grams";ARRAYFORMULA(IF(C2:C="","",C2:C/' + bhy + '))}',
    'Purity %',
    '={"Pure grams";ARRAYFORMULA(IF((C2:C="")+(E2:E=""),"",C2:C/' + bhy + '*E2:E))}',
    'Cost (PHP)',
    '={"Cost per pure gram";ARRAYFORMULA(IF((C2:C="")+(E2:E="")+(G2:G=""),"",IFERROR(G2:G/(C2:C/' + bhy + '*E2:E),"")))}',
    '={"Projected sell price";ARRAYFORMULA(IF((C2:C="")+(E2:E="")+(P2:P=""),"",P2:P*E2:E*C2:C/' + bhy + '))}',
    '={"Projected profit";ARRAYFORMULA(IF((I2:I="")+(G2:G=""),"",I2:I-G2:G))}',
    'Status', 'Sold date', 'Sold amount',
    '={"Realized profit";ARRAYFORMULA(IF((K2:K="Sold")*(M2:M<>"")*(G2:G<>""),M2:M-G2:G,""))}',
    'Batch ID', 'Base / g (frozen)', 'Archived on', BATCHNO.header]]);
  ar.getRange(1, BATCHNO.arcLabelCol).setFormula(BATCHNO.labelFormula);
  var pur = ss.getSheetByName(PURCHASES.sheet);
  if (pur) {
    pur.getRange(1, 1, 1, PURCHASES.lastCol).copyFormatToRange(ar, 1, PURCHASES.lastCol, 1, 1);
    pur.getRange(1, 1, Math.min(pur.getMaxRows(), 1000), PURCHASES.lastCol).copyFormatToRange(ar, 1, PURCHASES.lastCol, 1, Math.min(pur.getMaxRows(), 1000));
    pur.getRange(1, 14).copyFormatToRange(ar, ARCHIVE.cols.batch, ARCHIVE.cols.archivedOn, 1, 1);
  }
  ar.getRange(2, ARCHIVE.cols.base, ar.getMaxRows() - 1, 1).setNumberFormat('#,##0.00');
  ar.getRange(2, ARCHIVE.cols.archivedOn, ar.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
  ar.setFrozenRows(1);
  return ar;
}

// ---------- Form handlers (called from Form.html) ----------
/**
 * One purchase write. writer(sh, row, pairs) writes the cells.
 * The menu passes null and writes one cell at a time (hidden columns included).
 * The API passes goldApiSetPairs_ (one setValues per contiguous run, formula columns untouched)
 * and does not take a lock here: goldApiHandle_ already holds it, and a second waitLock would drop it.
 * Does not flush.
 */
function addPurchaseCore_(form, writer) {
  var c = PURCHASES.cols;
  var date = toDate_(form.date, 'Date', true) || new Date();
  var weight = toNumber_(form.weightBhy, 'Weight (BHY)', { positive: true });
  var purity = toPurity_(form.purity);
  var cost = toNumber_(form.cost, 'Cost (PHP)', { min: 0 });
  var status = STATUSES.indexOf(form.status) >= 0 ? form.status : 'In stock';
  var soldDate = toDate_(form.soldDate, 'Sold date', true);
  var soldAmount = toNumber_(form.soldAmount, 'Sold amount', { optional: true, min: 0 });
  if (status === 'Sold' && soldAmount === '') throw new Error('Enter the sold amount for a Sold item.');
  var at = buyAt_(form.at, date), qid = quoteId_(form.qid);   // v10

  var sh = SpreadsheetApp.getActive().getSheetByName(PURCHASES.sheet);
  if (!sh) throw new Error('Tab "' + PURCHASES.sheet + '" not found.');
  var bi = false; try { bi = !!ensureBuyInfoCols_(); } catch (e) { bi = false; }   // v10: a purchase never fails over its time
  var row = firstEmptyRow_(sh, PURCHASES.firstDataRow, colValues_(c));
  ensureRows_(sh, row);
  var no = nextItemNo_();
  var pairs = [[c.no, no], [c.date, date], [c.weightBhy, weight],
               [c.purity, purity], [c.cost, cost], [c.status, status]];
  var bno = null;   // v8: Batch # once batch numbers are set up
  if (batchNoOn_()) { ensureBatchNoCols_(); bno = nextBatchNo_(sh); pairs.push([BATCHNO.purCol, bno]); }
  if (soldDate !== '') pairs.push([c.soldDate, soldDate]);
  if (soldAmount !== '') pairs.push([c.soldAmount, soldAmount]);
  if (bi) { pairs.push([BUYINFO.purAt, at]); pairs.push([BUYINFO.purQid, qid]); }   // always, '' too: a reused row keeps no old time / group
  if (writer) writer(sh, row, pairs);
  else pairs.forEach(function (p) { sh.getRange(row, p[0]).setValue(p[1]); });
  if (bno !== null) setBatchNoLast_(bno);
  return 'Purchase added as No. ' + no + ' (row ' + row + ').' + (bno !== null ? ' Batch #' + bno + '.' : '');
}
function addPurchase(form) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var msg = addPurchaseCore_(form, null);
    SpreadsheetApp.flush();
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/** One other-sale write. No lock and no flush. The menu and the API both call this. */
function addSaleCore_(form) {
  var c = SALES.cols;
  var date = toDate_(form.date, 'Date', true) || new Date();
  var base = toNumber_(form.base, 'Base price / gram', { optional: true, positive: true });
  var grams = toNumber_(form.grams, 'Grams sold', { optional: true, positive: true });
  var estValue = toNumber_(form.estValue, 'Est. value', { optional: true, min: 0 });
  var cost = toNumber_(form.cost, 'Cost (PHP)', { min: 0 });
  var actual = toNumber_(form.actual, 'Actual received (PHP)', { min: 0 });
  var sh = SpreadsheetApp.getActive().getSheetByName(SALES.sheet);
  if (!sh) throw new Error('Tab "' + SALES.sheet + '" not found.');
  var row = firstEmptyRow_(sh, SALES.firstDataRow, colValues_(c));
  ensureRows_(sh, row);
  sh.getRange(row, 1, 1, 6).setValues([[date, base, grams, estValue, cost, actual]]);
  return 'Sale added on row ' + row + '. Realized profit: PHP ' + Math.round(actual - cost).toLocaleString() + '.';
}
function addSale(form) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var msg = addSaleCore_(form);
    SpreadsheetApp.flush();
    return msg;
  } finally {
    lock.releaseLock();
  }
}

// ---------- Batch refining ----------
/**
 * Copies every Purchases row with Status "In stock" into the Refining tab as a new batch
 * (values only, base price frozen at today's Settings base; column C = item No.), adds a
 * batch-register row, sets those rows to "Refined" and moves them to the Archive tab
 * (together with any other Refined / Sold rows still on Purchases).
 */
function batchRefining() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActive();
  var pur = ss.getSheetByName(PURCHASES.sheet);
  var ref = ss.getSheetByName(REFINING.sheet);
  if (!pur || !ref) { ui.alert('Purchases or Refining tab not found.'); return; }

  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var c = PURCHASES.cols;
    var last = pur.getLastRow();
    if (last < PURCHASES.firstDataRow) { ui.alert('No purchases found.'); return; }
    var n = last - PURCHASES.firstDataRow + 1;
    var data = pur.getRange(PURCHASES.firstDataRow, 1, n, PURCHASES.lastCol).getValues();

    var bhyPerGram = getNamed_('BHYPerGram') || 2;
    // Give any row without a No. its number first (Refining stores the No., not the row).
    var nextNo = nextItemNo_(), noFilled = false;
    data.forEach(function (r) {
      var w = r[c.weightBhy - 1];
      if (w !== '' && w !== null && (r[c.no - 1] === '' || r[c.no - 1] === null)) { r[c.no - 1] = nextNo++; noFilled = true; }
    });
    if (noFilled) pur.getRange(PURCHASES.firstDataRow, c.no, n, 1).setValues(data.map(function (r) { return [r[c.no - 1]]; }));
    var picked = [];
    var rawG = 0, refG = 0, cost = 0;
    data.forEach(function (r, i) {
      var w = r[c.weightBhy - 1];
      if (r[c.status - 1] === 'In stock' && w !== '' && w !== null) {
        var p = Number(r[c.purity - 1]) || 0;
        var g = Number(w) / bhyPerGram;
        rawG += g; refG += g * p; cost += Number(r[c.cost - 1]) || 0;
        picked.push({ idx: i, row: PURCHASES.firstDataRow + i, r: r });
      }
    });
    if (!picked.length) { ui.alert('There are no "In stock" purchases to refine.'); return; }

    var base = getNamed_(SETTINGS.basePriceName);
    if (!base) { ui.alert('Settings base price is empty. Set it first.'); return; }

    // Default batch ID R-YYYYMMDD (adds -2, -3 ... if it already exists)
    var existing = existingBatchIds_(ref), defId = defaultBatchId_(existing);

    var resp = ui.prompt('Batch refining', 'Batch ID (leave blank for ' + defId + '):', ui.ButtonSet.OK_CANCEL);
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    var batchId = String(resp.getResponseText() || '').trim() || defId;
    if (reservedDirectId_(batchId)) { ui.alert('Batch IDs starting with DS- are reserved for direct sales of items that are already 99.8%. Pick another ID.'); return; }
    if (existing[batchId]) { ui.alert('Batch "' + batchId + '" already exists. Pick another ID.'); return; }

    var fee = getNamed_('RefiningFee') || 0;
    var msg = 'Move ' + picked.length + ' In stock purchases into batch ' + batchId + '?\n\n' +
      'Raw grams: ' + rawG.toFixed(3) + ' g\n' +
      'Est. refined grams: ' + refG.toFixed(3) + ' g\n' +
      'Cost + fee: PHP ' + Math.round(cost + fee).toLocaleString() + '\n' +
      'Base frozen for this batch: PHP ' + base.toLocaleString() + ' / g\n\n' +
      'Their Status will change to "Refined" and they move to the Archive tab.';
    if (ui.alert('Confirm batch refining', msg, ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

    var batchDate = new Date();
    // 1) Item rows on Refining (values only)
    var itemStart = firstEmptyRow_(ref, REFINING.firstDataRow, range_(1, REFINING.itemCols));
    ensureRows_(ref, itemStart + picked.length);
    var rows = picked.map(function (p) {
      return [batchId, batchDate, p.r[c.no - 1], p.r[c.weightBhy - 1],
              p.r[c.purity - 1], p.r[c.cost - 1], base];
    });
    ref.getRange(itemStart, 1, rows.length, REFINING.itemCols).setValues(rows);

    // 2) Batch register row
    var regRow = firstEmptyRow_(ref, REFINING.firstDataRow, range_(REFINING.regFirstCol, REFINING.regCols));
    ensureRows_(ref, regRow);
    ref.getRange(regRow, REFINING.regFirstCol, 1, REFINING.regCols).setValues([[batchId, batchDate, base]]);

    // 3) Status -> Refined on Purchases
    var statusRange = pur.getRange(PURCHASES.firstDataRow, c.status, n, 1);
    var statuses = statusRange.getValues();
    picked.forEach(function (p) { statuses[p.idx][0] = 'Refined'; });
    statusRange.setValues(statuses);
    SpreadsheetApp.flush();

    // 4) Move Refined / Sold rows from Purchases to Archive (batch base frozen in Archive col P)
    var batchInfo = {};
    picked.forEach(function (p) { batchInfo[String(p.r[c.no - 1])] = { batch: batchId, base: base }; });
    var moved = archiveRows_(batchInfo, batchDate);
    setBatchNoLast_(0);   // v8: the next purchase is Batch #1

    // 4b) Archive keeps only this batch's rows; older rows' totals go to Archive Totals first.
    var purgeMsg = purgeOldArchiveRowsSafe_(batchId);

    // 5) Show the new (latest) batch
    ref.getRange(REFINING.selectorCell).clearContent();
    SpreadsheetApp.flush();
    ss.setActiveSheet(ref);
    ui.alert('Batch ' + batchId + ' created with ' + picked.length + ' items (' + moved + ' rows moved to Archive).\n' +
             (purgeMsg ? purgeMsg + '\n' : '') +
             'After you sell, fill Sell date and Sell base / gram (or Actual amount received) in the batch register (columns X-Z); ' +
             'it is then added to the Sales tab automatically (or use Gold Tracker > Record batch sale).');
  } finally {
    lock.releaseLock();
  }
}

// ---------- Archive (Purchases -> Archive) ----------
/**
 * Moves every Purchases row whose Status is Refined or Sold to the Archive tab: appends
 * A No., B Date, C Weight, E Purity, G Cost, K Status, L Sold date, M Sold amount, O Batch ID,
 * P Base / g (frozen), Q Archived on, then deletes the rows from Purchases bottom-up.
 * batchInfo (optional): { "<No.>": {batch, base} }; otherwise the batch/base come from the
 * Refining item list (matched by No.), else base = today's Settings base.
 * Call inside the document lock. Returns the number of rows moved.
 */
function archiveRows_(batchInfo, when) {
  var ss = SpreadsheetApp.getActive();
  var pur = ss.getSheetByName(PURCHASES.sheet);
  if (!pur) throw new Error('Purchases tab not found.');
  var c = PURCHASES.cols, A = ARCHIVE.cols;
  var last = pur.getLastRow();
  if (last < PURCHASES.firstDataRow) return 0;
  var n = last - PURCHASES.firstDataRow + 1;
  var wide = pur.getMaxColumns() >= BATCHNO.purCol;   // v8: Batch # (column O) comes along when present
  var bi = buyInfoOn_() && pur.getMaxColumns() >= BUYINFO.purQid;   // v10: Bought at / Quote ID (P, Q) too
  var data = pur.getRange(PURCHASES.firstDataRow, 1, n, bi ? BUYINFO.purQid : wide ? BATCHNO.purCol : PURCHASES.lastCol).getValues();
  var rows = [];
  data.forEach(function (r, i) {
    if (ARCHIVE_STATUSES.indexOf(String(r[c.status - 1]).trim()) >= 0) rows.push({ i: i, r: r });
  });
  if (!rows.length) return 0;

  // Give missing No.s a number so Archive/Refining always have a stable key.
  var nextNo = nextItemNo_();
  rows.forEach(function (x) { if (x.r[c.no - 1] === '' || x.r[c.no - 1] === null) x.r[c.no - 1] = nextNo++; });

  // Batch lookup from Refining (Item No. -> batch, base)
  var refInfo = {};
  var ref = ss.getSheetByName(REFINING.sheet);
  if (ref && ref.getLastRow() >= REFINING.firstDataRow) {
    ref.getRange(REFINING.firstDataRow, 1, ref.getLastRow() - REFINING.firstDataRow + 1, REFINING.itemCols).getValues()
      .forEach(function (v) { if (v[0] !== '' && v[2] !== '') refInfo[String(v[2])] = { batch: v[0], base: v[6] }; });
  }
  var curBase = getNamed_(SETTINGS.basePriceName);
  when = when || new Date();
  batchInfo = batchInfo || {};

  var out = rows.map(function (x) {
    var r = x.r, key = String(r[c.no - 1]);
    var info = batchInfo[key] || (String(r[c.status - 1]).trim() === 'Refined' ? refInfo[key] : null) || { batch: '', base: curBase };
    return { a: [r[0], r[c.date - 1], r[c.weightBhy - 1]], e: [r[c.purity - 1]], g: [r[c.cost - 1]],
             k: [r[c.status - 1], r[c.soldDate - 1], r[c.soldAmount - 1]],
             o: [info.batch, info.base === null ? '' : info.base, when],
             r: [wide && r[BATCHNO.purCol - 1] !== null ? r[BATCHNO.purCol - 1] : ''],
             t: bi ? [r[BUYINFO.purAt - 1], r[BUYINFO.purQid - 1]] : ['', ''] };
  });
  var anyB = out.some(function (o) { return o.r[0] !== ''; });
  var anyT = out.some(function (o) { return o.t[0] !== '' || o.t[1] !== ''; });

  var ar = getArchive_();
  if (anyB) ensureBatchNoCols_();
  if (anyT) { try { ensureBuyInfoCols_(); } catch (e) { anyT = false; } }   // v10 (never blocks refining)
  var start = firstEmptyRow_(ar, ARCHIVE.firstDataRow, [1, 3, 5, 7, 11]);
  ensureRows_(ar, start + out.length);
  var written = [];   // v10 review: the Archive blocks written, so a failure can clear exactly them
  var put = function (col, key, w) {
    written.push([col, w]);
    ar.getRange(start, col, out.length, w).setValues(out.map(function (o) { return o[key]; }));
  };
  var nos = out.map(function (o) { return o.a[0]; }), deleted = false;
  try {
    // Only input columns are written; D, F, H, I, J, N come from the row-1 ARRAYFORMULAs.
    put(1, 'a', 3); put(5, 'e', 1); put(7, 'g', 1); put(11, 'k', 3); put(A.batch, 'o', 3);
    if (anyB || ar.getMaxColumns() >= A.bno) put(A.bno, 'r', 1);   // v8 Batch #
    if (anyT || (buyInfoOn_() && ar.getMaxColumns() >= BUYINFO.arcQid)) put(BUYINFO.arcAt, 't', 2);   // v10 Bought at, Quote ID
    SpreadsheetApp.flush();

    // Verify the copy before deleting anything.
    var check = ar.getRange(start, 1, out.length, 7).getValues();
    for (var i = 0; i < out.length; i++) {
      if (String(check[i][0]) !== String(out[i].a[0]) || (out[i].g[0] !== '' && Number(check[i][6]) !== Number(out[i].g[0])))
        throw new Error('Archive copy check failed at Archive row ' + (start + i) + '; nothing was deleted from Purchases.');
    }

    // Keep enough rows so Sheets never refuses the delete, then delete bottom-up in runs.
    if (pur.getMaxRows() - rows.length < 50) pur.insertRowsAfter(pur.getMaxRows(), 100);
    var idx = rows.map(function (x) { return x.i; }).sort(function (a, b) { return b - a; });
    var k = 0;
    while (k < idx.length) {
      var hi = idx[k], lo = hi;
      while (k + 1 < idx.length && idx[k + 1] === lo - 1) { k++; lo = idx[k]; }
      deleted = true;   // from here on Purchases may have changed shape
      pur.deleteRows(PURCHASES.firstDataRow + lo, hi - lo + 1);
      k++;
    }
    SpreadsheetApp.flush();
  } catch (err) {
    // v10 review: tell the caller what is on the sheet now. Nothing deleted yet: the Archive rows written here are
    // cleared again, so the sheet is as before. Some deleted: Archive keeps every copied row (start .. start+n-1,
    // nos) and the caller re-matches by item No. (archiveRowsUndo_).
    err.archiveDeleted = deleted; err.archiveStart = start; err.archiveNos = nos;
    if (!deleted) {
      try { written.forEach(function (b) { ar.getRange(start, b[0], out.length, b[1]).clearContent(); }); SpreadsheetApp.flush(); err.archiveCleared = true; }
      catch (e2) { err.archiveCleared = false; err.message += ' (clearing the new Archive rows also failed: ' + e2.message + ')'; }
    }
    throw err;
  }
  return rows.length;
}
/**
 * v10 review: after archiveRows_ failed part way through its Purchases deletes (err.archiveDeleted), removes the
 * Archive copies of the rows that are STILL on Purchases (matched by item No. within the rows it wrote), so no item
 * is counted twice. Rows already deleted from Purchases stay on Archive (their only copy). Returns the No.s still on
 * Purchases (as numbers).
 */
function archiveRowsUndo_(err) {
  var ss = SpreadsheetApp.getActive(), pur = ss.getSheetByName(PURCHASES.sheet), ar = ss.getSheetByName(ARCHIVE.sheet);
  var onPur = {}, last = pur.getLastRow();
  if (last >= PURCHASES.firstDataRow) pur.getRange(PURCHASES.firstDataRow, PURCHASES.cols.no, last - PURCHASES.firstDataRow + 1, 1).getValues()
    .forEach(function (v) { if (v[0] !== '' && v[0] !== null) onPur[String(v[0])] = true; });
  var start = err.archiveStart, nos = err.archiveNos || [], still = [];
  if (ar && start && nos.length) {
    var got = ar.getRange(start, 1, nos.length, 1).getValues();
    if (ar.getMaxRows() - nos.length < 50) ar.insertRowsAfter(ar.getMaxRows(), 100);   // Sheets refuses to delete the last rows
    for (var i = nos.length - 1; i >= 0; i--) {   // bottom-up, so the rows above keep their place
      if (!onPur[String(nos[i])] || String(got[i][0]) !== String(nos[i])) continue;
      ar.deleteRow(start + i); still.push(Number(nos[i]));
    }
    SpreadsheetApp.flush();
  }
  return still;
}

// ---------- Archive: keep only the latest batch (v7) ----------
/**
 * Creates the Archive Totals tab if missing and links the Dashboard to it (idempotent).
 * Throws if a Dashboard figure that sums Archive cannot be linked, so callers never remove
 * Archive rows whose totals the Dashboard would then lose.
 */
function ensureArchiveTotals_() {
  var ss = SpreadsheetApp.getActive();
  var t = ss.getSheetByName(ARCHIVE_TOTALS.sheet);
  if (!t) {
    t = ss.insertSheet(ARCHIVE_TOTALS.sheet);
    t.getRange(1, 1, 1, ARCHIVE_TOTALS.headers.length).setValues([ARCHIVE_TOTALS.headers]);
    try {
      var pur = ss.getSheetByName(PURCHASES.sheet);
      if (pur) pur.getRange(1, 1).copyFormatToRange(t, 1, ARCHIVE_TOTALS.headers.length, 1, 1);
      var C = ARCHIVE_TOTALS.cols, rows = Math.max(t.getMaxRows() - 1, 1);
      t.getRange(2, C.removedOn, rows, 1).setNumberFormat('yyyy-mm-dd');
      t.getRange(2, C.buyMonth, rows, 2).setNumberFormat('mmm yyyy');
      t.getRange(2, C.grams, rows, 2).setNumberFormat('#,##0.000');
      t.getRange(2, C.cost, rows, 3).setNumberFormat('#,##0.00');
      t.getRange(2, C.lossAmt, rows, 3).setNumberFormat('#,##0.00');
      t.setFrozenRows(1);
    } catch (e) { /* formatting only */ }
  }
  linkDashboardToArchiveTotals_();
  return t;
}

/**
 * Dashboard formulas that sum the Archive tab also add the matching Archive Totals column.
 * Single figures (column B, found by their label in column A) get "+SUM('Archive Totals'!X2:X)";
 * the MONTHLY table (=MAP(...,LAMBDA(m, ...))) gets "+SUMIFS(...)" by purchase / sold month.
 * Already-linked formulas are left alone. Returns the number of formulas changed.
 */
function linkDashboardToArchiveTotals_() {
  var d = SpreadsheetApp.getActive().getSheetByName('Dashboard');
  if (!d) return 0;
  var T = "'" + ARCHIVE_TOTALS.sheet + "'!";
  var rows = Math.min(Math.max(d.getLastRow(), 1), 80);
  var labels = d.getRange(1, 1, rows, 1).getValues();
  var forms = d.getRange(1, 1, rows, 8).getFormulas();
  var single = [   // label in A -> Archive column it sums -> Archive Totals column to add
    { re: /^total cash used/i, arc: 'Archive!G', add: 'SUM(' + T + 'H2:H)' },
    { re: /^total grams/i, arc: 'Archive!D', add: 'SUM(' + T + 'F2:F)' },
    { re: /^total pure grams/i, arc: 'Archive!F', add: 'SUM(' + T + 'G2:G)' },
    { re: /^items purchased/i, arc: 'Archive!C', add: 'SUM(' + T + 'E2:E)' },
    { re: /^est\. sell value, all items/i, arc: 'Archive!I', add: 'SUM(' + T + 'I2:I)' },
    { re: /^est\. profit, all items/i, arc: 'Archive!J', add: 'SUM(' + T + 'J2:J)' },
    { re: /^losses \(count\)/i, arc: 'Archive!J', add: 'SUM(' + T + 'K2:K)' },
    { re: /^losses \(total/i, arc: 'Archive!J', add: 'SUM(' + T + 'L2:L)' },
    { re: /^realized profit, sold purchases/i, arc: 'Archive!N', add: 'SUM(' + T + 'N2:N)' }
  ];
  var month = function (col, dateCol) {
    return 'SUMIFS(' + T + col + '2:' + col + ',' + T + dateCol + '2:' + dateCol + ',">="&m,' + T + dateCol + '2:' + dateCol + ',"<"&EDATE(m,1))';
  };
  var monthly = [   // Archive column summed in the MAP formula -> Archive Totals addition
    { arc: 'Archive!G2:G', add: month('H', 'C') },   // Purchases cost by purchase month
    { arc: 'Archive!M2:M', add: month('M', 'D') },   // Sales received: sold amount by sold month
    { arc: 'Archive!N2:N', add: month('N', 'D') }    // Realized profit by sold month
  ];
  var changed = 0, missing = [];
  single.forEach(function (s) {
    for (var i = 0; i < labels.length; i++) {
      if (!s.re.test(String(labels[i][0]).trim())) continue;
      var f = String(forms[i][1] || '');
      if (f.indexOf(T) >= 0 || f.indexOf(s.arc) < 0) return;   // already linked / does not use Archive
      d.getRange(i + 1, 2).setFormula(f + '+' + s.add); changed++;
      return;
    }
  });
  for (var r = 0; r < forms.length; r++) {
    for (var c = 0; c < forms[r].length; c++) {
      var f = String(forms[r][c] || '');
      if (!/^=MAP\(/i.test(f) || f.indexOf('Archive!') < 0) continue;
      if (f.indexOf(T) >= 0) continue;
      var m = null;
      monthly.forEach(function (x) { if (!m && f.indexOf(x.arc) >= 0 && (x.arc !== 'Archive!M2:M' || f.indexOf('Archive!N2:N') < 0)) m = x; });
      if (!m || !/\)\)\s*$/.test(f)) { missing.push('Dashboard!' + String.fromCharCode(65 + c) + (r + 1)); continue; }
      d.getRange(r + 1, c + 1).setFormula(f.replace(/\)\)\s*$/, '+' + m.add + '))')); changed++;
    }
  }
  // Every Dashboard formula that still sums Archive must now also read Archive Totals.
  var after = d.getRange(1, 1, rows, 8).getFormulas();
  for (var r2 = 0; r2 < after.length; r2++) for (var c2 = 0; c2 < after[r2].length; c2++) {
    var g = String(after[r2][c2] || '');
    if (/Archive!/.test(g) && g.indexOf(T) < 0) missing.push('Dashboard!' + String.fromCharCode(65 + c2) + (r2 + 1));
  }
  if (missing.length) throw new Error('Could not link these Dashboard cells to Archive Totals: ' + missing.join(', ') +
                                      '. No Archive rows were removed.');
  if (changed) SpreadsheetApp.flush();
  return changed;
}

/** Menu: create Archive Totals and link the Dashboard (safe to run any time). */
function setupArchiveTotals() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  var msg;
  try { ensureArchiveTotals_(); msg = 'Archive Totals is ready and the Dashboard is linked to it.'; }
  catch (e) { msg = 'Archive Totals: ' + e.message; }
  finally { lock.releaseLock(); }
  try { SpreadsheetApp.getUi().alert('Archive Totals', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

/** Year-month key and first-of-month date for a date cell ('' when blank / not a date). */
function monthOf_(v) {
  if (!(v instanceof Date) && Object.prototype.toString.call(v) !== '[object Date]') return { key: '', date: '' };
  if (isNaN(v.getTime())) return { key: '', date: '' };
  var ym = Utilities.formatDate(v, TZ, 'yyyy-MM');
  return { key: ym, date: new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1) };
}

/**
 * Removes every Archive row whose Batch ID (col O) is not keepBatchId. v51: rows from a direct
 * sale (Batch ID starting with DS-) stay, with their original weight, purity and cost. First the
 * removed rows' totals are
 * written as fixed numbers to Archive Totals (grouped by batch, purchase month and sold month) and
 * checked; then the kept rows are rewritten to the top of Archive (input columns only, the row-1
 * ARRAYFORMULAs recalculate), the rest is cleared and spare rows at the bottom are deleted, so
 * 300+ rows take a handful of calls. On any error the Archive rows and the new totals rows are put
 * back as they were. Call inside the document lock. Returns {removed, kept, groups}.
 */
function purgeOldArchiveRows_(keepBatchId) {
  keepBatchId = String(keepBatchId || '').trim();
  if (!keepBatchId) throw new Error('No batch ID to keep.');
  var ss = SpreadsheetApp.getActive();
  var ar = ss.getSheetByName(ARCHIVE.sheet);
  var res = { removed: 0, kept: 0, groups: 0 };
  if (!ar) return res;
  var last = ar.getLastRow();
  if (last < ARCHIVE.firstDataRow) return res;
  var n = last - ARCHIVE.firstDataRow + 1;
  var W = Math.min(ARCHIVE.lastCol, ar.getMaxColumns());   // v8: R Batch # when the column exists
  if (ar.getMaxColumns() >= BUYINFO.arcQid && buyInfoOn_()) {   // v10: T, U (Bought at, Quote ID) move with their rows, only when they are ours
    var tu = ar.getRange(1, BUYINFO.arcAt, 1, 2).getValues()[0];
    if (tu[0] === BUYINFO.headers[0] && tu[1] === BUYINFO.headers[1]) W = BUYINFO.arcQid;
  }
  var data = ar.getRange(ARCHIVE.firstDataRow, 1, n, W).getValues();
  var INPUT = [1, 2, 3, 5, 7, 11, 12, 13, 15, 16, 17, 18, 20, 21].filter(function (c) { return c <= W; });   // A B C E G K L M O P Q R T U (S is a formula)
  var BLOCKS = [[1, 3], [5, 1], [7, 1], [11, 3], [15, 3]].concat(W >= 18 ? [[18, 1]] : [], W >= 21 ? [[20, 2]] : []);
  var blank = function (v) { return v === '' || v === null; };
  var keep = [], drop = [], batchKept = 0;
  data.forEach(function (r) {
    if (INPUT.every(function (c) { return blank(r[c - 1]); })) return;   // empty row
    var bid = String(r[ARCHIVE.cols.batch - 1]).trim();
    if (bid === keepBatchId || reservedDirectId_(bid)) { keep.push(r); if (bid === keepBatchId) batchKept++; }
    else drop.push(r);
  });
  res.kept = keep.length;
  if (!drop.length) return res;
  // Safety: the new batch must be on Archive before anything older is removed. Direct-sale rows alone do not count.
  if (!batchKept) throw new Error('Batch ' + keepBatchId + ' has no rows on Archive, so nothing was removed.');

  var tot = ensureArchiveTotals_();   // throws (nothing removed) if the Dashboard cannot be linked
  var bhy = getNamed_('BHYPerGram') || 2;
  var num = function (v) { var x = Number(v); return (blank(v) || !isFinite(x) || v instanceof Date) ? null : x; };
  var groups = {}, order = [], sumCost = 0;
  drop.forEach(function (r) {
    var bm = monthOf_(r[1]), sm = monthOf_(r[11]), bd = dayOf_(r[1]);
    var id = String(r[ARCHIVE.cols.batch - 1] || '').trim();
    var k = id + '|' + bm.key + '|' + sm.key + '|' + bd.key;   // v9: + purchase day
    var g = groups[k];
    if (!g) {
      g = groups[k] = { id: id, bm: bm.date, sm: sm.date, bd: bd.date, items: 0, grams: 0, pure: 0, cost: 0, sell: 0, profit: 0,
                        lossN: 0, lossAmt: 0, soldAmt: 0, realized: 0, maxNo: 0 };
      order.push(k);
    }
    var w = num(r[2]), p = num(r[4]), cost = num(r[6]), base = num(r[15]);
    var grams = num(r[3]); if (grams === null && w !== null) grams = w / bhy;
    var pure = num(r[5]); if (pure === null && w !== null && p !== null) pure = w / bhy * p;
    var sell = num(r[8]); if (sell === null && w !== null && p !== null && base !== null) sell = base * p * w / bhy;
    var prof = num(r[9]); if (prof === null && sell !== null && cost !== null) prof = sell - cost;
    var real = num(r[13]);
    if (real === null && String(r[10]).trim() === 'Sold' && num(r[12]) !== null && cost !== null) real = num(r[12]) - cost;
    if (w !== null) g.items++;                      // same as COUNT(Archive!C2:C)
    g.grams += grams || 0; g.pure += pure || 0; g.cost += cost || 0; sumCost += cost || 0;
    g.sell += sell || 0; g.profit += prof || 0;
    if (prof !== null && prof < 0) { g.lossN++; g.lossAmt += prof; }
    g.soldAmt += num(r[12]) || 0; g.realized += real || 0;
    var no = num(r[0]); if (no !== null && no > g.maxNo) g.maxNo = no;
  });
  var now = new Date();
  var out = order.map(function (k) {
    var g = groups[k];
    return [now, g.id, g.bm, g.sm, g.items, goldR_(g.grams, 6), goldR_(g.pure, 6), round2_(g.cost), round2_(g.sell),
            round2_(g.profit), g.lossN, round2_(g.lossAmt), round2_(g.soldAmt), round2_(g.realized), g.maxNo || '', g.bd];
  });
  res.groups = out.length;

  var tStart = firstEmptyRow_(tot, ARCHIVE_TOTALS.firstDataRow, [1, 2, 5, 8]);
  ensureRows_(tot, tStart + out.length);
  var TW = ARCHIVE_TOTALS.headers.length;
  if (tot.getMaxColumns() < TW) tot.insertColumnsAfter(tot.getMaxColumns(), TW - tot.getMaxColumns());
  if (String(tot.getRange(1, ARCHIVE_TOTALS.cols.buyDay).getValue()).trim() === '') {   // v9 header + date format on an older tab
    tot.getRange(1, ARCHIVE_TOTALS.cols.buyDay).setValue(ARCHIVE_TOTALS.headers[ARCHIVE_TOTALS.cols.buyDay - 1]);
    try { tot.getRange(2, ARCHIVE_TOTALS.cols.buyDay, Math.max(tot.getMaxRows() - 1, 1), 1).setNumberFormat('yyyy-mm-dd'); } catch (e) {}
  }
  var tRange = tot.getRange(tStart, 1, out.length, TW);
  var archiveTouched = false;
  try {
    tRange.setValues(out);
    SpreadsheetApp.flush();
    var back = tRange.getValues(), backCost = 0;
    back.forEach(function (x) { backCost += Number(x[ARCHIVE_TOTALS.cols.cost - 1]) || 0; });
    if (Math.abs(backCost - round2_(sumCost)) > 0.05 * out.length + 0.01) throw new Error('Archive Totals check failed (cost ' + backCost + ' vs ' + sumCost + ').');

    // Rewrite Archive: kept rows to the top, everything below cleared (input columns only).
    archiveTouched = true;
    BLOCKS.forEach(function (b) {   // [first column, width]
      var vals = data.map(function (_, i) {
        var src = keep[i];
        return src ? src.slice(b[0] - 1, b[0] - 1 + b[1]) : new Array(b[1]).fill('');
      });
      ar.getRange(ARCHIVE.firstDataRow, b[0], n, b[1]).setValues(vals);
    });
    SpreadsheetApp.flush();
    var chk = ar.getRange(ARCHIVE.firstDataRow, 1, Math.max(keep.length, 1), ARCHIVE.cols.batch).getValues();
    for (var i = 0; i < keep.length; i++) {
      var bidNow = String(chk[i][ARCHIVE.cols.batch - 1]).trim();
      var bidKeep = String(keep[i][ARCHIVE.cols.batch - 1]).trim();
      // The new batch's id, or a direct-sale id that was kept on purpose (v51).
      if (String(chk[i][0]) !== String(keep[i][0]) || bidNow !== bidKeep || (bidNow !== keepBatchId && !reservedDirectId_(bidNow)))
        throw new Error('Archive rewrite check failed at row ' + (ARCHIVE.firstDataRow + i) + '.');
    }
  } catch (err) {
    // Roll back: original Archive input columns and no new totals rows.
    try {
      if (archiveTouched) {
        BLOCKS.forEach(function (b) {
          ar.getRange(ARCHIVE.firstDataRow, b[0], n, b[1]).setValues(data.map(function (r) { return r.slice(b[0] - 1, b[0] - 1 + b[1]); }));
        });
      }
      tRange.clearContent();
      SpreadsheetApp.flush();
    } catch (e2) { err.message += ' (roll-back also failed: ' + e2.message + ')'; }
    throw err;
  }

  // Trim spare blank rows at the bottom (keeps ~200 empty rows for the next batch).
  try {
    var want = ARCHIVE.firstDataRow + keep.length + 200;
    var max = ar.getMaxRows();
    if (max > want + 50) ar.deleteRows(want + 1, max - want);
  } catch (e) { /* trimming is optional */ }
  SpreadsheetApp.flush();
  res.removed = drop.length;
  return res;
}

/** Batch refining wrapper: never fails the (already created) batch; returns a short note. */
function purgeOldArchiveRowsSafe_(keepBatchId) {
  try {
    var r = purgeOldArchiveRows_(keepBatchId);
    return r.removed ? r.removed + ' older Archive rows removed (their totals are kept on the Archive Totals tab).' : '';
  } catch (e) {
    return 'Older Archive rows were NOT removed: ' + e.message;
  }
}

/** v9: the purchase day of an Archive row (Manila), as a Date at midnight + a key; blank for no date. */
function dayOf_(v) {
  if (!(v instanceof Date) && Object.prototype.toString.call(v) !== '[object Date]') return { key: '', date: '' };
  if (isNaN(v.getTime())) return { key: '', date: '' };
  var k = Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return { key: k, date: new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10))) };
}
function goldR_(x, d) { var f = Math.pow(10, d); return Math.round(x * f) / f; }

/** Menu: move any Refined / Sold rows still on Purchases to Archive. */
function archiveRefinedSold() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  var n;
  try { n = archiveRows_(null, new Date()); } finally { lock.releaseLock(); }
  var msg = n ? n + ' Refined / Sold rows moved to the Archive tab.' : 'No Refined or Sold rows on Purchases.';
  try { SpreadsheetApp.getUi().alert('Archive refined/sold rows', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return n;
}

/** Archive: mark every item of a sold batch as Sold with the batch sell date (no Sold amount: the sale is in Sales). */
function markArchiveBatchSold_(batchId, sellDate) {
  var ar = SpreadsheetApp.getActive().getSheetByName(ARCHIVE.sheet);
  if (!ar || ar.getLastRow() < ARCHIVE.firstDataRow) return 0;
  var n = ar.getLastRow() - ARCHIVE.firstDataRow + 1;
  var st = ar.getRange(ARCHIVE.firstDataRow, 11, n, 2).getValues();          // K Status, L Sold date
  var ids = ar.getRange(ARCHIVE.firstDataRow, ARCHIVE.cols.batch, n, 1).getValues();
  var changed = 0;
  for (var i = 0; i < n; i++) {
    if (String(ids[i][0]) === String(batchId) && (st[i][0] !== 'Sold' || String(st[i][1]) !== String(sellDate))) {
      st[i][0] = 'Sold'; st[i][1] = sellDate; changed++;
    }
  }
  if (changed) ar.getRange(ARCHIVE.firstDataRow, 11, n, 2).setValues(st);
  return changed;
}

// ---------- Record batch sale (Refining -> Sales) ----------
/**
 * For every batch in the register with Sell date + (Sell base or Actual amount) filled and
 * "Recorded in Sales" (col AC) empty, appends ONE Sales row:
 *   A date = Sell date, B base = Sell base, C grams = refined grams, D est. value
 *   (refined grams x sell base, or batch est. value if no sell base), E cost = cost incl. fee,
 *   F actual received = Actual value (Z, else refined grams x sell base), I = batch ID,
 * then writes "Recorded in Sales" in AC so it is never added twice.
 * Realized profit therefore flows into the Dashboard only through the Sales tab.
 */
function recordBatchSales() {
  var res = syncBatchSales_(null);
  try { SpreadsheetApp.getUi().alert(res.message); } catch (e) { /* editor */ }
  return res.message;
}

/**
 * Simple trigger.
 *  - Purchases: any edit/paste that leaves a row with Weight, Purity or Cost filled and a blank
 *    Status sets Status to "In stock" (never overwrites Sold / Refined).
 *  - Refining: editing a batch's Sell date / Sell base / Actual amount (X:Z) records or updates it.
 */
function onEdit(e) {
  if (!e || !e.range) return;
  var name = e.range.getSheet().getName();
  if (name === PURCHASES.sheet) { defaultStatusOnEdit_(e); return; }
  if (name === REFINING.sheet) batchSaleOnEdit_(e);
}

/** Purchases: default blank Status to "In stock" on the edited rows that have purchase data. */
function defaultStatusOnEdit_(e) {
  try {
    var r1 = Math.max(e.range.getRow(), PURCHASES.firstDataRow), r2 = e.range.getLastRow();
    if (r2 < r1) return;
    var n = fillBlankStatuses_(e.range.getSheet(), r1, r2 - r1 + 1);
    if (n > 1) e.source.toast('Status set to "In stock" on ' + n + ' rows.', 'Gold Tracker', 4);
  } catch (err) {
    try { e.source.toast('Default status: ' + err.message, 'Gold Tracker', 8); } catch (x) {}
  }
}

/**
 * For rows r1..r1+count-1 where Weight (C), Purity (E) or Cost (G) is non-blank:
 *  - blank Status (K) -> "In stock" (Sold / Refined never overwritten)
 *  - blank No. (A)    -> next item number (continues after Purchases + Archive)
 * Only blank cells change. Returns the number of Status cells filled.
 */
function fillBlankStatuses_(sh, r1, count) {
  var c = PURCHASES.cols;
  var last = Math.min(r1 + count - 1, sh.getLastRow());
  if (last < r1) return 0;
  count = last - r1 + 1;
  var vals = sh.getRange(r1, 1, count, c.status).getValues();     // A..K
  var isBlank = function (x) { return x === '' || x === null || (typeof x === 'string' && x.trim() === ''); };
  var status = [], nos = [], changed = 0, noChanged = 0, nextNo = null;
  // v8: a new row typed in by hand also gets a Batch # (once batch numbers are set up)
  var bOn = batchNoOn_() && sh.getMaxColumns() >= BATCHNO.purCol;
  var bv = bOn ? sh.getRange(r1, BATCHNO.purCol, count, 1).getValues() : null, bChanged = 0, nextB = null;
  for (var i = 0; i < count; i++) {
    var v = vals[i], st = v[c.status - 1], no = v[c.no - 1];
    var hasData = !isBlank(v[c.weightBhy - 1]) || !isBlank(v[c.purity - 1]) || !isBlank(v[c.cost - 1]);
    if (hasData && isBlank(st)) { st = 'In stock'; changed++; }
    var newNo = hasData && isBlank(no);
    if (newNo) { if (nextNo === null) nextNo = nextItemNo_(); no = nextNo++; noChanged++; }
    if (bOn && newNo && String(st).trim() === 'In stock' && isBlank(bv[i][0])) { if (nextB === null) nextB = nextBatchNo_(sh); bv[i][0] = nextB++; bChanged++; }
    status.push([st]); nos.push([no]);
  }
  // One write per column; existing values are written back unchanged.
  if (changed) sh.getRange(r1, c.status, count, 1).setValues(status);
  if (noChanged) sh.getRange(r1, c.no, count, 1).setValues(nos);
  if (bChanged) { sh.getRange(r1, BATCHNO.purCol, count, 1).setValues(bv); setBatchNoLast_(nextB - 1); }
  return changed;
}

/** Menu: fill every blank Status on Purchases rows that have purchase data. */
function fillBlankStatuses() {
  var sh = SpreadsheetApp.getActive().getSheetByName(PURCHASES.sheet);
  if (!sh) throw new Error('Purchases tab not found');
  var last = sh.getLastRow();
  var n = last < PURCHASES.firstDataRow ? 0 : fillBlankStatuses_(sh, PURCHASES.firstDataRow, last - PURCHASES.firstDataRow + 1);
  SpreadsheetApp.getUi().alert('Fill blank statuses', n ? 'Status set to "In stock" on ' + n + ' rows (blank No. filled too).' : 'No blank statuses on rows with purchase data (blank No. filled if any).', SpreadsheetApp.getUi().ButtonSet.OK);
  return n;
}

/** Refining: editing a batch's Sell date / Sell base / Actual amount (X:Z) records or updates it. */
function batchSaleOnEdit_(e) {
  try {
    var sh = e.range.getSheet();
    var r = REFINING.reg;
    var c1 = e.range.getColumn(), c2 = e.range.getLastColumn();
    if (c2 < r.sellDate || c1 > r.actualAmt) return;
    var r1 = Math.max(e.range.getRow(), REFINING.firstDataRow), r2 = e.range.getLastRow();
    if (r2 < r1) return;
    var rows = [];
    for (var i = r1; i <= r2; i++) rows.push(i);
    var res = syncBatchSales_(rows);
    if (res.added || res.updated) e.source.toast(res.message, 'Gold Tracker', 6);
  } catch (err) {
    try { e.source.toast('Record batch sale: ' + err.message, 'Gold Tracker', 8); } catch (x) {}
  }
}

/**
 * rows = null: menu run, append every eligible batch not yet recorded.
 * rows = [sheet rows]: edit run, append those if eligible, or update their existing Sales row
 * (matched by batch ID in Sales column I) when the sell cells are corrected after recording.
 */
function syncBatchSales_(rows) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try { return syncBatchSalesCore_(rows); }
  finally { lock.releaseLock(); }
}
/** Sale-sync body. No lock. Api.gs calls this while goldApiHandle_ already holds the document lock. */
function syncBatchSalesCore_(rows) {
  var ss = SpreadsheetApp.getActive();
  var ref = ss.getSheetByName(REFINING.sheet);
  var sales = ss.getSheetByName(SALES.sheet);
  if (!ref || !sales) throw new Error('Refining or Sales tab not found.');
  var R = REFINING.reg, first = REFINING.firstDataRow;
  SpreadsheetApp.flush();  // make sure register formulas (R, T, U, AA) are recalculated
    var last = ref.getLastRow();
    if (last < first) return { added: 0, updated: 0, message: 'No refining batches yet.' };
    var width = R.recorded - R.id + 1;
    var reg = ref.getRange(first, R.id, last - first + 1, width).getValues();
    var col = function (row, c) { return row[c - R.id]; };
    var blank = function (v) { return v === '' || v === null; };

    // Existing Sales rows by batch ID
    var sLast = sales.getLastRow();
    var byBatch = {};
    if (sLast >= SALES.firstDataRow) {
      sales.getRange(SALES.firstDataRow, SALES.batchCol, sLast - SALES.firstDataRow + 1, 1).getValues()
        .forEach(function (v, i) { if (!blank(v[0])) byBatch[String(v[0])] = SALES.firstDataRow + i; });
    }

    var want = null;
    if (rows) { want = {}; rows.forEach(function (r) { want[r] = true; }); }
    var added = [], updated = [], skipped = [], reserved = [];
    for (var i = 0; i < reg.length; i++) {
      var sheetRow = first + i;
      if (want && !want[sheetRow]) continue;
      var row = reg[i];
      var id = col(row, R.id);
      if (blank(id)) continue;
      id = String(id);
      if (reservedDirectId_(id)) { reserved.push(id); continue; }   // v51: never overwrite a direct sale
      var sellDate = col(row, R.sellDate), sellBase = col(row, R.sellBase), amt = col(row, R.actualAmt);
      var eligible = !blank(sellDate) && (!blank(sellBase) || !blank(amt));
      var recorded = !blank(col(row, R.recorded));
      if (!eligible) { if (!recorded && (!blank(sellDate) || !blank(sellBase) || !blank(amt))) skipped.push(id); continue; }

      var grams = Number(col(row, R.refinedG)) || 0;
      var base = blank(sellBase) ? '' : Number(sellBase);
      var estValue = base === '' ? Number(col(row, R.estValue)) || 0 : round2_(grams * base);
      var cost = round2_(Number(col(row, R.costInclFee)) || 0);
      var actual = blank(amt) ? round2_(grams * base) : Number(amt);
      var values = [[sellDate, base, round2_(grams * 1000) / 1000, estValue, cost, actual]];

      var existingRow = byBatch[id];
      if (existingRow) {
        // Already in Sales: update in place (only on edits, or if AC was blank) - never duplicate.
        if (rows || !recorded) {
          sales.getRange(existingRow, 1, 1, 6).setValues(values);
          markArchiveBatchSold_(id, sellDate);
          updated.push(id + ' (row ' + existingRow + ')');
        }
        if (!recorded) ref.getRange(sheetRow, R.recorded).setValue('Recorded in Sales');
        continue;
      }
      if (recorded) continue;  // marked recorded but its Sales row was removed by the user: leave it
      var target = firstEmptyRow_(sales, SALES.firstDataRow, colValues_(SALES.cols));
      ensureRows_(sales, target);
      sales.getRange(target, 1, 1, 6).setValues(values);
      sales.getRange(target, SALES.batchCol).setValue(id);
      byBatch[id] = target;
      ref.getRange(sheetRow, R.recorded).setValue('Recorded in Sales');
      markArchiveBatchSold_(id, sellDate);
      added.push(id + ' (row ' + target + ', profit PHP ' + Math.round(actual - cost).toLocaleString() + ')');
    }
    SpreadsheetApp.flush();
    var msg = [];
    if (added.length) msg.push('Added to Sales: ' + added.join('; '));
    if (updated.length) msg.push('Updated in Sales: ' + updated.join('; '));
    if (!rows && skipped.length) msg.push('Incomplete (need Sell date + Sell base or Actual amount): ' + skipped.join(', '));
    if (reserved.length) msg.push('Skipped (DS- is reserved for direct sales): ' + reserved.join(', '));
    if (!msg.length) msg.push('No sold batches waiting to be recorded.');
    return { added: added.length, updated: updated.length, message: msg.join('\n') };
}

// ---------- Base price updater ----------
/**
 * Weekdays (Mon-Fri, Manila): BSP Reference Exchange Rate Bulletin.
 *   base = (GOLD BUYING USD/oz x BSP Buying Rate T/T PHP/USD) / 31.1034768 + WeekdayAdjust (-200)
 *   Accepted only when the bulletin date = today (Manila); otherwise base unchanged.
 * Weekends: goldprice.org spot (https://data-asg.goldprice.org/dbXRates/PHP, items[0].xauPrice PHP/oz)
 *   base = xauPrice / 31.1034768 + WeekendAdjust (-200)
 * The base price is never changed on failure; the reason goes to "Last update status".
 */
function updateBasePriceNow() {
  var res = runBasePriceUpdate_('manual');
  try { SpreadsheetApp.getActive().toast(res.status, 'Base price update', 10); } catch (e) {}
  try { SpreadsheetApp.getUi().alert('Base price update', res.status, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { Logger.log(res.status); /* run from editor / trigger */ }
  return res.status;
}

/** Entry point for the daily trigger. */
function dailyBasePriceUpdate() { return runBasePriceUpdate_('daily trigger').status; }

/** Wraps every path: whatever happens, a status ends up in Settings B23 and is returned. */
function runBasePriceUpdate_(how) {
  var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  var res;
  try {
    writeStatus_('Running (' + how + ') ' + now + ' ...');
    SpreadsheetApp.flush();
    res = updateBasePrice_();
    if (!res || !res.status) res = { ok: false, status: 'FAILED ' + now + ': updater returned no result. Base price left unchanged.' };
  } catch (e) {
    res = { ok: false, status: 'FAILED ' + now + ' (' + how + '): ' + (e && e.message ? e.message : e) + '. Base price left unchanged.' };
  }
  try { writeStatus_(res.status); SpreadsheetApp.flush(); } catch (e2) { res.status += ' (could not write status: ' + e2.message + ')'; }
  return res;
}

function updateBasePrice_() {
  var dow = Number(Utilities.formatDate(new Date(), TZ, 'u')); // 1=Mon ... 7=Sun
  if (!(dow >= 1 && dow <= 7)) throw new Error('could not work out the weekday (got "' + dow + '")');
  return (dow >= 6) ? updateFromGoldprice_() : updateFromBsp_();
}

/** Writes only the status cell (Settings B23). */
function writeStatus_(text) {
  var sh = SpreadsheetApp.getActive().getSheetByName(SETTINGS.sheet);
  if (!sh) throw new Error('Settings tab not found');
  sh.getRange(SETTINGS.statusCell).setValue(String(text));
}

/**
 * Reads an adjustment (WeekdayAdjust / WeekendAdjust). Rejects blanks, text, dates (a cell
 * formatted as a date returns a Date object) and silly values, falling back to the default.
 */
function readAdjust_(name, def) {
  var r = SpreadsheetApp.getActive().getRangeByName(name);
  var v = r ? r.getValue() : null;
  var note = '';
  var n = (v instanceof Date || v === '' || v === null) ? NaN : Number(v);
  if (!isFinite(n) || Math.abs(n) > 2000) {
    note = ' [' + name + ' unreadable (' + (r ? String(v) : 'named range missing') + '), used ' + def + ']';
    n = def;
  }
  return { value: n, note: note };
}

function readTroyOz_() {
  var n = getNamed_(SETTINGS.troyOzName);
  return (n && isFinite(n) && n > 30 && n < 32) ? n : TROY_OZ_GRAMS_DEFAULT;
}

function writeResult_(fields) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(SETTINGS.sheet);
  if (!sh) throw new Error('Settings tab not found');
  if (fields.base !== undefined && fields.base !== null) {
    if (!isFinite(fields.base) || fields.base < 1000 || fields.base > 50000)
      throw new Error('computed base PHP ' + fields.base + ' looks wrong (outside 1,000-50,000), not written');
    var baseRange = ss.getRangeByName(SETTINGS.basePriceName);
    if (!baseRange) throw new Error('named range ' + SETTINGS.basePriceName + ' not found');
  }
  var map = {
    source: SETTINGS.sourceCell, priceDate: SETTINGS.priceDateCell, goldUsd: SETTINGS.goldUsdCell,
    bspRate: SETTINGS.bspRateCell, goldPhpOz: SETTINGS.goldPhpOzCell, perGramRaw: SETTINGS.perGramRawCell
  };
  Object.keys(map).forEach(function (k) {
    if (fields.hasOwnProperty(k)) sh.getRange(map[k]).setValue(fields[k]);
  });
  if (fields.base !== undefined && fields.base !== null) {
    baseRange.setValue(fields.base);
    sh.getRange(SETTINGS.lastUpdatedCell).setValue(new Date());
  }
  sh.getRange(SETTINGS.statusCell).setValue(String(fields.status));
}

function round2_(x) { return roundAway_(x, 2); }

function fmt_(x, d) { return Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }

// ----- Weekend: goldprice.org -----
function updateFromGoldprice_() {
  var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  try {
    var resp = UrlFetchApp.fetch('https://data-asg.goldprice.org/dbXRates/PHP', {
      muteHttpExceptions: true,
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://goldprice.org/' }
    });
    if (resp.getResponseCode() !== 200) throw new Error('goldprice.org HTTP ' + resp.getResponseCode());
    var j;
    try { j = JSON.parse(resp.getContentText()); }
    catch (pe) { throw new Error('goldprice.org did not return JSON (' + resp.getContentText().substring(0, 80) + ')'); }
    var xau = j && j.items && j.items[0] && Number(j.items[0].xauPrice);
    if (!xau || !isFinite(xau)) throw new Error('xauPrice missing in goldprice.org response');
    var oz = readTroyOz_();
    var adjR = readAdjust_(SETTINGS.weekendAdjName, -200), adj = adjR.value;
    var perGram = xau / oz;
    var base = round2_(perGram + adj);
    var priceDate = j.date ? String(j.date) : todayStr_();
    writeResult_({
      source: 'goldprice.org spot (weekend)', priceDate: priceDate, goldUsd: '', bspRate: '',
      goldPhpOz: round2_(xau), perGramRaw: round2_(perGram), base: base,
      status: 'OK ' + now + ' (weekend): goldprice.org PHP ' + fmt_(xau, 2) + '/oz = PHP ' + fmt_(perGram, 2) +
              '/g, ' + (adj >= 0 ? '+' : '') + adj + ' = PHP ' + fmt_(base, 2) + '/g' + adjR.note
    });
    return { ok: true, status: 'OK ' + now + ': base updated to PHP ' + fmt_(base, 2) + '/g (goldprice.org, weekend rule: PHP ' +
             fmt_(xau, 2) + '/oz / 31.1034768 ' + (adj >= 0 ? '+ ' : '- ') + Math.abs(adj) + ').' + adjR.note };
  } catch (e) {
    var s = 'FAILED ' + now + ' (weekend, goldprice.org): ' + e.message + '. Base price left unchanged.';
    try { writeResult_({ status: s }); } catch (we) { /* runBasePriceUpdate_ writes it */ }
    return { ok: false, status: s };
  }
}

// ----- Weekdays: BSP Reference Exchange Rate Bulletin -----
var BSP_SOURCES = [
  // 1) SharePoint list the bulletin page appears to read (field names not public; parsed generically)
  { kind: 'json', url: "https://www.bsp.gov.ph/_api/web/lists/getByTitle('Exchange%20Rate')/items?$select=*&$top=500" },
  // 2) The bulletin page itself (works only if the numbers are in the served HTML)
  { kind: 'html', url: 'https://www.bsp.gov.ph/sitepages/statistics/exchangerate.aspx' },
  // 3) Legacy bulletin page (same 'BSP Buying Rate (T/T)' / 'GOLD BUYING' layout); date check rejects stale data
  { kind: 'html', url: 'https://www.bsp.gov.ph/Pages/Statistics/Statistical_Reports_and_Publications/ExchRate.aspx' }
];

function updateFromBsp_() {
  var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  var today = todayStr_();
  var notes = [];
  var found = null;

  for (var i = 0; i < BSP_SOURCES.length && !found; i++) {
    var src = BSP_SOURCES[i];
    try {
      var resp = UrlFetchApp.fetch(src.url, {
        muteHttpExceptions: true, followRedirects: true,
        headers: {
          'User-Agent': UA,
          'Accept': src.kind === 'json' ? 'application/json;odata=nometadata' : 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.bsp.gov.ph/sitepages/statistics/exchangerate.aspx'
        }
      });
      var code = resp.getResponseCode();
      if (code !== 200) { notes.push('src' + (i + 1) + ' HTTP ' + code); continue; }
      var body = resp.getContentText();
      var r = (src.kind === 'json') ? parseBspJson_(body) : parseBspText_(htmlToText_(body));
      if (r.goldUsd && r.bspRate) { r.url = src.url; found = r; }
      else notes.push('src' + (i + 1) + ' no gold/rate found');
    } catch (e) {
      notes.push('src' + (i + 1) + ' ' + e.message);
    }
  }

  if (!found) {
    var s = 'FAILED ' + now + ' (weekday, BSP): could not read GOLD BUYING / BSP Buying Rate (' + notes.join('; ') +
            '). Base price left unchanged.';
    writeResult_({ status: s });
    return { ok: false, status: s };
  }

  if (!found.date) {
    var s2 = 'FAILED ' + now + ' (weekday, BSP): bulletin date not found, so it cannot be confirmed as today. Base unchanged.';
    writeResult_({ source: 'BSP bulletin', goldUsd: found.goldUsd, bspRate: found.bspRate, status: s2 });
    return { ok: false, status: s2 };
  }
  if (found.date !== today) {
    var s3 = 'Bulletin not yet updated for today (' + now + '): latest BSP bulletin is ' + found.date +
             '. Base price left unchanged.';
    writeResult_({ source: 'BSP bulletin', priceDate: found.date, goldUsd: found.goldUsd, bspRate: found.bspRate, status: s3 });
    return { ok: false, status: s3 };
  }

  var oz = readTroyOz_();
  var adjR = readAdjust_(SETTINGS.weekdayAdjName, -200), adj = adjR.value;
  var phpOz = found.goldUsd * found.bspRate;
  var perGram = phpOz / oz;
  var base = round2_(perGram + adj);
  writeResult_({
    source: 'BSP Reference Exchange Rate Bulletin (weekday)', priceDate: found.date,
    goldUsd: found.goldUsd, bspRate: found.bspRate, goldPhpOz: round2_(phpOz), perGramRaw: round2_(perGram),
    base: base,
    status: 'OK ' + now + ' (weekday): BSP ' + found.date + ' gold USD ' + fmt_(found.goldUsd, 2) + ' x PHP ' +
            fmt_(found.bspRate, 3) + ' / 31.1034768 = PHP ' + fmt_(perGram, 2) + '/g, ' + (adj >= 0 ? '+' : '') + adj +
            ' = PHP ' + fmt_(base, 2) + '/g' + adjR.note
  });
  return { ok: true, status: 'OK ' + now + ': base updated to PHP ' + fmt_(base, 2) + '/g (BSP bulletin ' + found.date + ').' + adjR.note };
}

function htmlToText_(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#36;/g, '$')
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(Number(d)); })
    .replace(/\s+/g, ' ');
}

function num_(s) { var n = Number(String(s).replace(/,/g, '')); return isFinite(n) ? n : null; }

/** Finds GOLD BUYING (USD/oz), BSP Buying Rate T/T (PHP/USD) and the bulletin date in plain text. */
function parseBspText_(text) {
  var out = { goldUsd: null, bspRate: null, date: null };
  var g = text.match(/GOLD\s*BUYING\s*:?\s*(?:US\s*)?\$?\s*([\d,]+(?:\.\d+)?)/i);
  if (g) out.goldUsd = num_(g[1]);
  var b = text.match(/BSP\s*Buying\s*Rate\s*\(?\s*T\s*\/\s*T\s*\)?\s*:?\s*(?:PHP|₱|P)?\s*([\d,]+(?:\.\d+)?)/i);
  if (b) out.bspRate = num_(b[1]);
  out.date = findDate_(text);
  if (out.goldUsd !== null && (out.goldUsd < 300 || out.goldUsd > 20000)) out.goldUsd = null;   // sanity
  if (out.bspRate !== null && (out.bspRate < 20 || out.bspRate > 200)) out.bspRate = null;
  return out;
}

/**
 * SharePoint list JSON. Field names are not documented publicly, so: flatten every item to
 * "field: value" text and reuse the text parser; also look for items whose text names
 * GOLD / BSP Buying Rate with a numeric field, and for a date-like field.
 */
function parseBspJson_(body) {
  var j;
  try { j = JSON.parse(body); } catch (e) { return parseBspText_(htmlToText_(body)); }
  var items = (j && (j.value || (j.d && (j.d.results || j.d)))) || [];
  if (!items.length) return { goldUsd: null, bspRate: null, date: null };
  var lines = [];
  var out = { goldUsd: null, bspRate: null, date: null };
  var dateCands = [];
  items.forEach(function (it) {
    var parts = [];
    Object.keys(it).forEach(function (k) {
      var v = it[k];
      if (v === null || typeof v === 'object') return;
      parts.push(k + ': ' + v);
      if (/date|asof|bulletin|period/i.test(k) && !/^(Modified|Created)$/i.test(k)) {
        var d = findDate_(String(v)); if (d) dateCands.push(d);
      }
    });
    var t = parts.join(' | ');
    lines.push(t);
    var nums = parts.map(function (p) { return num_(p.split(': ').slice(1).join(': ')); })
                    .filter(function (n) { return n !== null; });
    if (out.goldUsd === null && /gold/i.test(t)) {
      var gn = nums.filter(function (n) { return n >= 300 && n <= 20000; });
      if (gn.length) out.goldUsd = gn[0];
    }
    if (out.bspRate === null && /buying\s*rate/i.test(t) && !/gold|silver/i.test(t)) {
      var bn = nums.filter(function (n) { return n >= 20 && n <= 200; });
      if (bn.length) out.bspRate = bn[0];
    }
  });
  var fromText = parseBspText_(lines.join(' \n '));
  out.goldUsd = out.goldUsd || fromText.goldUsd;
  out.bspRate = out.bspRate || fromText.bspRate;
  dateCands.sort();
  out.date = dateCands.length ? dateCands[dateCands.length - 1] : fromText.date;
  return out;
}

/** Returns yyyy-MM-dd for the first recognisable bulletin date in text, else null. */
function findDate_(text) {
  var months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function mk(y, m, d) { return (y && m && d) ? (y + '-' + pad(m) + '-' + pad(d)) : null; }
  var m;
  // ISO 2026-10-16 or 2026-10-16T...
  if ((m = text.match(/\b(20\d{2})-(\d{2})-(\d{2})/))) return mk(+m[1], +m[2], +m[3]);
  // October 16, 2026
  if ((m = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})/i)))
    return mk(+m[3], months[m[1].toLowerCase()], +m[2]);
  // 16 October 2026 / 16-Oct-2026
  if ((m = text.match(/\b(\d{1,2})[\s\-]+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\.?[\s\-,]+(20\d{2})/i)))
    return mk(+m[3], months[m[2].toLowerCase()], +m[1]);
  // 10/16/2026 (US order)
  if ((m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/))) return mk(+m[3], +m[1], +m[2]);
  return null;
}

/** Diagnostic: run from the editor to see what each BSP source returns (View > Logs). */
function debugBspSources() {
  BSP_SOURCES.forEach(function (src, i) {
    try {
      var resp = UrlFetchApp.fetch(src.url, { muteHttpExceptions: true, headers: { 'User-Agent': UA,
        'Accept': src.kind === 'json' ? 'application/json;odata=nometadata' : 'text/html' } });
      var body = resp.getContentText();
      var parsed = src.kind === 'json' ? parseBspJson_(body) : parseBspText_(htmlToText_(body));
      Logger.log('src' + (i + 1) + ' HTTP ' + resp.getResponseCode() + ' parsed=' + JSON.stringify(parsed) +
                 '\n' + body.substring(0, 1500));
    } catch (e) { Logger.log('src' + (i + 1) + ' error ' + e.message); }
  });
}

/**
 * v11: does not create (or delete) a trigger. The Gold Price Reports bot already sets the daily
 * base on this live sheet; a second 6pm trigger would overwrite it. Kept so an old menu click or
 * a leftover editor run cannot reinstall the trigger. Use "Update base price now" for a one-off.
 */
function installDailyTrigger() {
  var msg = 'Not installed. The Gold Price Reports bot already sets the daily base. A second 6pm trigger would overwrite it. Use “Update base price now” only if you need a one-off update.';
  try { SpreadsheetApp.getUi().alert('Daily base-price update', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* editor */ }
  return msg;
}

// ---------- v11: Maintenance (Iyam runs these; they never run on deploy) ----------
// Each tool is Preview (read only) → Apply (backup first) → Verify, with a Rollback.
// Do not call Apply from a trigger, from onOpen, or from the web app.

var TRIM_SOLD = {
  backupPrefix: 'Refining backup ',
  prop: 'trimSoldBatchItems',
  firstFrozen: 32,   // AF: after AE (Actual refined grams (app))
  // frozen columns: AF items, AG raw g, AH refined g, AI cost incl. fee, AJ est. value, AK silver g, AL items cost
  headers: ['Frozen items', 'Frozen raw g', 'Frozen refined g', 'Frozen cost incl. fee', 'Frozen est. value', 'Frozen silver g', 'Frozen items cost'],
  lockMs: 30000
};

function colLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function maintAlert_(title, msg) {
  Logger.log(title + ': ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)));
  try { SpreadsheetApp.getUi().alert(title, typeof msg === 'string' ? msg : JSON.stringify(msg, null, 1), SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}

function trimSoldState_() {
  try {
    var raw = PropertiesService.getDocumentProperties().getProperty(TRIM_SOLD.prop);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function trimSoldIsSold_(sellDate, sellBase, actualAmt) {
  return sellDate !== '' && sellDate !== null && sellDate !== undefined &&
         (sellBase !== '' && sellBase !== null && sellBase !== undefined ||
          actualAmt !== '' && actualAmt !== null && actualAmt !== undefined);
}

/**
 * Read-only snapshot of the Refining register, item rows, and All-batches totals.
 * Used by preview, apply (before any write), and verify.
 */
function trimSoldSnapshot_(ref) {
  var R = REFINING.reg, first = REFINING.firstDataRow, last = ref.getLastRow();
  var width = Math.max(ref.getMaxColumns(), TRIM_SOLD.firstFrozen + TRIM_SOLD.headers.length - 1);
  var fee = getNamed_('RefiningFee') || 0;
  var out = { fee: fee, last: last, batches: [], soldIds: [], unsoldIds: [], soldItems: 0, unsoldItems: 0, allBatches: {}, itemsByBatch: {} };
  if (last < first) return out;
  var n = last - first + 1;
  var items = ref.getRange(first, 1, n, 7).getValues();
  var regW = Math.min(width, 31) - R.id + 1;
  var reg = ref.getRange(first, R.id, n, regW).getValues();
  var i, id, row, rec;
  for (i = 0; i < reg.length; i++) {
    id = reg[i][0];
    if (id === '' || id === null) continue;
    rec = {
      id: String(id), row: first + i,
      date: reg[i][1], base: reg[i][2],
      items: Number(reg[i][R.id + 3 - R.id]) || 0,          // P
      rawG: Number(reg[i][4]) || 0,                          // Q
      refinedG: Number(reg[i][R.refinedG - R.id]) || 0,      // R
      costInclFee: Number(reg[i][R.costInclFee - R.id]) || 0,
      estValue: Number(reg[i][R.estValue - R.id]) || 0,
      estProfit: Number(reg[i][R.estValue + 1 - R.id]) || 0,
      silverG: Number(reg[i][R.estValue + 2 - R.id]) || 0,
      sellDate: reg[i][R.sellDate - R.id],
      sellBase: reg[i][R.sellBase - R.id],
      actualAmt: reg[i][R.actualAmt - R.id],
      recorded: reg[i][R.recorded - R.id]
    };
    rec.sold = trimSoldIsSold_(rec.sellDate, rec.sellBase, rec.actualAmt);
    rec.itemsCost = round2_(rec.costInclFee - fee);
    out.batches.push(rec);
    if (rec.sold) out.soldIds.push(rec.id); else out.unsoldIds.push(rec.id);
    out.itemsByBatch[rec.id] = [];
  }
  for (i = 0; i < items.length; i++) {
    id = items[i][0];
    if (id === '' || id === null || items[i][3] === '' || items[i][3] === null) continue;
    id = String(id);
    out.itemsByBatch[id] = out.itemsByBatch[id] || [];
    out.itemsByBatch[id].push({ row: first + i, vals: items[i].slice() });
  }
  out.batches.forEach(function (b) {
    var k = (out.itemsByBatch[b.id] || []).length;
    if (b.sold) out.soldItems += k; else out.unsoldItems += k;
    b.itemRows = k;
  });
  // All-batches figures currently shown in column C (must stay the same after trim).
  out.allBatches = {
    items: Number(ref.getRange('C6').getValue()) || 0,
    rawG: Number(ref.getRange('C7').getValue()) || 0,
    refinedG: Number(ref.getRange('C8').getValue()) || 0,
    costItems: Number(ref.getRange('C10').getValue()) || 0,
    fee: Number(ref.getRange('C11').getValue()) || 0,
    costInclFee: Number(ref.getRange('C12').getValue()) || 0,
    estValue: Number(ref.getRange('C13').getValue()) || 0,
    estProfit: Number(ref.getRange('C14').getValue()) || 0,
    actualValue: Number(ref.getRange('C16').getValue()) || 0
  };
  return out;
}

function trimSoldSummary_(snap, extra) {
  var lines = [];
  lines.push((snap.batches || []).length + ' batches: ' + snap.soldIds.length + ' sold (' + snap.soldItems + ' item rows), ' +
             snap.unsoldIds.length + ' unsold (' + snap.unsoldItems + ' item rows).');
  (snap.batches || []).forEach(function (b) {
    lines.push('  ' + b.id + (b.sold ? ' SOLD' : ' open') + ': register items ' + b.items + ', item rows ' + b.itemRows +
               ', cost incl. fee ' + b.costInclFee);
  });
  var a = snap.allBatches || {};
  lines.push('All batches (column C): items ' + a.items + ', raw g ' + a.rawG + ', refined g ' + a.refinedG +
             ', cost of items ' + a.costItems + ', fee ' + a.fee + ', cost incl. fee ' + a.costInclFee +
             ', est. value ' + a.estValue + ', actual value ' + a.actualValue);
  if (extra) lines.push(extra);
  return lines.join('\n');
}

function trimSoldBatchItemsPreview() {
  var ref = SpreadsheetApp.getActive().getSheetByName(REFINING.sheet);
  if (!ref) throw new Error('Refining tab not found.');
  var snap = trimSoldSnapshot_(ref);
  var extra = 'Apply will: (1) copy this tab to a hidden backup, (2) freeze sold-batch register totals into AF:AL, ' +
              '(3) point the register and All-batches formulas at those frozen values when item rows are gone, ' +
              '(4) keep unsold item rows (compacted in A:G; register rows in M:AE are never deleted), (5) verify totals match. ' +
              'Nothing runs automatically. Undo last batch is unchanged: it only works on the newest unsold batch, whose items stay.';
  return maintAlert_('Preview: trim sold batch items', trimSoldSummary_(snap, extra));
}

function trimSoldFormulas_() {
  var AF = colLetter_(TRIM_SOLD.firstFrozen), AG = colLetter_(TRIM_SOLD.firstFrozen + 1),
      AH = colLetter_(TRIM_SOLD.firstFrozen + 2), AI = colLetter_(TRIM_SOLD.firstFrozen + 3),
      AJ = colLetter_(TRIM_SOLD.firstFrozen + 4), AK = colLetter_(TRIM_SOLD.firstFrozen + 5),
      AL = colLetter_(TRIM_SOLD.firstFrozen + 6);
  var has = 'COUNTIF($A$19:$A,M19:M)>0';
  return {
    P: '={"Items";ARRAYFORMULA(IF(M19:M="","",IF(' + has + ',COUNTIF($A$19:$A,M19:M),' + AF + '19:' + AF + ')))}',
    Q: '={"Raw grams";ARRAYFORMULA(IF(M19:M="","",IF(' + has + ',SUMIF($A$19:$A,M19:M,$H$19:$H),' + AG + '19:' + AG + ')))}',
    R: '={"Refined grams";ARRAYFORMULA(IF(M19:M="","",IF(' + has + ',SUMIF($A$19:$A,M19:M,$I$19:$I),' + AH + '19:' + AH + ')))}',
    T: '={"Cost incl. fee";ARRAYFORMULA(IF(M19:M="","",IF(' + has + ',SUMIF($A$19:$A,M19:M,$F$19:$F)+IF(AM19:AM=1,0,RefiningFee),' + AI + '19:' + AI + ')))}',
    U: '={"Est. value";ARRAYFORMULA(IF(M19:M="","",IF(' + has + ',SUMIF($A$19:$A,M19:M,$J$19:$J),' + AJ + '19:' + AJ + ')))}',
    W: '={"Silver needed for refining (g)";ARRAYFORMULA(IF(M19:M="","",IF(' + has + ',IFERROR(LET(raw,SUMIFS($H$19:$H,$A$19:$A,M19:M,$E$19:$E,"<"&FullBaseMinPurity),ref,SUMIFS($I$19:$I,$A$19:$A,M19:M,$E$19:$E,"<"&FullBaseMinPurity),(ref*(ref/raw)/SilverDivisor)*SilverMultiplier-ref),0),' + AK + '19:' + AK + ')))}',
    // All-batches (column C) now sums the register, so sold batches still count after their item rows are gone.
    C6: '=SUM(P19:P)',
    C7: '=SUM(Q19:Q)',
    C8: '=SUM(R19:R)',
    C10: '=SUM(F19:F)+SUM(' + AL + '19:' + AL + ')',
    C11: '=C12-C10',
    C12: '=SUM(T19:T)',
    C13: '=SUM(U19:U)',
    C16: '=SUM(AA19:AA)',
    // Selected batch: always the register (live or frozen).
    B6: '=IF($B$4="",0,IFERROR(VLOOKUP($B$4,$M$19:$P,4,FALSE),0))',
    B7: '=IF($B$4="",0,IFERROR(VLOOKUP($B$4,$M$19:$Q,5,FALSE),0))',
    B8: '=IF($B$4="",0,IFERROR(VLOOKUP($B$4,$M$19:$R,6,FALSE),0))',
    B10: '=IF($B$4="",0,IFERROR(IF(COUNTIFS($A$19:$A,$B$4,$D$19:$D,"<>")>0,SUMIF($A$19:$A,$B$4,$F$19:$F),VLOOKUP($B$4,$M$19:$' + AL + ',26,FALSE)),0))',
    B11: '=IF(B6>0,B12-B10,0)',
    B12: '=IF($B$4="",0,IFERROR(VLOOKUP($B$4,$M$19:$T,8,FALSE),0))',
    B13: '=IF($B$4="",0,IFERROR(VLOOKUP($B$4,$M$19:$U,9,FALSE),0))',
    B15: '=IF($B$4="",0,IFERROR(VLOOKUP($B$4,$M$19:$W,11,FALSE),0))',
    E7: '=IF($B$4="","",IFERROR(VLOOKUP($B$4,$M$19:$Q,5,FALSE),""))'
  };
}

function trimSoldClose_(a, b, tol) {
  if (a == null && b == null) return true;
  return Math.abs((Number(a) || 0) - (Number(b) || 0)) <= (tol || 0.05);
}

function trimSoldCheck_(before, after, label) {
  var bad = [];
  before.batches.forEach(function (b) {
    var a = after.batches.filter(function (x) { return x.id === b.id; })[0];
    if (!a) { bad.push(label + ': missing register row ' + b.id); return; }
    ['items', 'rawG', 'refinedG', 'costInclFee', 'estValue', 'silverG'].forEach(function (k) {
      if (!trimSoldClose_(b[k], a[k], k === 'silverG' ? 0.02 : 0.05)) bad.push(label + ': ' + b.id + ' ' + k + ' was ' + b[k] + ' now ' + a[k]);
    });
  });
  if (before.batches.length !== after.batches.length) bad.push(label + ': register count ' + before.batches.length + ' → ' + after.batches.length);
  var bk = Object.keys(before.allBatches), i;
  for (i = 0; i < bk.length; i++) {
    var k = bk[i];
    if (!trimSoldClose_(before.allBatches[k], after.allBatches[k], 0.08))
      bad.push(label + ': All batches ' + k + ' was ' + before.allBatches[k] + ' now ' + after.allBatches[k]);
  }
  after.unsoldIds.forEach(function (id) {
    var nB = (before.itemsByBatch[id] || []).length, nA = (after.itemsByBatch[id] || []).length;
    if (nB !== nA) bad.push(label + ': unsold ' + id + ' item rows ' + nB + ' → ' + nA);
  });
  after.soldIds.forEach(function (id) {
    if ((after.itemsByBatch[id] || []).length) bad.push(label + ': sold ' + id + ' still has ' + after.itemsByBatch[id].length + ' item rows');
  });
  return bad;
}

function trimSoldBatchItemsApply() {
  var ss = SpreadsheetApp.getActive();
  var ref = ss.getSheetByName(REFINING.sheet);
  if (!ref) throw new Error('Refining tab not found.');
  var lock = LockService.getDocumentLock();
  lock.waitLock(TRIM_SOLD.lockMs);
  try {
    var before = trimSoldSnapshot_(ref);
    if (!before.soldItems) return maintAlert_('Trim sold batch items', 'No sold-batch item rows to trim. Nothing changed.');
    var existing = ss.getSheetByName(TRIM_SOLD.backupPrefix.trim()) || null;
    var stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HHmm');
    var bakName = TRIM_SOLD.backupPrefix + stamp;
    if (ss.getSheetByName(bakName)) bakName = bakName + '-' + String(new Date().getTime()).slice(-4);
    var bak = ref.copyTo(ss);
    bak.setName(bakName);
    try { bak.hideSheet(); } catch (e) {}

    // Frozen columns + headers (idempotent if a previous run was rolled back mid-way).
    var needCols = TRIM_SOLD.firstFrozen + TRIM_SOLD.headers.length - 1;
    if (ref.getMaxColumns() < needCols) ref.insertColumnsAfter(ref.getMaxColumns(), needCols - ref.getMaxColumns());
    ref.getRange(18, TRIM_SOLD.firstFrozen, 1, TRIM_SOLD.headers.length).setValues([TRIM_SOLD.headers]);

    var fee = before.fee, first = REFINING.firstDataRow;
    before.batches.forEach(function (b) {
      if (!b.sold) return;
      ref.getRange(b.row, TRIM_SOLD.firstFrozen, 1, 7).setValues([[
        b.items, b.rawG, b.refinedG, b.costInclFee, b.estValue, b.silverG, b.itemsCost
      ]]);
    });

    var F = trimSoldFormulas_();
    ref.getRange('P18').setFormula(F.P);
    ref.getRange('Q18').setFormula(F.Q);
    ref.getRange('R18').setFormula(F.R);
    ref.getRange('T18').setFormula(F.T);
    ref.getRange('U18').setFormula(F.U);
    ref.getRange('W18').setFormula(F.W);
    ref.getRange('C6').setFormula(F.C6);
    ref.getRange('C7').setFormula(F.C7);
    ref.getRange('C8').setFormula(F.C8);
    ref.getRange('C10').setFormula(F.C10);
    ref.getRange('C11').setFormula(F.C11);
    ref.getRange('C12').setFormula(F.C12);
    ref.getRange('C13').setFormula(F.C13);
    ref.getRange('C16').setFormula(F.C16);
    ref.getRange('B6').setFormula(F.B6);
    ref.getRange('B7').setFormula(F.B7);
    ref.getRange('B8').setFormula(F.B8);
    ref.getRange('B10').setFormula(F.B10);
    ref.getRange('B11').setFormula(F.B11);
    ref.getRange('B12').setFormula(F.B12);
    ref.getRange('B13').setFormula(F.B13);
    ref.getRange('B15').setFormula(F.B15);
    ref.getRange('E7').setFormula(F.E7);
    SpreadsheetApp.flush();

    // Compact unsold item inputs into A19:G; never touch M:AE (the register).
    var keep = [];
    before.unsoldIds.forEach(function (id) {
      (before.itemsByBatch[id] || []).forEach(function (r) { keep.push(r.vals.slice(0, 7)); });
    });
    var last = ref.getLastRow(), n = Math.max(0, last - first + 1);
    if (n > 0) ref.getRange(first, 1, n, 7).clearContent();
    if (keep.length) ref.getRange(first, 1, keep.length, 7).setValues(keep);
    SpreadsheetApp.flush();

    var after = trimSoldSnapshot_(ref);
    var bad = trimSoldCheck_(before, after, 'after trim');
    var st = { at: stamp, backup: bakName, soldIds: before.soldIds, soldItems: before.soldItems, unsoldItems: before.unsoldItems, allBatches: before.allBatches };
    PropertiesService.getDocumentProperties().setProperty(TRIM_SOLD.prop, JSON.stringify(st));
    if (bad.length) {
      return maintAlert_('Trim sold batch items — VERIFY FAILED',
        'A hidden backup tab "' + bakName + '" is intact. Use Maintenance > Rollback if the figures look wrong.\n' + bad.join('\n'));
    }
    return maintAlert_('Trim sold batch items',
      'Done. Removed ' + before.soldItems + ' sold item rows; ' + after.unsoldItems + ' unsold item rows kept. ' +
      'Register and All-batches totals match the backup.\nHidden backup tab: ' + bakName + '\nRun Verify next, then leave the backup tab until you are happy.');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function trimSoldBatchItemsVerify() {
  var ss = SpreadsheetApp.getActive();
  var st = trimSoldState_();
  var ref = ss.getSheetByName(REFINING.sheet);
  if (!ref) throw new Error('Refining tab not found.');
  if (!st || !st.backup) {
    var snap = trimSoldSnapshot_(ref);
    return maintAlert_('Verify trim', 'No trim has been applied on this sheet yet.\n' + trimSoldSummary_(snap));
  }
  var bak = ss.getSheetByName(st.backup);
  if (!bak) return maintAlert_('Verify trim', 'The backup tab "' + st.backup + '" is missing. The live Refining tab was not compared.');
  var live = trimSoldSnapshot_(ref), orig = trimSoldSnapshot_(bak);
  var bad = trimSoldCheck_(orig, live, 'verify');
  return maintAlert_('Verify trim', bad.length ? ('FAILED\n' + bad.join('\n')) :
    'OK. Register and All-batches totals match "' + st.backup + '". Sold item rows are gone; unsold item rows are intact.\n' + trimSoldSummary_(live));
}

function trimSoldBatchItemsRollback() {
  var ss = SpreadsheetApp.getActive();
  var st = trimSoldState_();
  if (!st || !st.backup) throw new Error('No trim backup recorded. Nothing to roll back.');
  var bak = ss.getSheetByName(st.backup);
  if (!bak) throw new Error('Backup tab "' + st.backup + '" was not found. Nothing was changed.');
  var lock = LockService.getDocumentLock();
  lock.waitLock(TRIM_SOLD.lockMs);
  try {
    var ref = ss.getSheetByName(REFINING.sheet);
    var trash = 'Refining (before rollback) ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HHmm');
    if (ref) {
      if (ss.getSheetByName(trash)) trash = trash + '-' + String(new Date().getTime()).slice(-4);
      ref.setName(trash);
      try { ref.hideSheet(); } catch (e) {}
    }
    try { bak.showSheet(); } catch (e) {}
    bak.setName(REFINING.sheet);
    PropertiesService.getDocumentProperties().deleteProperty(TRIM_SOLD.prop);
    return maintAlert_('Rollback trim', 'Restored "' + st.backup + '" as the Refining tab. The trimmed copy is hidden as "' + trash + '".');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// ---- Archive the hidden TZ fix log off this workbook (v11) ----
var TZLOG_ARCH = { sheet: 'TZ fix log', prop: 'tzFixLogArchive', folderId: '1bWwZIdbzx8kkZ_UtxqjpF3kkxWA9js3n' };

function tzLogState_() {
  try {
    var raw = PropertiesService.getDocumentProperties().getProperty(TZLOG_ARCH.prop);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function archiveTzFixLogPreview() {
  var ss = SpreadsheetApp.getActive();
  var log = ss.getSheetByName(TZLOG_ARCH.sheet);
  if (!log) return maintAlert_('Preview: archive TZ fix log', 'The "' + TZLOG_ARCH.sheet + '" tab is not on this workbook. Nothing to do.');
  var last = log.getLastRow(), hidden = false;
  try { hidden = log.isSheetHidden(); } catch (e) {}
  var sample = last >= 2 ? log.getRange(2, 1, Math.min(2, last - 1), 6).getValues() : [];
  var msg = 'Tab "' + TZLOG_ARCH.sheet + '" is ' + (hidden ? 'hidden' : 'visible') + ' with ' + Math.max(0, last - 1) +
            ' data rows (plus a header). Nothing on the sheet reads this tab (it is only the TzFix log from October 2026).\n' +
            'Apply will copy it to a new Drive spreadsheet, check the row count, then delete the tab here. Rollback copies it back.\n' +
            (sample.length ? 'First row: ' + sample[0].join(' | ') : '');
  return maintAlert_('Preview: archive TZ fix log', msg);
}

function archiveTzFixLogApply() {
  var ss = SpreadsheetApp.getActive();
  var log = ss.getSheetByName(TZLOG_ARCH.sheet);
  if (!log) return maintAlert_('Archive TZ fix log', 'The tab is already gone. Nothing changed.');
  var lock = LockService.getDocumentLock();
  lock.waitLock(TRIM_SOLD.lockMs);
  try {
    var last = log.getLastRow(), cols = Math.max(log.getLastColumn(), 6);
    var stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    var name = 'TZ fix log (archived ' + stamp + ')';
    var dest = SpreadsheetApp.create(name);
    log.copyTo(dest);
    var copied = dest.getSheets()[dest.getSheets().length - 1];
    copied.setName(TZLOG_ARCH.sheet);
    // Drop the default empty tab if create() made one.
    dest.getSheets().forEach(function (sh) {
      if (sh.getSheetId() !== copied.getSheetId() && dest.getSheets().length > 1) {
        try { dest.deleteSheet(sh); } catch (e) {}
      }
    });
    var copyLast = copied.getLastRow();
    if (copyLast !== last) throw new Error('Archive copy has ' + copyLast + ' rows, live tab has ' + last + '. The live tab was not deleted.');
    var destId = dest.getId(), destUrl = dest.getUrl();
    try { DriveApp.getFileById(destId).moveTo(DriveApp.getFolderById(TZLOG_ARCH.folderId)); } catch (e) { /* folder optional */ }
    var st = { at: stamp, id: destId, url: destUrl, name: name, rows: Math.max(0, last - 1) };
    PropertiesService.getDocumentProperties().setProperty(TZLOG_ARCH.prop, JSON.stringify(st));
    ss.deleteSheet(log);
    return maintAlert_('Archive TZ fix log', 'Moved ' + st.rows + ' data rows to "' + name + '".\n' + destUrl + '\nThe tab is no longer in this workbook. Run Verify next. Rollback can copy it back.');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function archiveTzFixLogVerify() {
  var ss = SpreadsheetApp.getActive();
  var st = tzLogState_();
  var still = ss.getSheetByName(TZLOG_ARCH.sheet);
  if (!st || !st.id) {
    return maintAlert_('Verify TZ fix log archive', still ?
      'No archive has been recorded. The tab is still on this workbook (' + Math.max(0, still.getLastRow() - 1) + ' data rows).' :
      'The tab is gone, but no archive record was saved, so it cannot be verified or rolled back from here.');
  }
  var dest, copy, rows = 0;
  try {
    dest = SpreadsheetApp.openById(st.id);
    copy = dest.getSheetByName(TZLOG_ARCH.sheet) || dest.getSheets()[0];
    rows = Math.max(0, copy.getLastRow() - 1);
  } catch (e) {
    return maintAlert_('Verify TZ fix log archive', 'Could not open the archive spreadsheet (' + st.id + '): ' + e.message);
  }
  var ok = !still && rows === st.rows;
  return maintAlert_('Verify TZ fix log archive', (ok ? 'OK. ' : 'CHECK: ') +
    'Live tab ' + (still ? 'still present' : 'removed') + '. Archive "' + (dest.getName()) + '" has ' + rows +
    ' data rows (expected ' + st.rows + ').\n' + (st.url || ''));
}

function archiveTzFixLogRollback() {
  var ss = SpreadsheetApp.getActive();
  var st = tzLogState_();
  if (!st || !st.id) throw new Error('No TZ fix log archive recorded. Nothing to roll back.');
  if (ss.getSheetByName(TZLOG_ARCH.sheet)) throw new Error('The "' + TZLOG_ARCH.sheet + '" tab is already on this workbook. Nothing was changed.');
  var lock = LockService.getDocumentLock();
  lock.waitLock(TRIM_SOLD.lockMs);
  try {
    var dest = SpreadsheetApp.openById(st.id);
    var copy = dest.getSheetByName(TZLOG_ARCH.sheet) || dest.getSheets()[0];
    var back = copy.copyTo(ss);
    back.setName(TZLOG_ARCH.sheet);
    try { back.hideSheet(); } catch (e) {}
    return maintAlert_('Rollback TZ fix log archive', 'Copied the tab back from "' + dest.getName() + '" and hid it. The archive spreadsheet was left in Drive.');
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
