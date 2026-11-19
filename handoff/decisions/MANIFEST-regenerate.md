# MANIFEST — refresh for handoff integrity

## Context
`manifest-content` failed because tracked files had drifted from the 12.1 manifest (145 entries).

## Decision
Use `scripts/check_handoff.py --write-manifest .`, which reads the git index and rewrites every listed path’s size and SHA-256. Skip runtime-only directories (`.git`, `__pycache__`, etc.) when walking packages.

## Consequence
484 tracked release files match. `manifest-content` passes. `clean-build` on this tree still fails until the rebuild staging copies edge paths (pre-existing Z.md note).

## Evidence
`python3 scripts/check_handoff.py . --no-rebuild` → exit 0 on `manifest-content`