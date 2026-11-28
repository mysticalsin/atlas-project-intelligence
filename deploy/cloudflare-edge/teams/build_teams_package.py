#!/usr/bin/env python3
"""Build the ATLAS Microsoft Teams app package (WOW_SPEC F4.4). BUILT, NOT CONNECTED.

    python3 deploy/cloudflare-edge/teams/build_teams_package.py            # needs every value and brand icons
    python3 deploy/cloudflare-edge/teams/build_teams_package.py --draft    # writes atlas-teams-DRAFT.zip, not uploadable
    python3 deploy/cloudflare-edge/teams/build_teams_package.py --make-placeholder-icons

It fills the {{NAME}} placeholders of manifest.template.json from environment variables (TEAMS_APP_ID,
TEAMS_BOT_APP_ID, ATLAS_HOST, TEAMS_DEVELOPER_NAME, TEAMS_DEVELOPER_WEBSITE_URL, TEAMS_PRIVACY_URL, TEAMS_TERMS_URL).
It refuses to build while a placeholder or a placeholder icon remains, unless --draft. It validates the manifest
against teams/schema/MicrosoftTeams.schema.v1.30.json when that file is vendored, else against a built-in list of
required fields, lengths and enums, checks the icon sizes, and zips manifest.json, color.png and outline.png at the
root of the archive. Standard library only; it never uses the network.
"""
import argparse
import json
import os
import re
import struct
import sys
import zipfile
import zlib
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
TEMPLATE = HERE / 'manifest.template.json'
SCHEMA = HERE / 'schema' / 'MicrosoftTeams.schema.v1.30.json'
ICONS = {'color.png': (192, 192), 'outline.png': (32, 32)}
PLACEHOLDER = re.compile(r'\{\{([A-Z0-9_]+)\}\}')
MARK = 'PLACEHOLDER: replace with brand-approved icons'
GUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
HOST = re.compile(r'^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$')
HTTPS = re.compile(r'^https://[^\s/?#]+(?:[/?#][^\s]*)?$')
VALUES = {'TEAMS_APP_ID': GUID, 'TEAMS_BOT_APP_ID': GUID, 'ATLAS_HOST': HOST, 'TEAMS_DEVELOPER_NAME': re.compile(r'^\S.{0,31}$'),
          'TEAMS_DEVELOPER_WEBSITE_URL': HTTPS, 'TEAMS_PRIVACY_URL': HTTPS, 'TEAMS_TERMS_URL': HTTPS}
# Structurally valid stand-ins, used ONLY to validate a --draft manifest; they are never written into a package.
DRAFT_SAMPLE = {'TEAMS_APP_ID': '00000000-0000-0000-0000-000000000000', 'TEAMS_BOT_APP_ID': '00000000-0000-0000-0000-000000000000',
                'ATLAS_HOST': 'atlas.invalid', 'TEAMS_DEVELOPER_NAME': 'Draft', 'TEAMS_DEVELOPER_WEBSITE_URL': 'https://atlas.invalid/',
                'TEAMS_PRIVACY_URL': 'https://atlas.invalid/privacy', 'TEAMS_TERMS_URL': 'https://atlas.invalid/terms'}
SCOPES = {'personal', 'team', 'groupChat'}


class PackageError(Exception):
    """The package cannot be built; the message lists every reason."""


def url_has_userinfo(value):
    """True when a URL carries a username or password. Those must not enter the package."""
    try:
        parts = urlsplit(str(value))
    except ValueError:
        return True
    return parts.username is not None or parts.password is not None


def fill(text, env, draft=False):
    """Replace {{NAME}} with env[NAME] (validated, JSON-escaped). Returns (text, missing names)."""
    missing, bad = [], []

    def one(m):
        name = m.group(1)
        value = str(env.get(name, '') or '').strip()
        if not value:
            missing.append(name)
            return m.group(0)
        rule = VALUES.get(name)
        if rule and not rule.match(value):
            bad.append(f'{name} has an invalid value (expected {"a GUID" if rule is GUID else "a host name without scheme or path" if rule is HOST else "an https:// URL" if rule is HTTPS else "a short name"}).')
        elif rule is HTTPS and url_has_userinfo(value):
            bad.append(f'{name} must be an https:// URL without a username or password.')
        return json.dumps(value)[1:-1]
    out = PLACEHOLDER.sub(one, text)
    if bad:
        raise PackageError('\n'.join(bad))
    return out, sorted(set(missing))


def _check_len(errors, path, value, limit):
    if not isinstance(value, str) or not value:
        errors.append(f'{path} is required.')
    elif len(value) > limit:
        errors.append(f'{path} is longer than {limit} characters.')


def check_builtin(m):
    """The required fields, lengths and enums of the v1.30 manifest that this package uses (no schema vendored)."""
    errors = []
    for key in ('$schema', 'manifestVersion', 'version', 'id', 'developer', 'name', 'description', 'icons', 'accentColor'):
        if key not in m:
            errors.append(f'{key} is required.')
    if m.get('manifestVersion') != '1.30':
        errors.append('manifestVersion must be "1.30".')
    if not re.match(r'^\d+\.\d+\.\d+$', str(m.get('version', ''))):
        errors.append('version must be MAJOR.MINOR.PATCH.')
    if not GUID.match(str(m.get('id', ''))):
        errors.append('id must be a GUID (the Entra app registration id).')
    dev = m.get('developer') if isinstance(m.get('developer'), dict) else {}
    _check_len(errors, 'developer.name', dev.get('name'), 32)
    for k in ('websiteUrl', 'privacyUrl', 'termsOfUseUrl'):
        _check_len(errors, f'developer.{k}', dev.get(k), 2048)
        if isinstance(dev.get(k), str) and dev.get(k) and not HTTPS.match(dev[k]):
            errors.append(f'developer.{k} must be an https:// URL.')
        elif isinstance(dev.get(k), str) and url_has_userinfo(dev.get(k)):
            errors.append(f'developer.{k} must be an https:// URL without a username or password.')
    name = m.get('name') if isinstance(m.get('name'), dict) else {}
    _check_len(errors, 'name.short', name.get('short'), 30)
    if 'full' in name:
        _check_len(errors, 'name.full', name.get('full'), 100)
    desc = m.get('description') if isinstance(m.get('description'), dict) else {}
    _check_len(errors, 'description.short', desc.get('short'), 80)
    _check_len(errors, 'description.full', desc.get('full'), 4000)
    icons = m.get('icons') if isinstance(m.get('icons'), dict) else {}
    for k in ('color', 'outline'):
        _check_len(errors, f'icons.{k}', icons.get(k), 2048)
    if not re.match(r'^#[0-9a-fA-F]{6}$', str(m.get('accentColor', ''))):
        errors.append('accentColor must be #RRGGBB.')
    for i, tab in enumerate(m.get('staticTabs', []) or []):
        _check_len(errors, f'staticTabs[{i}].entityId', tab.get('entityId'), 64)
        if not tab.get('scopes') or not set(tab['scopes']) <= SCOPES:
            errors.append(f'staticTabs[{i}].scopes must be a non-empty subset of {sorted(SCOPES)}.')
        for k in ('contentUrl', 'websiteUrl'):
            if k in tab and (not HTTPS.match(str(tab[k])) or len(str(tab[k])) > 2048):
                errors.append(f'staticTabs[{i}].{k} must be an https:// URL of at most 2048 characters.')
            elif k in tab and url_has_userinfo(tab[k]):
                errors.append(f'staticTabs[{i}].{k} must be an https:// URL without a username or password.')
        if 'name' in tab:
            _check_len(errors, f'staticTabs[{i}].name', tab.get('name'), 128)
    for i, bot in enumerate(m.get('bots', []) or []):
        if not GUID.match(str(bot.get('botId', ''))):
            errors.append(f'bots[{i}].botId must be a GUID.')
        if not bot.get('scopes') or not set(bot['scopes']) <= SCOPES:
            errors.append(f'bots[{i}].scopes must be a non-empty subset of {sorted(SCOPES)}.')
        for j, cl in enumerate(bot.get('commandLists', []) or []):
            for k, cmd in enumerate(cl.get('commands', []) or []):
                _check_len(errors, f'bots[{i}].commandLists[{j}].commands[{k}].title', cmd.get('title'), 32)
                _check_len(errors, f'bots[{i}].commandLists[{j}].commands[{k}].description', cmd.get('description'), 128)
    domains = m.get('validDomains', []) or []
    if not isinstance(domains, list) or any(not isinstance(d, str) or not d or len(d) > 2048 or '://' in d for d in domains):
        errors.append('validDomains must be host names without a scheme.')
    # This build: no in-tab microphone and no Teams SSO (Q9).
    for key in ('devicePermissions', 'webApplicationInfo'):
        if key in m:
            errors.append(f'{key} must not be present in this build (no in-tab interview, no Teams SSO; Q9).')
    return errors


def check_schema(value, schema, root=None, path='manifest'):
    """A small JSON Schema subset (type, required, properties, items, enum, pattern, min/maxLength, maxItems, local $ref).
    Unknown keywords are ignored, so this is a floor, not a full validator."""
    root = root if root is not None else schema
    errors = []
    if not isinstance(schema, dict):
        return errors
    if '$ref' in schema and str(schema['$ref']).startswith('#/'):
        target = root
        for part in schema['$ref'][2:].split('/'):
            target = target.get(part, {}) if isinstance(target, dict) else {}
        return check_schema(value, target, root, path)
    types = schema.get('type')
    kinds = {'object': dict, 'array': list, 'string': str, 'boolean': bool, 'number': (int, float), 'integer': int}
    if types:
        allowed = types if isinstance(types, list) else [types]
        if not any(isinstance(value, kinds[t]) and not (t in ('number', 'integer') and isinstance(value, bool)) for t in allowed if t in kinds):
            return [f'{path} must be {"/".join(allowed)}.']
    if 'enum' in schema and value not in schema['enum']:
        errors.append(f'{path} must be one of {schema["enum"]}.')
    if isinstance(value, str):
        if 'maxLength' in schema and len(value) > schema['maxLength']:
            errors.append(f'{path} is longer than {schema["maxLength"]} characters.')
        if 'minLength' in schema and len(value) < schema['minLength']:
            errors.append(f'{path} is shorter than {schema["minLength"]} characters.')
        if 'pattern' in schema and not re.search(schema['pattern'], value):
            errors.append(f'{path} does not match {schema["pattern"]}.')
    if isinstance(value, dict):
        for key in schema.get('required', []):
            if key not in value:
                errors.append(f'{path}.{key} is required.')
        for key, sub in (schema.get('properties') or {}).items():
            if key in value:
                errors += check_schema(value[key], sub, root, f'{path}.{key}')
    if isinstance(value, list):
        if 'maxItems' in schema and len(value) > schema['maxItems']:
            errors.append(f'{path} has more than {schema["maxItems"]} items.')
        if isinstance(schema.get('items'), dict):
            for i, item in enumerate(value):
                errors += check_schema(item, schema['items'], root, f'{path}[{i}]')
    return errors


def png_info(data):
    """(width, height, has_alpha, is_placeholder) of a PNG, or raise PackageError."""
    if data[:8] != b'\x89PNG\r\n\x1a\n' or data[12:16] != b'IHDR':
        raise PackageError('not a PNG file.')
    width, height, _, color_type = struct.unpack('>IIBB', data[16:26])
    pos, trns, placeholder = 8, False, False
    while pos + 8 <= len(data):
        length, kind = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if kind == b'tRNS':
            trns = True
        if kind == b'tEXt' and MARK.encode() in body:
            placeholder = True
        pos += 12 + length
    return width, height, color_type in (4, 6) or trns, placeholder


def make_png(width, height, pixel, text=MARK):
    """RGBA PNG from pixel(x, y) -> (r, g, b, a). With `text`, a tEXt Comment chunk marks it."""
    raw = b''.join(b'\x00' + b''.join(bytes(pixel(x, y)) for x in range(width)) for y in range(height))
    chunk = lambda kind, body: struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)
    out = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
    if text:
        out += chunk(b'tEXt', b'Comment\x00' + text.encode())
    return out + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def placeholder_icons():
    """Plain generated placeholders (a ring), never the Mantu logo: color 192x192, outline 32x32 white on transparent."""
    def ring(size, inner, outer, fg, bg):
        c = (size - 1) / 2
        return lambda x, y: fg if inner <= ((x - c) ** 2 + (y - c) ** 2) ** 0.5 <= outer else bg
    return {'color.png': make_png(192, 192, ring(192, 44, 62, (255, 255, 255, 255), (62, 0, 122, 255))),
            'outline.png': make_png(32, 32, ring(32, 8, 12, (255, 255, 255, 255), (0, 0, 0, 0)))}


def check_icons(icons_dir, allow_placeholder):
    errors, blobs = [], {}
    for name, (w, h) in ICONS.items():
        path = Path(icons_dir) / name
        if not path.is_file():
            errors.append(f'{name} is missing.')
            continue
        data = path.read_bytes()
        try:
            width, height, alpha, placeholder = png_info(data)
        except PackageError as e:
            errors.append(f'{name}: {e}')
            continue
        if (width, height) != (w, h):
            errors.append(f'{name} must be {w}x{h} pixels (it is {width}x{height}).')
        if name == 'outline.png' and not alpha:
            errors.append('outline.png must have a transparent background.')
        if placeholder and not allow_placeholder:
            errors.append(f'{name} is a placeholder: replace it with a brand-approved icon, or build with --draft.')
        blobs[name] = data
    return errors, blobs


def build(env=None, draft=False, out_dir=None, template=TEMPLATE, icons_dir=HERE, schema=SCHEMA):
    """Build the package; returns the zip path. Raises PackageError with every reason when it cannot."""
    env = os.environ if env is None else env
    text = Path(template).read_text(encoding='utf-8')
    filled, missing = fill(text, env)
    errors = []
    if missing and not draft:
        errors.append('Placeholders without a value: ' + ', '.join(missing) + '. Set them as environment variables, or build with --draft.')
    probe, _ = fill(filled, DRAFT_SAMPLE) if draft else (filled, [])
    try:
        manifest = json.loads(probe)
    except json.JSONDecodeError as e:
        raise PackageError(f'manifest.template.json is not valid JSON: {e}')
    schema_path = Path(schema)
    errors += check_schema(manifest, json.loads(schema_path.read_text(encoding='utf-8'))) if schema_path.is_file() else check_builtin(manifest)
    icon_errors, blobs = check_icons(icons_dir, allow_placeholder=draft)
    errors += icon_errors
    if errors:
        raise PackageError('\n'.join(errors))
    out = Path(out_dir) if out_dir else HERE / 'dist'
    out.mkdir(parents=True, exist_ok=True)
    target = out / ('atlas-teams-DRAFT.zip' if draft else 'atlas-teams.zip')
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(json.loads(filled), indent=2, ensure_ascii=False) + '\n')
        for name in ICONS:
            z.writestr(name, blobs[name])
    return target


def main(argv=None):
    p = argparse.ArgumentParser(description='Build the ATLAS Teams app package (BUILT, NOT CONNECTED).')
    p.add_argument('--draft', action='store_true', help='allow placeholders and placeholder icons; writes atlas-teams-DRAFT.zip')
    p.add_argument('--out', help='output directory (default: teams/dist)')
    p.add_argument('--make-placeholder-icons', action='store_true', help='(re)write the generated placeholder icons and exit')
    a = p.parse_args(argv)
    if a.make_placeholder_icons:
        for name, data in placeholder_icons().items():
            (HERE / name).write_bytes(data)
        print('Wrote placeholder icons (replace with brand-approved icons): ' + ', '.join(ICONS))
        return 0
    try:
        target = build(draft=a.draft, out_dir=a.out)
    except PackageError as e:
        print('Refused to build the Teams package:\n' + str(e), file=sys.stderr)
        return 2
    print(f'Wrote {target}')
    if a.draft:
        print('DRAFT: not uploadable')
    return 0


if __name__ == '__main__':
    sys.exit(main())
