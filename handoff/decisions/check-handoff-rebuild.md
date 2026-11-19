# check_handoff — full clean rebuild on a dev tree

## Context
Release verification must rebuild HTML from a source-only copy (`build.py` + `src/`, `assets/`, `docs/`) and byte-match the four shipped aliases. The dev checkout also had gitignored build artifacts and paths `build.py` imports (`atlas_voice/`, `deploy/cloudflare-edge/`).

## Decision
- **Unlisted files:** When `.git` is present, enumerate `git ls-files` (same as manifest write), not every filesystem walk entry.
- **Clean rebuild copy:** Include manifest-listed files under `atlas_voice/` and `deploy/cloudflare-edge/` in the temp directory, via `include_in_clean_rebuild()`.
- **Regression:** `tests/test_handoff.py::test_repository_full_handoff_includes_clean_rebuild` runs `inspect(..., rebuild=True)` on the repo.

## Consequence
`python3 scripts/check_handoff.py .` passes on a normal git checkout (including rebuild). Extracted packages without `.git` still use the full directory walk.

## Evidence
`python3 scripts/check_handoff.py .` → `PASS clean-build` and `PASS clean-build-byte-match`.