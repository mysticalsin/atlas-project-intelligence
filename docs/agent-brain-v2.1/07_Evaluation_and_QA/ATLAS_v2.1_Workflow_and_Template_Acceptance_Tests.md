# Atlas v2.1 — Workflow and Template Acceptance Tests

## Canonical workflow
1. A consultant/project identity is resolved before prefill.
2. Prefill returns only fields authorized for the current user and project.
3. MiChat supports voice and text.
4. Follow-up questions adapt to prior answers and ask one primary question per turn.
5. Project-level facts and individual contribution claims are separate records.
6. Evidence links support each metric and artifact.
7. Manager/project-owner review is required before evidence approval.
8. Rejection routes to clarify/correct/dispute and preserves previous revision.
9. Approval creates independent branch records for DNA, MeChat, IMP, MAAP, Project Review and Spotlight.
10. MAAP and Project Review have separate state, owner and completion status.
11. A failure in one branch does not mark all branches failed or roll back unrelated successful destinations.
12. Spotlight cannot publish without exact-revision authorization and required customer/confidentiality/legal/brand permissions.

## Success-story template
1. Field mapping covers all metadata and narrative fields in the supplied Spanish template.
2. At most three KPIs are rendered; unsupported KPIs are omitted.
3. KPI values preserve baseline, after-state, unit, period, method and source.
4. No numeric impact is invented.
5. Client quotation is verbatim and permission-checked; paraphrase is never wrapped in quotation marks.
6. Internal manager/consultant/date notes are stored separately.
7. Public/client DOCX export removes internal-notes heading and values.
8. Internal DOCX export retains restricted notes.
9. The template's 13-table layout is version-pinned; if table structure changes, generation fails safely and requests template adapter update.
10. Spanish template labels remain Spanish; output language is configurable by destination.

## Verified local test
The starter helper was run against the supplied template using an explicitly TEST_ONLY fixture:
- Public export: internal notes heading and test manager/consultant values absent.
- Internal export: internal notes retained.
- Public export reduced the supplied 13 tables to 11 by removing the two internal-only tables.
This verifies the helper's basic separation behaviour, not a production CMS integration.
