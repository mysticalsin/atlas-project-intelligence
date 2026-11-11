# Living CV

The living profile fits the library feature registry. The voice pipeline stays as it is.

## Decision

No refactor of the interview pipeline. A CV is a document the consultant asks for, built from stories the library has already published. The new code is a feature word, `living`, with a pure core and one route module that writes artifact status.

## What already exists

| Step | Where it lives | What this change does |
| --- | --- | --- |
| Speech recognition | `atlas_voice/kyutai.py`, `atlas_voice/realtime.py`, `deploy/cloudflare-edge/src/session.js` | Nothing. A transcript is not a fact. |
| Interviewer | `atlas_voice/cascade.py`, `atlas_voice/quality.py`, session history | Nothing. One question at a time stays there. |
| Evidence analyst | `atlas_voice/analyst.py`, `deploy/cloudflare-edge/src/ledger.js` | Nothing. A detail is stored only when the quote is in the transcript. |
| Quality controller | `InterviewLedger.inspect`, `review.js`, `gap-policy.js` | Nothing. Publish still requires a ready review plus both approval lanes. |
| Voice output | `session.js`, `src/voice-client.js` | Nothing. |
| Published record | `library.js`, `snippets.js` | Read. CV lines are snippet sentences from the owner's published stories. |

Ledger detail ids are not copied onto the library revision. The sentence the consultant applied, and both reviewers accepted, is the citation: `storyId:snippetId`. Keeping those session ids would mean changing the interview-to-library path, which this change does not do.

## Phrasing

`phraseLine` is a separate stage in `living-core.js`. It runs after a sentence is chosen and before the bullet is shown. It removes a leading "I" or "We" (and a following "have" or "am" when that is only the subject) and capitalises the bullet. Every remaining word has to occur in the published sentence. If that check fails, the stage keeps the published sentence. It does not call a model and it does not add a tool, a year count, or a skill that the sentence did not already contain. The published sentence stays on the line as `source`. Export still checks `source` against the live snippet, and the docx keeps the evidence id in the audit.

## Modules

- `living-core.js` is pure. It holds the artifact state machine, both need adapters, CV composition, the fiche projection, the competency-file mapper, and the local docx/pdf writers. It does not log, write, or call the network.
- `living.js` is the only writer. It calls `transition()`, writes the row, then logs the id and the states. Generation records a usage row with `tokenStatus: 'missing'`.
- States: `draft`, `in_review`, `approved`, `exported`, `withdrawn`. Generate creates a draft and submits it. The owner cannot approve. Export checks that every cited sentence is still the published snippet.

## Needs

`NeedSource` has two adapters and one Need shape.

- `SmartNeedLinkAdapter` accepts only `https://need.arp.mantu.com/needs/<id>`. It reads a fixture or HTML the caller already has. There is no fetch and no credential. An unknown link returns `unreadable` and `pasteFallback`.
- The parser keeps the Candidate Requirement section. Must tags and Level are the ATS keywords. A dash is empty. A duplicated mission list joined by a middle dot is de-duplicated. A merged profile bullet stays one item and is flagged, not split into a claim.
- A disagreement inside the section is a flag for the consultant. The flag states the conflict and the next step. Level 4–6 years stays the keyword when the prose says 2+ years. C++ stays a Must keyword when the prose says it is an asset. A gap is only a must keyword that no published sentence supports. Level and nice-to-have keywords are not gaps.
- A line that claims more years than its role dates is a `date_conflict` flag and is left out of the CV, the competency file, and the export. The published sentence stays on the flag. The mapper itself is unchanged: it only sees lines the composer kept.
- `PastedJobDescriptionAdapter` reads text the consultant pasted.

## MiChat

`toCompetencyFile` maps a CV onto the competency-file fields one for one: identity, summary, technical, soft, and functional skills, languages with spoken and written levels, education, certifications, and projects (company, role, dates, context, responsibilities, technologies, achievements). Years of experience and the summary stay null. A sentence that says "8 years" stays on the project. A language, a degree, or a certification is copied only when that sentence states it, and it is not copied from the need. Soft and functional skills stay empty unless the sentence itself uses those words. Every non-empty value keeps the snippet id. `exportDocument` writes that file as a local `.docx` and does not call MiChat. A connector only has to send the object.

MiChat has an "Adapt CF to Project" action. Atlas already tailors from the Candidate Requirement before export. A future connector must not call that MiChat action, or the same CV would be adapted twice. The envelope records `operation: 'adapt'` and `michatAdapt: false` to keep that distinction.

## Fiche

A fiche is the same published snippets, grouped by topic. Salary, compensation, and market value are dropped by key and by sentence. The projection does not add a score.

## Consent, delete, tenant

`profileReuse` is a stored consent, the same path as the other profile consents. Generate and review ask for it. Privacy delete removes living artifacts for that subject and tenant. Another tenant cannot read them.
