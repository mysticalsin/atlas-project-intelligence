# How ATLAS handles your information

Version `2026-10-31.2`. DRAFT — controls implemented in code; wording, lawful bases, controller and DPO details need DPO and legal sign-off.

> Generated from `atlas_voice/config/privacy.json` by `scripts/render_privacy_docs.py`. Edit the JSON, not this file. The same text is served at `/privacy`.

ATLAS is a voice-first interview that helps you turn a past project into a reusable reference. This notice explains what is collected, who sees it, how long it is kept and how you control it. Items in square brackets are placeholders that Mantu's DPO and legal team must complete before real use.

## Who is responsible

Controller: [CONTROLLER — Mantu legal entity, registered address — to be completed by Mantu legal].

Data Protection Officer: [DPO name and contact — to be completed by Mantu].

## What your information is used for

Running the interview: your voice is turned into text so ATLAS can reply and take notes. Audio is not stored.

Keeping a private draft of your notes, transcript and report. Only you can see it until you click Submit for review.

After you submit: review by your N+1 or a reviewer and, once approved, reuse as reference material for future Mantu projects.

Optional, each off unless you tick it: resuming an interrupted interview (up to 24 hours) and a short private memory between interviews.

Lawful basis for each purpose: [LAWFUL BASIS PER PURPOSE — DPO to confirm].

## What is collected

Your words, spoken (as text) or typed; your project details, notes, report and any evidence statements you confirm.

Your sign-in identity (work email and name from your Microsoft or Access sign-in), your N+1 if known, and the choices you make in the consent dialog (consent receipts).

A quality score of the write-up (it rates the write-up, not you), review decisions, and an audit record of who did what.

ATLAS does not identify you by your voice, does not record audio, and does not infer anything about you as a person (no mood, personality, skill or performance judgements).

## Sensitive personal information

Please do not share information about your health, religion, politics, trade-union membership, sexual orientation or ethnic origin. If you do, ATLAS will offer to keep that part private.

ATLAS matches a short list of sensitive terms in several languages only to make that offer. It never records anything about you from it, and text it flags is not sent to its memory service.

## Who receives it

Inside Mantu: you; your N+1 and reviewers only after you submit; administrators only for operating the service.

Processors: Cloudflare (hosting, storage and the Workers AI models for speech-to-text, language and text-to-speech).

Only if switched on: ElevenLabs (speech for some languages; receives the text ATLAS speaks), Hindsight (private memory, only if you turn it on), TypeSafe (story quality rating, only if you allow it).

Your name never goes to a language model. The processor list, locations and contracts are in the sub-processor register: [PROCESSOR LOCATIONS AND DPAs — to verify].

## Transfers outside the EEA

[TRANSFER MECHANISMS — to be completed after processor locations are verified].

## How long it is kept

Interrupted interviews: deleted automatically after 24 hours.

Other periods are proposals awaiting DPO confirmation (table below). Backups held by the platform can outlast deletion for a short period: [PLATFORM RECOVERY WINDOW — to verify].

| What | Kept for | Counted from | Then | Enforced by | Status |
|---|---|---|---|---|---|
| Private drafts never submitted for review (library drafts and evidence drafts) | 90 days | last change | deleted | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Withdrawn references | 90 days | withdrawal | content erased (an empty marker stays) | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Rejected or withdrawn evidence records and their claims | 180 days | last change | content erased (an empty marker stays) | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Expired confirmation requests and proof (gap) requests | 90 days | expiry | deleted | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Outreach messages and interview invitations that are finished | 90 days | sent, dismissed, done or expired | deleted | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Staffing import rows (who worked on which project, N+1) | 180 days | project end date, else last import | deleted | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Audit trail rows | 730 days | row date | pseudonymised (actor replaced, free text cleared) | LibraryStore daily sweep (the audit hash chain is re-sealed and its new head logged) | PROPOSAL — DPO to confirm |
| Consent receipts (records that a choice was made) | 2190 days | the person's latest receipt | deleted | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Pseudonymous security-event log lines | 90 days | event | handled by the platform | the log sink or Cloudflare Workers Logs plan (to verify) | PROPOSAL — DPO to confirm |
| Private memory facts (Hindsight, only if the person turned memory on) | 365 days | last update | forgotten | pruned for that person each time memory is used; the person can erase it at any time | PROPOSAL — DPO to confirm |
| Interview checkpoint (resume after a dropped connection) | 24 hours | first write | deleted | Interview Durable Object alarm | Decided by Tony (24 h absolute) |

## Your rights and how to use them

Access and portability: choose Download my data in your profile to get a machine-readable file.

Erasure: choose Delete my data in your profile. Content you wrote is replaced by empty markers. Approved material already used in a bid is flagged for the DPO to review instead of being silently deleted.

Withdraw consent: change the toggles in your profile at any time. Withdrawing is recorded and does not affect what was done before.

Restriction and objection: you can ask ATLAS to stop scoring, matching or remembering your material.

You can complain to your supervisory authority. Contact: [PRIVACY CONTACT — to be completed].

## Interrupted interviews (24 hours)

If you allow it, the state of a running interview is kept in your own storage for at most 24 hours from the first save so you can resume. It is then deleted automatically.

## Typing instead of speaking

You can type instead of speaking. No microphone is used and no audio is sent. Only saving your draft is needed.

## No automated decisions about people

ATLAS does not make decisions about you by automated means. Quality scores describe the write-up, and people review every reference before it is shared.

## Your browser

If you choose Save on this device, your workspace is stored unencrypted in this browser until you remove it. Nothing else is stored in your browser except small settings needed for the page to work. No advertising or tracking cookies are used.

## Contact

[PRIVACY CONTACT — email and postal address, to be completed by Mantu].

## The wording of the consent choices (what the consent dialog shows)

- **capture** (required): I agree that ATLAS transcribes what I say and saves my notes, transcript and report as a private draft that only I can see until I click Submit for review.
  - typed interview: I agree that ATLAS saves what I type, my notes and my report as a private draft that only I can see until I click Submit for review.
- **checkpoint** (optional): Keep this interview for up to 24 hours so I can resume it if the connection drops. It is deleted automatically after 24 hours, or as soon as I end or discard the interview.
- **memory** (optional): Let ATLAS remember a few short, neutral facts about my projects between interviews (private to me, kept with its memory service). Nothing I keep private is stored. I can see and erase it at any time.
- **notice** (optional): I have read the privacy notice.

- Profile choices:
  - **spoken_ask**: Allow ATLAS to transcribe my short spoken questions in Ask. The recording is sent for transcription and is not kept.
  - **jev_rating**: Allow my reference write-ups to be rated by TypeSafe's JEV service. The text of the write-up (without my name or client details) is sent to TypeSafe for that.
