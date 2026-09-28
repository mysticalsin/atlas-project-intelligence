#!/usr/bin/env bash
# Double-click in Finder (or `open` it) to store ATLAS's Hindsight and TypeSafe keys in the Terminal app.
cd "$(dirname "$0")" && bash set-keys.sh
echo; read -r -p "Press Return to close this window. " _
