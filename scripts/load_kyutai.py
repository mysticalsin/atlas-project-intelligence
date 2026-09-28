"""Measure how many simultaneous interviews one Kyutai STT/TTS GPU sustains in real time.

Operator tool for the bake-off. It contacts ONLY the speech servers you name, with synthetic
audio/text, never consultant data. Example (run from an approved host):
  KYUTAI_API_KEY=... python scripts/load_kyutai.py --stt wss://stt.internal --tts wss://tts.internal \
      --voice vctk/<file>.wav --sessions 10 20 40 --seconds 30
Real time means STT returns about one Step per 80 ms of audio sent, and TTS produces audio
at least as fast as it plays. Reported numbers are measurements for this host only.
"""
import argparse
import asyncio
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path

import aiohttp

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from atlas_voice.kyutai import SAMPLE_RATE, connect_stt, connect_tts, pack, unpack  # noqa: E402

FRAME = 1920  # 80 ms
SENTENCE = ('Thanks, that helps. Before we talk about results, which part of the handover did you personally '
            'own, and what did the rest of the team own?')


def summarize(values):
    if not values:
        return None
    ordered = sorted(values)
    return {'median': round(statistics.median(ordered), 3), 'p95': round(ordered[min(len(ordered) - 1, math.ceil(0.95 * len(ordered)) - 1)], 3),
            'worst': round(ordered[-1], 3)}


async def stt_session(http, url, key, seconds):
    ws = await connect_stt(http, url, key)
    steps = 0
    start = time.monotonic()

    async def send():
        tone = [0.02 * math.sin(2 * math.pi * 220 * n / SAMPLE_RATE) for n in range(FRAME)]
        for i in range(int(seconds / 0.08)):
            await ws.send_bytes(pack({'type': 'Audio', 'pcm': tone}))
            await asyncio.sleep(max(0, start + (i + 1) * 0.08 - time.monotonic()))

    async def receive():
        nonlocal steps
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.BINARY:
                return
            if unpack(msg.data)['type'] == 'Step':
                steps += 1

    reader = asyncio.create_task(receive())
    await send()
    await asyncio.sleep(1.0)  # allow the model's delay to drain
    reader.cancel()
    await asyncio.gather(reader, return_exceptions=True)
    await ws.close()
    # 1.0 = kept up with real time; lower = fell behind.
    return steps / max(1, int(seconds / 0.08))


async def tts_session(http, url, key, voice):
    ws = await connect_tts(http, url, key, voice)
    sent = time.monotonic()
    for word in SENTENCE.split():
        await ws.send_bytes(pack({'type': 'Text', 'text': word + ' '}))
    await ws.send_bytes(pack({'type': 'Eos'}))
    first, samples = None, 0
    async for msg in ws:
        if msg.type != aiohttp.WSMsgType.BINARY:
            break
        value = unpack(msg.data)
        if value['type'] == 'Audio':
            first = first or time.monotonic() - sent
            samples += len(value.get('pcm') or [])
    elapsed = time.monotonic() - sent
    await ws.close()
    return first, (samples / SAMPLE_RATE) / max(elapsed, 1e-6)


async def run_level(args, n):
    async with aiohttp.ClientSession() as http:
        # Both run at once, as in live interviews.
        stt, tts = await asyncio.gather(
            asyncio.gather(*(stt_session(http, args.stt, args.key, args.seconds) for _ in range(n)), return_exceptions=True),
            asyncio.gather(*(tts_session(http, args.tts, args.key, args.voice) for _ in range(n)), return_exceptions=True))
    stt_ok = [x for x in stt if not isinstance(x, BaseException)]
    tts_ok = [x for x in tts if not isinstance(x, BaseException)]
    return {'sessions': n,
            'stt_failed': len(stt) - len(stt_ok), 'stt_realtime_ratio': summarize(stt_ok),
            'tts_failed': len(tts) - len(tts_ok),
            'tts_first_audio_s': summarize([f for f, _ in tts_ok if f is not None]),
            'tts_speed_x_realtime': summarize([r for _, r in tts_ok]),
            'verdict': verdict(len(stt) - len(stt_ok), stt_ok, len(tts) - len(tts_ok), tts_ok)}


def verdict(stt_failed, stt_ok, tts_failed, tts_ok):
    if stt_failed or tts_failed:
        return 'over capacity (sessions refused or failed)'
    if stt_ok and min(stt_ok) < 0.95:
        return 'STT fell behind real time'
    if tts_ok and min(r for _, r in tts_ok) < 1.0:
        return 'TTS slower than real time'
    return 'kept up'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--stt', required=True)
    parser.add_argument('--tts', required=True)
    parser.add_argument('--voice', required=True)
    parser.add_argument('--sessions', type=int, nargs='+', default=[5, 10, 20])
    parser.add_argument('--seconds', type=float, default=20)
    args = parser.parse_args(argv)
    args.key = os.environ.get('KYUTAI_API_KEY', '')
    for n in args.sessions:
        print(json.dumps(asyncio.run(run_level(args, n))), flush=True)


if __name__ == '__main__':
    main()
