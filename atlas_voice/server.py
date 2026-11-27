"""ATLAS voice gateway. Bounded concurrent interviews (one for the PersonaPlex worker), no public GPU port."""
import asyncio
import contextlib
import html
import json
import os
import re
import secrets
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit, urlencode

import aiohttp
from aiohttp import web

from .audio import AudioCodec
from .capacity import BUSY, VoiceCapacity
from .config import Config, LOOPBACK, VOICES
from .identity import Identity, COOKIE
from .interview import project_context, make_prompt
from .memory import PrivateMemory
from .notes import make_notes
from .csp import REPORTING_ENDPOINTS, RUNTIME_BLOCK, html_csp, legacy_csp, script_hashes

ROOT = Path(__file__).resolve().parents[1]

class SessionCancelled(Exception):
    pass


def _ws_origin(config):
    u = urlsplit(config.origin)
    return ('wss' if u.scheme == 'https' else 'ws') + '://' + u.netloc


def csp(config, hashes=(), *, blob=False):
    """Hash-only script policy. blob=True is the voice page (the worklet). Sign-in and JSON leave it false."""
    return html_csp(hashes=tuple(hashes), connect=_ws_origin(config), script_blob=blob, worker_blob=blob, media_blob=blob)


def csp_headers(config, hashes=(), *, blob=False):
    connect = _ws_origin(config)
    strict = html_csp(hashes=tuple(hashes), connect=connect, script_blob=blob, worker_blob=blob, media_blob=blob)
    if os.environ.get('ATLAS_CSP', '').lower() == 'report-only':
        return {'Content-Security-Policy': legacy_csp(connect=connect), 'Content-Security-Policy-Report-Only': strict, 'Reporting-Endpoints': REPORTING_ENDPOINTS}
    return {'Content-Security-Policy': strict}


def same_origin(request, config):
    return request.headers.get('Origin') == config.origin


def create_app(config=None, *, memory_factory=PrivateMemory, notes_fn=make_notes, ledger_check=True):
    if ledger_check:
        from .spend import require_ledger
        require_ledger()
    config = (config or Config.env()).validate()
    identity = Identity(config)
    memory = memory_factory(config)
    gate = VoiceCapacity(config.max_interviews)
    preference_times = {}
    active = {}  # Cookie id -> websocket. Logout and expiry close a live stream.

    @web.middleware
    async def boundary(request, handler):
        # Explicit Host validation also prevents DNS rebinding in local mode.
        if request.host.lower() != urlsplit(config.origin).netloc.lower():
            raise web.HTTPForbidden(text='Host is not the configured ATLAS origin.')
        if config.auth_mode == 'local' and request.remote not in LOOPBACK:
            raise web.HTTPForbidden(text='Local mode accepts loopback connections only.')
        if request.method not in ('GET', 'HEAD'):
            subject = identity.require(request)
            if not same_origin(request, config) or not secrets.compare_digest(
                    request.headers.get('X-Atlas-CSRF', ''), subject.csrf):
                raise web.HTTPForbidden(text='Invalid request origin or session token.')
        try:
            response = await handler(request)
        except web.HTTPException as error:
            response = error
        if not response.prepared:
            response.headers['Cache-Control'] = 'no-store'
            response.headers['X-Content-Type-Options'] = 'nosniff'
            response.headers['Referrer-Policy'] = 'no-referrer'
            response.headers['Permissions-Policy'] = 'microphone=(self), camera=(), geolocation=()'
            if 'Content-Security-Policy' not in response.headers:
                content_type = response.content_type or ''
                if 'html' not in content_type:
                    response.headers['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'none'"
                else:
                    body = response.text if isinstance(getattr(response, 'text', None), str) else ''
                    # blob: only on the voice page. Sign-in has no script and no worklet, so script-src stays 'none'.
                    voice = 'id="atlas-runtime"' in body
                    for key, value in csp_headers(config, script_hashes(body), blob=voice).items():
                        response.headers[key] = value
        return response

    app = web.Application(middlewares=[boundary], client_max_size=131072)
    app['config'] = config
    app['identity'] = identity
    app['voice_gate'] = gate
    if config.wiki_root:
        from .wiki import WikiVault
        app['wiki'] = WikiVault(config.wiki_root)

    async def startup(app):
        app['http'] = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, connect=10),
                                           trust_env=False)
        memory.session = app['http']

    async def cleanup(app):
        for ws in list(active.values()):
            await ws.close(code=1001, message=b'Server shutdown')
        await app['http'].close()
        if 'wiki' in app:app['wiki'].close()

    app.on_startup.append(startup)
    app.on_cleanup.append(cleanup)

    async def index(request):
        subject = identity.get(request)
        cookie = None
        if subject is None and config.auth_mode == 'local':
            cookie, subject = identity.issue('local', 'single-developer', 'Local developer')
        if subject is None:
            return web.Response(text='''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ATLAS · Sign in</title><style>body{font:18px/1.6 Arial;background:#F8F8F8;color:#3E007A;padding:12vh 12vw}h1{font-size:54px}a{display:inline-block;background:#3E007A;color:white;padding:14px 25px;border-radius:9px;text-decoration:none}p{max-width:570px}</style><h1>Great work. Worth hearing.</h1><p>Sign in with your Mantu work account to use the ATLAS voice interview. Access requires the assigned ATLAS app role.</p><a href="/auth/login">Sign in with Microsoft Entra ID →</a></html>''', content_type='text/html')
        text = (ROOT / 'ATLAS_Voice.html').read_text()
        runtime = json.dumps({'subjectKey': subject.subject_key, 'authMode': config.auth_mode,
                              'name': subject.name}).replace('<', '\\u003c')
        block = '<script id="atlas-runtime" type="application/json">' + runtime + '</script>'
        text = text.replace(RUNTIME_BLOCK, block, 1)
        # Header is authoritative; replace the file's restricted connect-src too.
        text = text.replace("connect-src 'self';", "connect-src 'self' " +
                            config.origin.replace('https://', 'wss://').replace('http://', 'ws://') + ';')
        if os.environ.get('ATLAS_CSP', '').lower() == 'report-only':
            text = re.sub(r'<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>', '', text, count=1)
        response = web.Response(text=text, content_type='text/html')
        if cookie:
            identity.set_cookie(response, cookie)
        return response

    async def bootstrap(request):
        subject = identity.require(request)
        hosted=config.voice_provider=='openai'
        cascade=config.voice_provider=='kyutai'
        from .realtime import VOICES as HOSTED_VOICES
        if config.voice_provider=='workers':
            info={'model':'Workers AI nova-3/aura-1 + '+config.conversation_model,'voices':[config.workers_voice],'defaultVoice':config.workers_voice,
                  'codecAvailable':bool(config.workers_key),'transcription':True,'structuredNotes':bool(config.analyst_url),
                  'providerLabel':'Cloudflare voice','liveLedger':bool(config.analyst_url),'playbackAck':False}
        elif cascade:
            info={'model':'Kyutai STT/TTS + '+config.conversation_model,'voices':[config.kyutai_voice],'defaultVoice':config.kyutai_voice,
                  'codecAvailable':bool(config.kyutai_stt_url and config.kyutai_tts_url),'transcription':True,'structuredNotes':bool(config.analyst_url),
                  'providerLabel':'Kyutai voice','liveLedger':bool(config.analyst_url),'playbackAck':False}
        else:
            info={'model': config.openai_model if hosted else 'NVIDIA PersonaPlex 7B v1', 'voices': list(HOSTED_VOICES if hosted else VOICES), 'defaultVoice': config.openai_voice if hosted else config.voice,
                  'codecAvailable': bool(config.openai_key) if hosted else bool(shutil.which(config.ffmpeg)),
                  'transcription': hosted or bool(config.riva_uri), 'structuredNotes': hosted or bool(config.riva_uri and config.notes_url),
                  'providerLabel':'OpenAI Realtime' if hosted else 'NVIDIA PersonaPlex','liveLedger':hosted,'playbackAck':hosted}
        return web.json_response({**info,'provider':config.voice_provider,'capacity':config.max_interviews,'wiki':bool(config.wiki_root),'jev':bool(__import__('os').environ.get('TYPESAFE_API_KEY')),'protocol': 'atlas-personaplex-pcm-v1', 'csrf': subject.csrf,
            'identity': {'name': subject.name, 'mode': config.auth_mode, 'subjectKey': subject.subject_key},
            'busy': gate.locked(),
            'maxSeconds': config.duration, 'memory': memory.enabled,
            'readiness': 'configured-not-inference-tested'})

    async def preference(request):
        subject = identity.require(request)
        now = time.monotonic()
        if now - preference_times.get(subject.subject_key, -100) < 10:
            raise web.HTTPTooManyRequests(text='Wait a few seconds before saving another preference.')
        preference_times[subject.subject_key] = now
        if len(preference_times) > 1000:
            for key in [k for k,v in preference_times.items() if now-v>60]:
                preference_times.pop(key, None)
        try:
            data = await request.json()
            if set(data) != {'preference'}:
                raise ValueError('Only a preference is accepted; the server selects the user bank.')
            await memory.retain(subject, data['preference'])
            return web.json_response({'saved': True})
        except ValueError as e:
            raise web.HTTPBadRequest(text=str(e)) from None
        except Exception:
            raise web.HTTPBadGateway(text='Hindsight did not confirm this write. No success is assumed.') from None

    async def logout(request):
        key = request.cookies.get(COOKIE, '')
        identity.sessions.pop(key, None)
        if key in active:
            await active[key].close(code=1008, message=b'Signed out')
        response = web.json_response({'signedOut': True})
        response.del_cookie(COOKIE, path='/')
        return response

    async def voice(request):
        if config.voice_provider == 'openai':
            from .realtime import run
            return await run(request,config,identity,memory,app['http'],gate,active)
        if config.voice_provider in ('kyutai', 'workers'):
            from .cascade import run
            return await run(request,config,identity,memory,app['http'],gate,active)
        subject = identity.require(request)
        if not same_origin(request, config):
            raise web.HTTPForbidden(text='Voice must use the configured same-origin page.')
        ws = web.WebSocketResponse(max_msg_size=32768, heartbeat=20)
        ws.headers['Cache-Control'] = 'no-store'
        await ws.prepare(request)
        held = False
        codec = None
        upstream = None
        tasks = []
        pcm = bytearray()
        capture = False
        clean_end = False
        session_cookie = request.cookies.get(COOKIE, '')
        counters = {'inputBytes': 0, 'outputBytes': 0, 'agentTextCharacters': 0}

        async def event(kind, **values):
            if not ws.closed:
                await ws.send_json({'type': kind, **values})

        try:
            init = await asyncio.wait_for(ws.receive_json(), 15)
            if not isinstance(init, dict) or set(init) - {'type', 'csrf', 'consent', 'project', 'voice', 'capture', 'memory', 'language'}:
                raise ValueError('Invalid start message.')
            if init.get('type') != 'start' or init.get('consent') is not True or not secrets.compare_digest(
                    str(init.get('csrf', '')), subject.csrf):
                raise ValueError('Fresh session consent and a valid session token are required.')
            project = project_context(init.get('project'))
            voice_name = init.get('voice', config.voice)
            if voice_name not in VOICES:
                raise ValueError('Unknown voice. Use a supplied PersonaPlex voice.')
            capture = init.get('capture') is True and bool(config.riva_uri)
            slot = gate.try_acquire(subject.subject_key)
            if slot != 'ok':
                await event('error', code='busy', message=BUSY[slot])
                await ws.close(code=1013)
                return ws
            held = True
            active[session_cookie] = ws
            if not shutil.which(config.ffmpeg):
                raise ValueError('FFmpeg is missing on the voice gateway. Install FFmpeg with libopus support.')
            await event('status', state='connecting', message='Preparing NVIDIA voice; microphone is not sent before the model handshake.')
            preferences = ''
            if init.get('memory') is True and memory.enabled:
                try:
                    preferences = await memory.recall(subject)
                    await event('memory', status='recalled', message='Private preferences loaded for the signed-in identity.')
                except Exception:
                    await event('memory', status='unavailable', message='Private memory is unavailable. Continuing without it.')
            prompt = make_prompt(project, preferences)
            params = {'text_prompt': prompt, 'voice_prompt': voice_name}
            if len(urlencode(params).encode()) > 7800:
                raise ValueError('Project context is too long for this PersonaPlex server. Shorten the project description.')
            upstream = await app['http'].ws_connect(config.personaplex_url, params=params,
                max_msg_size=131072, heartbeat=20, autoclose=True)
            # The upstream seed parameter is deliberately omitted: this audited stock version
            # indexes request['seed'] instead of request.query['seed'].
            # Cancellation while the GPU prepares its prompt must not hold the
            # only worker until the handshake timeout. Read both sides once.
            model_ready = asyncio.create_task(upstream.receive())
            client_cancel = asyncio.create_task(ws.receive())
            try:
                completed, _ = await asyncio.wait((model_ready, client_cancel),
                    timeout=min(config.handshake_timeout, max(0.1, subject.expires-time.monotonic())),
                    return_when=asyncio.FIRST_COMPLETED)
                if not completed:
                    raise asyncio.TimeoutError()
                if client_cancel in completed:
                    message = client_cancel.result()
                    if message.type == aiohttp.WSMsgType.BINARY:
                        raise ValueError('Wait for the model-ready message before sending audio.')
                    raise SessionCancelled()
                first = model_ready.result()
            finally:
                for item in (model_ready, client_cancel):
                    if not item.done():
                        item.cancel()
                await asyncio.gather(model_ready, client_cancel, return_exceptions=True)
            if first.type != aiohttp.WSMsgType.BINARY or first.data != b'\x00':
                raise ConnectionError('PersonaPlex did not send its model-ready handshake.')
            codec = await AudioCodec(config.ffmpeg).start()
            await event('ready', model='NVIDIA PersonaPlex 7B v1', sampleRate=24000,
                        capture=capture, maxSeconds=config.duration,
                        message='Model handshake received. Microphone audio now streams to PersonaPlex.')
            started = time.monotonic()
            last_input = started

            async def client_audio():
                nonlocal clean_end, last_input
                async for msg in ws:
                    if msg.type == aiohttp.WSMsgType.BINARY:
                        data = msg.data
                        if not data or len(data) % 2 or len(data) > 3840:
                            raise ValueError('Expected small mono PCM16 frames at 24 kHz.')
                        counters['inputBytes'] += len(data)
                        last_input = time.monotonic()
                        elapsed = time.monotonic() - started
                        if counters['inputBytes'] > (elapsed + 3) * 48000:
                            raise ValueError('Audio arrived faster than real time.')
                        if capture:
                            if len(pcm) + len(data) > config.duration * 48000:
                                raise ValueError('Audio buffer limit reached.')
                            pcm.extend(data)
                        await codec.pcm_in(data)
                    elif msg.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        if data == {'type': 'end'}:
                            clean_end = True
                            return
                        if data == {'type': 'discard'}:
                            return
                        raise ValueError('Unknown voice control message.')
                    else:
                        return

            async def model_audio_in():
                async for chunk in codec.opus_chunks():
                    await upstream.send_bytes(b'\x01' + chunk)

            async def model_audio_out():
                async for msg in upstream:
                    if msg.type == aiohttp.WSMsgType.BINARY and msg.data:
                        kind, payload = msg.data[0], msg.data[1:]
                        if kind == 1:
                            await codec.opus_in(payload)
                        elif kind == 2:
                            token = payload.decode('utf-8', errors='replace')
                            counters['agentTextCharacters'] += len(token)
                            if counters['agentTextCharacters'] > 120000:
                                raise ValueError('Agent transcript budget reached.')
                            await event('agent_text', text=token)
                        elif kind != 0:
                            raise ValueError('Unsupported PersonaPlex frame type.')
                    elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        break
                raise ConnectionError('The NVIDIA voice stream closed.')

            async def browser_audio():
                async for chunk in codec.pcm_chunks():
                    counters['outputBytes'] += len(chunk)
                    await ws.send_bytes(chunk)

            async def deadline():
                nonlocal clean_end
                await asyncio.sleep(config.duration)
                clean_end = True
                await event('status', state='ended', message='Session time limit reached. Start a new interview when ready.')

            async def identity_watch():
                while True:
                    await asyncio.sleep(3)
                    if identity.sessions.get(session_cookie) is not subject or subject.expires <= time.monotonic():
                        raise PermissionError('Your sign-in expired. The microphone session has stopped.')
                    # Detect a dead AudioWorklet without leaving a GPU session hanging indefinitely.
                    if time.monotonic() - last_input > 10:
                        raise ConnectionError('No microphone frames arrived. Check microphone and browser permissions.')

            tasks = [asyncio.create_task(coro()) for coro in
                     (client_audio, model_audio_in, model_audio_out, browser_audio, deadline, identity_watch)]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            errors = [task.exception() for task in done if not task.cancelled() and task.exception()]
            if errors:
                raise errors[0]
        except SessionCancelled:
            clean_end = False
        except (ValueError, PermissionError) as e:
            clean_end = False
            await event('error', code='invalid-session', message=str(e))
        except asyncio.TimeoutError:
            clean_end = False
            await event('error', code='model-timeout', message='NVIDIA did not become ready before the timeout. Microphone capture has stopped.')
        except (aiohttp.ClientError, ConnectionError, OSError) as e:
            clean_end = False
            await event('error', code='voice-unavailable', message='The NVIDIA voice connection failed. Check the GPU worker and gateway logs; no fallback voice was used.')
        except Exception:
            clean_end = False
            await event('error', code='voice-failed', message='The voice session stopped unexpectedly. No interview data was approved.')
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            if upstream is not None:
                with contextlib.suppress(Exception):
                    await upstream.close()
            if codec is not None:
                await codec.close()
            if active.get(session_cookie) is ws:
                active.pop(session_cookie, None)
            if held:
                gate.release(subject.subject_key)
            await event('audio_stopped', **counters)

        # Release the voice worker before optional transcription. Do not fabricate input text
        # from PersonaPlex's agent-only text stream. All raw bytes remain in RAM, not a file.
        from .spend import BudgetRefused
        try:
            if clean_end and capture and pcm and not ws.closed:
                await event('status', state='transcribing', message='Voice stopped. Preparing a consultant transcript for your review.')
                result = await notes_fn(config, app['http'], bytes(pcm))
                if not ws.closed and identity.sessions.get(session_cookie) is subject and subject.expires > time.monotonic():
                    await event('notes', **result)
            elif clean_end:
                await event('notes', transcript='', sections=None, status='not-configured',
                            message='Voice interview ended. Consultant transcription was not enabled; no consultant words were invented.')
        except BudgetRefused as refused:
            from .spend import refusal_event
            if refused.reason == 'unpriced':
                note_message, note_code = 'Transcription is not priced, so it was not sent.', refused.code
            else:
                note_message, note_code = refusal_event(refused)
            await event('notes', transcript='', sections=None, status='refused', code=note_code, message=note_message)
        except Exception:
            await event('notes', transcript='', sections=None, status='failed',
                        message='Transcription did not complete. No transcript or project notes are claimed.')
        finally:
            pcm.clear()
            await event('ended', message='Microphone and NVIDIA stream closed.')
            await ws.close()
        return ws

    from .knowledge_routes import install
    install(app,identity)
    app.router.add_get('/', index)
    app.router.add_get('/ATLAS_Voice.html', index)
    app.router.add_get('/api/bootstrap', bootstrap)
    app.router.add_get('/api/voice', voice)
    app.router.add_post('/api/preference', preference)
    app.router.add_post('/api/logout', logout)
    app.router.add_get('/auth/login', identity.login)
    app.router.add_get('/auth/callback', identity.callback)
    return app


def main():
    from .spend import LedgerConfigError, require_ledger
    try:
        require_ledger()
    except LedgerConfigError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error
    config = Config.env()
    print(f'ATLAS voice gateway: {config.origin}  |  authentication: {config.auth_mode}')
    print('No model inference is claimed until a PersonaPlex session handshake and audio are received.')
    web.run_app(create_app(config), host=config.bind, port=config.port, access_log=None)

if __name__ == '__main__':
    main()
