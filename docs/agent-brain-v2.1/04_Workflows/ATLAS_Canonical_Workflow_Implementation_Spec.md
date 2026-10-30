# Atlas Canonical Workflow — Implementation Specification v2.1
The uploaded workflow diagram is the canonical user-approved flow. Preserve its sequence and branching.

## Required sequence
1. Identify consultant and project.
2. Prefill authorized context.
3. MiChat voice or text interview.
4. Adaptive follow-up and challenge.
5. Create project and individual contribution evidence.
6. Attach artifacts, metrics, sources and attribution.
7. Manager or project owner factual review.
8. If not accepted, clarify/correct/dispute and return to interview/evidence capture. If accepted, approve the evidence revision.
9. Fan out to independent branches:
   - Purpose-specific projections: DNA skills update, MeChat CV, IMP capability signal.
   - MAAP Review when due or triggered.
   - Project Review: alignment, quality and readiness.
   - Spotlight story candidate.
10. Spotlight candidate requires fact, customer, confidentiality and publication approvals.
11. If public release is not authorized: hold, revise or internal-only. If authorized: publish the approved Spotlight version.

## Branch semantics
- MAAP Review and Project Review are separate workflows.
- Project Review focuses on alignment, quality and readiness. Its detailed rubric, owners and cadence are to confirm.
- Destination projections have independent permissions and sync states.
- Spotlight is success-story publication, not generic publication of consultant data.
- A story candidate is not publishable until exact-revision approval and required permissions exist.
- Evidence corrections after approval create new revisions and may invalidate derivatives.

## Statuses
`identified`, `context_prefilled`, `interview_in_progress`, `evidence_draft`, `submitted_for_review`, `needs_clarification`, `disputed`, `evidence_approved`, `projection_pending`, `maap_pending`, `maap_in_progress`, `maap_closed`, `project_review_pending`, `project_review_in_progress`, `project_review_closed`, `spotlight_draft`, `spotlight_approval_pending`, `publication_held`, `published`, `sync_partial`, `sync_complete`.

## Triggers
- MAAP: scheduled, due or authorized manager/process initiation.
- Project Review: configured project milestone, governance cadence, risk trigger or authorized manual start.
- Spotlight: nominated based on evidence and story relevance; nomination does not publish.
- DNA/MeChat/IMP: only after evidence approval and destination-specific permission/validation.

## UI progress
Show separate status cards for Evidence, MAAP Review, Project Review, DNA, MeChat, IMP and Spotlight. Never show one generic “completed” status if a branch remains pending or failed.
