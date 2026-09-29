"""F3 "confirmed by someone else" end to end on the local edge (real Worker handle(), real library and claims code on
node:sqlite, stand-in review model, loopback only; WOW_SPEC F3.6). Setup and the status check go through the API only;
the browser covers the /confirm page: sam confirms one point and corrects one, jo's inbox is empty, 320 px has no
horizontal overflow, reduced motion is emulated, and there are no page errors. UI badges are T4's (trust_browser.py).
  python3 tests/confirm_browser.py
"""
import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
ERR = []


def check(name, ok):
    print(('PASS ' if ok else 'FAIL ') + name)
    assert ok, name


s = socket.socket()
s.bind(('127.0.0.1', 0))
PORT = s.getsockname()[1]
s.close()
BASE = f'http://127.0.0.1:{PORT}'
srv = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(PORT)], cwd=EDGE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(100):
    try:
        urllib.request.urlopen(BASE + '/__settle', timeout=1)
        break
    except Exception:
        time.sleep(.1)
settle = lambda: urllib.request.urlopen(BASE + '/__settle', timeout=30).read()
CSRF = {}


def api(email, method, path, body=None):
    """One API call as `email` (the local edge's ?as= switch), with Origin and the per-user CSRF token for POSTs."""
    url = f'{BASE}{path}{"&" if "?" in path else "?"}as={urllib.parse.quote(email)}'
    headers = {}
    if method == 'POST':
        if email not in CSRF:
            CSRF[email] = api(email, 'GET', '/api/bootstrap')[1]['csrf']
        headers = {'Origin': BASE, 'X-Atlas-CSRF': CSRF[email], 'Content-Type': 'application/json'}
    req = urllib.request.Request(url, method=method, headers=headers, data=json.dumps(body or {}).encode() if method == 'POST' else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')


NOTES = ['Zebracorp had claims bouncing between three teams, slowing payouts for customers across the region.',
         'I designed and built the routing model and ran the pilot with two teams myself. We kept the old rules as a fallback.',
         'We compared rules against a model, chose the model, and kept a manual fallback for edge cases.',
         'Triage fell from 40 to 12 minutes per claim according to the operations dashboard.',
         'Operations dashboard export v3, before and after quarters.',
         'Any insurer or service desk with manual routing and a measurable queue would benefit.']
REF = {'title': 'Claims triage rebuilt with ML routing', 'stage': 'Delivered', 'sector': 'Insurance',
       'consultant': {'name': 'Alex Martin', 'role': 'Data engineer'}, 'client': {'name': 'Zebracorp', 'location': 'Lyon', 'contact': 'Jane Doe'},
       'details': {'projectId': 'PRJ-2291', 'country': 'France', 'technologies': ['Python'], 'serviceLines': ['Data & AI']},
       'validation': {'manager': {'name': 'Sam', 'email': 'sam@mantu.com'}}, 'answers': NOTES}
try:
    # ---- Setup through the API only.
    boot = api('alex@mantu.com', 'GET', '/api/bootstrap')[1]
    check('claims feature is on in this build (Access mode)', boot['features']['claims'] is True and boot['features']['clientConfirm'] is False)
    st, saved = api('alex@mantu.com', 'POST', '/api/library', {'localId': 'confirm-browser', 'reference': REF})
    check('alex saves a reference naming N+1 sam@mantu.com', st == 201 and saved.get('id'))
    rid = saved['id']
    settle()
    st, validated = api('sam@mantu.com', 'POST', f'/api/library/{rid}/validate', {'decision': 'validate'})
    check('sam validates the reference (existing N+1 flow)', st == 200 and validated['state']['validation']['status'] == 'validated')
    st, view = api('alex@mantu.com', 'GET', f'/api/library/claims/{rid}')
    cands = view['candidates']
    pick = [next(c for c in cands if c['topic'] == 1 and c['idx'] == 0), next(c for c in cands if c['topic'] == 3 and c['idx'] == 0)]
    st, proposed = api('alex@mantu.com', 'POST', '/api/library/claims', {'refId': rid, 'items': pick})
    check('alex proposes 2 claims (exact sentences of the current revision)', st == 201 and len(proposed['claims']) == 2)
    ids = [c['id'] for c in proposed['claims']]
    st, made = api('alex@mantu.com', 'POST', '/api/library/confirmations', {'refId': rid, 'claimIds': ids, 'kind': 'manager'})
    req = made['request']
    check('confirmation requested from the self-declared N+1', st == 201 and req['toEmail'] == 'sam@mantu.com' and req['managerSource'] == 'self_declared')
    check('the draft holds only the /confirm link: no claim text, no client name', made['draft']['body'] == f'{BASE}/confirm#{req["id"]}'
          and 'Zebracorp' not in json.dumps(made['draft']) and 'routing model' not in json.dumps(made['draft']))
    check('outreach rows queued as pending_approval (nothing sent)', [o['status'] for o in made['outreach']] == ['pending_approval', 'pending_approval'])

    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)

        def page(email, hash_='', width=1280):
            c = b.new_context(viewport={'width': width, 'height': 900}, reduced_motion='reduce')
            p = c.new_page()
            p.on('pageerror', lambda e: ERR.append(str(e)))
            p.on('console', lambda m: ERR.append('console: ' + m.text) if m.type == 'error' else None)
            p.goto(f'{BASE}/confirm?as={urllib.parse.quote(email)}{hash_}')
            p.wait_for_selector('#confirmInbox h1', timeout=10000)
            return p

        # ---- sam, at 320 px first: the whole request fits, no horizontal overflow.
        narrow = page('sam@mantu.com', '#' + req['id'], width=320)
        check('320 px: no horizontal overflow on the request', narrow.evaluate('document.documentElement.scrollWidth <= 320 && document.body.scrollWidth <= 320'))
        narrow.context.close()
        n = page('sam@mantu.com', '#' + req['id'])
        check('the deep link focuses the request heading', n.evaluate("document.activeElement && document.activeElement.id === 'confirmTitle'"))
        check('heading reads "Confirm 2 points for Alex Martin, about 60 seconds"', n.locator('#confirmTitle').inner_text() == 'Confirm 2 points for Alex Martin, about 60 seconds')
        texts = n.locator('#confirmInbox .claim .text').all_inner_texts()
        check('the declared N+1 (full access) sees the exact sentences', texts == [pick[0]['text'], pick[1]['text']])
        check('three decision buttons per claim', n.locator('[data-decision]').count() == 6)
        check('reduced motion: emulated, no running animation, no transition', n.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches && document.getAnimations().length === 0 && getComputedStyle(document.querySelector('[data-decision]')).transitionDuration === '0s'"))
        submit = n.locator('#confirmSubmit')
        check('submit is disabled until every point is decided', submit.is_disabled())
        first, second = n.locator('.claim').nth(0), n.locator('.claim').nth(1)
        first.locator('[data-decision=confirm]').focus()
        n.keyboard.press('Space')
        check('keyboard: Space on "Confirm" presses it', first.locator('[data-decision=confirm]').get_attribute('aria-pressed') == 'true')
        second.locator('[data-decision=correct]').click()
        check('"Correct" reveals a required note and focuses it', second.locator('textarea').is_visible() and n.evaluate("document.activeElement.tagName === 'TEXTAREA'") and submit.is_disabled())
        second.locator('textarea').fill('It was 15 minutes per claim, not 12.')
        check('submit enables once every point is decided', submit.is_enabled())
        submit.click()
        n.wait_for_selector('#confirmDone:not([hidden])', timeout=10000)
        check('#confirmDone: "Recorded. Thank you. Nothing else is shared."', n.locator('#confirmDone').inner_text().strip().startswith('Recorded. Thank you. Nothing else is shared.'))
        check('320 px after submitting: still no overflow', (n.set_viewport_size({'width': 320, 'height': 700}) or True) and n.evaluate('document.documentElement.scrollWidth <= 320'))
        n.reload()
        n.wait_for_selector('#confirmInbox h1')
        check('a done request leaves sam\'s inbox', n.locator('#confirmInbox h1').inner_text() == 'Nothing to confirm')

        # ---- The claims API (owner) shows both statuses; validation and status of the reference are untouched.
        st, after = api('alex@mantu.com', 'GET', f'/api/library/claims/{rid}')
        got = {c['id']: c for c in after['claims']}
        check('claims API: confirmed and corrected, by sam, source self_declared', st == 200 and got[ids[0]]['status'] == 'manager_confirmed' and got[ids[1]]['status'] == 'corrected'
              and got[ids[1]]['note'] == 'It was 15 minutes per claim, not 12.' and all(got[i]['byMail'] == 'sam@mantu.com' and got[i]['source'] == 'self_declared' for i in ids))
        st, record = api('alex@mantu.com', 'GET', f'/api/library/{rid}')
        check('the reference validation is unchanged by confirmations', record['state']['validation']['status'] == 'validated' and record['status'] == validated['status'])
        trail = json.dumps(record['audit'])
        check('audit: one row per decision with rev N; no claim text or client name', trail.count('"claim confirm"') == 1 and trail.count('"claim correct"') == 1
              and 'routing model' not in trail and 'Zebracorp' not in trail and f'rev {record["revision"]} claim {ids[0]}' in trail)

        # ---- jo: nothing addressed to her; an empty inbox, and a request id in the hash reveals nothing.
        j = page('jo@mantu.com', '#' + req['id'])
        check("jo's inbox is empty", j.locator('#confirmInbox h1').inner_text() == 'Nothing to confirm' and j.locator('#confirmSubmit').count() == 0)
        st, denied = api('jo@mantu.com', 'POST', f'/api/library/confirmations/{req["id"]}', {'decisions': [{'claimId': ids[0], 'decision': 'confirm'}]})
        check('jo cannot decide sam\'s request (403)', st == 403)
        check('jo at 320 px: no overflow', (j.set_viewport_size({'width': 320, 'height': 700}) or True) and j.evaluate('document.documentElement.scrollWidth <= 320'))
        b.close()
    check('no page errors', not ERR)
    print(ERR)
finally:
    srv.terminate()
