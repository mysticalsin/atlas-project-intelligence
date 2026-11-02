# Atlas Implementation Plan

## Phase 0 — Discovery and contracts
- Confirm MiChat/MeChat naming and system ownership.
- Confirm MAAP process owner, official template/rubric, roles, cadence and retention.
- Confirm Spotlight CMS, approval chain and customer permission requirements.
- Confirm stable IDs and DNA, IMP, opportunity and MeChat APIs.
- Define data classification, retention and purpose-specific permissions.
**Exit:** signed decision log and contract examples; no ambiguous system-of-record ownership.

## Phase 1 — Conversational foundation
- Implement Atlas persona, dialogue manager and session state.
- Implement MiChat voice/text capture with pause/resume and correction.
- Implement structured claim extraction and provenance.
- Implement summary review and submission.
**Exit:** consultant can complete a grounded interview and resume after interruption.

## Phase 2 — Evidence and reviewer workflow
- Project and contribution entities.
- Evidence ledger, revisions, source references and review queue.
- Manager approve/return/dispute workflow.
- Audit log and access controls.
**Exit:** no claim becomes validated without accountable reviewer.

## Phase 3 — MAAP Review
- Configure official MAAP template only after process-owner approval.
- Review scheduling/triggers, participants, responses, actions and amendments.
- Separate acknowledgement from agreement.
**Exit:** review lifecycle and action tracking validated with process owner.

## Phase 4 — DNA and MeChat
- DNA approved skill/profile proposal and version-aware write.
- MeChat CV generation from approved profile revision.
- Destination acknowledgements and reconciliation.
**Exit:** live round trip in test environment with conflict/retry tests.

## Phase 5 — IMP intelligence
- Integrate authoritative availability and opportunity requirements.
- Deterministic mandatory eligibility and explainable ranking.
- Freshness and missing-data indicators.
**Exit:** staffing owners validate shortlist rationale; no automated staffing decision.

## Phase 6 — Spotlight and JEV
- Draft story from approved evidence.
- Claim-level evidence and permission checks.
- Exact-revision approvals and CMS publishing.
- JEV relevance matching for bid/customer reuse.
**Exit:** end-to-end publication test with customer permission, revocation and derivative review.

## Phase 7 — Pilot and scale
Pilot one consultant, one completed project, one manager review, one opportunity and one Spotlight candidate. Expand across practices/countries only after local process, taxonomy, privacy and integration checks.

## Definition of done
- Source-controlled code and docs.
- Environment/configuration and secrets documented without embedding credentials.
- Unit, integration, security and conversation eval tests.
- Observability for agent state, jobs, approvals and failures.
- Rollback/recovery plan.
- Owner for each system integration.
- No production claim based solely on mock responses.
