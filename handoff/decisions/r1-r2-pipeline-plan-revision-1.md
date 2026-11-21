# R1+R2 pipeline plan, revision 1

Loop 1 of 3. The plan freezes after this revision. No product code and no pipeline code.

Debate on `cad889f5ca558da902f93a407101bae60d558dc7`: CONSENSUS NOT YET. The report on the Atlas box is `/workspace/atlas-gate/PLAN-DEBATE-atlas-22-cad889f.md`. Its sha256 prefix is `9cab4ebb`. That file is not in this repository.

The plan file at that commit, `handoff/plans/r1-r2-pipeline-generated-artifacts.md`, had sha256 `e157d1897544ff6589d188709eb3fa615e27e650132ece131f1fd3f97bb0a02d`.

## What this revision changes

1. `MANIFEST.json` gains one row for the plan file. The path is not added to `manifest_excludes`. This decision file is also tracked, so it has its own row. A tracked path missing from the manifest fails `manifest-content`.

2. `publish_ok` is illegal unless the reducer sees a verified packet whose `tree` equals `git rev-parse 'HEAD^{tree}'`. The base fetch uses the advertised ref `refs/heads/<base branch>` and exits 28 when that commit is not on the branch. Deploy lookup is `wrangler deployments list` for worker `atlas`, matching the version message `atlas-tree=<tree>`.

3. While Actions cannot run, there is no `source: ci` packet, so publish stays refused. Run `44829213197` is the evidence: the job never started, `runner_id` 0, log 404, budget annotation. The local fallback writes `source: local-run` and does not relabel it. It does not rerun Actions, raise a timeout, or spend money.

4. P3 does not refuse a deploy because `ATLAS_HOME_URL` is set. The page hash is the gate. P3 can roll the live page back with `wrangler rollback` to the previous version id. P3 and P4 each revert on their own. Each rollback has its own test and TEST COMMAND. Reverting one does not revert the other.

5. The witness is the sha256 of canonical `packet.json`, stored in `SHA256SUMS` and in the deploy record field `packet_sha256`. `g_packet_witness` checks that digest, `csp_sha256`, and the page hash. The pin and `csp.generated.js` are not committed back.

6. Phase numbers are P1 through P6 everywhere. `MANIFEST.json` leaves git in P5. `handoff/BUILD_STATUS.md` leaves git in P6.

## Red at cad889f5

```sh
python3 -m pytest tests/test_handoff.py::test_repository_full_handoff_includes_clean_rebuild tests/test_handoff.py::test_git_archive_of_head_passes_check_handoff -q --tb=line
```

Both failed. `tests/test_handoff.py:722` and `:753`. Detail: `unlisted: handoff/plans/r1-r2-pipeline-generated-artifacts.md`. 2 failed.

## Green

The same command on the commit that contains this decision and the two manifest rows is the green check. That commit SHA is recorded in the gate packet and the PR body. It is not written here, because putting it in this file would change the bytes that commit contains.

## Freeze

No second revision in this loop. Questions 1, 3, 4, 5, 6, 7, 8, and 10 in the plan stay open. Questions 2 and 9 are closed above. Implementation still waits until #15–#21 have merged.
