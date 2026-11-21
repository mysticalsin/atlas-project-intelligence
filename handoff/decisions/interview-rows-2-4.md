# Interview ledger and cascade run (rows 2, 3 and 4)

Ticket: ask row A22. Tony, relayed verbatim via Jarvis, t2062u: "do the full build of everything that I ask you, and then fully QA test it."

Base: `main` `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
APP-FIT: ADAPT for all three. The lifecycles are real. The written rows do not match the code: row 2 says the ledger decides the next question, and row 3 cites a continuation window the cascade does not have.

## What changed against the current code

- Row 2. `record` still classifies with the unknown regex, then the uncertain flag or regex, then `reported`. `detailTransition` allows that write once. `planProbe` still repeats a plan on the same turn. The while loop now calls `probeTransition`. It assigns the existing defer sentence only on the `defer` effect. `inspect` still picks `next_field`.
- Row 4. `quality.py` calls the Python twin. The status strings and the defer sentence are the same. The shared fixture is `the team shipped the change last spring`, `we don't know the baseline yet`, `about twelve minutes of delay`, and `uncertain: true`.
- Row 3. `cascade.run` steps `open`, `admit`, `ready`, `finish`, `discard`, `fail` and `release`. A busy slot stays a `ValueError` (`fail` from `opening`). `Discarded` is `discard`. Exception types, event payloads and the notes block stay. The continuation window stays absent.

## Not in this PR

Row 1 stays a plan. `session.js` is already changed by #32 and #35, so this run does not edit it and does not invent `hold` or `loudRun`.

## Overlap named, not stacked

#39 changes `ledger.js`. #2 changes `cascade.py`, `quality.py` and `ledger.js`. Neither is in the required check list (#25, #27, #35, #37, #44, #45, #47, and the s01 branches). This branch starts from `main`.

## Tests

`tests/test_field_status.py`, `tests/test_cascade_run.py`, `deploy/cloudflare-edge/test/field-status.test.js`. The existing quality, depth, cascade and parity suites stay green.
