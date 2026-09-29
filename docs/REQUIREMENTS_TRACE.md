# Requirements trace: the brief → ATLAS

Status: **Built** = implemented and tested locally (unit + real-browser tests against the real Worker code with a
stand-in model); **Live** needs Tony's deploy and a spoken test; **External** needs a system or approval ATLAS does
not control. Test files: edge `deploy/cloudflare-edge/test/*.test.js`, app `tests/*.test.js`, browser `tests/*_browser.py`.

## Business objective
| Requirement | Where | Test | Status |
|---|---|---|---|
| Capture project information directly from consultants | voice interview `src/voice-client.js`, `deploy/cloudflare-edge/src/session.js` | session.test, autosave_browser | Built, Live |
| Turn operational descriptions into commercial references | talker policy (`atlas_voice/cascade.py`), report (`report.py/js`), review agent (`review.js`), commercial relevance field | report/library tests | Built, Live |
| Reliable, searchable database of high-quality references | Library DO `library.js`, quality gate, N+1 validation | library.test, library_browser | Built |
| Recommend references for a client, sector, issue or service | `recommend()` + `reuse.js` | reuse.test, reuse_browser | Built |
| Client-ready slides without inventing information | `slides()` + `src/pptx.js`, number check | reuse.test, pptx.test, reuse_browser | Built |

## Main pain point
| Requirement | Where | Status |
|---|---|---|
| Ask the right questions; explain business challenge, importance, client value, relevance to others, commercial interest, structure for sales | TALKER_POLICY (story contract, breadth/depth, reference details), ledger guidance, report `customer_relevance`, review agent `client_value_clear` | Built, Live |
| Identify missing information | completeness check (`review.js REQUIRED`), report `gaps`, pace note "next uncovered area" | Built |
| Challenge vague answers | policy challenge rules, analyst flags, review issues `vague` | Built, Live |
| Extract business value | outcome vs activities rule, review `value_unclear` blocker | Built, Live |

## 1. Conversational intake agent
| Requirement | Where | Test | Status |
|---|---|---|---|
| Explain the purpose of the interview | OPENING | policy.generated | Built, Live |
| Structured questions based on reference templates | AREAS + REFERENCE DETAILS in TALKER_POLICY; template = `review.js REQUIRED` | test_report pace | Built |
| Adapt to answers | analyst guidance, JEV ranker, stale-hint rule | session.test | Built |
| Detect incomplete, vague, low-value responses | ledger flags, policy, review issues | test_quality, library.test | Built |
| Follow-up questions; challenge for precision | policy (one follow-up in breadth, depth phase), guidance | session.test | Built, Live |
| Stop only when required information is collected | ENDING requires every area answered + reference details asked (or consultant must leave / time up); `[[END]]` ignored while a question is pending | session.test (question backstop) | Built, Live |
| Structured summary to review and validate | report → auto-saved project, report dialog, library record, N+1 validation | autosave_browser, library_browser | Built |
| Interactive interview, not form or transcription | voice turn-taking, barge-in, pacing | session.test, studio_browser | Built, Live |

## 2. Reference content
| Field | Where | Status |
|---|---|---|
| Client name (confidential) and project context | `client{}` (never sent to models), answer 1 | Built |
| Business challenges and objectives | answer "context" | Built |
| Industry and business domain | `sector`, report facts `industry` | Built |
| Services, expertise, service lines | `details.serviceLines`, JEV practice area | Built |
| Scope and activities | answer "contribution" | Built |
| Deliverables and achievements | `details.deliverables`, answer "outcome" | Built |
| Client benefits and measurable outcomes | answer "outcome", evidence rules | Built |
| Timeline and duration | `details.start/end/duration` | Built |
| Team composition and roles | `details.teamSize/teamRoles` | Built |
| Technologies, methods, capabilities | `details.technologies`, answer "approach" | Built |
| Project identifier and links | `details.projectId`, `details.links` (https only) | Built |
| Consultants involved | `consultant`, `details.consultants[]`, merged contributors | Built |
| Missing information / points to confirm | quality `missing`, report `gaps`, Word "Missing - to confirm" | Built |
| Commercial relevance | answer "customer_relevance" | Built |
| Word-style document, then a database | `recordDoc()` / library Word export; Library DO | Built |

## 3. Quality review and scoring
| Requirement | Where | Status |
|---|---|---|
| Second agent assesses quality | `review.js reviewReference` (analyst model, anonymised) | Built, Live |
| Missing / weak information | completeness + issues | Built |
| Vague or overly technical wording | issue kinds `vague`, `too_technical` | Built |
| Client value clearly explained | `client_value_clear` (blocker when false) | Built |
| Unsupported claims | `unsupported_claim` (blocker) | Built |
| Recommend improvements | `recommendations` | Built |
| Score / status / ready for use | score, `ready | needs_work | insufficient`, threshold `READY_SCORE` | Built |
| Poor quality never treated as validated | publication = ready + N+1 validated; no override | Built |
| Human validation not a bottleneck | automatic review on save; auto-publish; N+1 one click from a link | Built |

## 4. No hallucination
| Requirement | Where | Status |
|---|---|---|
| Never create facts | talker, report, review, rerank, slides, insights policies; slide number check; id checks | Built |
| Ask / mark missing / request evidence / flag for review | policy, gaps, missing, review blockers | Built |

## Search and recommendation
| Requirement | Where | Status |
|---|---|---|
| Natural-language search ("data director of a major energy company") | Library → *Find references for a meeting* | Built |
| Understand industry and context; likely challenges | `TARGET_POLICY` | Built |
| Search across detailed references | embeddings (bge-m3) + lexical fallback over anonymised records | Built |
| Recommend, explain why, transferable elements | `RERANK_POLICY` → relevance, why, transferable, caveat | Built |
| Not keyword-only; cross-client transfer (a project for one client made relevant to another company) | semantic retrieval + model judgement of business similarity | Built, Live (quality depends on real data) |

## Reference generation and presentation output
| Requirement | Where | Status |
|---|---|---|
| Reuse detailed data; concise summary | slides `summary`, report headline/summary | Built |
| Client-oriented PowerPoint | `src/pptx.js` (validated by python-pptx) | Built |
| Adapt wording to target context | slides context | Built |
| Preserve facts; distinguish facts from interpretation | bullet `kind`, ◇ marker, provenance footer; unsupported numbers removed | Built |
| Never invent results, clients, figures | number check, client name only added by code for allowed readers | Built |
| Progression 1–5 | 1–4 built; 5 (value propositions) = commercial insights | Built |

## Data repository and platform
| Requirement | Where | Status |
|---|---|---|
| Structured storage | `refs` table, `atlas.reference.v1` | Built |
| Search by client, industry, country, service line, expertise, technology, topic, challenge | list filters/facets, text filter (client search for record people only), recommendations | Built |
| Links to project IDs and source documents | `details.projectId`, `links`, `sources` | Built |
| Access rights | roles + record people + anonymised public view | Built |
| Versioning and enrichment over time | immutable `revisions`, review on every revision | Built |
| Traceability (created, reviewed, updated) | `audit` table, shown in record | Built |
| Scalability beyond pilot | `docs/SOLUTION.md` §5, `handoff/SCALE_PLAN.md` | Built (pilot scale); plan documented |
| Spotlight Ref integration | export/import contract `docs/INTEGRATIONS.md` | Built; connection External |
| Project-management integration | `POST /api/triggers` | Built; connection External |
| Scalable system, not a chatbot | Worker + Durable Objects + library | Built |

## Consultant workflow and automation
| Requirement | Where | Status |
|---|---|---|
| End of project / milestone / periodic review triggers | `/api/triggers` reasons | Built; PM connection External |
| Not updated for six months | daily cron `scanStale` | Built, Live |
| Part of the normal workflow | *Your interviews*, start from invitation, deep links | Built |
| Scheduled slot, guided voice, short, dynamic | slots + `.ics`, voice interview, 15-minute interview limit (her own speaking capped at 10) | Built |
| No generic email | nothing sent automatically; calendar file and in-app list | Built |

## Experience requirement
| Requirement | Where | Status |
|---|---|---|
| Not: receive a doc, transcribe, fixed list, generic summary | adaptive interview + review agent | Built |
| Explore, follow up, business impact, concrete examples, clarify role, separate activities from outcomes, detect low quality | TALKER_POLICY sections, ledger, review agent | Built, Live |

## Future capabilities
| Requirement | Where | Status |
|---|---|---|
| Counts by country, service line, expertise/topic | Analytics & insights | Built |
| Coverage gaps | practice × country matrix + gap list | Built |
| Most represented clients / industries | by client (reviewers), by industry | Built |
| Strongest references; needing enrichment | strongest, needs enrichment (incl. stale) | Built |
| Activity without documented reference | open invitations from triggers with no reference | Built (needs PM feed) |
| Duplicate detection and consolidation, multiple consultants, preserved contributions | `index()` duplicates, `merge()` | Built |
| Mapping: service lines, expertise, technologies, industries, countries, problems, consultants | analytics bars, practice areas, facets | Built |
| Commercial intelligence: repeated needs, emerging expertise, proposals, new offerings | `insights()` (interpretation, cited ids) | Built, Live |

## Immediate expectations for Tony
| Expectation | Where |
|---|---|
| Functional solution | `docs/SOLUTION.md` |
| At least two operating models | `docs/SOLUTION.md` §4 |
| Agent concept or mock-up | the running app; offline demo `dev/local-edge.mjs` |
| How the consultant interaction works; what the agent asks and how it follows up | `docs/SOLUTION.md` §2 |
| Final reference record | `docs/SOLUTION.md` §3, Word export |
| Backend and scalability options | `docs/SOLUTION.md` §5 |
| Open decisions | `docs/SOLUTION.md` §6 |
