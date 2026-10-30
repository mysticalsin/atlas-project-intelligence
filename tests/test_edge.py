"""The Cloudflare edge deployment must stay in sync with the Python source of truth."""
import importlib.util, json, os, shutil, subprocess, sys
from pathlib import Path
import pytest
EDGE = Path(__file__).resolve().parents[1] / 'deploy' / 'cloudflare-edge'
ROOT = EDGE.parents[1]

def build_edge():
    spec = importlib.util.spec_from_file_location('build_edge', EDGE / 'build_edge.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m

def test_generated_policy_is_current():
    assert (EDGE / 'src' / 'policy.generated.js').read_text() == build_edge().render(), 'Run: python deploy/cloudflare-edge/build_edge.py'

def test_build_edge_policy_only_writes_the_constants_without_the_page(tmp_path):
    # A copy of build_edge.py in an empty tree (no ATLAS_Voice.html): --policy-only must succeed and copy no page.
    edge = tmp_path / 'deploy' / 'cloudflare-edge'; (edge / 'src').mkdir(parents=True)
    shutil.copy(EDGE / 'build_edge.py', edge / 'build_edge.py'); (tmp_path / 'atlas_voice').symlink_to(ROOT / 'atlas_voice')
    r = subprocess.run([sys.executable, str(edge / 'build_edge.py'), '--policy-only'], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert (edge / 'src' / 'policy.generated.js').read_text() == build_edge().render() and not (edge / 'src' / 'atlas.html').exists()
    assert subprocess.run([sys.executable, str(edge / 'build_edge.py')], capture_output=True).returncode != 0, 'without the flag the page is copied (none exists here)'

# Each generator records Python behaviour for a JS parity test. CAUTION: this rewrites the vector files, so run it in a
# clean tree only (WOW_SPEC §6.5); a stale file is left regenerated for review.
# One entry per line: later tasks append a line each.
VECTORS = [
    ('gen_parity.py', 'parity.vectors.json'),
    ('gen_speech_parity.py', 'speech.vectors.json'),
    ('gen_pace_parity.py', 'pace.vectors.json'),
    ('gen_gap_parity.py', 'gap.vectors.json'),
    ('gen_jev_parity.py', 'jev-customer.vectors.json'),
    ('gen_state_parity.py', 'state.vectors.json'),
]
@pytest.mark.parametrize('gen,vec', VECTORS)
def test_parity_vectors_are_current(gen, vec):
    if gen == 'gen_jev_parity.py':
        if not (EDGE / 'test' / gen).exists(): pytest.skip('gen_jev_parity.py is not in this tree yet (T1 step 3 adds it)')
        if importlib.util.find_spec('aiohttp') is None: pytest.skip('gen_jev_parity.py imports atlas_voice.jev, which needs aiohttp')
    path = EDGE / 'test' / vec
    before = path.read_text() if path.exists() else None
    subprocess.run([sys.executable, str(EDGE / 'test' / gen)], check=True, capture_output=True)
    assert path.read_text() == before, f'{vec} was stale; regenerated — rerun the JS tests'

def test_wrangler_config_is_locked_down():
    text = (EDGE / 'wrangler.jsonc').read_text()
    body = json.loads('\n'.join(l for l in text.splitlines() if not l.strip().startswith('//')))
    assert body['ai'] == {'binding': 'AI'} and body['preview_urls'] is False and body['vars']['ORIGIN'].startswith('https://')
    assert 'CSRF_SECRET' not in body['vars'] and len(body['vars']['ACCESS_AUD']) == 64

def test_edge_modules_registry_merges_constants_and_rejects_duplicates(tmp_path):
    # A copy of build_edge.py registering a throwaway module: its EDGE_CONSTANTS land after the built-in ones; a clash fails the build.
    edge = tmp_path / 'deploy' / 'cloudflare-edge'; (edge / 'src').mkdir(parents=True); (tmp_path / 'atlas_voice').symlink_to(ROOT / 'atlas_voice')
    (tmp_path / 'fake_edge_mod.py').write_text("EDGE_CONSTANTS = {'FAKE_CONSTANT': {'a': [1, 2]}}\n")
    src = (EDGE / 'build_edge.py').read_text(); assert '\n]\nfor _name in EDGE_MODULES' in src  # the registry's closing bracket; the fake module goes last, after any registered ones
    (edge / 'build_edge.py').write_text(src.replace('\n]\nfor _name in EDGE_MODULES', "\n    'fake_edge_mod',\n]\nfor _name in EDGE_MODULES"))
    env = {**os.environ, 'PYTHONPATH': str(tmp_path)}
    r = subprocess.run([sys.executable, str(edge / 'build_edge.py'), '--policy-only'], capture_output=True, text=True, env=env); assert r.returncode == 0, r.stderr
    out = (edge / 'src' / 'policy.generated.js').read_text()
    assert out.endswith('export const FAKE_CONSTANT = {"a": [1, 2]};\n') and out.startswith((EDGE / 'src' / 'policy.generated.js').read_text()[:200])
    (tmp_path / 'fake_edge_mod.py').write_text("EDGE_CONSTANTS = {'OPENING': 'x'}\n")
    r = subprocess.run([sys.executable, str(edge / 'build_edge.py'), '--policy-only'], capture_output=True, text=True, env=env)
    assert r.returncode != 0 and 'redefines edge constant OPENING' in r.stderr
