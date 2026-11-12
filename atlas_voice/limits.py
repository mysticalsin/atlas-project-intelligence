"""The gateway reads each kind's limit from prices.js. That file is the only definition."""
import json
import re
from pathlib import Path

_PRICES = Path(__file__).resolve().parents[1] / 'deploy' / 'cloudflare-edge' / 'src' / 'prices.js'
_MATCH = re.search(r'export const LIMITS = Object\.freeze\(JSON\.parse\(`(.*?)`\)\);', _PRICES.read_text(encoding='utf-8'), re.S)
if not _MATCH:
    raise RuntimeError('LIMITS is missing from prices.js')
LIMITS = json.loads(_MATCH.group(1))


def output_tokens(name):
    spec = LIMITS[name]
    return int(spec['maxTokens']) + int(spec.get('reasoningTokens') or 0)


def _raw(payload):
    if payload is None:
        return b''
    if isinstance(payload, bytes):
        return payload
    if isinstance(payload, str):
        return payload.encode('utf-8')
    return json.dumps(payload, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def input_tokens(payload):
    raw = _raw(payload)
    return max(1, len(raw))


def cap_pcm(pcm, max_audio_ms):
    data = bytes(pcm or b'')
    max_bytes = int(max_audio_ms) * int(LIMITS['pcmBytesPerMs'])
    if len(data) <= max_bytes:
        return data
    start = len(data) - max_bytes
    if start % 2:
        start += 1
    return data[start:]


def cap_text(text, max_chars):
    s = '' if text is None else str(text)
    n = int(max_chars)
    return s if len(s) <= n else s[:n]


def realtime_reservation(seconds):
    spec = LIMITS['realtime']
    try:
        raw = int(seconds)
    except (TypeError, ValueError):
        raw = int(spec['maxSeconds'])
    if raw < 1:
        raw = int(spec['maxSeconds'])
    seconds_capped = max(1, min(raw, int(spec['maxSeconds'])))
    stop_in = seconds_capped * int(spec['inputTokensPerSecond'])
    stop_out = seconds_capped * int(spec['outputTokensPerSecond'])
    return {
        'seconds': seconds_capped,
        'inputTokens': stop_in,
        'outputTokens': stop_out + int(spec['maxResponseTokens']),
        'stopInput': stop_in,
        'stopOutput': stop_out,
    }


def jev_body(text):
    raw = text if isinstance(text, str) else json.dumps(text, separators=(',', ':'), ensure_ascii=False)
    if len(raw.encode('utf-8')) > int(LIMITS['jev']['contextTokens']):
        raise ValueError('Story exceeds ranking context budget; prepare a reviewed shorter variant')
    return raw
