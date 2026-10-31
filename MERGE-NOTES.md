# Merge notes: atlas/core-e2e into feature/agent-brain-v2.1

Base: the Mac main line at 4510bbb (v2.1 plus the v2.2 merges D1, F1, F2, G2, L1, X1, X2: red-team fixes, unslop UI, GDPR, connections panel, CSP).
On top: the 5 box commits from atlas/core-e2e (box base 54e934c), replayed with `git am -3`.

## From the Mac v2.2 side (kept as is)
- Every v2.2 change: red-team retest fixes (erasure, holds, kill switches, limits, live erase, message caps, multilingual guards), unslop UI, GDPR, connections panel, CSP report-only rollout.
- The `csp_browser.py` UI suite (added in v2.2, kept in test-ui).
- The X2 L13 ordering of the fenced prompt block (the label comes before the memory it names).

## From the box core-e2e side
- Setup automation: `build` copies ATLAS_Voice.html to the edge `atlas.html`; `test-edge`/`test-eval` depend on `build`; python-docx in requirements-test.txt; scripts/chromium_path.py picks a cached Chromium.
- Business Project ID: `projectId` accepted by projectContext (edge and Python), kept out of every model prompt (`forModel`), and used as the evidence draft's `project_ref`.
- Project Review hand-off: buildPayload PROJECT_REVIEW and `shellBranch`, once per approved revision; the shell still answers NOT_CONFIGURED.
- New `make test-e2e` and deploy/cloudflare-edge/test/e2e-core-flow.test.js (also run inside test-eval), plus the added unit tests.

## Overlaps and decisions
1. Makefile test-ui, patch 1 vs v2.2: patch 1 turned the explicit lines into a shell loop; v2.2 had explicit lines and had added csp_browser. Patch 4 (box) already reverted to explicit lines.
   Winner: explicit lines (v2.2 style, as in box patch 4) plus csp_browser, with CHROMIUM_PATH set by the target-specific `export` from patch 4.
   Why: one line per suite shows which suite failed, keeps v2.2's CSP suite, and merges cleanly when a later worktree adds a suite.
2. session.js talkerMessages, Project ID vs X2 red L13: both edited the same line.
   Winner: v2.2's ordering (label, then memory) with box's `forModel(project)`.
   Why: the X2 order is a red-team fix; box's change is only to drop the routing ID from the prompt. Box's line had the old order and would have reverted L13.
3. evidenceNotes, v2.2 added `lang`/`sensitive` fields; box changed `project_ref`. Auto-merged, both kept: they are independent fields.
4. Built artifacts (ATLAS_*.html, csp.generated.js): box's committed hashes were built from box's app.js; after the merge the inline script hash changed.
   Winner: rebuilt from the merged sources (make build), committed.
   Why: a stale hash would make the strict CSP block the page script.
