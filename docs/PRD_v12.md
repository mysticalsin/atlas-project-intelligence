# ATLAS Project Intelligence
## Product and implementation contract · v12 · 26 September 2026

**Mantu · Product direction: Tony Walteur.** Working software and a deployment kit, not a claim of a connected production service. The browser is one application with three primary screens: Conversation, Projects and Stories. The deeper quality, wiki, customer-match and private-memory tools live in one secondary workbench.

> The consultant should feel interviewed by someone who followed the work, noticed what was missing, and cared about getting the account right—not processed by an intake form.

## 1. The product decision

The orb is an audio-responsive interface, not the intelligence itself. Quality comes from the conversational model, the bounded interview controller, explicit source provenance, consultant correction and independent review. A visually lifelike response must never suggest knowledge, emotion, live connection or factual certainty that the application does not have.

The durable outputs are an accurate account of the consultant’s contribution and a useful, permissioned customer story. An assessment, avoided bad decision, qualitative improvement or failed pilot may be more useful to a particular customer than a large but weakly supported savings claim. Do not optimize for the number of completed interviews, impressive percentages or polished paragraphs.

The first release stays deliberately small: one application/gateway, one selected voice provider, per-user Hindsight, immutable Markdown story revisions and one SQLite authority registry. The optional editorial and JEV calls are explicit operations inside this application, not additional autonomous agents or microservices. A derived graph is a view of authorized records, not a second source of truth.

## 2. A real conversation, not narrated form fields

Two voice routes are implemented. The hosted route uses OpenAI Realtime with speech input/output, automatic turn detection, interruption handling, transcript events and restricted function calls. The retained NVIDIA PersonaPlex route uses its private GPU worker, with optional Riva transcription after the conversation. They share the interface and project rules but do not have identical capabilities. There is no silent fallback and no browser synthesizer pretending to be a hosted model.

Hosted voice is the practical first pilot route when a PersonaPlex worker is not available. The default model name in the example configuration is `gpt-realtime-2.1`; confirm account access and actual behavior. NVIDIA remains available through an explicit server configuration change. A different provider must implement the same audio, consent, cancellation, transcript-provenance and tool boundaries before it can replace either route.

The assistant introduces itself as an AI interviewer, asks one useful opening question, then waits. A brief pause is not automatically the end of the person’s thought. It acknowledges the specific detail just heard rather than repeating generic praise. It can be interrupted. Its goal is a concrete account, not a sequence of affirmative answers.

### The twelve dimensions behind six familiar project topics

| Dimension | Information to recover only when missing |
|---|---|
| Problem and stakes | Who had the problem, what triggered action, and why the situation mattered. |
| Individual contribution | Deliverables and decisions the consultant actually owned, distinct from team/client ownership. |
| Intervention and choice | One implemented change, its mechanism, the plausible alternative, and the trade-off. |
| Adoption | Who used it, exceptions, handover and accountable operation after delivery. |
| Outcome | What changed, including a qualitative finding or a decision not to proceed. |
| Measurement | Named measure, baseline, after value, unit, time windows, population and comparison limitations. |
| Evidence | A checkable artifact, its version, supported sections and an appropriate reviewer. |
| Limits | Other changes, causal uncertainty, project stage and what must not be inferred. |
| Customer fit | The buyer, decision and situation for which this experience is useful. |
| Poor fit | Missing prerequisites, constraints or circumstances that make transfer inappropriate. |

This table is an internal coverage map, not a script to read aloud. A detailed answer may cover several dimensions at once. The voice model should capture those together and avoid asking them again. A source-linked estimate remains an estimate. A detailed account is not automatically true.

### Example: recover the mechanism before the headline

**Consultant:** “We used AI and saved forty percent.”

**ATLAS:** “What exactly does the forty percent measure?”

**Consultant:** “The time spent routing incoming requests.”

**ATLAS:** “What were the before-and-after values for that routing step?”

**Consultant:** “I need to check. I remember it felt faster, but I do not have the baseline.”

**ATLAS:** “We’ll leave the number unconfirmed. What did you personally change in the routing process?”

The system has learned something valuable without coercing a number: the claimed measurement is unresolved, while the consultant’s intervention can still be investigated. After recovering the mechanism it asks who adopted the change, what artifact supports it, and what would make the approach a poor fit for another customer.

## 3. The bounded quality controller

With hosted transcript capture enabled, recognized user turns receive item IDs. `record_details` accepts exact quotes from those user items only; it rejects invented IDs, changed numerical/negative wording and agent speech. Quotes have `reported`, `uncertain` or `unknown` states. Confirmed corrections retire a prior same-field candidate through `supersedes`; the historical candidate is retained in the session ledger.

`inspect_gaps` reads the ledger. `plan_probe` chooses one next question and tracks the clarification budget. A repeated call within the same user turn does not consume another attempt. After two unresolved plans for a field, that field is deferred rather than marked complete. A plan is explicitly recorded as planned, not as proof that the model actually spoke it.

A numerical outcome prioritizes its missing comparison basis. Multiple outcome accounts prompt a comparison/correction question; the code does not automatically label them contradictory or average them. Explicit unknowns and confidentiality remain open. Assessment and proof-of-concept outcomes are framed as findings or decisions, not assumed production benefits. The controller can end with a correction invitation while leaving unresolved work visible.

The measurement detector uses conservative wording cues. It does not establish statistical comparability, semantic entailment or causality. The speech recognizer and the model’s field selection can be wrong. Human correction remains part of the product. The voice model has no tool to publish, approve, choose a memory bank or run arbitrary URLs.

The offline wording lab is a transparent local helper, not a simulation of real inference. The live ledger remains empty until actual hosted user-transcript/tool events arrive. PersonaPlex receives the qualitative interview policy but does not use the hosted tool ledger; its captured notes follow the separate Riva route.

## 4. Presence with truthful signals

The embedded orb is a stable three-dimensional particle sculpture rendered with Canvas. Low, middle and high energy bands measured from output PCM affect shape, twist and highlights. A phrase onset after a short silence triggers one bounded directional gesture; tiny within-phrase gaps do not create jitter. The body settles when output becomes silent. A speaking label or a transcript delta without output energy cannot generate a speech gesture.

Listening movement is subtler and tied to microphone energy. Muting input does not suppress the agent’s playback. Ending releases the microphone. Connection failure, tab lifecycle changes and timeouts stop the session rather than silently reconnect. Focus, palette, pause and system reduced-motion remain available. The inline SVG is a first-paint/failure animation, not evidence of inference.

Silent previews are labelled and never create transcripts, memory, sources or approvals. No camera, emotional inference, attention tracking or claim of consciousness is part of this interface.

## 5. Hindsight remembers each person

Use `mysticalsin/hindsight`, inspected at commit `a921929a0e0ea82fb49da1daa0ca3e152e41fcc1`. This kit contains the adapter and deployment guidance, not a deployed copy of that repository.

The server validates the current Entra identity and derives the private bank from tenant/object identity using a stable secret. Neither an email address nor a browser-supplied bank ID is authoritative. Recalled content is bounded and treated as untrusted context. A manager does not automatically inherit another person’s private bank.

Private memory is for interview preferences, resume pointers and user-reviewed unresolved questions. The workbench can prepare a minimal resume note locally without client names or the full transcript. The person inspects it and explicitly saves it. Replacing the fixed `atlas-continuity` document supports correction without stacking obsolete summaries. Reading and forgetting that document are explicit operations. Older separately stored preferences and other provider records are outside that delete action; the UI says so.

Memory must not become customer evidence. The assistant confirms a prior pointer against current authorized records and the consultant’s account. The kit does not silently upload whole conversations to Hindsight. An unavailable memory service is reported; the agent continues without pretending to remember.

## 6. The Markdown-first knowledge layer

Each saved story creates a new immutable `.md` revision. Its frontmatter includes identity, revision, stage, kind, audience, tags and recorded time. Eight narrative sections preserve challenge, contribution, approach, outcome, evidence, limitations, customer fit and poor fit. Versioned source excerpts are embedded in separately fenced blocks.

The private vault layout is:

```text
data/wiki/
  registry.sqlite3
  <owner-subject-key>/
    <story-id>/
      r1-<content-hash>.md
      r2-<content-hash>.md
```

The registry owns access, review decisions, withdrawal, expiry and audit events. Markdown is the narrative artifact; edited frontmatter cannot approve itself. Each read checks the stored content hash. Save uses an expected-hash check, writes a new immutable revision and does not inherit previous approval. Back up the files and registry together. This single-process pilot is not a claim of horizontally scalable or disaster-tested storage.

A structural lint identifies unresolved placeholder sections and missing source links. It is not a model quality score. Such gaps block factual approval until the account is clarified or reformulated honestly. Distinct authenticated reviewers handle facts (`ATLAS.Review`) and external permission (`ATLAS.Publish`). An author cannot self-approve; reviewers must already have access. Local browser checkboxes remain local only.

An authorized export creates `index.md`, story pages, topic pages, a relationship graph and a manifest. This is the modest LLM-wiki pattern: durable Markdown, explicit source conventions, derived indexes, and disciplined maintenance. It is not a second unrestricted personal-memory store.

The native graph links stories to topics and versioned evidence. Its links are explicit record relationships, not causal claims. Optional Graphify runs consume an authorized exported snapshot—not the entire vault, registry or private Hindsight banks. Keep Graphify’s inferred relationships distinct from source-extracted links. A snapshot can become stale after withdrawal; recheck the live registry before reuse. Native Graphify execution is not performed by this package.

## 7. A source-grounded editorial pass

Template assembly remains available without an API. The optional editor uses one configured structured-output text model to improve a saved candidate for an explicit customer decision. It receives only that version’s narrative accounts and source excerpts. It cannot browse, load private memory, save or approve.

Every proposed paragraph identifies known references appropriate to its section. The validator checks schema, section coverage, bounded lengths, reference existence and numerical-token provenance. A numerical headline is rejected. The original limitations are preserved verbatim when not already present. Provenance markers travel into the candidate text.

These are useful checks, not a hallucination-proofing guarantee: a model can misinterpret a supported number, overstate causality without adding a number, or paraphrase a source incorrectly. Every returned candidate requires semantic, factual, anonymity and audience review. No received suggestion overwrites an unsaved edit. The server rechecks current access and the story hash after the asynchronous call. The user explicitly applies the suggestion to the editor and separately saves the next restricted revision.

Configure `STORY_EDITOR_MODEL` to an approved model that supports the structured-output schema. This is separate from a realtime speech model. No model identifier, quota or provider acceptance is invented if that setting is empty.

## 8. JEV answers “best for this customer?”

The TypeSafe JEV adapter evaluates eligible customer-anonymized variants against four mandatory brief fields: customer problem, buyer/decision, constraints/prerequisites, and desired outcome. It does not rank consultants, certify facts or confer disclosure permission.

A small deterministic lexical shortlist first selects up to twelve already-authorized eligible records. It considers the challenge, mechanism, fit, outcome, tags and title rather than simply taking the most recently uploaded files. This can miss synonyms and cross-domain analogies; an explicit authorized ID shortlist is supported by the API. An empty lexical shortlist is reported, not disguised as a semantic search result.

Proposed pilot weights are problem fit 30%, transferability 25%, evidence 20%, decision usefulness 15%, and dated-source freshness 10%. JEV supplies four typed semantic scores with validated probability distributions. Code computes the date proxy from ISO dates in source-version labels, not upload time. Missing, invalid or future-dated labels remain unresolved. Currency is a proxy, not a claim that old experience is useless or newer work is better.

The composite is a relevance estimate, never expected ROI or probability of customer success. Low model confidence or unresolved freshness produces `review-first`. Weak problem/transfer fit produces `poor-contextual-fit`. The response may contain no strong match and no recommended IDs. Display limitations and poor-fit text next to the result. The model does not produce freeform rationale in this adapter; the UI explains the rubric and shows the original caveats.

Access, exact revision, audience and current eligibility are checked before each outbound call and again before returning results. The client explicitly authorizes external processing. Scores are not persisted as everlasting truth. A later edit, withdrawal, expiry or revoked access invalidates reuse. The weights and thresholds must be calibrated on human-labelled customer/story pairs before broad use.

## 9. Evaluate quality, not just a working transport

Local unit, route, browser and rendering tests establish that selected software contracts work with synthetic inputs. They do not establish a good spoken interview. Run a separately authorized live pilot against the chosen provider and account.

Use paired reviews by a delivery expert and a customer-facing reviewer. Include vague claims, strong qualitative work, failed pilots, conflicting cohorts, withheld details, heavy accents, interruptions, long pauses and projects that should not be reused externally. Judge the retained meaning, not just word error rate.

Proposed release gates, not achieved metrics: every introduced numerical claim must be detected/rejected or corrected before review; no tested cross-user memory or story access; no approval carried to a changed revision; no automatic publication; a complete microphone-stop test; and a verified no-match path. Score interview specificity, individual attribution, mechanism recovery, unnecessary repetition, respect for unknowns, source traceability and relevance to the buyer separately. Compare time-to-reviewable record and reviewer correction burden with the current manual interview process. Do not call voice quality proven because a codec test passed.

## 10. Deliberate first-release limits

One active voice interview per gateway in the provided pilot; one process owns the wiki registry. No cross-region replica protocol, agent swarm, graph database, general autonomous crawler or universal voice-provider router. Entra, provider endpoints and the Hindsight fork require real deployment, credentials, permissions and operational review. Local browser authoring is not a secure shared project database. Neither screenshots nor animation imply a live model connection.

Move beyond these limits only after observing a requirement: concurrent interview demand, missed retrieval cases, measured queue latency or a need for central collaboration. Protect the quality contract while replacing internal components; do not trade concrete evidence for more apparent sophistication.

## Source record

API and repository references inspected on 26 September 2026. They describe external capabilities, not deployment success for this kit.

- Hindsight fork: https://github.com/mysticalsin/hindsight/tree/a921929a0e0ea82fb49da1daa0ca3e152e41fcc1
- Hindsight retain and documents: https://hindsight.vectorize.io/developer/api/retain and https://hindsight.vectorize.io/developer/api/documents
- Hosted voice: https://developers.openai.com/api/docs/models/gpt-realtime-2.1 and https://developers.openai.com/api/docs/guides/realtime-conversations
- Structured editorial output: https://developers.openai.com/api/docs/guides/structured-outputs
- NVIDIA: https://github.com/NVIDIA/personaplex
- JEV API: https://docs.typesafe.ai/api
- Graphify source: https://github.com/mysticalsin/graphify/tree/v8
- LLM Wiki pattern: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Entra claim validation: https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation
