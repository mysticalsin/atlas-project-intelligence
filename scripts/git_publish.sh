#!/usr/bin/env bash
# Commit this ATLAS working tree and push it to a PRIVATE GitHub repository.
#   bash scripts/git_publish.sh [repo-name] [commit message file]
# Refuses to commit when a likely secret or private runtime file is staged.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${1:-atlas-project-intelligence}"
MSG_FILE="${2:-}"
PATTERN='rpa_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer [A-Za-z0-9_-]{30,}'

[ -d .git ] || git init -q -b main
git config user.email >/dev/null || git config user.email "tony.walteur@gmail.com"
git config user.name >/dev/null || git config user.name "Tony Walteur"
git add -A
if git diff --cached --name-only | grep -E '(^|/)\.env$|\.(key|pem|p12)$|^\.claude/|^data/|\.playwright-mcp/|\.sqlite'; then
  echo "ABORT: a private/runtime file is staged (listed above). Fix .gitignore." >&2; git reset -q; exit 1
fi
if git diff --cached -z --name-only | xargs -0 grep -IlE "$PATTERN" 2>/dev/null; then
  echo "ABORT: possible secret in the files listed above." >&2; git reset -q; exit 1
fi
if ! git diff --cached --quiet; then
  if [ -n "$MSG_FILE" ]; then git commit -q -F "$MSG_FILE"; else git commit -q -m "ATLAS update $(date +%Y-%m-%d)"; fi
  echo "Committed $(git rev-parse --short HEAD)."
fi
gh auth status >/dev/null 2>&1 || { echo "GitHub login needed: run  gh auth login -h github.com -w  then rerun this script." >&2; exit 1; }
if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin main
else
  gh repo create "$REPO" --private --source . --remote origin --push
fi
gh repo view --json url,visibility -q '"\(.url) (\(.visibility))"'
