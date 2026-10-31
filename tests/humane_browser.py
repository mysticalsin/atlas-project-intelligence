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
Not covered (needs a live voice model): what ATLAS says, audio, the microphone path beyond the browser's fake device (COVERAGE.md).
"""
import json, os, re, socket, subprocess, sys, time, urllib.request
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


def start_edge():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    env = {k: v for k, v in os.environ.items() if k not in ('DATA_MODE', 'DIRECTORY_PUSH_SECRET', 'IDENTITY_SOURCE') and not k.startswith('DNA_')}
    proc = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(port)], cwd=EDGE, env={**env, 'ATLAS_ADAPTERS': 'mock'}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
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
    def __init__(s, controls=None, draft=None):
        s.controls = controls; s.draft = draft or {}; s.frames = []; s.sock = None; s.sockets = 0; s.hold = False; s.held = []; s.summary_items = [dict(i) for i in ITEMS]

    def send(s, **event): s.sock.send(json.dumps(event))

    def summary(s): s.send(type='summary', items=s.summary_items, unknowns=[{'kind': 'skipped', 'field': 'decision', 'label': 'Decision'}], state='summary', round=1)

    def __call__(s, ws):
        s.sock = ws; s.sockets += 1
        def on(m):
            if isinstance(m, bytes): return
            d = json.loads(m); s.frames.append(d); t = d.get('type')
            if t == 'start':
                def ready():
                    resumed = d.get('resume') is not None
                    ws.send(json.dumps({'type': 'ready', 'mode': 'full', 'model': 'ATLAS', 'provider': 'ATLAS voice', 'sampleRate': 24000, 'capture': True, 'liveLedger': True, 'maxSeconds': 900,
                                        'speakingSeconds': 600, 'message': 'ready', 'sessionId': SID, 'resumable': True, **({'resumed': True} if resumed else {}), **({'controls': s.controls} if s.controls else {}),
                                        'timePlan': {'depthAt': 405, 'closingAt': 690}}))
                    if resumed:
                        ws.send(json.dumps({'type': 'restore', 'user': [{'item_id': 'user-1', 'text': 'We rebuilt the claims intake process for the insurance client.', 'provenance': 'unverified_speech_recognition'}],
                                            'agent': ['Hi, I am ATLAS.', 'What was the baseline?'], 'lastQuestion': 'What was the baseline?', 'activeSeconds': 95}))
                    else: ws.send(json.dumps({'type': 'agent_text', 'text': "Hi, I'm ATLAS. What was the project?"}))
                if s.hold and d.get('resume') is not None: s.held.append(ready)
                else: ready()
            elif t == 'pause': ws.send(json.dumps({'type': 'state', 'state': 'paused', 'event': 'pause', 'actor': 'consultant'}))
            elif t == 'resume':
                ws.send(json.dumps({'type': 'state', 'state': 'discovery', 'event': 'resume', 'actor': 'consultant'}))
                ws.send(json.dumps({'type': 'agent_text', 'text': '\n\nWelcome back. What was the baseline?'}))
            elif t == 'repeat': ws.send(json.dumps({'type': 'agent_text', 'text': '\n\nOf course. What was the baseline?'}))
            elif t == 'skip': ws.send(json.dumps({'type': 'agent_text', 'text': "\n\nNo problem, we'll leave that one. What changed for the customer?"}))
            elif t == 'text':
                ws.send(json.dumps({'type': 'user_text', 'item_id': 'user-typed-1', 'text': d['text'], 'provenance': 'consultant_typed'}))
                ws.send(json.dumps({'type': 'agent_text', 'text': '\n\nThanks. Over what period was that measured?'}))
            elif t == 'correct':
                for i in s.summary_items:
                    if i['detail_id'] == d['detail_id']: i.update(quote=d['text'], provenance='consultant_typed', detail_id='D-004')
                s.summary()
            elif t == 'withhold':
                s.summary_items = [i for i in s.summary_items if i['detail_id'] != d['detail_id']]; s.summary()
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

        def open_page(who, voice, path='/', w=1280, resumable=False, discard=None):
            ctx = br.new_context(permissions=['microphone'], viewport={'width': w, 'height': 1000})
            p = ctx.new_page(); p.on('pageerror', lambda e: ERR.append(who + ': ' + str(e)))
            p.requests = []; p.on('request', lambda r: p.requests.append((r.method, urlparse(r.url).path, r.post_data or '', r.headers)) if '/api/' in r.url else None)
            p.voice = voice; p.route_web_socket('**/api/voice', voice)
            if resumable:  # the Interview Durable Object is not in the local edge: say what its /api/checkpoint would say, on the real bootstrap
                def boot(route):
                    resp = route.fetch(); body = resp.json()
                    if not discard: body['resumable'] = {'sessionId': SID, 'savedAt': int(time.time() * 1000) - 60000, 'expiresAt': int(time.time() * 1000) + 86400000}  # once discarded, the server has nothing to resume
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
        check('no controls announced: Pause, Repeat, Skip and the typed answer stay hidden', all(p0.locator(s).is_hidden() for s in ('#voicePause', '#voiceRepeat', '#voiceSkip', '#voiceTypeForm')))
        p0.locator('#voiceEnd').click(); p0.wait_for_function('()=>AtlasVoice.status().phase==="idle"', timeout=8000)
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

        # ---- 3. controls are announced: Pause, Resume, Repeat, Skip
        check('the server announced the controls: Pause, Repeat, Skip and the typed answer are shown and enabled', all(pr.locator(s).is_visible() and pr.locator(s).is_enabled() for s in ('#voicePause', '#voiceRepeat', '#voiceSkip', '#voiceTypeInput')))
        check('every control has its own accessible name', pr.get_attribute('#voicePause', 'aria-label') == 'Pause the interview' and pr.get_attribute('#voiceRepeat', 'aria-label') == 'Ask me the last question again'
              and pr.get_attribute('#voiceSkip', 'aria-label') == 'Skip this question' and pr.get_attribute('#voiceTypeSend', 'aria-label') == 'Send your typed answer'
              and pr.evaluate("document.querySelector('label[for=voiceTypeInput]').textContent.trim()") == 'Type your answer instead of speaking')
        t0 = pr.locator('#voiceTimer').inner_text(); pr.wait_for_timeout(1300)
        check('the interview clock runs, starting from the restored 01:35', t0 >= '01:35' and pr.locator('#voiceTimer').inner_text() > t0)
        pr.locator('#voicePause').focus(); pr.keyboard.press('Enter'); pr.wait_for_timeout(500)   # keyboard: Enter on the focused button
        check('Pause (keyboard): one pause message is sent', len(frames_of(pr, 'pause')) == 1)
        cap = pr.locator('#orbStateCaption').inner_text().lower()  # the caption is set in capitals by the stylesheet
        check('Paused: the caption says so, the orb is not speaking, the microphone is off, and the button now reads Resume', cap.startswith('paused') and pr.evaluate("document.getElementById('voicePanel').dataset.orbState") != 'speaking'
              and pr.locator('#orbInputWord').inner_text() == 'Paused' and pr.locator('#voicePause').inner_text() == 'Resume' and pr.get_attribute('#voicePause', 'aria-label') == 'Resume the interview')
        check('Paused: Repeat and Skip are off, the mute button is off, the typed answer still works', pr.locator('#voiceRepeat').is_disabled() and pr.locator('#voiceSkip').is_disabled() and pr.locator('#voiceMute').is_disabled() and pr.locator('#voiceTypeInput').is_enabled())
        t1 = pr.locator('#voiceTimer').inner_text(); pr.wait_for_timeout(2300)
        check('Paused: the clock stops', pr.locator('#voiceTimer').inner_text() == t1)
        pr.locator('#voicePause').click(); pr.wait_for_timeout(2300)
        check('Resume: one resume message, the caption and the clock carry on, Repeat and Skip are back', len(frames_of(pr, 'resume')) == 1 and not pr.locator('#orbStateCaption').inner_text().lower().startswith('paused')
              and pr.locator('#voiceTimer').inner_text() > t1 and pr.locator('#voiceRepeat').is_enabled() and 'Welcome back' in pr.locator('#agentText').inner_text())
        pr.locator('#voiceRepeat').click(); pr.wait_for_timeout(400)
        check('Repeat: one repeat message, and the question is said again on screen', len(frames_of(pr, 'repeat')) == 1 and 'Of course. What was the baseline?' in pr.locator('#agentText').inner_text())
        pr.locator('#voiceSkip').click(); pr.wait_for_timeout(400)
        check('Skip: one skip message, and ATLAS moves on', len(frames_of(pr, 'skip')) == 1 and "we'll leave that one" in pr.locator('#agentText').inner_text())
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
              and 'You skipped: Decision' in pr.locator('#summaryOpen').inner_text() and 'unverified' in pr.locator('#summaryCard .board-label').inner_text())
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
        check('Keep private: one withhold message, and the item leaves the card', frames_of(pr, 'withhold') == [{'type': 'withhold', 'detail_id': 'D-001'}] and pr.locator('#summaryItems [data-detail=D-001]').count() == 0 and pr.locator('#summaryItems .summary-item').count() == 2)
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
        check('a reviewer approves the exact revision and hash (the real review route)', approved['state'] == 'approved' and approved['approval']['revision'] == 1)
        lib = open_page(USER, Voice(draft=draft)); lib.locator('header [data-view=library]').click(); lib.wait_for_timeout(500)
        lib.locator('#workflowStatus .wf-card').first.wait_for(state='visible', timeout=10000)
        cards = lib.locator('#workflowStatus .wf-card')
        check('the workflow status shows seven cards in the pack\'s order', cards.count() == 7 and [c.get_attribute('data-branch') for c in cards.all()] == ['evidence', 'maap', 'project_review', 'dna', 'mechat', 'imp', 'spotlight'])
        mocks = {c.get_attribute('data-branch'): c.locator('.wf-mock').inner_text() for c in cards.all() if c.locator('.wf-mock').count()}
        check('every destination that is not really connected carries "Mock — not connected"', mocks == {b: 'Mock — not connected' for b in ('dna', 'mechat', 'imp', 'spotlight')})
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
