# Primary sources inspected — 25 September 2026

Implementation references, not evidence that any provider was deployed in this session.

- NVIDIA PersonaPlex repository: https://github.com/NVIDIA/personaplex
- Audited stock binary protocol and server behavior: https://raw.githubusercontent.com/NVIDIA/personaplex/main/moshi/moshi/server.py
  `/api/chat`; query text_prompt/voice_prompt; binary 0x00 readiness, 0x01 Ogg/Opus, 0x02 agent text. Shared prompt state means one dedicated active interview. Stock `--host` was not supplied to `web.run_app`; full text_prompt was logged. The private launcher checks exact reviewed snippets before applying runtime-only protections. A configured seed is intentionally not sent because the audited implementation indexed request rather than query for that field.
- Official model card: https://huggingface.co/nvidia/personaplex-7b-v1
  Full-duplex English audio model; Linux/NVIDIA GPU; audio input/output 24kHz. The model card is not a browser implementation or performance guarantee.
- Opus stream library used by the stock server: https://github.com/kyutai-labs/sphn
  Ogg/Opus streaming. ATLAS uses gateway FFmpeg encoding/decoding to avoid frontend codec/WASM dependencies. Actual interoperability with the target GPU build still needs a live test.
- Riva Python ASR implementation: https://raw.githubusercontent.com/nvidia-riva/python-clients/main/riva/client/asr.py
  RecognitionConfig, RecognizeRequest and RivaSpeechRecognitionStub. The gateway adds a per-request deadline and bounded input chunks.
- Riva authentication: https://raw.githubusercontent.com/nvidia-riva/python-clients/main/riva/client/auth.py
- Hindsight recall: https://hindsight.vectorize.io/developer/api/recall
- Hindsight retain: https://hindsight.vectorize.io/developer/api/retain
- Hindsight current async Python implementation: https://raw.githubusercontent.com/vectorize-io/hindsight/main/hindsight-clients/python/hindsight_client/hindsight_client.py
  Hindsight(base_url, api_key, timeout, max_attempts), arecall, aretain, aclose. max_tokens budgets text, not the full response, so ATLAS separately caps preference text.
- MSAL auth-code flow: https://learn.microsoft.com/en-us/entra/msal/python/getting-started/acquiring-tokens
- Entra claims validation: https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation

Mantu logo source: original asset from the supplied ATLAS Working package; SHA-256 92c5ff21779f09199097a2971c172453017f0d2581a0ced6f54fe486ba9b6c2b. Palette retained from the supplied Mantu handoff. No font assets redistributed.


## Orb edition references, checked in this turn
- Requested visual source: https://github.com/mysticalsin/tonys-jarvis.git — GitHub connector returned 404 for contents and metadata; no exact-source match claimed.
- Associated particle reference: https://github.com/mysticalsin/jarvis2.0/blob/main/frontend/src/orb.ts — inspected to understand the requested particle-cloud visual; no source bundled.
- Reference license: https://github.com/mysticalsin/jarvis2.0/blob/main/LICENSE — restrictive noncommercial license, not copied into Mantu. Exact license blob: 639e39cf79e75d508be8e33db2aa6dc281886569.
- NVIDIA voice preset table: https://github.com/NVIDIA/personaplex — NATM1 is one of the documented natural male presets; this replaces the prior package default, not a claimed actor voice.

New visuals are original code. Test screenshots exercise the Canvas2D fallback without any active provider. Existing source-protocol assertions above originate in the inherited gateway audit, not a new production deployment validation.


## v7 implementation checks · 25 September 2026

- NVIDIA primary repository: https://github.com/NVIDIA/personaplex — server operation and voice presets, not proof that this package was deployed.
- Browser microphone requirements: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- Audio context resume behavior: https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/resume

Mantu logo comes from the previously supplied brand package. Original SHA-256: `92c5ff21779f09199097a2971c172453017f0d2581a0ced6f54fe486ba9b6c2b`. No font files are shipped.

## v10 references rechecked on 25 September 2026
- NVIDIA PersonaPlex official repository: https://github.com/NVIDIA/personaplex
- NVIDIA model card and access conditions: https://huggingface.co/nvidia/personaplex-7b-v1
- Official worker protocol implementation: https://raw.githubusercontent.com/NVIDIA/personaplex/main/moshi/moshi/server.py
- Browser audio-worklet processing: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet
- Microsoft identity claim validation: https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation
- Hindsight recall contract: https://hindsight.vectorize.io/developer/api/recall

These are sources for integration behavior, not evidence that the services were deployed or validated here. The new low/mid/high visualization is application-side output-signal analysis, not a feature claim made by NVIDIA. The generated design reference is not a picture of a connected production app.


## v11 integration references
Current references and exact inspected Hindsight fork commit are in `SOURCE_LOCK.json` and `PRD_v11.md`. Older sections above document inherited components and are not current provider recommendations.
