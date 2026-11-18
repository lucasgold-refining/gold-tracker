#!/bin/bash
# Gold Tracker v55: every suite. Group 99.8% uses batch refine. Mocked sheet / local servers only, never the live API.
cd "$(dirname "$0")"; export TZ=Asia/Manila
rc=0
for t in api_test_receipts api_test_undo api_test_v13 api_test_v15 api_test_v50 api_test_v51 api_test_v54 sw_test_v54 compare_logfail phase1_test phase2_test bugs_regress layout_v49 pick_e2e layout_v50 sell_e2e undo_direct_e2e nofee_e2e layout_v51 app_v54 layout_v54 layout_v55 layout_v56; do
  out=$(timeout 600 node $t.js 2>&1); c=$?
  p=$(grep -c '^PASS' <<<"$out"); f=$(grep -c '^FAIL' <<<"$out"); e=$(grep -c 'PAGEERROR' <<<"$out")
  printf '%-18s exit=%s pass=%s fail=%s pageerrors=%s\n' "$t" "$c" "$p" "$f" "$e"
  [ $c -ne 0 ] || [ $f -ne 0 ] && { rc=1; grep -E '^FAIL|Error' <<<"$out" | head; }
done
exit $rc
