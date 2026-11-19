"""Journey layout must not scroll horizontally at 320, 375 and 1280 px for reviewer, presales and admin roles.
Synthetic library fixtures only.
  python3 tests/journey_layout_browser.py
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ERR = []
JOURNEY = {
    'stages': [
        {'id': 'project', 'title': 'Identify the project', 'current': True},
        {'id': 'review', 'title': 'Project review'},
        {'id': 'spotlight', 'title': 'Spotlight reference', 'blocked': 'spotlight'},
    ],
    'fields': {
        'title': {'value': 'Synthetic queue alias'},
        'personalWork': {'value': 'Route design and pilot ownership.'},
        'evidence': {'value': 'Ops dashboard quarters.'},
    },
    'confirmed': {},
    'roles': {'explanation': 'Matches use confirmed skills only.', 'decision': 'Illustrative catalog.', 'matches': []},
    'publication': 'Manager and pre-sales approval for non-admins.',
    'integrations': {'spotlight': {'reason': 'No Spotlight endpoint configured.'}},
}
ITEMS = {
    'items': [{
        'id': 'a' * 32,
        'title': 'Synthetic reference with a long title that must stay inside the journey panel',
        'status': 'awaiting_validation',
        'managerDecision': 'pending',
        'presalesDecision': 'pending',
        'access': 'full',
        'mine': False,
    }]
}
PRIVACY = {
    'consent': {'interview': 'recorded with purpose consent'},
    'recording': 'Optional.',
    'textOnly': 'Typed notes are enough.',
    'retention': {'appTelemetryDays': 90, 'vendorDeletion': 'operator-defined'},
    'lawfulBasis': 'Contract.',
    'biometrics': 'No biometrics stored.',
}


def check(n, v):
    print(('PASS ' if v else 'FAIL ') + n)
    assert v, n


def boot(role):
    return {
        'protocol': 'atlas-personaplex-pcm-v1',
        'provider': 'workers',
        'providerLabel': 'ATLAS voice',
        'csrf': 'tok',
        'identity': {'name': 'synthetic@example.com', 'mode': 'access', 'subjectKey': 's'},
        'library': True,
        'libraryRole': role,
        'voices': ['atlas'],
        'defaultVoice': 'atlas',
        'captureRequired': True,
        'codecAvailable': True,
        'busy': False,
        'capacity': 1,
        'maxSeconds': 900,
        'speakingSeconds': 600,
        'memory': False,
        'transcription': True,
        'playbackAck': True,
    }


def route_for(role, html):
    def route(r):
        u = r.request.url.split('?', 1)[0].rstrip('/')
        if u.endswith('atlas.test'):
            return r.fulfill(body=html, content_type='text/html')
        if u == 'https://atlas.test/api/bootstrap':
            return r.fulfill(json=boot(role))
        if u == 'https://atlas.test/api/library/journey':
            return r.fulfill(json=JOURNEY)
        if u == 'https://atlas.test/api/library/privacy/disclosure':
            return r.fulfill(json=PRIVACY)
        if u == 'https://atlas.test/api/library':
            return r.fulfill(json=ITEMS)
        if r.request.method == 'POST' and u.endswith('/validate'):
            return r.fulfill(json={'ok': True})
        if r.request.method == 'POST' and u.endswith('/admin/publish'):
            return r.fulfill(json={'ok': True})
        return r.fulfill(status=404, json={'error': 'not mocked'})
    return route


def no_overflow(page):
    return page.evaluate(
        "() => { const n = document.getElementById('journey'); "
        "return !!n && n.scrollWidth <= n.clientWidth + 1; }"
    )


def main():
    H = (ROOT / 'ATLAS_Project_Intelligence.html').read_text()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        for role in ('reviewer', 'presales', 'admin'):
            ctx = browser.new_context(viewport={'width': 1280, 'height': 900})
            page = ctx.new_page()
            page.on('pageerror', lambda e, r=role: ERR.append(f'{r}: {e}'))
            page.route('**/*', route_for(role, H))
            page.goto('https://atlas.test/#journey')
            page.locator('header [data-view=journey]').click()
            page.locator('#journeyTitle', has_text='From the work to a reference').wait_for()
            page.locator('#journey .stage-grid').wait_for()
            for width in (320, 375, 1280):
                page.set_viewport_size({'width': width, 'height': 900})
                page.locator('#journeyTitle').wait_for()
                check(f'{role} journey fits at {width}px', no_overflow(page))
            ctx.close()
        browser.close()
    check('no page errors', not ERR)


if __name__ == '__main__':
    main()