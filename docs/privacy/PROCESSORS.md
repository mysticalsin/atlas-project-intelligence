# Sub-processor registry (draft for the DPO)

Status: **DRAFT. Nothing here has been verified with a provider.** Every cell marked *to verify* needs a provider document, a contract or a console check before real data is used. This registry lists what the code can send where; it is not a statement that any contract, location or transfer mechanism is in place. No provider was called to write it.

**OWNER-DECISION (before any real data):** the deployment runs on a **personal Cloudflare account** (`wrangler.jsonc`: `tony-walteur.workers.dev`, an individual's email as admin and as the Access team). That account is not covered by a Mantu data processing agreement. Move the Worker, the Durable Objects, the Access application and the secrets to a **Mantu-owned Cloudflare account** and re-run this registry against that account's contract before a single real interview.

## Registry

| Processor | Role in ATLAS | Personal data it can receive | Switched on | Location | DPA / contract | Sub-processors | Retention at the processor | Transfer mechanism |
|---|---|---|---|---|---|---|---|---|
| **Cloudflare** (Workers, Durable Objects, Access, Workers Logs) | Hosts the application, stores everything ATLAS keeps (per-person Interview objects, the LibraryStore), signs people in (Access), runs the logs | Everything below, at rest and in transit: transcripts as text, notes, reports, evidence, profile, consent receipts, audit rows, the sign-in identity (email, name), request metadata in logs | Always | *to verify* (Durable Object placement; jurisdiction options) | *to verify* (currently a personal account: see the owner decision above) | *to verify* | Storage until the app deletes it; Durable Object point-in-time recovery after deletion: *to verify* (about 30 days stated by the platform); Workers Logs: plan dependent, *to verify* | *to verify* |
| **Cloudflare Workers AI** (models listed below) | Runs speech-to-text, the conversational model, the analyst, text-to-speech, embeddings and the end-of-turn model for the interview, review and matching | Consultant speech (as audio frames, not stored by ATLAS), consultant text, project context without the consultant's name, reference text with client names masked | Always | *to verify* (inference location is not pinned) | *to verify* (inference retention and training use: *to verify*) | *to verify* | *to verify* | *to verify* |
| Models on Workers AI: `@cf/deepgram/nova-3` (speech-to-text), `@cf/deepgram/aura-2-en` and `aura-2-es` (text-to-speech), `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (talker), `@cf/openai/gpt-oss-120b` (analyst, review, report), `@cf/baai/bge-m3` (embeddings), `@cf/pipecat-ai/smart-turn-v2` (end of turn) | The model vendors are named so the DPO can ask whether any of them receives data, or whether the models run only on Cloudflare infrastructure | As above | Always | *to verify* whether Deepgram, Meta, OpenAI or Pipecat see any data | *to verify* | | | |
| **ElevenLabs** | Optional: speech for languages the Cloudflare voices do not cover, or for every language when an admin chooses ElevenLabs in Settings → Voice (v2.2 V2) | The text ATLAS speaks (replies, read-backs; never the consultant's audio). Key check and voice list send the admin's key only. Test voice sends a fixed phrase | Only when a key exists: `ELEVENLABS_API_KEY`, or one an admin saved in Settings → Voice (stored sealed). The default stays Workers AI; ElevenLabs speaks English and Spanish only after an admin selects it | *to verify* | *to verify* | *to verify* | *to verify* | *to verify* |
| **Hindsight** (Vectorize, Hindsight Cloud, or a self-hosted server through `HINDSIGHT_URL`) | Optional private memory between interviews | Short structured facts about a project (title, stage, sector, job title, technical details, which topics were covered, open follow-up questions); never what was said, never anything kept private, never a flagged sensitive line, observations off | **Only when the person turned memory on** and `HINDSIGHT_API_KEY` and `HINDSIGHT_BANK_SECRET` are set | *to verify* | *to verify* | *to verify* | Pruned per person after 365 days (proposal) and erasable by the person at any time; provider side: *to verify* | *to verify* |
| **TypeSafe** (JEV) | Optional: rates the write-up of a reference (not the person) and ranks references for a customer brief | The text of a reference with the consultant's name removed and client names masked (rating, only with the owner's `jev_rating` consent); questions and structure only (customer ranking). **Memory text is no longer sent** (G2). | Only when `TYPESAFE_API_KEY` is set (and, for rating, the owner's consent) | *to verify* | *to verify* | *to verify* | *to verify* | *to verify* |
| **Microsoft Entra ID** | Optional identity provider behind Cloudflare Access (`IDENTITY_SOURCE=entra`; built, not enabled) | Sign-in identity, tenant and object ids, roles | Only when configured | Mantu's tenant | Existing Mantu agreement: *to verify* | | | |

## Not yet connected (no personal data flows today)

DNA (skills write-back and the directory pull or push), MiChat (CV), IMP (capability), Spotlight CMS, MAAP, Project Review and the Teams bot are `BLOCKED_EXTERNAL`: the owners have not supplied an endpoint, a schema or a credential (`docs/CONNECTIONS.md`). When one is connected it is a recipient and belongs in this registry, in the RoPA and in the DPIA before it goes live. The framework (`connectors.js`) refuses to send until a connection's status says it is verified.

## What the code guarantees about what is sent

- The consultant's name never reaches a language model (pinned by tests, including every evaluation scenario).
- Client names, contacts, other people's names, emails and links are masked from model input by `scrub.js` and `recordView`.
- A kept-private utterance is removed from the talker history, the analyst input, the notes, the report input and the draft. A line the special-category guard flags is never sent to memory.
- Private memory sends facts, never conversation text, and only after the person ticked it (consent receipt).
- Every outbound call to an optional processor needs its key to be set; with no key nothing is sent. `ATLAS_AI_OFF` stops every model call at the Worker.

## To do before real data

1. Mantu-owned Cloudflare account (owner decision above).
2. A DPA and a transfer mechanism for every row marked *to verify*, or switch the row off.
3. Confirm with Cloudflare whether Workers AI keeps or trains on inputs, and where inference runs.
4. Decide whether memory, ElevenLabs and TypeSafe stay in scope for employees at all.
5. Fill the placeholders in the privacy notice (`[PROCESSOR LOCATIONS AND DPAs — to verify]`).
