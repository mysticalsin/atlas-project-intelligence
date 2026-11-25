"""The PersonaPlex codec must not inherit gateway secrets."""
import asyncio
import os
import stat
from pathlib import Path

from atlas_voice.audio import AudioCodec

SECRET = 'ATLAS_SYNTHETIC_SECRET'
OTHER = 'ENTRA_CLIENT_SECRET'


def _script(path: Path) -> None:
    path.write_text('#!/bin/sh\nexec sleep 30\n', encoding='ascii')
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def _environ(pid: int) -> dict:
    raw = Path(f'/proc/{pid}/environ').read_bytes()
    found = {}
    for item in raw.split(b'\0'):
        if not item or b'=' not in item:
            continue
        key, value = item.split(b'=', 1)
        found[key.decode('ascii')] = value.decode('ascii', 'replace')
    return found


def test_codec_process_does_not_inherit_gateway_secrets(tmp_path):
    script = tmp_path / 'ffmpeg'
    _script(script)
    os.environ[SECRET] = 'synthetic-zebra'
    os.environ[OTHER] = 'synthetic-client-secret'
    try:
        asyncio.run(_run(script))
    finally:
        os.environ.pop(SECRET, None)
        os.environ.pop(OTHER, None)


async def _run(script: Path) -> None:
    codec = AudioCodec(str(script))
    await codec.start()
    try:
        for proc in (codec.encoder, codec.decoder):
            assert proc.returncode is None
            seen = _environ(proc.pid)
            got_secret = seen.get(SECRET)
            got_other = seen.get(OTHER)
            got_path = seen.get('PATH')
            assert got_secret is None
            assert got_other is None
            assert got_path == os.environ.get('PATH')
    finally:
        await codec.close()
