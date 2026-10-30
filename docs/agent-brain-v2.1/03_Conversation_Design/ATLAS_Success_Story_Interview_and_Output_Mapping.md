# Atlas MiChat → Success Story Template Mapping
## Source: Entrevista Caso de Exito Consultores_Template.docx (3 pages)

Atlas populates the supplied Amaris Consulting template from interview answers and validated project evidence. Preserve its sections and the page-3 internal-notes boundary.

## Field mapping

| Template field | Atlas source | Follow-up / validation | Required |
|---|---|---|---|
| Client | Project/account record | Confirm display name or anonymised label; public naming needs permission | Internal required; public permission separate |
| Industry | Account/project context | Confirm sector taxonomy | Preferred |
| Year | Project dates | Validate year | Required |
| Duration | Start/end dates | Ask if absent; never infer | Preferred |
| Number of consultants | Project participation | Confirm team size/time window | Preferred |
| Main role | Consultant participation | Confirm exact role | Required |
| Country | Project record | Confirm delivery country | Required |
| Main technologies | Evidence/interview | Ask where/how each was used | Preferred |
| Project summary (2–3 lines) | Approved challenge + solution + key outcome | Check no overclaim | Required |
| Three key numbers | Validated outcome claims | Baseline, after, unit, period, method, source, attribution | Up to 3; omit unsupported |
| Client problem | Interview context | 1–2 lines on pain/limitation | Required |
| Why important | Risk, cost, growth, competition, regulation | Ask consequence of not solving | Preferred |
| What we did (2–4 lines) | Approved contribution/deliverables | Separate consultant and team contribution | Required |
| Technologies | Skill/tool evidence | Normalize taxonomy; preserve product names | Preferred |
| How we worked with client | Delivery model/collaboration | Agile, embedded, nearshore only if confirmed | Preferred |
| Results table | Outcome claims | Before/after for time, cost, errors/rework, other | At least one meaningful result; qualitative allowed |
| New capability enabled | Outcome/capability claim | Ask what client can now do that it could not before | Preferred |
| Amaris differentiator | Evidence-backed approach and strengths | Ask why Amaris role mattered | Required for story quality |
| Why selected / role mattered | Account/project source + interview | Expertise, speed, ownership, network only if evidenced | Preferred |
| What client valued | Client feedback | Identify speaker/source | Preferred |
| Client quote | Exact quote + speaker/title/company approval | Never fabricate or put paraphrase in quotation marks | Optional |
| Internal manager | Authenticated manager/profile | Confirm if absent | Internal only |
| Internal consultant | Authenticated consultant | Confirm if absent | Internal only |
| Internal date | Workflow timestamp | Use locale policy | Required |

## Adaptive question path
Do not ask every template field sequentially. Conduct a natural interview, then ask only the highest-value missing questions:
1. “Could you tell me about the client and what the project set out to achieve?”
2. “What problem was the client experiencing before the work began?”
3. “Why was solving that important to the business?”
4. “What did Amaris deliver, and what part did you personally own?”
5. “Which technologies or methods were actually used, and where?”
6. “How did the team work with the client?”
7. “What changed after delivery? What can the client do now that it couldn't do before?”
8. “Do we have before-and-after measures for time, cost, errors or another useful indicator?”
9. “What made Amaris particularly valuable in this engagement?”
10. “What feedback did the client share? Was any wording explicitly approved as a quote?”
11. “Is there anything confidential that should be anonymised or excluded?”

## KPI rules
Each metric stores label, before, after, unit, period, method, source, attribution, status and public permission. Do not force three KPIs. Qualitative impact is acceptable; do not fabricate a percentage or ROI.

## Client quote rules
Quote must be exact source text. Store speaker, title, company, date, source reference and permission. If no approved verbatim quote exists, omit the quote block or use a clearly labelled paraphrase outside quotation marks.

## Internal-only notes
Page 3 contains “NOTAS INTERNAS (NO COMPARTIR CON CLIENTE)” with manager, consultant and date. Store these in a separate restricted metadata object. Exclude them from client-facing/public exports by field-level allowlist, not prompt instruction alone. Include a regression test attempting to export internal notes and confirming they are absent.

## Language and output
The supplied template is Spanish. Preserve Spanish labels and generate Spanish when requested/appropriate. User conversation language and output language are independent. Keep names, titles and technology names exact. FR/EN variants should be separate versioned templates.

Generate:
1. Internal structured story record with provenance/status.
2. Review-ready Spanish DOCX using supplied template.
3. Public-safe Spotlight story only after approvals.
4. Internal notes as a separate restricted metadata object.
