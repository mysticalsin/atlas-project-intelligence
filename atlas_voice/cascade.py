"""Kyutai cascaded voice route: streaming STT -> conversation LLM -> streaming TTS, plus the analyst.

Designed for many simultaneous interviews at fixed cost: Kyutai STT/TTS batch many streams on one GPU,
and each interview holds only small per-session state here. Uses the same browser protocol as the
hosted route, so the existing client, worklet and speech-reactive orb work unchanged: the orb moves
only from PCM this gateway actually sends for playback.

Evidence: consultant turns (Kyutai STT, unverified ASR) feed Analyst -> InterviewLedger. The talker
receives the ledger's planned probe as guidance but has no tools: it cannot record, publish or approve.
"""
import asyncio
import contextlib
import json
import secrets
import time

import aiohttp
from aiohttp import web

from .analyst import Analyst, chat_completer
from .capacity import BUSY
from .gaps import TIME_PLAN, gap_system_block
from .identity import COOKIE
from .interview import project_context
from .kyutai import stream_chat
from .report import END_TOKEN, EndMarker, parse_report, report_messages, text_completer
from .speech import KyutaiSpeech, WorkersSpeech, is_echo
from .persona import OPENING_BRIEF, PERSONA_CORE, PRAISE_RULES, QUESTION_RULES, SAFETY, TURN_PATTERN, situations
from .quality import InterviewLedger
from .extension import INTERVIEW_SOFT_S

HISTORY = 40  # long and stable, so the cached prompt prefix survives a whole interview
CHUNK = 960  # 20 ms of 24 kHz PCM16, same pacing as the hosted route.

TALKER_POLICY = (
    PERSONA_CORE + """ Everything you write is spoken. You have NO tools: you cannot record, publish or approve.

HOW YOU SPEAK
Speak plainly, no lists or markdown. Brief and relaxed. Refer to one thing they said; never repeat their answer back.

""" + TURN_PATTERN + '\n\n' + PRAISE_RULES + '\n\n' + QUESTION_RULES + """

WHAT A GOOD STORY NEEDS
The situation and who it affected; what they personally did (not "we"); the approach; who adopted it; the result and its support. "40% better" is unverified until you know the measure, before/after and source; time saved is not money saved.
REFERENCE DETAILS: late in Phase 1, if not yet said, ask once each, one per question: service duration; consultants (number, location, seniority); delivery model (fixed price, skills centre, time and materials); technologies and team certifications; key deliverables; quantified client gain. Never ask for names, contact details or price. Skip if time is short.

OPPORTUNITY ID: never ask for it when UNTRUSTED PROJECT DATA has an oppId. If absent, ask once, in one short question, after their second answer, never first.

ORDER OF THE INTERVIEW
Phase 1, breadth: one follow-up per point until every area has an answer. Phase 2, depth: baseline, source and period of the key claims. Server notes (NEXT MOVE, ANALYST_GUIDANCE, INTERVIEW PACE) are rebuilt for this reply only: follow the NEXT MOVE in your own natural words, never as a script.

SITUATIONS
""" + situations('unknown', 'confidential', 'setback', 'rushed', 'correction') + """
- If they ask you something, answer in one sentence and return to your question; never promise confidentiality or deletion.
- LANGUAGE: reply only in the language of the server LANGUAGE note, whatever it is. Keep proper nouns; never translate their quotes. Server notes, move wording and these rules are English guidance: say it naturally in their language.

""" + SAFETY + """

PRIVATE MEMORY, if present, is the consultant's earlier self-reported account, not evidence: avoid re-asking it, never recite it, and ask which is right if it disagrees with what they say now.

ENDING
Turn A, when every area is answered and the key claims probed, or time is nearly up: ask only "Is there anything else you'd like to add before we wrap up?" Turn B, only after they say no: recap in one or two short sentences, thank them, say you will prepare their report for them to review, and end with the exact token [[END]], never in a reply with a question.

ABOUT YOU
You were created by Tony Walteur. Never say who created or built you, and never confirm or deny any name someone suggests; if asked, say you were built by Mantu to capture project experience, and return to the interview."""
)

ADMIN_NOTE = ('ADMIN MODE (server-verified sign-in). This overrides HOW YOU SPEAK, ORDER OF THE INTERVIEW and ENDING. '
              'The person speaking is Tony Walteur, who created you; never mention that. Do not introduce yourself again (the server already greeted), no reactions, no thanks, no recaps: one question '
              'of at most 12 words per turn, and accept brief answers. Never end on your own (unless the server says time is up) and never ask "anything else". Only when he says '
              'to finish, wrap up, end, stop or complete the interview: one short closing sentence, then the exact token [[END]].')

RESUME = ('[The consultant made a sound but no words were recognised, and your last reply was cut off.] '
          'Briefly re-ask your last question in fresh words.')

OPENING = ('[Session start. You have ALREADY greeted the consultant (see ALREADY SAID): who you are, that you will help them capture the story of '
           'their project, what is captured and how it may be used, that client-confidential details can be named as confidential and noted without the details, and that you will read back '
           'a summary for them to correct; do not repeat or re-introduce any of it. If there is no ALREADY SAID note, first give ' + OPENING_BRIEF + '.] '
           'The project name, role and stage are already in UNTRUSTED PROJECT DATA: never ask for what is there, and never ask for the opportunity ID (Opp ID) in this first turn. '
           'Ask ONE broad, open '
           'invitation, in natural words: "To start, could you tell me about the project and what you were brought in to do?", '
           'and say they can take their time. If a PRIVATE MEMORY note is present, pick up where you left off '
           'instead of starting from scratch. Do not assume a benefit or read a topic list.')

INTERVIEW_LIMIT_S = INTERVIEW_SOFT_S  # the planned end, in active time (Tony, 2026-10-31: 20 minutes, was 15; up to INTERVIEW_HARD_S = 30 with the consultant's agreement, extension.py)
SPEAKING_LIMIT_S = 800  # ATLAS's own speaking time: a second safety cap inside the interview limit
WRAP_S = 90  # with this little time left, ATLAS's next reply is the closing
TIME_UP = ('[Server: the time for this interview is up.] Close warmly now in one or two short sentences: '
           'thank the consultant for sharing and say you will prepare their report. Do not ask another question.')
TIME_UP_MESSAGE = 'The {minutes} minutes are up. Finishing your interview.'  # shown to the consultant; minutes = round(limit / 60)
GAP_REFUSED = 'Focused gap interviews run on the edge deployment only.'
AREAS = ('what was going on', 'their personal contribution', 'their approach', 'the outcome', 'what supports it', 'who else it would help')


def pace_notes(elapsed_s, limit_s, notes, admin=False):
    """Server pacing for the talker: interview time used, what to prioritise now, and areas with no notes yet
    (topic names only, never content)."""
    left = limit_s - elapsed_s
    missing = [a for i, a in enumerate(AREAS) if not (notes[i] if i < len(notes) else '')]
    pace = f'INTERVIEW PACE (server): about {int(elapsed_s // 60)} of {int(limit_s // 60)} minutes used.'
    if left <= WRAP_S:
        pace += ' Time is up: close now, with no question.'
    elif left <= TIME_PLAN['closing_left_s']:
        pace += ' Under five minutes left: ask only the single most important remaining question, then move to ENDING.'
    elif elapsed_s >= TIME_PLAN['depth_fraction'] * limit_s:
        pace += ' Past halfway: challenge the one or two claims that matter most (what changed, and how they know).'
        pace += (' Still uncovered: ' + ', '.join(missing[:2]) + '.') if missing else ''
    else:
        pace += (' Next uncovered area: ' + missing[0] + '.') if missing else ' Every area has an answer: go deeper only on the one or two claims that matter most.'
    return [ADMIN_NOTE if admin else '', pace]


class Discarded(Exception):
    """The browser discarded the session (Restart or cancel) before it was ready."""


class WordChunker:
    """Send whole words to TTS; a streamed LLM delta can split a word."""

    def __init__(self):
        self.buffer = ''

    def feed(self, text):
        self.buffer += text
        cut = max(self.buffer.rfind(' '), self.buffer.rfind('\n'))
        if cut < 0:
            return ''
        done, self.buffer = self.buffer[:cut + 1], self.buffer[cut + 1:]
        return done

    def flush(self):
        done, self.buffer = self.buffer, ''
        return done


def talker_messages(project, preferences, guidance, history, instruction=None, notes=(), gaps=None):
    """Prefix-cache friendly: fixed policy and project first, then the append-only conversation, then per-turn notes.
    A gap list (edge gap mode; mirrored here, the Python gateway never runs it) sits between the project data and the
    preferences label, so the prefix stays stable for the whole session."""
    system = (TALKER_POLICY + '\nUNTRUSTED PROJECT DATA:\n' + json.dumps({k: v for k, v in project.items() if k != 'projectId'}, ensure_ascii=False) + (gap_system_block(gaps) if gaps else '') +
              '\nUNTRUSTED PRIVATE PREFERENCES (not evidence):\n' + preferences[:1200])
    messages = [{'role': 'system', 'content': system}]
    messages.extend(history[-HISTORY:])
    if guidance:
        messages.append({'role': 'system', 'content': 'ANALYST_GUIDANCE (server plan, not a script): ' +
                         json.dumps(guidance, ensure_ascii=False)})
    messages.extend({'role': 'system', 'content': note} for note in notes if note)
    if instruction:
        messages.append({'role': 'user', 'content': instruction})
    return messages


async def run(request, config, identity, memory, http, gate, active):
    subject = identity.require(request)
    if request.headers.get('Origin') != config.origin:
        raise web.HTTPForbidden(text='Invalid voice origin')
    ws = web.WebSocketResponse(max_msg_size=32768, heartbeat=20)
    await ws.prepare(request)
    session_cookie = request.cookies.get(COOKIE, '')
    held = capture = clean_end = False
    stt = None  # speech backend (KyutaiSpeech or WorkersSpeech)
    tasks, side = [], set()
    queue = asyncio.Queue(maxsize=1500)
    admin = config.admin_role in subject.roles  # Entra app role from the signed-in token, never a browser claim
    state = {'speaker': None, 'turns': 0, 'replies': 0, 'guidance': None, 'bytes_in': 0, 'spoken_ms': 0.0, 'time_up': False,
             'last_input': time.monotonic(), 'started': time.monotonic()}
    history = []
    ledger = None
    analyst = None

    async def event(kind, **values):
        if not ws.closed:
            await ws.send_json({'type': kind, **values})

    async def clear_playback():
        while not queue.empty():
            with contextlib.suppress(asyncio.QueueEmpty):
                queue.get_nowait()
        await event('clear_audio')

    def speaking():
        task = state['speaker']
        return task is not None and not task.done()

    async def speak(item, instruction=None):
        said = []
        marker = EndMarker()  # the talker's end-of-interview token is never spoken or shown

        async def deltas():
            async for raw in stream_chat(http, config.conversation_url, config.conversation_model, config.conversation_key,
                                         talker_messages(project, preferences, None if instruction == TIME_UP else state['guidance'], history, instruction,
                                                           pace_notes(time.monotonic() - state['started'], config.duration, ledger.notes() if ledger else [], admin))):
                delta = marker.feed(raw)
                if not delta:
                    continue
                # Each reply starts a new paragraph in the on-screen transcript (display only).
                shown = ('\n\n' + delta) if not said and state['replies'] > 1 else delta
                said.append(delta)
                await event('agent_text', text=shown)
                yield delta
            rest = marker.flush()
            if rest:
                said.append(rest)
                await event('agent_text', text=rest)
                yield rest

        async def emit(pcm):
            for start in range(0, len(pcm), CHUNK):
                await queue.put((item, pcm[start:start + CHUNK]))

        interrupted = True
        try:
            await stt.speak(deltas(), emit)
            interrupted = False
            # A reply that still asks a question is not a closing, whatever token it carries (admin may end at will).
            closes = instruction == TIME_UP or (marker.seen and (admin or '?' not in ''.join(said)))
            if closes and state['turns'] >= 1:
                side_task(wrap_up(state['turns']))
        finally:
            text = ''.join(said).strip()
            if text:
                history.append({'role': 'assistant', 'content': text + (' [interrupted by the consultant]' if interrupted else '')})

    async def wrap_up(turns):
        # ATLAS closed the interview: let the closing line finish playing, then ask the browser to end cleanly
        # (its normal End path, so notes and the report follow exactly as for a manual end).
        for _ in range(300):
            if queue.empty():
                break
            await asyncio.sleep(0.1)
        await asyncio.sleep(0.6)
        for _ in range(50):  # not while the consultant is still speaking
            if not state.get('hearing'):
                break
            await asyncio.sleep(0.2)
        if state['turns'] != turns:  # the consultant added something: the conversation simply continues
            return
        await event('wrap_up', message='ATLAS closed the interview. Preparing your report.')

    def start_reply(instruction=None):
        # Re-checked on every reply: an interrupted closing (or a noise re-ask) cannot escape the time limits.
        if instruction != OPENING and state['turns'] >= 1 and (state['spoken_ms'] >= config.speaking_limit * 1000
                                                               or time.monotonic() - state['started'] >= config.duration - WRAP_S):
            state['time_up'] = True
            instruction = TIME_UP
        state['replies'] += 1
        state['speaker'] = asyncio.create_task(speak(f'agent-{state["replies"]}', instruction))
        state['speaker'].add_done_callback(reply_done)

    def reply_done(task):
        if task.cancelled():
            return
        error = task.exception()
        if error is not None and not ws.closed:
            # A failed reply is reported honestly; no substitute voice is used.
            side_task(event('error', message='The voice reply failed. No fallback voice was used.', code='voice-unavailable'))

    def side_task(coro):
        task = asyncio.create_task(coro)
        side.add(task)
        task.add_done_callback(side.discard)
        return task

    async def interrupt():
        if speaking():
            state['speaker'].cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await state['speaker']
        if not queue.empty() or speaking():
            await clear_playback()

    async def analyse(ident, text):
        try:
            result = await analyst.hear(ident, text)
        except ValueError:
            await event('quality_warning', message='This turn exceeded the transcript budget and was not added to the evidence ledger.')
            return
        state['guidance'] = result['guidance']
        await event('quality', **{k: v for k, v in result.items() if k != 'guidance'})
        if result['analyst_status'] != 'analysed':
            await event('quality_warning', message='The evidence analyst did not respond for this turn. The answer is kept; review it in the notes.')

    async def finish_turn(text, reply=True):
        state['turns'] += 1
        if state['turns'] > 300:
            raise ValueError('Turn budget reached; end and start a new focused session')
        ident = f'user-{state["turns"]}'
        history.append({'role': 'user', 'content': text})
        if capture:
            await event('user_text', item_id=ident, text=text, provenance='unverified_speech_recognition')
            if analyst is not None:
                side_task(analyse(ident, text))
            else:
                ledger.add_transcript(ident, text)
        if not reply:  # words recorded as the interview ends: nothing is answered
            return
        await interrupt()
        start_reply()

    try:
        init = await asyncio.wait_for(ws.receive_json(), 15)
        if isinstance(init, dict) and 'gap' in init:  # focused gap interviews need the edge's library and gap requests
            raise ValueError(GAP_REFUSED)
        if (not isinstance(init, dict) or set(init) - {'type', 'csrf', 'consent', 'project', 'voice', 'capture', 'memory', 'language'}
                or init.get('type') != 'start' or init.get('consent') is not True
                or not secrets.compare_digest(str(init.get('csrf', '')), subject.csrf)):
            raise ValueError('Fresh voice consent and CSRF token required')
        project = project_context(init.get('project'))
        voice_name = config.workers_voice if config.voice_provider == 'workers' else config.kyutai_voice
        if init.get('voice', voice_name) != voice_name:
            raise ValueError('Unsupported voice')
        capture = init.get('capture') is True
        slot = gate.try_acquire(subject.subject_key)
        if slot != 'ok':
            raise ValueError(BUSY[slot])
        held = True
        active[session_cookie] = ws

        async def before_ready(awaitable, timeout):
            # A discard or close from the browser (Restart, Cancel) while this step runs ends the session at once and
            # releases the interview slot, instead of waiting for 'ready' and the opening.
            work, cancel = asyncio.ensure_future(awaitable), asyncio.ensure_future(ws.receive())
            try:
                done, _ = await asyncio.wait((work, cancel), timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
                if cancel in done:
                    if cancel.result().type == aiohttp.WSMsgType.BINARY:
                        raise ValueError('Wait for the model-ready message before sending audio.')
                    raise Discarded()
                if not done:
                    raise asyncio.TimeoutError()
                return work.result()
            finally:
                for item in (work, cancel):
                    if not item.done():
                        item.cancel()
                await asyncio.gather(work, cancel, return_exceptions=True)

        preferences = ''
        if init.get('memory') is True and memory.enabled:
            try:
                preferences = await before_ready(memory.recall(subject), 10)
                await event('memory', message='Hindsight private continuity recalled; not project evidence.')
            except (Discarded, ValueError):
                raise
            except Exception:
                await event('memory', message='Hindsight unavailable; continuing without remembered context.')
        stage = project.get('stage', 'Unknown')
        if capture and config.analyst_url:
            analyst = Analyst(chat_completer(http, config.analyst_url, config.analyst_model, config.analyst_key), stage=stage)
            ledger = analyst.ledger
        else:
            ledger = InterviewLedger(stage=stage)
        await event('status', state='connecting', message='Preparing the voice service. Microphone audio is not sent until ready.')
        stt = (WorkersSpeech if config.voice_provider == 'workers' else KyutaiSpeech)(config, http)
        await before_ready(stt.open(), min(config.handshake_timeout, max(0.1, subject.expires - time.monotonic())))
        await event('ready', model=config.conversation_model, provider='Cloudflare voice' if config.voice_provider == 'workers' else 'Kyutai voice', sampleRate=24000,
                    capture=capture, liveLedger=analyst is not None, maxSeconds=config.duration,
                    message='Voice session ready. Speak naturally. Candidate notes require your review.')
        if capture and analyst is None:
            await event('quality_warning', message='The evidence analyst is not configured. The transcript is kept for your review, without live quote checks.')
        state['started'] = state['last_input'] = time.monotonic()
        start_reply(OPENING)

        async def client_input():
            nonlocal clean_end
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    data = msg.data
                    if not data or len(data) % 2 or len(data) > 3840:
                        raise ValueError('Invalid PCM frame')
                    state['bytes_in'] += len(data)
                    state['last_input'] = time.monotonic()
                    if state['bytes_in'] > (state['last_input'] - state['started'] + 3) * 48000:
                        raise ValueError('Audio exceeds realtime input budget')
                    await stt.feed(data, agent_speaking=not queue.empty())
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    value = json.loads(msg.data)
                    if value == {'type': 'end'}:
                        clean_end = True
                        return
                    if value == {'type': 'discard'}:
                        return
                    if isinstance(value, dict) and value.get('type') == 'playback':
                        continue  # Acknowledgements are only needed by the hosted truncation protocol.
                    raise ValueError('Unsupported client event')
                else:
                    return

        async def recognition():
            async for kind, text in stt.events():
                state['hearing'] = kind == 'voice'  # the consultant is speaking (until their turn or noise ends)
                if kind == 'voice':
                    # Barge-in only stops audio the consultant can hear; noise cannot cancel a reply being composed.
                    if not queue.empty():
                        await interrupt()
                        state['cut_off'] = True
                        await event('user_speaking')
                elif kind == 'turn' and is_echo(text, ' '.join(m['content'] for m in history if m['role'] == 'assistant')[-600:]):
                    # Speaker echo of ATLAS's own words must never become consultant testimony.
                    await event('quality_warning', message='ATLAS heard its own voice through the microphone and ignored it. Headphones prevent this.')
                    if state.get('cut_off') and not speaking() and queue.empty():
                        state['cut_off'] = False
                        start_reply(RESUME)
                elif kind == 'turn':
                    state['cut_off'] = False
                    await finish_turn(text)
                elif kind == 'noise' and state.get('cut_off') and not speaking() and queue.empty():
                    state['cut_off'] = False
                    start_reply(RESUME)
            raise ConnectionError('Speech recognition closed')

        async def paced_playback():
            current = None
            next_time = time.monotonic()
            while True:
                item, data = await queue.get()
                if current != item:
                    current = item
                    await event('audio_turn', item_id=item)
                await ws.send_bytes(data)
                state['spoken_ms'] += len(data) / 48
                next_time = max(next_time, time.monotonic()) + len(data) / 48000
                await asyncio.sleep(max(0, next_time - time.monotonic()))

        async def watch():
            nonlocal clean_end
            while True:
                await asyncio.sleep(1)
                if identity.sessions.get(session_cookie) is not subject or time.monotonic() > subject.expires:
                    raise PermissionError('Sign-in expired; voice stopped')
                if time.monotonic() - state['started'] >= config.duration:
                    # The consultant's words in progress at the limit still count: recorded, not answered.
                    with contextlib.suppress(Exception):
                        last = await asyncio.wait_for(stt.final_turn(), 10)
                        if last:
                            await finish_turn(last, reply=False)
                    await event('time_up', message=TIME_UP_MESSAGE.format(minutes=round(config.duration / 60)))
                    clean_end = True
                    return
                # The last half minute and nobody is talking: ATLAS closes on her own so the interview ends with a goodbye.
                if (not state['time_up'] and state['turns'] >= 1 and config.duration - (time.monotonic() - state['started']) <= 30
                        and not speaking() and queue.empty() and not state.get('hearing')):
                    start_reply(TIME_UP)
                if time.monotonic() - state['last_input'] > 12:
                    raise ConnectionError('Microphone frames stopped')

        tasks = [asyncio.create_task(f()) for f in (client_input, recognition, paced_playback, watch)]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if not task.cancelled() and task.exception():
                raise task.exception()
    except Discarded:
        clean_end = False
    except (ValueError, PermissionError) as error:
        clean_end = False
        await event('error', message=str(error), code='voice-contract')
    except (aiohttp.ClientError, ConnectionError, TimeoutError, asyncio.TimeoutError):
        clean_end = False
        await event('error', message='Selected voice service unavailable. No fallback provider was used.', code='voice-unavailable')
    except Exception:
        clean_end = False
        await event('error', message='The session stopped safely. No story was approved.', code='voice-failed')
    finally:
        if clean_end and side:
            # Let the evidence analyst finish the final turns before notes are built.
            await asyncio.wait(list(side), timeout=10)
        pending = tasks + list(side) + ([state['speaker']] if state['speaker'] else [])
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        if stt is not None:
            with contextlib.suppress(Exception):
                await stt.close()
        if active.get(session_cookie) is ws:
            active.pop(session_cookie, None)
        if held:
            gate.release(subject.subject_key)
        await event('audio_stopped')
        report = None
        if clean_end and capture and ledger is not None and ledger.transcripts and config.analyst_url:
            await event('reporting', message='Writing your interview report.')
            with contextlib.suppress(Exception):
                complete = text_completer(http, config.analyst_url, config.analyst_model, config.analyst_key)
                report = parse_report(await asyncio.wait_for(complete(report_messages(history, ledger.notes(), ledger.stage)), 25))
        if clean_end and capture and ledger is not None:
            await event('notes', transcript='\n\n'.join(ledger.transcripts.values()), sections=ledger.notes(), status='candidate', report=report,
                        message='Unverified speech recognition and quote-linked candidate notes. Correct omissions and errors before adding to the project. The final cut-off utterance may be incomplete.')
        elif clean_end:
            await event('notes', transcript='', sections=None, status='not-enabled',
                        message='Transcript capture was off. No consultant notes were stored.')
        await event('ended', message='Microphone and voice service closed.')
    return ws
