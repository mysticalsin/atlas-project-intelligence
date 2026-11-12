"""Kyutai streaming STT/TTS clients (moshi-server protocol, as used by kyutai-labs/unmute)
and an OpenAI-compatible streaming chat helper for the cascaded voice route.

Protocol (verified against unmute/kyutai_constants.py, stt/speech_to_text.py, tts/text_to_speech.py):
- 24 kHz mono float32 PCM, 80 ms frames; msgpack messages; header `kyutai-api-key`.
- STT  /api/asr-streaming  send {"type":"Audio","pcm":[...]}; receive Ready, Word{text,start_time},
  EndWord{stop_time}, Step{step_idx,prs}, Marker{id}, Error{message}. prs[2] = pause prediction.
- TTS  /api/tts_streaming?format=PcmMessagePack&voice=...  send {"type":"Text","text"}, {"type":"Eos"};
  receive Ready, Audio{pcm}, Text{text,start_s,stop_s}, Error{message}.
"""
import json
import struct
from urllib.parse import quote

import aiohttp

from .spend import reserve, usage_from
import msgpack

SAMPLE_RATE = 24000
STT_PATH = '/api/asr-streaming'
TTS_PATH = '/api/tts_streaming'
WARMUP_STEPS = 12  # Pause prediction is unreliable for the first steps (unmute).


def pcm16_to_float(data):
    count = len(data) // 2
    return [v / 32768.0 for v in struct.unpack('<%dh' % count, data[:count * 2])]


def float_to_pcm16(samples):
    return struct.pack('<%dh' % len(samples), *(int(max(-1.0, min(1.0, float(s))) * 32767) for s in samples))


def pack(value):
    return msgpack.packb(value, use_bin_type=True, use_single_float=True)


def unpack(data):
    value = msgpack.unpackb(data, raw=False)
    if not isinstance(value, dict) or not isinstance(value.get('type'), str):
        raise ValueError('Invalid speech-service message')
    return value


class TurnDetector:
    """End of consultant turn = words heard, then pause prediction above threshold (unmute's rule)."""

    def __init__(self, threshold=0.6):
        self.threshold = threshold
        self.steps = 0
        self.words = []

    def word(self, text):
        text = str(text).strip()
        if text:
            self.words.append(text)

    def step(self, prs):
        """Return the finished utterance text, or None."""
        self.steps += 1
        if self.steps <= WARMUP_STEPS or not self.words:
            return None
        try:
            pause = float(prs[2])
        except (TypeError, ValueError, IndexError):
            return None
        if pause > self.threshold:
            text, self.words = ' '.join(self.words), []
            return text
        return None


async def connect(http, base, path, key, query=''):
    ws = await http.ws_connect(base + path + query, headers={'kyutai-api-key': key} if key else {},
                               max_msg_size=4 * 1024 * 1024, heartbeat=20)
    first = await ws.receive()
    if first.type != aiohttp.WSMsgType.BINARY:
        await ws.close()
        raise ConnectionError('Speech service closed before ready')
    message = unpack(first.data)
    if message['type'] != 'Ready':
        await ws.close()
        # Kyutai servers answer Error when at capacity; surface it, never fall back silently.
        raise ConnectionError('Speech service unavailable or at capacity')
    return ws


def connect_stt(http, base, key):
    return connect(http, base, STT_PATH, key)


def connect_tts(http, base, key, voice):
    return connect(http, base, TTS_PATH, key, '?format=PcmMessagePack&cfg_alpha=1.5&voice=' + quote(voice, safe=''))


async def stream_chat(http, url, model, key, messages, max_tokens=300):
    """Yield text deltas from an OpenAI-compatible streaming chat completion (SSE)."""
    headers = {'Authorization': 'Bearer ' + key} if key else {}
    body = {'model': model, 'messages': messages, 'stream': True, 'temperature': 0.6, 'max_tokens': max_tokens}
    hold = await reserve({'kind': 'talker', 'provider': 'openai', 'model': model,
                          'inputTokens': max(1, len(json.dumps(body)) // 4), 'outputTokens': max_tokens}, http)
    seen = None
    try:
        async with http.post(url, headers=headers, json=body,
                             timeout=aiohttp.ClientTimeout(total=45, sock_read=15)) as response:
            response.raise_for_status()
            buffer = b''
            async for chunk in response.content.iter_any():
                buffer += chunk
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    line = line.strip()
                    if not line.startswith(b'data:'):
                        continue
                    payload = line[5:].strip()
                    if payload == b'[DONE]':
                        return
                    try:
                        parsed = json.loads(payload)
                    except ValueError:
                        continue
                    found = usage_from(parsed)
                    if found:
                        seen = found
                    try:
                        delta = parsed['choices'][0].get('delta', {}).get('content') or ''
                    except (KeyError, IndexError, TypeError):
                        continue
                    if delta:
                        yield delta
    except Exception as error:
        await hold.settle(error=type(error).__name__)
        raise
    finally:
        await hold.settle(seen)
