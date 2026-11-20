# Ask runner count

Date: 2026-11-20
Owner: Atlas
Rows: ATLAS-ASKRUNNER-COUNT-VALIDATION (Sentinel I-N1 on PR10)

## Decision

`tests/run_ask_browser_stamped.sh` refuses a count that is not a canonical decimal integer from 1 to 32. An omitted count means 8. The refusal exits 2 with:

```text
invalid count: '<value>' is not an integer from 1 to 32
```

The log file is not truncated. Python is not started.

A canonical integer is one token matching `^[1-9][0-9]*$` whose value is at most 32. Zero, negatives, leading zeros, signs, spaces, decimals, `NaN`, scientific notation, and every other string are refused. A digit string longer than two characters is refused before Bash arithmetic, because `10#` wraps a 19-digit integer into the accepted range.

## Why refuse, not clamp

This script repeats `tests/ask_browser.py` and stamps `HEAD` and `TREE` for evidence. The run it was built for uses 8. 32 is four times that and is the cap. Above 32 the previous `seq` loop starts a long Playwright series (`1e2` ran 100 times on `8b0972ec`).

Clamping would hide the typo. On that base, `0`, `-1`, `abc`, and `NaN` already exited 0 with an empty log, because `seq` either printed nothing or failed inside the `for` list and `set -e` did not stop the script. A clamp of those values to 1 or 8 would still exit 0. The operator would read a successful shorter run. Refusal is the visible error.

Exit 2 is the script's existing usage code (missing log path). A real `ask_browser.py` failure, including a mixed run, still exits 1 and still writes `exit=` into the log.

## Unchanged

Canonical `1` through `32`, and an omitted count, use the same loop, the same stamp lines, and the same per-run `exit=` line. Explicit `8` runs eight times.

## Evidence

`python3 -m pytest tests/test_ask_runner_count.py -q` fails on `a68a8ee7a8594fe250d8e1ecd1fe12715eb49d6b` (29 failed, 6 passed: the four valid boundaries, the mixed run, and the missing-log usage line). It passes on `3d8136861f25f72a13fee75e1c1bdfd59d5818f9` (35 passed).
