"""Group 12 interface checks copied from sweep 01: D-01 through D-12.

D-04 is the same defect as C-2 and is not repeated here.
Each check encodes the behaviour the page should have. The script exits
non-zero on main. Nothing here is skipped.
  CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/s01-ui-shell-d-browser.py
"""
import json
import os
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


number = port()
proc = subprocess.Popen(
    ['node', '--no-warnings', 'dev/local-edge.mjs', str(number)],
    cwd=EDGE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
)
base = f'http://127.0.0.1:{number}'
for _ in range(100):
    try:
        urllib.request.urlopen(base + '/', timeout=1)
        break
    except Exception:
        time.sleep(0.1)
else:
    proc.terminate()
    raise SystemExit('local edge did not start')

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None)

        def open_as(email, roles=None, viewport=None):
            context = browser.new_context(viewport=viewport or {'width': 1280, 'height': 800})
            page = context.new_page()
            query = '/?as=' + urllib.parse.quote(email)
            if roles:
                query += '&idp=' + urllib.parse.quote(json.dumps({'roles': roles}))
            page.goto(base + query)
            page.wait_for_timeout(900)
            return page

        stories = open_as('consultant@example.test')
        stories.wait_for_function(
            "() => (document.getElementById('toast')?.textContent || '').includes('Your projects are back')",
            timeout=8000,
        )
        stories.locator('header [data-view=stories]').click()
        stories.wait_for_timeout(400)
        story_state = stories.evaluate("""() => {
          const sel = document.getElementById('storyProject');
          const empty = document.getElementById('emptyStories');
          return {
            disabled: sel.disabled,
            real: [...sel.options].some(option => option.value),
            empty: empty && !empty.hidden ? empty.innerText : '',
          };
        }""")
        check(
            'D-01 stories lets a restored project be chosen',
            not (story_state['real'] and story_state['disabled'] and 'Create a project' in story_state['empty']),
        )

        phone = open_as('consultant@example.test', viewport={'width': 375, 'height': 812})
        clipped = phone.evaluate("""() => [...document.querySelectorAll('header nav button')]
          .filter(button => !button.hidden && button.offsetParent && button.scrollWidth > button.clientWidth + 1)
          .map(button => button.textContent.trim())""")
        check('D-02 navigation labels stay readable at 375px', clipped == [])

        journey = open_as('consultant@example.test')
        journey.locator('header [data-view=journey]').click()
        journey.get_by_role('heading', name='Stories you can open').wait_for(timeout=8000)
        queue = journey.evaluate("""() => {
          const aside = document.querySelector('#journey aside');
          return {
            titles: aside.querySelectorAll('article strong').length,
            actions: aside.querySelectorAll('article a, article button').length,
          };
        }""")
        check('D-03 each story the journey lists can be opened', queue['titles'] > 0 and queue['actions'] > 0)

        library = open_as('consultant@example.test')
        library.locator('header [data-view=library]').click()
        library.wait_for_timeout(600)
        status = library.locator('#storageStatus').inner_text()
        enable = library.locator('#enableSave').inner_text()
        check('D-05 saved library work does not share a row with Enable autosave', not ('Saved to ATLAS' in status and 'Enable autosave' in enable))

        zoom = open_as('consultant@example.test', viewport={'width': 640, 'height': 500})
        zoom.locator('header [data-view=library]').click()
        zoom.wait_for_timeout(400)
        fit = zoom.evaluate("""() => {
          const doc = document.documentElement;
          const avatar = document.getElementById('profileButton').getBoundingClientRect();
          return doc.scrollWidth <= doc.clientWidth + 8 && avatar.right <= doc.clientWidth;
        }""")
        check('D-06 the profile control stays inside a 640px layout', fit)

        voice = open_as('consultant@example.test')
        named = voice.evaluate("""() => {
          const chip = document.getElementById('studioConnection');
          const visible = (document.getElementById('voiceState')?.innerText || '').trim();
          const accessible = (chip?.getAttribute('aria-label') || chip?.innerText || '');
          return visible && accessible.toLowerCase().includes(visible.toLowerCase().replace(/[^a-z]/gi, ''));
        }""")
        check('D-07 the connection chip name includes the visible status', named)

        sample = open_as('consultant@example.test')
        sample.locator('#studioSample').click()
        sample.wait_for_timeout(400)
        sample.locator('header [data-view=stories]').click()
        sample.wait_for_timeout(500)
        silent = sample.locator('#storyPaper path[tabindex="0"][aria-label]').evaluate_all(
            "nodes => nodes.filter(node => !node.getAttribute('role')).length"
        )
        named = sample.locator('#storyPaper path[aria-label]').count()
        check('D-08 a focusable story-ring mark has a role that can carry its name', named > 0 and silent == 0)

        rtl = open_as('consultant@example.test')
        rtl.evaluate("document.documentElement.dir = 'rtl'")
        rtl.wait_for_timeout(200)
        swapped = rtl.evaluate("""() => {
          const count = document.getElementById('captureCount');
          const zero = count.childNodes[0];
          const span = count.querySelector('span');
          const range = document.createRange();
          range.setStart(zero, 0);
          range.setEnd(zero, 1);
          return range.getBoundingClientRect().left > span.getBoundingClientRect().left;
        }""")
        check('D-09 the topic count keeps zero before the total in RTL', not swapped)

        admin = open_as('admin@example.test', ['ATLAS.Interview', 'ATLAS.Admin'])
        admin.locator('header [data-view=admin]').click()
        admin.wait_for_selector('#admin .chart', timeout=8000)
        chart = admin.evaluate("""() => {
          const fig = document.querySelector('#admin .chart');
          const hasCount = value => /\\d+\\s*events?/i.test(value || '');
          return hasCount(fig.innerText) || hasCount(fig.getAttribute('aria-label'));
        }""")
        check('D-10 the events chart states how many events it drew', chart)

        lead = library.locator('#library p', has_text='N+1').first.inner_text()
        check('D-11 the library says who the N+1 is', 'manager' in lead.lower())

        levels = voice.evaluate("""() => [...document.querySelectorAll('#interview h1, #interview h2, #interview h3, #interview h4, h1, h2, h3')]
          .filter(node => node.offsetParent)
          .map(node => Number(node.tagName.slice(1)))""")
        skipped = any(levels[index] > levels[index - 1] + 1 for index in range(1, len(levels)))
        check('D-12 visible headings do not skip a level', levels and not skipped)
        browser.close()
finally:
    proc.terminate()
    proc.wait(timeout=5)

if FAILS:
    raise SystemExit('failed: ' + ', '.join(FAILS))
