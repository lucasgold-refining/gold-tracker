# Gold Tracker v54: audit remediation

Staged only. Not merged. Not published. The live Google Sheet and Apps Script were not called. No tokens are in these files.

The UI baseline is the approved v53 layout page (v51 box sizes, slimmer desktop sidebar, full-width content, light-gold colors). That CSS and markup are unchanged. `origin/main` was still the v52 theme when this branch was made; this branch does not push `main`.

Scripts started from the deployed v51 `Api.gs` and `Code.gs` (same bytes as `origin/cursor/direct-sale-998-9656` at `9739f0e`). Both changed, so both are v54.

## Numbering

- App `APP_VERSION` 54
- Service worker cache `gold-tracker-v54`
- `sheet/Api.gs` version 54 (`directSale` and `pickRefine` still true; a v51 sheet still counts as able to sell)
- `sheet/Code.gs` v54
- `manifest.json` unchanged

## What was verified and changed

1. **Group sale “Sale waiting to sync”.** Confirmed. The button called `openSale`, which only looks for `recordBatchSale`, so it opened a fresh Record sale. That second sale could update one batch’s Sales row after the group sale. The button now opens the queued group review. `openSale` will not enqueue another `recordBatchSale` for a batch already in a group sale. If one is already queued, sync holds it instead of sending it.

2. **Uncertain direct sale pointed at Stock backwards.** Confirmed. A saved direct sale has left Stock; a sale that never saved is still In stock. Purchases still use Check Stock. A direct sale says Check Sales: still In stock means send the same request again. A batch or group sale says Check Sales and Refining: still status Refining means send the same request again. The waiting-row text matches.

3. **Batch refine wrote rows before Archive and did not roll back.** Confirmed. If Archive throws before it deletes any Purchases row, the new Refining item rows and register row are cleared and Status goes back to In stock. The same request id can then succeed. If Archive has already started deleting, the earlier partial-delete behavior is unchanged.

4. **Service worker could store an HTTP-cached page.** Confirmed. A navigation now fetches the page URL with `cache: 'reload'`. Chrome throws if a navigation Request is rebuilt with a new cache mode, so the fetch uses the URL rather than a copied Request. Install still uses `cache: 'reload'`.

5. **Save all dropped rows that did not fit.** Confirmed. If the queue cannot be stored after some rows were saved, those rows stay queued and the rest stay in the batch draft. The draft is cleared only when every row was stored. A failure on the first row still leaves the whole draft.

6. **A waiting edit or delete could change a direct sale.** Confirmed. The sheet re-reads weight, purity, and cost at sync time, and the queue runs the edit first. Direct sale and Batch refine now refuse to start while a waiting edit or delete covers one of those item numbers. Send or delete that waiting item first.

7. **Token on the URL, and a full-spreadsheet backup.** Confirmed. The phone already sends the token in the POST body. The script no longer reads `token` from the query string, so a GET or a logged URL cannot authorise. Download backup still works as a POST with the body token (the Settings button). The existing token is not rotated. `setupGoldApi` still shows the setup text, which is how the phone is paired, and says not to put the token on the web app URL. If a `?token=` URL was ever used, run `goldApiNewToken()` once and paste the new setup text. That is manual.

8. **Rounding.** Confirmed for money. `round2_` now uses the phone’s half-away-from-zero rounding (`1.005` → `1.01`, `-1.005` → `-1.01`). A percent typed as `85.356` is cut to `0.8535`, matching the phone. A fraction that is already between 0 and 1 is not rounded: rounding `0.997999` to 4 places would make it `0.998` and sell gold that is below 99.8%. The phone already cuts a fraction before it sends. Stored rows are not rewritten.

9. **Unused code and duplicated writers.** Confirmed unused: `saveQ`, `isV47Action`, `goldApiBatchSilver_`, `goldApiDashVals_`. Removed. `addPurchase`, `addSale`, and batch-sale sync now have one body. The menu still takes its own lock. A menu purchase is still written one cell at a time. The API passes the batched writer and does not take a second lock.

A group sale that is already on Sales returns success and does not write a second row, so a retry after a late error does not get stuck on “already sold”. A normal group sale’s message is unchanged. If the Refining register size differs after a successful sale, the sale is still returned as saved instead of throwing away the receipt.

## Kept on purpose

- **Refresh during a refine can read a torn sheet** (`getState` does not take the document lock). Real in the code. Not changed. Locking every refresh would make the phones wait on each other, and a sale or refine started from that picture is checked again before it writes.
- **Stock does not refresh itself every minute.** Real. Not changed. The 60 second timer still syncs the queue. A sale of a row that is already gone is still refused.
- **2026 monthly profit might double if the compilation cells are themselves a sum of the sales table.** Not opened on the live sheet. Not changed.
- **Named-range positions cached for 6 hours.** Values are read live. A moved name would be stale until the cache expires. Not observed. Not changed.
- **Archive copy check uses `Number(a) !== Number(b)`.** Not reproduced. A throw before any Purchases delete is now rolled back by the refine fix.
- **Menu Batch refine** (the spreadsheet menu, not the phone) still has no rollback. The phone uses `batchRefine`.
- **`goldApiDashMonthTable_`** is still called. It was not in the unused list. The dashboard is still passed `null`, so that table is not read.
- **Phone copies of the silver and gram totals** stay. They are the on-screen estimate, not a second writer. Fee stays inside cost and is not shown on its own. A refined batch is still one item at its refined grams. A direct sale is still base × purity × grams, with no refining fee.

## sha256

- `index.html` `6d29fdc2ae183d94c7afe2c64a66a0367e150b003f48b5be440486b33c06fa81`
- `sw.js` `c48a025ef5681c1babac9c2ced34271ef34639be639d01173963cbabe48739eb`
- `manifest.json` `2d5a7e2fc729cf9feb3831732d2577193c0304d1c5c142882e2a92b47778270a` (unchanged)
- `sheet/Api.gs` `65cbea3166e5f6bd4b9f85727e44ceff8f92ddddfdad2ba195b6ddeee4bc61be`
- `sheet/Code.gs` `dfea0b065844ca0de4435f1cb26738ca885ee421c692cd303161e95cedd84446`

## Tests

`test/run_all.sh`, simulated sheet and local Chromium only. Every suite exited 0. The original v51 direct-sale and group-sale suites are still here (`api_test_v51.js`, `sell_e2e.js`, `layout_v51.js`). Their version checks now expect script version 54. State reads in those suites use POST, because a token on the URL is refused. The behavior checks are the same.

| Suite | Result |
|---|---|
| api_test_receipts | 26/26 |
| api_test_undo | 43/43 |
| api_test_v13 | 27/27. GET `?token=` is refused. POST getState passes. Dashboard fixture still skipped |
| api_test_v15 | 18/18 |
| api_test_v50 | 61/61 |
| api_test_v51 | 87/87 direct sale and refined-batch group |
| api_test_v54 | 28/28 rounding, token, backup, refine rollback, repeated group sale |
| sw_test_v54 | 5/5 navigation stores the reloaded page, not the HTTP cache |
| compare_logfail | 1/1. The v14 half is still skipped: that old script was not in the archive |
| phase1_test | 24/24 |
| phase2_test | 22/22 |
| bugs_regress | 6/6 |
| layout_v49 | 20/20 |
| pick_e2e | 49/49 |
| layout_v50 | 47/47 |
| sell_e2e | 58/58 |
| layout_v51 | 59/59 |
| app_v54 | 16/16 group-sale button, sale check, save-all quota, queued edit, queued delete, reload |
| layout_v54 | 5/5 at 412×915 DPR 3.5, 100% and 130%, plus 1366×768 |

602 passing lines. No page errors.

Phone screenshots are `test/shots/v54-group-review-100.png`, `v54-group-review-130.png`, `v54-sale-check-130.png`, and `v54-group-review-desktop.png`.

## Deploy order (not done)

Do this after the v53 layout page is the one on the site. Do not publish this branch over it from here.

1. Paste `Code.gs` v54 and save. The menu purchase, menu sale, and menu batch-sale sync still behave as before. A percent with extra decimals is cut. Money rounding changes on new writes only.
2. Paste `Api.gs` v54. Deploy the existing web app as a new version. Keep the URL and who has access. Do this before the v54 page, so a refine that fails can roll back and so a token on a URL stops working.
3. Publish app v54 (`index.html`, `sw.js`). `manifest.json` is unchanged. Until this page is published, the v53 page does not have the queue fixes. Until the scripts are deployed, the v54 page still talks to v51 scripts for sales and refine; the new page will not send a second sale for a batch that is already in a group sale.

The existing token keeps working in the POST body. Phones that are already paired do not need a new token unless you choose to run `goldApiNewToken()`.
