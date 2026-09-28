#!/usr/bin/env bash
# Double-click: sign in to GitHub if needed, then commit and push ATLAS to a PRIVATE repository.
cd "$(dirname "$0")"
gh auth status >/dev/null 2>&1 || gh auth login -h github.com -w -p https
bash scripts/git_publish.sh atlas-project-intelligence handoff/COMMIT_MSG.txt
echo; read -r -p "Press Return to close this window. " _
