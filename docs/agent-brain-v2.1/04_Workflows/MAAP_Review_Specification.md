# MAAP Review — Functional Specification

## 1. Purpose and boundary
MAAP Review is a dedicated structured review capability connected to Atlas project and consultant evidence. It should turn reviews into traceable conversations, decisions and owned actions rather than disconnected notes.

**Critical unknown:** official MAAP expansion, purpose, rubric, rating model, cadence, mandatory participants, required fields, country variants and retention policy were not supplied. The workflow below is a configurable shell, not a claim about the official MAAP methodology. Do not invent a rating scale.

## 2. Trigger options (to be configured)
- Scheduled review cadence.
- Project milestone or assignment checkpoint.
- Consultant/manager request.
- Approved project-risk escalation.
Only approved triggers should create review tasks.

## 3. Review sections
1. **Review metadata:** consultant, project, review period, country, type, due date, reviewer, participants.
2. **Consultant perspective:** assignment experience, role clarity, workload, support, blockers and feedback.
3. **Project context:** scope, delivery status, quality, collaboration, customer feedback and risks.
4. **Contribution and achievements:** concrete responsibilities, deliverables and evidence-linked outcomes.
5. **Skills and development:** demonstrated capabilities, gaps, training and certification needs.
6. **Risks and support:** matters requiring manager attention, only within approved policy.
7. **Actions:** action, accountable owner, due date, priority, status, dependency and escalation path.
8. **Conclusion:** summary, manager comments, consultant acknowledgement, disagreement, next checkpoint and closure.

## 4. Conversation style
Atlas should introduce the review in a calm, transparent way:
“Thanks for making time. I'd like to look at how the assignment has been going, what has worked well and where you might need more support. This is a chance to capture your perspective as well as the project context. We can take it one topic at a time.”

Open prompts:
- “How has the assignment been going from your perspective?”
- “What has helped you do your best work?”
- “Where have you had to work around obstacles?”
- “What feedback have you received, and from whom?”
- “What would make the next period more successful?”
- “What support or development would be useful now?”

## 5. Workflow
Trigger → prepare permitted context → notify participants → collect input → manager/consultant discussion → resolve factual errors while preserving differing perspectives → authorized reviewer records official outcome using approved rubric → assign actions → acknowledgement → closure → next checkpoint.

## 6. Governance
- Acknowledgement means “seen”, not necessarily “agreed”.
- Preserve consultant and manager perspectives separately where they differ.
- Closed review changes require an amendment with author, reason and timestamp.
- No automated employment, compensation, promotion, performance or termination decisions.
- No emotion, personality, health or attrition inference from voice, language or sentiment.
- Restrict access to authorized roles and purposes.
- Confirm retention, access, correction and appeal policy with HR/legal/process owner.

## 7. Data model
MAAPReview: id, consultant_id, project_id, period_start/end, review_type, country, status, due_at, reviewer_ids, participant_ids, template_version, rubric_version, outcome_fields, summary_revision_id, opened_at, closed_at, next_review_at.
ReviewResponse: id, review_id, participant_id, section_id, response, source_type, visibility, revision.
ReviewAction: id, review_id, title, description, owner_id, due_at, priority, status, created_by, closed_at, evidence_refs.
ReviewAmendment: id, review_id, prior_revision, new_revision, author_id, reason, timestamp.

## 8. Acceptance tests
- A review cannot close if configured mandatory sections/actions are missing.
- User acknowledgement is distinct from agreement.
- Disagreement is retained and visible to permitted reviewers.
- Closed reviews cannot be overwritten.
- A review summary cannot be exported to Spotlight without independent permission.
- A MAAP outcome cannot automatically change DNA skill proficiency or employment status.
