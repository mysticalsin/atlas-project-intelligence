# ATLAS — start here
**Claude build handoff 12.1 · Application baseline v12 · 26 September 2026**

This folder contains the actual application source and its compiled HTML, not just a PRD. Continue from this implementation. Do not rebuild a generic intake chatbot or replace it with another visual mockup.

## Give this to Claude
Open the extracted `ATLAS_Project_Intelligence/` folder as Claude's working directory. Paste **[CLAUDE_BUILD_PROMPT.md](CLAUDE_BUILD_PROMPT.md)**. The repository instructions are **[CLAUDE.md](CLAUDE.md)**. No prior chat is required.

Claude needs a coding environment with file access and a terminal for execution. In a chat-only environment, it must distinguish edited files from commands it could not run; uploading a ZIP does not itself start any services.

## Read in this order
1. [CLAUDE.md](CLAUDE.md) — product invariants and working rules.
2. [handoff/CURRENT_STATUS.md](handoff/CURRENT_STATUS.md) — what exists, what was tested, and remaining blockers.
3. [handoff/BUILD_PLAN.md](handoff/BUILD_PLAN.md) — ordered work packages and completion evidence.
4. [handoff/CONFIGURATION.md](handoff/CONFIGURATION.md) — dependencies, exact environment names and launch modes.
5. [handoff/ACCEPTANCE.md](handoff/ACCEPTANCE.md) — local checks versus real-service acceptance.
6. [docs/PRD_v12.md](docs/PRD_v12.md) — deeper product behavior; consult as needed, not all at once.

For source entry points and API routes, use [handoff/CODE_MAP.md](handoff/CODE_MAP.md).

## Three different run modes
| Mode | Command / entry point | What it proves |
|---|---|---|
| Standalone interface | Open `ATLAS_Project_Intelligence.html` | Embedded orb, silent previews and local authoring. No hosted voice or cloud memory. |
| Safe local preview | `python3 scripts/preview.py` → `http://localhost:8000` | Only compiled HTML is served. Microphone is deliberately disabled by this preview server. |
| Application gateway | Configure an inspected `.env`, then `bash scripts/start_gateway.sh` → configured `ATLAS_ORIGIN` | Calls the explicitly chosen real voice service when credentials, endpoint, consent and permissions are valid. |

The gateway serves `ATLAS_Voice.html`, a byte-identical alias of the primary HTML. Edit `src/`, then run `python3 build.py`; do not hand-edit the compiled aliases.

## First actions
```sh
python3 scripts/doctor.py --profile preview
python3 build.py
```
Then install only the required local dependencies and run the complete tests described in `handoff/CONFIGURATION.md`.

## Release package
```sh
make verify-package PACKAGE=path/to/extracted-release
```
`PACKAGE` is an extracted release directory or a `.zip` / `.tar` archive. The command checks that package against the `MANIFEST.json` inside it (`python3 scripts/check_handoff.py path/to/extracted-release` is the same check). Issue a new reviewed manifest when cutting a release package.

## What is intentionally absent
No API keys, Entra tenant configuration, hosted services, model weights, GPU runtime, installed virtualenv, customer data or font binaries are included. Those are deployment dependencies, not missing application source. The chosen Hindsight fork is pinned in `docs/SOURCE_LOCK.json`; it is not silently replaced with a claimed deployment.

## Non-negotiable outcome
A consultant speaks naturally. ATLAS asks concrete, relevant follow-ups, preserves unknowns and corrections, captures individual contribution, then prepares a source-linked Markdown story for independent review and the appropriate customer. The orb articulates with **played speech**, not outward waves or fictional thinking states.

**Local tests are not proof of live provider quality or production readiness.** See [handoff/verification/RESULTS.json](handoff/verification/RESULTS.json). The inherited 375-check report remains separately labelled in `handoff/provenance/`.
