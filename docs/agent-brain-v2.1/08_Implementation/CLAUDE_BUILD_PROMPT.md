# Claude Build Prompt — Atlas Agent Brain v2.0

You are implementing Atlas from this documentation package. Read `00_START_HERE/START_HERE.md` and every referenced specification before changing code.

## Mission
Build Atlas as a warm, conversational Project Intelligence agent with governed domain workflows. The product must not become a form-only interview bot or an unrestricted autonomous agent.

## Required first steps
1. Inspect the existing repository and report its actual structure, framework, current functionality, tests and deployment model.
2. Identify existing features to preserve. Do not overwrite or rebuild functioning modules without evidence.
3. Produce a gap analysis against this package, classifying each item as existing, partial, missing, blocked or requiring owner/API confirmation.
4. Create a decision log for unresolved contracts. Do not invent MAAP rubric, system APIs, permissions or product naming.
5. Propose an implementation plan with dependency order before major refactoring.

## Product requirements
- One coherent Atlas personality across workflows.
- Warm, welcoming, curious, professionally enthusiastic; natural reactions such as “wow, that's a meaningful result” only when context warrants it.
- One open-ended question per conversational turn; adaptive follow-up based on answer, context and evidence gaps.
- Voice and text; interruption/barge-in; pause/resume; uncertain ASR confirmation; summary correction.
- MiChat interview captures context, individual contribution, action, evidence, outcomes, skills and lessons.
- Evidence claims have provenance, attribution, status and immutable revisions.
- Human review required for material validation and all external publication.
- MAAP Review is a configurable dedicated module; do not invent official rating rules.
- DNA, MeChat, IMP and Spotlight adapters are contract-driven and feature-flagged until live APIs are confirmed.
- Spotlight means success stories; no generic publication shortcut.
- JEV is relevance matching only, not evidence validation or permission.
- Per-destination integration status, idempotency, retries, version checks and reconciliation.
- Strict role, project and purpose access controls.

## Agent architecture
Implement separate components for:
1. Persona/dialogue manager.
2. Intent/workflow router.
3. Context and permission builder.
4. Retrieval/memory layer.
5. Domain specialists (MiChat, Evidence, MAAP, Skills, CV, IMP, Spotlight, JEV).
6. Deterministic policy/approval gate.
7. Durable integration job orchestrator.
8. Audit and reconciliation.

LLM-generated proposals must not bypass deterministic authorization or state transitions.

## Quality requirements
- Tests for all state transitions and permission gates.
- Conversation evaluation against `07_Evaluation_and_QA/ATLAS_Evaluation_Framework.md`.
- No unsupported metric, credential, client claim or approval generation.
- No cross-user memory leakage.
- No automated employment decision or sentiment-based people inference.
- No false “synced” or “published” status without destination acknowledgement.
- Accessibility, localization and responsive UX.
- Document all configuration and API assumptions.

## Deliverables
- Working implementation in the existing project structure.
- Updated `AGENT.md` and architecture diagrams.
- Database migrations/schema.
- API contracts and adapter implementations or clearly labelled mocks.
- Conversation scripts and evaluation test fixtures.
- Unit/integration/security tests and results.
- Environment template with placeholders only; never commit secrets.
- Deployment/runbook and rollback instructions.
- Screenshots or recordings of the implemented user journeys.
- `IMPLEMENTATION_STATUS.md` with evidence-backed status for each requirement.

## Execution discipline
Work incrementally. Preserve existing user data and files. Do not claim production readiness without live round-trip evidence, security review and acceptance tests. If blocked by missing system access, complete independent work and document exact missing owner, API or permission.
