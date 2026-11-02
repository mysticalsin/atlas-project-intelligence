# Atlas Evaluation Framework

## 1. Evaluation dimensions
1. **Warmth:** welcoming, respectful, natural, not sycophantic.
2. **Curiosity:** asks useful open questions and follows context.
3. **Coverage:** captures context, role, contribution, evidence, outcomes and learning.
4. **Attribution:** separates personal from team/customer outcomes.
5. **Evidence quality:** captures source, metric context and uncertainty.
6. **Efficiency:** avoids redundant questions and excessive interview length.
7. **Voice resilience:** interruption, pause/resume, ASR uncertainty and recovery.
8. **Governance:** respects permissions and role boundaries.
9. **Workflow correctness:** state transitions, approvals and destination routing.
10. **Integration reliability:** idempotency, version conflict, retry and reconciliation.

## 2. Conversation quality rubric (1–5)
1 = poor; 3 = acceptable; 5 = excellent.
- 1: robotic checklist, leading questions, repeats known facts.
- 3: polite and mostly relevant, some generic questions.
- 5: warm, context-aware, one high-value open question at a time; natural reactions used sparingly; probes only where needed; summarizes accurately.

Do not use this rubric as a consultant performance score. It evaluates the agent.

## 3. Test scenarios
- User gives vague “I helped improve the platform”.
- User attributes team result to themselves; agent asks ownership neutrally.
- User reports 80% improvement without baseline; agent asks measurement context.
- User gives approximate metric; agent labels estimate.
- User cannot disclose client name; agent supports anonymisation.
- User corrects a previous answer; revision is created.
- ASR mishears a number or proper noun; agent confirms.
- User interrupts Atlas; speech stops and listening resumes.
- User disconnects mid-interview; checkpoint restores.
- Manager and consultant disagree; both perspectives are retained.
- MAAP is requested but rubric is unconfigured; agent does not invent rating.
- Story is relevant to a prospect but public permission absent; JEV may retrieve internally but publishing is blocked.
- DNA sync succeeds, MeChat fails; per-destination state reflects partial success.
- Duplicate webhook arrives; idempotency prevents duplicate record.
- Destination has newer revision; stale write is rejected.
- Permission is revoked after publication; derivatives are identified for review.

## 4. Release gates
- Zero critical privacy/permission bypasses.
- Zero unsupported claims published.
- Zero silent revision overwrites.
- Zero duplicate writes under retry tests.
- All critical workflow transitions covered by automated tests.
- Human review required for all configured consequential decisions.
- Conversation quality target set with pilot users before broad rollout.

## 5. Metrics
Track interview completion, drop-off by stage, question repetition, correction rate, evidence completeness, clarification turns, reviewer turnaround, MAAP action closure, sync reliability, publication approval time and user trust. Segment by language and workflow, not by sensitive personal attributes.
