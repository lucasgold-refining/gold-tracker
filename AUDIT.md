# Lucas Gold Tracker — read-only audit

App v51 (`index.html`, `sw.js`, `manifest.json`), checked against the live sheet formulas in **Gold Tracker (Improved)**. Nothing in the app, the sheet, or the Apps Script deployment was changed.

`Api.gs` and `Code.gs` are not in this repository. They are also not a separate Drive file this account can open (the script is bound to the spreadsheet). Every claim below is either from the PWA source, from a sheet formula that was read, or from a Node simulation of that source. Where the script would have to be open to be sure, the finding says so.

The phone the owner uses is about 412px wide, which is under the app’s 900px desktop breakpoint. Findings that only show up on that width are called out.

## High

### 1. The phone quote is lower than the sheet’s Quick Quote on every buy

`index.html:1333-1340`. Sheet: Quick Quote buy-price formula (`Quick Quote!C6` = per gram, then `C6/BHYPerGram` for per BHY) and the batch-quote array formula in row 10. Settings rows for base `7566.66`, deduction `0.01`, full-base purity `0.998`, BHY per gram `2`.

The phone cuts the per-BHY price down to the next lower multiple of ₱5 (`floor5`). The sheet formula does not. The comment above `quoteFor` says the phone uses the same rules as the sheet. v26 documents the ₱5 cut, and the sheet was never given the same cut.

At the base price on the sheet while this was read:

| Purity | Sheet ₱/BHY | Phone ₱/BHY | Phone is lower by |
| --- | ---: | ---: | ---: |
| 75% | 2,799.66 | 2,795 | ₱4.66 |
| 85.35% | 3,191.24 | 3,190 | ₱1.24 |
| 99.8% and up | 3,783.33 | 3,780 | ₱3.33 |

A 7.5 BHY piece at 85.35% is ₱23,934.29 on the sheet and ₱23,925 on the phone (₱9.29). Tapping the quote to fill Cost stores the phone number. Quick Quote on the PC, and the batch-quote column, still show the higher number.

Confirmed by evaluating `floor5` / `quoteFor` in Node against the formula text. The live web app was not called.

Smallest fix: put the same ₱5 floor in both Quick Quote formulas, or stop flooring in `quoteFor` if the sheet figure is the price you want to pay. One of the two has to change. Leaving both as they are keeps two prices in daily use.

### 2. A refused Undo still deletes that batch’s estimate and locked fee on the phone

`index.html:3485-3496`.

`undoLastBatch` runs inside `try`. The `catch` returns only when the error is a network failure (`e.net`). A normal refusal (batch already sold, id mismatch, script says nothing was changed) falls through. The phone then calls `fcForget` and `beForget`, closes the dialog, redraws, and reads `j.message`. `j` was never assigned, so that last read throws.

The sheet batch is unchanged. On the phone, the typed base and actual refined weight for that batch are gone, and the Dashboard cost lock for it is gone. The next Dashboard open rebuilds the cost from the current refining-fee setting, which is the jump v36 was written to avoid.

Confirmed by tracing the control flow and running the same branch structure in Node: a business error sets `forgot = true` and then throws on `j.message`. Undo was not sent to the live script.

Smallest fix: `return` at the end of the `catch` for every error, and call `fcForget` / `beForget` only after `j.ok`.

### 3. “Save all” throws away rows that never made it into the queue

`index.html:1954-1964`.

`saveAllGo` enqueues rows one by one and stops at the first `enqueue` failure (storage full, or the outbox write failing its check). If at least one row was queued, it still clears the whole batch draft, including the rows that were not queued. The toast reports only the queued count (“Saved 3 purchases”). The other rows are not on the phone and not on the sheet.

Confirmed by walking the loop: five typed rows, enqueue fails on the fourth, the function clears `BB` and the last two rows are in neither list. Not run against the live sheet.

Smallest fix: remove only the rows that `enqueue` accepted. Leave the rest on the batch screen and say they were not saved.

### 4. A non-JSON answer is treated as “this never reached the sheet”

`index.html:731-732`, `index.html:1166-1170`, `index.html:1232-1238`.

`api` has already finished `fetch` before it parses JSON. A 200 (or any status other than 500, 408, or 429) whose body is not JSON throws a plain `Error` with no `e.net` flag. The queue catch treats that as a definite rejection: it stores the message, and it clears `uncertainAt`.

Deleting that waiting row then uses the copy for a row that is not uncertain: “It has not reached the sheet.” That is the path that drops the only copy of the request id. Typing the purchase again creates a new id. Whether the script would have kept the first id is inside `Api.gs` (the phone comments say 6 hours) and was not verified. The phone’s own label is wrong either way: the request did reach the server, because `fetch` returned.

Apps Script often answers with an HTML error page after it has already written the row. That case hits this path. Not reproduced against the live deployment.

Smallest fix: any failure after `fetch` resolves should set the same “may already be on the sheet” flag as a timeout. The delete dialog should keep the “Check Stock first” wording whenever that flag is set.

### 5. A second phone, or this phone after it has been in the background, keeps old stock under a new base price

`index.html:3574-3606` and `index.html:2397-2400`.

Coming back to the app after 10 minutes calls `getSettings` when the script version is 13 or newer. That updates the base price and settings only. Stock, batches, sales, and the week chart stay on the last full `getState`. The 60-second timer syncs the local queue, or retries a failed connection. It does not reload inventory.

Opening the PWA from scratch does a full refresh. Leaving it in memory, which Chrome on a Galaxy does, does not.

Consequences on a second phone that is already open:

- Dashboard “Total in stock” is missing purchases saved on the other phone, and it multiplies that old gram total by the new base.
- Sell 99.8% builds its list from `ST.stock` on the device (`directPool`), not from a fresh read. Batch refine is safer when online, because it calls `batchPreview` first.

`getSettings` was not called here. The branch is the code: version ≥ 13 returns after `getSettings` and never calls `getState`.

Smallest fix: on focus, run the same full `getState` the refresh button runs (queue first, then state). Keep `getSettings` only if you also merge stock.

## Medium

### 6. The service worker can replace the saved app with a stale page or a portal page

`sw.js:14`, `sw.js:23-31`, `sw.js:35`.

`keep` stores any same-origin response that is HTTP 200 and type `basic`. Install fetches with `cache: 'reload'`. The navigation handler’s `fetch` does not, so it obeys the browser HTTP cache. The comment on line 24 says a captive-portal page never overwrites the saved copy. The code does not look at the body.

The live GitHub Pages responses for `/gold-tracker/`, `index.html`, and `sw.js` send `cache-control: max-age=600` (HEAD request on 18 Nov 2026). For up to 10 minutes after a release, a navigation can receive the previous `index.html` and `keep` will write it over the copy install just stored. A portal that returns 200 HTML for this URL is stored the same way. Offline, that saved copy is what opens. The next good 200 of the real page replaces it again.

The service worker was not installed in a browser for this audit. `/gold-tracker/` itself returns 200, so `addAll` of `./` is not failing on a 404 today.

Smallest fix: `fetch` the page with `cache: 'reload'`, and store it only when the body contains a marker only the real app has (for example `APP_VERSION` or the root element id).

### 7. A failed outbox check can bring a synced purchase back and send it again

`index.html:919-937` and `index.html:976-989`.

`persistOutbox` snapshots the queue, writes it, then reads it back. If another write landed in between (a sync removing a finished purchase while a new one is being saved), the check throws. The `catch` writes that old snapshot into `localStorage` under `gold-tracker-queue` and reports success. On the next launch, `initOutbox` merges that localStorage list into IndexedDB. Merge keeps ids that are only in the old snapshot.

A purchase that already synced can show up again as waiting. Retry uses the same request id, so a script that still remembers the id should no-op. That memory is described in the phone comments (6 hours) and was not read in `Api.gs`. After that window, the retry is a second stock row. Two views of the same origin (the installed app and a Chrome tab) make the overlap normal. One tab only hits it if a save and a queue removal overlap on the check.

Confirmed by running the merge: IndexedDB `[B]` plus a stale fallback `[A, B]` comes back as `[B, A]`. The IndexedDB transaction timing was not executed in a browser.

Smallest fix: on a mismatch, write the in-memory queue again and do not copy the stale snapshot to `localStorage`. On launch, ignore a `localStorage` queue when IndexedDB already loaded.

### 8. An estimate that failed once is queued again on every launch

`index.html:993-1002`.

On startup, every batch that still has a pending base or actual weight in `gold-tracker-batchest` is pushed onto the queue unless a clean waiting estimate for that batch is already there. An estimate sitting in error or on hold does not count as clean, so each launch adds another `setBatchEstimate` for the same batch. Each one will try to write the Refining estimate cells.

Confirmed by reading the guard: it only skips `!x.error && !x.hold`. Not executed against IndexedDB.

Smallest fix: skip the push when any queue row for that batch id already has action `setBatchEstimate`, whatever its error or hold state.

### 9. On the phone, the Stock list has no total

`index.html:2173-2176` and `index.html:452-454`.

The total row (weight, cost, projected profit) is in the table with class `desk-only`. Below 900px that table is `display: none`. The phone list adds a total only while a filter is on (`sftot`). At 412px, In stock shows each item and no total. The Dashboard total is a different figure (it adds open batches and one refining fee).

Confirmed from the markup and the media query. Not opened in a phone browser.

Smallest fix: always render the `sftot` line under the phone list, using the same `T` the desktop total row uses.

### 10. Some failures are swallowed, so the screen stays old with no message

`index.html:3591-3593` and `index.html:1182`.

If `getSettings` fails for any reason other than “Unknown action”, `lightOrFullRefresh` returns. No toast, no full refresh. A bad token or a script error leaves the old base in place until the next manual refresh.

After a successful queue sync, a following `getState` failure is an empty `catch`. The toast still says the items synced. Sales and refining batches on screen stay as they were until a later full refresh. The queue row is already gone.

Confirmed by reading both catches. Not triggered against the live script.

Smallest fix: toast the `getSettings` error and fall through to `refresh`. If the follow-up `getState` fails, keep the toast and say the screen may be behind the sheet.

## Low

### 11. Filtering purity “1” matches 100%, not 1%

`index.html:2105-2112`.

`sfPur` treats any number from 0 up to 1 as a fraction, same idea as the quote box. `1`, `1.0`, and `1.00` become 100% and match only items at 100.00–100.99%. `85` still means 85.00–85.99%, which matches the hint. `99.8` matches 99.80–99.89%.

Confirmed in Node. A 1% bar is rare here; the surprise is typing `1` and seeing the 99.8% / 100% pieces.

Smallest fix: treat a value as a fraction only when it is strictly below 1, or when the text starts with `0.`.

### 12. “Add other sale” sends grams and base as typed text

`index.html:2939-2941`.

Cost and amount received go through `parseNum` (commas and ₱ stripped). Grams and base are the raw input. `8,250` in the base box is sent as the string `8,250`. A script that does `Number("8,250")` stores nothing or zero. Not checked in `Api.gs`.

Smallest fix: `parseNum` those two fields the same way as cost, and send `''` when the box is empty.

### 13. Direct-sale 99.8% is a second copy of the sheet’s full-base setting

`index.html:878-879` and `index.html:1325-1326`. Settings full-base purity is `0.998` today, so they match.

`isDirectEligible` uses a hardcoded `0.998`. Quote and refining use `settings.fullMin`, defaulting to `0.998` only when the setting is missing. If Full-base buy purity is edited on the sheet, Quote follows it and the Sell button does not.

Confirmed by reading both expressions and the Settings cell. The setting was not changed.

Smallest fix: use `fullMinOf(S())` inside `isDirectEligible`.

### 14. Service-worker install failures are ignored

`index.html:3613`.

`navigator.serviceWorker.register('sw.js').catch(() => {})` drops the error. If install fails, the phone has no offline copy and no signal. There is also no `controllerchange` reload, so an open PWA keeps running the previous page until the process is killed.

Confirmed by reading the register call. Register was not attempted here.

Smallest fix: on failure, set `netErr` or a toast once. On `controllerchange`, reload if there is no unsynced queue.

## Not confirmed

These were looked at and are not filed as bugs.

- Silver needed, refining fee once per batch, and projected sell (`base × purity × grams`) match the sheet. Refining `B15` is `(refined × refined/raw / silver divisor) × multiplier − refined` for purity below the full-base threshold. `rnTotals` (`index.html:2503-2512`) is the same expression. Purchases column I is `BasePrice × purity × BHY / BHYPerGram`, same as `qSell`.
- `round2` half-away-from-zero holds for the usual traps (`1.005` → `1.01`, `1.015` → `1.02`, `1.255` → `1.26`) in Node. The ₱5 floor’s own examples (`6983.47` → `6980`, `6985` → `6985`) hold. A value that is `6984.999999` exactly (six 9s) floors to `6980`; float noise at `6984.999999999` becomes `6985`.
- Week buckets are Sunday–Saturday in the Manila calendar. 18 Nov 2026 falls in 15–21 Nov. 1 Jan 2026 falls in 28 Dec–3 Jan. No timezone shift in the UTC-date construction.
- Stock totals intentionally add one refining fee onto “not refined yet”, matching Dashboard `B27`. Open batches then add their own fee. That is the written v36 rule, not a double charge of the same batch.
- The token is sent in the POST body, not the URL (`index.html:725-728`). The setup hash is removed with `replaceState` (`index.html:3563`). Whether `Api.gs` rejects a missing or wrong token was not verified. There is no token column on the ApiLog header. This audit did not call the web app.

## Redundancy

Dead code that can be removed without changing behavior, about **6 lines**:

| What | Where | Lines |
| --- | --- | --- |
| `MOBILE_MQ` is never read | `index.html:618` | 1 |
| `isV47Action` is never called | `index.html:869` | 1 |
| `estQ` is never called | `index.html:874` | 1 |
| `feeLine` is always false, and the template branch is empty | `index.html:2454`, `index.html:2461` | 2 |
| `loadQ` returns `Q` and does not load anything | `index.html:1006` (call sites `2023`, `2152`) | 1 |

`api`’s `isPost` argument is ignored (`index.html:718`). Every call already POSTs. Dropping the argument is a mechanical cleanup, not a behavior change.

Duplicated on purpose so the phone can work offline. Do not delete the phone copy. The drift is finding 1 and finding 13.

| Copy | Where | Notes |
| --- | --- | --- |
| Buy price | `quoteFor` and Quick Quote `C6` / batch array | Same inputs, phone then floors to ₱5 |
| Refine preview | `refineTotals` (`2347-2358`) and `rnTotals` (`2503-2512`) | Same silver, fee, and value math. About 10 lines become one helper |
| Full-base threshold | `DIRECT_MIN` and `settings.fullMin` | Finding 13 |
| Batch estimates | `gold-tracker-batchest` and a `setBatchEstimate` queue row | Finding 8 is this split |
| Queue storage | IndexedDB `gold-tracker-outbox` and legacy `localStorage` key `gold-tracker-queue` | Finding 7 is this split |

No CSS class in `index.html` is unused. The manifest shortcuts, icons, and service-worker asset list match files that exist. Server actions the phone calls (`getState`, `getSettings`, `ping`, `addPurchase`, `editPurchase`, `deletePurchase`, `batchPreview`, `batchRefine`, `batchItems`, `addToBatch`, `removeFromBatch`, `setBatchEstimate`, `recordBatchSale`, `sellStock`, `sellBatches`, `addSale`, `setBase`, `exportBackup`, `undoLastBatch`) cannot be marked unused without `Api.gs`.

## Fix first

1. Make Quick Quote and `quoteFor` use one price (finding 1). This is the number you say out loud on every buy.
2. Stop a failed Undo from clearing the phone’s estimate and fee lock (finding 2).
3. Keep unsent rows on the batch screen when Save all only queues some of them (finding 3).
4. Treat a non-JSON answer as “check the sheet before you delete this” (finding 4).
5. Full-refresh stock when the app comes back to the foreground, on every phone (finding 5).
