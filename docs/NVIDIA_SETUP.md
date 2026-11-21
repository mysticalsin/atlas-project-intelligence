# ATLAS Animated Orb · Mantu — NVIDIA voice setup

**Once the GPU service is running: open the browser, press Start, and speak with the NVIDIA model.**

This package replaces browser dictation/read-aloud with an actual PersonaPlex WebSocket integration. It contains a self-contained Mantu HTML interface and a small Python application gateway. It does **not** contain model weights, a GPU, service credentials, or a deployed endpoint. Opening the standalone HTML shows the interface; it cannot run NVIDIA inference by itself.

The Studio v7 interface uses NVIDIA `NATM1.pt` by default, unless the server environment overrides it. The standalone animation is not evidence that inference is running. See the root README and `tests/RESULTS.json` for current verification.

## Fastest route when PersonaPlex is already running

Run the gateway **on the approved server**, not as a heavy installation on the Mac. Python 3.11+ and FFmpeg with libopus must be installed there.

```bash
cd ATLAS_Intelligence
python3 -m venv .venv-gateway
source .venv-gateway/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
# Edit PERSONAPLEX_WS_URL to the actual private worker endpoint.
# Defaults assume the worker is on this same server, port 8998.
bash scripts/start_gateway.sh
```

Use `http://localhost:8080` on the server, or create an SSH tunnel from your Mac:

```bash
ssh -N -L 8080:127.0.0.1:8080 USER@YOUR_GPU_SERVER
```

Then open **http://localhost:8080** in your Mac browser. Those capitalized values are placeholders for your actual SSH account/server. No model download or Python environment is required on the Mac. The gateway binds loopback by default; do not publicly expose local mode. Use exactly the configured origin (`localhost`, not a different hostname), because Origin and Host checks are deliberate.

Create the project, choose **Start voice interview**, consent, and allow the microphone. NVIDIA must send the model-ready handshake before audio is streamed. You should then hear the model lead the conversation. Use headphones. Mute silences your input but lets the model speak. End closes the microphone immediately. Switching pages, opening other workflows, backgrounding the tab or losing the connection stops the session; it does not silently reconnect.

## When the GPU worker is not installed yet

On an approved Linux NVIDIA GPU server, follow the official model/repository prerequisites and accept the model's Hugging Face terms under the authorized account. Review the repository before installation. Keep model and gateway virtualenvs separate because the official model has its own Torch/aiohttp dependencies. Example server-side setup:

```bash
# Use Python 3.11 and an appropriate NVIDIA/CUDA environment for the model.
python3.11 -m venv .venv-personaplex
source .venv-personaplex/bin/activate
git clone https://github.com/NVIDIA/personaplex.git
# Review the checked-out source; record the exact commit you deploy.
git -C personaplex rev-parse HEAD
python -m pip install ./personaplex/moshi
# Supply HF_TOKEN securely in this server environment after accepting terms.
# From the ATLAS_Orb_Studio folder:
python scripts/run_personaplex.py --port 8998 --static none
```

Keep this worker running and start the gateway in another terminal using `.venv-gateway`. The supplied launcher makes two explicit runtime-only changes to the reviewed stock server: it forces loopback binding and removes the full interview-prompt log/access log. It refuses an unexpected source version; it does not modify installed source files. Do not expose the raw GPU worker. Never put HF_TOKEN or provider keys into the HTML. NVIDIA's model card specifies English, Linux and NVIDIA hardware; it does not make this a browser-native model or establish performance on your chosen GPU.

**One worker, one interview.** The stock worker has shared generation state. Use exactly one ATLAS gateway process against this dedicated worker, with no direct clients bypassing the gateway. This is an intentional small-pilot limit, not a scalable production concurrency claim.

## Keep spoken questions separate from consultant notes

PersonaPlex's returned text describes the agent's own speech, not the consultant's input. The interface labels it accordingly and never inserts it as a consultant answer.

To generate notes after the conversation, configure the optional **NVIDIA Riva speech-recognition service** in `.env` (`RIVA_URI`, TLS and any API metadata required by your deployment). Install the client with `make install-integrations`. This is a separate service endpoint, not a browser recognizer. Enable capture consent at the start. The gateway buffers only microphone PCM in RAM, transcribes it after End and discards the raw buffer after processing. It does not write audio files. Hosting/provider logs, swap and retention need their own review.

For automatic assignment to six topics, also configure an authorized `NOTES_CHAT_URL`, `NOTES_MODEL` and any key. Only exact microphone-transcript excerpts pass the assignment validator. Without this optional text endpoint, users can organize the returned transcript manually. Without Riva, voice can run but **no consultant transcript or automatic notes are claimed**.

The user checks/corrects the recognized text and explicitly appends selected notes to the unchanged project. Existing independent sources remain separate. Actual results and disclosure require review; the voice model cannot approve stories. Notes/chunk boundaries may contain recognition errors or speaker leakage; headphones and human review are important.

## Entra ID and Hindsight

For shared use, run `make install-integrations`, deploy behind an approved HTTPS reverse proxy, and configure `ATLAS_AUTH=entra`. Register a confidential Entra web app with the exact redirect URI `https://YOUR_ATLAS_HOST/auth/callback`, define/assign the `ATLAS.Interview` app role, and provide tenant/client/secret through server secrets. Keep `ATLAS_BIND=127.0.0.1` when the proxy runs on the same machine. The proxy must preserve Host, support WebSocket upgrades and NOT log sensitive query strings, payloads or cookies. Native sign-in/role assignment must be tested in the actual tenant before use.

Set `HINDSIGHT_URL`, its key and a stable random `HINDSIGHT_BANK_SECRET` (32+ characters). A bank is derived server-side from the validated Entra tenant/object identity. There is no client-supplied bank selector. The Connection & privacy dialog can explicitly save a private preference; the next consented session recalls a bounded relevant preference packet. The application uses current async Hindsight client methods and closes the client. Missing/unavailable memory is visibly reported; it is not faked.

The local workspace selector is still only an organizational tool. In Entra mode, device storage is namespaced per authenticated subject, but it remains unencrypted browser storage—not a secure shared project database. Hindsight preferences are not evidence, and Entra login alone does not turn the local authoring/review workflow into a centrally governed production system. Tenant deployment, current project permissions and authenticated publication approval remain release gates.

## What's included

- `ATLAS_Orb_Studio.html`: one-file browser interface; no CDN, font or provider key.
- `atlas_voice/`: gateway, actual model protocol, FFmpeg codec, identity/memory/notes integrations.
- `src/`: editable frontend and unchanged project/story domain engine.
- `scripts/`: private worker launcher and gateway startup.
- `docs/`: short design/build notes, architecture, primary-source record and acceptance checklist.
- `tests/`: executable transport, audio-worklet, frontend lifecycle and domain tests, with explicit scope.

Rebuild HTML with `python build.py`. Run tests with `python -m pytest tests/test_voice.py`, `node --test tests/engine.test.js tests/worklet.test.js`, and `python tests/studio_browser.py` after installing their test dependencies/Chromium.

## Validation status

Real FFmpeg encoding/decoding and HTTP/WebSocket framing were exercised locally against an **explicit protocol test fixture that emits a test tone, not speech**. Frontend tests use API adapters because this environment's managed Chromium blocks navigation to localhost. Audio-worklet processing and existing domain rules have separate tests. See `tests/RESULTS.json` for precise counts and limitations.

**Not validated here:** actual PersonaPlex GPU inference, speak-first quality, barge-in with a real person, browser-native microphone playback, Riva accuracy, Entra tenant login or live Hindsight retain/recall. A real GPU endpoint was not provided. Do not call this deployed or production-ready based on transport tests.

The original Mantu SVG is preserved byte-for-byte; colors use the supplied Mantu palette. No font files are included. Final brand approval remains with the brand owner.
