# Data protection impact assessment (Art 35): draft for the DPO

Status: **DRAFT. Not an assessment that the processing is acceptable.** An engineer prepared this from the code, the GDPR privacy audit of 2026-10-31 and the controls built in v2.2 G2. The DPO decides whether a DPIA is mandatory, owns the likelihood and severity ratings, consults, and signs. Nothing here claims compliance: it lists which controls exist in code and which risks remain open. Every control below was tested offline on synthetic data; no live deployment, provider or real consultant has been involved.

## 1. Why a DPIA is likely required (DPO decides)

- **Systematic evaluation of employees' work product.** Quality scores of write-ups, a ready threshold, review decisions and per-story win rates are visible to managers and reviewers and could act as proxies for performance (Art 35(3)(a), Art 22 residual risk; Art 88 for employment).
- **Power imbalance.** The data subjects are employees invited to take part by their organisation. Consent is a weak basis for the core interview; this is why consent receipts are reserved for the optional extras and the lawful basis is left to the DPO.
- **New technology.** Speech recognition, large language models, an optional person-level memory service.
- **Special categories.** Free speech can disclose health, union membership, religion, politics, sexual orientation or ethnic origin.
- **Several processors and possible transfers**, one of them (Cloudflare) currently on a personal account.
- **Scale.** A pilot today; the intent is a company-wide reference library.

## 2. The processing

See `ROPA.md` (activities 1 to 12) and `PROCESSORS.md`. In one line: a consultant talks or types about a past project; ATLAS keeps a private draft that only they can see until they click Submit for review; after that a reviewer and the resolved N+1 check it, a review agent rates the write-up, and approved references can be reused internally. Optional and off unless chosen: a 24-hour saved interview, a short private memory.

## 3. Necessity and proportionality

| Question | Where it stands |
|---|---|
| Is the purpose specific? | Yes: reusable, defensible project references. Not performance management: the policy gate denies rating, ranking and comparing consultants for every role (`policy-gate.js`) and no sentiment or trait inference exists (decision D6, D18). |
| Is the data minimised? | The name never reaches a model; audio is never stored; memory keeps short structured facts only; notes keep a hash of notes text; kept-private items are removed; a special-category guard flags sentences. |
| Is it kept no longer than needed? | A retention schedule is executed daily (all periods are proposals): `RETENTION_SCHEDULE.md`. |
| Are people informed? | A privacy notice at `/privacy`, linked from the consent dialog, the profile and the footer (placeholders for the controller, DPO, bases and transfers remain). |
| Can people exercise their rights? | Download (`GET /api/me/export`), delete (`POST /api/me/erase`, two steps), restrict and object (`/api/me/privacy`), withdraw consent (recorded, never deleted). |
| Who are the processors, and where? | `PROCESSORS.md`: most cells are *to verify*. |

## 4. Risks, mitigations mapped to implemented controls, and what is left

Likelihood and severity are left for the DPO. "Control" names the code and the test that proves it offline.

| # | Risk to the person | Control implemented | Test | Residual / open |
|---|---|---|---|---|
| R1 | Their interview becomes visible to the N+1, reviewers, admins or colleagues, or is scored, before they decided | Interview saves are **private drafts** (owner-only) until the explicit Submit for review; excluded from lists, search, Ask, recommend, bids, analytics, exports, the duplicate index, rating and memory; confirmation requests refuse a draft | `g2-private-draft.test.js` | A reviewer can still read a record after submit (audited). Drafts older than 90 days are erased (proposal). |
| R2 | They cannot tell what they agreed to, or withdraw it; consent is bundled | Separate choices (transcribe and draft; saved interview; memory; notice), each with an append-only receipt (subject key, purpose, granted or withdrawn, notice version, SHA-256 of the exact wording, time, channel); withdrawal is recorded; the session checks each purpose | `g2-consent.test.js` | Receipts exist only for what the page records; a lawful-basis decision may make some of them acknowledgements rather than consent. The notice-acknowledged box is optional. |
| R3 | A person-level profile builds up in memory | Memory **off by default**, a separate tick, facts only (no conversation text), observations off, a narrower mission, sensitive lines excluded, no TypeSafe call on memory text, per-person prune | `memory.test.js`, `g2-special.test.js` | The memory service's own retention and location: *to verify*. Whether memory should exist for employees at all: DPO. |
| R4 | Sensitive information is spoken and spreads | The notice and the consent ask people not to share it; a phrase guard flags such a sentence at the read-back ("keep it private?") and keeps it out of memory; it records nothing about the person | `special.test.js`, `g2-special.test.js`, `test_privacy_config.py` | A phrase list is not understanding: it misses paraphrase and flags innocent text; sensitive text already in a kept draft or checkpoint stays until it expires or is kept private. Languages beyond en, fr, es, pt, de, it, nl are not covered. Needs native and DPO review. |
| R5 | No way to see or take their data | Export of library material, evidence with claims, receipts, invitations, outreach, staffing, profile, audit ids, saved interview and memory | `g2-rights.test.js`, `g2-worker.test.js` | The memory service's per-document read endpoint was not verified on a live account. Platform backups and provider logs are outside the file. |
| R6 | No way to have their data removed | Erasure replaces content with tombstones across the stores, removes the person from the audit trail (chain re-sealed), purges the saved interview and memory, deletes the profile; approved evidence, published references and bids are **flagged for the DPO** (legal hold) and withdrawn from processing | `g2-rights.test.js`, `g2-worker.test.js` | Platform recovery windows; DNA directory is out of scope; the DPO must work the hold list. Restriction does not yet stop downstream projections already queued for approved evidence. |
| R6b | Data kept for ever | Daily retention sweep from `retention.json` (drafts, withdrawn references, rejected evidence, requests, outreach, staffing, audit pseudonymisation, receipts) | `g2-retention.test.js` | Periods are proposals; security logs and memory are enforced elsewhere; the live cron has not run. |
| R7 | The quality score is read as a judgement of them (Art 22, performance proxy) | The score rates the write-up; the policy gate denies rating people; no solely automated decision; objection and restriction stop scoring, matching and memory for their references | `policy-gate.test.js`, `g2-rights.test.js` | Whether the N+1 sees scores and win rates at all is an owner decision (Art 88, works council). |
| R8 | Someone reads another person's record unseen | Reads of another person's record, a reviewer's bulk export and people lookups are audited (ids only); the email lookup moved to a POST body | `g2-rights.test.js`, `profile.test.js` | No alerting on unusual reads; no read audit for every route. |
| R9 | Data leaves to processors without cover | Registry of processors; optional processors off without a key; AI kill switch | `PROCESSORS.md` | Personal Cloudflare account (owner decision); contracts and transfers *to verify*. |
| R10 | A breach is not noticed | Numbers-only security events (export, erase, flags, consent changes, authentication and rate-limit failures), audit hash chain verified daily | `security-log.test.js`, `audit-chain.test.js` | No alert routing or SIEM; no breach runbook beyond `handoff/SECURITY_RUNBOOK.md`; DO NOT treat this as detection capability. |
| R11 | Voice is treated as biometric data | The code does no voice identification, no diarisation, no voiceprint; audio is never stored | code review | DPO to confirm. |

## 5. Consultation

- DPO: required. Name: [to be completed].
- Works council or employee representatives: see `WORKS_COUNCIL_PACK.md`; the countries and the obligations are for legal to assess (France and Germany at least).
- Data subjects: a pilot with a small group is the natural place to ask; not done.

## 6. Open items before real data

1. DPO decision: is a DPIA mandatory; lawful basis per activity; retention periods; legal-hold rules.
2. Move to a Mantu-owned Cloudflare account; processor contracts and transfers.
3. Complete the notice placeholders (controller, DPO, bases, transfers, contact, platform recovery window).
4. Decide whether the N+1 may see quality scores and per-story win rates.
5. Native review of the consent, notice and special-category wording (seven languages).
6. Works council consultation as legal requires.
7. Verify the provider facts listed as *to verify* in `PROCESSORS.md`.

## 7. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| DPO | [ ] | [ ] | [ ] |
| Business owner | [ ] | [ ] | [ ] |
| Legal | [ ] | [ ] | [ ] |
