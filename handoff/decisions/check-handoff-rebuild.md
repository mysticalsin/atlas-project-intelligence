# check_handoff — full clean rebuild on a dev tree

## Context
Release verification must rebuild HTML from a source-only copy (`build.py` + `src/`, `assets/`, `docs/`) and byte-match the four shipped aliases. The dev checkout also had gitignored build artifacts and paths `build.py` imports (`atlas_voice/`, `deploy/cloudflare-edge/`).

## Decision
- **Unlisted files:** Only with explicit `--dev-git-index`, enumerate `git ls-files` (same as manifest write). Received packages use filesystem walk and refuse `.git/*`.
- **Clean rebuild copy:** Include manifest-listed files under `atlas_voice/` and `deploy/cloudflare-edge/` in the temp directory, via `include_in_clean_rebuild()`.
- **Regression:** `tests/test_handoff.py::test_repository_full_handoff_includes_clean_rebuild` runs `inspect(..., rebuild=True)` on the repo.

## Consequence
`python3 scripts/check_handoff.py . --dev-git-index` passes on a normal git checkout (including rebuild). Extracted packages use the full directory walk only.

## Evidence
`python3 scripts/check_handoff.py . --dev-git-index` → `PASS clean-build` and `PASS clean-build-byte-match`.