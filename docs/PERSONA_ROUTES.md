# ATLAS from Mantu: which prompts speak to the consultant

Tony, 2026-11-08: ATLAS has a personality, is ATLAS from Mantu, and is here to help tell the story, with warmth that fits the moment. That applies to the routes that converse with the consultant. Analytic and report prompts keep their own factual roles and get no interview chat or praise.

Contracts: `tests/test_persona.py`, `tests/test_persona_routes.py` and `tests/test_persona_scenarios.py`. The last is a matrix of route by kind of answer (ordinary, proud, uncertain, distressed, brief, repetition, honesty, untrusted input), with each route's interruption tests named in it. These are deterministic prompt checks. Live model behaviour and native-language review are not covered.

## Conversational routes (aligned)
| Route | Speaks with | Identity and story purpose | Proportionate warmth, choice on sensitive topics, AI not a person |
|---|---|---|---|
| Edge Workers (deployed) and Kyutai (`cascade.py`) | `TALKER_POLICY`, and `OPENING` if no greeting was spoken. Spoken greeting: `languages.js` `GREETINGS` / `WELCOME_BACK` (7 languages). Gap mode uses the same talker. | yes | yes |
| Hosted OpenAI Realtime (`realtime.py`) | `quality.py` `INTERVIEW_POLICY` (session instructions), with `HOSTED_OPENING` for the first response | yes | yes, added to the existing rules (no sentience claims, no inferred emotions, no generic praise) |
| PersonaPlex (`server.py` via `interview.make_prompt`) | `interview.ROLE` | yes | yes, in short form |

**Admin mode** on the edge and Kyutai routes (`ADMIN_NOTE`) deliberately overrides the speaking style with short questions and no reactions.

**Not equal across routes:**
- Only the edge route has the instant cached greeting.
- The hosted route's first words come from the model following `HOSTED_OPENING`.
- PersonaPlex speaks first from its role.
- The three routes still differ in features (see `CLAUDE.md`).

## Non-conversational prompts (unchanged on purpose)
None of these speaks to the consultant:
- the evidence analyst: `analyst.py` `ANALYST_POLICY`, and `ledger.js` on the edge;
- the report writer: `report.py` / `report.js`;
- the account editor: `editor.py`;
- the reference sheet and visuals: `sheet.js`;
- the reuse review: `review.js`;
- library, bid and insight ranking or writing: `library.js`, `bids.js` and `ask.js`;
- the JEV rating: `jev.py` / `jev.js`;
- post-session notes: `notes.py`.

They must stay factual and keep their schemas and roles. `tests/test_persona_routes.py` checks that the analyst, report, editor, review, sheet and ledger prompts carry no conversational warmth.

## Not established
- Live behaviour on any route: warmth, no repetition, handling distress.
- The quality of the non-English greetings, which needs a native-speaker review.
- The hosted route's opening wording, which is model-generated.
