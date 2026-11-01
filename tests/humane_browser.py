"""The humane interview UI (Agent Brain v2.1 T9, T10, T11, T15) in a real browser against the local edge: the real Worker handle(), the real Library with the evidence
store, review machine, policy gate and mock destinations (node:sqlite), and the built page (deploy/cloudflare-edge/src/atlas.html). Loopback only: no provider, no network.
The voice WebSocket is a scripted stand-in answered in the browser (the local edge serves no WebSocket, as in zero_config_edge_browser.py): it plays what the Interview
Durable Object would announce and send (ready with controls, state, user_text, restore, summary, evidence_draft). Everything the page then does with the library
(saving the draft, Submit for review, the workflow status cards) is the real server. The evidence draft is filed through dev/local-edge.mjs /__evidence_draft, the
same post the Interview Durable Object makes on a confirmed read-back.
  python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html && python3 tests/humane_browser.py
Covers: controls only when the server announces them; Pause (caption, orb, clock), Resume, Repeat, Skip; a typed answer; the reconnect status and the "Resume your
interview?" prompt (Resume, Start over); the read-back card (Correct, Keep private, Confirm, a typed correction, "Saved as a private draft", the separate "Submit for
review" with expected_revision); the workflow status cards (mock badge, never one "complete"); keyboard use and aria labels; no horizontal overflow at 390 px; no page errors.
X1 (text-only interview): "Type instead" before starting (no microphone permission is given and none is asked for), a typed interview from the greeting text through typed answers,
the summary card and the confirmed draft; the typed text kept in the box until the server takes the turn (and a gentle note when it does not); a kept-private utterance replaced on
screen by "[kept private]"; a resumed typed interview; keyboard use, aria-live, focus after each reply, reduced motion, 390 px.
Not covered (needs a live voice model): what ATLAS says, audio, the microphone path beyond the browser's fake device (COVERAGE.md).
"""
import json, math, os, re, socket, struct, subprocess, sys, time, urllib.request
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
PAGE = EDGE / 'src/atlas.html'
ERR, PROCS = [], []
SID = 'ab' * 16
USER = 'alex@mantu.com'
REVIEWER = 'reviewer@mantu.com'
NOTES = {'session_id': 'humane-browser-1', 'project_ref': 'PRJ-1', 'details': [
    {'id': 'D-001', 'field': 'problem', 'item_id': 'user-1', 'quote': 'Claims were bouncing between three teams and payouts were slow.', 'status': 'reported'},
    {'id': 'D-002', 'field': 'contribution', 'item_id': 'user-1', 'quote': 'I designed and built the routing model.', 'status': 'reported'},
    {'id': 'D-003', 'field': 'measurement', 'item_id': 'user-2', 'quote': 'Triage fell from 40 to 12 minutes according to the dashboard.', 'status': 'uncertain'}]}
ITEMS = [
    {'detail_id': 'D-001', 'field': 'problem', 'label': 'Problem', 'quote': 'Claims were bouncing between three teams and payouts were slow.', 'status': 'reported', 'asr_unconfirmed': False, 'provenance': 'unverified_speech_recognition'},
    {'detail_id': 'D-002', 'field': 'contribution', 'label': 'Contribution', 'quote': 'I designed and built the routing model.', 'status': 'reported', 'asr_unconfirmed': False, 'provenance': 'unverified_speech_recognition'},
    {'detail_id': 'D-003', 'field': 'measurement', 'label': 'Measurement', 'quote': 'Triage fell from 40 to 12 minutes according to the dashboard.', 'status': 'uncertain', 'asr_unconfirmed': False, 'provenance': 'unverified_speech_recognition'}]
# What the real Session announces in `ready` (read from the source so the stand-in cannot drift from it).
CONTROLS = re.findall(r"'([a-z_]+)'", re.search(r'export const CONTROLS = Object\.freeze\(\[(.*?)\]\)', (EDGE / 'src/session.js').read_text()).group(1))
TYPED = 'The median handling time dropped from fourteen minutes to nine minutes.'
CORRECTION = 'It was one team and one queue, not the whole company.'


def check(name, value):
    print(('PASS ' if value else 'FAIL ') + name, flush=True)
    assert value, name


# U1: the local edge announces voice:false (no speech service); this suite stands in for the voice socket, so it asks for the voice start (ATLAS_VOICE=on)
def start_edge():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    env = {k: v for k, v in os.environ.items() if k not in ('DATA_MODE', 'DIRECTORY_PUSH_SECRET', 'IDENTITY_SOURCE') and not k.startswith('DNA_')}
    proc = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(port)], cwd=EDGE, env={**env, 'ATLAS_ADAPTERS': 'mock', 'ATLAS_VOICE': 'on'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    PROCS.append(proc)
    base = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try: urllib.request.urlopen(base + '/__settle', timeout=1); break
        except Exception: time.sleep(.1)
    return base


def wait(p, cond, timeout=8):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond(): return True
        p.wait_for_timeout(100)
    return cond()


class Voice:
    """The scripted stand-in for the voice WebSocket. controls: what `ready` announces (a gateway that announces none must get no control UI)."""
    def __init__(s, controls=None, draft=None, text=False, language=None):
        s.language = language;   # v2.2 L1: the language object the stand-in announces in `ready` (None: none, as an older server)
        s.controls = controls; s.draft = draft or {}; s.frames = []; s.sock = None; s.sockets = 0; s.hold = False; s.held = []; s.summary_items = [dict(i) for i in ITEMS]
        s.text = text; s.binary = 0; s.refuse = None; s.typed = []   # text: a typed interview (start mode 'text'); refuse: the reason the stand-in refuses the next typed turn

    def send(s, **event): s.sock.send(json.dumps(event))

    def summary(s): s.send(type='summary', items=s.summary_items, unknowns=[{'kind': 'unknown', 'field': 'decision', 'label': 'Decision'}], state='summary', round=1)

    def __call__(s, ws):
        s.sock = ws; s.sockets += 1
        def on(m):
            if isinstance(m, bytes): s.binary += 1; return
            d = json.loads(m); s.frames.append(d); t = d.get('type')
            if t == 'start':
                def ready():
                    resumed = d.get('resume') is not None
                    ws.send(json.dumps({'type': 'ready', 'mode': 'full', 'model': 'ATLAS', 'provider': 'ATLAS voice', 'sampleRate': 24000, 'capture': True, 'liveLedger': True, 'maxSeconds': 900,
                                        'speakingSeconds': 600, 'message': 'ready', **({'input': 'text'} if d.get('mode') == 'text' else {}), 'sessionId': SID, 'resumable': True, **({'resumed': True} if resumed else {}), **({'language': s.language, 'voices': ['en', 'es']} if s.language else {}), **({'controls': s.controls} if s.controls else {}),
                                        'timePlan': {'depthAt': 405, 'closingAt': 690}}))
                    if resumed:
                        ws.send(json.dumps({'type': 'restore', 'user': [{'item_id': 'user-1', 'text': 'We rebuilt the claims intake process for the insurance client.', 'provenance': 'unverified_speech_recognition'}],
                                            'agent': ['Hi, I am ATLAS.', 'What was the baseline?'], 'lastQuestion': 'What was the baseline?', 'activeSeconds': 95}))
                    else: ws.send(json.dumps({'type': 'agent_text', 'text': 'Bonjour, je suis ATLAS. Quel était le projet ?' if s.language else "Hi, I'm ATLAS. What was the project?"}))
                if s.hold and d.get('resume') is not None: s.held.append(ready)
                else: ready()
            elif t == 'pause': ws.send(json.dumps({'type': 'state', 'state': 'paused', 'event': 'pause', 'actor': 'consultant'}))
            elif t == 'resume':
                ws.send(json.dumps({'type': 'state', 'state': 'discovery', 'event': 'resume', 'actor': 'consultant'}))
                ws.send(json.dumps({'type': 'agent_text', 'text': '\n\nWelcome back. What was the baseline?'}))
            elif t == 'repeat': ws.send(json.dumps({'type': 'agent_text', 'text': '\n\nOf course. What was the baseline?'}))
            elif t == 'text':
                if s.refuse:   # the session refuses the turn (rate limit, still composing, the protected greeting): a quality_warning that says which, and no user_text
                    ws.send(json.dumps({'type': 'quality_warning', 'message': 'ATLAS is still replying.', 'refused': 'text', 'reason': s.refuse})); return
                s.typed.append(('user-typed-%d' % (len(s.typed) + 1), d['text']))
                ws.send(json.dumps({'type': 'user_text', 'item_id': s.typed[-1][0], 'text': d['text'], 'provenance': 'consultant_typed'}))
                ws.send(json.dumps({'type': 'agent_text', 'text': ('\n\nMerci. Sur quelle période cela a-t-il été mesuré ?' if s.language else '\n\nThanks. Over what period was that measured?') if len(s.typed) < 3 else '\n\nThat helps. What did the team change?'}))
            elif t == 'correct':
                for i in s.summary_items:
                    if i['detail_id'] == d['detail_id']: i.update(quote=d['text'], provenance='consultant_typed', detail_id='D-004')
                s.summary()
            elif t == 'withhold':
                s.summary_items = [i for i in s.summary_items if i['detail_id'] != d['detail_id']]; s.summary()
                if s.text and s.typed: ws.send(json.dumps({'type': 'user_text_private', 'items': [s.typed[-1][0]]}))   # what the session announces for the utterance the detail came from
            elif t == 'confirm_summary':
                ws.send(json.dumps({'type': 'summary_confirmed'}))
                ws.send(json.dumps({'type': 'evidence_draft', 'id': s.draft['id'], 'revision': s.draft['revision'], 'unchanged': False}))
            elif t == 'end':
                for e in [{'type': 'audio_stopped'}, {'type': 'reporting'}, {'type': 'notes', 'transcript': '', 'sections': ['', '', '', '', '', ''], 'status': 'candidate', 'message': 'No transcript in this stand-in.'}, {'type': 'ended', 'message': 'closed'}]:
                    ws.send(json.dumps(e))
        ws.on_message(on)


if not PAGE.exists() or 'voicePause' not in PAGE.read_text():
    print('NOT RUNNABLE: deploy/cloudflare-edge/src/atlas.html is missing or older than the humane controls. Run: python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html')
    sys.exit(2)
code = 0
try:
    BASE = start_edge()

    def http_json(path, who, method='GET', body=None):
        req = urllib.request.Request(BASE + path + ('&' if '?' in path else '?') + 'as=' + who, data=json.dumps(body).encode() if body is not None else None, method=method)
        return json.loads(urllib.request.urlopen(req, timeout=15).read())

    draft = http_json('/__evidence_draft', USER, 'POST', NOTES)
    check('a private draft is filed for alex (as the interview would on a confirmed read-back)', draft['state'] == 'evidence_draft' and draft['revision'] == 1 and draft['mine'] is True)

    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])

        MIC_COUNT = "window.__mic=0;const g=navigator.mediaDevices&&navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);if(g)navigator.mediaDevices.getUserMedia=(...a)=>{window.__mic++;return g(...a)};"
        def open_page(who, voice, path='/', w=1280, resumable=False, discard=None, mic=True):
            ctx = br.new_context(permissions=['microphone'] if mic else [], viewport={'width': w, 'height': 1000})
            p = ctx.new_page(); p.on('pageerror', lambda e: ERR.append(who + ': ' + str(e))); p.add_init_script(MIC_COUNT)
            p.requests = []; p.on('request', lambda r: p.requests.append((r.method, urlparse(r.url).path, r.post_data or '', r.headers)) if '/api/' in r.url else None)
            p.voice = voice; p.route_web_socket('**/api/voice', voice)
            if resumable:  # the Interview Durable Object is not in the local edge: say what its /api/checkpoint would say, on the real bootstrap
                def boot(route):
                    resp = route.fetch(); body = resp.json()
                    if not discard: body['resumable'] = {'sessionId': SID, 'savedAt': int(time.time() * 1000) - 60000, 'expiresAt': int(time.time() * 1000) + 86400000, **({'input': 'text'} if resumable == 'text' else {})}  # once discarded, the server has nothing to resume
                    route.fulfill(response=resp, json=body)
                p.route('**/api/bootstrap', boot)
            if discard is not None: p.route('**/api/checkpoint/discard', lambda route: (discard.append(route.request.headers), route.fulfill(json={'discarded': True}))[1])
            p.goto(BASE + path + ('&' if '?' in path else '?') + 'as=' + who); p.wait_for_timeout(900)
            return p

        def start_interview(p):
            p.locator('#voiceStart').click(); p.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
            p.locator('#modelConsent').check(); p.locator('#voiceConsentStart').click()
            p.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=10000)

        def no_overflow(p): return p.evaluate('document.scrollingElement.scrollWidth<=document.scrollingElement.clientWidth+1')
        def frames_of(p, kind): return [f for f in p.voice.frames if f.get('type') == kind]

        # ---- 1. a server that announces no controls gets none
        v0 = Voice(controls=None, draft=draft)
        p0 = open_page(USER, v0); start_interview(p0)
        check('no controls announced: Pause, Repeat and the typed answer stay hidden (Stop is not an announced control: it is there while live)', all(p0.locator(s).is_hidden() for s in ('#voicePause', '#voiceRepeat', '#voiceTypeForm')) and p0.locator('#voiceEnd').is_visible() and p0.locator('#voiceEndLabel').inner_text() == 'Stop interview' and p0.locator('#voiceSkip').count() == 0)
        p0.locator('#voiceEnd').click(); p0.locator('#voiceEndConfirm').click(); p0.wait_for_function('()=>AtlasVoice.status().phase==="idle"', timeout=8000)
        check('and nothing was sent to a gateway that never announced them', all(f.get('type') in ('start', 'end') for f in v0.frames))

        # ---- 2. the resume prompt on page load, then Resume
        discard = []
        vb = Voice(controls=CONTROLS, draft=draft)
        pb = open_page(USER, vb, resumable=True, discard=discard)
        pb.locator('#voiceResumeDialog').wait_for(state='visible', timeout=8000)
        dlg = pb.locator('#voiceResumeDialog')
        check('the saved interview is offered before anything else: "Resume your interview?" with Resume and Start over', pb.locator('#voiceResumeTitle').inner_text() == 'Resume your interview?'
              and dlg.get_by_role('button', name='Resume').count() == 1 and dlg.get_by_role('button', name='Start over').count() == 1)
        check('the dialog is labelled and says what Start over does and when the copy expires', pb.get_attribute('#voiceResumeDialog', 'aria-labelledby') == 'voiceResumeTitle' and 'deletes the saved interview' in pb.locator('#voiceResumeNote').inner_text())
        # Start over deletes it on the server first (same Origin + CSRF as every other POST), then the way to a new interview opens.
        dlg.get_by_role('button', name='Start over').click(); pb.wait_for_timeout(800)
        check('Start over: the discard request carries the CSRF token, the dialog closes, no interview was started', len(discard) == 1 and bool(discard[0].get('x-atlas-csrf')) and not dlg.is_visible() and not frames_of(pb, 'start'))
        pb.close()
        vr = Voice(controls=CONTROLS, draft=draft)
        pr = open_page(USER, vr, resumable=True)
        pr.locator('#voiceResumeDialog').wait_for(state='visible', timeout=8000)
        pr.locator('#voiceResumeDialog').get_by_role('button', name='Resume').click()
        pr.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=10000); pr.wait_for_timeout(500)
        start = frames_of(pr, 'start')[0]
        check('Resume starts the interview with the saved interview\'s id, and no consent dialog is shown again', start.get('resume') == SID and not pr.locator('#voiceConsentDialog').is_visible())
        check('the screens come back where they were: ATLAS\'s words, the question, the clock', 'What was the baseline?' in pr.locator('#agentText').inner_text() and 'Interview resumed. The question was: What was the baseline?' in pr.locator('#orbAccessibleState').inner_text())

        # ---- 3. controls are announced: Pause, Resume, Repeat, Stop
        check('the server announced the controls: Pause, Repeat, Stop interview and the typed answer are shown and enabled, and there is no Skip', all(pr.locator(s).is_visible() and pr.locator(s).is_enabled() for s in ('#voicePause', '#voiceRepeat', '#voiceEnd', '#voiceTypeInput')) and pr.locator('#voiceSkip').count() == 0)
        check('every control has its own accessible name', pr.get_attribute('#voicePause', 'aria-label') == 'Pause the interview' and pr.get_attribute('#voiceRepeat', 'aria-label') == 'Ask me the last question again'
              and pr.get_attribute('#voiceEnd', 'aria-label') == 'Stop the interview' and pr.get_attribute('#voiceTypeSend', 'aria-label') == 'Send your typed answer'
              and pr.evaluate("document.querySelector('label[for=voiceTypeInput]').textContent.trim()") == 'Type your answer instead of speaking')
        t0 = pr.locator('#voiceTimer').inner_text(); pr.wait_for_timeout(1300)
        check('the interview clock runs, starting from the restored 01:35', t0 >= '01:35' and pr.locator('#voiceTimer').inner_text() > t0)
        pr.locator('#voicePause').focus(); pr.keyboard.press('Enter'); pr.wait_for_timeout(500)   # keyboard: Enter on the focused button
        check('Pause (keyboard): one pause message is sent', len(frames_of(pr, 'pause')) == 1)
        cap = pr.locator('#orbStateCaption').inner_text().lower()  # the caption is set in capitals by the stylesheet
        check('Paused: the caption says so, the orb is not speaking, the microphone is off, and the button now reads Resume', cap.startswith('paused') and pr.evaluate("document.getElementById('voicePanel').dataset.orbState") != 'speaking'
              and pr.locator('#orbInputWord').inner_text() == 'Paused' and pr.locator('#voicePause').inner_text() == 'Resume interview' and pr.get_attribute('#voicePause', 'aria-label') == 'Resume the interview')
        check('Paused: Repeat is off, the mute button is off, Stop interview still works, the typed answer still works', pr.locator('#voiceRepeat').is_disabled() and pr.locator('#voiceEnd').is_enabled() and pr.locator('#voiceMute').is_disabled() and pr.locator('#voiceTypeInput').is_enabled())
        t1 = pr.locator('#voiceTimer').inner_text(); pr.wait_for_timeout(2300)
        check('Paused: the clock stops', pr.locator('#voiceTimer').inner_text() == t1)
        pr.locator('#voicePause').click(); pr.wait_for_timeout(2300)
        check('Resume: one resume message, the caption and the clock carry on, Repeat is back', len(frames_of(pr, 'resume')) == 1 and not pr.locator('#orbStateCaption').inner_text().lower().startswith('paused')
              and pr.locator('#voiceTimer').inner_text() > t1 and pr.locator('#voiceRepeat').is_enabled() and 'Welcome back' in pr.locator('#agentText').inner_text())
        pr.locator('#voiceRepeat').click(); pr.wait_for_timeout(400)
        check('Repeat: one repeat message, and the question is said again on screen', len(frames_of(pr, 'repeat')) == 1 and 'Of course. What was the baseline?' in pr.locator('#agentText').inner_text())
        pr.locator('#voiceEnd').click(); pr.locator('#voiceEndDialog').wait_for(state='visible')
        check('Stop interview: the sheet offers Stop and review what you said, Discard everything and Cancel (nothing is sent yet)', pr.locator('#voiceEndConfirm').inner_text() == 'Stop and review what you said' and pr.locator('#voiceEndDiscard').inner_text() == 'Discard everything' and pr.locator('#voiceEndTitle').inner_text() == 'Stop the interview?'
              and pr.locator('#voiceEndDialog').get_by_role('button', name='Cancel', exact=True).count() >= 1 and not frames_of(pr, 'end') and not frames_of(pr, 'discard'))
        pr.locator('#voiceEndDialog [data-voice-close]').last.click(); pr.wait_for_timeout(300)
        check('Cancel leaves the interview running', pr.evaluate('AtlasVoice.status().phase') == 'live' and not pr.locator('#voiceEndDialog').is_visible() and not frames_of(pr, 'end') and not frames_of(pr, 'discard'))
        # ---- 4. a typed answer
        pr.locator('#voiceTypeInput').fill(TYPED); pr.keyboard.press('Enter'); pr.wait_for_timeout(500)
        typed = frames_of(pr, 'text')
        check('a typed answer: sent once as {type:text}, the field is cleared, the screen says what was typed, and the board shows it is being analysed', len(typed) == 1 and typed[0] == {'type': 'text', 'text': TYPED}
              and pr.locator('#voiceTypeInput').input_value() == '' and TYPED in pr.locator('#voiceMessage').inner_text() and 'analysing' in pr.locator('#boardChallenge').inner_text())
        pr.locator('#voiceTypeInput').fill('   '); check('an empty typed answer cannot be sent', pr.locator('#voiceTypeSend').is_disabled())

        # ---- 5. the connection drops: Reconnecting, then back (the saved interview is resumed by itself)
        vr.hold = True; vr.sock.close(); pr.wait_for_function('()=>document.getElementById("voiceState").textContent==="Reconnecting…"', timeout=5000)
        check('the socket drops: the page says Reconnecting…, and what has been said is kept on screen', 'Your interview is saved on the server' in pr.locator('#voiceMessage').inner_text() and 'What was the baseline?' in pr.locator('#agentText').inner_text())
        check('while reconnecting, End and Restart cannot be pressed by accident', pr.locator('#voiceEnd').is_disabled() and pr.locator('#voiceRestart').is_disabled())
        wait(pr, lambda: bool(vr.held), 8)
        resume = [f for f in vr.frames if f.get('type') == 'start' and f.get('resume')]
        check('the retry asks for the same interview: a start with resume=<id>, from the same page, no new consent', len(resume) == 2 and resume[-1]['resume'] == SID)
        vr.held.pop()(); wait(pr, lambda: pr.locator('#voiceHeading').inner_text().startswith('You’re back'), 8)
        check('it comes back: "You\'re back", the controls are live again', pr.locator('#voiceHeading').inner_text().startswith('You’re back') and pr.locator('#voiceEnd').is_enabled() and pr.locator('#voicePause').is_enabled())
        vr.hold = False

        # ---- 6. the read-back card
        vr.summary(); pr.locator('#summaryCard').wait_for(state='visible', timeout=5000)
        check('the read-back shows each item in the consultant\'s words, with Correct and Keep private, and one Confirm summary', pr.locator('#summaryItems .summary-item').count() == 3
              and pr.locator('#summaryItems [data-action=correct]').count() == 3 and pr.locator('#summaryItems [data-action=withhold]').count() == 3 and pr.locator('#summaryConfirm').is_visible())
        check('an estimate is labelled as the consultant\'s own estimate; an open point is listed; the card says nothing is verified', 'you called this an estimate' in pr.locator('#summaryItems .summary-item[data-detail=D-003]').inner_text()
              and 'Still open, in your own words: Decision' in pr.locator('#summaryOpen').inner_text() and 'unverified' in pr.locator('#summaryCard .board-label').inner_text())
        check('buttons carry accessible names that say which item', pr.get_attribute('#summaryItems [data-detail=D-002] [data-action=correct]', 'aria-label') == 'Correct: Contribution'
              and pr.get_attribute('#summaryItems [data-detail=D-002] [data-action=withhold]', 'aria-label') == 'Keep private: Contribution' and pr.get_attribute('#summaryLive', 'aria-live') == 'polite')
        # keyboard: focus Correct on the contribution item, Enter opens the field and focuses it, type, Enter sends
        pr.locator('#summaryItems [data-detail=D-002] [data-action=correct]').focus(); pr.keyboard.press('Enter'); pr.wait_for_timeout(200)
        check('Correct (keyboard) opens a labelled field and focuses it', pr.evaluate('document.activeElement.id') == 'summaryEdit-D-002' and pr.evaluate("document.querySelector('label[for=summaryEdit-D-002]').textContent") == 'Your correction, in your own words')
        pr.keyboard.type('ok'); pr.keyboard.press('Enter'); pr.wait_for_timeout(200)
        check('a correction under five characters is refused on the page, nothing is sent', 'at least five characters' in pr.locator('#summaryMessage').inner_text() and not frames_of(pr, 'correct'))
        pr.locator('#summaryEdit-D-002').fill(CORRECTION); pr.keyboard.press('Enter'); pr.wait_for_timeout(600)
        sent = frames_of(pr, 'correct')
        check('the typed correction is sent as {type:correct, detail_id, text}', len(sent) == 1 and sent[0] == {'type': 'correct', 'detail_id': 'D-002', 'text': CORRECTION})
        item = pr.locator('#summaryItems [data-detail=D-004]')
        check('the card updates: the item now reads as the correction, tagged "typed by you", and the old words are gone', item.count() == 1 and CORRECTION in item.inner_text() and 'typed by you' in item.inner_text()
              and 'built the routing model' not in pr.locator('#summaryItems').inner_text())
        pr.locator('#summaryItems [data-detail=D-001] [data-action=withhold]').click(); pr.wait_for_timeout(500)
        check('Keep private: one withhold message; the line stays in its block as "Kept private. Not used." with its words gone (W1: visibly excluded, not silently removed)', frames_of(pr, 'withhold') == [{'type': 'withhold', 'detail_id': 'D-001'}] and pr.locator('#summaryItems [data-detail=D-001].is-kept').count() == 1 and 'Kept private. Not used.' in pr.locator('#summaryItems [data-detail=D-001]').inner_text() and pr.locator('#summaryItems .summary-item').count() == 3 and pr.locator('#summaryItems [data-detail=D-001] button').count() == 0)
        check('at 390 px the live interview with the read-back card does not scroll sideways', (pr.set_viewport_size({'width': 390, 'height': 844}), pr.wait_for_timeout(300), no_overflow(pr))[2])
        pr.set_viewport_size({'width': 1280, 'height': 1000}); pr.wait_for_timeout(200)
        pr.locator('#summaryConfirm').focus(); pr.keyboard.press('Enter'); pr.wait_for_timeout(1200)
        check('Confirm summary (keyboard): one confirm_summary message', len(frames_of(pr, 'confirm_summary')) == 1)
        check('confirmed: "Saved as a private draft", and a SEPARATE Submit for review is offered, not yet pressed', 'Saved as a private draft' in pr.locator('#summarySaved').inner_text() and pr.locator('#summarySubmit').is_visible()
              and pr.locator('#summarySubmit').inner_text() == 'Submit for review' and 'Not submitted yet' in pr.locator('#summaryMessage').inner_text() and pr.locator('#summaryConfirm').is_hidden())
        mine = http_json('/api/library/evidence/' + draft['id'], USER)
        check('on the server it is still the owner\'s private draft: nobody else can see it and nothing was submitted', mine['state'] == 'evidence_draft' and mine['revision'] == 1)
        try: http_json('/api/library/evidence/' + draft['id'], 'kim@mantu.com'); other = 200
        except urllib.error.HTTPError as e: other = e.code
        check('another signed-in person gets 404 for it', other == 404)
        n = len(pr.requests)
        pr.locator('#summarySubmit').click(); pr.wait_for_timeout(1500)
        posts = [(m, path, body) for m, path, body, _ in pr.requests[n:] if m == 'POST' and path.endswith('/submit')]
        check('Submit for review: ONE library POST to /evidence/<id>/submit with expected_revision 1', len(posts) == 1 and posts[0][1] == '/api/library/evidence/' + draft['id'] + '/submit' and json.loads(posts[0][2]) == {'expected_revision': 1})
        check('the card says it was submitted and the button is spent', 'Submitted for review' in pr.locator('#summaryMessage').inner_text() and pr.locator('#summarySubmit').is_disabled())
        submitted = http_json('/api/library/evidence/' + draft['id'], USER)
        check('on the server it is now in the reviewer queue', submitted['state'] == 'reviewer_queue' and submitted['revision'] == 1)
        pr.wait_for_timeout(800)
        check('the status list under the card shows the seven steps, none of them complete', pr.locator('#summaryStatus li').count() == 7 and not any('Synced' in t or 'Published' in t for t in pr.locator('#summaryStatus li').all_inner_texts()))

        # ---- 7. approval, then the workflow status cards (the mock destinations)
        def api(p, path, method='GET', body=None):   # the real library routes, through the page (Origin and CSRF as every browser POST)
            return p.evaluate("([p,o])=>window.ATLAS_APP.libraryApi(p,o||{})", [path, {'method': method, **({'body': body} if body is not None else {})}])
        for purpose in ('skills_profile', 'cv', 'matching'): api(pr, '/evidence/' + draft['id'] + '/permissions', 'POST', {'expected_revision': 1, 'purpose': purpose})
        # (the grants above are the owner's own act through the real route; a reviewer then approves the exact revision and hash)
        rv = open_page(REVIEWER, Voice(draft=draft))
        approved = api(rv, '/evidence/' + draft['id'] + '/review', 'POST', {'action': 'approve', 'expected_revision': 1, 'content_hash': submitted['content_hash']})
        check('a reviewer approves the exact revision and hash (the real review route)', approved['state'] == 'downstream_proposals' and approved['approval']['revision'] == 1)  # approved, and the knowledge is already proposed downstream
        lib = open_page(USER, Voice(draft=draft)); lib.locator('header [data-view=library]').click(); lib.wait_for_timeout(500)
        lib.locator('#workflowStatus .wf-card').first.wait_for(state='visible', timeout=10000)
        cards = lib.locator('#workflowStatus .wf-card')
        check('the workflow status shows seven cards in the pack\'s order', cards.count() == 7 and [c.get_attribute('data-branch') for c in cards.all()] == ['evidence', 'maap', 'project_review', 'dna', 'michat', 'imp', 'spotlight'])
        mocks = {c.get_attribute('data-branch'): c.locator('.wf-mock').inner_text() for c in cards.all() if c.locator('.wf-mock').count()}
        check('every destination that is not really connected carries "Mock — not connected"', mocks == {b: 'Mock — not connected' for b in ('dna', 'michat', 'imp', 'spotlight')})
        check('DNA reads "Mock acknowledged — not synced", never "Synced"', 'Mock acknowledged — not synced' in lib.locator('[data-branch=dna]').inner_text() and 'Synced' not in lib.locator('#workflowStatus').inner_text())
        check('MAAP and Project Review say their rubric is not configured by its owner, and show no rating', 'not been configured by its process owner' in lib.locator('[data-branch=maap]').inner_text() and 'not been configured by its process owner' in lib.locator('[data-branch=project_review]').inner_text()
              and not re.search(r'rating|score', lib.locator('[data-branch=maap]').inner_text(), re.I))
        overall = lib.locator('#workflowStatus .wf-overall')
        check('there is no overall "complete": the overall line says what still needs attention, and is a status region', overall.get_attribute('data-overall') != 'complete' and 'Everything is finished' not in overall.inner_text() and overall.get_attribute('role') == 'status')
        check('the record picker and Refresh are labelled and reachable by keyboard', lib.get_attribute('#workflowPick', 'aria-label') == 'Evidence record' and lib.locator('#workflowRefresh').is_enabled())
        lib.locator('#workflowRefresh').focus(); lib.keyboard.press('Enter'); lib.wait_for_timeout(600)
        check('Refresh by keyboard keeps the same seven cards', lib.locator('#workflowStatus .wf-card').count() == 7)
        lib.set_viewport_size({'width': 390, 'height': 844}); lib.wait_for_timeout(300)
        check('at 390 px the library view with the workflow cards does not scroll sideways', no_overflow(lib))
        check('at 390 px the cards stay readable: every card is inside the viewport', lib.evaluate("[...document.querySelectorAll('#workflowStatus .wf-card')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})"))

        # ---- 8. X1: a typed interview (no microphone permission is given, and none may be asked for)
        vt = Voice(controls=CONTROLS, draft=draft, text=True)
        pt = open_page(USER, vt, mic=False)
        pt.locator('#voiceStartText').wait_for(state='visible', timeout=8000)
        check('before starting, "Type instead" sits next to Start conversation (the server announced typed interviews)', pt.locator('#voiceStartText').inner_text() == 'Type instead' and pt.locator('#voiceStart').is_visible())
        pt.locator('#voiceStartText').click(); pt.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000)
        check('the consent dialog offers both ways in, the typed one leading, both waiting for the one consent tick',
              pt.locator('#voiceConsentType').is_visible() and pt.locator('#voiceConsentStart').is_visible() and pt.locator('#voiceConsentType').is_disabled() and pt.locator('#voiceConsentStart').is_disabled()
              and pt.get_attribute('#voiceConsentDialog', 'data-input') == 'text' and 'no microphone is used' in pt.locator('#consentTip').inner_text().lower())
        pt.locator('#modelConsent').check()
        check('ticking enables both starts', pt.locator('#voiceConsentType').is_enabled() and pt.locator('#voiceConsentStart').is_enabled())
        pt.locator('#voiceConsentType').click(); pt.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=10000); pt.wait_for_timeout(700)
        check('the start message asks for mode text (no other new key), and the page never asked for the microphone', frames_of(pt, 'start')[0].get('mode') == 'text' and pt.evaluate('window.__mic') == 0
              and pt.evaluate('AtlasVoice.status().hasMicrophone===false&&AtlasVoice.status().hasAudioContext===false&&AtlasVoice.status().textMode===true'))
        check('the greeting is on screen as text, in a labelled conversation log that announces politely', ('Hi, I\'m ATLAS.' in pt.locator('#textLog').inner_text() and 'What was the project?' in pt.locator('#textLog').inner_text())
              and pt.get_attribute('#textLog', 'role') == 'log' and pt.get_attribute('#textLog', 'aria-live') == 'polite' and pt.get_attribute('#textLog', 'aria-label') == 'Conversation')
        check('no microphone anywhere: Mute is gone, the orb is idle (no listening or speaking motion), the caption says typed interview', pt.locator('#voiceMute').is_hidden()
              and pt.evaluate("document.getElementById('voicePanel').dataset.orbState") == 'idle' and 'typed interview' in pt.locator('#orbStateCaption').inner_text().lower()
              and pt.locator('.orb-meters').is_hidden() and 'Typed interview' in pt.locator('#connectionStateLabel').inner_text())
        check('the answer box is focused when the interview opens, under the conversation', pt.evaluate('document.activeElement.id') == 'voiceTypeInput'
              and pt.evaluate("document.getElementById('textLog').nextElementSibling.contains(document.getElementById('voiceTypeInput'))"))
        ANS1 = 'We rebuilt the claims intake process for a large insurer, and I led the design.'
        pt.locator('#voiceTypeInput').fill(ANS1); pt.keyboard.press('Enter'); pt.wait_for_timeout(600)
        log = pt.locator('#textLog .msg')
        check('a typed answer: sent once, cleared when the server took it, shown as "You", and ATLAS\'s reply follows in the log',
              [f['text'] for f in frames_of(pt, 'text')] == [ANS1] and pt.locator('#voiceTypeInput').input_value() == '' and log.count() == 4   # W1: the opening is two bubbles (greeting, question)
              and log.nth(2).inner_text().lower().startswith('you') and ANS1 in log.nth(2).inner_text() and 'Over what period was that measured?' in log.nth(3).inner_text())
        check('after the reply the cursor is back in the answer box', pt.evaluate('document.activeElement.id') == 'voiceTypeInput')
        # kept until accepted: the session refuses the turn, the text stays and a gentle note says so
        ANS2 = 'It ran for about six months, and the baseline was forty minutes per claim.'
        vt.refuse = 'speaking'; pt.locator('#voiceTypeInput').fill(ANS2); pt.keyboard.press('Enter'); pt.wait_for_timeout(500)
        check('refused while ATLAS speaks: the text is still in the box, the note says "I\'ll take that as soon as I finish speaking", and the log did not change',
              pt.locator('#voiceTypeInput').input_value() == ANS2 and "I\u2019ll take that as soon as I finish speaking" in pt.locator('#voiceTypeNote').inner_text() and 'Your text is kept' in pt.locator('#voiceTypeNote').inner_text() and log.count() == 4)
        check('the note is a polite status region, Send is usable again, and focus is back in the box', pt.get_attribute('#voiceTypeNote', 'role') == 'status' and pt.get_attribute('#voiceTypeNote', 'aria-live') == 'polite'
              and pt.locator('#voiceTypeSend').is_enabled() and pt.evaluate('document.activeElement.id') == 'voiceTypeInput')
        vt.refuse = 'composing'; pt.keyboard.press('Enter'); pt.wait_for_timeout(400)
        check('refused again while ATLAS is still replying: "One moment", the same text still there', 'One moment' in pt.locator('#voiceTypeNote').inner_text() and pt.locator('#voiceTypeInput').input_value() == ANS2)
        pt.keyboard.press('Shift+Enter'); pt.keyboard.type('x'); pt.wait_for_timeout(100)
        check('editing the kept text clears the note, and Shift+Enter adds a line instead of sending', pt.locator('#voiceTypeNote').inner_text() == '' and pt.locator('#voiceTypeInput').input_value() == ANS2 + '\nx' and len(frames_of(pt, 'text')) == 3)
        pt.locator('#voiceTypeInput').fill(ANS2); vt.refuse = None; pt.keyboard.press('Enter'); pt.wait_for_timeout(600)
        check('accepted at last: the text is cleared only now, the note is gone, and the answer is in the log', pt.locator('#voiceTypeInput').input_value() == '' and pt.locator('#voiceTypeNote').inner_text() == '' and ANS2 in pt.locator('#textLog').inner_text())
        SECRET = 'The secret margin was nineteen percent and nobody outside the team knows it.'
        pt.locator('#voiceTypeInput').fill(SECRET); pt.keyboard.press('Enter'); pt.wait_for_timeout(600)
        check('the last answer is also the last-words receipt on the interview card', SECRET in pt.locator('#lastHeard').inner_text())
        # the read-back card, then Keep private on the secret
        vt.summary(); pt.locator('#summaryCard').wait_for(state='visible', timeout=5000)
        pt.locator('#summaryItems [data-detail=D-001] [data-action=withhold]').click(); pt.wait_for_timeout(500)
        check('Keep private: the live line of that utterance is replaced on screen by "[kept private]" in the conversation and in the last-words receipt, and its words are gone from the page',
              '[kept private]' in pt.locator('#textLog').inner_text() and pt.locator('#lastHeard').inner_text() == '\u201c[kept private]\u201d' and SECRET not in pt.evaluate('document.body.innerText')
              and ANS2 in pt.locator('#textLog').inner_text() and pt.locator('#textLog .msg.is-private').count() == 1)
        pt.locator('#summaryConfirm').focus(); pt.keyboard.press('Enter'); pt.wait_for_timeout(1200)
        check('confirm: the summary card shows "Saved as a private draft" in a typed interview too', 'Saved as a private draft' in pt.locator('#summarySaved').inner_text() and len(frames_of(pt, 'confirm_summary')) == 1)
        check('no audio frame was sent in the whole typed interview, and the microphone was never requested', vt.binary == 0 and pt.evaluate('window.__mic') == 0)
        # accessibility: keyboard, narrow screen, reduced motion
        pt.locator('#voicePause').focus(); pt.keyboard.press('Enter'); pt.wait_for_timeout(400)
        check('keyboard: Pause works in a typed interview and reads "Paused" (no microphone to mention)', len(frames_of(pt, 'pause')) == 1 and pt.locator('#voiceState').inner_text() == 'Paused')
        pt.locator('#voicePause').click(); pt.wait_for_timeout(300)
        check('the log can be scrolled by keyboard (it is focusable) and the answer box has its label', pt.get_attribute('#textLog', 'tabindex') == '0' and pt.evaluate("document.querySelector('label[for=voiceTypeInput]').textContent.trim()") != '')
        pt.set_viewport_size({'width': 390, 'height': 844}); pt.wait_for_timeout(400)
        check('at 390 px a typed interview does not scroll sideways, and the log and answer box stay inside the screen', no_overflow(pt) and pt.evaluate("['textLog','voiceTypeInput','voiceTypeSend'].every(id=>{const r=document.getElementById(id).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})"))
        pt.emulate_media(reduced_motion='reduce'); vt.sock.send(json.dumps({'type': 'agent_text', 'text': '\n\nOne more thing: who adopted it?'})); pt.wait_for_timeout(300)
        check('reduced motion: a new line does not animate', pt.evaluate("getComputedStyle(document.querySelector('#textLog .msg:last-child')).animationName") == 'none')
        pt.set_viewport_size({'width': 1280, 'height': 1000}); pt.locator('#voiceEnd').click(); pt.locator('#voiceEndConfirm').click(); pt.wait_for_function('()=>AtlasVoice.status().phase==="idle"', timeout=8000)
        check('End: the typed interview stays readable, the answer box goes, and both ways to start again are offered', pt.locator('#textLog .msg').count() >= 5 and pt.locator('#voiceTypeForm').is_hidden() and pt.locator('#voiceStartText').is_visible() and pt.locator('#voiceStartText').is_enabled())
        # a typed interview that is resumed: the saved interview says it was typed, and no microphone is asked for
        vtr = Voice(controls=CONTROLS, draft=draft, text=True)
        ptr = open_page(USER, vtr, resumable='text', mic=False)
        ptr.locator('#voiceResumeDialog').wait_for(state='visible', timeout=8000)
        check('the resume prompt names a typed interview', 'typed interview' in ptr.locator('#voiceResumeText').inner_text())
        ptr.locator('#voiceResumeDialog').get_by_role('button', name='Resume').click(); ptr.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=10000); ptr.wait_for_timeout(500)
        st = frames_of(ptr, 'start')[0]
        check('Resume carries the saved interview\'s id and mode text, with no microphone request', st.get('resume') == SID and st.get('mode') == 'text' and ptr.evaluate('window.__mic') == 0)
        check('the typed interview comes back where it was: the turns and ATLAS\'s words, in order', ptr.locator('#textLog .msg').count() == 3
              and 'We rebuilt the claims intake process for the insurance client.' in ptr.locator('#textLog .msg').nth(1).inner_text() and 'What was the baseline?' in ptr.locator('#textLog .msg').nth(2).inner_text())
        ptr.close(); pt.close()

        # ---- 9. v2.2 L1: a typed interview in French. The page offers every language (the real bootstrap lists them), the choice is sent with the start, the server's language shows
        # in the indicator (French has no voice here: replies are text), French text and accents are kept exactly, and a change during the conversation sends one message.
        FR = {'code': 'fr', 'language': 'fr', 'name': 'French', 'native': 'Français', 'rtl': False, 'voice': False, 'locked': True, 'bank': True}
        vf = Voice(controls=CONTROLS, draft=draft, text=True, language=FR)
        pf = open_page(USER, vf, mic=False)
        pf.locator('#voiceLanguage').wait_for(state='visible', timeout=8000)
        opts = pf.evaluate("[...document.querySelectorAll('#voiceLanguageSelect option')].map(o=>[o.value,o.textContent])")
        check('the language selector lists Auto-detect first and every language by its own name; one ATLAS has no voice for says "text replies"',
              opts[0] == ['auto', 'Auto-detect'] and ['fr', 'Français \u00b7 French (text replies)'] in opts and ['en', 'English'] in opts and ['es', 'Español \u00b7 Spanish'] in opts and len(opts) >= 30)
        check('the selector is a labelled control and the typed answer takes any direction of text', pf.evaluate("document.querySelector('label[for=voiceLanguageSelect]').textContent.trim()") == 'Language' and pf.get_attribute('#voiceTypeInput', 'dir') == 'auto')
        pf.select_option('#voiceLanguageSelect', 'fr')
        pf.locator('#voiceStartText').click(); pf.locator('#voiceConsentDialog').wait_for(state='visible', timeout=8000); pf.locator('#modelConsent').check()
        pf.locator('#voiceConsentType').click(); pf.wait_for_function('()=>AtlasVoice.status().phase==="live"', timeout=10000); pf.wait_for_timeout(600)
        st = frames_of(pf, 'start')[0]
        check('the start message carries the chosen language and that it is fixed (and mode text), nothing else new', st.get('language') == 'fr' and st.get('languageLock') is True and st.get('mode') == 'text')
        check('the indicator says what the server announced: French, fixed by you, answering in text; the selector shows it', 'Français \u00b7 fixed by you \u00b7 ATLAS answers in text' in pf.locator('#voiceLanguageState').inner_text()
              and pf.evaluate("document.getElementById('voiceLanguageSelect').value") == 'fr' and pf.get_attribute('#voiceLanguageState', 'role') == 'status')
        check('the French greeting is in the log, and its lines take their own text direction', 'Bonjour, je suis ATLAS. Quel était le projet ?' in pf.locator('#textLog').inner_text() and pf.get_attribute('#textLog .msg', 'dir') == 'auto')
        FR1 = "Nous avons reconstruit le processus d\u2019accueil des sinistres pour un grand assureur, et j\u2019ai dirigé la conception."
        pf.locator('#voiceTypeInput').fill(FR1); pf.keyboard.press('Enter'); pf.wait_for_timeout(600)
        check('a French answer is sent exactly as typed (accents and the curly apostrophe intact) and shown as "You", with the French reply after it',
              [f['text'] for f in frames_of(pf, 'text')] == [FR1] and FR1 in pf.locator('#textLog .msg').nth(1).inner_text() and 'Sur quelle période cela a-t-il été mesuré ?' in pf.locator('#textLog .msg').nth(2).inner_text())
        vf.sock.send(json.dumps({'type': 'language', 'code': 'ar', 'language': 'ar', 'name': 'Arabic', 'native': '\u0627\u0644\u0639\u0631\u0628\u064a\u0629', 'rtl': True, 'voice': False, 'locked': False, 'bank': False, 'via': 'detected'})); pf.wait_for_timeout(300)
        check('a switch the server announces updates the indicator and the selector (back to Auto-detect), with no page error', '\u0627\u0644\u0639\u0631\u0628\u064a\u0629 \u00b7 detected \u00b7 ATLAS answers in text' in pf.locator('#voiceLanguageState').inner_text()
              and pf.evaluate("document.getElementById('voiceLanguageSelect').value") == 'auto')
        vf.sock.send(json.dumps({'type': 'language', 'code': 'pl', 'language': 'pl', 'name': 'Polish', 'native': 'Polski', 'rtl': False, 'voice': False, 'locked': False, 'bank': False, 'via': 'detected', 'notice': 'ATLAS cannot speak aloud here right now.'})); pf.wait_for_timeout(300)
        check('the one-time "no voice" notice is shown to the consultant', 'ATLAS cannot speak aloud here right now.' in pf.locator('#voiceMessage').inner_text())
        pf.select_option('#voiceLanguageSelect', 'es'); pf.wait_for_timeout(300)
        check('choosing a language during the conversation sends exactly one language message', [f for f in vf.frames if f.get('type') == 'language'] == [{'type': 'language', 'language': 'es'}])
        pf.select_option('#voiceLanguageSelect', 'auto'); pf.wait_for_timeout(300)
        check('and "Auto-detect" gives the choice back to the server', [f for f in vf.frames if f.get('type') == 'language'][-1] == {'type': 'language', 'language': 'auto'})
        pf.set_viewport_size({'width': 390, 'height': 844}); pf.wait_for_timeout(300)
        check('at 390 px the language row does not scroll sideways', no_overflow(pf) and pf.evaluate("(()=>{const r=document.getElementById('voiceLanguage').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})()"))
        pf.close()

        # ---- 10. v2.2 V1: the voice engine in the page. The scripted voice socket sends real 24 kHz PCM at 1x with a 500 ms credit lead, as the server now does, and
        # ONE 120 ms stall in the middle. The worklet must never run dry, and her volume ducks on the server's word and comes back.
        vv = Voice(controls=CONTROLS, draft=draft)
        pv = open_page(USER, vv); start_interview(pv)
        pv.wait_for_function('()=>!!AtlasVoice.audioStats()', timeout=8000)
        stats = lambda: pv.evaluate('AtlasVoice.audioStats()')
        us0 = stats()['underruns']; SECONDS, FRAME = 3.0, 0.02
        total = int(SECONDS / FRAME)
        pcm = lambda i: struct.pack('<480h', *[int(9000 * math.sin(2 * math.pi * 440 * (i * 480 + k) / 24000)) for k in range(480)])
        vv.send(type='audio_turn', item_id='agent-1')
        sent, stalled, queued_low, started, t0 = 0, False, 1e9, False, time.time()
        while sent < total:
            now = time.time() - t0
            if now > 1.5 and not stalled:   # the one stall: nothing for 120 ms
                stalled = True; pv.wait_for_timeout(120); continue
            due = min(total, int((now + 0.5) / FRAME) + 1)   # credit: keep 500 ms ahead of the clock, as the server does
            while sent < due: vv.sock.send(pcm(sent)); sent += 1
            q = stats()
            if q['queuedMs'] > 100: started = True
            if started and now > 0.4: queued_low = min(queued_low, q['queuedMs'])
            if sent in (60, 61): vv.send(type='duck', on=True)
            if sent >= total - 2 and sent >= 120: vv.send(type='duck', on=False)
            pv.wait_for_timeout(10)
        after = stats()
        check('real PCM at 1x with one 120 ms stall: playback began and the worklet buffer never ran dry while it streamed', started and after['underruns'] == us0 and queued_low > 0)
        print('# lowest queue while streaming: %d ms (lead 500 ms, stall 120 ms)' % queued_low, flush=True)
        check('the buffer never overflowed (a full second of ring)', after['droppedSamples'] == 0)
        pv.wait_for_timeout(2200)
        check('after the last chunk the buffer drains once, and that is the only run-dry', stats()['underruns'] == us0 + 1)
        check('the page took the server\'s duck without error and no gateway failure was shown', not pv.locator('#voiceHeading').inner_text().lower().startswith('error'))
        pv.close()
        br.close()
    check('no page errors', not ERR)
except SystemExit as e: code = e.code or 0
except AssertionError: code = 1
finally:
    for pr_ in PROCS:
        pr_.terminate()
        try: pr_.wait(timeout=5)
        except Exception: pr_.kill()
    if ERR: print('page errors:', ERR)
sys.exit(code)
