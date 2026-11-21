# ATLAS — Claude build handoff 12.1

**Start with [00_START_HERE.md](00_START_HERE.md).** Paste [CLAUDE_BUILD_PROMPT.md](CLAUDE_BUILD_PROMPT.md) into Claude with this extracted folder as its workspace. [CLAUDE.md](CLAUDE.md) defines the product and implementation rules.

This handoff preserves the v12 runtime and UI. It adds an ordered build plan, current-status matrix, configuration reference, complete test entry points, offline diagnostics and packaging verification.

The setup below is the retained application README. The current handoff documents take precedence for setup/test entry points; no historical test count is a live-provider validation.

---

# ATLAS Project Intelligence / Mantu
## v12 · 26 September 2026

A voice-first interviewer that investigates the actual work, preserves uncertainty, and produces reviewable customer stories. The embedded orb reacts to output audio; the intelligence is in the interview policy, bounded follow-up planner, evidence record and review process—not in the animation.

## Open the HTML

Open **ATLAS_Project_Intelligence.html** in a full browser. It contains the interface, particle sculpture, silent previews and local authoring tools. No frontend install, CDN, font files or provider keys are included. **Story intelligence** opens the quality lab, Markdown wiki workflow, customer-match brief and Hindsight controls.

## Fresh clone

Stay in the repository root. A git clone's directory is `atlas-project-intelligence`. Do not `cd` into `ATLAS_Project_Intelligence`; that name is not this tree. A release zip is the folder you extracted. Use `python3`. A fresh Ubuntu image has no `python` command.

```sh
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements.txt -r requirements-test.txt
python3 build.py
python3 scripts/preview.py
```

Open `http://localhost:8000`. This serves the compiled HTML only, not source files, `.env` or a knowledge vault. It does not activate voice or other providers. Stop the preview with Ctrl-C.

## Enable a genuine conversational voice API

On the approved application server:

```sh
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
cp .env.example .env
# Edit server-side .env. Never put provider credentials into HTML.
bash scripts/start_gateway.sh
```

The example explicitly selects `ATLAS_VOICE_PROVIDER=openai`, `OPENAI_REALTIME_MODEL=gpt-realtime-2.1`, `OPENAI_REALTIME_VOICE=cedar` and `OPENAI_TRANSCRIBE_MODEL=gpt-transcribe`. Set the authorized `OPENAI_API_KEY`. Confirm model access, provider data policy and native audio quality in your account. This is genuine speech-to-speech with server-side tool handling, not browser read-aloud.

Open `http://localhost:8080` on the server, or use an authorized SSH tunnel from the Mac. Choose a project, Start conversation, inspect the provider/processing notice, and explicitly enable transcript capture for the quote-based quality ledger. The model leads the conversation. End always stops the microphone. Failures are visible; no alternate voice provider is selected behind your back.

To use NVIDIA instead, set `ATLAS_VOICE_PROVIDER=personaplex` and configure the dedicated private GPU worker and FFmpeg as described in `docs/NVIDIA_SETUP.md`. The hosted route supports live candidate tools. PersonaPlex retains its optional Riva post-session transcript path; its agent text must not be mistaken for consultant speech. The kit does not include a GPU, model weights, endpoints or credentials. One active interview per gateway/worker is an intentional pilot limit.

## Quality upgrades

The live hosted ledger records exact consultant ASR quotes with uncertainty/correction state. The next-question planner prioritizes concrete missing information and caps repeated clarification plans at two per field. Unknown and confidentiality are valid; assessment outcomes and qualitative lessons are not inflated into production benefits. A plan is not proof the model spoke it. ASR, field assignment and meaning require user review.

In the workbench, try **Vague example**, **No measurement** and **Assessment, not delivery**. Those are deterministic offline demonstrations. They never populate a real transcript or pretend an API is connected.

## Memory: your Hindsight fork

Inspected source: `https://github.com/mysticalsin/hindsight`, commit `a921929a0e0ea82fb49da1daa0ca3e152e41fcc1`.

```sh
# Review repository and dependencies before installation.
git clone --filter=blob:none https://github.com/mysticalsin/hindsight.git
git -C hindsight checkout a921929a0e0ea82fb49da1daa0ca3e152e41fcc1
```

Deploy that reviewed checkout according to its installation instructions. This kit does not silently install it or substitute a claimed deployment. Install `requirements-integrations.txt` only for enabled integrations, test the resolved SDK against your fork service, and record your deployment lock.

Configure `HINDSIGHT_URL`, `HINDSIGHT_API_KEY` and a stable random `HINDSIGHT_BANK_SECRET`. The server derives a private bank from authenticated tenant/object identity. The browser cannot choose another person's bank. Recall is bounded and untrusted; private continuity is not customer evidence. Prepare a minimal resume note, review it, then save explicitly. Read, correct/replace and forget the fixed ATLAS continuity document from the workbench. Other older preference documents, story files, logs and exported copies are outside that delete action.

For shared use, configure `ATLAS_AUTH=entra`, exact HTTPS origin/redirect URI and server-held Entra credentials. Assign `ATLAS.Interview` to users and independently assign `ATLAS.Review` and `ATLAS.Publish` where authorized. Follow `docs/NVIDIA_SETUP.md` for the existing identity/proxy deployment. Local profiles organize browser drafts but do not authenticate users. Entra login does not magically make all local project drafts a centrally governed database.

## Markdown wiki and optional Graphify

Set `ATLAS_WIKI_ROOT` to a private durable directory. Drafts are immutable Markdown revisions. The SQLite registry stores current version, content hash, access, review, expiry and withdrawal. Back up both together. The provided pilot uses one process.

Prepare the current project, edit all eight sections, inspect source excerpts, and explicitly save a restricted server candidate. Structural gaps block factual approval. Authors cannot self-approve. An independently authorized reviewer with record access decides facts; an authorized publication reviewer decides the exact external audience. Use `scripts/wiki_access.py --help` on the trusted operator server to manage grants. No arbitrary browser user ID grants access.

The native graph connects current eligible stories to explicit topics and versioned evidence. Export an authorized snapshot containing index, topic pages, Markdown stories, relationships and manifest. Graphify may consume that snapshot under your approved model/data policy; **Graphify itself is not run here**. Inferred graph edges do not become facts or permission. `docs/WIKI_SCHEMA.md` defines the maintenance rules. The server checks current eligibility rather than trusting an exported `approved` flag.

## Source-grounded story refinement

Optionally set `STORY_EDITOR_MODEL` to your approved structured-output model and use `OPENAI_API_KEY`. Leave it empty to keep this external operation unavailable. Save your current candidate, open **Refine the narrative**, describe the customer decision, and authorize the external call. The model must supply references per paragraph; the validator rejects missing sections, unknown/cross-section references and new numerical tokens. Original limitations are retained.

Review the suggestion before applying it to the editor. Applying does not save or approve; save separately as a new restricted revision. Current access, source hash and local unsaved edits are checked so a stale response cannot silently replace work. Citation existence is NOT truth or entailment; semantic, causality, anonymity and factual review remain required.

## JEV: customer-specific relevance, not a truth score

Configure `TYPESAFE_API_KEY` and `JEV_MODEL` (example candidate: `jev-1.13.0`). Enter the four-part customer brief and authorize external processing. Only currently eligible customer-anonymized stories are considered. An inspectable lexical shortlist reduces the initial set; JEV supplies four typed semantic scores. Code computes the source-date proxy. The 30/25/20/15/10 weights and review thresholds are proposed pilot assumptions, not calibrated commercial predictions.

A weak fit or unresolved confidence/date signal can produce **no strong match**. Results retain limitations and poor-fit conditions. Access/eligibility are rechecked before outbound calls and before results return. No score is invented when JEV is unavailable. Do not use these scores for consultant performance ratings.

## Build, tests and handoff

From the same repository root, after the fresh-clone install:

```sh
make test
make test-edge
make test-ui
```

`make test-ui` runs every `tests/*_browser.py`. Set `CHROMIUM_PATH` when Chromium is already installed. `make geo-ne-check` exits 2 until `ATLAS_NE_SRC` points at the pinned Natural Earth sources. Optional integrations install from the hash lock: `make install-integrations`.

The primary HTML and three compatibility aliases are identical builds. Python gateway and JavaScript source are readable without a frontend framework. `docs/PRD_v12.md` explains quality, voice, memory, wiki, editorial and JEV responsibilities. `docs/EVALUATION_v12.md` contains proposed live pilot scenarios. `tests/RESULTS.json` records actual local checks and their limitations.

## What is and is not delivered

Delivered: executable browser application, real provider adapters, bounded interview logic, private-memory adapter, actual Markdown vault with authority checks, optional grounded editor, actual TypeSafe decision adapter, authorized graph/export, tests and configuration. No synthetic fixture is shipped as a real voice service.

Not deployed or validated here: live OpenAI/NVIDIA inference, native microphone/turn-taking/voice quality, real Entra tenant login, live Hindsight, live JEV, actual Graphify extraction, multiuser production operations or brand-owner sign-off. Automated provider tests use explicit synthetic fixtures. Frontend validation in this environment uses Chromium `set_content` because direct local-file navigation is blocked.

The original supplied Mantu logo is preserved byte-for-byte; no font files are distributed. Store local drafts and backups only on a trusted device and use authorized material. Browser storage/backups are not encrypted. Do not expose local-auth mode, the GPU worker, secrets or the private knowledge directory publicly.

## Working in the cloud
See `docs/CLOUD_WORKFLOW.md`: private GitHub repository, tests on every push (GitHub Actions), manual deploy workflow, offline demo with `deploy/cloudflare-edge/dev/local-edge.mjs`.
