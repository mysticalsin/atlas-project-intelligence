# ATLAS: the reference creation and reuse platform

Functional solution for the brief "Summary of the Expected Tool / Platform" (2026-09-27). Built and tested; the local
demo (`node deploy/cloudflare-edge/dev/local-edge.mjs`, then `http://127.0.0.1:8787/?as=you@mantu.com`) is the mock-up.
Every requirement is traced in `docs/REQUIREMENTS_TRACE.md`.

## 1. What it is
A voice interviewer that turns what a consultant did into a structured, evidenced, commercially useful reference,
a review agent that scores it, an N+1 who validates it, and a shared library where sales can find the right references
for a meeting and generate client-ready slides. Nothing is invented: missing information is asked for, marked
missing or flagged, and every model output is checked.

## 2. How the consultant interaction works
1. **Trigger.** End of project, milestone, periodic review (project-management webhook), or a reference not updated
   for six months (daily scan). The consultant sees it under *Your interviews* with a calendar file. Nothing is emailed
   automatically.
2. **Consent.** One plain sentence: transcribed, saved with a report, reused only once reviewed and validated.
3. **Opening.** ATLAS says what it is for (a reference other teams can reuse, about fifteen minutes, reviewed before
   use) and asks one broad, open invitation to tell the story.
4. **Breadth first.** One good open question per area until each has an answer: what was going on (client
   challenge), what the consultant personally did, how they approached it, what came of it, what supports it, who else
   it would help. At most one follow-up per point in this phase; for a number, only "how did you know?".
5. **Reference details.** Once and briefly: timeline and duration, team size and roles, technologies or methods,
   deliverables, service line, country. Never pushed if unknown.
6. **Depth.** The one or two claims that matter most: baseline, source and period. Activities are kept apart from
   outcomes ("what changed because of it?"). Vague or team-level answers are challenged; after two unproductive tries
   ATLAS offers to move on.
7. **Pacing.** The whole interview lasts at most 15 minutes. The server tells her how much time is used and what to prioritise (breadth, then challenging the one or two claims that matter, then only the most important question); with 75 seconds left her next reply is the closing, and at 15 minutes the interview ends cleanly with its report. Her own speaking time is a second cap (10 minutes).
8. **Ending.** Two turns: "anything else before we wrap up?", then a one-sentence recap and thanks. The microphone
   closes by itself.
9. **Report and save.** A report is drafted from the conversation only (client names generalised), saved
   automatically to the project with the notes, story draft and transcript, and synced to the library.
10. **Review and validation.** The review agent scores it; the N+1 validates in-app from a direct link (or requests
    changes). Validated and ready references publish automatically, with client details hidden from other readers.

What the agent never does: accept the first vague answer, bundle questions, praise an unverified number, name the
client, promise confidentiality, or end before the areas are covered (unless the consultant must leave or the time
is up).

## 3. The final reference record (`atlas.reference.v1`)
| Area | Fields |
|---|---|
| Identity | title (authorized alias), project ID, links to supporting information, owner, consultants (name, email, role), revision |
| Client (confidential) | client name, location, contact role: visible only to the record's people and reviewers, never sent to a model |
| Context | industry, country, service lines, practice area (JEV), stage |
| Story | client context and challenge, personal contribution (scope and activities), approach and methods, outcome and benefits, evidence, commercial relevance for future clients |
| Delivery | timeline (start, end, duration), team size and roles, technologies and methods, key deliverables |
| Quality | score, completeness, review-agent score, status, blockers, missing fields, issues (vague, too technical, unsupported claim, value unclear, activities not outcomes), recommendations |
| Governance | N+1 validation (status, by, when, note), publication status, revisions, audit trail, next review date, duplicates |
| Drafts | ATLAS report (model draft), interview transcript (unverified ASR, not evidence) |

Exported as a Word-compatible record from a project or from the library; stored as structured JSON in the library.

## 4. Two operating models (and a recommendation)
| | A. Consultant-led, AI-gated (built) | B. Reference desk (assisted) |
|---|---|---|
| Who runs the interview | The consultant, when triggered | A reference/marketing owner schedules and attends, ATLAS asks the questions |
| Validation | N+1 in-app; review agent gate; auto-publish when ready + validated | Reference desk validates and publishes every record |
| Throughput | Scales to all consultants (12,000); no central bottleneck | Limited by the desk's capacity |
| Quality control | Deterministic completeness + review agent + N+1 + threshold (`READY_SCORE`) | Human editorial quality, slower |
| Risk | Consultants skip invitations: needs the lifecycle triggers and management follow-up | Desk becomes the bottleneck the brief warns about |
| Cost | Model usage per interview; no headcount | Headcount per volume |

**Recommendation:** A as the default, with B's desk as *reviewers* (`REVIEWER_EMAILS` / Entra `ATLAS.Reviewer`) who
handle exceptions: requested changes, merges, reinstatement, insights and import/export. Both run on the same build;
switching is configuration, not code.

## 5. Backend and scalability options
| Option | What | When |
|---|---|---|
| Current (built) | Cloudflare Worker + Durable Objects (SQLite) for sessions and the library; Workers AI for speech and models; Access for sign-in | Pilot, up to ~5,000 references and hundreds of concurrent interviews |
| Scale-out on Cloudflare | Library to D1 + Vectorize (embeddings), per-country Durable Objects, Queues for reviews | Beyond ~5,000 references or heavy search load |
| Mantu Azure | Same API contract on Azure (App Service/Functions, Azure SQL, AI Search, Entra roles), Spotlight Ref backend as the store | If IT requires data residency in the Mantu tenant or Spotlight becomes the master |

The library API and `atlas.reference.v1` schema are the stable contract, so moving the store does not change the
interviewer, the review agent or the UI.

## 6. Open decisions (built so each is a setting, not a rebuild)
| Decision | Built default | Where to change |
|---|---|---|
| Chat, voice or both | Voice first; typed notes remain available per topic | UI |
| Interface (Teams, Slack, web) | Web app; deep links work from any channel; a Teams tab is the natural next step | Integration |
| Individual access for consultants | Yes, each person has their own space and sees published references | Access / Entra |
| Automatic scheduling | Invitations with suggested slots and calendar files; never auto-sent | `/api/triggers`, reviewer form |
| Recording and transcription | Transcription required by consent; no audio stored | Consent text |
| Where the master database lives | Library Durable Object (pilot) | Section 5 |
| Connection to Spotlight Ref | Versioned JSON export/import | `docs/INTEGRATIONS.md` |
| Connection to the project-management system | Webhook `POST /api/triggers` | `docs/INTEGRATIONS.md` |
| Who validates | The N+1 per record; reviewers for exceptions | `REVIEWER_EMAILS`, Entra roles |
| Minimum quality score to publish | 75 | `READY_SCORE` |
| Who sees what | Record people and reviewers: everything; everyone else: published, client hidden | Library permissions |

## 7. What is not claimed
Live speech quality, model answers on real interviews, Entra sign-in, the Teams/Graph notification and the real
project-management and Spotlight connections are not yet verified in production; see `handoff/BUILD_STATUS.md`.
