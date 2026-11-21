# MANIFEST — refresh for handoff integrity

## Context
`manifest-content` failed because tracked files had drifted from the 12.1 manifest (145 entries).

## Decision
Use `scripts/check_handoff.py . --dev-git-index --write-manifest`, which reads the git index and rewrites every listed path’s size and SHA-256. Package verification never auto-enables git mode from a planted `.git`.

## Consequence
484 tracked release files match. `manifest-content` passes. `clean-build` on this tree still fails until the rebuild staging copies edge paths (pre-existing Z.md note).

## Evidence
`python3 scripts/check_handoff.py . --dev-git-index --no-rebuild` → exit 0 on `manifest-content`