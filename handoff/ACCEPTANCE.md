# Acceptance and evidence contract
A check passes only when its evidence exists. Keep **fixture**, **native browser**, and **real provider** results separate. The inherited reports do not authorize deployment or customer reuse.

## Local acceptance (repeat after changes)
| ID | Check | Evidence |
|---|---|---|
| L01 | Source builds four identical standalone HTML aliases; logo unchanged | Build log, SHA-256 hashes, byte comparison |
| L02 | All project/story/quality/protocol/editor/review tests pass | `node --test tests/*.test.js`, `pytest tests/test_*.py`, full logs including warnings |
| L03 | All four UI scripts run, no uncaught JS errors | Separate browser reports, screenshot evidence |
| L04 | Orb reacts to played output, settles in silence, distinguishes input, freezes on pause | Worklet tests + actual rendered pixel/state checks |
| L05 | Preview is labelled synthetic, silent, does not open mic or modify projects | UI assertions; do not count it as voice evidence |
| L06 | No secrets/vault/provider artifacts in source release | Manifest + secret/path review; automated checks alone are not a full secret audit |

## Native / provider acceptance (not executed for the received baseline)
| ID | Required demonstration | Pass condition |
|---|---|---|
| V01 | First real conversation | Approved provider actually speaks the opening question, hears an answer and asks a relevant follow-up. Log model/browser/test case, not raw keys. |
| V02 | Interruption | Interrupt a spoken response with a correction; playback stops, stale output clears, and the next turn uses the correction. Measure audible behavior, not only an event. |
| V03 | Resource lifecycle | Consent denied, mic missing, End during connect/live, network loss, tab lifecycle and expiry all release tracks/stream and show honest state. |
| V04 | Quality | Run the scenario set in `docs/EVALUATION_v12.md`; preserve unknowns, probe mechanism, separate individual work, reject inflated assessment/ROI. |
| V05 | Transcription | Distinguish consultant speech from agent text; correct proper names, quantities and cut-off utterances; user reviews before notes application. |
| I01 | Two real identities | A's draft/memory context never appears to B without proper story permission. Browser profile names do not count. |
| I02 | Authorization lifecycle | Deny wrong tenant/audience/missing role; test assignment removal, expiry, logout and stale session behavior. Record actual propagation limits. |
| M01 | Hindsight | Actual retain/recall/replace/read/delete against pinned-fork deployment; capture SDK/service versions and scoped deletion result. |
| M02 | Memory unavailable | Report failure honestly; no invented recollection or unauthorized retry/egress. |
| W01 | Durable candidate | Save an eight-section Markdown record, restart gateway and read it back with matching hash and status. |
| W02 | Independent review | Author self-approval denied; authorized non-author with record access approves exact revision; required customer permission separately resolved. |
| W03 | Invalidation | Edit, withdraw, expire, revoke, tamper and stale-save cases block incorrect reuse, graph inclusion and exports. |
| W04 | Recovery | Joint vault/registry backup and restore preserve revisions, hashes, grants and review expiry. No public static route exposes data. |
| E01 | Optional editor | Real structured response; references, limits and numeric checks pass; human checks meaning/causality; apply/save/review remain separate. |
| J01 | Real JEV | Typed response schema and confidence are validated; ineligible stories never leave; weak/poor-fit cases can return no strong match. |
| J02 | Ranking race | Withdraw/edit/revoke while a call is in flight; stale result is discarded. Evaluate customer fit against human judgement. |
| G01 | Optional Graphify | If enabled: inspect authorized snapshot, selected semantic provider and extracted/inferred edges; record actual execution. Otherwise label it unexecuted. |
| O01 | Pilot operations | Private HTTPS deployment, secret handling, redacted logs, one-process limit, bounded spend, persistent vault, stop/rollback/restore plan and owner approval. |

## Evaluate interview quality, not just completion
For each scenario record: relevant concrete details recovered; which fields remain unknown; redundant/leading questions; corrections accepted; contribution attribution; source/review burden; unsupported or confidential claims introduced; customer-fit usefulness; native interruption/latency observations. Compare a draft to the actual reviewed record, not to the model's self-assessment.

A release fails when an accepted story contains an invented material fact, a serious disclosure/isolation violation occurs, a revoked record is returned as eligible, or the model is falsely labelled connected. Numerical thresholds for conversational comfort and JEV calibration must be established with real target users, not invented after observing a convenient result.

## Required delivery report from Claude
Provide: application commit/hash; changed files and reason; exact install/run/test commands; tests run with fixture/native/provider scope; sanitized resolved dependency/model inventory; screenshots of actual HTML; unresolved issues ranked by impact; external values/actions still required; steps to stop and roll back. Keep blocked integrations explicit.

Do not omit failed/skipped checks or treat an SDK import, stored screenshot, nonempty environment variable, source-code adapter, configured status badge or passing mock as evidence of real service quality.
