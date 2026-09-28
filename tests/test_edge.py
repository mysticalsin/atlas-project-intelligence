"""The Cloudflare edge deployment must stay in sync with the Python source of truth."""
import importlib.util, json, subprocess, sys
from pathlib import Path
EDGE = Path(__file__).resolve().parents[1] / 'deploy' / 'cloudflare-edge'

def test_generated_policy_is_current():
    spec = importlib.util.spec_from_file_location('build_edge', EDGE / 'build_edge.py'); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    assert (EDGE / 'src' / 'policy.generated.js').read_text() == m.render(), 'Run: python deploy/cloudflare-edge/build_edge.py'

def test_parity_vectors_are_current(tmp_path):
    for gen, vec in (('gen_parity.py', 'parity.vectors.json'), ('gen_speech_parity.py', 'speech.vectors.json')):
        before = (EDGE / 'test' / vec).read_text()
        subprocess.run([sys.executable, str(EDGE / 'test' / gen)], check=True, capture_output=True)
        assert (EDGE / 'test' / vec).read_text() == before, f'{vec} was stale; regenerated — rerun the JS tests'

def test_wrangler_config_is_locked_down():
    text = (EDGE / 'wrangler.jsonc').read_text()
    body = json.loads('\n'.join(l for l in text.splitlines() if not l.strip().startswith('//')))
    assert body['ai'] == {'binding': 'AI'} and body['preview_urls'] is False and body['vars']['ORIGIN'].startswith('https://')
    assert 'CSRF_SECRET' not in body['vars'] and len(body['vars']['ACCESS_AUD']) == 64
