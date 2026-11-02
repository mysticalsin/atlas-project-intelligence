"""Disputes on the real local edge, in a real browser (D-DSR, Tony 2026-11-02: "Let the same reviewer settle the dispute when there's only one reviewer.").

  python3 build.py && cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html && python3 tests/dispute_browser.py

Two local edges, synthetic people only:
  single    one eligible reviewer (solo@): the owner sees "Rejected", raises a dispute from the status panel (a reason is required, an adjudicator is optional);
            the reviewer sees it in the queue with a Disputed chip, opens it, reads both views and the single-reviewer note, and overturns it with a reason;
            the record is back in review and recorded as a single-reviewer adjudication
  four-eyes two reviewers: the rejecter sees the dispute listed but not counted, with both buttons disabled and the reason beside them; the other reviewer
            upholds it; the owner sees "Rejection upheld"
No em dash in the dispute copy, 44px buttons, no console or page errors (strict CSP held).
"""
import json, os, re, socket, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy/cloudflare-edge'
ERR, PROCS = [], []
OWNER = 'alex.dispute@mantu.com'
NOTES = lambda s: {'session_id': s, 'project_ref': 'PRJ-D1', 'details': [
    {'id': 'D-001', 'field': 'problem', 'item_id': 'user-1', 'quote': 'Claims were bouncing between three teams and payouts were slow.', 'status': 'reported'},
    {'id': 'D-002', 'field': 'contribution', 'item_id': 'user-1', 'quote': 'I designed and built the routing model.', 'status': 'reported'},
    {'id': 'D-003', 'field': 'measurement', 'item_id': 'user-2', 'quote': 'Triage fell from 40 to 12 minutes according to the dashboard.', 'status': 'uncertain'}]}


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' ' + str(detail) if detail and not ok else ''), flush=True)
    assert ok, name + ' ' + str(detail)


def start_edge(admins, reviewers):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    env = {k: v for k, v in os.environ.items() if k not in ('DATA_MODE', 'DIRECTORY_PUSH_SECRET', 'IDENTITY_SOURCE', 'ATLAS_VOICE') and not k.startswith('DNA_')}
    proc = subprocess.Popen(['node', '--no-warnings', 'dev/local-edge.mjs', str(port)], cwd=EDGE, env={**env, 'ATLAS_ADAPTERS': 'mock', 'ADMIN_EMAILS': admins, 'REVIEWER_EMAILS': reviewers},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    PROCS.append(proc); base = f'http://127.0.0.1:{port}'
    for _ in range(150):
        try: urllib.request.urlopen(base + '/__settle', timeout=1); break
        except Exception: time.sleep(.1)
    return base


def draft(base, session):
    req = urllib.request.Request(f'{base}/__evidence_draft?as={OWNER}', data=json.dumps(NOTES(session)).encode(), method='POST')
    return json.loads(urllib.request.urlopen(req, timeout=15).read())


def page(br, base, who):
    ctx = br.new_context(viewport={'width': 1440, 'height': 900}); p = ctx.new_page()
    p.on('pageerror', lambda e: ERR.append(str(e)))
    p.on('console', lambda m: ERR.append('console: ' + m.text) if m.type == 'error' and not re.search(r'status of (403|409)', m.text) else None)  # a refused review is a 4xx the panel explains
    p.goto(f'{base}/?as={who}'); p.wait_for_timeout(1200)
    return ctx, p


def api(p, path, body=None):
    return p.evaluate("([p,b])=>ATLAS_APP.libraryApi(p,b?{method:'POST',body:b}:undefined)", [path, body])


def reject(p, rid, why):
    r = api(p, '/evidence/' + rid)
    return api(p, f'/evidence/{rid}/review', {'action': 'reject', 'expected_revision': r['revision'], 'content_hash': r['content_hash'], 'reason': why})


def no_dash(p, sel):
    return '\u2014' not in p.evaluate("(s)=>[...document.querySelectorAll(s)].map(e=>e.innerText).join(' ')", sel)


def open_library(p):
    p.evaluate("ATLAS_APP.switchView('library')"); p.wait_for_timeout(600)


def single(br):
    base = start_edge('solo@mantu.com', 'solo@mantu.com')
    d = draft(base, 'dispute-single-1')
    o_ctx, o = page(br, base, OWNER)
    check('the owner submits the draft', api(o, f"/evidence/{d['id']}/submit", {'expected_revision': 1})['state'] == 'reviewer_queue')
    r_ctx, r = page(br, base, 'solo@mantu.com')
    check('the only reviewer rejects it', reject(r, d['id'], 'The 40 to 12 figure has no source.')['state'] == 'rejected')
    # ---- the owner raises the dispute from the status panel
    open_library(o); o.evaluate("AtlasWorkflowUI.refresh()")
    o.wait_for_selector('#wfDispute [data-dp-badge=rejected]', timeout=10000)
    check('the owner sees the Rejected badge and the reviewer\'s reason', o.locator('#wfDispute [data-dp-badge]').inner_text() == 'Rejected' and 'The 40 to 12 figure has no source.' in o.locator('#wfDispute').inner_text())
    raise_btn = o.locator('#wfDispute [data-dp-do=dispute]')
    check('Raise a dispute and Accept the rejection are enabled for the owner', raise_btn.is_enabled() and o.locator('#wfDispute [data-dp-do=accept_rejection]').is_enabled())
    raise_btn.click(); o.wait_for_timeout(300)
    check('a dispute without a reason is not sent', 'Say why you dispute the rejection.' in o.locator('#wfDispute .dp-err').inner_text() and api(o, '/evidence/' + d['id'])['state'] == 'rejected')
    o.locator('#wfDispute textarea').fill('The operations dashboard export is the source.')
    raise_btn.click(); o.wait_for_selector('#wfDispute [data-dp-badge=disputed]', timeout=10000)
    check('after raising it the owner sees Disputed, and Raise is disabled with the reason beside it', not o.locator('#wfDispute [data-dp-do=dispute]').is_enabled() and 'Your dispute is open' in o.locator('#wfDispute [data-dp-why=dispute]').inner_text())
    check('no em dash in the owner\'s dispute panel', no_dash(o, '#wfDispute'))
    # ---- the reviewer settles it
    r.evaluate("AtlasReviewUI.refresh()"); open_library(r); r.wait_for_selector('.rq-row [data-rq-disputed]', timeout=10000)
    check('the dispute waits in the queue with a Disputed chip and is counted', r.locator('.rq-row [data-rq-disputed]').inner_text() == 'Disputed' and r.locator('#rqTitle').inner_text() == 'Waiting for you (1)')
    r.locator('.rq-row').first.click(); r.locator('#reviewScreen[open]').wait_for(timeout=5000); r.wait_for_selector('#rvDispute .dp', timeout=8000)
    txt = r.locator('#rvDispute').inner_text()
    check('the review screen shows both views side by side', 'The 40 to 12 figure has no source.' in txt and 'The operations dashboard export is the source.' in txt)
    check('the only reviewer is told they settle it themselves', 'only reviewer for this project' in txt and 'single-reviewer adjudication' in txt)
    check('Validate and Request changes give way to the dispute buttons', r.locator('#rvApprove').is_hidden() and r.locator('#rvChanges').is_hidden())
    hs = r.evaluate("()=>[...document.querySelectorAll('#rvDispute [data-dp-do]')].map(b=>[b.disabled,Math.round(b.getBoundingClientRect().height)])")
    check('Uphold and Overturn are enabled and 44px', hs == [[False, hs[0][1]], [False, hs[1][1]]] and all(h >= 44 for _, h in hs), hs)
    check('no em dash in the review screen\'s dispute panel', no_dash(r, '#rvDispute'))
    r.locator('#rvDispute [data-dp-do=reopen_review]').click(); r.wait_for_timeout(300)
    check('overturning needs a reason too', 'Say why the rejection is overturned.' in r.locator('#rvDispute .dp-err').inner_text())
    r.locator('#rvDispute textarea').fill('The export does support the figure.')
    r.locator('#rvDispute [data-dp-do=reopen_review]').click()
    r.wait_for_function("()=>/Overturned/.test(document.getElementById('rvState').textContent)", timeout=10000)
    check('after overturning, the record is back in review with Validate available', r.locator('#rvApprove').is_visible() and r.locator('#rvApprove').is_enabled() and r.locator('#rvDispute').is_hidden())
    rec = api(r, '/evidence/' + d['id'])
    check('it is recorded as a single-reviewer adjudication', rec['state'] == 'reviewer_queue' and rec['adjudication']['outcome'] == 'reopened' and rec['adjudication']['single_reviewer'] is True and rec['adjudication']['by'] == 'solo@mantu.com', rec['adjudication'])
    o.evaluate("AtlasWorkflowUI.refresh()"); o.wait_for_selector('#wfDispute [data-dp-badge=reopened]', timeout=10000)
    check('the owner sees "Reopened after a dispute"', o.locator('#wfDispute [data-dp-badge]').inner_text() == 'Reopened after a dispute')
    o_ctx.close(); r_ctx.close()


def four_eyes(br):
    base = start_edge('boss@mantu.com', 'rev@mantu.com')
    d = draft(base, 'dispute-four-1')
    o_ctx, o = page(br, base, OWNER)
    api(o, f"/evidence/{d['id']}/submit", {'expected_revision': 1})
    r_ctx, r = page(br, base, 'rev@mantu.com')
    reject(r, d['id'], 'No source for the figure.')
    check('the owner disputes it', api(o, f"/evidence/{d['id']}/review", {'action': 'dispute', 'expected_revision': 1, 'rationale': 'The export is the source.'})['state'] == 'disputed')
    r.evaluate("AtlasReviewUI.refresh()"); open_library(r); r.wait_for_selector('.rq-row [data-rq-disputed]', timeout=10000)
    check('the rejecter sees it listed as decided by another reviewer, and it is not counted', r.locator('.rq-row [data-rq-disputed]').inner_text() == 'Disputed: another reviewer decides' and r.locator('#rqTitle').inner_text() == 'Waiting for you (0)')
    r.locator('.rq-row').first.click(); r.wait_for_selector('#rvDispute .dp', timeout=8000)
    dis = r.evaluate("()=>[...document.querySelectorAll('#rvDispute [data-dp-do]')].map(b=>[b.disabled,!!b.getAttribute('aria-describedby')])")
    check('both adjudication buttons are disabled and described', dis == [[True, True], [True, True]], dis)
    check('the reason is said beside them', 'another reviewer is available' in r.locator('#rvDispute [data-dp-why=uphold_rejection]').inner_text())
    b_ctx, b = page(br, base, 'boss@mantu.com')
    b.evaluate("AtlasReviewUI.refresh()"); open_library(b); b.wait_for_selector('.rq-row [data-rq-disputed]', timeout=10000)
    b.locator('.rq-row').first.click(); b.wait_for_selector('#rvDispute .dp', timeout=8000)
    check('the other reviewer gets the plain note, not the single-reviewer one', 'only reviewer' not in b.locator('#rvDispute').inner_text() and b.locator('#rvDispute [data-dp-do=uphold_rejection]').is_enabled())
    b.locator('#rvDispute textarea').fill('The export covers a different business line.')
    b.locator('#rvDispute [data-dp-do=uphold_rejection]').click()
    b.wait_for_function("()=>!document.getElementById('reviewScreen').open || /Upheld/.test(document.getElementById('rvState').textContent)", timeout=10000)
    rec = api(b, '/evidence/' + d['id'])
    check('upheld under the four-eyes rule', rec['state'] == 'closed_rejected' and rec['adjudication']['rule'] == 'four_eyes' and rec['adjudication']['single_reviewer'] is False, rec['adjudication'])
    open_library(o); o.evaluate("AtlasWorkflowUI.refresh()"); o.wait_for_selector('#wfDispute [data-dp-badge=upheld]', timeout=10000)
    check('the owner sees "Rejection upheld" with the reason, and nothing left to press', 'The export covers a different business line.' in o.locator('#wfDispute').inner_text() and o.locator('#wfDispute [data-dp-do]:enabled').count() == 0)
    o_ctx.close(); r_ctx.close(); b_ctx.close()


if __name__ == '__main__':
    with sync_playwright() as pw:
        br = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'))
        try:
            single(br); four_eyes(br)
            check('no console errors and no page errors (strict CSP held)', not ERR, ERR[:5])
            print('\nALL DISPUTE CHECKS PASSED')
        finally:
            for pr in PROCS: pr.terminate()
            br.close()
