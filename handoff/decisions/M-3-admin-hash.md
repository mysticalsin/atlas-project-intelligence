# M-3 — `/#admin` deep link for non-admins

## Context
`openFromHash` handled library, invitation, bid and gap hashes but not `#admin`, so consultants opening a bookmark saw a blank admin shell.

## Decision
Treat `#admin` like choosing the Admin nav: `switchView('admin')` and let `renderAdmin()` paint the existing denied state.

## Consequence
No new copy. The verified-admin refusal banner is unchanged.

## Evidence
`tests/admin_metrics_browser.py` — consultant `#admin` deep link case