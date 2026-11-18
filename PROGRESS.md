# Gold Tracker v51: direct sale of 99.8% stock, and refined batches stay listed until the sale is recorded

Staged only. Not merged. Not published. The live Google Sheet and Apps Script were not called. No tokens are in these files.

Live release this was built from: app v50 (`1d25db7`) + Api.gs v50 + Code.gs v11. The attached v50 archive was the backend baseline. The repo's older copies were not used.

## What Iyam asked

Items already at 99.8% can be sold directly, one at a time or as a chosen group, with no fake refining and no refining fee. A group of batches that have already been refined stays on the Refining screen while the sale is only selected, reviewed, or waiting to sync. Those batches leave that list only after the sale is actually recorded. An unrefined 99.8% purchase is never invented onto the Refining tab.

## Numbering

- App `APP_VERSION` 51, service worker cache `gold-tracker-v51`
- Api.gs v51 (`directSale: true`, actions `sellStock` and `sellBatches`)
- Code.gs v51 (it was v11). A later refine keeps Archive rows whose batch id starts with `DS-`, and a refining batch cannot use a `DS-` id

## Direct sale (unrefined 99.8% stock)

Eligibility is the stored purity fraction, at least 0.998, and not above 1. The same epsilon the sheet already uses for "already refined" applies (`value + 1e-9`). 99.9% and 100% are included. 0.997999 displays as 99.80% and is refused. A lower `FullBaseMinPurity` setting does not widen this gate.

The Stock screen shows **Sell** on each eligible row and **Sell 99.8%…** for a group. Nothing starts ticked. The review uses the same inputs as Record sale: sell date, sell base per gram, and an optional amount received. There is no buyer field in the current sale form, so none was added.

One Sales row is written for the group. Identity is `DS-` plus the item numbers (`DS-1.5`), which cannot be a refining batch id. Grams are the original purchased grams. Sale value is base × purity × grams (each item's own purity). Cost is the sum of the purchase costs. Profit is received minus that cost. No refining batch, no silver, no loss, and no refining fee. Sold amount on the purchase is left blank so monthly profit is counted once, from Sales. The rows move to Archive with their original weight, purity, cost, and Batch #. Leftover Batch #s are not renumbered, and the counter is not restarted even if this empties the stock.

The sheet checks every selected row before it writes. A missing, duplicate, stale, or below-99.8% row rejects the whole request, leaves no receipt, and rolls back if a later delete fails. The same request id replays from cache or from ApiLog. An older sheet (no `directSale`, version under 51) never receives `sellStock`. A queued sale is kept across reload, waits for unsynced purchases to get a No., and is held with a clear message if the sheet is still older.

## Refined batches

**Sell refined…** on the Refining screen lists batches that are not sold yet. Nothing starts ticked. Review uses the same date, base, and optional amount. A typed amount is split across the batches by refined grams. Each batch's cost already includes its own refining fee; the group sale does not add another one.

While the batches are only ticked, on the review, or waiting offline, they stay listed on the Refining screen. `sellBatches` does not delete the Refining register or its item rows. After the sale is recorded, their status is Sold and the app list no longer shows them (Recent sales still has the profit, with Correct). A direct sale of stock that never went through refining does not add a `DS-` row to that list or to the register.

One old backend cannot do the group write. The request is held until Api.gs v51 is deployed, and it is not sent.

## sha256

- `index.html` `e71a84dc7783ce015d8fc04b8ad86827ba041afe0fc799cecc390f42d428300a`
- `sw.js` `5dac20f34590b6367ff9cadaed9622289633a30bd9437d7293e559145a51f6f0`
- `manifest.json` `9657d82276058c5d71cd33048fdcb8ff0bdd3e25b05d33f8ccc68a7fa9d683b0` (unchanged)
- `sheet/Api.gs` `8b7b0a05fe26632ff04c18185af34d29b3d93c7242a9e9b6d2da767680f3f733`
- `sheet/Code.gs` `6886a06a86d452736dc80548426a520143473cfcef62a075310604078706d777`

## Tests

`test/run_all.sh`, mocked sheet and local Chromium only. Every suite exited 0.

| Suite | Result |
|---|---|
| api_test_receipts | 26/26 |
| api_test_undo | 43/43 |
| api_test_v13 | 26/26 runnable. 3 realizedMonths checks skipped: `fixtures/expected-dashboard.json` was not in the v50 archive |
| api_test_v15 | 18/18 |
| api_test_v50 | 61/61 |
| api_test_v51 | 87/87 new: direct sale, valuation, no fee, monthly profit, retry and cache eviction, validation with no write, rollback, stale group, refine afterwards, undo, v50 sheet rejects `sellStock`, refined-batch group stays on the register until recorded, direct sale does not create a refining batch |
| compare_logfail | 1/1 on the current scripts (log failure still succeeds and does not duplicate). The v14 half was skipped: `/workspace/gold-v48-work/sheet` was not in the archive |
| phase1_test | 24/24 |
| phase2_test | 22/22 |
| bugs_regress | 6/6 |
| layout_v49 | 20/20 |
| pick_e2e | 49/49 |
| layout_v50 | 47/47 |
| sell_e2e | 58/58 new: one item, group, offline reload, stale refusal, v50 gate, refined batches stay listed through the picker, review, queue and reload, and leave the list only after the recorded sale |
| layout_v51 | 59/59: 412×915 DPR 3.5 at 100% and 130%, plus 1366×768 |

Prior v50 total was 347. Four of those checks need files the archive did not include (3 dashboard fixture, 1 historical v14 script). The other 343 passed. New checks: 87 + 58 + 59 = 204. Combined passing lines: 547.

Phone screenshots (412×915, DPR 3.5) are under `test/shots/` and copied for handoff: stock sell at 100% and 130%, empty / one / all picker, review with a large peso amount, single item, no eligible rows, refining list, refined-batch picker and review. Laptop shots are there too.

## Deploy order (not done)

1. Paste `Code.gs` v51 and save. Old app v50 does not send `DS-` ids, and a refine with no direct-sale rows behaves as before.
2. Paste `Api.gs` v51. Deploy the existing web app as a new version. Keep the URL and access. Do this before the first direct sale, so the next refine keeps those Archive rows.
3. Publish app v51 (`index.html`, `sw.js`). If the app is published first, it shows the update note and does not send `sellStock` or `sellBatches`.

## Defaults worth knowing

- 99.9% and 100% can be sold directly. Only a real fraction below 0.998 cannot, even when the screen rounds it to 99.80%.
- There is still no buyer box. Date, base per gram, and optional amount received are the sale inputs.
- Selling every in-stock item does not restart Batch #. The next purchase continues the sequence.
- A typed amount on a refined-batch group is split by refined grams. The last batch takes the leftover cent.
