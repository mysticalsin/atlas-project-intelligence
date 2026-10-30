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


GUARD_MAX_WORDS = 45  # most words ATLAS says in one reply
PRAISE_MAX_WORDS = 8  # a sentence this short that is only praise is dropped
REACTION_MAX_WORDS = 12  # a leading sentence longer than this is an answer, not a reaction: the repeated-opener rule leaves it alone
DEFAULT_BANNED_PRAISE = r'\b(amazing|incredible|brilliant|awesome|fantastic)\b'  # persona.BANNED_PRAISE_SRC replaces it when wired
_TERMINAL = re.compile(r'[.!?\u3002\uff01\uff1f\u0964]+$')
_CLOSERS = re.compile('[\\s"\'\u201d\u2019\u00bb)\\]*_`]+$')
_NUMBER = re.compile(r'[0-9]+(?:[.,][0-9]+)*')
_THOUSANDS = re.compile(r'[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?')
_TRIM = ' ,;:\u2014\u2013-'
GUARD_STATS = ('dropped_after_question', 'dropped_praise', 'dropped_repeat_opener', 'capped_words', 'dropped_unknown_number')


def _words(text):
    """The words of a text: whitespace-separated tokens with a letter or digit (a dash or a bullet is not a word)."""
    return [t for t in text.split() if any(c.isalnum() for c in t)]


def _norm(text):
    """Lower case, apostrophes and punctuation removed, whitespace collapsed: how two reactions are compared."""
    text = text.lower().replace("'", '').replace('\u2019', '')
    return ' '.join(''.join(c if c.isalnum() or c.isspace() else ' ' for c in text).split())


def _number(token):
    """A numeral in one form, so '35%' and '35', '1,200' and '1200', '3.50' and '3.5' are the same figure."""
    token = token.replace(',', '') if _THOUSANDS.fullmatch(token) else token.replace(',', '.')
    return token.rstrip('0').rstrip('.') if '.' in token else token


def _is_question(sentence):
    """A finished sentence whose closing punctuation holds a question mark ('?', or the full-width one), quotes and markup aside."""
    m = _TERMINAL.search(_CLOSERS.sub('', sentence))
    return bool(m) and ('?' in m.group() or '\uff1f' in m.group())


def _first_words(text, count):
    """The start of text up to its count-th word, trailing commas and dashes trimmed (an exact slice)."""
    seen = 0
    for m in re.finditer(r'\S+', text):
        if any(c.isalnum() for c in m.group()):
            seen += 1
            if seen >= count:
                return text[:m.end()].rstrip(_TRIM) if count > 0 else ''
    return text if count > 0 else ''


class ReplyGuard:
    """Streaming filter over the spoken pieces (Phrases) of one reply. It enforces the shape of a reply in code, whatever the
    model wrote: at most one question, no empty praise, no repeated reaction, a short reply, and (in summary mode) no number
    that is not one of the given facts.

    push(piece) returns the pieces to voice: exact slices of the piece (so the on-screen text can be cut at them), possibly
    trimmed or none. done turns true once the first question sentence has been reached (voiced or not) or the word cap has cut
    the reply; the caller then stops reading the model stream. stats counts each rule's drops, never text.

    Options: banned_praise, a regex source (case-insensitive); recent_openers, the leading reaction of the last replies
    (only the last 3 count); max_words, None for no cap; summary_facts, None, or the list of figures the reply may use
    (an empty list allows none): summary mode.

    A sentence is judged when its first piece arrives. A first clause already voiced is not taken back, and the rest of that
    sentence follows it (a dropped first clause drops the rest). Words are whitespace-separated: a language written without
    spaces is not capped."""

    def __init__(self, banned_praise=None, recent_openers=(), max_words=GUARD_MAX_WORDS, summary_facts=None):
        self._praise = re.compile(DEFAULT_BANNED_PRAISE if banned_praise is None else banned_praise, re.I)
        self._openers = [o for o in (_norm(o) for o in list(recent_openers or ())[-3:]) if o]
        self._max = max_words
        self._allowed = None if summary_facts is None else {_number(m) for fact in summary_facts for m in _NUMBER.findall(str(fact))}
        self._stats = dict.fromkeys(GUARD_STATS, 0)
        self._spoken = 0  # words voiced so far
        self._open = None  # the sentence in progress when the last piece ended mid-sentence: 'voiced' or 'dropped'
        self._lead = True  # the next sentence that gets this far is the reply's leading one
        self._stop = None  # 'question' or 'cap'

    @property
    def done(self):
        return self._stop is not None

    @property
    def stats(self):
        return dict(self._stats)

    def _repeats_opener(self, text):
        words = _words(text)
        n = _norm(text)
        return bool(n) and len(words) <= REACTION_MAX_WORDS and any(n == o or n.startswith(o + ' ') or o.startswith(n + ' ') for o in self._openers)

    def _judge(self, text, ended, continuing):
        """(text to voice or '', whether the sentence is the first question). Applies the rules to one sentence or clause."""
        stats = self._stats
        question = ended and _is_question(text)
        if continuing and self._open == 'dropped':
            return '', question
        if not continuing and not question:
            if len(_words(text)) <= PRAISE_MAX_WORDS and self._praise.search(text):
                stats['dropped_praise'] += 1
                return '', question
            if self._lead:
                self._lead = False
                if self._repeats_opener(text):
                    stats['dropped_repeat_opener'] += 1
                    return '', question
        if self._allowed is not None and any(_number(m) not in self._allowed for m in _NUMBER.findall(text)):
            stats['dropped_unknown_number'] += 1
            return '', question
        if self._max is not None:
            room = self._max - self._spoken
            if len(_words(text)) > room:
                stats['capped_words'] += 1
                self._stop = 'cap'
                # Cut at a sentence boundary when something has been said already; else (or inside a sentence under way) at a word.
                return (_first_words(text, room) if continuing or not self._spoken else ''), False
        return text, question

    def push(self, piece):
        piece = piece or ''
        cuts, start, spans = _boundaries(piece + ' '), 0, []
        for end, nxt in cuts:
            if piece[start:end].strip():
                spans.append((start, min(end, len(piece)), True))
            start = nxt
        if piece[start:].strip():
            spans.append((start, len(piece), False))
        runs, last = [], -2
        for i, (a, b, ended) in enumerate(spans):
            while a < b and piece[a].isspace():
                a += 1
            if self._stop:
                if self._stop == 'question':
                    self._stats['dropped_after_question'] += 1
                continue
            text, question = self._judge(piece[a:b].strip(), ended, i == 0 and self._open is not None)
            if text:
                b = a + len(text)
                self._spoken += len(_words(text))
                if last == i - 1:
                    runs[-1][1] = b
                else:
                    runs.append([a, b])
                last = i
            self._open = None if ended else ('voiced' if text else 'dropped')
            if question and not self._stop:
                self._stop = 'question'
        return [piece[a:b] for a, b in runs]


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
