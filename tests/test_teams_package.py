"""Teams app package builder (WOW_SPEC F4.4, F4.8 #6): placeholder refusal, --draft output, required fields, icon
dimensions. Standard library only; the builder never uses the network. Outputs go to pytest's tmp_path."""
import importlib.util
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TEAMS = ROOT / 'deploy' / 'cloudflare-edge' / 'teams'
SCRIPT = TEAMS / 'build_teams_package.py'
spec = importlib.util.spec_from_file_location('build_teams_package', SCRIPT)
btp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(btp)

VALUES = {'TEAMS_APP_ID': '0d4c3a1e-5b6f-4a7b-8c9d-0e1f2a3b4c5d', 'TEAMS_BOT_APP_ID': '0d4c3a1e-5b6f-4a7b-8c9d-0e1f2a3b4c5d',
          'ATLAS_HOST': 'atlas.example.com', 'TEAMS_DEVELOPER_NAME': 'Example Developer', 'TEAMS_DEVELOPER_WEBSITE_URL': 'https://example.com/',
          'TEAMS_PRIVACY_URL': 'https://example.com/privacy', 'TEAMS_TERMS_URL': 'https://example.com/terms'}


def brand_icons(tmp_path, color=(192, 192), outline=(32, 32), outline_alpha=True):
    """Stand-in 'approved' icons (no placeholder marker) in a temporary directory."""
    d = tmp_path / 'icons'
    d.mkdir(exist_ok=True)
    (d / 'color.png').write_bytes(btp.make_png(*color, lambda x, y: (10, 20, 30, 255), text=None))
    a = 0 if outline_alpha else 255
    (d / 'outline.png').write_bytes(btp.make_png(*outline, lambda x, y: (255, 255, 255, a), text=None))
    return d


def run(*args, env=None):
    import os
    e = {k: v for k, v in os.environ.items() if k not in VALUES}
    e.update(env or {})
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=e, cwd=str(ROOT))


def test_template_matches_the_spec():
    m = json.loads((TEAMS / 'manifest.template.json').read_text())
    assert m['$schema'] == 'https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json'
    assert m['manifestVersion'] == '1.30' and m['name']['short'] == 'ATLAS'
    assert set(m['developer']) == {'name', 'websiteUrl', 'privacyUrl', 'termsOfUseUrl'}
    assert m['staticTabs'] == [{'entityId': 'atlas', 'name': 'ATLAS', 'contentUrl': 'https://{{ATLAS_HOST}}/teams/tab', 'websiteUrl': 'https://{{ATLAS_HOST}}/', 'scopes': ['personal']},
                               {'entityId': 'conversations', 'scopes': ['personal']}]
    assert m['bots'] == [{'botId': '{{TEAMS_BOT_APP_ID}}', 'scopes': ['personal'], 'isNotificationOnly': False, 'supportsFiles': False, 'supportsCalling': False,
                          'supportsVideo': False, 'commandLists': [{'scopes': ['personal'], 'commands': [{'title': 'stop', 'description': 'Stop interview invitations'}]}]}]
    assert m['validDomains'] == ['{{ATLAS_HOST}}']
    assert 'devicePermissions' not in m and 'webApplicationInfo' not in m
    assert m['icons'] == {'color': 'color.png', 'outline': 'outline.png'}


def test_refuses_placeholders_without_draft(tmp_path):
    r = run('--out', str(tmp_path))
    assert r.returncode == 2
    assert 'Placeholders without a value: ATLAS_HOST, TEAMS_APP_ID, TEAMS_BOT_APP_ID' in r.stderr
    assert not list(tmp_path.iterdir())
    partial = dict(VALUES)
    partial.pop('TEAMS_PRIVACY_URL')
    with pytest.raises(btp.PackageError, match='TEAMS_PRIVACY_URL'):
        btp.build(env=partial, out_dir=tmp_path, icons_dir=brand_icons(tmp_path))
    assert not (tmp_path / 'atlas-teams.zip').exists()


def test_placeholder_icons_are_refused_without_draft(tmp_path):
    with pytest.raises(btp.PackageError, match='color.png is a placeholder'):
        btp.build(env=VALUES, out_dir=tmp_path)


def test_draft_output_is_marked_and_zipped_at_the_root(tmp_path):
    r = run('--draft', '--out', str(tmp_path))
    assert r.returncode == 0, r.stderr
    assert 'DRAFT: not uploadable' in r.stdout
    z = zipfile.ZipFile(tmp_path / 'atlas-teams-DRAFT.zip')
    assert z.namelist() == ['manifest.json', 'color.png', 'outline.png']
    assert '{{TEAMS_APP_ID}}' in z.read('manifest.json').decode(), 'a draft keeps its placeholders (never sample values)'
    assert 'atlas.invalid' not in z.read('manifest.json').decode()


def test_full_build_fills_every_value(tmp_path):
    target = btp.build(env=VALUES, out_dir=tmp_path, icons_dir=brand_icons(tmp_path))
    assert target.name == 'atlas-teams.zip'
    z = zipfile.ZipFile(target)
    assert z.namelist() == ['manifest.json', 'color.png', 'outline.png']
    m = json.loads(z.read('manifest.json'))
    assert '{{' not in json.dumps(m)
    assert m['id'] == VALUES['TEAMS_APP_ID'] and m['bots'][0]['botId'] == VALUES['TEAMS_BOT_APP_ID']
    assert m['staticTabs'][0]['contentUrl'] == 'https://atlas.example.com/teams/tab' and m['validDomains'] == ['atlas.example.com']
    assert m['developer'] == {'name': 'Example Developer', 'websiteUrl': 'https://example.com/', 'privacyUrl': 'https://example.com/privacy', 'termsOfUseUrl': 'https://example.com/terms'}


@pytest.mark.parametrize('name,value', [('TEAMS_APP_ID', 'not-a-guid'), ('ATLAS_HOST', 'https://atlas.example.com'), ('ATLAS_HOST', 'atlas.example.com/x'),
                                        ('TEAMS_PRIVACY_URL', 'http://example.com/privacy'), ('TEAMS_DEVELOPER_NAME', 'x' * 40)])
def test_invalid_values_are_refused(tmp_path, name, value):
    with pytest.raises(btp.PackageError, match=name):
        btp.build(env={**VALUES, name: value}, out_dir=tmp_path, icons_dir=brand_icons(tmp_path))


def test_required_fields_lengths_and_enums(tmp_path):
    good = json.loads(btp.fill((TEAMS / 'manifest.template.json').read_text(), VALUES)[0])
    assert btp.check_builtin(good) == []
    cases = [
        (lambda m: m['developer'].pop('privacyUrl'), 'developer.privacyUrl is required.'),
        (lambda m: m['name'].__setitem__('short', 'x' * 31), 'name.short is longer than 30 characters.'),
        (lambda m: m['description'].__setitem__('short', 'x' * 81), 'description.short is longer than 80 characters.'),
        (lambda m: m['bots'][0].__setitem__('scopes', ['everyone']), 'bots[0].scopes must be a non-empty subset'),
        (lambda m: m.pop('accentColor'), 'accentColor is required.'),
        (lambda m: m.__setitem__('devicePermissions', ['media']), 'devicePermissions must not be present'),
        (lambda m: m.__setitem__('webApplicationInfo', {'id': 'x'}), 'webApplicationInfo must not be present'),
        (lambda m: m['staticTabs'][0].__setitem__('contentUrl', 'http://atlas.example.com/teams/tab'), 'staticTabs[0].contentUrl must be an https:// URL'),
        (lambda m: m.__setitem__('validDomains', ['https://atlas.example.com']), 'validDomains must be host names'),
    ]
    for mutate, message in cases:
        m = json.loads(json.dumps(good))
        mutate(m)
        assert any(message in e for e in btp.check_builtin(m)), message
    # A broken template is refused as a whole.
    bad = tmp_path / 'manifest.template.json'
    tpl = json.loads((TEAMS / 'manifest.template.json').read_text())
    tpl['name']['short'] = 'A' * 40
    bad.write_text(json.dumps(tpl))
    with pytest.raises(btp.PackageError, match='name.short is longer than 30'):
        btp.build(env=VALUES, out_dir=tmp_path, template=bad, icons_dir=brand_icons(tmp_path))


def test_vendored_schema_subset_is_used_when_present(tmp_path):
    schema = {'type': 'object', 'required': ['manifestVersion', 'id', 'developer'], 'definitions': {'guid': {'type': 'string', 'pattern': '^[0-9a-f-]{36}$'}},
              'properties': {'id': {'$ref': '#/definitions/guid'}, 'manifestVersion': {'type': 'string', 'enum': ['1.30']},
                             'name': {'type': 'object', 'properties': {'short': {'type': 'string', 'maxLength': 4}}}}}
    path = tmp_path / 'schema.json'
    path.write_text(json.dumps(schema))
    with pytest.raises(btp.PackageError, match=r'manifest.name.short is longer than 4 characters'):
        btp.build(env=VALUES, out_dir=tmp_path, icons_dir=brand_icons(tmp_path), schema=path)
    errors = btp.check_schema({'manifestVersion': '1.2', 'id': 'nope'}, schema)
    assert 'manifest.developer is required.' in errors and any('manifest.id does not match' in e for e in errors) and any('manifestVersion must be one of' in e for e in errors)


def rgb_png(width, height):
    """An opaque RGB PNG (colour type 2, no alpha, no tRNS)."""
    import struct
    import zlib
    chunk = lambda kind, body: struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    raw = b''.join(b'\x00' + b'\xff\xff\xff' * width for _ in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def test_icon_dimensions_and_transparency(tmp_path):
    for i, (kwargs, message) in enumerate([({'color': (96, 96)}, 'color.png must be 192x192 pixels (it is 96x96).'), ({'outline': (32, 30)}, 'outline.png must be 32x32 pixels (it is 32x30).')]):
        d = tmp_path / f'case{i}'
        d.mkdir()
        errors, _ = btp.check_icons(brand_icons(d, **kwargs), allow_placeholder=False)
        assert message in errors, errors
    d = tmp_path / 'opaque'
    d.mkdir()
    icons = brand_icons(d)
    (icons / 'outline.png').write_bytes(rgb_png(32, 32))
    assert btp.png_info((icons / 'outline.png').read_bytes())[:3] == (32, 32, False)
    assert 'outline.png must have a transparent background.' in btp.check_icons(icons, allow_placeholder=False)[0]
    assert btp.check_icons(brand_icons(tmp_path), allow_placeholder=False)[0] == []
    # The committed icons: right sizes, transparent outline, and marked as placeholders to replace.
    for name, size in btp.ICONS.items():
        w, h, alpha, placeholder = btp.png_info((TEAMS / name).read_bytes())
        assert (w, h) == size and alpha and placeholder, name
    with pytest.raises(btp.PackageError, match='not a PNG'):
        btp.png_info(b'GIF89a' + b'\x00' * 30)
