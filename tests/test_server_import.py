"""The gateway module loads aiohttp. requirements.txt is the install that provides it."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def requirement_names(path):
    names = []
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or line.startswith('-'):
            continue
        names.append(line.split('>', 1)[0].split('=', 1)[0].split('<', 1)[0].split('[', 1)[0].strip())
    return names


def test_gateway_requirements_import_the_server():
    assert 'aiohttp' in requirement_names(ROOT / 'requirements.txt')
    included = (ROOT / 'requirements-test.txt').read_text(encoding='utf-8').splitlines()
    assert any(line.strip() == '-r requirements.txt' for line in included)
    import atlas_voice.server as server
    assert callable(server.create_app)
