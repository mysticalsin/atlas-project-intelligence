"""Teams package URLs must not carry a username or password into the manifest."""
import importlib.util
import json
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TEAMS = ROOT / 'deploy' / 'cloudflare-edge' / 'teams'
spec = importlib.util.spec_from_file_location('build_teams_package', TEAMS / 'build_teams_package.py')
btp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(btp)

VALUES = {'TEAMS_APP_ID': '0d4c3a1e-5b6f-4a7b-8c9d-0e1f2a3b4c5d', 'TEAMS_BOT_APP_ID': '0d4c3a1e-5b6f-4a7b-8c9d-0e1f2a3b4c5d',
          'ATLAS_HOST': 'atlas.example.com', 'TEAMS_DEVELOPER_NAME': 'Example Developer', 'TEAMS_DEVELOPER_WEBSITE_URL': 'https://example.com/',
          'TEAMS_PRIVACY_URL': 'https://example.com/privacy', 'TEAMS_TERMS_URL': 'https://example.com/terms'}


def brand_icons(tmp_path):
    d = tmp_path / 'icons'
    d.mkdir(exist_ok=True)
    (d / 'color.png').write_bytes(btp.make_png(192, 192, lambda x, y: (10, 20, 30, 255), text=None))
    (d / 'outline.png').write_bytes(btp.make_png(32, 32, lambda x, y: (255, 255, 255, 0), text=None))
    return d


@pytest.mark.parametrize('name', ['TEAMS_DEVELOPER_WEBSITE_URL', 'TEAMS_PRIVACY_URL', 'TEAMS_TERMS_URL'])
def test_https_userinfo_is_refused_before_the_zip_is_written(tmp_path, name):
    env = {**VALUES, name: 'https://user:secret@example.com/privacy'}
    with pytest.raises(btp.PackageError, match=name):
        btp.build(env=env, out_dir=tmp_path, icons_dir=brand_icons(tmp_path))
    assert not (tmp_path / 'atlas-teams.zip').exists()


def test_builtin_check_rejects_userinfo_in_developer_and_tab_urls():
    manifest = json.loads(btp.fill((TEAMS / 'manifest.template.json').read_text(), VALUES)[0])
    manifest['developer']['privacyUrl'] = 'https://user:secret@example.com/privacy'
    manifest['staticTabs'][0]['contentUrl'] = 'https://user:secret@atlas.example.com/teams/tab'
    errors = btp.check_builtin(manifest)
    assert any('developer.privacyUrl' in e and 'username' in e for e in errors)
    assert any('staticTabs[0].contentUrl' in e and 'username' in e for e in errors)


def test_https_url_without_userinfo_still_builds(tmp_path):
    target = btp.build(env=VALUES, out_dir=tmp_path, icons_dir=brand_icons(tmp_path))
    manifest = json.loads(zipfile.ZipFile(target).read('manifest.json'))
    assert manifest['developer']['privacyUrl'] == 'https://example.com/privacy'
    assert manifest['developer']['websiteUrl'] == 'https://example.com/'
    assert manifest['developer']['termsOfUseUrl'] == 'https://example.com/terms'
