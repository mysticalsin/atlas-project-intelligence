# Plan A live test: privacy check

**Scope:** the owner-approved, local-only live test of Plan A. It runs under `wrangler dev` with a local spend ledger and the remote Workers AI binding. The test, its caps and its bound are described in `docs/LIVE_TEST_BOUND.md`.

**Result:** no unresolved personal-data issue. No personal data enters the test, so no data-protection basis or notice is needed for it. Open provider questions are listed below as unknowns; none of them involves personal data in this test.

## Test material: synthetic only

- **Speech.** Scripted, fictional answers about a fictional project ("Harbour Lane claims pilot (synthetic)") are written in `live-test/run.mjs`. They are voiced by Workers AI speech synthesis (`@cf/deepgram/aura-2-en`, voice `arcas`), which is a synthetic voice and not a recording or clone of any real person. That synthesis is itself metered by the ledger.
- **No microphone, and no real person's voice, name, employer, customer or personal data.** The project fields and answers contain no real company or person.
- **The agent's side** is the normal edge `Session` with `capture: false`. There is no analyst, no report, no memory, no library, no Hindsight and no identity. The only identity in play is the local harness's fixed `csrf: 'local'`.
- **No production data or users.** The Worker is not deployed, has no routes, and answers only on localhost with `LIVE_TEST_LOCAL=1` passed on the dev command line. It does not touch the production Durable Objects, library, Access or Entra.

## Provider processing (Cloudflare Workers AI)

Sources were read on 2026-11-09:
- Data usage: <https://developers.cloudflare.com/workers-ai/platform/privacy/>, which redirects to the Workers AI data-usage page, last updated 2026-10-16.
- Model page: <https://developers.cloudflare.com/workers-ai/models/nova-3/>.

Stated by Cloudflare:
- Inputs and outputs are treated as Customer Content.
- Standard inference has zero data retention. Content is stored only if you use storage features or logs, and the test uses neither: no AI Gateway logging and no Workers Logs from a deployed Worker.
- Cloudflare does not train on customer content.
- Operational metadata (for example sizes and token counts) is retained.
- Third-party model licence terms may apply to partner models.
- The Nova-3 model page lists the model as Cloudflare-hosted, Partner, and zero data retention "Yes".

The test sends synthetic audio (to Nova-3 and smart-turn-v2), synthetic text (to the llama-3.3-70b talker) and synthetic text to be voiced (to aura-2).

**Unknowns, not assumed:**
- **Data residency.** No statement was found on which region or data centre processes a Workers AI request. Synthetic test material makes this immaterial for this test, but it is not resolved for real use.
- **Deepgram's Model Improvement Program.** The Nova-3 schema exposes `mip_opt_out`, which this code does not set. It is not stated whether that program applies to Cloudflare-hosted inference. This is immaterial here because the audio is synthetic, but it must be resolved before any real consultant audio.
- **Partner licence terms.** The text of the Deepgram and Pipecat terms linked from the model pages was not reviewed for this test.

## Retention in this test

- **Local only.** The driver writes timings, counts and ledger figures to the local output file, with no audio and no transcript text. The Durable Object state holds counts only. `wrangler dev` logs stay on this VM.
- **Raw audio** (the synthetic speech, the agent's synthesized replies and the cached acknowledgements) lives only in the dev process's memory. It is never written to disk and is gone when the process stops. A run must stop the dev process and delete its `--persist-to` directory afterwards. That directory holds counts only, but it is deleted anyway.
- **Nothing is uploaded or shared** beyond the Workers AI requests themselves.

## What would change this result

Any real speech, a real microphone, real project content, a deployed Worker, routes, AI Gateway logging, or ElevenLabs. Each of these needs its own privacy review and owner approval first. None of them is possible in this test path as built.
