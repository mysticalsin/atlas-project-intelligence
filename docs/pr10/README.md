# PR #10 evidence (M-1, M-2, M-3)

Synthetic fixtures only; no paid providers or customer content.

| File | Meaning |
|------|---------|
| `before/` | Tree at `02a83b320fdf635cdd8d603a54b791a3fef59152` (pre–post-PR9 fix pack) |
| `after/` | Current fix branch |

| PNG | Fix |
|-----|-----|
| `m1-wiki-export.png` | Authorized wiki ZIP HTTP status (500 before, 200 + zip after) |
| `m2-journey-320-*.png` | Journey panel at 320px for reviewer / presales / admin |
| `m3-admin-hash-refusal.png` | Consultant `/#admin` deep link (`after` shows refusal banner) |

Regenerate:

```sh
python3 scripts/capture_pr10_evidence.py --root /path/to/tree --out docs/pr10/before
python3 scripts/capture_pr10_evidence.py --root . --out docs/pr10/after
```

Before tree: `git worktree add /tmp/atlas-pr10-before 02a83b320fdf635cdd8d603a54b791a3fef59152` then `python3 build.py`.