# Decision: git metadata component check

Date: 2026-11-20
Owner: Atlas

## Casefold

A path component is git metadata when it matches `.git` ignoring case (`str.casefold`). Windows and macOS fold `.GIT` onto `.git`. The fence is Windows-first. `.gitignore`, `.gitattributes`, `.github/`, `something.git`, and `foo/.git.bak` stay allowed.

## Normalization (ASCII only)

Every call site uses one helper. There is no raw `.git` string compare outside that helper.

An ASCII component is normalized before the compare:

1. Strip a trailing `::$INDEX_ALLOCATION` suffix.
2. Casefold.
3. Strip trailing dots and spaces.

Refuse when the result is `.git`. A backslash spelling is split and then checked, so the report is `refused:` rather than `unlisted:`.

## Non-ASCII components (loop 3, fail closed)

Owner decision, 2026-11-20, Atlas. Any path component with a character above U+007F is refused in inspect, verify-package, write-manifest, and `--dev-git-index`. The message contains `refused: non-ASCII path component` and the command exits 1. The confusable fold table is removed. The real repository and package were scanned before this change and contain no non-ASCII names, so `check_handoff . --dev-git-index` stays exit 0.

## Short names

After casefold, refuse a component matching `^git~[0-9]+(\..*)?$`. That covers `GIT~1`, `GIT~1.DIR`, and `git~12.x`.

## Dev checkout

`--dev-git-index` also walks the disk. A nested `.git` under a gitignored directory (for example `vendor/demo/.git/HEAD` while `.gitignore` hides `vendor/`) is `refused:` and the command exits 1. Package mode refuses an empty nested `.git` directory. The checkout's own top-level git directory is not refused in dev mode.

## Still open

- SIGKILL does not run `atexit`, so the one `atlas-git-home-*` directory can remain.
