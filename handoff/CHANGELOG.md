# Handoff 12.1 changes

Application baseline remains v12.

- Added 00_START_HERE.md, CLAUDE.md and a self-contained Claude build prompt.
- Added current-state matrix, ordered build plan, environment/runbook, exact source/API map, acceptance matrix and session-resume log.
- Added offline doctor and received-manifest/clean-build checker, with 29 unit tests.
- Fixed Makefile test discovery to include all Python tests and all four browser scripts.
- Added per-integration dependency files so a hosted setup need not install Riva just to enable Entra or Hindsight.
- Expanded .gitignore to protect secrets, private vaults and local backups. This does not remove already tracked secrets in an external repository.
- Included explicitly fictional API payload examples; they are candidates, never approved customer references.
- Reran all 375 existing checks and 29 new ones. No live provider was called.
- Retained the exact supplied application runtime, compiled HTML and Mantu logo. Runtime gaps are documented rather than silently declared fixed.

The original manifest, report and README remain under provenance/. The current report is verification/RESULTS.json. The package manifest is regenerated for this handoff.

## Session 2026-09-26 (Claude Code)
- Added Cloudflare Tunnel + Access deployment templates and runbook under `deploy/cloudflare/`; gateway runtime unchanged.
- Added `doctor.py --profile cloudflare` (loopback bind, public HTTPS origin, Entra mode, cloudflared presence).
- Added `tests/test_cloudflare.py` (10 tests, no port binding) covering proxied Host/Origin/CSRF/cookie boundary.
