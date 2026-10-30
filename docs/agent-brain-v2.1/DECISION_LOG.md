# Decision log: Agent Brain v2.1 upgrade

Plan author: Opus architect, 2026-10-30. Owner decisions: Tony, 2026-10-30 (binding, last section). The decisions below are the basis for tasks T0 to T17; a later task that needs to depart from one records the change here.

## Do-not-invent decisions (placeholders)

The pack names systems and a rubric the repository has no contract for. These stay placeholders until the owner supplies the real thing.

| ID | Decision | Consequence |
|---|---|---|
| D1 | MiChat is an internal document label for this interview. No UI rename. MeChat appears only as a mock adapter `MECHAT_CV`, shown as "not connected". | See Q4. |
| D2 | MAAP: the rubric is `MUST_BE_CONFIGURED_BY_PROCESS_OWNER`. Rating or closing a MAAP review returns `MAAP_NOT_CONFIGURED`. Only the shell is built. | No invented criteria. |
| D3 | Project Review: same treatment as D2. | |
| D4 | Spotlight is a `SPOTLIGHT_CMS` mock only and never sets `published`. | |
| D5 | Live DNA, MeChat and IMP APIs are `BLOCKED_EXTERNAL`. | No endpoints or credentials invented. |
| D6 | The interview-recap wishes (turnover, peer comparison, sentiment) are out of scope under the governance section. **Non-negotiable.** | The gate denies `rate_consultant` and `infer_sentiment`. |
| D7 | Add purposes `skills_profile` and `matching` (the latter `pending_owner_confirmation`) next to the pack's four. | |

## Design decisions

| ID | Decision |
|---|---|
| D8 | Two-level state machine. Interview states live in Session (welcome through user_correction to summary_confirmed). Post-submission states live in Library (submitted, reviewer_queue, then needs_clarification, approved, rejected or disputed, then downstream_proposals). Discovery states are a focus annotation: free order, audited. |
| D9 | Added states: `paused` (returns to the prior state), `suspended` (socket lost, 24 h), `withdrawn` (terminal, purges), `abandoned` (TTL). Skip is an event; the field records `skipped_by_user`. |
| D10 | `rejected` leads to `needs_clarification`, `disputed` or `closed_rejected` (with a reason). The prior revision is kept. |
| D11 | Withdrawal after approval moves the branches to `impact_review` and lists the derivatives. |
| D12 | A mock success is `mock_acknowledged`, labelled "not synced". `sync_complete` and `published` require `destination_ack.mock === false`. |
| D13 | Claim types gain `context` and `learning` (Atlas extension), with a field-to-claim mapping. |
| D14 | Machine configuration is JSON in `atlas_voice/config/` (no YAML parser, no new dependency), emitted into `policy.generated.js`, and tested against the pack YAML keys. |
| D15 | The v2 conversation is wired into the edge only. Python holds the policy and pure logic with parity tests. Other routes are unchanged. |
| D16 | The success-story renderer is Python stdlib (zipfile and XML) with a pinned template sha256 and a 13-table fingerprint, plus a JavaScript projection port with parity. |
| D17 | The Library `published` UI label becomes "Shared in internal library". The gate forbids mapping it to Spotlight. |
| D18 | Turn cues describe events in words (`describes_setback`), never the person. Text only, with an allowlist test. |
| D19 | A confirmed summary becomes an owner-only `evidence_draft`. "Submit for review" is an explicit click. (Q2) |

## Tony's decisions (2026-10-30), binding

| Topic | Decision |
|---|---|
| Scope | Full plan, T0 to T17. |
| Q1 Opening | **Full pack opening**, overriding the plan's default. The spoken greeting covers the purpose, what is captured, how it may be used, that any question can be skipped, answered "I don't know" or "can't share", and that a summary is read back for correction before anything goes to review. Warm and short for voice: about 60 words at most, split into at most two spoken pieces. Update the `tests/test_cascade.py:309-312` pin and the cached greetings in `languages.js`. English is authored carefully; other cached languages are translated faithfully and flagged "needs native review" in `IMPLEMENTATION_STATUS.md`. |
| Q2 Submission | Default: owner-only draft, then an explicit "Submit for review". |
| Q3 Checkpoint | Default: 24 h in the user's own Durable Object, gated by consent, discard purges, paused time excluded from the interview clock, 45-minute wall cap. |
| Q4 MiChat and MeChat | Default (D1). |
| Q5 Latency | Default: `SPECULATIVE_STT` and `ANALYST_WAIT_MS` stay off, endpointing and temperature unchanged, `max_tokens` 160. |

## Original questions and their default answers

| # | Question | Default |
|---|---|---|
| 1 | Opening | Keep the short greeting plus one sentence: "You can skip anything, and I'll read back a summary for you to correct at the end." Data use stays in the consent dialog. **Replaced by Tony's Q1 above.** |
| 2 | Submission | Confirm the summary, creating an owner-only draft; submission is an explicit click. |
| 3 | Pause and checkpoint | Paused time excluded from the 15-minute limit, 45-minute wall cap; checkpoints only with transcript consent, 24 h in the user's own Durable Object; discard purges. |
| 4 | MiChat and MeChat | MiChat is an internal label, no UI rename; MeChat is a mock CV adapter shown as "not connected". |
| 5 | Latency | `SPECULATIVE_STT` and `ANALYST_WAIT_MS` off; endpointing and temperature unchanged; `max_tokens` 160. |

## Rollout switches and rollback

Planned flags: `ATLAS_SELECTOR=v2|legacy`, `ATLAS_REPLY_GUARD`, `ATLAS_ACKS=content|legacy`, `ATLAS_CHECKPOINT`, `ATLAS_EVIDENCE_WORKFLOW`, `ATLAS_ADAPTERS=off|mock` (live is rejected). New storage is additive tables and every task is one commit. A live rollback is a Worker version rollback performed by Tony.
