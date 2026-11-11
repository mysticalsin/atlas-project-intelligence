"""CI installs Python from the tested pins. The ffmpeg step stays."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PINS = {
    'aiohappyeyeballs': '2.6.2',
    'aiohttp': '3.13.3',
    'aiosignal': '1.4.0',
    'attrs': '26.1.0',
    'cryptography': '41.0.7',
    'frozenlist': '1.8.0',
    'greenlet': '3.5.6',
    'idna': '3.17',
    'iniconfig': '2.3.1',
    'lxml': '6.1.3',
    'msgpack': '1.2.4',
    'multidict': '6.7.1',
    'packaging': '26.3',
    'playwright': '1.64.1',
    'pluggy': '1.7.0',
    'propcache': '0.5.2',
    'pyee': '14.0.0',
    'pygments': '2.21.0',
    'pyjwt': '2.7.0',
    'pytest': '9.2.0',
    'pytest-asyncio': '1.4.1.post1',
    'python-docx': '1.2.0',
    'typing-extensions': '4.16.0',
    'yarl': '1.24.2',
}


def test_ci_installs_from_pins_and_keeps_ffmpeg():
    ci = (ROOT / '.github/workflows/ci.yml').read_text()
    pip = next(line for line in ci.splitlines() if 'pip install' in line)
    assert '-c constraints-tested.txt' in pip
    assert '-r requirements.txt' in pip and '-r requirements-test.txt' in pip
    assert 'msgpack' in pip and 'pyjwt' in pip and 'cryptography' in pip
    assert 'playwright' in pip and 'python-docx' in pip
    assert 'sudo apt-get install -y --no-install-recommends ffmpeg' in ci
    found = {}
    for line in (ROOT / 'constraints-tested.txt').read_text().splitlines():
        body = line.split('#', 1)[0].strip()
        if not body:
            continue
        assert '>=' not in body and '==' in body
        name, version = body.split('==', 1)
        found[name.lower().replace('_', '-')] = version.split()[0]
    assert found == PINS
