"""Group 12 shell checks copied from sweep 01: C-1, C-2, C-4, and C-5.

C-3 stays with group 13. That group owns src/voice-client.js and the
production-conflict sentence. This file does not assert it.
Each check encodes the behaviour the page should have. The script exits
non-zero on main. Nothing here is skipped.
  CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/s01-ui-shell-c-browser.py
"""
import json
import os
import re
import socket
import subprocess
import time
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDGE = ROOT / 'deploy' / 'cloudflare-edge'
FAILS = []


def check(name, value):
    print(('PASS ' if value else 'FAIL ') + name)
    if not value:
        FAILS.append(name)


def port():
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    number = sock.getsockname()[1]
    sock.close()
    return number


def start(extra=None):
    number = port()
    env = os.environ.copy()
    if extra:
        env.update(extra)
    proc = subprocess.Popen(
        ['node', '--no-warnings', 'dev/local-edge.mjs', str(number)],
        cwd=EDGE, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    base = f'http://127.0.0.1:{number}'
    for _ in range(100):
        try:
            urllib.request.urlopen(base + '/', timeout=1)
            return proc, base
        except Exception:
            time.sleep(0.1)
    proc.terminate()
    raise SystemExit('local edge did not start')


def page_for(browser, base, email, roles=None, viewport=None):
    context = browser.new_context(viewport=viewport or {'width': 1280, 'height': 800})
    page = context.new_page()
    query = '/?as=' + urllib.parse.quote(email)
    if roles:
        query += '&idp=' + urllib.parse.quote(json.dumps({'roles': roles}))
    page.goto(base + query)
    page.wait_for_timeout(800)
    return page


proc, base = start()
try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)
        manager = page_for(browser, base, 'manager@example.test')
        manager.locator('header [data-view=journey]').click()
        manager.locator('#journey article', has_text='Northwind').get_by_role('button', name='Approve as trusted manager').click()
        manager.wait_for_timeout(900)
        presales = page_for(browser, base, 'presales@example.test', ['ATLAS.Interview', 'ATLAS.Presales'])
        presales.locator('header [data-view=journey]').click()
        presales.locator('#journey article', has_text='Northwind').get_by_role('button', name='Approve for bid / pre-sales').click()
        presales.wait_for_timeout(900)
        colleague = page_for(browser, base, 'colleague2@example.test')
        colleague.locator('header [data-view=library]').click()
        card = colleague.locator('#libraryList .project-card', has_text='Northwind')
        card.wait_for(timeout=8000)
        card.locator('[data-open-record]').click()
        colleague.wait_for_timeout(700)
        body = colleague.locator('#recordBody').inner_text()
        check(
            'C-1 a published record names the approver and the time, and omits blank quality numbers',
            'undefined' not in body and 'Invalid Date' not in body and not re.search(r'threshold\s*·\s*completeness', body)
            and 'Northwind Mutual' not in body,
        )

        consultant = page_for(browser, base, 'consultant@example.test')
        consultant.locator('header [data-view=journey]').click()
        consultant.locator('a', has_text='Trusted manager').click()
        consultant.wait_for_timeout(900)
        active = consultant.locator('header nav button.active').inner_text().strip()
        opened = consultant.evaluate("() => ({ hash: location.hash, hidden: document.getElementById('journey').hidden })")
        check('C-2 a journey persona link opens Journey', opened['hash'] == '#journey' and active == 'Journey' and not opened['hidden'])

        consultant.locator('header [data-view=interview]').click()
        consultant.context.set_offline(True)
        consultant.locator('header [data-view=library]').click()
        consultant.wait_for_timeout(800)
        library = consultant.locator('#library').inner_text()
        check(
            'C-4 an offline library names the network and keeps a retry',
            'Failed to fetch' not in library and consultant.locator('#library').get_by_role('button', name=re.compile('retry', re.I)).count() > 0,
        )
        consultant.context.set_offline(False)

        maker = page_for(browser, base, 'consultant@example.test')
        maker.locator('[data-action=new-project]:visible').first.click()
        maker.locator('#projectTitle').fill('A' * 140)
        maker.locator('#consultantName').fill('Ada Example')
        maker.locator('#consultantRole').fill('Lead')
        maker.locator('#n1Email').fill('manager@example.test')
        maker.locator('#projectForm button[type=submit]').click()
        maker.wait_for_timeout(400)
        box = maker.evaluate("""() => {
          const title = document.getElementById('contextProjectTitle');
          const card = title.closest('.context-card');
          const titleBox = title.getBoundingClientRect();
          const cardBox = card.getBoundingClientRect();
          return { scroll: title.scrollWidth, client: title.clientWidth, right: titleBox.right, cardRight: cardBox.right };
        }""")
        check(
            'C-5 a long project title stays inside the conversation card',
            box['right'] <= box['cardRight'] + 1 and box['scroll'] <= box['client'] + 1,
        )
        browser.close()
finally:
    proc.terminate()
    proc.wait(timeout=5)

if FAILS:
    raise SystemExit('failed: ' + ', '.join(FAILS))
