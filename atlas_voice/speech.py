"""Speech backends for the cascaded voice route (cascade.py).

KyutaiSpeech  - self-hosted Kyutai STT/TTS over msgpack WebSockets (GPU; batches many sessions).
WorkersSpeech - Cloudflare Workers AI over plain HTTPS: gateway-side turn detection on the microphone
                signal, @cf/deepgram/nova-3 per utterance, @cf/deepgram/aura-1 per sentence (PCM16 24 kHz).
Both expose the same small interface so the interviewer, analyst and browser protocol stay shared:
  await open(); await feed(pcm16); async for kind, text in events(); await speak(deltas, emit); await close()
events() yields ('voice', None) when the consultant starts speaking (barge-in) and ('turn', text) at turn end.
"""
import asyncio
import io
import json
import math
import re
import struct
import wave

import aiohttp

from .kyutai import TurnDetector, connect_stt, connect_tts, float_to_pcm16, pack, pcm16_to_float, unpack

SAMPLE_RATE = 24000
CHUNK = 960


def wav_bytes(pcm, rate=SAMPLE_RATE):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buffer.getvalue()


def rms(pcm):
    count = len(pcm) // 2
    if not count:
        return 0.0
    samples = struct.unpack('<%dh' % count, pcm[:count * 2])
    return math.sqrt(sum(s * s for s in samples) / count) / 32768.0


class EnergyTurns:
    """Utterance segmentation from microphone energy with an adaptive noise floor.

    Start: loudness clearly above the floor for 80 ms. End: 750 ms of quiet after at least 300 ms of speech.
    While ATLAS is speaking the start threshold is raised, so speaker echo is less likely to count as a
    barge-in; a consultant speaking over ATLAS must be clearly louder. Frames are 20-80 ms of PCM16 at 24 kHz.
    """

    def __init__(self, end_silence=1.1, min_speech=.30, max_seconds=90):
        self.floor = .004
        self.active = False
        self.loud = 0.0
        self.quiet = 0.0
        self.spoken = 0.0
        self.buffer = bytearray()
        self.pre = bytearray()
        self.end_silence, self.min_speech, self.max_bytes = end_silence, min_speech, int(max_seconds * SAMPLE_RATE * 2)

    def feed(self, pcm, agent_speaking=False):
        """Return (started, utterance_or_None)."""
        seconds = len(pcm) / (2 * SAMPLE_RATE)
        level = rms(pcm)
        threshold = max(.012, self.floor * 3.2) * (4.0 if agent_speaking else 1.0)
        started, done = False, None
        if not self.active:
            self.floor = self.floor * .97 + min(level, .05) * .03 if level < threshold else self.floor
            self.pre = (self.pre + pcm)[-int(.3 * SAMPLE_RATE * 2):]  # keep 300 ms before onset
            self.loud = self.loud + seconds if level > threshold else 0.0
            # While ATLAS is audible, a barge-in needs 450 ms of sustained loud speech, not a blip or echo.
            if self.loud >= (.45 if agent_speaking else .08):
                self.active, started, self.buffer, self.quiet, self.spoken = True, True, bytearray(self.pre), 0.0, 0.0
        else:
            self.buffer += pcm
            self.spoken += seconds
            self.quiet = self.quiet + seconds if level < threshold * .7 else 0.0
            if (self.quiet >= self.end_silence and self.spoken >= self.min_speech) or len(self.buffer) >= self.max_bytes:
                done, self.active, self.loud, self.pre = bytes(self.buffer), False, 0.0, bytearray()
                self.buffer = bytearray()
        return started, done


def is_echo(text, recent_agent_text):
    """True when a 'consultant' transcript is mostly ATLAS's own recent words picked up by the microphone."""
    words = re.findall(r"[\w']+", text.lower())  # any script
    agent = set(re.findall(r"[\w']+", recent_agent_text.lower()))
    if len(words) < 3 or not agent:
        return False
    return sum(w in agent for w in words) / len(words) >= .7


def sentences(buffer):
    """Split finished sentences off a streaming text buffer: (complete_sentences, remainder)."""
    parts = re.split(r'(?<=[.!?])\s+|(?<=[。！？।])\s*', buffer)  # Latin, CJK and Devanagari sentence ends
    if len(parts) == 1:
        return [], buffer
    return [p for p in parts[:-1] if p.strip()], parts[-1]


class KyutaiSpeech:
    def __init__(self, config, http):
        self.config, self.http, self.stt, self.detector = config, http, None, TurnDetector()

    async def open(self):
        self.stt = await connect_stt(self.http, self.config.kyutai_stt_url, self.config.kyutai_key)

    async def feed(self, pcm, agent_speaking=False):
        await self.stt.send_bytes(pack({'type': 'Audio', 'pcm': pcm16_to_float(pcm)}))

    async def events(self):
        async for msg in self.stt:
            if msg.type != aiohttp.WSMsgType.BINARY:
                raise ConnectionError('Speech recognition closed')
            value = unpack(msg.data)
            if value['type'] == 'Word':
                self.detector.word(value.get('text', ''))
                yield 'voice', None
            elif value['type'] == 'Step':
                text = self.detector.step(value.get('prs'))
                if text:
                    yield 'turn', text
            elif value['type'] == 'Error':
                raise ConnectionError('Speech recognition failed')
        raise ConnectionError('Speech recognition closed')

    async def speak(self, deltas, emit):
        tts = await connect_tts(self.http, self.config.kyutai_tts_url, self.config.kyutai_key, self.config.kyutai_voice)
        buffer = ''

        async def feed():
            nonlocal buffer
            async for delta in deltas:
                buffer += delta
                cut = max(buffer.rfind(' '), buffer.rfind('\n'))
                if cut >= 0:
                    await tts.send_bytes(pack({'type': 'Text', 'text': buffer[:cut + 1]}))
                    buffer = buffer[cut + 1:]
            if buffer:
                await tts.send_bytes(pack({'type': 'Text', 'text': buffer}))
            await tts.send_bytes(pack({'type': 'Eos'}))

        async def pull():
            async for message in tts:
                if message.type != aiohttp.WSMsgType.BINARY:
                    return
                value = unpack(message.data)
                if value['type'] == 'Error':
                    raise ConnectionError('Speech synthesis failed')
                if value['type'] == 'Audio':
                    await emit(float_to_pcm16(value.get('pcm') or []))
        try:
            await asyncio.gather(feed(), pull())
        finally:
            await tts.close()

    async def close(self):
        if self.stt is not None:
            await self.stt.close()


class WorkersSpeech:
    BASE = 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}'

    def __init__(self, config, http):
        self.config, self.http = config, http
        self.turns = EnergyTurns()
        self.queue = asyncio.Queue(maxsize=16)
        self.agent_speaking = False
        self.headers = {'Authorization': 'Bearer ' + config.workers_key}

    def url(self, model):
        return self.BASE.format(account=self.config.workers_account, model=model)

    async def open(self):
        return None

    async def feed(self, pcm, agent_speaking=False):
        started, utterance = self.turns.feed(pcm, agent_speaking)
        if started:
            await self.queue.put(('voice', None))
        if utterance:
            await self.queue.put(('audio', utterance))

    async def transcribe(self, pcm):
        async with self.http.post(self.url(self.config.workers_stt_model), headers={**self.headers, 'Content-Type': 'audio/wav'},
                                  params={'smart_format': 'true', 'punctuate': 'true', 'language': 'en'}, data=wav_bytes(pcm),
                                  timeout=aiohttp.ClientTimeout(total=20)) as response:
            response.raise_for_status()
            data = await response.json()
        result = data.get('result', data)
        try:
            return result['results']['channels'][0]['alternatives'][0]['transcript'].strip()
        except (KeyError, IndexError, TypeError):
            return ''

    async def synthesize(self, text):
        async with self.http.post(self.url(self.config.workers_tts_model), headers=self.headers,
                                  json={'text': text, 'speaker': self.config.workers_voice, 'encoding': 'linear16',
                                        'container': 'none', 'sample_rate': SAMPLE_RATE},
                                  timeout=aiohttp.ClientTimeout(total=30)) as response:
            response.raise_for_status()
            if response.content_type == 'application/json':
                raise ConnectionError('Speech synthesis returned an error document')
            return await response.read()

    async def events(self):
        while True:
            kind, value = await self.queue.get()
            if kind == 'voice':
                yield 'voice', None
                continue
            text = await self.transcribe(value)
            yield ('turn', text) if text else ('noise', None)

    async def speak(self, deltas, emit):
        buffer = ''

        async def say(sentence):
            pcm = await self.synthesize(sentence)
            if len(pcm) % 2:
                pcm = pcm[:-1]
            for start in range(0, len(pcm), CHUNK):
                await emit(pcm[start:start + CHUNK])
        # Synthesize sentence by sentence as the reply streams, so ATLAS starts talking early.
        async for delta in deltas:
            buffer += delta
            done, buffer = sentences(buffer)
            for sentence in done:
                await say(sentence)
        if buffer.strip():
            await say(buffer.strip())

    async def close(self):
        return None
