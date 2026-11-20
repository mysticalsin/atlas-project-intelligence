"""Measure #journey scrollWidth vs clientWidth (synthetic fixtures)."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WIDTHS = (320, 375, 1280)
ROLES = ('reviewer', 'presales', 'admin')
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


def measure(repo: Path) -> list[dict]:
    html = (repo / 'ATLAS_Project_Intelligence.html').read_text(encoding='utf-8')
    rows = []

    def route_for(role):
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
            return r.fulfill(status=404, json={'error': 'not mocked'})
        return route

    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        for role in ROLES:
            for width in WIDTHS:
                ctx = browser.new_context(viewport={'width': width, 'height': 900})
                page = ctx.new_page()
                page.route('**/*', route_for(role))
                page.goto('https://atlas.test/#journey')
                page.locator('header [data-view=journey]').click()
                page.locator('#journeyTitle', has_text='From the work to a reference').wait_for()
                m = page.evaluate(
                    "() => { const j = document.getElementById('journey'); const d = document.documentElement; "
                    "return { journey: [j.scrollWidth, j.clientWidth], page: [d.scrollWidth, d.clientWidth] }; }"
                )
                rows.append({'role': role, 'width': width, **m})
                ctx.close()
        browser.close()
    return rows


if __name__ == '__main__':
    import sys
    repo = Path(sys.argv[1] if len(sys.argv) > 1 else '.').resolve()
    for row in measure(repo):
        jsw, jcw = row['journey']
        psw, pcw = row['page']
        print(
            f"{row['role']:9} {row['width']:4} #journey {jsw}/{jcw} "
            f"overflow={jsw > jcw + 1} page {psw}/{pcw} page_overflow={psw > pcw + 1}"
        )