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


_DONE = object()


def _event_lines(buffer, final):
    """SSE lines. CR, LF and CRLF each end a line. A CR at the end of a chunk waits, in case the next byte is LF.
    When the body ends, the remaining bytes are a line too, so the last delta is not dropped."""
    lines = []
    start = 0
    i = 0
    size = len(buffer)
    while i < size:
        if buffer[i] == 10:
            lines.append(buffer[start:i])
            i += 1
            start = i
            continue
        if buffer[i] == 13:
            if i + 1 == size and not final:
                break
            lines.append(buffer[start:i])
            i += 2 if i + 1 < size and buffer[i + 1] == 10 else 1
            start = i
            continue
        i += 1
    if final and start < size:
        lines.append(buffer[start:])
        start = size
    return lines, buffer[start:]


def _chat_delta(line):
    line = line.strip()
    if not line.startswith(b'data:'):
        return None
    payload = line[5:].strip()
    if payload == b'[DONE]':
        return _DONE
    try:
        delta = json.loads(payload)['choices'][0].get('delta', {}).get('content') or ''
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    return delta or None


async def stream_chat(http, url, model, key, messages, max_tokens=300):
    """Yield text deltas from an OpenAI-compatible streaming chat completion (SSE)."""
    headers = {'Authorization': 'Bearer ' + key} if key else {}
    async with http.post(url, headers=headers, json={'model': model, 'messages': messages, 'stream': True,
                                                     'temperature': 0.6, 'max_tokens': max_tokens},
                         timeout=aiohttp.ClientTimeout(total=45, sock_read=15)) as response:
        response.raise_for_status()
        buffer = b''

        def take(final):
            nonlocal buffer
            lines, buffer = _event_lines(buffer, final)
            deltas = []
            for line in lines:
                delta = _chat_delta(line)
                if delta is _DONE:
                    return deltas, True
                if delta:
                    deltas.append(delta)
            return deltas, False

        async for chunk in response.content.iter_any():
            buffer += chunk
            deltas, done = take(False)
            for delta in deltas:
                yield delta
            if done:
                return
        deltas, _done = take(True)
        for delta in deltas:
            yield delta
