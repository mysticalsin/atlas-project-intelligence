#!/usr/bin/env bash
# ATLAS Kyutai bake-off on ONE rented RunPod GPU. Run on the operator's Mac.
#   bash scripts/runpod_bakeoff.sh plan     # show the pod request (no API call, no secrets)
#   bash scripts/runpod_bakeoff.sh up       # create pod, install Kyutai STT/TTS + ATLAS, run load test
#   bash scripts/runpod_bakeoff.sh tunnel   # private SSH tunnel -> open http://localhost:8080 and talk
#   bash scripts/runpod_bakeoff.sh status | logs | down
# Keys are read from private files and never printed:
#   ~/.config/atlas/runpod.key      RunPod API key (prepaid credit = spending cap)
#   ~/.config/atlas/workers-ai.key  Cloudflare Workers AI token
# Only SSH (22/tcp) is exposed. Speech servers and the gateway bind loopback on the pod.
# ALWAYS run `down` when finished: a stopped test still bills until the pod is deleted.
set -euo pipefail
cd "$(dirname "$0")/.."
STATE="${ATLAS_STATE_DIR:-$HOME/.config/atlas}"
API=https://rest.runpod.io/v1
IMAGE="${BAKEOFF_IMAGE:-runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04}"
GPU="${BAKEOFF_GPU:-NVIDIA L40S}"
ACCOUNT="${WORKERS_AI_ACCOUNT:-294885a27b3cc0a1cbe5d0ccbe38de4f}"
VOICE="${KYUTAI_VOICE:-vctk/p225_023.wav}"
SSH_KEY="$STATE/bakeoff_ed25519"
POD_FILE="$STATE/bakeoff.pod"

die() { echo "ERROR: $*" >&2; exit 1; }
need_file() { [ -s "$1" ] || die "missing $1 (see header of this script)"; }
api() { # method path [json]; the key goes through a header file descriptor, never argv
  local key; key=$(tr -d '[:space:]' < "$STATE/runpod.key")
  curl -sS --fail-with-body -X "$1" "$API$2" -H 'Content-Type: application/json' \
       -H @<(printf 'Authorization: Bearer %s\n' "$key") ${3:+--data "$3"}
}
pod_id() { need_file "$POD_FILE"; cat "$POD_FILE"; }
ssh_target() { # prints: host port
  api GET "/pods/$(pod_id)" | python3 -c 'import json,sys; p=json.load(sys.stdin); m=p.get("portMappings") or {}; ip=p.get("publicIp"); print(ip, m.get("22","")) if ip and m.get("22") else sys.exit(1)'
}
pod_ssh() { local t; t=($(ssh_target)); ssh -i "$SSH_KEY" -p "${t[1]}" -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$STATE/known_hosts" -o ServerAliveInterval=30 "root@${t[0]}" "$@"; }

request_json() { # pod request body; only the public SSH key is embedded
  python3 - "$IMAGE" "$GPU" "$1" <<'PY'
import json, sys
image, gpu, pub = sys.argv[1:]
print(json.dumps({'name': 'atlas-bakeoff', 'imageName': image, 'gpuTypeIds': [gpu], 'gpuCount': 1,
                  'cloudType': 'SECURE', 'containerDiskInGb': 120, 'volumeInGb': 0,
                  'ports': ['22/tcp'], 'env': {'PUBLIC_KEY': pub}}))
PY
}

cmd_plan() {
  local pub="${1:-ssh-ed25519 AAAA...(generated at up)}"
  request_json "$pub"
}

cmd_up() {
  need_file "$STATE/runpod.key"; need_file "$STATE/workers-ai.key"
  [ -s "$POD_FILE" ] && die "a bake-off pod is already recorded ($(cat "$POD_FILE")); run status or down first"
  mkdir -p "$STATE"; chmod 700 "$STATE"
  [ -f "$SSH_KEY" ] || ssh-keygen -q -t ed25519 -N '' -C atlas-bakeoff -f "$SSH_KEY"
  echo "Creating 1x $GPU pod (SECURE cloud, SSH only)…"
  api POST /pods "$(request_json "$(cat "$SSH_KEY.pub")")" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' > "$POD_FILE"
  echo "Pod $(cat "$POD_FILE") created. Billing has started; run 'down' when finished."
  echo -n "Waiting for SSH"
  for _ in $(seq 1 90); do ssh_target >/dev/null 2>&1 && break; echo -n .; sleep 10; done; echo
  ssh_target >/dev/null || die "pod has no SSH mapping after 15 min; check the RunPod console, then run down"
  for _ in $(seq 1 30); do pod_ssh true 2>/dev/null && break; sleep 10; done
  echo "Uploading ATLAS source (no .env, vault data, keys or aliases)…"
  tar czf - --exclude='.venv' --exclude='data' --exclude='.env' --exclude='*.key' --exclude='.playwright-mcp' \
      --exclude='__pycache__' --exclude='.pytest_cache' --exclude='preview' --exclude='handoff/provenance' \
      --exclude='ATLAS_Intelligence.html' --exclude='ATLAS_Project_Intelligence.html' --exclude='ATLAS_Voice_Studio.html' . \
    | pod_ssh 'mkdir -p /opt/atlas && tar xzf - -C /opt/atlas'
  pod_ssh 'umask 077; cat > /opt/atlas/.workers-ai.key' < "$STATE/workers-ai.key"
  local kkey; kkey=$(openssl rand -hex 24)
  printf 'KYUTAI_API_KEY=%s\nWORKERS_AI_ACCOUNT=%s\nKYUTAI_VOICE=%s\n' "$kkey" "$ACCOUNT" "$VOICE" \
    | pod_ssh 'umask 077; cat > /opt/atlas/.bakeoff.env'
  echo "Installing Kyutai STT/TTS + ATLAS and running the load test (typically 20-40 min)…"
  pod_ssh 'cd /opt/atlas && nohup bash -c "set -a; . ./.bakeoff.env; set +a; bash scripts/pod_setup.sh" > /opt/atlas/setup.out 2>&1 &'
  cmd_logs follow
}

cmd_logs() {
  if [ "${1:-}" = follow ]; then
    pod_ssh 'while ! grep -qE "=== .* done|=== FAILED" /opt/atlas/setup.out 2>/dev/null; do sleep 15; tail -n 2 /opt/atlas/setup.out 2>/dev/null; done; tail -n 40 /opt/atlas/setup.out'
    cmd_fetch
  else
    pod_ssh 'tail -n 60 /opt/atlas/setup.out'
  fi
}

cmd_fetch() {
  local dest="handoff/verification/runpod-$(date +%Y-%m-%d)"
  mkdir -p "$dest"
  pod_ssh 'cd /opt/atlas/bakeoff && tar czf - --exclude=".env" .' | tar xzf - -C "$dest"
  echo "Results saved to $dest (load.jsonl, gpu*.txt, batch.txt, logs)."
}

cmd_tunnel() {
  local t; t=($(ssh_target))
  echo "Open http://localhost:8080 in Chrome. Use headphones. Ctrl-C closes the tunnel."
  ssh -i "$SSH_KEY" -p "${t[1]}" -o UserKnownHostsFile="$STATE/known_hosts" -N -L 8080:127.0.0.1:8080 "root@${t[0]}"
}

cmd_status() { api GET "/pods/$(pod_id)" | python3 -c 'import json,sys; p=json.load(sys.stdin); print({k:p.get(k) for k in ("id","desiredStatus","costPerHr","gpu","publicIp")})'; }

cmd_down() {
  local id; id=$(pod_id)
  api DELETE "/pods/$id" >/dev/null && rm -f "$POD_FILE" && echo "Pod $id deleted; billing stopped."
  echo "Reminder: delete the 'atlas-bakeoff' API key in RunPod when the bake-off is over."
}

case "${1:-}" in
  plan) cmd_plan "${2:-}" ;; up) cmd_up ;; logs) cmd_logs ;; fetch) cmd_fetch ;;
  tunnel) cmd_tunnel ;; status) cmd_status ;; down) cmd_down ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
