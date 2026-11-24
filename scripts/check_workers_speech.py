"""Live round trip against Cloudflare Workers AI speech with a synthetic sentence (costs well under $0.01).
aura-1 synthesizes the sentence -> nova-3 transcribes it back -> word overlap is reported, with latencies.
Uses the same WorkersSpeech code as the gateway. Reads the token from ~/.config/atlas/workers-ai.key.
  python scripts/check_workers_speech.py
"""
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from atlas_voice.speech import WorkersSpeech  # noqa: E402

SENTENCE = 'Before the rollout, triage took about forty minutes per ticket in the Lisbon service desk.'


async def main():
    key = Path(os.environ.get('WORKERS_AI_KEY_FILE', Path.home() / '.config/atlas/workers-ai.key')).read_text().strip()
    cfg = SimpleNamespace(workers_account=os.environ.get('WORKERS_AI_ACCOUNT', ''), workers_key=key,
                          workers_stt_model='@cf/deepgram/nova-3', workers_tts_model='@cf/deepgram/aura-2-en',
                          workers_voice=os.environ.get('WORKERS_TTS_VOICE', 'harmonia'))
    async with aiohttp.ClientSession() as http:
        speech = WorkersSpeech(cfg, http)
        t0 = time.monotonic()
        pcm = await speech.synthesize(SENTENCE)
        t1 = time.monotonic()
        text = await speech.transcribe(pcm)
        t2 = time.monotonic()
    words = lambda s: re.findall(r'[a-z]+', s.lower())  # noqa: E731
    want, got = words(SENTENCE), set(words(text))
    overlap = sum(w in got for w in want) / len(want)
    result = {'tts_seconds_audio': round(len(pcm) / 48000, 2), 'tts_latency_s': round(t1 - t0, 2), 'stt_latency_s': round(t2 - t1, 2),
              'transcript': text, 'word_overlap': round(overlap, 2), 'pass': overlap >= .8}
    print(json.dumps(result, indent=2))
    return 0 if result['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
