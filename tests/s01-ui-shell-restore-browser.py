"""Inspector adapt checks for a restored Stories menu and the events chart.

A restored project stays unselected behind "Choose a project". Choosing a
real project, including the only one, commits it. The events chart name
includes the visible count.
  CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/s01-ui-shell-restore-browser.py
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
REFERENCE = {
    'stage': 'Pilot',
    'sector': 'Insurance',
    'consultant': {'name': 'Ada Example', 'role': 'Consultant'},
    'client': {'name': 'Example Mutual', 'location': 'Example City', 'contact': 'Operations'},
    'answers': ['A fictional queue.', '', '', '', '', ''],
    'validation': {'manager': {'name': 'Sam Example', 'email': 'manager@example.test'}, 'managerStaff': False},
}


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


def menu(page):
    return page.evaluate("""() => {
      const read = id => {
        const sel = document.getElementById(id);
        const opt = sel.options[sel.selectedIndex];
        return {
          disabled: sel.disabled,
          text: opt ? opt.text : '',
          value: opt ? opt.value : '',
          real: [...sel.options].filter(option => option.value).map(option => option.text),
        };
      };
      const story = read('storyProject');
      const interview = read('interviewProject');
      const empty = document.querySelector('#emptyStories h2');
      return { story, interview, heading: empty ? empty.textContent : '' };
    }""")


def unselected(state, titles):
    story, interview = state['story'], state['interview']
    return (
        not story['disabled'] and not interview['disabled']
        and story['real'] == titles and interview['real'] == titles
        and story['text'] == 'Choose a project' and story['value'] == ''
        and interview['text'] == 'Choose a project' and interview['value'] == ''
        and state['heading'] == 'Choose a project for this story.'
    )


def committed(page, title):
    # A real menu does not fire change when the chosen title is already the displayed value.
    page.evaluate(
        """title => {
          const sel = document.getElementById('storyProject');
          const option = [...sel.options].find(item => item.text === title);
          if (!option || sel.value === option.value) return;
          sel.value = option.value;
          sel.dispatchEvent(new Event('change', {bubbles: true}));
        }""",
        title,
    )
    page.wait_for_timeout(200)
    state = menu(page)
    story, interview = state['story'], state['interview']
    return (
        story['text'] == title and bool(story['value'])
        and interview['text'] == title and interview['value'] == story['value']
        and state['heading'] == 'Give this project a story.'
    )


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

        def open_as(email, roles=None):
            context = browser.new_context(viewport={'width': 1280, 'height': 800})
            page = context.new_page()
            query = '/?as=' + urllib.parse.quote(email)
            if roles:
                query += '&idp=' + urllib.parse.quote(json.dumps({'roles': roles}))
            page.goto(base + query)
            page.wait_for_timeout(400)
            return page

        def restored(page):
            page.wait_for_function(
                "() => (document.getElementById('toast')?.textContent || '').includes('Your projects are back')",
                timeout=8000,
            )
            page.locator('header [data-view=stories]').click()
            page.wait_for_timeout(300)

        solo = open_as('solo@example.test')
        seeded = solo.evaluate(
            """async (reference) => {
              const saved = await window.ATLAS_APP.libraryApi('', {method:'POST', body:{localId:'solo-restored', reference}});
              return saved && typeof saved.id === 'string' ? saved.id : '';
            }""",
            {**REFERENCE, 'title': 'Solo restored pilot'},
        )
        check('seeded one library record', bool(seeded))
        solo.reload()
        restored(solo)
        one = menu(solo)
        check('one restored project starts on Choose a project', unselected(one, ['Solo restored pilot']))
        check('choosing the only restored project commits it', committed(solo, 'Solo restored pilot'))

        several = open_as('consultant@example.test')
        restored(several)
        many = menu(several)
        titles = many['story']['real']
        check(
            'several restored projects start on Choose a project',
            unselected(many, titles) and titles == ['Admin test copy', 'Northwind queue pilot'],
        )
        check('choosing each restored project commits that one', all(committed(several, title) for title in titles))

        admin = open_as('admin@example.test', ['ATLAS.Interview', 'ATLAS.Admin'])
        admin.locator('header [data-view=admin]').click()
        admin.wait_for_selector('#admin .chart', timeout=8000)
        chart = admin.evaluate("""() => {
          const fig = document.querySelector('#admin .chart');
          const visible = [...fig.querySelectorAll('b')].reduce((sum, node) => sum + (parseInt(node.textContent, 10) || 0), 0);
          const word = visible === 1 ? 'event' : 'events';
          return fig.getAttribute('aria-label') === 'Events by day, ' + visible + ' ' + word && visible > 0;
        }""")
        check('the events chart name includes the visible count', chart)
        browser.close()
finally:
    proc.terminate()
    proc.wait(timeout=5)

if FAILS:
    raise SystemExit('failed: ' + ', '.join(FAILS))
