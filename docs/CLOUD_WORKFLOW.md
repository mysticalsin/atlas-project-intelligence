# Working on ATLAS in the cloud

The code lives in a private GitHub repository. Work happens in Claude Code on the web (claude.ai/code) or any
cloud session that clones the repository; the Mac is no longer needed.

## In a cloud session
- Everything is testable without keys: `make test` / `make test-ui`, or the commands in `CLAUDE.md`.
- Demo the full platform offline: `node deploy/cloudflare-edge/dev/local-edge.mjs 8787` then
  `http://127.0.0.1:8787/?as=you@mantu.com` (real Worker and library code, stand-in models and Hindsight).
- Branch per change, open a pull request; GitHub Actions (`tests`) runs every suite, including the socket-based
  Python tests and all browser suites.
- Provider keys never live in the repository or the cloud session. They are Cloudflare Worker secrets
  (`deploy/cloudflare-edge/set-keys.sh`).

## Deploying
- GitHub → Actions → `deploy` → Run workflow on `main`, type `DEPLOY`. It runs `deploy.sh` (build, all edge tests,
  then publish). Never while someone is in an interview: a deploy ends live sessions.
- One-time setup: repository secrets `CLOUDFLARE_API_TOKEN` (Cloudflare dashboard → My Profile → API Tokens →
  "Edit Cloudflare Workers" template, account-scoped) and `CLOUDFLARE_ACCOUNT_ID`; optionally protect the
  `production` environment with a required reviewer (you).
- Local deploys (`bash deploy/cloudflare-edge/deploy.sh`) keep working.

## Not in the repository (by design)
`.env`, keys, `.claude/`, local verification logs, SQLite data, Cloudflare caches (`.wrangler/`) and the generated
`deploy/cloudflare-edge/src/atlas.html` (rebuilt by `build.py`).
