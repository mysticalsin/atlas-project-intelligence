# ATLAS Kyutai voice route — setup
Selected 2026-09-26 as the **primary low-cost, high-concurrency route** (see `handoff/SCALE_PLAN.md` §3b).

```
browser mic ─PCM16 24k─▶ ATLAS gateway ─float32/msgpack─▶ Kyutai STT (GPU)  ─words + pause─▶ turn
                               │                                                         │
                               ├─▶ conversation LLM (streaming, no tools) ◀─ ANALYST_GUIDANCE
                               │        └─text─▶ Kyutai TTS (GPU) ─PCM─▶ gateway ─paced PCM─▶ browser (orb reacts)
                               └─▶ analyst LLM (record_details only) ─▶ InterviewLedger ─▶ quality events + guidance
```
- **Code:** `atlas_voice/cascade.py` (route), `kyutai.py` (STT/TTS protocol, turn detection, streaming chat), `analyst.py` (evidence).
- **Concurrency:** set `ATLAS_MAX_INTERVIEWS` above 1. Kyutai reports 64 STT connections (batch 64) and 32 TTS users (~350 ms) on one L40S. These are Kyutai's own figures; measure your own before sizing.
- **Turn-taking:** Kyutai STT pause prediction (`prs[2] > 0.6` after 12 warm-up steps, as Unmute does). Consultant speech during playback interrupts ATLAS and clears queued audio. **Use headphones:** speaker echo can be transcribed and trigger an interruption.
- **Not full duplex:** no back-channelling while the consultant speaks. PersonaPlex remains the full-duplex option (one conversation per GPU process today).

## 1. GPU host (rented, Linux, NVIDIA; L40S 48 GB recommended by Kyutai)
Follow Kyutai's own instructions in https://github.com/kyutai-labs/delayed-streams-modeling (Rust `moshi-server`). Review the source first, and record the exact commits you deploy.
```sh
cargo install --features cuda moshi-server
moshi-server worker --config configs/config-stt-en-hf.toml      # streaming STT (English)
moshi-server worker --config configs/config-tts.toml            # streaming TTS (Kyutai suggests Unmute's start_tts.sh for its Python deps)
```
- Bind both to loopback or a private network. Set an API key in the server config; ATLAS sends it as `kyutai-api-key`. Never expose these ports publicly. If the gateway runs elsewhere, use TLS (`wss://`); `Config` rejects plain `ws://` off loopback.
- Kyutai's STT/TTS model licences and weights come from Hugging Face. Accept and record them.

## 2. Voice (licence matters)
`KYUTAI_VOICE` is a path in the `kyutai/tts-voices` repository. Use a **commercially usable** set: `voice-donations/` (CC0), `voice-zero/` (CC0), `vctk/` (CC BY 4.0), `alba-mackenna/` (CC BY 4.0). ATLAS refuses `expresso/` and `ears/` (CC BY-NC 4.0). Check `unmute-prod-website/` file by file: it is mixed. Brand/voice approval stays with the brand owner.

## 3. Conversation and analyst LLMs
Both are OpenAI-compatible chat-completions endpoints. They can be the same service.

| Variable | Use |
|---|---|
| `CONVERSATION_CHAT_URL`, `CONVERSATION_MODEL`, `CONVERSATION_API_KEY` | Streaming talker. A **fast, non-reasoning** model, because time to first token is the voice latency. Selected: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (see `handoff/verification/workers-ai-2026-09-26/RESULTS.md`). |
| `ANALYST_CHAT_URL`, `ANALYST_MODEL`, `ANALYST_API_KEY` | Evidence analyst with tool calling (`record_details`). Runs beside the conversation, so its latency does not delay speech. Selected: `@cf/openai/gpt-oss-120b` (exact quotes 3/3, injection ignored). Avoid `gpt-oss-20b`: it returns JSON text instead of tool calls. |

Workers AI OpenAI-compatible URL: `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1/chat/completions`.

## 4. Gateway `.env`
```sh
ATLAS_VOICE_PROVIDER=kyutai
KYUTAI_STT_URL=wss://<private-stt-host>
KYUTAI_TTS_URL=wss://<private-tts-host>
KYUTAI_API_KEY=
KYUTAI_VOICE=<commercially licensed voice path>
CONVERSATION_CHAT_URL=...
CONVERSATION_MODEL=...
ANALYST_CHAT_URL=...
ANALYST_MODEL=...
ATLAS_MAX_INTERVIEWS=20
```
Check with `python scripts/doctor.py --profile kyutai --env-file .env` (offline only). Then follow `deploy/cloudflare/README.md`.

## 5. One-command bake-off on RunPod (operator's Mac)
Prerequisites: prepaid RunPod credit (the spending cap), `~/.config/atlas/runpod.key`, `~/.config/atlas/workers-ai.key`.
```sh
bash scripts/runpod_bakeoff.sh plan     # inspect the pod request: 1x L40S, SECURE cloud, only 22/tcp exposed
bash scripts/runpod_bakeoff.sh up       # create pod, build moshi-server 0.6.4, start STT/TTS + ATLAS on loopback, run load test
bash scripts/runpod_bakeoff.sh tunnel   # then open http://localhost:8080 and hold a real interview (headphones)
bash scripts/runpod_bakeoff.sh down     # delete the pod: billing stops
```
`scripts/pod_setup.sh` follows Unmute's dockerless scripts. It replaces the demo `public_token` with a random key and raises batch sizes to STT 64 / TTS 32 (Unmute ships 1 / 2). Results land in `handoff/verification/runpod-<date>/`. Afterwards, delete the `atlas-bakeoff` API key in RunPod.

## 6. Acceptance (not yet executed)
Run V01–V05 from `handoff/ACCEPTANCE.md` on this route, plus these:
- **Latency:** time from the end of consultant speech to the first audible ATLAS audio.
- **Barge-in:** with and without headphones.
- **Concurrency:** `python scripts/load_kyutai.py --stt wss://… --tts wss://… --voice <voice> --sessions 10 20 40` runs synthetic STT and TTS streams together and reports real-time ratio, first-audio latency and a verdict per level. Size `ATLAS_MAX_INTERVIEWS` from the highest level that kept up.
- **Voice quality:** blind human rating against hosted Realtime and PersonaPlex.

Local fixture tests (`tests/test_cascade.py`) prove the protocol and the evidence path only. They do not prove voice quality.
