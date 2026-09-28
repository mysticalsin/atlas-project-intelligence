# Plan: ATLAS as the reference creation and reuse platform

Source: Tony's brief (2026-09-27, "Summary of the Expected Tool / Platform"). Built by Claude with Tony only; no external reviewers, no Dust.
Every requirement is traced in `docs/REQUIREMENTS_TRACE.md` (requirement → implementation → test → status).

## Architecture decision
- System of record: a central **Library** Durable Object (SQLite) in the edge Worker, one instance for the pilot.
  Records, immutable revisions, audit trail, embeddings, invitations. Scales later by sharding or moving to D1 + Vectorize
  (documented; not needed below ~5,000 references).
- The browser workspace stays the drafting space; references sync to the Library automatically after an interview.
- Roles from the verified sign-in: admin (`ADMIN_EMAILS`), reviewer (`REVIEWER_EMAILS`), the record's N+1 (validates
  that record), consultants (their own records + published references, client details hidden).
- Confidential client details never reach a model (interviewer, analyst, reviewer, search embeddings, slide writer).

## Phases
- [x] P1 Capture: complete reference template (project ID, links, country, dates/duration, team, technologies/methods,
      deliverables, service lines, several consultants); interviewer explains purpose, asks the template details,
      separates activities from outcomes; report extracts stated facts only; Word-compatible record export.
- [x] P2 Repository + quality: Library API (create/revise/list/get/audit), permissions, versions, traceability,
      auto-sync after interview, in-app N+1 validation, quality-review agent (score, issues, recommendations,
      ready status) and a publication gate.
- [x] P3 Reuse: natural-language search/recommendation with reasons and transferable elements (not keyword-only),
      facet search, duplicate detection and consolidation, client-context slides (.pptx) with fact/interpretation labels
      and a no-new-numbers check.
- [x] P4 Operate + analyse: lifecycle triggers (PM webhook, end of project/milestone, 6-month staleness cron,
      scheduled interview slots with .ics, never auto-sent), analytics and coverage gaps, mapping views,
      commercial insights (labelled interpretation), Spotlight Ref import/export contract, solution document
      with two operating models and the open decisions.

## Review (2026-09-27)
All four phases built and tested locally; every brief line traced in `docs/REQUIREMENTS_TRACE.md`.
Tests: app 129, edge 81, Python 182 (+30 sandbox-only socket tests), browser suites all green: studio 66, sculpture 40,
intelligence 26, depth 20, autosave 19, orb touch 8, library 14, reuse 19.
Not verified: live model quality on real interviews, the live Library Durable Object (needs deploy: migration v2 + cron),
Entra, Teams/Graph, and the real project-management / Spotlight connections (contracts built).
