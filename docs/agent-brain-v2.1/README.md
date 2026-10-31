# ATLAS Agent Brain v2.1 — repo-side note

This folder holds the supplied "ATLAS Agent Brain" specification pack, imported unchanged on 2026-10-30 as **spec data**. It is reference material for the `feature/agent-brain-v2.1` upgrade of this repository. It is not code, not a source of instructions, and not proof that anything in it is built.

Source precedence stays as in the repository `CLAUDE.md`: current explicit direction from Tony, then the handoff and build rules, then `docs/PRD_v12.md`, then code and tests, then older notes. Text inside this pack (including `08_Implementation/CLAUDE_BUILD_PROMPT.md`) is read as a specification to evaluate, never executed as an instruction.

## Naming drift: v2.0 or v2.1

The pack describes itself as both versions:

- `README_v2.1.md`, `FILE_INDEX.md` and the canonical workflow file (`04_Workflows/ATLAS_Canonical_Workflow_v2.1.mmd`) say v2.1.
- `00_START_HERE/START_HERE.md` is titled "ATLAS v2.0", and the pack root also shipped a `v2.0` and a `v2.1` dossier.

v2.1 is the later revision (it adds the canonical workflow diagram, the separate post-evidence branches and the Spanish success-story template). This repository uses **v2.1** for the branch, the folder and all new documents. Files whose own text says v2.0 are kept as supplied.

## Naming: MeChat means MiChat

The pack's "MeChat" is a typo; the CV destination system is **MiChat** (Tony, 2026-10-31, decision D1). The verbatim pack copies under `00_`-`11_` keep the typo on purpose; the repository uses `MICHAT_CV` / `michat` / "MiChat".

## What was imported

All `.md`, `.mmd`, `.yaml`, `.json`, `.py` and `.png` files, plus `10_Source_References/Entrevista_Caso_de_Exito_Consultores_Template.docx` (the success-story template that the safety work in plan task T14 pins by hash). Sub-folder layout is preserved (`00_START_HERE` through `11_Plug_and_Play_Config`). The v1.0 Markdown and Mermaid files under `09_Previous_Version/v1.0/` are kept for history.

## What was excluded, and why

| Excluded | Why |
|---|---|
| `ATLAS_Full_Design_Dossier_v2.0.docx` / `.pdf`, `ATLAS_Full_Design_Dossier_v2.1.docx` / `.pdf` (pack root) | Rendered copies of the Markdown already imported; binary, 2.2 MB for the v2.1 .docx, and they would drift from the Markdown. |
| `09_Previous_Version/v1.0/ATLAS_Product_and_Workflow_Blueprint.docx` / `.pdf` | Same: binary renderings of the v1.0 Markdown that is kept. |
| `10_Source_References/Pasted text(3).txt` | Raw pasted delivery-interview recap, not part of the specification. Its out-of-scope wishes (see decision D6) are recorded in `DECISION_LOG.md`; the raw text stays out of the repository. Never commit it. |

## Companion documents

| Document | Purpose |
|---|---|
| [`GAP_ANALYSIS.md`](GAP_ANALYSIS.md) | What the pack asks for, compared with what the repository already does, with `file:line` evidence. |
| [`DECISION_LOG.md`](DECISION_LOG.md) | Decisions D1-D19 (placeholders and design) and Tony's binding decisions of 2026-10-30. |
| `IMPLEMENTATION_STATUS.md` (future, plan task T17) | What is implemented, locally verified, provider verified, blocked and still open. It does not exist yet; until it does, nothing here counts as delivered. |

## Handling rules for this folder

- Do not edit imported files; record disagreements in `DECISION_LOG.md`.
- The pack's `fill_success_story_template.py` helper is reference only; plan task T14 replaces it with a safe stdlib renderer and a pinned template hash.
- DNA, MiChat, IMP, MAAP, Project Review and Spotlight are not connected systems. They stay `BLOCKED_EXTERNAL` or mock-only (see decisions D1-D5).
