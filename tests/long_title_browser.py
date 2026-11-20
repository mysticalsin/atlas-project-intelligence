"""Long story and record titles must stay inside the page.

Widths 320, 375, and 1280. Three titles: 5000 characters with spaces, a
5000-character token with no spaces, and a long title with emoji and RTL
characters. Lists clamp. Detail, the record dialog, and the export preview
wrap. The stored model slices titles before paint, so this drives the real
nodes and then writes the long strings into them.

  CHROMIUM_PATH=/usr/bin/google-chrome python3 tests/long_title_browser.py
"""
import os, re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'ATLAS_Project_Intelligence.html').read_text()
HTML = re.sub(r'<meta content="[^"]*" http-equiv="Content-Security-Policy"/>', '', HTML, count=1)
WIDTHS = (320, 375, 1280)
R = []

def title_cases():
    spaced = ('Synthetic record ' * 400)[:5000]
    token = 'X' * 5000
    rtl = ('مشروع🌟' * 120) + '\u202b' + ('עברית' * 80) + '⭐' + ('عنوان' * 80)
    return (('spaced', spaced), ('token', token), ('rtl', rtl))

def check(name, ok, detail=''):
    R.append({'name': name, 'passed': bool(ok)})
    line = ('PASS ' if ok else 'FAIL ') + name
    if detail and not ok:
        line += ' :: ' + detail
    print(line)

PROBE = r"""
(spec) => {
  const token = spec.token;
  const want = spec.what;
  const setText = (el) => { if (el) el.textContent = token; return el; };
  if (want === 'projects') {
    setText(document.querySelector('#projectCards .project-card > h2'));
    setText(document.querySelector('#projectDetail .detail-title > div > h2'));
  } else if (want === 'story') {
    setText(document.querySelector('#storyPaper .paper-head > h2'));
  } else if (want === 'library') {
    const lib = document.getElementById('libraryList');
    lib.replaceChildren();
    const card = document.createElement('article');
    card.className = 'project-card';
    const h3 = document.createElement('h3');
    card.append(h3);
    lib.append(card);
    h3.textContent = token;
  } else if (want === 'record') {
    setText(document.getElementById('recordTitle'));
    const dialog = document.getElementById('recordDialog');
    if (!dialog.open) dialog.showModal();
  } else if (want === 'preview') {
    const prev = document.getElementById('sheetPreview');
    const step = prev.closest('[data-sheet-step]');
    if (step) step.hidden = false;
    prev.replaceChildren();
    const box = document.createElement('div');
    box.className = 'sheet-preview';
    const h2 = document.createElement('h2');
    box.append(h2);
    prev.append(box);
    h2.textContent = token;
    const dialog = document.getElementById('sheetDialog');
    if (!dialog.open) dialog.showModal();
  }
  const root = document.documentElement;
  const fit = (el, bound) => {
    if (!el || !el.getClientRects().length) return null;
    const rect = el.getBoundingClientRect();
    const parent = bound || el.parentElement;
    const prect = parent.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      full: el.textContent === token,
      textOver: el.scrollWidth > el.clientWidth + 1,
      boxOver: rect.left < prect.left - 1 || rect.right > prect.right + 1,
      sw: el.scrollWidth,
      cw: el.clientWidth,
      clamp: style.webkitLineClamp || 'none',
      wrap: style.overflowWrap,
      h: Math.round(rect.height),
      parentMin: getComputedStyle(el.parentElement).minWidth,
    };
  };
  const authorMin = (el) => {
    const found = [];
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText && rule.style) {
          let matches = false;
          try { matches = el.matches(rule.selectorText); } catch (err) { matches = false; }
          if (!matches) continue;
          const value = rule.style.getPropertyValue('min-width').trim();
          if (value) found.push(value);
        } else if (rule.cssRules) walk(rule.cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try { walk(sheet.cssRules); } catch (err) { /* cross-origin sheet */ }
    }
    return found;
  };
  const flexChild = document.querySelector('#recordDialog .dialog-head > div');
  const dialog = document.getElementById(want === 'preview' ? 'sheetDialog' : 'recordDialog');
  const recordTitle = document.getElementById('recordTitle');
  return {
    docSW: root.scrollWidth,
    docCW: root.clientWidth,
    docOver: root.scrollWidth > root.clientWidth,
    card: fit(document.querySelector('#projectCards .project-card > h2')),
    detail: fit(document.querySelector('#projectDetail .detail-title > div > h2')),
    flexMin: authorMin(flexChild),
    paper: fit(document.querySelector('#storyPaper .paper-head > h2')),
    lib: fit(document.querySelector('#libraryList > .project-card > h3')),
    record: fit(recordTitle, document.getElementById('recordDialog')),
    preview: fit(document.querySelector('#sheetPreview .sheet-preview > h2'), document.querySelector('#sheetPreview .sheet-preview')),
    dialogOver: !!(dialog && dialog.open && dialog.scrollWidth > dialog.clientWidth + 1),
    dialogSW: dialog && dialog.open ? dialog.scrollWidth : 0,
    dialogCW: dialog && dialog.open ? dialog.clientWidth : 0,
  };
}
"""

def detail_of(m, key):
    row = m.get(key) or {}
    return 'sw=%s cw=%s clamp=%s wrap=%s h=%s' % (row.get('sw'), row.get('cw'), row.get('clamp'), row.get('wrap'), row.get('h'))

def main():
    cases = title_cases()
    assert len(cases[0][1]) == 5000 and ' ' in cases[0][1]
    assert len(cases[1][1]) == 5000 and ' ' not in cases[1][1]
    assert '🌟' in cases[2][1] and '\u202b' in cases[2][1]
    shots = os.environ.get('SHOTS')
    prefix = os.environ.get('SHOT_PREFIX', 'title')
    if shots:
        Path(shots).mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or None, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1280, 'height': 800})
        page.set_default_timeout(8000)
        page.on('pageerror', lambda err: errors.append(str(err)))
        page.set_content(HTML, wait_until='domcontentloaded')
        page.wait_for_timeout(200)
        page.evaluate("() => document.querySelector('[data-action=new-project]').click()")
        page.locator('#projectTitle').fill('Short synthetic title')
        page.locator('#consultantName').fill('Ada')
        page.locator('#projectForm button[type=submit]').click()
        page.wait_for_timeout(200)
        ready = page.evaluate("""() => {
          document.body.classList.remove('voice-first');
          const input = document.getElementById('answerInput');
          input.value = 'I rebuilt one queue and kept the manual path for the exceptions.';
          input.dispatchEvent(new Event('input', {bubbles: true}));
          document.getElementById('nextButton').click();
          window.ATLAS_APP.switchView('projects');
          document.querySelector('#projectCards [data-project]').click();
          const draft = document.querySelector('[data-action=draft]');
          if (draft) draft.click();
          return {
            card: !!document.querySelector('#projectCards .project-card > h2'),
            paper: !!document.querySelector('#storyPaper .paper-head > h2'),
          };
        }""")
        check('setup paints a project card and a story', ready['card'] and ready['paper'], str(ready))
        if not (ready['card'] and ready['paper']):
            raise SystemExit(1)
        for width in WIDTHS:
            page.set_viewport_size({'width': width, 'height': 800})
            for kind, token in cases:
                label = '%s %s' % (width, kind)
                page.evaluate("(v) => window.ATLAS_APP.switchView(v)", 'projects')
                projects = page.evaluate(PROBE, {'token': token, 'what': 'projects'})
                check(label + ': no horizontal overflow', not projects['docOver'], 'doc %s/%s' % (projects['docSW'], projects['docCW']))
                card = projects['card'] or {}
                check(
                    label + ': list title is clamped',
                    card.get('full') and card.get('clamp') == '2' and not card.get('textOver') and not card.get('boxOver') and card.get('h', 999) < 90,
                    detail_of(projects, 'card'),
                )
                detail = projects['detail'] or {}
                check(
                    label + ': detail title wraps with overflow-wrap anywhere',
                    detail.get('full') and detail.get('wrap') == 'anywhere' and detail.get('clamp') == 'none' and not detail.get('textOver') and not detail.get('boxOver'),
                    detail_of(projects, 'detail'),
                )
                page.evaluate("(v) => window.ATLAS_APP.switchView(v)", 'stories')
                story = page.evaluate(PROBE, {'token': token, 'what': 'story'})
                paper = story['paper'] or {}
                check(
                    label + ': story title wraps in the detail',
                    not story['docOver'] and paper.get('full') and paper.get('wrap') == 'anywhere' and paper.get('clamp') == 'none' and not paper.get('textOver') and not paper.get('boxOver'),
                    detail_of(story, 'paper') + ' doc %s/%s' % (story['docSW'], story['docCW']),
                )
                page.evaluate("(v) => window.ATLAS_APP.switchView(v)", 'library')
                page.wait_for_function("() => document.getElementById('libraryStatusLine').textContent !== 'Loading the library…'")
                library = page.evaluate(PROBE, {'token': token, 'what': 'library'})
                lib = library['lib'] or {}
                check(
                    label + ': library card title is clamped',
                    not library['docOver'] and lib.get('full') and lib.get('clamp') == '2' and not lib.get('textOver') and not lib.get('boxOver'),
                    detail_of(library, 'lib') + ' doc %s/%s' % (library['docSW'], library['docCW']),
                )
                record = page.evaluate(PROBE, {'token': token, 'what': 'record'})
                rec = record['record'] or {}
                check(
                    label + ': dialog title wraps inside the dialog',
                    rec.get('full') and rec.get('wrap') == 'anywhere' and rec.get('clamp') == 'none' and not rec.get('textOver') and not rec.get('boxOver'),
                    detail_of(record, 'record'),
                )
                check(
                    label + ': dialog has no horizontal overflow',
                    not record['dialogOver'],
                    'dialog %s/%s' % (record['dialogSW'], record['dialogCW']),
                )
                check(
                    label + ': dialog title flex child can shrink',
                    '0' in (record.get('flexMin') or []) or '0px' in (record.get('flexMin') or []),
                    'min-width ' + str(record.get('flexMin')),
                )
                preview = page.evaluate(PROBE, {'token': token, 'what': 'preview'})
                prev = preview['preview'] or {}
                check(
                    label + ': export preview wraps with overflow-wrap anywhere',
                    prev.get('full') and prev.get('wrap') == 'anywhere' and prev.get('clamp') == 'none' and not prev.get('textOver') and not prev.get('boxOver') and not preview['dialogOver'],
                    detail_of(preview, 'preview') + ' dialog %s/%s' % (preview['dialogSW'], preview['dialogCW']),
                )
                if shots:
                    page.evaluate("""() => {
                      document.getElementById('recordDialog').close();
                      document.getElementById('sheetDialog').close();
                    }""")
                    page.evaluate("(v) => window.ATLAS_APP.switchView(v)", 'projects')
                    page.evaluate(PROBE, {'token': token, 'what': 'projects'})
                    page.evaluate("() => document.querySelector('#projectCards .project-card')?.scrollIntoView({block: 'center'})")
                    page.screenshot(path=str(Path(shots) / ('%s-projects-%s-%s.png' % (prefix, kind, width))))
                    page.evaluate(PROBE, {'token': token, 'what': 'record'})
                    page.locator('#recordDialog').screenshot(path=str(Path(shots) / ('%s-dialog-%s-%s.png' % (prefix, kind, width))))
                    page.evaluate("() => document.getElementById('recordDialog').close()")
                    page.evaluate(PROBE, {'token': token, 'what': 'preview'})
                    page.locator('#sheetDialog').screenshot(path=str(Path(shots) / ('%s-preview-%s-%s.png' % (prefix, kind, width))))
                    page.evaluate("() => document.getElementById('sheetDialog').close()")
                else:
                    page.evaluate("""() => {
                      document.getElementById('recordDialog').close();
                      document.getElementById('sheetDialog').close();
                    }""")
        browser.close()
    check('no page error', not errors, '; '.join(errors[:3]))
    failed = [row for row in R if not row['passed']]
    print('CHECKS %d PASS %d FAIL %d' % (len(R), len(R) - len(failed), len(failed)))
    if failed:
        raise SystemExit(1)

if __name__ == '__main__':
    main()
