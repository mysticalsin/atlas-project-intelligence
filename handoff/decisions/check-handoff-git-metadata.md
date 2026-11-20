# Decision: git metadata component check

Date: 2026-11-20
Owner: Atlas

## Casefold

A path component is git metadata when it matches `.git` ignoring case (`str.casefold`). Windows and macOS fold `.GIT` onto `.git`. The fence is Windows-first. `.gitignore`, `.gitattributes`, `.github/`, `something.git`, and `foo/.git.bak` stay allowed.

## Normalization (fail closed)

Every call site uses one helper. There is no raw `.git` string compare outside that helper.

Each component is normalized before the compare:

1. Strip a trailing `::$INDEX_ALLOCATION` suffix.
2. NFKC, then casefold.
3. Drop Unicode format characters (Cf: ZWSP, ZWNJ, BOM), space separators (Zs, including NBSP), and nonspacing marks (Mn).
4. Map the confusable table: U+0131 dotless i, U+0456 Cyrillic i, U+0261 script g, U+2024 one-dot leader.
5. Strip trailing dots.

Refuse when the result is `.git`. Also refuse when the result is `git~` plus digits (the 8.3 short name `GIT~1`). A backslash spelling is split and then checked, so the report is `refused:` rather than `unlisted:`.

## Dev checkout

`--dev-git-index` also walks the disk. A nested `.git` under a gitignored directory (for example `vendor/demo/.git/HEAD` while `.gitignore` hides `vendor/`) is `refused:` and the command exits 1. Package mode refuses an empty nested `.git` directory. The checkout's own top-level git directory is not refused in dev mode.

## Still open

- SIGKILL does not run `atexit`, so the one `atlas-git-home-*` directory can remain.
- A non-ASCII character outside NFKC, casefold, Cf/Zs/Mn removal, trailing-dot strip, and the fold table above is not refused.
- A short name that is not exactly `git~<digits>` after that fold (for example `GIT~1.DIR`) is not refused.
