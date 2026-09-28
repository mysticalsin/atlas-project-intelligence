# Scale and cost plan — 12,000 consultants
**Requirement (Tony, 2026-09-26):** a platform where Mantu's 12,000 consultants record project and success-story interviews every 3–6 months. Many people may use it at the same time. Cost control is a primary goal.

Every figure below is an **assumption or a secondary-source estimate** until it is measured. Replace them with real data after the first campaign.

## 1. Expected load
| Quantity | Low | High | Basis |
|---|---|---|---|
| Interviews per person per year | 2 | 4 | every 6 / every 3 months |
| Interviews per month | 2,000 | 4,000 | 12,000 × cadence ÷ 12 |
| Talk time per interview | 15 min | 15 min | `ATLAS_MAX_SECONDS=900` cap, taken as the upper bound |
| Voice hours per month | 500 h | 1,000 h | |
| Business hours per month (one region) | ~200 h | ~200 h | 22 days × 9 h; multiple time zones spread load further |
| **Average simultaneous interviews** | **~2.5** | **~5** | voice hours ÷ business hours |
| **Busy-hour peak** (≈3× average) | ~8 | ~15 | assumption |
| **Deadline-day spike** (≈5–10× average) | ~12–25 | ~25–50 | only if a campaign has one hard deadline |

The "50 at once" case is real only when a campaign funnels everyone into the same days. Scheduling (§4) is the cheapest lever on peak cost, whichever voice provider is used.

## 2. Cost per route (monthly, voice only)
| Route | Concurrency model | Monthly cost at 2,000–4,000 interviews | Interview quality |
|---|---|---|---|
| **A. Hosted `gpt-realtime-2.1-mini`** | Pay per use; scales automatically | **~$400–2,800** (≈$0.20–0.70 per interview) | Full ATLAS ledger: live transcript, quote-based tools, probe planner |
| A′. Hosted `gpt-realtime-2.1` | Pay per use | ~$1,000–8,000 (≈$0.50–2 per interview) | Same ledger; stronger reasoning |
| B. PersonaPlex, stock NVIDIA server | **1 interview per GPU** | 15–25 peak GPUs × ~$730 ≈ **$11k–18k** | No tool calling; notes only after the session via Riva |
| C. PersonaPlex, batched serving (experimental vLLM-Omni / pega-omni work reports ~32 sessions per data-centre GPU) | Many per GPU | 1–2 large GPUs: ~$1,200–4,400 around the clock, or ~$600–1,800 in business hours only | Same gaps as B, **plus** Riva transcription and a notes LLM (extra services) |

| C′. PersonaPlex, several **stock** worker processes on one large GPU (behind one gateway worker pool) | ~2–5 per GPU (**unmeasured**; the 7B model is ~14 GB bf16, but each session must produce a frame every 80 ms) | L40S 48 GB ≈ $1,100/month 24/7 per card | Same gaps as B; needs a gateway worker pool (small change) |
| **D. Cascaded pipeline on Cloudflare**: Workers AI `nova-3` speech-to-text → `gpt-oss-120b` (text LLM **with function calling**) → Fish Audio or Workers AI `aura` text-to-speech | Pay per use; Cloudflare/Fish scale it | **≈$0.25–0.40 per interview → ~$500–1,600/month** (estimate: STT ~$0.09, LLM ~$0.10–0.20, Fish TTS ~$0.06) | Keeps the quote-based tool ledger (the LLM works in text). Turn-taking is less natural than full duplex (sequential STT→LLM→TTS adds latency; barge-in is handled by the pipeline) |

Fish Audio is a speech component (TTS $15 per M characters, ASR $0.006 per minute, API concurrency 5/15/50 by prepaid tier), not a conversation model. It fits route D as the voice and route C as the cheap post-session transcript in place of Riva. Cloudflare cannot host PersonaPlex self-serve today (bring-your-own-model on Workers AI is limited to design partners). A GPU host for C sits **behind the existing Cloudflare Tunnel** instead.

Route C's fixed GPU bill is not the whole cost. It also needs the transcription service, engineering to adopt an experimental batched server, GPU operations/on-call, and redundancy (one GPU is a single point of failure for 12,000 users). At this volume **C is roughly equal to A, not clearly cheaper**, and it weakens the interview, which is the product's core value.

**Break-even rule:** self-hosting wins only when the all-in fixed monthly cost of C (GPUs + transcription + operations) falls below the *measured* hosted bill. On these assumptions that means well above ~4,000 interviews a month on mini, or running the full model at this volume.

## 3. Decision (revised 2026-09-26 after Tony's input)
Run a **measured bake-off** before committing. Every candidate uses the same `docs/EVALUATION_v12.md` scenarios, blind review by a delivery reviewer, and the same cost model:
- **A** hosted mini (already built)
- **C′/C** PersonaPlex: how many simultaneous interviews one rented GPU really sustains in real time, with stock processes and then batched
- **D** Cloudflare Workers AI + Fish Audio cascade (new provider route in the existing gateway; no stack rewrite)

Pick the lowest cost per interview at the measured peak **that passes the quality bar**. Quality includes live challenge of vague claims, individual contribution and preserved unknowns.

### Previous decision (superseded)
1. **Pilot and first campaign on route A (hosted mini)**, with bounded concurrency. Implemented: `ATLAS_MAX_INTERVIEWS`, one interview per user, PersonaPlex held at 1.
2. **Measure** real interviews per month, talk minutes, peak simultaneous sessions and the actual OpenAI bill.
3. **Run a PersonaPlex bake-off in parallel**, at a few dollars of hourly GPU rental: the `docs/EVALUATION_v12.md` scenarios on PersonaPlex vs mini vs full, blind-reviewed by a delivery reviewer. Also measure batched sessions per GPU on the target card.
4. **Switch to C only if all three hold:** its measured all-in cost is below the hosted bill; its interview quality is acceptable against the scenarios; and the batched server is stable under a load test. Otherwise stay hosted and tune (mini vs full, session length).

## 3b. Target architecture: two brains ("voice + analyst") — proposed 2026-09-26
Goal (Tony): PersonaPlex-level naturalness **and** the full live evidence ledger, at 12,000-user scale with controlled cost.

```
consultant mic ──┬──▶ VOICE brain: PersonaPlex full duplex (speaks, listens, backchannels, handles interruption)
                 │          ▲ guidance injected into its inner-monologue text stream at turn boundaries
                 └──▶ ANALYST brain: streaming ASR → existing InterviewLedger (quality.py) + text LLM with tools
                            (exact-quote provenance, 12 dimensions, gaps, next best probe; cannot publish/approve)
```
- **Evidence for the pattern:** a community PersonaPlex fork (`abhinavpgagi/personaplex-tool-calling`, Apache-2.0/MIT) teacher-forces external results into the inner monologue one token per 80 ms frame. The voice and prosody stay PersonaPlex's own. It is a prototype: ~19 GB VRAM, one conversation per process, OpenAI transcription. The arXiv paper 2609.19334 (frontend-backend tool calls for full-duplex models, preprint) reports 92–97% tool-call recall while keeping duplex turn-taking. Neither is production-proven.
- **Analyst layer is reusable:** it can drive any voice layer. If PersonaPlex steering or its cost disappoints, swap in the fallback below without redoing the evidence work.
- **Fallback voice layer: Kyutai Unmute** (open source; streaming STT + any text LLM + streaming TTS, semantic turn detection). Kyutai reports an L40S serving 64 STT streams and 32 TTS users (~350 ms). This is the high-concurrency, fixed-cost option with a natural (not full-duplex) feel.
- **Cost risk:** the injection fork is one conversation per process. At a peak of 15–25 that means about 8–13 L40S cards (~$9k–14k/month around the clock). It only becomes cheap if batched PersonaPlex serving can also accept injected tokens, which is new engineering. Run GPUs in business hours only and stagger campaigns to cut this.

### Finding that changed the primary route (2026-09-26)
The fork's own README says the injection server is **one conversation per process** and that "multi-worker concurrency on a shared GPU was tested and collapsed". PersonaPlex + injection would therefore cost one GPU per simultaneous interview. For Tony's goal (lowest cost, high voice quality, many simultaneous users), the **Kyutai route is now primary**: Kyutai STT/TTS batched on one GPU, a conversation LLM, and the analyst. It is implemented in `atlas_voice/cascade.py`. PersonaPlex stays the full-duplex option to re-evaluate if batched serving with injection matures.

### Build order
1. **[DONE, local fixtures — 2026-09-26]** **Analyst layer** (`atlas_voice/analyst.py`, `tests/test_analyst.py`) in the existing gateway, provider-independent: streaming-ASR transcript events → InterviewLedger → text-LLM tool calls → `next_probe` guidance. Fixture-tested locally, no keys needed.
2. **[DONE, local fixtures]** Kyutai route `cascade.py` + `kyutai.py` (STT/TTS protocol, pause-based turns, barge-in, streaming talker, analyst guidance, notes). **Next:** voice bake-off on one hourly-rented GPU: (a) PersonaPlex + injection, (b) Unmute, (c) hosted `gpt-realtime-2.1` as the reference. Measure blind "felt human" ratings from test consultants, evidence completeness on the `EVALUATION_v12.md` scenarios, latency/interruption, and real concurrent sessions per GPU.
3. Choose by quality first, then cost per interview at measured peak.

## 4. Cost controls to build regardless of provider
- **Staggered campaigns:** invite consultants in waves by business unit/country, over 2–4 weeks rather than one deadline. This cuts the peak 3–5× for free.
- **Concurrency cap:** `ATLAS_MAX_INTERVIEWS` (start at 20). Beyond the cap, users see "All interview slots are in use. Try again shortly." Worst-case hosted spend per hour = slots × hourly per-session cost.
- **Provider budget limit:** set a monthly budget/alert in the OpenAI project (operator action).
- **Session length:** keep the 15-minute cap; review the median length after the first campaign.
- **Model choice:** mini by default; the full model only if the bake-off shows a material quality gain.

## 5. Gateway work items for many users (ordered)
1. **Done (local, tests pass except bind-dependent):** bounded concurrent interviews with a per-user limit (`atlas_voice/capacity.py`, `tests/test_capacity.py`).
2. **Next:** `identity.py` caps signed-in sessions at 500 per process (1-hour sessions). At campaign peaks more than 500 people can sign in within an hour, and new sign-ins would then get HTTP 503. Make it configurable and size it from measured logins.
3. **Load test** one gateway process with 20–50 synthetic concurrent hosted streams (CPU, memory, event-loop latency, Cloudflare Tunnel throughput). Only move to multiple processes/hosts if this test shows a limit. Multi-process needs a shared session store and a vault-writer strategy (SQLite is single-writer).
4. **UI:** show a clear "slots full, try again" state and let a user book or retry, rather than a generic error.
5. **PersonaPlex batched serving** (only if §3 step 4 passes): replace the stock worker, lift the `max_interviews == 1` rule for that provider, and add the same concurrency tests.

## Sources for the estimates
huggingface.co/abhinavpgagi/personaplex-tool-calling; arxiv.org/abs/2609.19334; github.com/kyutai-labs/unmute; kyutai.org/stt, kyutai.org/tts.
Cloudflare voice agents and Workers AI pricing (developers.cloudflare.com/agents/api-reference/voice, /workers-ai/platform/pricing, /workers-ai/models/nova-3); Fish Audio pricing (docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits).
OpenAI realtime pricing via secondary trackers (verify on https://developers.openai.com/api/docs/pricing); GPU rates from getdeploying.com (A10G, L40S); batched PersonaPlex serving from vllm-project/vllm-omni issue #7389 and pegainfer-project/pega-omni PR #7 (experimental, not NVIDIA's stock server).

## Reference library (2026-09-27)
- Pilot: one `LibraryStore` Durable Object (SQLite) holds references, revisions, audit, invitations and embeddings.
  Reads are in-memory scans with anonymised text; comfortable to roughly 5,000 references.
- Next step when needed: move `refs`/`revisions`/`audit` to D1 and embeddings to Vectorize (same `Library` API; the
  SQL adapter already abstracts storage), run reviews through Queues, and shard invitations by country.
- Alternative: implement the same `atlas.reference.v1` contract on Mantu Azure (Azure SQL + AI Search) if IT requires
  the master copy in the Mantu tenant or next to Spotlight Ref. See `docs/SOLUTION.md` §5.
