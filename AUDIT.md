# Lucas Gold Tracker — read-only audit

Daily use is a phone PWA (about 412px wide, Chrome on Samsung) talking to a Google Sheet through an Apps Script web app. This pass looked for wrong totals, lost purchases, races between the phone and the sheet, a service worker that can serve a stale page, errors that hide a failed save, and a token that can read or change the whole business. Nothing in the app was changed. The live Sheet and the Apps Script deployment were not called.

## What was read

| File | Where |
|---|---|
| `index.html`, `sw.js`, `manifest.json` | `main` at `66f5a22`. These are the files the phone loads. |
| `sheet/Api.gs`, `sheet/Code.gs` | Not on `main`. The v51 copies that match this page are on `origin/cursor/direct-sale-998-9656` at `9739f0e`. `index.html` and `sw.js` are the same blobs on both (`c4f2927b` and `118a9639`). Line numbers for the script are from that commit. |

Confirmed means the path was read and, where a calculator or a lookup was enough, executed in Node. Anything that needs the live spreadsheet is marked as a suspicion.

Layout at 412px was inspected from the CSS (the stock table is `desk-only`; below 900px the phone gets the card list). It was not opened in a browser.

---

## High

### 1. “Sale waiting to sync” on a group sale opens a new Record sale

**Where:** `index.html:2861-2864` (the button), `index.html:2888-2896` and `index.html:2922` (`openSale`), `sheet/Api.gs:516-521` (the second write updates the Sales row).

**What goes wrong:** Sell refined… queues one `sellBatches` for the ticked batches. Each of those batches then shows **Sale waiting to sync**. That button always calls `openSale`. `openSale` only looks for a `recordBatchSale` (`pendingSaleFor`). A group sale is invisible to it, so the form is a fresh **Record sale**, prefilled with today’s base.

Submitting it queues a second sale for that one batch. The queue runs in order, so the group sale is recorded first. The later `recordBatchSale` hits the “already in Sales” branch and **updates that batch’s row**. One batch’s received amount changes. The pesos on the Sales tab no longer add up to the amount that was reviewed for the group.

**Confirmed:** Node replay of the lookup with a queued `sellBatches` for `R-20261118`: the card treats it as pending, `openSale` finds no `recordBatchSale` and would open a new Record sale. The update branch is `goldApiSyncBatchSales_` when `rows` is set (`sheet/Api.gs:516-518`). Not run against the live sheet.

**Smallest fix:** If `pendingGroupFor(id)` is set, the button should open that group review (`openBatchGroup`). `openSale` should refuse to enqueue `recordBatchSale` while a group sale already includes that batch.

### 2. After a timeout, “if you can see it in Stock” means the opposite for a direct sale

**Where:** `index.html:1215-1226` (`qCheckStock`), `index.html:1228-1236` (`qDel`), `index.html:1167` (any sent failure sets `uncertainAt`), `sheet/Api.gs:762` (a successful direct sale deletes the Purchases rows).

**What goes wrong:** The same dialog is used for every waiting item that might already have reached the sheet. It sends the user to Stock and says: if you can see it, drop the waiting item; if you cannot, delete it.

That test is right for a purchase. It is backwards for a direct sale. A sale that saved has **left** Stock (the rows are on Archive, the money is on Sales). A sale that never saved is **still** In stock. Following the dialog when the items are still in Stock drops the waiting sale. The gold stays in stock and there is no Sales row, while the phone has told the user the sale was already saved.

A group sale is just as blind on that screen: refined batches are not In stock either before or after the sale, so Stock cannot answer the question.

**Confirmed:** The dialog copy and both buttons were read. `sellStock` removes the chosen Purchases rows only after the Sales row is written. The live sheet was not timed out on purpose.

**Smallest fix:** For `sellStock`, `sellBatches`, and `recordBatchSale`, point the check at Sales (and Refining for a batch). Still In stock, or still status Refining, means the sale was not recorded — keep the waiting item and send it again with the same request id.

### 3. A failed Batch refine can take items out of stock and then refuse the retry

**Where:** `sheet/Api.gs:1068-1088` (item rows, register row, and Status → Refined are written before `archiveRows_`), `sheet/Api.gs:1019-1105` (no rollback around those steps), `sheet/Code.gs:893-902` (`archiveRows_` only undoes its own Archive writes, and only if it has not started deleting).

**What goes wrong:** Batch refine writes the Refining rows and sets the purchases to Refined, then moves them to Archive. If the Archive step throws (copy check, a full sheet, a formula error), the exception leaves the function. Those purchases are no longer In stock, so the phone stops listing them, but they are not safely on Archive either. The request has no receipt, because the receipt is stored only after a normal return (`sheet/Api.gs:207-214`). The retry says the items are no longer In stock and writes nothing. The items sit as Refined on Purchases with a half-built batch until someone fixes the sheet by hand.

`sellStock` rolls back on the same kind of failure (`sheet/Api.gs:768-779`). Batch refine does not.

**Confirmed:** The order of writes and the missing `try/catch` were read. Not executed inside Apps Script.

**Smallest fix:** Wrap the refine writes the way `sellStock` does. If Archive has not deleted any Purchases row, set Status back to In stock and clear the new Refining item rows and the new register row, then return the error.

---

## Medium

### 4. The service worker can store an old copy of the page as the new offline copy

**Where:** `sw.js:7` (install fetches with `cache: 'reload'`), `sw.js:14` (`keep` writes any OK same-origin response into the cache), `sw.js:23-31` (a navigation does `fetch(req)` with the request’s own cache mode, then `keep('./index.html', r)`).

**What goes wrong:** Install of `gold-tracker-v51` bypasses the browser HTTP cache so the new cache starts with the new page. The next visit does not. `fetch(req)` on a navigation still uses the HTTP cache. If that cache has the previous `index.html` (GitHub Pages and many static hosts send `Cache-Control: max-age=600`), `keep` writes that old page over the fresh copy. Offline, and any visit that hits the 6 second fallback, then opens the old app. A cache-name bump does not protect the page the phone actually runs.

Assets are safer: they are cache-first from the install, and a navigation is the only path that overwrites `index.html`.

**Confirmed:** The fetch and `keep` calls were read. Not installed in Chrome.

**Smallest fix:** Navigate with `fetch(req, { cache: 'reload' })` (or a new `Request` with that mode) so the response that `keep` stores is not the HTTP-cached page.

### 5. Save all drops the rows that did not fit, and clears the draft

**Where:** `index.html:1954-1965` (`saveAllGo`), `index.html:1023-1026` (`enqueue` removes the row again when persist fails).

**What goes wrong:** Save all enqueues each purchase. If the phone runs out of storage halfway, `enqueue` returns false and the loop stops. The rows that did get into the queue are kept. The rest are not put back into the batch draft. The draft is then set to an empty batch whenever at least one row was saved. Those unsaved weights and costs are gone. The storage alert points at the waiting list, which does not contain them.

A failure on the first row returns before the draft is cleared, so a “wrong sheet” binding error does not do this. The loss is the partial one.

**Confirmed:** Both functions were read in order. Not reproduced by filling a device.

**Smallest fix:** On a failed `enqueue`, leave the remaining rows in `BB`, tell the user how many were kept, and do not call the “saved, clear the draft” path.

### 6. A direct sale can be recorded at different figures than the review

**Where:** `index.html:2233-2236` (an edit is queued and does not change the stock on screen), `index.html:2466-2481` (the sale queues the item numbers and a snapshot), `index.html:1086` and `index.html:1134-1156` (the queue runs from the front), `sheet/Api.gs:727-748` (`sellStock` reads weight, purity, and cost from the sheet at sync time).

**What goes wrong:** The review shows the stock row as it is now. If an edit or a delete of that same item is already waiting, that edit runs first. The sale then uses whatever is on the sheet after the edit. The amount received and the profit can differ from the review the user just confirmed. A delete that runs first makes the sale fail with “no longer In stock”, after the review said it could be sold.

**Confirmed:** Queue order and the sheet’s re-read of the row were read. Not run against the sheet.

**Smallest fix:** When building a direct sale, if a waiting edit or delete covers one of the item numbers, block the sale until that waiting item is sent or deleted. The same guard belongs on Batch refine for those numbers.

### 7. One static token can read, change, undo, and download the whole business

**Where:** `sheet/Api.gs:125-142` (`doGet` takes `token` from the query, and `doPost` copies `token` from the query when the body has none), `sheet/Api.gs:232-239` (the check itself), `sheet/Api.gs:1695-1709` (`exportBackup` returns the spreadsheet as base64), `index.html:699` and `index.html:725-728` (the phone keeps the token in `localStorage` and sends it in the POST body).

**What goes wrong:** The web app is deployed as anyone-with-the-link, and every action is allowed once the token matches. That includes delete, undo of the newest batch, and a full `.xlsx` of the Sheet. The phone’s own requests put the token in the body, which is the right place. The script still accepts it on the URL. A GET, or an old client, leaves the token in Google’s request logs and in browser history. Anyone with that URL can change purchases and download the file. The token does not expire. `setupGoldApi` also shows it in an alert (`sheet/Api.gs:258-262`), which is how the phone is paired, so the secret lives in the Apps Script execution log as well.

The comparison itself is constant-time for equal lengths. The phone escapes text it puts into the page (`esc` at `index.html:541`).

**Confirmed:** The entry points and `exportBackup` were read. The deployment’s access setting is what the script’s own setup comment says (`sheet/Api.gs:89`). The live deployment was not requested.

**Smallest fix:** Ignore `e.parameter.token`. Keep accepting the token only from the POST body. The v51 phone already sends it that way. Treat the current token as exposed if any GET with `?token=` has ever been used, and rotate it with `goldApiNewToken()`.

### 8. A refresh during a refine can show a torn sheet

**Where:** `sheet/Api.gs:154-160` (reads do not take the document lock), `sheet/Api.gs:178-220` (writes hold it, then `getState` runs after the lock is released).

**What goes wrong:** `LockService` only makes other locked calls wait. `getState` never locks, so a refresh from this phone or the other phone can read the sheet in the middle of Batch refine: Status already Refined, Archive not moved yet, or the opposite. Stock and the dashboard are then wrong until the next full refresh. A sale or refine started from that picture is checked again on the server, so it usually fails closed. The screen is still wrong while the user is standing with a seller.

**Confirmed:** Read path versus write path. Not observed live.

**Smallest fix:** Take the same document lock for `getState` (a short wait). The write already builds state after it releases the lock, so two phones serialize on a consistent snapshot.

---

## Low

### 9. Phone and sheet round money and purity differently

**Where:** `index.html:543` (`round2`, half away from zero via the `e2` string), `sheet/Code.gs:1510` (`round2_` is `Math.round(x * 100) / 100`), `index.html:674-695` (the phone cuts purity to 0.01% before save), `sheet/Code.gs:312-319` (`toPurity_` keeps every decimal the sheet form was given).

**What goes wrong:** For a value such as `1.005`, the phone’s preview rounds to `1.01` and the sheet’s `Math.round(1.005 * 100) / 100` is `1` because `1.005 * 100` is `100.49999999999999` in IEEE math. Sale value and profit on the review can be ₱0.01 off the figure that is stored. Negative amounts differ as well (`-1.005` → phone `-1.01`, sheet `-1`).

Purity typed on the phone is cut first (`85.356` → `0.8535`). The sheet’s own Add purchase keeps `0.85356`. At a base of ₱8,250 and 7.5 g, that is about ₱3.71 of projected sell. The phone path is consistent with itself, because it sends the already-cut number. The gap is the sheet form versus the phone for the same keystrokes.

**Confirmed:** Both functions were executed in Node for `1.005`, `1.015`, `-1.005`, `-1.015`, and the purity examples above.

**Smallest fix:** Use one round (the phone’s half-away `e2` version) in `round2_` and in `toPurity_`.

### 10. An uncertain direct sale tells the user to look at Refining

**Where:** `index.html:2444`. A batch sale’s waiting row says the same thing at `index.html:2029`, which is the right tab for a batch and the wrong tab for a direct sale.

**What goes wrong:** A direct sale never creates a refining batch. The banner on an uncertain direct sale says to check Refining before deleting it. The sale, if it saved, is on Sales. This is the same trap as finding 2, with the wrong tab named in the banner.

**Confirmed:** The banner string and `goldApiSellStock_` (no Refining register row) were read.

**Smallest fix:** Say “Check Sales” for `sellStock`.

### 11. Stock on an open phone does not refresh on its own

**Where:** `index.html:3574-3596` (after 10 minutes away, only `getSettings` runs), `index.html:3603-3606` (the 60 second timer syncs the queue, or retries when `netDown` is set).

**What goes wrong:** Purchases added on the computer, or on the other phone, stay off this screen until the user hits refresh. The base price does update after 10 minutes, so quotes move and stock does not. Server checks still reject a sale of a row that is already gone.

**Confirmed:** The timer and `lightOrFullRefresh` were read.

**Smallest fix:** When the queue is empty, the 60 second timer can call `getState` if the last full sync is older than a few minutes.

### 12. The v51 script is not on `main`

**Where:** `main` at `66f5a22` has no `sheet/` directory. `sheet/Api.gs` and `sheet/Code.gs` are on `origin/cursor/direct-sale-998-9656` (`9739f0e`) only.

**What goes wrong:** A deploy or a review that uses `main` cannot see the script the phone is calling. The page and the script can drift, which is how the group-sale button and the refine rollback ended up different shapes.

**Confirmed:** `git ls-tree` on both commits, and identical hashes for `index.html` and `sw.js`.

**Smallest fix:** Put `sheet/Api.gs` and `sheet/Code.gs` on `main` next to the page they belong to. This audit does not do that.

---

## Suspicions

These are real shapes in the code. The trigger was not observed.

- **`sheet/Api.gs:1251-1258`.** After a group sale has already written Sales rows, a register-size check sits outside the rollback `try`. If it throws, the phone gets an error, no receipt is stored, and the retry then hears “already sold”. A normal write does not add a register row, so this may never fire. Move the check inside the `try`, or treat a matching Sales row as success.
- **`sheet/Code.gs:876-878`.** The Archive copy check uses `Number(a) !== Number(b)`. A binary float that Sheets returns slightly differently would throw, and that throw is one way into finding 3. Not reproduced.
- **`sheet/Api.gs:2019-2029`.** Monthly profit adds the 2026 compilation cells (Sales rows 4–9) and every Sales row from row 11. `goldApiMonthPack_` passes `null` for the dashboard (`sheet/Api.gs:2059`), so the dashboard cells never replace that sum. If those summary cells are themselves a sum of the sales table, 2026 profit on the phone is doubled. The comment says the compilation is a separate import. The live Sheet was not opened, so this stays a suspicion.
- **`sheet/Api.gs:1743-1755`.** Named-range positions are cached for 6 hours. The values are read live. A moved named range would be read from the old cell until the cache expires.

---

## Redundancy

Lines that can be removed with no behavior change, because nothing calls them:

| What | Where | Lines |
|---|---|---|
| `saveQ` | `index.html:1007` | 1 |
| `isV47Action` | `index.html:869` | 1 |
| `goldApiBatchSilver_` | `sheet/Api.gs:969-980` | 12 |
| `goldApiDashVals_` | `sheet/Api.gs:1939-1945` | 7 |

About **21 lines**. `getState` takes silver from the Refining register (column W), not from `goldApiBatchSilver_`. `goldApiDashVals_` has no caller. `goldApiDashMonthTable_` is called, always with `null`, so its body never reads the Dashboard. Deleting that function and the merge at `sheet/Api.gs:2042-2047` is another **~23 lines**, and it matches what v13 already claims to do.

Copies that are not safe to delete until one function is shared (the Api copies exist so a second `waitLock` does not drop the outer lock):

| Copy | Lines, about |
|---|---|
| `goldApiSyncBatchSales_` (`sheet/Api.gs:475-543`) and `syncBatchSales_` (`sheet/Code.gs:1334-1410`) | 70 |
| `goldApiAddPurchase_` (`sheet/Api.gs:412-438`) and `addPurchase` (`sheet/Code.gs:632-667`) | 25 |
| `goldApiAddSale_` (`sheet/Api.gs:457-471`) and `addSale` (`sheet/Code.gs:670-688`) | 15 |
| Silver and gram totals in `refineTotals` (`index.html:2347-2358`) and `rnTotals` (`index.html:2503-2512`), same formula as `goldApiSilverG_` | 10 |

About **120 lines** once each pair calls one implementation that knows whether the lock is already held. `addPurchase` on the menu still writes a cell at a time; the Api path batches `setValues` so it must not be a blind delete.

No unused CSS class turned up: every class token in the style block also appears in the markup or the script. `manifest.json` matches the icons the page links. The XRF file watcher is desktop-only (`index.html:1499`) and is unused on the phone; it is live on a computer, so it is not dead.

---

## Fix first

1. **Group-sale button** (`index.html:2863`). Open the group review, and do not enqueue a second `recordBatchSale` for a batch that is already in a group sale. This changes money that was already recorded.
2. **Uncertain-sale check** (`index.html:1215`). For a sale, “still In stock” means it was not saved. Stop sending the user to Stock with the purchase test.
3. **Batch refine rollback** (`sheet/Api.gs:1068`). If Archive fails before it deletes Purchases rows, put Status back to In stock and remove the new Refining rows.
4. **Service worker** (`sw.js:25`). Fetch the page with `cache: 'reload'` so the offline copy cannot be replaced by the HTTP cache.
5. **Save all** (`index.html:1954`). Keep the rows that failed to persist in the batch draft.
