# Atlas Memory & Context Policy

## 1. Memory is not evidence
Memory helps Atlas maintain conversational continuity. It must never become the authoritative source for project facts, skills, review outcomes or publication permissions.

## 2. Memory tiers
- **Turn context:** immediate dialogue.
- **Session checkpoint:** active workflow state, answered questions, open gaps and transcript offsets.
- **User continuity:** limited preferences such as language, accessibility preference or current workflow, subject to policy and user controls.
- **Organizational evidence:** versioned claims, project records, artifacts and approvals.
- **Reference memory:** taxonomies, templates, process definitions and approved playbooks.
- **Derived graph:** links among entities, never a substitute for source records.

## 3. Hindsight / personal memory integration
If Hindsight is used as previously explored, scope it to the authenticated user and approved continuity purpose. It may help remember prior interview context or preferred interaction style, but cannot:
- grant access to another user's records;
- override current permissions;
- silently validate an old claim;
- change an approved record without a new review;
- store restricted private MAAP content as general conversational memory.

## 4. Retrieval order
1. Check authorization and purpose.
2. Load current workflow state.
3. Retrieve authoritative system-of-record values.
4. Retrieve approved evidence revisions.
5. Retrieve relevant reference guidance.
6. Retrieve permitted continuity memory only if it materially helps.
7. Label stale or conflicting information.

## 5. Freshness
Every source record should expose last-updated time, source system and version where possible. If freshness is unknown, show “freshness unknown”; do not imply current availability or project status.

## 6. Forget, correction and withdrawal
A correction to a fact creates a new evidence revision. A request to withdraw a permission triggers downstream impact review. Memory deletion follows the product's documented retention and user-control process; it does not automatically delete authoritative evidence where legal retention applies.
