#!/usr/bin/env python3
"""Offline prerequisite/configuration checks. Never calls providers or prints secret values."""
from __future__ import annotations
import argparse
from urllib.parse import urlsplit
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
from typing import Mapping

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def literal_assignment(text: str) -> str:
    """The assignment text after '=', with a trailing shell comment removed.

    Bash starts a comment at '#' only when that character begins a word.
    A '#' attached to the value stays in the value. A later word that is not
    a comment is left in place so the caller still rejects it.
    """
    quote = ''
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if quote:
            if c == '\\' and quote == '"' and i + 1 < n:
                i += 2
                continue
            if c == quote:
                quote = ''
            i += 1
            continue
        if c in '"\'':
            quote = c
            i += 1
            continue
        if c == '\\' and i + 1 < n:
            i += 2
            continue
        if c.isspace():
            j = i
            while j < n and text[j].isspace():
                j += 1
            if j >= n or text[j] == '#':
                return text[:i]
            return text
        i += 1
    return text


def read_literal_env(path: Path) -> dict[str, str]:
    """Read a deliberately small .env grammar without executing shell code.

    The launcher sources a trusted shell file. This diagnostic does NOT; ambiguous
    interpolation/commands are rejected, never evaluated or echoed into errors.
    A '#' inside an assignment is kept. A '#' that begins a later word is a comment.
    """
    if not path.is_file() or path.stat().st_size > 65536:
        raise ValueError('Environment file is missing or exceeds 64 KiB.')
    out: dict[str, str] = {}
    for no, raw in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].lstrip()
        match = re.match(r'^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$', line)
        if not match or '$(' in line or '${' in line or '`' in line:
            raise ValueError(f'Line {no}: use literal KEY=value assignments; shell evaluation is not supported.')
        key = match.group(1)
        try:
            parts = shlex.split(literal_assignment(line[line.find('=') + 1:]), comments=False, posix=True)
        except ValueError:
            raise ValueError(f'Line {no}: invalid quoting; no value has been displayed.') from None
        if len(parts) > 1:
            raise ValueError(f'Line {no}: quote spaces in literal values; no value has been displayed.')
        out[key] = parts[0] if parts else ''
    return out


@contextlib.contextmanager
def environment(values: Mapping[str, str]):
    previous = dict(os.environ)
    try:
        os.environ.clear()
        os.environ.update(values)
        yield
    finally:
        os.environ.clear()
        os.environ.update(previous)


def available(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def probe(profile: str, values: Mapping[str, str]) -> dict:
    checks: list[dict] = []
    def add(name, ok, message, required=True):
        checks.append({'name': name, 'status': 'pass' if ok else 'fail' if required else 'warn', 'message': message})
    def present(key: str) -> bool:
        return bool(values.get(key, '').strip())
    add('python', sys.version_info >= (3, 11), 'Python 3.11+ required for the supported gateway environment.')
    required = ['build.py', 'src/shell.html', 'assets/Mantu.svg', 'ATLAS_Project_Intelligence.html', 'ATLAS_Voice.html']
    add('source', all((ROOT/p).is_file() for p in required), 'Build source, logo and compiled entry points must be present.')
    add('node', bool(shutil.which('node')), 'Node with node --test is needed for JavaScript unit tests.', required=False)
    add('pytest', available('pytest'), 'Install requirements-test.txt to run Python unit tests.', required=False)
    add('playwright', available('playwright'), 'Playwright plus Chromium is needed for browser checks.', required=False)
    if profile != 'preview':
        add('aiohttp', available('aiohttp'), 'Install requirements.txt for the application gateway.')
        try:
            from atlas_voice.config import Config
            with environment(values):
                cfg = Config.env()
            add('configuration', True, 'Existing Config validation passed; this does not test any service.')
        except (ValueError, TypeError, OverflowError):
            cfg = None
            add('configuration', False, 'Existing Config rejected configuration. Check bounded values, exact origin, auth fields and secret lengths in handoff/CONFIGURATION.md. Values are withheld.')
        provider = values.get('ATLAS_VOICE_PROVIDER', 'personaplex')
        if profile == 'hosted':
            add('selected-provider', provider == 'openai', 'Hosted profile requires explicit ATLAS_VOICE_PROVIDER=openai.')
        elif profile == 'nvidia':
            add('selected-provider', provider == 'personaplex', 'NVIDIA profile requires explicit ATLAS_VOICE_PROVIDER=personaplex.')
        elif profile == 'kyutai':
            add('selected-provider', provider == 'kyutai', 'Kyutai profile requires explicit ATLAS_VOICE_PROVIDER=kyutai.')
        else:
            add('selected-provider', provider in ('openai','personaplex','kyutai'), 'Choose one supported provider explicitly.')
        if provider == 'kyutai':
            add('msgpack', available('msgpack'), 'Install requirements.txt (msgpack) for the Kyutai speech protocol.')
            for key in ('KYUTAI_STT_URL', 'KYUTAI_TTS_URL', 'KYUTAI_VOICE', 'CONVERSATION_CHAT_URL', 'CONVERSATION_MODEL'):
                add(key.lower(), present(key), f'{key} must be configured; values are never printed.')
            add('evidence-analyst', present('ANALYST_CHAT_URL') and present('ANALYST_MODEL'),
                'Without ANALYST_CHAT_URL/ANALYST_MODEL there is no live quote-grounded evidence ledger.', required=False)
        if provider == 'openai':
            add('hosted-key', present('OPENAI_API_KEY'), 'OPENAI_API_KEY must be set server-side. Presence is not validity or account access.')
        if provider == 'personaplex':
            binary = values.get('FFMPEG', 'ffmpeg')
            executable = shutil.which(binary)
            opus = False
            if executable:
                try:
                    result = subprocess.run([executable, '-hide_banner', '-encoders'], capture_output=True, text=True, timeout=8, check=False)
                    opus = result.returncode == 0 and 'libopus' in result.stdout
                except (OSError, subprocess.TimeoutExpired):
                    pass
            add('ffmpeg-libopus', opus, 'PersonaPlex gateway requires FFmpeg with the libopus encoder; no audio or provider has been contacted.')
        if profile in ('shared', 'cloudflare'):
            add('entra-mode', values.get('ATLAS_AUTH') == 'entra', 'Shared use requires ATLAS_AUTH=entra; local workspace names are not authentication.')
            add('shared-https', values.get('ATLAS_ORIGIN','').startswith('https://'), 'Shared deployment requires an approved HTTPS origin and matching reverse proxy.')
            for key in ('ENTRA_TENANT_ID','ENTRA_CLIENT_ID','ENTRA_CLIENT_SECRET','HINDSIGHT_URL','HINDSIGHT_BANK_SECRET','ATLAS_WIKI_ROOT'):
                add(key.lower(), present(key), f'{key} must be configured; values are never printed.')
        if profile == 'cloudflare':
            host = urlsplit(values.get('ATLAS_ORIGIN', '')).hostname or ''
            add('tunnel-loopback-bind', values.get('ATLAS_BIND', '127.0.0.1') in ('127.0.0.1', '::1', 'localhost'),
                'Behind Cloudflare Tunnel the gateway binds loopback only; cloudflared on the same host is its sole ingress.')
            add('tunnel-public-origin', bool(host) and host not in ('127.0.0.1', '::1', 'localhost'),
                'ATLAS_ORIGIN must be the exact public https:// tunnel hostname, matching cloudflared httpHostHeader.')
            add('cloudflared', bool(shutil.which('cloudflared')), 'Install cloudflared on the gateway host; no tunnel or account has been contacted.', required=False)
        if values.get('ATLAS_AUTH') == 'entra':
            add('msal', available('msal'), 'Install requirements-entra.txt and validate the real tenant flow.')
        if present('HINDSIGHT_URL'):
            add('hindsight-sdk', available('hindsight_client') and available('hindsight_client_api'), 'Install requirements-hindsight.txt; verify generated Documents API compatibility with your fork.')
            add('hindsight-service-auth', present('HINDSIGHT_API_KEY'), 'No Hindsight key configured; verify the private service authentication policy before use.', required=False)
        if present('RIVA_URI'):
            add('riva-sdk', available('riva'), 'Install requirements-riva.txt for the explicitly selected transcription endpoint.')
        if present('STORY_EDITOR_MODEL'):
            add('editor-key', present('OPENAI_API_KEY'), 'Optional editor uses the server-held OPENAI_API_KEY.')
        if not present('ATLAS_WIKI_ROOT'):
            add('wiki-vault', False, 'Server Markdown wiki is disabled until ATLAS_WIKI_ROOT is configured.', required=False)
        add('not-live-verified', False, 'No API key validation, network request, login, microphone, GPU inference or external write was attempted.', required=False)
    return {'profile': profile, 'offline_only': True, 'checks': checks,
            'ready_for_local_prerequisites': not any(x['status']=='fail' for x in checks),
            'live_verified': False}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=['preview','hosted','nvidia','kyutai','shared','cloudflare'], default='preview')
    parser.add_argument('--env-file', type=Path, help='Optional trusted literal .env file; this tool never executes it.')
    parser.add_argument('--json', action='store_true', help='Emit redacted machine-readable check statuses.')
    args = parser.parse_args(argv)
    values = dict(os.environ)
    try:
        if args.env_file:
            values.update(read_literal_env(args.env_file))
        report = probe(args.profile, values)
    except (OSError, UnicodeError, ValueError) as exc:
        # OSError can contain operator paths; expose a generic status, not data.
        message = str(exc) if isinstance(exc, ValueError) else 'Environment file could not be read safely.'
        report = {'profile': args.profile, 'offline_only': True, 'ready_for_local_prerequisites': False,
                  'live_verified': False, 'checks':[{'name':'environment-file','status':'fail','message':message}]}
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print('ATLAS offline preflight — configuration is not connectivity')
        for check in report['checks']:
            print(f"{check['status'].upper():4}  {check['name']}: {check['message']}")
    return 0 if report['ready_for_local_prerequisites'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
