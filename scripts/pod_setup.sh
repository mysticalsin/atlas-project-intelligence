#!/usr/bin/env bash
# Runs ON the rented GPU pod (Ubuntu + CUDA devel image), started by scripts/runpod_bakeoff.sh.
# Follows kyutai-labs/unmute dockerless/start_{stt,tts}.sh: one moshi-server build, then STT and
# TTS workers on loopback only. Batch sizes are raised for the concurrency test.
# Nothing listens publicly: the operator reaches the gateway through an SSH tunnel.
set -euo pipefail
: "${KYUTAI_API_KEY:?}" "${WORKERS_AI_ACCOUNT:?}" "${KYUTAI_VOICE:=vctk/p225_023.wav}"
export KYUTAI_API_KEY KYUTAI_VOICE WORKERS_AI_ACCOUNT
STT_BATCH="${STT_BATCH:-64}"; TTS_BATCH="${TTS_BATCH:-32}"
MOSHI_SERVER_VERSION="0.6.4"   # version pinned by unmute's dockerless scripts
MOSHI_PY_COMMIT="9837ca328d58deef5d7a4fe95a0fb49c902ec0ae"
ATLAS=/opt/atlas; UNMUTE=/opt/unmute; OUT=$ATLAS/bakeoff
mkdir -p "$OUT"; exec > >(tee -a "$OUT/setup.log") 2>&1
step() { printf '\n=== %s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
trap 'echo "=== FAILED at line $LINENO (exit $?)"' ERR

step "system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl wget build-essential pkg-config libssl-dev cmake python3-dev >/dev/null
command -v cargo >/dev/null || { curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null; }
command -v uv >/dev/null || { curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null; }
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | tee "$OUT/gpu.txt"

step "kyutai unmute checkout"
[ -d "$UNMUTE" ] || git clone -q --depth 1 https://github.com/kyutai-labs/unmute "$UNMUTE"
git -C "$UNMUTE" rev-parse HEAD | tee "$OUT/unmute-commit.txt"
cd "$UNMUTE"
for cfg in stt tts; do
  f=services/moshi-server/configs/$cfg.toml
  # Replace the public demo token with this pod's random key.
  sed -i "s/^authorized_ids = .*/authorized_ids = [\"$KYUTAI_API_KEY\"]/" "$f"
done
sed -i "s/^batch_size = .*/batch_size = $STT_BATCH/" services/moshi-server/configs/stt.toml
sed -i "s/^batch_size = .*/batch_size = $TTS_BATCH/" services/moshi-server/configs/tts.toml
grep -h '^batch_size' services/moshi-server/configs/{stt,tts}.toml | tee "$OUT/batch.txt"

step "moshi-server $MOSHI_SERVER_VERSION build (takes 10-25 min)"
cd "$UNMUTE/dockerless"
[ -f pyproject.toml ] || wget -q "https://raw.githubusercontent.com/kyutai-labs/moshi/$MOSHI_PY_COMMIT/rust/moshi-server/pyproject.toml"
[ -f uv.lock ] || wget -q "https://raw.githubusercontent.com/kyutai-labs/moshi/$MOSHI_PY_COMMIT/rust/moshi-server/uv.lock"
uv venv -q; source .venv/bin/activate; cd "$UNMUTE"
export LD_LIBRARY_PATH=$(python -c 'import sysconfig; print(sysconfig.get_config_var("LIBDIR"))')
export CXXFLAGS="-include cstdint"
command -v moshi-server >/dev/null || cargo install -q --features cuda "moshi-server@$MOSHI_SERVER_VERSION"

step "start STT (8090) and TTS (8089) on loopback"
nohup moshi-server worker --config services/moshi-server/configs/stt.toml --addr 127.0.0.1 --port 8090 > "$OUT/stt.log" 2>&1 &
nohup uv run --locked --project ./dockerless moshi-server worker --config services/moshi-server/configs/tts.toml --addr 127.0.0.1 --port 8089 > "$OUT/tts.log" 2>&1 &
deactivate

step "ATLAS gateway environment"
cd "$ATLAS"
uv venv -q .venv && uv pip install -q --python .venv/bin/python -r requirements.txt
WAI="https://api.cloudflare.com/client/v4/accounts/$WORKERS_AI_ACCOUNT/ai/v1/chat/completions"
umask 077
cat > .env <<ENV
ATLAS_VOICE_PROVIDER=kyutai
LEDGER_MODE=off
ATLAS_LEDGER_DEV=1
ATLAS_AUTH=local
ATLAS_BIND=127.0.0.1
ATLAS_PORT=8080
ATLAS_ORIGIN=http://localhost:8080
ATLAS_MAX_INTERVIEWS=4
ATLAS_WIKI_ROOT=/opt/atlas/data/wiki
KYUTAI_STT_URL=ws://127.0.0.1:8090
KYUTAI_TTS_URL=ws://127.0.0.1:8089
KYUTAI_API_KEY=$KYUTAI_API_KEY
KYUTAI_VOICE=$KYUTAI_VOICE
CONVERSATION_CHAT_URL=$WAI
CONVERSATION_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast
CONVERSATION_API_KEY=$(cat "$ATLAS/.workers-ai.key")
ANALYST_CHAT_URL=$WAI
ANALYST_MODEL=@cf/openai/gpt-oss-120b
ANALYST_API_KEY=$(cat "$ATLAS/.workers-ai.key")
ENV
rm -f "$ATLAS/.workers-ai.key"
umask 022
echo '{"atlas_metric":"ledger","mode":"off"}'

step "wait for speech servers (first start downloads models)"
.venv/bin/python - <<'PY'
import asyncio, os, time, aiohttp
from atlas_voice.kyutai import connect_stt, connect_tts
key = os.environ['KYUTAI_API_KEY']; voice = os.environ['KYUTAI_VOICE']
async def ready():
    async with aiohttp.ClientSession() as http:
        for name, make in (('STT', lambda: connect_stt(http, 'ws://127.0.0.1:8090', key)),
                           ('TTS', lambda: connect_tts(http, 'ws://127.0.0.1:8089', key, voice))):
            deadline = time.monotonic() + 1800
            while True:
                try:
                    ws = await make(); await ws.close(); print(name, 'ready', flush=True); break
                except Exception as error:
                    if time.monotonic() > deadline: raise SystemExit(f'{name} not ready: {error!r}')
                    await asyncio.sleep(10)
asyncio.run(ready())
PY

step "offline preflight"
.venv/bin/python scripts/doctor.py --profile kyutai --env-file .env | tee "$OUT/doctor.txt" || true

step "start ATLAS gateway (loopback 8080)"
nohup bash scripts/start_gateway.sh > "$OUT/gateway.log" 2>&1 &
sleep 5; grep -q "ATLAS voice gateway" "$OUT/gateway.log" && echo "gateway up"

step "concurrency load test (synthetic audio/text only)"
.venv/bin/python scripts/load_kyutai.py --stt ws://127.0.0.1:8090 --tts ws://127.0.0.1:8089 \
  --voice "$KYUTAI_VOICE" --sessions ${LOAD_LEVELS:-4 8 16 32} --seconds 20 | tee "$OUT/load.jsonl"
nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader | tee "$OUT/gpu-after.txt"
step "done"
