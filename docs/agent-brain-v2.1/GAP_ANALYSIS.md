# Gap analysis: Agent Brain v2.1 pack against the repository

Date: 2026-10-30. Baseline: `main` at `efb4948`. Evidence is `file:line` in the repository at that commit; line numbers drift as the upgrade lands, so re-check before relying on one.

Status key: **E** existing, **P** partial, **M** missing, **B** blocked on an external system, **O** open owner decision. Combined codes (for example P/O) apply to both.

## Verified constraints that shape every task

| # | Constraint | Evidence |
|---|---|---|
| 1 | Python is the policy source of truth; `build_edge.py` imports `atlas_voice.cascade`, which needs aiohttp, so generation runs in the venv. | `deploy/cloudflare-edge/build_edge.py` |
| 2 | `tests/test_edge.py` asserts `policy.generated.js` is current and regenerates the parity vectors. Any `quality.py` ledger change must update `ledger.js`, `test/gen_parity.py` and `parity.vectors.json` in the same commit. | `tests/test_edge.py` |
| 3 | Commit c08e7ef ("short introduction, no review talk") is pinned by a test and conflicts with the pack's opening (resolved by Tony, see Q1 in `DECISION_LOG.md`). | `tests/test_cascade.py:309-312` |
| 4 | The consultant's name never reaches a model. | `atlas_voice/interview.py:26`, `session.js:86-87` |
| 5 | Library `published` means "visible in the internal library". It is never a Spotlight publication. | `library.js:96-98` |
| 6 | Library validation is not bound to a revision hash. | `library.js:545-555` |
| 7 | Never commit `Claude outputs/` or the pack's `Pasted text(3).txt`. | repository rules |
| 8 | `MANIFEST.json` is stale; `check_handoff.py` is not part of `make test`. | `handoff/` |

## Capability matrix

### Conversation behaviour

| Area | Status | Evidence | Note |
|---|---|---|---|
| Single persona and praise calibration | P | three separate prompts: `interview.py:8-12`, `cascade.py:33-67`, `quality.py:29-40`; "Oh wow, that's amazing" at `cascade.py:38-39` | Persona is duplicated and the praise line over-rewards. |
| One question per turn | P | prompt-only rule `cascade.py:37`; compound canned questions `quality.py:18-20`; streamed text is voiced unfiltered `session.js:656-667` | No enforcement after the model answers. |
| Acknowledge, explore, clarify, connect, confirm turn pattern | M | none | |
| Opening | P/O | `languages.js:36-44`, `cascade.py:77-84` (c08e7ef) | Owner chose the full pack opening. |
| Question selection | P | `inspect()` `quality.py:118-166`, dict order at `:145`; cap `:168-181` | No ladder; no redundancy check against prefill. |
| Stale guidance | E (bug) | `session.js:494` against `:512` | The two code paths disagree on which guidance the talker uses, so it can lag a turn. |
| Content-aware acknowledgements | M | `pickFiller` `session.js:551-556` | Fillers are content-blind. |
| Latency | P | reply gap 3.4 to 5.5 s; cache and prewarm `session.js:37-45`, `:567`; `max_tokens` 300, temperature 0.7 at `app.js:354` | |
| ASR uncertainty | M | `app.js:332-335` drops word data (`languages.js:18` already reads `alt.words`) | |
| Barge-in | E | `session.js:206-210`, `:425-431`; echo guard `speech.js:80-84` | |
| Pause, resume, repeat | M | `voice-client.js:168` is mute only | |
| Checkpoint and reconnect | M | `worker.js:57-58`, `session.js:783` | |
| Summary read-back and correction | P | improvised in `cascade.py:64`; supersede logic `quality.py:89-101`; no UI path | |
| Conversation state machine and audit | M | none | |
| Repetition guard | M | filler-only `session.js:553` | |
| Rushed, skip, "I don't know" | P | `UNKNOWN` regex `quality.py:26` | |
| Text interview (workflow W3) | M | `engine.js:4-11` has fixed topics only | |
| Output language per destination | M | none | |

### Memory, evidence and review

| Area | Status | Evidence | Note |
|---|---|---|---|
| Memory policy | E | `app.js:200`, `memory.js:18-21`, `session.js:342-349` | Private memory is not evidence. |
| Claim model | P | ledger `quality.py:94-96`; `claims.js:30`; `library.js:107` | Ledger and library claims are not linked. |
| Review flow with exact revision | P | only validate and request-changes exist | Not bound to a hash. |
| Audit with version and reason | P | `library.js:108` stores ids only | |
| Job envelope and idempotency | P | ledger call-id only | |
| Eval harness | P | `session.test.js` has 102 structural tests | No conversation-quality scenarios. |

### Governance and workflow

| Area | Status | Evidence | Note |
|---|---|---|---|
| Policy gate | P | checks are scattered across routes | Needs one deterministic default-deny gate. |
| Four purpose permissions | M | none | |
| Entity statuses and seven branch cards | M | none | |
| Internal notes never exported | M | none | |
| No sentiment or people inference | E (implicit) | nothing infers it today | Needs a test and a gate entry. |
| No false "published" or "synced" | P | library label is ambiguous | |
| Success-story template safety | M | `docx.js` uses a different sheet; the pack helper is unsafe | |

### External systems

| Area | Status | Evidence | Note |
|---|---|---|---|
| DNA, MeChat, IMP, Spotlight live integration | B/O | export contract only | No endpoints or credentials exist. |
| MAAP review, Project Review | M/O | none | No rubric has been supplied; it must be configured by the process owner. |
| JEV relevance-only matching | E | `jev.js`, `rating.js` | Ranks stories for a customer brief, never consultants. |
