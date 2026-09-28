"""End-to-end demo of the Kyutai route through the REAL browser UI and REAL gateway code.

SIMULATED (labelled as such in the UI): speech recognition, speech synthesis and the LLM replies.
REAL: compiled ATLAS page, worklet + orb, gateway, cascade route, analyst + InterviewLedger,
consent, capacity, notes. No provider, GPU or account is contacted; the microphone is Chromium's fake device.

  python scripts/e2e_demo.py            # visible Chrome window, screenshots + results
  python scripts/e2e_demo.py --headless
Output: handoff/verification/e2e-<date>/
"""
import argparse
import asyncio
import datetime
import json
import math
import os
import shutil
import sys
import tempfile
import threading
import time
from dataclasses import replace
from pathlib import Path

import msgpack
from aiohttp import web

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from atlas_voice.config import Config  # noqa: E402
from atlas_voice.kyutai import WARMUP_STEPS  # noqa: E402
from atlas_voice.server import create_app  # noqa: E402

PORT = 8765
ORIGIN = f'http://localhost:{PORT}'
P = lambda v: msgpack.packb(v, use_bin_type=True, use_single_float=True)  # noqa: E731
CONSULTANT = [  # scripted consultant turns (synthetic)
    'Tickets were bouncing between three support teams and urgent cases waited for days.',
    'After the rollout we cut triage time by about 40% according to the service desk report.',
    'I personally rebuilt the routing rules while a colleague owned the dashboard.',
]
AGENT = [  # scripted interviewer lines (synthetic stand-in for the conversation LLM)
    "Hi, I'm ATLAS. What was going wrong for the client when you joined the project?",
    'Urgent cases waiting for days is serious. What changed after the rollout, in practice?',
    'You mentioned about forty percent. What was the typical triage time before the rollout?',
    'Thanks. Who used the new routing day to day after your handover?',
]
TURN_AT = [10.0, 22.0, 34.0]  # seconds after the first microphone frame


class Simulated:
    def __init__(self):
        self.first_audio = None
        self.talker_calls = 0

    async def stt(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_bytes(P({'type': 'Ready'}))
        sent = 0
        async for msg in ws:
            if msgpack.unpackb(msg.data).get('type') != 'Audio':
                continue
            self.first_audio = self.first_audio or time.monotonic()
            await ws.send_bytes(P({'type': 'Step', 'step_idx': 0, 'prs': [0, 0, 0]}))
            if sent < len(TURN_AT) and time.monotonic() - self.first_audio >= TURN_AT[sent]:
                for word in CONSULTANT[sent].split():
                    await ws.send_bytes(P({'type': 'Word', 'text': word, 'start_time': 0.0}))
                for _ in range(WARMUP_STEPS):
                    await ws.send_bytes(P({'type': 'Step', 'step_idx': 1, 'prs': [0, 0, 0]}))
                await ws.send_bytes(P({'type': 'Step', 'step_idx': 2, 'prs': [0, 0, 0.95]}))
                sent += 1
        return ws

    async def tts(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_bytes(P({'type': 'Ready'}))
        text = ''
        async for msg in ws:
            value = msgpack.unpackb(msg.data)
            if value['type'] == 'Text':
                text += value['text']
            elif value['type'] == 'Eos':
                # Synthetic voiced-like tone with syllable envelope: NOT speech, drives the real orb path.
                seconds = min(5.0, 0.055 * len(text))
                n = int(24000 * seconds)
                pcm = [0.22 * abs(math.sin(math.pi * i / 4800)) * math.sin(2 * math.pi * (140 + 40 * math.sin(i / 9000)) * i / 24000)
                       for i in range(n)]
                for start in range(0, n, 1920):
                    await ws.send_bytes(P({'type': 'Audio', 'pcm': pcm[start:start + 1920]}))
                await ws.close()
                break
        return ws

    async def chat(self, request):
        body = await request.json()
        if body.get('tools'):  # analyst: propose the whole segment as an exact quote
            data = json.loads(body['messages'][1]['content'].split('\n', 1)[1])['new_segment']
            text = data['text']
            field = 'outcome' if '%' in text else 'contribution' if 'personally' in text else 'problem'
            call = {'id': 'sim-' + data['item_id'], 'function': {'name': 'record_details', 'arguments': json.dumps(
                {'details': [{'field': field, 'item_id': data['item_id'], 'quote': text}]})}}
            return web.json_response({'choices': [{'message': {'tool_calls': [call]}}]})
        line = AGENT[min(self.talker_calls, len(AGENT) - 1)]
        self.talker_calls += 1
        response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
        await response.prepare(request)
        for word in line.split(' '):
            await response.write(('data: ' + json.dumps({'choices': [{'delta': {'content': word + ' '}}]}) + '\n\n').encode())
            await asyncio.sleep(0.02)
        await response.write(b'data: [DONE]\n\n')
        return response


def serve(vault):
    sim = Simulated()
    loop = asyncio.new_event_loop()
    ready = threading.Event()

    async def main():
        mock = web.Application()
        mock.router.add_get('/api/asr-streaming', sim.stt)
        mock.router.add_get('/api/tts_streaming', sim.tts)
        mock.router.add_post('/chat', sim.chat)
        mr = web.AppRunner(mock, access_log=None)
        await mr.setup()
        site = web.TCPSite(mr, '127.0.0.1', 0)
        await site.start()
        base = '127.0.0.1:%d' % site._server.sockets[0].getsockname()[1]
        cfg = replace(Config(), origin=ORIGIN, port=PORT, voice_provider='kyutai', max_interviews=4,
                      kyutai_stt_url='ws://' + base, kyutai_tts_url='ws://' + base, kyutai_key='SIMULATED',
                      kyutai_voice='simulated/voice.wav', conversation_url=f'http://{base}/chat',
                      conversation_model='SIMULATED-talker', analyst_url=f'http://{base}/chat',
                      analyst_model='SIMULATED-analyst', wiki_root=vault)
        gr = web.AppRunner(create_app(cfg), access_log=None)
        await gr.setup()
        await web.TCPSite(gr, '127.0.0.1', PORT).start()
        ready.set()
        await asyncio.Event().wait()

    threading.Thread(target=lambda: loop.run_until_complete(main()), daemon=True).start()
    if not ready.wait(15):
        raise SystemExit('gateway did not start')


def run(headless, sound=False):
    from playwright.sync_api import sync_playwright
    out = ROOT / 'handoff' / 'verification' / f'e2e-{datetime.date.today():%Y-%m-%d}'
    out.mkdir(parents=True, exist_ok=True)
    results, errors = [], []

    def check(name, ok):
        results.append({'check': name, 'pass': bool(ok)})
        print(('PASS ' if ok else 'FAIL ') + name, flush=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=headless, executable_path=os.getenv('CHROMIUM_PATH') or None,
                                     args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
                                           '--autoplay-policy=no-user-gesture-required']
                                     # The simulated voice is a placeholder tone, not speech: silent unless --sound.
                                     + ([] if sound else ['--mute-audio']))
        context = browser.new_context(viewport={'width': 1440, 'height': 900}, permissions=['microphone'])
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        shot = lambda name: page.screenshot(path=str(out / f'{name}.png'))  # noqa: E731

        def wait_js(expr, arg=None, timeout=20000):
            """Poll with page.evaluate: the gateway CSP (no unsafe-eval) blocks string-predicate waits."""
            deadline = time.monotonic() + timeout / 1000
            while time.monotonic() < deadline:
                try:
                    if page.evaluate(expr, arg) if arg is not None else page.evaluate(expr):
                        return
                except Exception:
                    pass
                page.wait_for_timeout(150)
            raise TimeoutError('timed out waiting for: ' + expr[:80])

        page.goto(ORIGIN)
        wait_js('() => !!(window.AtlasOrbUI && AtlasOrbUI.inspect().frames>2)')
        shot('01-home-orb')
        check('Gateway serves the compiled ATLAS page with the orb rendering', page.locator('#orbCanvas').is_visible())

        page.locator('#studioProject').click()
        page.locator('#studioProjectDrawer [data-action=new-project]').click()
        for k, v in {'projectTitle': 'Project Falcon (synthetic)', 'consultantName': 'Alex Example',
                     'consultantRole': 'Service designer', 'sectorInput': 'Insurance'}.items():
            page.locator('#' + k).fill(v)
        page.locator('#projectStage').select_option('Pilot')
        shot('02-new-project')
        page.locator('#projectForm button[type=submit]').click()
        if page.locator('#studioCloseContext').is_visible():
            page.locator('#studioCloseContext').click()

        page.locator('#voiceStart').click()
        page.locator('#voiceConsentDialog').wait_for(state='visible')
        page.locator('#modelConsent').check()
        if page.locator('#captureConsent').is_enabled():
            page.locator('#captureConsent').check()
        shot('03-consent')
        check('Consent dialog names the selected provider', 'Kyutai voice' in page.locator('#voiceConsentDialog').inner_text())
        page.locator('#voiceConsentStart').click()
        wait_js('() => AtlasVoice.status().phase==="live"')
        check('Live session reached (gateway ready handshake)', True)
        wait_js('() => AtlasOrbUI.inspect().state==="speaking"')
        shot('04-atlas-speaking')
        check('Orb enters speaking state from PCM actually played', True)

        heard = 0
        for n in range(len(CONSULTANT)):
            wait_js("(n)=>((document.getElementById('lastHeard')||{}).textContent||'').includes(n)", CONSULTANT[n][:40], 30000)
            heard += 1
            if n == 1:
                page.wait_for_timeout(1500)
                shot('05-consultant-heard-40-percent')
        page.wait_for_timeout(3000)
        shot('06-follow-up-and-evidence')
        check('Each consultant turn reached the page as unverified transcript', heard == len(CONSULTANT))
        check('Agent words streamed to the page', 'triage time before' in page.locator('body').inner_text() or 'handover' in page.locator('body').inner_text())
        rows = page.evaluate("document.querySelectorAll('#candidateLedger .candidate-row').length")
        count = page.evaluate("(document.getElementById('qualityLiveCount')||{}).textContent||''")
        nxt = page.evaluate("(document.getElementById('qualityNext')||{}).textContent||''")
        check(f'Live evidence ledger shows quote-linked details ({rows} rows, "{count}")', rows >= 3 and 'unverified' in count)
        check(f'Ledger plans the next probe from the evidence ("{nxt}")', bool(nxt) and 'What changed, why did it matter' not in nxt)

        page.locator('#voiceEnd').click()
        page.locator('#voiceNotesDialog').wait_for(state='visible', timeout=20000)
        page.wait_for_timeout(800)
        shot('07-notes-for-review')
        notes = page.locator('#voiceNotesDialog').inner_text()
        check('Notes dialog holds quote-linked candidate notes', 'triage time by about 40%' in notes or 'triage time' in page.locator('#consultantTranscript').input_value())
        check('Microphone released after End', page.evaluate('!AtlasVoice.status().hasMicrophone'))
        page.keyboard.press('Escape')

        for view in ('projects', 'stories'):
            loc = page.locator(f'header [data-view={view}]')
            if loc.count():
                loc.first.click()
                page.wait_for_timeout(600)
                shot(f'08-{view}')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('header [data-view=interview]').first.click()
        page.wait_for_timeout(600)
        shot('09-mobile')
        check('No JavaScript errors', not errors)
        browser.close()
    summary = {'date': str(datetime.date.today()), 'scope': 'real UI + gateway + cascade + analyst/ledger; SIMULATED STT/TTS/LLM; fake microphone',
               'passed': sum(r['pass'] for r in results), 'total': len(results), 'results': results, 'errors': errors[:5]}
    (out / 'results.json').write_text(json.dumps(summary, indent=2))
    print(f"\n{summary['passed']}/{summary['total']} checks passed. Screenshots: {out}")
    return 0 if summary['total'] and summary['passed'] == summary['total'] else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--sound', action='store_true', help='play the placeholder tone (it is not a voice)')
    args = parser.parse_args()
    vault = tempfile.mkdtemp(prefix='atlas-e2e-')
    try:
        serve(vault)
        raise SystemExit(run(args.headless, args.sound))
    finally:
        shutil.rmtree(vault, ignore_errors=True)
