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
import unicodedata
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

    def flush(self):
        """End the current utterance now (for example when the interview time is up). None when idle."""
        if not self.active or not self.buffer:
            return None
        done, self.active, self.loud, self.pre, self.quiet = bytes(self.buffer), False, 0.0, bytearray(), 0.0
        self.buffer = bytearray()
        return done


def is_echo(text, recent_agent_text):
    """True when a 'consultant' transcript is mostly ATLAS's own recent words picked up by the microphone."""
    words = re.findall(r"[\w']+", text.lower())  # any script
    agent = set(re.findall(r"[\w']+", recent_agent_text.lower()))
    if len(words) < 3 or not agent:
        return False
    return sum(w in agent for w in words) / len(words) >= .7


# A sentence end: . ! or ? (then any closing quote, bracket or markdown) before whitespace, or a CJK or Devanagari stop.
_END = re.compile(r'([.!?]+)["\'\u201d\u2019\u00bb)\]*_`]*(\s+)|[\u3002\uff01\uff1f\u0964]\s*')
ABBREVIATIONS = frozenset('mr mrs ms dr prof st jr sr vs etc cf approx inc ltd corp dept mme mlle hr sra dott sig dhr mevr ca'.split())
MIN_PIECE = 40  # characters: shorter sentences join the next piece, and the first clause goes early only from here
_CLAUSE = re.compile(r'(.{%d,}?[,;:\u2014\u2013])\s+' % MIN_PIECE, re.S)


def _letters_before(text):
    i = len(text)
    while i and (text[i - 1] == '.' or unicodedata.category(text[i - 1]).startswith('L')):
        i -= 1
    return text[i:]


def _boundaries(text):
    """(end, next) of each sentence end in text: text[:end] is finished and the next sentence starts at next."""
    cuts, start = [], 0
    for m in _END.finditer(text):
        nxt = m.end()
        if m.group(1) is None:
            end = m.start() + 1
        else:
            end, stops = nxt - len(m.group(2)), m.group(1)
            if '!' not in stops and '?' not in stops:  # full stops only: maybe an initial, an abbreviation or a list number
                if nxt < len(text) and unicodedata.category(text[nxt]) == 'Ll':
                    continue  # a lowercase word continues the sentence ("data... and", "etc. were")
                before = text[start:m.start()]
                if re.fullmatch(r'\s*[0-9]{1,2}', before):
                    continue  # "1." opens a list item
                if stops == '.':
                    token = _letters_before(before)
                    if all(len(part) == 1 for part in token.split('.')) or token.lower() in ABBREVIATIONS:
                        continue  # "A.I.", "e.g.", "U.S.", "J.", "Dr.", "vs."
        cuts.append((end, nxt))
        start = nxt
    return cuts


def sentences(buffer):
    """Split finished sentences off a streaming text buffer: (complete_sentences, remainder)."""
    done, start = [], 0
    for end, nxt in _boundaries(buffer):
        if buffer[start:end].strip():
            done.append(buffer[start:end])
        start = nxt
    return done, buffer[start:]


class Phrases:
    """Streaming reply text -> the pieces to synthesise, each an exact slice of the text (trimmed).

    The first piece goes as soon as it is a whole sentence, or a clause of MIN_PIECE characters, so ATLAS starts talking
    early. After it, a sentence shorter than MIN_PIECE joins the next one while more text is coming: the voice gets whole
    phrases with natural intonation instead of clipped fragments with a pause after each."""

    def __init__(self):
        self.text, self.first = '', True

    def feed(self, delta):
        self.text += delta
        out, start = [], 0
        for end, nxt in _boundaries(self.text):
            piece = self.text[start:end].strip()
            if self.first or not piece or len(piece) >= MIN_PIECE:
                if piece:
                    out.append(piece)
                    self.first = False
                start = nxt
        if self.first:
            m = _CLAUSE.match(self.text, start)
            if m:
                out.append(m.group(1).strip())
                self.first, start = False, m.end()
        self.text = self.text[start:]
        return out

    def flush(self):
        piece, self.text = self.text.strip(), ''
        return [piece] if piece else []


def speakable(text):
    """What the voice says for a piece of reply text: markdown and list markers removed, whitespace collapsed (the
    on-screen text keeps them). Empty when nothing speakable is left."""
    text = re.sub(r'(?m)^\s*(?:#{1,6}|[-*\u2022]|[0-9]{1,2}[.)])\s+', '', text)
    text = ' '.join(re.sub(r'\*\*|__|[*`]', '', text).split())
    return text if any(c.isalnum() for c in text) else ''


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

    async def final_turn(self):
        """Words heard but not yet ended as a turn (the interview time is up)."""
        text, self.detector.words = ' '.join(self.detector.words), []
        return text

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
        phrases, jobs = Phrases(), []

        def start(piece):
            text = speakable(piece)
            if text:
                job = asyncio.ensure_future(self.synthesize(text))
                job.add_done_callback(lambda j: j.cancelled() or j.exception())  # a failure is raised where it is awaited
                jobs.append(job)

        async def play_first():
            pcm = await jobs[0]
            jobs.pop(0)
            if len(pcm) % 2:
                pcm = pcm[:-1]
            for offset in range(0, len(pcm), CHUNK):
                await emit(pcm[offset:offset + CHUNK])
        # Phrase by phrase as the reply streams, so ATLAS starts talking early. Each piece is synthesised as soon as its
        # text is complete, while the one before it is still being synthesised (at most two at once); audio stays in order.
        try:
            async for delta in deltas:
                for piece in phrases.feed(delta):
                    start(piece)
                    while len(jobs) >= 2:
                        await play_first()
            for piece in phrases.flush():
                start(piece)
            while jobs:
                await play_first()
        finally:
            for job in jobs:
                job.cancel()

    async def final_turn(self):
        """Speech still waiting to be transcribed, or still being spoken (the interview time is up)."""
        pending = []
        while not self.queue.empty():
            kind, value = self.queue.get_nowait()
            if kind == 'audio':
                pending.append(value)
        last = self.turns.flush()
        if last:
            pending.append(last)
        texts = [await self.transcribe(pcm) for pcm in pending]
        return ' '.join(t for t in texts if t)

    async def close(self):
        return None
