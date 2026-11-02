# ATLAS — Master Product Blueprint
## Project Intelligence Platform + Conversational Agent

### 1. Product vision
Atlas is the shared evidence, review and decision layer connecting consultant experience, project delivery, people development, staffing and commercial storytelling. Its interface is a conversational agent, not a form-first data-entry tool.

Atlas should feel like a warm, capable colleague who knows how to make people comfortable, asks intelligent questions, understands business context and is disciplined about evidence.

### 2. Product promise
**Capture once. Understand deeply. Validate with people. Reuse responsibly.**

A consultant should not reconstruct their experience for every CV, review, staffing discussion or success story. Atlas captures a structured account once, progressively improves it through evidence and human review, and produces separate approved outputs for each destination.

### 3. Capability map
1. **MiChat — Experience Capture:** conversational voice/text interview, adaptive probing, corrections, save/resume.
2. **Project Intelligence — Evidence:** project records, individual contribution, deliverables, outcomes, lessons, provenance.
3. **MAAP Review — People/Project Review:** preparation, discussion, structured outcomes, actions, acknowledgement and closure.
4. **Skills & DNA — Capability Records:** evidence-backed skill assertions, assessments, credential verification and approved DNA updates.
5. **MeChat — CV Generation:** accurate, tailored CV versions based on approved profile revisions.
6. **IMP Intelligence — Opportunity Matching:** explainable capability matching combined with authoritative availability and demand.
7. **Spotlight — Success Stories:** evidence-based stories, customer permissions, approvals, publishing and commercial reuse.
8. **Bid/JEV Intelligence — Reuse:** retrieve relevant, validated proof for proposals and client conversations. JEV relevance is not validation or publication approval.

### 4. System boundaries
Atlas does not replace DNA, MeChat, IMP, CRM/opportunity management, finance, HR systems or the corporate CMS. It owns evidence orchestration, workflow state, source lineage, assigned review records, approval history and purpose-specific projections.

| Capability | Atlas role | Authority |
|---|---|---|
| Identity | Map stable cross-system IDs | Workforce identity/DNA owner |
| Project facts | Capture and validate evidence | Project/account owner and source system |
| Skills | Propose evidence-backed assertions | DNA owns approved skills master |
| CV | Supply approved claims and revisions | MeChat owns rendered CV artefacts |
| Availability | Consume status and freshness | IMP/assignment source |
| Opportunity | Consume role demand and lifecycle | CRM/opportunity source |
| MAAP | Orchestrate configured review process | MAAP process owner |
| Success story | Draft and govern story revision | Spotlight/CMS publication owner |

### 5. Product principles
- Evidence before assertion.
- Human approval before material decisions and external release.
- Distinguish project facts, individual contribution, proficiency, credential validity, review outcome, staffing eligibility and publication permission.
- Missing information is unknown/unverified, not negative evidence.
- Corrections create revisions; do not silently overwrite.
- Internal, CV, bid/client-facing and public permissions are distinct.
- AI never fabricates facts, numbers, client names, credentials or approvals.
- Country-specific policy is configuration, not a hard-coded assumption.
- Preserve human relationships; automation removes admin, not manager conversations.

### 6. User journeys
**Consultant:** invitation → warm introduction → explain project → adaptive interview → review structured summary → correct/submit → see status → optionally use approved experience in CV/review.

**Manager:** review queue → evidence dossier → inspect source and attribution → request clarification or approve → initiate MAAP → assign actions → monitor completion.

**Project/delivery owner:** project evidence → validate scope/outcomes/risks → approve factual record → nominate Spotlight candidate.

**Staffing owner:** opportunity criteria → evidence-backed capability shortlist + IMP freshness → inspect rationale/gaps → make human decision.

**Communications/account owner:** candidate story → claim-by-claim validation → customer/brand/legal permission → approve exact public revision → Spotlight publish → track response.

### 7. Operating model
Atlas is not one giant autonomous agent. It is a conversational front door over governed domain workflows and specialist capabilities. The user experiences one coherent Atlas personality, while orchestration routes work to MiChat, Project Evidence, MAAP, Skills, MeChat, IMP and Spotlight.

### 8. Success measures
Interview completion/abandonment; evidence completeness; clarification rate; manager turnaround/correction rate; claim traceability; MAAP completion/action closure; DNA sync/profile freshness; CV preparation/factual correction; IMP shortlist usefulness; Spotlight approvals/publications/qualified inquiries; user trust and conversational usefulness. Safety target: zero unauthorized disclosures, unsupported published claims and erroneous writebacks.

### 9. Non-goals
No autonomous performance ratings or employment decisions. No publication without named approval. No sensitive-trait or attrition inference from voice tone. LLM confidence is not evidence. Atlas does not replace source-of-truth systems or make all captured content globally visible.
