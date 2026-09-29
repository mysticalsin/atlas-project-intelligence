"""ATLAS_HOME is baked into every copy at build time (WOW_ZERO_CONFIG §3.10, §9). Stdlib only.
The override and invalid cases build in a temporary tree (build.py copied, sources symlinked), so the delivered aliases in
the working copy are never rewritten by this test.
  python3 -m pytest tests/test_build_home.py -q
"""
import json, os, re, shutil, subprocess, sys
from pathlib import Path
import pytest

ROOT = Path(__file__).resolve().parents[1]
ALIASES = ['ATLAS_Project_Intelligence.html', 'ATLAS_Intelligence.html', 'ATLAS_Voice_Studio.html', 'ATLAS_Voice.html']
SLOT = re.compile(r'<script>window\.ATLAS_HOME=("[^"<]*");</script>')


def origin():
    text = (ROOT / 'deploy/cloudflare-edge/wrangler.jsonc').read_text()
    return json.loads('\n'.join(l for l in text.splitlines() if not l.strip().startswith('//')))['vars']['ORIGIN']


def homes(html):
    return [json.loads(m) for m in SLOT.findall(html)]


def build(tmp, env_value=None, wrangler=None):
    """Run a copy of build.py in tmp with the real sources symlinked; optionally a stand-in wrangler.jsonc."""
    shutil.copy(ROOT / 'build.py', tmp / 'build.py')
    for name in ('src', 'assets', 'docs', 'atlas_voice'):
        (tmp / name).symlink_to(ROOT / name)
    edge = tmp / 'deploy' / 'cloudflare-edge'
    edge.mkdir(parents=True)
    (edge / 'wrangler.jsonc').write_text(wrangler if wrangler is not None else (ROOT / 'deploy/cloudflare-edge/wrangler.jsonc').read_text())
    env = {k: v for k, v in os.environ.items() if k != 'ATLAS_HOME_URL'}
    if env_value is not None:
        env['ATLAS_HOME_URL'] = env_value
    r = subprocess.run([sys.executable, str(tmp / 'build.py')], capture_output=True, text=True, env=env, timeout=120)
    assert r.returncode == 0, r.stderr
    return [(tmp / a).read_text() for a in ALIASES]


def test_delivered_aliases_carry_the_wrangler_origin():
    want = origin()
    assert re.fullmatch(r'https://[a-z0-9.-]+', want)
    for a in ALIASES:
        assert homes((ROOT / a).read_text()) == [want], a + ': run python3 build.py'


def test_default_comes_from_wrangler_origin(tmp_path):
    for html in build(tmp_path):
        assert homes(html) == [origin()]
        assert '__ATLAS_HOME__' not in html and '__SESSION_KEEPER__' not in html and '__PROFILE_CORE__' not in html and '__PROFILE_UI__' not in html


def test_environment_override(tmp_path):
    for html in build(tmp_path, env_value='https://atlas.mantu.example'):
        assert homes(html) == ['https://atlas.mantu.example']


@pytest.mark.parametrize('bad', ['http://atlas.tony-walteur.workers.dev', 'https://atlas.example/go/start', 'https://ATLAS.example',
                                 'https://user@atlas.example', 'javascript:alert(1)', 'https://atlas.example";alert(1);"', ' ', ''])
def test_invalid_override_gives_empty(tmp_path, bad):
    for html in build(tmp_path, env_value=bad):
        assert homes(html) == ['']


def test_invalid_or_missing_wrangler_origin_gives_empty(tmp_path):
    bad = '// test\n{"vars": {"ORIGIN": "http://insecure.example"}}\n'
    for html in build(tmp_path, wrangler=bad):
        assert homes(html) == ['']
