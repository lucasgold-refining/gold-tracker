/**
 * Gold Tracker (Improved) - JSON API for the "Lucas Gold Tracker" app (PC + phone).  File v12.
 * v12: getState.realizedMonths is every month's realized profit, the same maths as goldApiMonth_
 *     and the Dashboard MONTHLY column. The current month's month.realizedProfit is that list's
 *     figure, so the two cannot disagree. Nothing on the sheet is written.
 * v10 (needs Code.gs v10 in the same project):
 *     - addPurchase takes at (ISO entry time from the app) and qid (batch-quote group ID): saved in Purchases P / Q
 *       ("Bought at", "Quote ID", hidden). Every stock item carries at ('yyyy-MM-ddTHH:mm' Manila, '' for older
 *       rows) and qid ('' for single buys / older rows). editPurchase clears the time when the date moves to another day.
 *     - getState adds dailySold = { 'yyyy-MM-dd': grams of that day's purchases that are sold since } (same grams as
 *       daily; sold = item Sold, or its refining batch has a sale). Each batch carries canAdd (not sold, no sale details).
 *     - addToBatch {batchId, nos:[item No.]}: In stock items join an existing, not yet sold refining batch at that
 *       batch's frozen base (Refining item rows + Archive, like Batch refining). The register's formulas recalc the
 *       batch totals. removeFromBatch {batchId, no}: one item goes back to In stock (only while its Archive row is
 *       still there). batchItems (GET, batchId): the items of a batch, for the app's list.
 * v9: getState adds daily = { 'yyyy-MM-dd': grams bought that Manila day } over ALL purchases: Purchases
 *     (any status) + Archive + removed Archive rows (Archive Totals, which Code.gs v9 now keeps per
 *     purchase day). dailyGapUntil = the last 'Removed on' day of older month-only Archive Totals rows
 *     (days up to it can be missing refined items), or ''. Nothing else changed; v8 answers still work.
 * v8: Batch # (needs Code.gs v8): every stock item also carries bno, the per-batch display number
 *     (Purchases column O, restarts at 1 after each Batch refining; null until "Set up batch numbers"
 *     ran). The real item No. ("no") is unchanged and is still what edit / delete / batchRefine use.
 *     getState adds nextBno and batchNos (true once set up); addPurchase answers bno too (message
 *     "Saved as #<bno>."); editPurchase / deletePurchase answer bno; batchPreview adds bnos.
 *     New read action exportBackup (GET): the whole spreadsheet as .xlsx, base64 in "data", with
 *     name, size (bytes), mime and at. It uses the Drive export link with the script's own sign-in,
 *     so the project needs Drive access: run authorizeBackup() once in the editor and allow it.
 * v7: Per-batch estimate inputs from the app, so PC and phone share them: setBatchEstimate
 *     {batchId, sellBase?, actualG?} saves the batch's "Base" (expected selling base / gram) and
 *     "Actual refined grams" on the Refining batch register, in the two columns right after
 *     "Recorded in Sales": AD (Est. sell base / gram (app)) and AE (Actual refined grams (app)).
 *     The first save adds column AE if the tab is only 30 columns wide and fills the two header
 *     cells on row 18 when they are empty. Nothing else on the sheet reads these columns, so the
 *     sheet's own Est. value / Est. profit (base at batch) and Actual value formulas are unchanged.
 *     A field that is not sent is left as it is; an empty value clears it. Answers lite (no state).
 *     getState: each batch also carries estBase and actualG (null when empty).
 * v6: Silver needed leaves out items at FullBaseMinPurity (99.8%) or higher: they are already refined.
 *     Those items still count in every other batch total (items, grams, cost, fee, value, profit).
 *     Batch refine preview and each batch's silver in the app use this rule (goldApiSilverG_).
 * v5: batchRefine keeps only the new batch's raw rows on Archive (older rows' totals move to the
 *     "Archive Totals" tab first, see Code.gs purgeOldArchiveRows_); next No. and this month's
 *     figures also count those saved totals. Needs Code.gs v7 in the same project.
 *
 * Add this as a NEW file (Api.gs) in the same Apps Script project as Code.gs. It reuses the
 * Code.gs layout (PURCHASES, ARCHIVE, REFINING, SALES, SETTINGS) and helpers (addPurchase,
 * addSale, archiveRows_, syncBatchSales_, toNumber_, toPurity_, toDate_, nextItemNo_ ...).
 *
 * One-time setup:
 *   1. Run setupGoldApi() once from the editor. It creates the secret token (Script Properties
 *      key GOLD_API_TOKEN) and prints it in the Execution log.
 *   2. Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone. Copy the URL.
 *   3. Run setupGoldApi() again: it prints the one-tap setup text  <web app URL>|<token>.
 *
 * Requests (every one needs the token):
 *   GET  <url>?action=getState&token=...            (also: action=batchPreview)
 *   POST <url>  body (Content-Type text/plain) = JSON {action, token, rid, ...fields}
 *        actions: addPurchase, editPurchase, deletePurchase, batchRefine, recordBatchSale, addSale,
 *                 setBase {base}  (manual base, PHP per gram after the adjustment),
 *                 setBatchEstimate {batchId, sellBase?, actualG?}  (v7, lite answer: {ok, message, batchId, estBase, actualG, version})
 *   Every response is JSON: {ok:true, message, state} or {ok:false, error}.
 *   addPurchase with lite:true answers {ok, message, no, item, version} without the full state (much faster).
 */

var GOLD_API = {
  version: 12,         // 12: getState.realizedMonths (every month, same figure as the Dashboard MONTHLY column and as month.realizedProfit). 11: undoLastBatch. 10: purchase time + batch group, dailySold, add / remove items of an unsold batch. 9: getState daily. 8: Batch # + exportBackup. 7: setBatchEstimate. 6: silver excludes 99.8%+. 5: Archive Totals. 2: lite addPurchase, 6 h request-ID memory
  dedupeSeconds: 21600, // CacheService maximum (6 hours)
  tokenProp: 'GOLD_API_TOKEN',
  recentSales: 25,
  readActions: { getState: true, batchPreview: true, ping: true, exportBackup: true, batchItems: true },
  backupMaxBytes: 30 * 1024 * 1024,
  writeActions: { addPurchase: true, editPurchase: true, deletePurchase: true, batchRefine: true,
                  recordBatchSale: true, addSale: true, setBase: true, setBatchEstimate: true,
                  addToBatch: true, removeFromBatch: true,   // v10
                  undoLastBatch: true },                      // v11
  baseMin: 1000,
  baseMax: 50000,
  manualSource: 'Manual (app)'
};

// ---------- Web app entry points ----------
function doGet(e) {
  var p = (e && e.parameter) || {};
  return goldApiRespond_(goldApiHandle_(p, false));
}

function doPost(e) {
  var body = {};
  try {
    var raw = e && e.postData && e.postData.contents;
    body = raw ? JSON.parse(raw) : {};
    if (!body || typeof body !== 'object') body = {};
  } catch (err) {
    return goldApiRespond_({ ok: false, error: 'Request body is not valid JSON.' });
  }
  var q = (e && e.parameter) || {};
  if (!body.token && q.token) body.token = q.token;
  if (!body.action && q.action) body.action = q.action;
  return goldApiRespond_(goldApiHandle_(body, true));
}

function goldApiRespond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Pure dispatcher (testable): returns a plain object. */
function goldApiHandle_(req, isPost) {
  try {
    if (!goldApiTokenOk_(req.token)) return { ok: false, error: 'Not authorised. Check the token in the app Settings.', auth: false };
    var action = String(req.action || 'getState');
    if (GOLD_API.readActions[action]) {
      if (action === 'ping') return { ok: true, message: 'pong', version: GOLD_API.version };
      if (action === 'batchPreview') return { ok: true, preview: goldApiBatchPreview_(), state: goldApiState_() };
      if (action === 'exportBackup') return goldApiExportBackup_();
      if (action === 'batchItems') return goldApiBatchItems_(req);   // v10
      return { ok: true, state: goldApiState_() };
    }
    if (!GOLD_API.writeActions[action]) return { ok: false, error: 'Unknown action "' + action + '".' };
    if (!isPost) return { ok: false, error: 'Use POST for "' + action + '".' };

    // Same request sent twice (double tap / retry after a timeout) -> same answer, no second write.
    var rid = req.rid ? String(req.rid).substring(0, 80) : '';
    // lite (addPurchase only): answer with the new row, skip rebuilding the whole state.
    var lite = (action === 'addPurchase' && (req.lite === true || req.lite === 'true' || req.lite === 1 || req.lite === '1')) ||
               action === 'setBatchEstimate';   // v7: always lite
    var cache = rid ? CacheService.getScriptCache() : null;
    if (cache) {
      var seen = cache.get('goldapi:' + rid);
      if (seen) {
        var prev = JSON.parse(seen); prev.duplicate = true;
        if (lite) prev.version = GOLD_API.version; else prev.state = goldApiState_();
        return prev;
      }
    }
    var res = goldApiWrite_(action, req);
    var out = { ok: true, message: res.message };
    if (res.no !== undefined) out.no = res.no;
    if (res.bno !== undefined) out.bno = res.bno;   // v8
    if (res.batchId !== undefined) out.batchId = res.batchId;
    if (res.item) out.item = res.item;
    if (res.restored !== undefined) { out.restored = res.restored; out.newer = res.newer; out.shift = res.shift; }   // v11
    if (res.est) { out.estBase = res.est.estBase; out.actualG = res.est.actualG; }
    if (cache) { try { cache.put('goldapi:' + rid, JSON.stringify(out), GOLD_API.dedupeSeconds); } catch (e) { /* too big / cache busy */ } }
    if (lite) out.version = GOLD_API.version; else out.state = goldApiState_();
    return out;
  } catch (err) {
    return { ok: false, error: (err && err.message) ? err.message : String(err) };
  }
}

function goldApiTokenOk_(given) {
  var want = PropertiesService.getScriptProperties().getProperty(GOLD_API.tokenProp);
  if (!want || want.length < 16) throw new Error('API token not set up. Run setupGoldApi() in the Apps Script editor.');
  given = String(given || '');
  if (given.length !== want.length) return false;
  var diff = 0;
  for (var i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/**
 * Run once from the editor: creates the token if missing and logs it, plus the one-tap setup
 * text once the web app is deployed. Pass true (goldApiNewToken) to replace the token.
 */
function setupGoldApi() { return goldApiSetup_(false); }
function goldApiNewToken() { return goldApiSetup_(true); }

function goldApiSetup_(rotate) {
  var props = PropertiesService.getScriptProperties();
  var tok = props.getProperty(GOLD_API.tokenProp);
  if (!tok || rotate) {
    tok = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty(GOLD_API.tokenProp, tok);
  }
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) { url = ''; }
  var msg = 'Token: ' + tok + '\n' +
    (url ? 'Web app URL: ' + url + '\nApp setup text (paste into the app Settings, or add after #setup= in the app link):\n' + url + '|' + tok
         : 'Not deployed yet: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone), then run setupGoldApi again.');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Gold Tracker app setup', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* run from editor */ }
  return msg;
}

// ---------- Write actions ----------
function goldApiWrite_(action, req) {
  switch (action) {
    case 'addPurchase': {
      var msg = addPurchase({ date: req.date || '', weightBhy: req.weightBhy, purity: req.purity, cost: req.cost, status: 'In stock', at: req.at, qid: req.qid });   // v10: at, qid
      var m = String(msg).match(/No\.\s*(\d+)/), rm = String(msg).match(/\(row\s*(\d+)\)/), bm = String(msg).match(/Batch #(\d+)/);
      var out = { message: 'Saved as #' + (bm ? bm[1] : (m ? m[1] : '?')) + '.', no: m ? Number(m[1]) : undefined };
      if (bm) out.bno = Number(bm[1]);   // v8
      try { if (m && rm) out.item = goldApiPurchaseRow_(Number(rm[1]), Number(m[1])); } catch (e) { /* the app falls back to its own numbers */ }
      return out;
    }
    case 'editPurchase': return goldApiEditPurchase_(req);
    case 'deletePurchase': return goldApiDeletePurchase_(req);
    case 'batchRefine': return goldApiBatchRefine_(req);
    case 'recordBatchSale': return goldApiRecordBatchSale_(req);
    case 'setBase': return goldApiSetBase_(req);
    case 'setBatchEstimate': return goldApiSetBatchEstimate_(req);
    case 'addToBatch': return goldApiAddToBatch_(req);           // v10
    case 'removeFromBatch': return goldApiRemoveFromBatch_(req); // v10
    case 'undoLastBatch': return goldApiUndoLastBatch_(req);     // v11
    case 'addSale': {
      addSale({ date: req.date || '', base: req.base, grams: req.grams, estValue: req.estValue, cost: req.cost, actual: req.actual });
      var prof = toNumber_(req.actual, 'Actual received') - toNumber_(req.cost, 'Cost');
      return { message: 'Sale added. Profit ' + goldApiPeso_(prof) + '.' };
    }
  }
  throw new Error('Unknown action.');
}

/** The just-written Purchases row as a stock item (one read; formulas are already calculated after flush). */
function goldApiPurchaseRow_(row, no) {
  var sh = SpreadsheetApp.getActive().getSheetByName(PURCHASES.sheet);
  var r = sh.getRange(row, 1, 1, goldApiPurW_(sh)).getValues()[0];
  if (Number(r[PURCHASES.cols.no - 1]) !== no) return null;
  var lazy = null;
  return goldApiStockItem_(r, function () { return lazy || (lazy = { base: getNamed_(SETTINGS.basePriceName), bhyPerGram: getNamed_('BHYPerGram') || 2 }); });
}

/**
 * Manual base price from the app: writes BasePrice (Settings B3), Source (B16) = "Manual (app)",
 * Last updated (B22) and Status (B23). Leaves B17-B21 (price date, gold USD, BSP rate ...) alone.
 */
function goldApiSetBase_(req) {
  var raw = req.base;
  if (raw === null || raw === undefined || String(raw).trim() === '') throw new Error('Enter the base price per gram.');
  if (typeof raw !== 'number' && !/^\s*[₱]?\s*[0-9][0-9,]*(\.[0-9]+)?\s*$/.test(String(raw))) throw new Error('Base price must be a number.');
  var base = toNumber_(raw, 'Base price');
  if (!isFinite(base) || base < GOLD_API.baseMin || base > GOLD_API.baseMax)
    throw new Error('Base price must be between ₱1,000 and ₱50,000 per gram (got ' + raw + ').');
  base = round2_(base);
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName(SETTINGS.sheet);
    if (!sh) throw new Error('Settings tab not found.');
    var baseRange = ss.getRangeByName(SETTINGS.basePriceName);
    if (!baseRange) throw new Error('Named range ' + SETTINGS.basePriceName + ' not found.');
    var now = new Date();
    var stamp = Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm');
    baseRange.setValue(base);
    sh.getRange(SETTINGS.sourceCell).setValue(GOLD_API.manualSource);
    sh.getRange(SETTINGS.lastUpdatedCell).setValue(stamp + ' (Manila)');
    sh.getRange(SETTINGS.statusCell).setValue('Manual base set in app ' + stamp + ': ' + goldApiPeso_(base) + ' / g');
    SpreadsheetApp.flush();
    return { message: 'Base set to ' + goldApiPeso_(base) + ' / g.' };
  } finally { lock.releaseLock(); }
}

/** Purchases columns to read: A..Q with the v10 Bought at / Quote ID columns, A..O with the Batch # column (v8), else A..N. */
function goldApiPurW_(sh) {
  if (!sh) return PURCHASES.lastCol;
  var m = sh.getMaxColumns();
  return m >= BUYINFO.purQid && buyInfoOn_() ? BUYINFO.purQid : m >= BATCHNO.purCol ? BATCHNO.purCol : PURCHASES.lastCol;
}
/** v8: Batch # of a Purchases row (null when blank / no column). */
function goldApiRowBno_(sh, row) {
  if (sh.getMaxColumns() < BATCHNO.purCol) return null;
  return goldApiNum_(sh.getRange(row, BATCHNO.purCol).getValue());
}
/** v8: "#3" (Batch #) for messages, else the item No. */
function goldApiLabel_(no, bno) { return '#' + (bno !== null && bno !== undefined ? bno : Number(no)); }

/** Finds the Purchases row (1-based) of item No. (In stock / blank status only). */
function goldApiFindStockRow_(sh, no) {
  var c = PURCHASES.cols;
  var n = Number(no);
  if (!isFinite(n) || n <= 0) throw new Error('Item number is missing.');
  var last = sh.getLastRow();
  if (last < PURCHASES.firstDataRow) throw new Error('Item #' + n + ' was not found on Purchases.');
  var vals = sh.getRange(PURCHASES.firstDataRow, 1, last - PURCHASES.firstDataRow + 1, c.status).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][c.no - 1] !== '' && Number(vals[i][c.no - 1]) === n) {
      var st = String(vals[i][c.status - 1] || '').trim();
      if (st && st !== 'In stock') throw new Error('Item #' + n + ' is ' + st + ', so it can no longer be changed here.');
      return PURCHASES.firstDataRow + i;
    }
  }
  throw new Error('Item #' + n + ' was not found on Purchases (it may have been refined already). Refresh the app.');
}

function goldApiEditPurchase_(req) {
  var c = PURCHASES.cols;
  var weight = toNumber_(req.weightBhy, 'Weight (BHY)', { positive: true });
  var purity = toPurity_(req.purity);
  var cost = toNumber_(req.cost, 'Cost (PHP)', { min: 0 });
  var date = toDate_(req.date, 'Date', true);
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(PURCHASES.sheet);
    if (!sh) throw new Error('Purchases tab not found.');
    var row = goldApiFindStockRow_(sh, req.no);
    sh.getRange(row, c.weightBhy).setValue(weight);
    sh.getRange(row, c.purity).setValue(purity);
    sh.getRange(row, c.cost).setValue(cost);
    if (date !== '') {
      sh.getRange(row, c.date).setValue(date);
      // v10: a time from another day would be wrong now: the item keeps no time rather than a made-up one
      if (buyInfoOn_() && sh.getMaxColumns() >= BUYINFO.purAt) {
        var atCell = sh.getRange(row, BUYINFO.purAt), atV = atCell.getValue();
        if (goldApiIsDate_(atV) && Utilities.formatDate(atV, TZ, 'yyyy-MM-dd') !== Utilities.formatDate(date, TZ, 'yyyy-MM-dd')) atCell.setValue('');
      }
    }
    if (String(sh.getRange(row, c.status).getValue()).trim() === '') sh.getRange(row, c.status).setValue('In stock');
    SpreadsheetApp.flush();
    var bno = goldApiRowBno_(sh, row);
    return { message: 'Item ' + goldApiLabel_(req.no, bno) + ' updated.', no: Number(req.no), bno: bno === null ? undefined : bno };
  } finally { lock.releaseLock(); }
}

function goldApiDeletePurchase_(req) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(PURCHASES.sheet);
    if (!sh) throw new Error('Purchases tab not found.');
    var row = goldApiFindStockRow_(sh, req.no);
    var bno = goldApiRowBno_(sh, row);
    if (sh.getMaxRows() < 60) sh.insertRowsAfter(sh.getMaxRows(), 100); // Sheets refuses to delete the last rows
    sh.deleteRow(row);
    SpreadsheetApp.flush();
    return { message: 'Item ' + goldApiLabel_(req.no, bno) + ' deleted.', no: Number(req.no), bno: bno === null ? undefined : bno };
  } finally { lock.releaseLock(); }
}

/** In stock rows on Purchases with their totals (what Batch refining would take). */
function goldApiPickStock_(pur) {
  var c = PURCHASES.cols;
  var last = pur.getLastRow();
  var out = { n: 0, data: [], picked: [], rawG: 0, refG: 0, cost: 0, sRawG: 0, sRefG: 0, high: 0 };   // s*: items that need silver
  if (last < PURCHASES.firstDataRow) return out;
  out.n = last - PURCHASES.firstDataRow + 1;
  out.data = pur.getRange(PURCHASES.firstDataRow, 1, out.n, goldApiPurW_(pur)).getValues();
  var bhy = getNamed_('BHYPerGram') || 2, fullMin = goldApiFullMin_();
  out.data.forEach(function (r, i) {
    var w = r[c.weightBhy - 1];
    var st = String(r[c.status - 1] || '').trim();
    if ((st === 'In stock' || st === '') && w !== '' && w !== null) {
      var g = Number(w) / bhy, p = Number(r[c.purity - 1]) || 0;
      out.rawG += g; out.refG += g * p; out.cost += Number(r[c.cost - 1]) || 0;
      if (goldApiIsRefined_(p, fullMin)) out.high++; else { out.sRawG += g; out.sRefG += g * p; }
      out.picked.push({ idx: i, row: PURCHASES.firstDataRow + i, r: r });
    }
  });
  return out;
}

/** FullBaseMinPurity as a fraction (same rule as getState settings.fullMin): blank -> 0.998, 99.8 -> 0.998. */
function goldApiFullMin_() {
  var f = getNamed_('FullBaseMinPurity');
  if (f === null || !isFinite(f) || f <= 0) f = 0.998;
  if (f > 1) f = f / 100;
  return f;
}
/** Already refined (99.8%+): needs no silver. Same comparison as the app's Quote full-base rule. */
function goldApiIsRefined_(p, fullMin) { return Number(p) + 1e-9 >= fullMin; }
/** Silver to add (grams) for the raw / refined grams of the items that get refined (the sheet's rule). */
function goldApiSilverG_(rawG, refG, div, mul) {
  if (div === undefined) { div = getNamed_('SilverDivisor'); mul = getNamed_('SilverMultiplier'); }
  if (!div || !mul || !refG || !rawG) return 0;
  return (refG * (refG / rawG) / div) * mul - refG;
}
/** Per batch: silver from the Refining item table (A batch, D weight, E purity), 99.8%+ items left out. */
function goldApiBatchSilver_(C, st) {   // st = getState settings (already read: no extra named-range reads)
  var rows = C.rows(REFINING.sheet, REFINING.firstDataRow, 5, 1), bhy = st.bhyPerGram || 2, fullMin = st.fullMin, t = {};
  rows.forEach(function (r) {
    var id = r[0], w = r[3]; if (id === '' || id === null || w === '' || w === null) return;
    var k = String(id), p = Number(r[4]) || 0, g = Number(w) / bhy;
    t[k] = t[k] || { raw: 0, ref: 0 };
    if (!goldApiIsRefined_(p, fullMin)) { t[k].raw += g; t[k].ref += g * p; }
  });
  var out = {}; Object.keys(t).forEach(function (k) { out[k] = goldR_(goldApiSilverG_(t[k].raw, t[k].ref, st.silverDivisor, st.silverMultiplier), 3); });
  return out;
}

function goldApiBatchPreview_() {
  var ss = SpreadsheetApp.getActive();
  var pur = ss.getSheetByName(PURCHASES.sheet), ref = ss.getSheetByName(REFINING.sheet);
  if (!pur || !ref) throw new Error('Purchases or Refining tab not found.');
  var s = goldApiPickStock_(pur);
  var base = getNamed_(SETTINGS.basePriceName);
  var fee = s.picked.length ? (getNamed_('RefiningFee') || 0) : 0;
  var value = base ? s.refG * base : 0;
  var rawPct = s.rawG ? s.refG / s.rawG : 0;
  var silver = goldApiSilverG_(s.sRawG, s.sRefG);   // v6: only the items below 99.8%
  return {
    count: s.picked.length,
    nos: s.picked.map(function (p) { return Number(p.r[PURCHASES.cols.no - 1]) || null; }),
    bnos: s.picked.map(function (p) { return goldApiNum_(p.r[BATCHNO.purCol - 1]); }),   // v8 (null when not set up)
    rawG: goldR_(s.rawG, 3), refinedG: goldR_(s.refG, 3), rawPct: goldR_(rawPct, 4),
    cost: round2_(s.cost), fee: fee, costInclFee: round2_(s.cost + fee),
    base: base, estValue: round2_(value), estProfit: round2_(value - s.cost - fee),
    silverG: goldR_(silver, 3), silverExcl: s.high, fullMin: goldApiFullMin_(), defaultBatchId: defaultBatchId_(existingBatchIds_(ref))
  };
}

/**
 * Same as the Batch refining menu (Code.gs batchRefining), without pop-ups:
 * all In stock purchases -> new Refining batch (base frozen at today's Settings base),
 * register row, Status -> Refined, rows moved to Archive.
 * req.expectNos (optional): the item numbers the user confirmed; refuses if stock changed since.
 */
function goldApiBatchRefine_(req) {
  var ss = SpreadsheetApp.getActive();
  var pur = ss.getSheetByName(PURCHASES.sheet), ref = ss.getSheetByName(REFINING.sheet);
  if (!pur || !ref) throw new Error('Purchases or Refining tab not found.');
  var c = PURCHASES.cols;
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var s = goldApiPickStock_(pur);
    if (!s.picked.length) throw new Error('There are no In stock purchases to refine.');
    // Give any picked row without a No. its number first (Refining stores the No.).
    var nextNo = nextItemNo_(), noFilled = false;
    s.picked.forEach(function (p) {
      if (p.r[c.no - 1] === '' || p.r[c.no - 1] === null) { p.r[c.no - 1] = nextNo++; s.data[p.idx][c.no - 1] = p.r[c.no - 1]; noFilled = true; }
    });
    if (Array.isArray(req.expectNos)) {
      var want = req.expectNos.map(Number).filter(function (x) { return x > 0; }).sort(function (a, b) { return a - b; }).join(',');
      var have = s.picked.map(function (p) { return Number(p.r[c.no - 1]); }).sort(function (a, b) { return a - b; }).join(',');
      if (want !== have) throw new Error('Stock changed since you opened this (someone added or edited items). Nothing was refined. Refresh and try again.');
    }
    if (noFilled) pur.getRange(PURCHASES.firstDataRow, c.no, s.n, 1).setValues(s.data.map(function (r) { return [r[c.no - 1]]; }));

    var base = getNamed_(SETTINGS.basePriceName);
    if (!base) throw new Error('Settings base price is empty. Set it first.');
    var existing = existingBatchIds_(ref);
    var batchId = String(req.batchId || '').trim() || defaultBatchId_(existing);
    if (existing[batchId]) throw new Error('Batch "' + batchId + '" already exists. Pick another ID.');

    var batchDate = new Date();
    // 1) Item rows on Refining (values only)
    var itemStart = firstEmptyRow_(ref, REFINING.firstDataRow, range_(1, REFINING.itemCols));
    ensureRows_(ref, itemStart + s.picked.length);
    var rows = s.picked.map(function (p) {
      return [batchId, batchDate, p.r[c.no - 1], p.r[c.weightBhy - 1], p.r[c.purity - 1], p.r[c.cost - 1], base];
    });
    ref.getRange(itemStart, 1, rows.length, REFINING.itemCols).setValues(rows);
    // 2) Batch register row
    var regRow = firstEmptyRow_(ref, REFINING.firstDataRow, range_(REFINING.regFirstCol, REFINING.regCols));
    ensureRows_(ref, regRow);
    ref.getRange(regRow, REFINING.regFirstCol, 1, REFINING.regCols).setValues([[batchId, batchDate, base]]);
    // 3) Status -> Refined
    var statusRange = pur.getRange(PURCHASES.firstDataRow, c.status, s.n, 1);
    var statuses = statusRange.getValues();
    s.picked.forEach(function (p) { statuses[p.idx][0] = 'Refined'; });
    statusRange.setValues(statuses);
    SpreadsheetApp.flush();
    // 4) Move Refined / Sold rows to Archive with the frozen base
    var info = {};
    s.picked.forEach(function (p) { info[String(p.r[c.no - 1])] = { batch: batchId, base: base }; });
    var moved = archiveRows_(info, batchDate);
    setBatchNoLast_(0);   // v8: the next purchase is Batch #1
    // 4b) Archive keeps only this batch's rows (older totals saved on Archive Totals first)
    var purgeMsg = purgeOldArchiveRowsSafe_(batchId);
    // 5) Refining tab shows the latest batch
    ref.getRange(REFINING.selectorCell).clearContent();
    SpreadsheetApp.flush();
    return { message: 'Batch ' + batchId + ' created with ' + s.picked.length + ' items (' + moved + ' moved to Archive).' +
                      (purgeMsg ? ' ' + purgeMsg : ''), batchId: batchId };
  } finally { lock.releaseLock(); }
}

// ---------- v7: per-batch estimate (Base + actual refined grams), shared by every device ----------
var BATCH_EST = {
  estBase: 30,   // AD  Est. sell base / gram (app)
  actualG: 31,   // AE  Actual refined grams (app)
  headerRow: 18,
  headers: ['Est. sell base / gram (app)', 'Actual refined grams (app)'],
  maxGrams: 1000000
};
function goldApiSetBatchEstimate_(req) {
  var R = REFINING.reg;
  var id = String(req.batchId || '').trim();
  if (!id) throw new Error('Pick a batch.');
  var hasB = Object.prototype.hasOwnProperty.call(req, 'sellBase'), hasG = Object.prototype.hasOwnProperty.call(req, 'actualG');
  if (!hasB && !hasG) throw new Error('Nothing to save: send sellBase and/or actualG.');
  var base = hasB ? toNumber_(req.sellBase, 'Base', { optional: true, positive: true }) : null;
  if (hasB && base !== '' && (base < GOLD_API.baseMin || base > GOLD_API.baseMax))
    throw new Error('Base must be between ₱1,000 and ₱50,000 per gram (got ' + req.sellBase + ').');
  var g = hasG ? toNumber_(req.actualG, 'Actual refined weight', { optional: true, positive: true }) : null;
  if (hasG && g !== '' && g > BATCH_EST.maxGrams) throw new Error('Actual refined weight looks too large (' + req.actualG + ' g).');
  var ref = SpreadsheetApp.getActive().getSheetByName(REFINING.sheet);
  if (!ref) throw new Error('Refining tab not found.');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var row = goldApiRegRow_(ref, id);
    var maxC = ref.getMaxColumns();
    if (maxC < BATCH_EST.actualG) ref.insertColumnsAfter(maxC, BATCH_EST.actualG - maxC);
    var hdr = ref.getRange(BATCH_EST.headerRow, BATCH_EST.estBase, 1, 2), hv = hdr.getValues()[0];
    if (hv[0] === '' || hv[1] === '') hdr.setValues([[hv[0] === '' ? BATCH_EST.headers[0] : hv[0], hv[1] === '' ? BATCH_EST.headers[1] : hv[1]]]);
    var cell = ref.getRange(row, BATCH_EST.estBase, 1, 2), cur = cell.getValues()[0];
    var now = [hasB ? base : cur[0], hasG ? g : cur[1]];
    cell.setValues([now]);
    SpreadsheetApp.flush();
    var est = { estBase: goldApiNum_(now[0]), actualG: goldApiNum_(now[1]) };
    return { message: 'Saved on batch ' + id + '.', batchId: id, est: est };
  } finally { lock.releaseLock(); }
}

/** Writes Sell date / Sell base / Actual received into the batch register, then records it in Sales. */
function goldApiRecordBatchSale_(req) {
  var R = REFINING.reg;
  var id = String(req.batchId || '').trim();
  if (!id) throw new Error('Pick a batch.');
  var sellDate = toDate_(req.sellDate, 'Sell date', false);
  var sellBase = toNumber_(req.sellBase, 'Sell base / gram', { optional: true, positive: true });
  var amt = toNumber_(req.actualAmt, 'Actual received', { optional: true, min: 0 });
  if (sellBase === '' && amt === '') throw new Error('Enter the sell base / gram or the actual amount received.');
  var ref = SpreadsheetApp.getActive().getSheetByName(REFINING.sheet);
  if (!ref) throw new Error('Refining tab not found.');
  var row = null;
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    row = goldApiRegRow_(ref, id);
    ref.getRange(row, R.sellDate, 1, 3).setValues([[sellDate, sellBase, amt]]);
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
  // syncBatchSales_ takes the lock itself; script writes do not fire onEdit, so call it here.
  var res = syncBatchSales_([row]);
  var msg = res.added ? 'Batch ' + id + ' recorded in Sales.' : res.updated ? 'Sale for batch ' + id + ' updated in Sales.' : 'Saved on batch ' + id + '. ' + res.message;
  return { message: msg, batchId: id };
}

/** Batch register row (1-based) of batch id; throws when it is not there. */
function goldApiRegRow_(ref, id) {
  var last = ref.getLastRow();
  if (last >= REFINING.firstDataRow) {
    var ids = ref.getRange(REFINING.firstDataRow, REFINING.reg.id, last - REFINING.firstDataRow + 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) return REFINING.firstDataRow + i;
  }
  throw new Error('Batch ' + id + ' not found in the batch register.');
}

// ---------- v10: add In stock items to an existing, not yet sold batch / take one back out ----------
/** The register row M..AC of a batch (values), checked: not sold, no sale details typed, not in Sales. */
function goldApiOpenBatch_(ref, id) {
  var R = REFINING.reg, row = goldApiRegRow_(ref, id);
  var reg = ref.getRange(row, R.id, 1, R.recorded - R.id + 1).getValues()[0], col = function (k) { return reg[k - R.id]; };
  var blank = function (v) { return v === '' || v === null; };
  if (!blank(col(R.recorded)) || !blank(col(R.sellDate)) || !blank(col(R.sellBase)) || !blank(col(R.actualAmt)))
    throw new Error('Batch ' + id + ' is already sold (or has sale details), so its items can no longer change.');
  return { row: row, date: col(R.id + 1), base: goldApiNum_(col(R.id + 2)), actualG: ref.getMaxColumns() >= BATCH_EST.actualG ? goldApiNum_(ref.getRange(row, BATCH_EST.actualG).getValue()) : null };
}
/** Highest Batch # used by this batch's items (Archive R), at least the number of its items on Refining. */
function goldApiBatchMaxBno_(id, ref) {
  var m = 0, ar = SpreadsheetApp.getActive().getSheetByName(ARCHIVE.sheet);
  if (ar && ar.getLastRow() >= ARCHIVE.firstDataRow && ar.getMaxColumns() >= ARCHIVE.cols.bno) {
    var n = ar.getLastRow() - ARCHIVE.firstDataRow + 1;
    var ob = ar.getRange(ARCHIVE.firstDataRow, ARCHIVE.cols.batch, n, ARCHIVE.cols.bno - ARCHIVE.cols.batch + 1).getValues();
    ob.forEach(function (r) { var b = goldApiNum_(r[r.length - 1]); if (String(r[0]).trim() === id && b !== null && b > m) m = b; });
  }
  var last = ref.getLastRow(), k = 0;
  if (last >= REFINING.firstDataRow) ref.getRange(REFINING.firstDataRow, 1, last - REFINING.firstDataRow + 1, 1).getValues().forEach(function (v) { if (String(v[0]) === id) k++; });
  return Math.max(m, k);
}
function goldApiAddToBatch_(req) {
  var id = String(req.batchId || '').trim();
  if (!id) throw new Error('Pick a batch.');
  var want = (Array.isArray(req.nos) ? req.nos : [req.no]).map(Number).filter(function (x, i, a) { return x > 0 && isFinite(x) && a.indexOf(x) === i; });
  if (!want.length) throw new Error('Pick the In stock items to add.');
  var ss = SpreadsheetApp.getActive(), pur = ss.getSheetByName(PURCHASES.sheet), ref = ss.getSheetByName(REFINING.sheet);
  if (!pur || !ref) throw new Error('Purchases or Refining tab not found.');
  var c = PURCHASES.cols;
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var B = goldApiOpenBatch_(ref, id);
    if (!B.base) throw new Error('Batch ' + id + ' has no base / gram at batch.');
    var s = goldApiPickStock_(pur), byNo = {};
    s.picked.forEach(function (p) { var n = Number(p.r[c.no - 1]); if (n > 0) byNo[n] = p; });
    var sel = want.map(function (n) { if (!byNo[n]) throw new Error('Item #' + n + ' is no longer In stock (it may have been refined or deleted). Refresh and try again.'); return byNo[n]; });
    var hasB = pur.getMaxColumns() >= BATCHNO.purCol && batchNoOn_();
    var nextB = hasB ? goldApiBatchMaxBno_(id, ref) + 1 : 0;   // Batch # continues this batch's numbers (Archive label "R-… · #n")
    // 1) Refining item rows (values only), at the batch's own date and frozen base
    var itemStart = firstEmptyRow_(ref, REFINING.firstDataRow, range_(1, REFINING.itemCols));
    ensureRows_(ref, itemStart + sel.length);
    var itemRange = ref.getRange(itemStart, 1, sel.length, REFINING.itemCols);
    itemRange.setValues(sel.map(function (p) { return [id, B.date, p.r[c.no - 1], p.r[c.weightBhy - 1], p.r[c.purity - 1], p.r[c.cost - 1], B.base]; }));
    // 2) Status -> Refined, and the new Batch #s
    var stR = pur.getRange(PURCHASES.firstDataRow, c.status, s.n, 1), st = stR.getValues(), st0 = st.map(function (x) { return [x[0]]; });
    var bR = hasB ? pur.getRange(PURCHASES.firstDataRow, BATCHNO.purCol, s.n, 1) : null, bv = hasB ? bR.getValues() : null, bv0 = hasB ? bv.map(function (x) { return [x[0]]; }) : null;
    var info = {}, newB = {};
    sel.forEach(function (p) { var n = Number(p.r[c.no - 1]); st[p.idx][0] = 'Refined'; if (hasB) { newB[n] = nextB; bv[p.idx][0] = nextB++; } info[String(n)] = { batch: id, base: B.base }; });
    var moved;
    try {
      stR.setValues(st); if (hasB) bR.setValues(bv);
      SpreadsheetApp.flush();
      moved = archiveRows_(info, new Date());
    } catch (err) {
      try { goldApiAddUndo_(err, { pur: pur, ref: ref, s: s, stR: stR, st0: st0, bR: bR, bv0: bv0, hasB: hasB, sel: sel, itemStart: itemStart, itemRange: itemRange }); }
      catch (e2) { err.message += ' (undo also failed: ' + e2.message + ')'; }
      throw err;
    }
    SpreadsheetApp.flush();
    // v10 review: the labels show the items' NEW Batch #s in this batch (their Archive label "R-… · #n")
    var labels = sel.map(function (p) { var n = Number(p.r[c.no - 1]); return goldApiLabel_(n, hasB ? newB[n] : null); }).join(', ');
    return { message: (sel.length === 1 ? 'Item ' + labels : sel.length + ' items (' + labels + ')') + ' added to batch ' + id + '.' +
                      (B.actualG !== null ? ' Its actual refined weight (' + B.actualG + ' g) was typed before: update it if the weight changed.' : ''),
             batchId: id, added: sel.length, moved: moved };
  } finally { lock.releaseLock(); }
}
/**
 * v10 review: undo of a failed addToBatch. archiveRows_ says what happened (err.archiveDeleted):
 *  - nothing deleted from Purchases: it already cleared its Archive rows; Refining item rows are cleared and the
 *    Purchases Status / Batch # columns go back to the values read before (rows have not moved).
 *  - some Purchases rows deleted: the Archive copies of rows still on Purchases are removed (archiveRowsUndo_).
 *    The selected items still on Purchases (found again by item No.) go back to their old Status / Batch # and
 *    leave the Refining item table; items whose Purchases row is already gone stay in the batch (Archive +
 *    Refining), so every item is counted exactly once. err.message says which items were added.
 */
function goldApiAddUndo_(err, u) {
  var c = PURCHASES.cols;
  if (!err.archiveDeleted) {
    u.itemRange.clearContent();
    u.stR.setValues(u.st0); if (u.hasB) u.bR.setValues(u.bv0);   // rows have not moved
    SpreadsheetApp.flush();
    return;
  }
  var still = archiveRowsUndo_(err), back = {};
  still.forEach(function (n) { back[n] = true; });
  // Purchases: re-match the selected items still there by No. and restore their own old Status / Batch #
  var last = u.pur.getLastRow();
  if (last >= PURCHASES.firstDataRow) {
    var nn = last - PURCHASES.firstDataRow + 1, nosNow = u.pur.getRange(PURCHASES.firstDataRow, c.no, nn, 1).getValues();
    u.sel.forEach(function (p) {
      var no = Number(p.r[c.no - 1]); if (!back[no]) return;
      for (var i = 0; i < nn; i++) if (Number(nosNow[i][0]) === no) {
        u.pur.getRange(PURCHASES.firstDataRow + i, c.status).setValue(u.st0[p.idx][0]);
        if (u.hasB) u.pur.getRange(PURCHASES.firstDataRow + i, BATCHNO.purCol).setValue(u.bv0[p.idx][0]);
        break;
      }
    });
  }
  // Refining: keep only the item rows of items that really moved (compacted, values only)
  var rows = u.itemRange.getValues(), keep = rows.filter(function (r) { return !back[Number(r[2])]; });
  while (keep.length < rows.length) keep.push(new Array(REFINING.itemCols).fill(''));
  u.itemRange.setValues(keep);
  SpreadsheetApp.flush();
  var gone = u.sel.map(function (p) { return Number(p.r[c.no - 1]); }).filter(function (n) { return !back[n]; });
  err.message += ' Partly done: ' + (gone.length ? 'item' + (gone.length === 1 ? '' : 's') + ' #' + gone.join(', #') + ' did go into the batch; ' : '') +
                 'the others stayed In stock. Refresh and check the batch.';
}
function goldApiRemoveFromBatch_(req) {
  var id = String(req.batchId || '').trim(), no = Number(req.no);
  if (!id) throw new Error('Pick a batch.');
  if (!(no > 0)) throw new Error('Item number is missing.');
  var ss = SpreadsheetApp.getActive(), pur = ss.getSheetByName(PURCHASES.sheet), ref = ss.getSheetByName(REFINING.sheet), ar = ss.getSheetByName(ARCHIVE.sheet);
  if (!pur || !ref || !ar) throw new Error('Purchases, Refining or Archive tab not found.');
  var c = PURCHASES.cols, first = REFINING.firstDataRow;
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var B = goldApiOpenBatch_(ref, id);
    var last = ref.getLastRow(), items = last >= first ? ref.getRange(first, 1, last - first + 1, REFINING.itemCols).getValues() : [];
    var at = -1, count = 0;
    items.forEach(function (v, i) { if (String(v[0]) === id && v[3] !== '' && v[3] !== null) { count++; if (Number(v[2]) === no) at = i; } });
    if (at < 0) throw new Error('Item #' + no + ' is not in batch ' + id + '.');
    if (count <= 1) throw new Error('It is the only item in batch ' + id + ', so it stays.');
    var aw = Math.min(ar.getMaxColumns(), BUYINFO.arcQid), alast = ar.getLastRow(), arow = -1, a = null;
    if (alast >= ARCHIVE.firstDataRow) {
      var av = ar.getRange(ARCHIVE.firstDataRow, 1, alast - ARCHIVE.firstDataRow + 1, aw).getValues();
      for (var i = 0; i < av.length; i++) if (Number(av[i][0]) === no && String(av[i][ARCHIVE.cols.batch - 1]).trim() === id) { arow = ARCHIVE.firstDataRow + i; a = av[i]; break; }
    }
    if (!a) throw new Error('Item #' + no + ' is no longer on the Archive tab (older batches keep only totals), so it cannot go back to stock here.');
    if (String(a[10]).trim() === 'Sold') throw new Error('Item #' + no + ' is marked Sold on the Archive tab.');
    // 1) Back on Purchases as In stock (its own No., purchase date, weight, purity, cost, time and group)
    var row = firstEmptyRow_(pur, PURCHASES.firstDataRow, colValues_(c));
    ensureRows_(pur, row);
    var pairs = [[c.no, no], [c.date, a[1]], [c.weightBhy, a[2]], [c.purity, a[4]], [c.cost, a[6]], [c.status, 'In stock']], bno = null;
    if (batchNoOn_()) { ensureBatchNoCols_(); bno = nextBatchNo_(pur); pairs.push([BATCHNO.purCol, bno]); }
    var tAt = aw >= BUYINFO.arcQid ? a[BUYINFO.arcAt - 1] : '', tQ = aw >= BUYINFO.arcQid ? a[BUYINFO.arcQid - 1] : '';
    var has = function (v) { return v !== '' && v !== null && v !== undefined; };
    var bi = buyInfoOn_() && pur.getMaxColumns() >= BUYINFO.purQid;
    if (!bi && (has(tAt) || has(tQ))) { try { bi = !!ensureBuyInfoCols_(); } catch (e) { bi = false; } }
    if (bi) { pairs.push([BUYINFO.purAt, has(tAt) ? tAt : '']); pairs.push([BUYINFO.purQid, has(tQ) ? tQ : '']); }   // always: a reused row keeps no old time / group
    var bLast0 = batchNoOn_() ? batchNoProps_().getProperty(BATCHNO.prop) : null;
    pairs.forEach(function (p) { pur.getRange(row, p[0]).setValue(p[1]); });
    if (bno !== null) setBatchNoLast_(bno);
    SpreadsheetApp.flush();
    if (Number(pur.getRange(row, c.no).getValue()) !== no) throw new Error('Could not write item #' + no + ' back to Purchases; nothing else was changed.');
    // 2) Out of the batch: its Archive row, then its Refining item row (the rows below move up one; values only)
    var arDeleted = false;
    try {
      if (ar.getMaxRows() < 60) ar.insertRowsAfter(ar.getMaxRows(), 100);   // Sheets refuses to delete the last rows
      ar.deleteRow(arow); arDeleted = true;
      var below = items.slice(at + 1); below.push(new Array(REFINING.itemCols).fill(''));
      ref.getRange(first + at, 1, below.length, REFINING.itemCols).setValues(below);
      SpreadsheetApp.flush();
    } catch (err) {   // v10 review: undo, so the item is never both In stock and in the batch
      try { goldApiRemoveUndo_({ pur: pur, ref: ref, ar: ar, no: no, row: row, items: items, a: a, arow: arow, arDeleted: arDeleted, bno: bno, bLast0: bLast0 }); }
      catch (e2) { err.message += ' (undo also failed: ' + e2.message + ')'; throw err; }
      err.message += ' Nothing was changed: item #' + no + ' is still in batch ' + id + '.';
      throw err;
    }
    return { message: 'Item ' + goldApiLabel_(no, bno) + ' is back In stock (out of batch ' + id + ').' +
                      (B.actualG !== null ? ' Its actual refined weight (' + B.actualG + ' g) was typed before: update it if the weight changed.' : ''),
             batchId: id, no: no, bno: bno === null ? undefined : bno };
  } finally { lock.releaseLock(); }
}
/**
 * v10 review: undo of a failed removeFromBatch: deletes the Purchases row written for the item (found by its No.),
 * puts the Refining item table A..G back exactly as it was read and, when its Archive row was already deleted,
 * writes that row's input columns back (the formula columns D F H I J N S fill themselves).
 */
function goldApiRemoveUndo_(u) {
  var c = PURCHASES.cols, first = REFINING.firstDataRow;
  var last = u.pur.getLastRow(), prow = -1;
  if (last >= PURCHASES.firstDataRow) {
    var nos = u.pur.getRange(PURCHASES.firstDataRow, c.no, last - PURCHASES.firstDataRow + 1, 1).getValues();
    for (var i = nos.length - 1; i >= 0; i--) if (Number(nos[i][0]) === u.no) { prow = PURCHASES.firstDataRow + i; break; }
  }
  if (prow > 0) {
    if (u.pur.getMaxRows() < 60) u.pur.insertRowsAfter(u.pur.getMaxRows(), 100);
    u.pur.deleteRow(prow);
  }
  if (u.bno !== null && u.bLast0 !== null) batchNoProps_().setProperty(BATCHNO.prop, u.bLast0);
  if (u.items.length) {   // the table as read, plus the row below it (the failed shift may have written there too)
    var back = u.items.slice();
    if (u.ref.getMaxRows() >= first + back.length) back.push(new Array(REFINING.itemCols).fill(''));
    u.ref.getRange(first, 1, back.length, REFINING.itemCols).setValues(back);
  }
  if (u.arDeleted) {
    var a = u.a, w = a.length, r = firstEmptyRow_(u.ar, ARCHIVE.firstDataRow, [1, 3, 5, 7, 11]);
    ensureRows_(u.ar, r);
    [[1, 3], [5, 1], [7, 1], [11, 3], [ARCHIVE.cols.batch, 3], [ARCHIVE.cols.bno, 1], [BUYINFO.arcAt, 2]].forEach(function (b) {
      if (b[0] + b[1] - 1 > w) return;
      u.ar.getRange(r, b[0], 1, b[1]).setValues([a.slice(b[0] - 1, b[0] - 1 + b[1])]);
    });
  }
  SpreadsheetApp.flush();
}
// ---------- v11: undo the newest refining batch (last resort, Settings) ----------
/**
 * The NEWEST batch (last row of the batch register), only while not sold / not in Sales, goes back In stock:
 * every item of it (also ones added later from stock) gets its Purchases row back from its Archive copy with its own
 * No., date, weight, purity, cost, Bought at and Quote ID (Bought together group) and its own Batch #. Rows go back in
 * item-No. order among the rows that are there now. In stock items bought after the batch keep their No., date and
 * group; only their Batch # changes: they take the next numbers after the highest one brought back, in order, so no two
 * In stock items share a # and there is no gap.
 * Then the batch leaves Archive, the Refining item table (compacted) and the register (M..O, X..Z, AD..AE cleared),
 * so its ID can be used again. req.batchId must be that newest batch; req.items (optional) its item count as seen.
 * A repeat (same rid, or the batch already gone) changes nothing.
 */
function goldApiUndoLastBatch_(req) {
  var id = String(req.batchId || '').trim();
  if (!id) throw new Error('Pick a batch.');
  var ss = SpreadsheetApp.getActive(), pur = ss.getSheetByName(PURCHASES.sheet), ref = ss.getSheetByName(REFINING.sheet), ar = ss.getSheetByName(ARCHIVE.sheet);
  if (!pur || !ref || !ar) throw new Error('Purchases, Refining or Archive tab not found.');
  var c = PURCHASES.cols, R = REFINING.reg, first = REFINING.firstDataRow;
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    // 1) Checks: newest batch, unsold, not in Sales, every item still on Archive and not Sold
    var last = ref.getLastRow(), regIds = last >= first ? ref.getRange(first, R.id, last - first + 1, 1).getValues() : [], regAt = -1;
    for (var i = regIds.length - 1; i >= 0; i--) if (String(regIds[i][0]).trim() !== '') { regAt = i; break; }
    if (regAt < 0) throw new Error('There is no refining batch to undo.');
    var newest = String(regIds[regAt][0]).trim();
    if (newest !== id) {
      var known = regIds.some(function (v) { return String(v[0]).trim() === id; });
      throw new Error(known ? 'Batch ' + id + ' is not the newest batch (' + newest + ' is), so it cannot be undone. Nothing was changed.'
                            : 'Batch ' + id + ' is not on the sheet any more (already undone?). Nothing was changed.');
    }
    goldApiOpenBatch_(ref, id);   // throws when sold / sale details typed / recorded
    var sal = ss.getSheetByName(SALES.sheet);
    if (sal && sal.getLastRow() >= SALES.firstDataRow && sal.getMaxColumns() >= SALES.batchCol) {
      var sb = sal.getRange(SALES.firstDataRow, SALES.batchCol, sal.getLastRow() - SALES.firstDataRow + 1, 1).getValues();
      if (sb.some(function (v) { return String(v[0]).trim() === id; })) throw new Error('Batch ' + id + ' is in the Sales tab, so it cannot be undone.');
    }
    var items = ref.getRange(first, 1, last - first + 1, REFINING.itemCols).getValues();
    var mine = items.filter(function (v) { return String(v[0]).trim() === id && v[3] !== '' && v[3] !== null; });
    if (!mine.length) throw new Error('Batch ' + id + ' has no items on the Refining tab.');
    if (req.items !== undefined && req.items !== null && req.items !== '' && Number(req.items) !== mine.length)
      throw new Error('Batch ' + id + ' changed since you opened this (' + mine.length + ' items now). Nothing was changed. Refresh and try again.');
    var aw = Math.min(ar.getMaxColumns(), BUYINFO.arcQid), alast = ar.getLastRow();
    var av = alast >= ARCHIVE.firstDataRow ? ar.getRange(ARCHIVE.firstDataRow, 1, alast - ARCHIVE.firstDataRow + 1, aw).getValues() : [];
    var arcBy = {}, arcRows = [];
    av.forEach(function (r, k) { if (String(r[ARCHIVE.cols.batch - 1]).trim() === id) { arcBy[Number(r[0])] = r; arcRows.push(ARCHIVE.firstDataRow + k); } });
    var back = mine.map(function (v) {
      var no = Number(v[2]), a = arcBy[no];
      if (!a) throw new Error('Item #' + no + ' of batch ' + id + ' is not on the Archive tab any more, so the batch cannot be undone. Nothing was changed.');
      if (String(a[10]).trim() === 'Sold') throw new Error('Item #' + no + ' is marked Sold on the Archive tab. Nothing was changed.');
      return a;
    });
    if (arcRows.length !== back.length) throw new Error('Batch ' + id + ' has ' + arcRows.length + ' Archive rows but ' + back.length + ' items on Refining. Nothing was changed; check the sheet.');
    back.sort(function (x, y) { return Number(x[0]) - Number(y[0]); });
    var get = function (a, col) { return col <= a.length ? a[col - 1] : ''; }, has = function (v) { return v !== '' && v !== null && v !== undefined; };

    // 2) Batch #: brought-back items keep theirs; In stock items bought since move up by the highest one brought back
    var bOn = batchNoOn_(), bLast0 = bOn ? batchNoProps_().getProperty(BATCHNO.prop) : null;
    var bBack = back.map(function (a) { return goldApiNum_(get(a, ARCHIVE.cols.bno)); });
    var useB = bOn && bBack.some(function (b) { return b !== null; });
    if (useB) ensureBatchNoCols_();
    var M = 0; bBack.forEach(function (b) { if (b !== null && b > M) M = b; });
    var tOn = back.some(function (a) { return has(get(a, BUYINFO.arcAt)) || has(get(a, BUYINFO.arcQid)); });
    if (tOn) { try { ensureBuyInfoCols_(); } catch (e) { tOn = false; } }
    var W = Math.max(PURCHASES.lastCol, useB || pur.getMaxColumns() >= BATCHNO.purCol ? BATCHNO.purCol : 0, (tOn || (buyInfoOn_() && pur.getMaxColumns() >= BUYINFO.purQid)) ? BUYINFO.purQid : 0);
    W = Math.min(W, pur.getMaxColumns());

    // 3) Purchases: insert the rows back in No. order among the rows there now (bottom-up, so earlier positions hold)
    var plast = pur.getLastRow(), pn = plast >= PURCHASES.firstDataRow ? plast - PURCHASES.firstDataRow + 1 : 0;
    var pv = pn ? pur.getRange(PURCHASES.firstDataRow, 1, pn, W).getValues() : [];
    var used = 0; for (var u = pv.length - 1; u >= 0; u--) if (pv[u].some(function (x) { return x !== '' && x !== null; })) { used = u + 1; break; }
    pv = pv.slice(0, used);
    var have = {}; pv.forEach(function (r) { if (has(r[c.no - 1])) have[Number(r[c.no - 1])] = true; });
    back.forEach(function (a) { if (have[Number(a[0])]) throw new Error('Item #' + a[0] + ' is already on the Purchases tab. Nothing was changed; check the sheet.'); });
    var newer = pv.filter(function (r) { var st = String(r[c.status - 1] || '').trim(); return (st === 'In stock' || st === '') && has(r[c.weightBhy - 1]); }).length;
    var rowOf = function (a, bno) {
      var r = new Array(W).fill('');
      r[c.no - 1] = a[0]; r[c.date - 1] = a[1]; r[c.weightBhy - 1] = a[2]; r[c.purity - 1] = a[4]; r[c.cost - 1] = a[6]; r[c.status - 1] = 'In stock';
      if (W >= BATCHNO.purCol && useB) r[BATCHNO.purCol - 1] = bno === null ? '' : bno;
      if (W >= BUYINFO.purQid) { r[BUYINFO.purAt - 1] = get(a, BUYINFO.arcAt); r[BUYINFO.purQid - 1] = get(a, BUYINFO.arcQid); }
      return r;
    };
    var merged = pv.map(function (r) { return { r: r, old: true }; });
    back.forEach(function (a, k) {
      var no = Number(a[0]), at = merged.length;
      for (var j = 0; j < merged.length; j++) { var n2 = Number(merged[j].r[c.no - 1]); if (has(merged[j].r[c.no - 1]) && n2 > no) { at = j; break; } }
      merged.splice(at, 0, { r: rowOf(a, bBack[back.indexOf(a)]), old: false });
    });
    var shifted = 0;
    if (useB && M > 0) merged.forEach(function (m) {
      if (!m.old) return; var st = String(m.r[c.status - 1] || '').trim(), b = goldApiNum_(m.r[BATCHNO.purCol - 1]);
      if ((st === 'In stock' || st === '') && b !== null) { shifted++; m.r[BATCHNO.purCol - 1] = M + shifted; }   // next numbers, in order, no gap
    });
    // Formula columns (D F H I J N) come from row-1 ARRAYFORMULAs: write only input columns, as blocks
    var outRows = merged.map(function (m) { return m.r; });
    ensureRows_(pur, PURCHASES.firstDataRow + outRows.length);
    var blocks = [[1, 3], [5, 1], [7, 1], [11, 3]];
    if (W >= BATCHNO.purCol) blocks.push([BATCHNO.purCol, 1]);
    if (W >= BUYINFO.purQid) blocks.push([BUYINFO.purAt, 2]);
    var pvOld = pn ? pur.getRange(PURCHASES.firstDataRow, 1, pn, W).getValues() : [];
    var writeP = function (rows, n) {
      blocks.forEach(function (b) {
        pur.getRange(PURCHASES.firstDataRow, b[0], n, b[1]).setValues(rows.slice(0, n).map(function (r) { return r.slice(b[0] - 1, b[0] - 1 + b[1]); }));
      });
    };
    writeP(outRows, outRows.length);
    if (useB) setBatchNoLast_(M + shifted);
    SpreadsheetApp.flush();
    var chk = pur.getRange(PURCHASES.firstDataRow, 1, outRows.length, 1).getValues();
    var bad = outRows.some(function (r, k) { return String(chk[k][0]) !== String(r[0]); });
    try {
      if (bad) throw new Error('Could not write the items back to Purchases.');
      // 4) Out of Archive (bottom-up), Refining item table (compacted), register row
      if (ar.getMaxRows() - arcRows.length < 50) ar.insertRowsAfter(ar.getMaxRows(), 100);
      arcRows.slice().sort(function (x, y) { return y - x; }).forEach(function (r) { ar.deleteRow(r); });
      var keep = items.filter(function (v) { return String(v[0]).trim() !== id; });
      while (keep.length < items.length) keep.push(new Array(REFINING.itemCols).fill(''));
      ref.getRange(first, 1, items.length, REFINING.itemCols).setValues(keep);
      var rr = first + regAt;
      ref.getRange(rr, R.id, 1, REFINING.regCols).clearContent();
      ref.getRange(rr, R.sellDate, 1, 3).clearContent();
      if (ref.getMaxColumns() >= BATCH_EST.actualG) ref.getRange(rr, BATCH_EST.estBase, 1, 2).clearContent();
      ref.getRange(REFINING.selectorCell).clearContent();
      SpreadsheetApp.flush();
    } catch (err) {
      // Put Purchases back as it was (the batch is still whole only when Archive was not touched yet)
      if (ar.getLastRow() >= ARCHIVE.firstDataRow) {
        var still = ar.getRange(ARCHIVE.firstDataRow, ARCHIVE.cols.batch, ar.getLastRow() - ARCHIVE.firstDataRow + 1, 1).getValues()
          .filter(function (v) { return String(v[0]).trim() === id; }).length;
        if (still === arcRows.length) {
          var pad = pvOld.slice(); while (pad.length < outRows.length) pad.push(new Array(W).fill(''));
          writeP(pad, pad.length);
          if (useB && bLast0 !== null) batchNoProps_().setProperty(BATCHNO.prop, bLast0);
          SpreadsheetApp.flush();
          err.message += ' Nothing was changed: batch ' + id + ' is still there.';
        } else err.message += ' Partly done: check the Purchases, Archive and Refining tabs.';
      }
      throw err;
    }
    return { message: 'Batch ' + id + ' undone: its ' + back.length + ' item' + (back.length === 1 ? ' is' : 's are') + ' back In stock' +
                       (newer ? ' with the ' + newer + ' item' + (newer === 1 ? '' : 's') + ' bought since' : '') + '.' +
                       (shifted ? (shifted === 1 ? ' That newer item now has Batch # ' + (M + 1) : ' Those ' + shifted + ' newer items now have Batch # ' + (M + 1) + '–' + (M + shifted)) + ', after the items brought back.' : ''),
             batchId: id, restored: back.length, newer: newer, shift: shifted ? M : 0 };
  } finally { lock.releaseLock(); }
}
/** Read: the items of one batch (Refining item table), and which can still go back to stock (Archive row there). */
function goldApiBatchItems_(req) {
  var id = String(req.batchId || '').trim();
  if (!id) throw new Error('Pick a batch.');
  var ss = SpreadsheetApp.getActive(), ref = ss.getSheetByName(REFINING.sheet), ar = ss.getSheetByName(ARCHIVE.sheet);
  if (!ref) throw new Error('Refining tab not found.');
  goldApiRegRow_(ref, id);   // throws when the batch is unknown
  var bhy = getNamed_('BHYPerGram') || 2, onArc = {};
  if (ar && ar.getLastRow() >= ARCHIVE.firstDataRow) {
    var w = Math.min(ar.getMaxColumns(), Math.max(ARCHIVE.cols.bno, BUYINFO.arcAt));
    ar.getRange(ARCHIVE.firstDataRow, 1, ar.getLastRow() - ARCHIVE.firstDataRow + 1, w).getValues().forEach(function (r) {
      if (String(r[ARCHIVE.cols.batch - 1]).trim() !== id) return;
      onArc[Number(r[0])] = { bno: w >= ARCHIVE.cols.bno ? goldApiNum_(r[ARCHIVE.cols.bno - 1]) : null, sold: String(r[10]).trim() === 'Sold', date: goldApiDate_(r[1]), at: w >= BUYINFO.arcAt ? goldApiAt_(r[BUYINFO.arcAt - 1]) : '' };
    });
  }
  var open = true; try { goldApiOpenBatch_(ref, id); } catch (e) { open = false; }
  var items = [], last = ref.getLastRow();
  if (last >= REFINING.firstDataRow) ref.getRange(REFINING.firstDataRow, 1, last - REFINING.firstDataRow + 1, 6).getValues().forEach(function (v) {
    if (String(v[0]) !== id || v[3] === '' || v[3] === null) return;
    var no = Number(v[2]), x = onArc[no];
    items.push({ no: no, bno: x ? x.bno : null, weightBhy: Number(v[3]), grams: goldR_(Number(v[3]) / bhy, 4), purity: Number(v[4]) || 0, cost: goldApiNum_(v[5]),
                 date: x ? x.date : '', at: x ? x.at : '', back: open && !!x && !x.sold });
  });
  return { ok: true, batchId: id, open: open, items: items, version: GOLD_API.version };
}

// ---------- v8: backup (whole spreadsheet as .xlsx) ----------
/**
 * Exports the spreadsheet as .xlsx through Google's export link, signed in as the script owner, and
 * returns it base64-encoded. Read only: nothing on the sheet changes.
 */
function goldApiExportBackup_() {
  var ss = SpreadsheetApp.getActive(), id = ss.getId();
  var name = ss.getName();
  try { name = DriveApp.getFileById(id).getName(); } catch (e) {
    throw new Error('Backup needs Drive access. In Apps Script run authorizeBackup once, allow access, then make a New version of the deployment.');
  }
  var url = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(id) + '/export?format=xlsx';
  var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true, followRedirects: true });
  var code = resp.getResponseCode();
  if (code !== 200) throw new Error('Google did not export the sheet (HTTP ' + code + ').' + (code === 401 || code === 403 ? ' Run authorizeBackup once in Apps Script and allow Drive access.' : ' Try again in a minute.'));
  var bytes = resp.getContent();
  if (!bytes || bytes.length < 100) throw new Error('The export came back empty. Try again in a minute.');
  if (bytes.length > GOLD_API.backupMaxBytes) throw new Error('The backup is too large for the app (' + Math.round(bytes.length / 1048576) + ' MB).');
  return { ok: true, name: name, size: bytes.length, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
           at: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss"), data: Utilities.base64Encode(bytes), version: GOLD_API.version };
}
/** Run once from the Apps Script editor (Run > authorizeBackup): asks for the Drive access the backup needs, and tests it. */
function authorizeBackup() {
  var r = goldApiExportBackup_();
  var msg = 'Backup works: ' + r.name + ', ' + Math.round(r.size / 1024) + ' KB.';
  Logger.log(msg);
  return msg;
}

// ---------- State (read only) ----------
/**
 * Every sheet range is read once per request (v2): Settings in one block, Purchases, Archive,
 * the Refining register, Sales and the Dashboard once each, then everything is worked out in memory.
 */
function goldApiCtx_(ss) {
  var sheets = {}, memo = {};
  var sheet = function (n) { if (!(n in sheets)) sheets[n] = ss.getSheetByName(n); return sheets[n]; };
  // Rows firstRow..lastRow, columns 1..ncols (or firstCol..firstCol+ncols-1). [] when empty.
  var rows = function (n, firstRow, ncols, firstCol) {
    var k = n + '|' + firstRow + '|' + ncols + '|' + (firstCol || 1);
    if (k in memo) return memo[k];
    var sh = sheet(n), out = [];
    if (sh) { var last = sh.getLastRow(); if (last >= firstRow) out = sh.getRange(firstRow, firstCol || 1, last - firstRow + 1, ncols).getValues(); }
    return (memo[k] = out);
  };
  return { ss: ss, sheet: sheet, rows: rows };
}

/**
 * Named-range values. All of them live on Settings (B3:B15), so they come out of the one Settings
 * block read. Where each name points is looked up once (getNamedRanges) and remembered for 6 hours;
 * a name that is not on Settings, or not found, is read the normal way (getNamed_).
 */
function goldApiNamed_(C, setVals) {
  var where = null, cache = null, key = 'goldapi:namedpos:v1';
  try { cache = CacheService.getScriptCache(); var hit = cache.get(key); if (hit) where = JSON.parse(hit); } catch (e) { where = null; }
  if (!where) {
    where = {};
    try {
      var list = C.ss.getNamedRanges ? C.ss.getNamedRanges() : [];
      for (var i = 0; i < list.length; i++) {
        var r = list[i].getRange();
        if (r.getSheet().getName() === SETTINGS.sheet && r.getNumRows() === 1 && r.getNumColumns() === 1)
          where[list[i].getName()] = [r.getRow(), r.getColumn()];
      }
      if (cache && list.length) cache.put(key, JSON.stringify(where), GOLD_API.dedupeSeconds);
    } catch (e) { where = {}; }
  }
  return function (name) {
    var p = where[name];
    if (p && setVals[p[0] - 1] && p[1] - 1 < setVals[p[0] - 1].length) {
      var v = setVals[p[0] - 1][p[1] - 1];
      return (v === '' || v === null) ? null : Number(v);
    }
    return getNamed_(name);
  };
}

function goldApiState_() {
  var ss = SpreadsheetApp.getActive();
  var C = goldApiCtx_(ss);
  var set = C.sheet(SETTINGS.sheet);
  var setVals = set ? set.getRange(1, 1, Math.min(set.getMaxRows(), 40), Math.min(set.getMaxColumns(), 4)).getValues() : [];
  var cell = function (a1) {
    var m = a1.match(/^([A-Z])(\d+)$/), r = Number(m[2]) - 1, c = m[1].charCodeAt(0) - 65;
    if (setVals[r] && c < setVals[r].length) return setVals[r][c];
    return set ? set.getRange(a1).getValue() : '';
  };
  var named = goldApiNamed_(C, setVals);

  // Same rules as Code.gs getQuoteSettings()
  var base = named(SETTINGS.basePriceName), margin = named('QuoteMargin'), fullMin = named('FullBaseMinPurity');
  if (margin === null || !isFinite(margin)) margin = 0.01;
  if (margin >= 1) margin = margin / 100;
  if (fullMin === null || !isFinite(fullMin) || fullMin <= 0) fullMin = 0.998;
  if (fullMin > 1) fullMin = fullMin / 100;
  var settings = {
    base: base, margin: margin, fullMin: fullMin,
    bhyPerGram: named('BHYPerGram') || 2,
    refiningFee: named('RefiningFee') || 0,
    silverDivisor: named('SilverDivisor'), silverMultiplier: named('SilverMultiplier')
  };

  var pur = C.rows(PURCHASES.sheet, PURCHASES.firstDataRow, goldApiPurW_(C.sheet(PURCHASES.sheet)));
  var arc = C.rows(ARCHIVE.sheet, ARCHIVE.firstDataRow, ARCHIVE.cols.batch);   // A..O (v10: O Batch ID for dailySold)
  var tot = C.rows(ARCHIVE_TOTALS.sheet, ARCHIVE_TOTALS.firstDataRow, ARCHIVE_TOTALS.headers.length);  // [] if no tab
  var maxNo = 0;
  [pur, arc].forEach(function (vals) {
    vals.forEach(function (v) { var n = Number(v[0]); if (v[0] !== '' && v[0] !== null && isFinite(n) && n > maxNo) maxNo = n; });
  });
  tot.forEach(function (v) { var n = Number(v[ARCHIVE_TOTALS.cols.maxNo - 1]); if (v[ARCHIVE_TOTALS.cols.maxNo - 1] !== '' && isFinite(n) && n > maxNo) maxNo = n; });
  var batches = goldApiBatches_(C, settings);
  var monthPack = goldApiMonthPack_(C, pur, arc, tot);   // v12: current month + every month, one calculation
  // v8: next Batch # (same rule as Code.gs nextBatchNo_), from the rows already read
  var bOn = batchNoOn_(), nextBno = null;
  if (bOn) {
    var mb = Number(batchNoProps_().getProperty(BATCHNO.prop)) || 0;
    pur.forEach(function (v) { var b = goldApiNum_(v[BATCHNO.purCol - 1]); if (b !== null && b > mb) mb = b; });
    nextBno = mb + 1;
  }

  return {
    version: GOLD_API.version,
    serverTime: Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss"),
    today: todayStr_(),
    base: base,
    source: goldApiText_(cell(SETTINGS.sourceCell)),
    priceDate: goldApiText_(cell(SETTINGS.priceDateCell)),
    lastUpdated: goldApiText_(cell(SETTINGS.lastUpdatedCell), 'yyyy-MM-dd HH:mm'),
    updateStatus: goldApiText_(cell(SETTINGS.statusCell)),
    settings: settings,
    nextNo: maxNo + 1,
    nextBno: nextBno, batchNos: bOn,   // v8
    stock: goldApiStock_(pur, settings),
    batches: batches,
    dashboard: goldApiDashboard_(C, batches),
    month: monthPack.month,
    realizedMonths: monthPack.realizedMonths,   // v12
    daily: goldApiDaily_(pur, arc, tot, settings.bhyPerGram || 2),   // v9
    dailySold: goldApiDailySold_(pur, arc, tot, settings.bhyPerGram || 2, batches),   // v10
    dailyGapUntil: goldApiDailyGap_(tot),
    sales: goldApiSales_(C)
  };
}

/** One Purchases row -> stock item, or null when it is not In stock. settingsFn() gives {base, bhyPerGram}. */
function goldApiStockItem_(r, settingsFn) {
  var c = PURCHASES.cols;
  var w = r[c.weightBhy - 1];
  var st = String(r[c.status - 1] || '').trim();
  if (w === '' || w === null || (st && st !== 'In stock')) return null;
  var weight = Number(w), purity = Number(r[c.purity - 1]) || 0, cost = r[c.cost - 1] === '' ? null : Number(r[c.cost - 1]);
  var gramsCell = goldApiNum_(r[3]);    // D Grams (sheet formula)
  var grams = gramsCell !== null ? gramsCell : weight / settingsFn().bhyPerGram;
  var sell = goldApiNum_(r[8]);          // I Projected sell price (sheet formula)
  if (sell === null) { var s = settingsFn(); if (s.base) sell = s.base * purity * (weight / s.bhyPerGram); }
  var profit = goldApiNum_(r[9]);        // J Projected profit
  if (profit === null && sell !== null && sell !== undefined && cost !== null) profit = sell - cost;
  return {
    no: r[c.no - 1] === '' ? null : Number(r[c.no - 1]),
    bno: r.length >= BATCHNO.purCol ? goldApiNum_(r[BATCHNO.purCol - 1]) : null,   // v8 Batch #
    date: goldApiDate_(r[c.date - 1]),
    weightBhy: weight, grams: goldR_(grams, 4), purity: purity,
    cost: cost, projSell: (sell === null || sell === undefined) ? null : round2_(sell), projProfit: profit === null ? null : round2_(profit),
    status: 'In stock',
    at: r.length >= BUYINFO.purQid ? goldApiAt_(r[BUYINFO.purAt - 1]) : '',     // v10 time bought ('' = not known)
    qid: r.length >= BUYINFO.purQid ? quoteId_(r[BUYINFO.purQid - 1]) : ''      // v10 batch-quote group
  };
}

function goldApiStock_(vals, settings) {
  var out = [];
  var sf = function () { return settings; };
  vals.forEach(function (r) { var it = goldApiStockItem_(r, sf); if (it) out.push(it); });
  return out;
}

function goldApiBatches_(C, st) {
  var R = REFINING.reg;
  // v7: also the estimate columns AD:AE when the tab is that wide (never reads past the last column).
  var sh = C.sheet(REFINING.sheet), width = sh ? Math.min(sh.getMaxColumns(), BATCH_EST.actualG) : R.recorded;
  var reg = C.rows(REFINING.sheet, REFINING.firstDataRow, Math.max(width, R.recorded) - R.id + 1, R.id);
  var col = function (row, k) { var v = row[k - R.id]; return v === undefined ? '' : v; };
  var out = [], silv = reg.length && st ? goldApiBatchSilver_(C, st) : {};
  reg.forEach(function (row, i) {
    var id = col(row, R.id);
    if (id === '' || id === null) return;
    var sellDate = col(row, R.sellDate), recorded = String(col(row, R.recorded) || '') !== '';
    var sold = sellDate !== '' && sellDate !== null &&
               (col(row, R.sellBase) !== '' || col(row, R.actualAmt) !== '');
    out.push({
      id: String(id), date: goldApiDate_(col(row, R.id + 1)), at: goldApiAt_(col(row, R.id + 1)) /* v11: batch made, date + time */, base: goldApiNum_(col(row, R.id + 2)),
      items: goldApiNum_(col(row, R.id + 3)), rawG: goldApiNum_(col(row, R.id + 4)), refinedG: goldApiNum_(col(row, R.refinedG)),
      costInclFee: goldApiNum_(col(row, R.costInclFee)), estValue: goldApiNum_(col(row, R.estValue)),
      estProfit: goldApiNum_(col(row, R.estValue + 1)), silverG: silv[String(id)] !== undefined ? silv[String(id)] : goldApiNum_(col(row, R.estValue + 2)),   // v6: 99.8%+ left out
      sellDate: goldApiDate_(sellDate), sellBase: goldApiNum_(col(row, R.sellBase)), actualAmt: goldApiNum_(col(row, R.actualAmt)),
      actualValue: goldApiNum_(col(row, R.actualValue)), actualProfit: goldApiNum_(col(row, R.actualValue + 1)),
      estBase: goldApiNum_(col(row, BATCH_EST.estBase)), actualG: goldApiNum_(col(row, BATCH_EST.actualG)),   // v7
      recorded: recorded, status: sold ? (recorded ? 'Sold' : 'Sold, not in Sales yet') : 'Refining',
      canAdd: !sold && !recorded && [R.sellDate, R.sellBase, R.actualAmt].every(function (k) { var v = col(row, k); return v === '' || v === null; })   // v10
    });
  });
  return out.reverse(); // newest first
}

/** The Dashboard tab, read once: first min(max(lastRow, 30), 80) rows, up to 12 columns. */
function goldApiDashVals_(C) {
  if (C.dash !== undefined) return C.dash;
  var d = C.sheet('Dashboard');
  C.dash = d ? { last: d.getLastRow(), vals: d.getRange(1, 1, Math.min(Math.max(d.getLastRow(), 30), 80), Math.min(d.getMaxColumns(), 12)).getValues() } : null;
  return C.dash;
}

/** Key Dashboard figures, found by their labels in column A (fixed cells as fallback). */
function goldApiDashboard_(C, batches) {
  var want = {
    cashUsed: { re: /^total cash used/i, cell: 5 },
    totalRealized: { re: /^total realized profit/i, cell: 19 },
    estRefiningProfit: { re: /^est\.? refining profit/i, cell: 29 },
    base: { re: /^base price/i, cell: 2 }
  };
  var out = {};
  var D = goldApiDashVals_(C);
  if (D) {
    var vals = D.vals;
    Object.keys(want).forEach(function (k) {
      var v = null;
      for (var i = 0; i < vals.length; i++) if (want[k].re.test(String(vals[i][0]).trim())) { v = goldApiNum_(vals[i][1]); break; }
      if (v === null && vals[want[k].cell - 1]) v = goldApiNum_(vals[want[k].cell - 1][1]);
      out[k] = v;
    });
  }
  // Unsold refining batches (already out of stock, not yet sold)
  var open = 0, openCount = 0;
  batches.forEach(function (b) { if (b.status === 'Refining') { open += b.estProfit || 0; openCount++; } });
  out.openBatchesEstProfit = round2_(open);
  out.openBatches = openCount;
  return out;
}

/**
 * Realized profit for every month, factored from the old single-month goldApiMonth_.
 * Same maths as the Dashboard MONTHLY table (Dashboard D:G):
 *   profit = COMPILATION 2026 summary for that month only (Sales B4:B9 for Jan–Jun, G4:G9 for Jul–Dec)
 *          + new Sales rows (H from row 11, by sale date A; H blank falls back to F − E)
 *          + sold Purchases and Archive items (N by Sold date L)
 *          + Archive Totals realized profit (N by Sold month D).
 * Purchases cost = Purchases G + Archive G by purchase date B, plus Archive Totals cost by purchase month.
 * A recorded batch is not added again from the Refining register: it is already in Sales H, or in the
 * item rows, which is the sheet formula. Summary rows 1–10 are not also read as sales (that would
 * count the compilation twice). When the Dashboard table has the month, its cells replace the sum,
 * so the app matches the sheet. The current month in this list is month.realizedProfit.
 */
function goldApiMonthYm_(v) {
  if (v === '' || v === null || v === undefined) return '';
  var d = goldApiDate_(v);
  return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : '';
}
function goldApiDashMonthTable_(dash) {
  var out = {};
  if (!dash || !dash.vals) return out;
  var vals = dash.vals.slice(0, Math.min(Math.max(dash.last || 1, 1), 40));
  for (var i = 0; i < vals.length; i++) {
    var j = vals[i].indexOf('Month');
    if (j < 0 || !/purchases cost/i.test(String(vals[i][j + 1])) || !/realized profit/i.test(String(vals[i][j + 3]))) continue;
    for (var k = i + 1; k < vals.length; k++) {
      if (/^total/i.test(String(vals[k][j]))) break;   // same stop as v11 goldApiMonth_
      var ym = goldApiMonthYm_(vals[k][j]);
      if (!ym || out[ym]) continue;   // v11 stops at the first Dashboard row for a month
      out[ym] = { profit: goldApiNum_(vals[k][j + 3]), cost: goldApiNum_(vals[k][j + 1]) };
    }
    break;
  }
  return out;
}
function goldApiMonthsFromRows_(sales, pur, arc, tot, dash, todayYm) {
  var map = {};
  var ensure = function (ym) {
    if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return null;
    return map[ym] || (map[ym] = { profit: 0, cost: 0, from: 'computed' });
  };
  var add = function (ym, p, c) {
    if (!p && !c) return;
    var e = ensure(ym); if (!e) return;
    e.profit += p || 0; e.cost += c || 0;
  };
  if (sales) {
    for (var m = 1; m <= 12; m++) {   // 2026 compilation summary only; rows 4–9, never the sales table
      var sr = sales[(m <= 6 ? 3 + m : m - 3) - 1];
      var v = sr ? goldApiNum_(sr[(m <= 6 ? 2 : 7) - 1]) : null;
      add('2026-' + (m < 10 ? '0' : '') + m, v || 0, 0);
    }
    sales.slice(SALES.firstDataRow - 1).forEach(function (r) {
      var h = goldApiNum_(r[7]);
      if (h === null && goldApiNum_(r[5]) !== null && goldApiNum_(r[4]) !== null) h = r[5] - r[4];
      add(goldApiMonthYm_(r[0]), h || 0, 0);
    });
  }
  [pur || [], arc || []].forEach(function (vals) {
    vals.forEach(function (r) {
      add(goldApiMonthYm_(r[1]), 0, goldApiNum_(r[6]) || 0);    // B purchase date, G cost
      add(goldApiMonthYm_(r[11]), goldApiNum_(r[13]) || 0, 0);  // L sold date, N realized profit
    });
  });
  var T = ARCHIVE_TOTALS.cols;
  (tot || []).forEach(function (r) {
    add(goldApiMonthYm_(r[T.buyMonth - 1]), 0, goldApiNum_(r[T.cost - 1]) || 0);
    add(goldApiMonthYm_(r[T.soldMonth - 1]), goldApiNum_(r[T.realized - 1]) || 0, 0);
  });
  var dashMap = goldApiDashMonthTable_(dash);
  Object.keys(dashMap).forEach(function (ym) {
    var e = ensure(ym), d = dashMap[ym]; if (!e) return;
    if (d.profit !== null) { e.profit = d.profit; e.from = 'dashboard'; }
    if (d.cost !== null) e.cost = d.cost;
  });
  if (todayYm) ensure(todayYm);
  return Object.keys(map).sort().map(function (ym) {
    var e = map[ym];
    return { month: ym, profit: round2_(e.profit), purchasesCost: round2_(e.cost), from: e.from };
  });
}
function goldApiMonthPack_(C, pur, arc, tot) {
  var NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var ym = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  var dash = null;
  try { dash = goldApiDashVals_(C); } catch (e) { dash = null; }
  var built = goldApiMonthsFromRows_(goldApiSalesVals_(C), pur, arc, tot, dash, ym);
  var cur = { ym: ym, name: NAMES[Number(ym.slice(5, 7)) - 1], realizedProfit: 0, purchasesCost: 0, from: 'computed' };
  built.forEach(function (row) {
    if (row.month !== ym) return;
    cur.realizedProfit = row.profit; cur.purchasesCost = row.purchasesCost; cur.from = row.from;
  });
  return {
    month: cur,
    realizedMonths: built.map(function (row) { return { month: row.month, profit: row.profit }; })
  };
}

/** Sales tab rows 1..last, columns A..I (summary rows 1-9 + table from row 11), read once. null if no tab. */
function goldApiSalesVals_(C) {
  if (!C.sheet(SALES.sheet)) return null;
  return C.rows(SALES.sheet, 1, SALES.batchCol);
}

function goldApiSales_(C) {
  var all = goldApiSalesVals_(C);
  if (!all) return [];
  var vals = all.slice(SALES.firstDataRow - 1);
  var out = [];
  vals.forEach(function (r, i) {
    if (r.slice(0, 6).every(function (v) { return v === '' || v === null; })) return;
    var cost = goldApiNum_(r[4]), actual = goldApiNum_(r[5]);
    var profit = goldApiNum_(r[7]);
    if (profit === null && cost !== null && actual !== null) profit = actual - cost;
    out.push({ row: SALES.firstDataRow + i, date: goldApiDate_(r[0]), base: goldApiNum_(r[1]), grams: goldApiNum_(r[2]),
               estValue: goldApiNum_(r[3]), cost: cost, actual: actual, profit: profit === null ? null : round2_(profit),
               batch: r[8] === '' ? '' : String(r[8]) });
  });
  return out.reverse().slice(0, GOLD_API.recentSales);
}

// ---------- small helpers (prefixed to avoid clashes with Code.gs) ----------
function goldApiNum_(v) {
  if (v === '' || v === null || v === undefined || goldApiIsDate_(v)) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}
function goldApiIsDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function goldApiPeso_(x) { return (x < 0 ? '-₱' : '₱') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
// v9: grams bought per Manila day, every purchase whatever its batch / status. Weight BHY (C) / BHYPerGram,
// the same grams as column D. Removed Archive rows come from Archive Totals rows that carry a purchase day.
function goldApiDaily_(pur, arc, tot, bhy) {
  var out = {}, ok = function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); };
  var add = function (d, g) { if (!ok(d) || g === null || !isFinite(g)) return; out[d] = (out[d] || 0) + g; };
  [pur, arc].forEach(function (vals) {
    vals.forEach(function (r) {
      var w = goldApiNum_(r[PURCHASES.cols.weightBhy - 1]);
      if (w === null || r[PURCHASES.cols.date - 1] === '' || r[PURCHASES.cols.date - 1] === null) return;
      add(goldApiDate_(r[PURCHASES.cols.date - 1]), w / bhy);
    });
  });
  var T = ARCHIVE_TOTALS.cols;
  (tot || []).forEach(function (r) {
    var d = r[T.buyDay - 1]; if (d === '' || d === null || d === undefined) return;
    add(goldApiDate_(d), goldApiNum_(r[T.grams - 1]));
  });
  Object.keys(out).forEach(function (k) { out[k] = Math.round(out[k] * 1e6) / 1e6; });
  return out;
}
// v10: the same grams, only for purchases sold since: item Sold, or its refining batch is sold (status Sold / Sold, not
// in Sales yet). Removed Archive rows (Archive Totals) by their batch, or a sold month on the totals row.
function goldApiDailySold_(pur, arc, tot, bhy, batches) {
  var sold = {}, out = {}, ok = function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); };
  (batches || []).forEach(function (b) { if (/^Sold/.test(b.status)) sold[b.id] = true; });
  var add = function (d, g) { if (!ok(d) || g === null || !isFinite(g)) return; out[d] = (out[d] || 0) + g; };
  var c = PURCHASES.cols;
  [pur, arc].forEach(function (vals, k) {
    vals.forEach(function (r) {
      var w = goldApiNum_(r[c.weightBhy - 1]);
      if (w === null || r[c.date - 1] === '' || r[c.date - 1] === null) return;
      var isSold = String(r[c.status - 1]).trim() === 'Sold' || (k === 1 && sold[String(r[ARCHIVE.cols.batch - 1] || '').trim()]);
      if (isSold) add(goldApiDate_(r[c.date - 1]), w / bhy);
    });
  });
  var T = ARCHIVE_TOTALS.cols;
  (tot || []).forEach(function (r) {
    var d = r[T.buyDay - 1]; if (d === '' || d === null || d === undefined) return;
    var sm = r[T.soldMonth - 1];
    if (sold[String(r[T.batch - 1] || '').trim()] || !(sm === '' || sm === null || sm === undefined)) add(goldApiDate_(d), goldApiNum_(r[T.grams - 1]));
  });
  Object.keys(out).forEach(function (k) { out[k] = Math.round(out[k] * 1e6) / 1e6; });
  return out;
}
/** v10: Bought at cell -> 'yyyy-MM-ddTHH:mm' (Manila), '' when blank / not a date. */
function goldApiAt_(v) { return goldApiIsDate_(v) ? Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm") : ''; }
function goldApiDailyGap_(tot) {
  var T = ARCHIVE_TOTALS.cols, last = '';
  (tot || []).forEach(function (r) {
    var d = r[T.buyDay - 1];
    if (!(d === '' || d === null || d === undefined) || (r[T.grams - 1] === '' || r[T.grams - 1] === null)) return;
    var k = goldApiDate_(r[T.removedOn - 1]); if (/^\d{4}-\d{2}-\d{2}$/.test(k) && k > last) last = k;
  });
  return last;
}
function goldApiDate_(v) {
  if (goldApiIsDate_(v)) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  if (typeof v === 'number' && v > 20000 && v < 80000) {   // a date serial stored as a number
    return Utilities.formatDate(new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86400000)), 'UTC', 'yyyy-MM-dd');
  }
  return v === null || v === undefined ? '' : String(v);
}
function goldApiText_(v, fmt) {
  if (goldApiIsDate_(v)) return Utilities.formatDate(v, TZ, fmt || 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}
