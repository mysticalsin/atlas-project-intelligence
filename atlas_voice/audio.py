"""Streaming PCM <-> Ogg/Opus using FFmpeg, compatible with PersonaPlex's Opus framing.

No files, shell invocation, uploaded codecs, or microphone data in logs.
Each session owns two bounded OS pipes and destroys both processes on exit.
The codec process receives a path and locale only. Gateway secrets stay in the parent.
"""
import asyncio
import contextlib
import os

SAMPLE_RATE = 24000
FRAME_BYTES = 960  # 20 ms, mono, signed little-endian PCM16

# Executable lookup, locale, temp files, and dynamic linker. Nothing else.
_CODEC_ENV = (
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'TMPDIR', 'TMP', 'TEMP',
    'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH',
    'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC',
)


def codec_environment(source=None):
    base = os.environ if source is None else source
    kept = {}
    for key in _CODEC_ENV:
        value = base.get(key)
        if isinstance(value, str) and value and '\0' not in value and '\n' not in value and '\r' not in value:
            kept[key] = value
    return kept


class AudioCodec:
    def __init__(self, ffmpeg='ffmpeg'):
        self.ffmpeg = ffmpeg
        self.encoder = None
        self.decoder = None

    async def start(self):
        common = [self.ffmpeg, '-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0']
        enc = common + ['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
              '-c:a', 'libopus', '-application', 'voip', '-frame_duration', '20',
              '-b:a', '32000', '-page_duration', '20000', '-flush_packets', '1', '-f', 'ogg', 'pipe:1']
        dec = common + ['-f', 'ogg', '-i', 'pipe:0', '-ar', '24000', '-ac', '1',
                        '-f', 's16le', '-flush_packets', '1', 'pipe:1']
        try:
            env = codec_environment()
            self.encoder = await asyncio.create_subprocess_exec(*enc, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=32768, env=env)
            self.decoder = await asyncio.create_subprocess_exec(*dec, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=32768, env=env)
        except BaseException:
            await self.close()
            raise
        return self

    async def pcm_in(self, data: bytes):
        self.encoder.stdin.write(data)
        await asyncio.wait_for(self.encoder.stdin.drain(), 3)

    async def opus_in(self, data: bytes):
        self.decoder.stdin.write(data)
        await asyncio.wait_for(self.decoder.stdin.drain(), 3)

    async def opus_chunks(self):
        while data := await self.encoder.stdout.read(8192):
            yield data
        raise ConnectionError('Audio encoder stopped.')

    async def pcm_chunks(self):
        # Align PCM16 even when the OS pipe splits on an odd boundary.
        carry = b''
        while data := await self.decoder.stdout.read(4096):
            data = carry + data
            end = len(data) - len(data) % 2
            carry = data[end:]
            if end:
                yield data[:end]
        raise ConnectionError('Audio decoder stopped.')

    async def close(self):
        for p in (self.encoder, self.decoder):
            if p is None:
                continue
            if p.stdin:
                with contextlib.suppress(Exception):
                    p.stdin.close()
            if p.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    p.terminate()
                try:
                    await asyncio.wait_for(p.wait(), 2)
                except asyncio.TimeoutError:
                    with contextlib.suppress(ProcessLookupError):
                        p.kill()
                    await p.wait()
