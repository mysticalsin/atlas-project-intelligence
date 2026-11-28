"""The microphone transcript cap counts the joined text, including spaces between results.

Synthetic recognition results only. No Riva, NVIDIA, or other provider call.
"""
import asyncio
import sys
import types
from types import SimpleNamespace

import atlas_voice.notes as notes


class _Alt:
    def __init__(self, transcript):
        self.transcript = transcript


class _Result:
    def __init__(self, transcript):
        self.alternatives = [_Alt(transcript)]


class _Response:
    def __init__(self, texts):
        self.results = [_Result(text) for text in texts]


def _install_recognizer(texts):
    saved = {name: sys.modules.get(name) for name in (
        'riva', 'riva.client', 'riva.client.proto', 'riva.client.proto.riva_asr_pb2')}

    class _Auth:
        def __init__(self, **kwargs):
            self.channel = SimpleNamespace(close=lambda: None)

        def get_auth_metadata(self):
            return []

    class _Stub:
        def Recognize(self, request, metadata=None, timeout=None):
            return _Response(texts)

    class _Service:
        def __init__(self, auth):
            self.stub = _Stub()

    class _Config:
        def __init__(self, **kwargs):
            pass

    class _Encoding:
        LINEAR_PCM = 1

    class _Request:
        def __init__(self, config=None, audio=None):
            self.audio = audio

    client = types.ModuleType('riva.client')
    client.Auth = _Auth
    client.ASRService = _Service
    client.RecognitionConfig = _Config
    client.AudioEncoding = _Encoding
    proto = types.ModuleType('riva.client.proto')
    asr = types.ModuleType('riva.client.proto.riva_asr_pb2')
    asr.RecognizeRequest = _Request
    riva = types.ModuleType('riva')
    riva.client = client
    sys.modules['riva'] = riva
    sys.modules['riva.client'] = client
    sys.modules['riva.client.proto'] = proto
    sys.modules['riva.client.proto.riva_asr_pb2'] = asr
    return saved


def _restore(saved):
    for name, module in saved.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module


def _config():
    return SimpleNamespace(
        riva_uri='synthetic:1', riva_key='', riva_function_id='', riva_ssl=False,
        riva_model='synthetic', ffmpeg='ffmpeg', notes_url='')


def _transcribe(monkeypatch, texts):
    async def resample(pcm, ffmpeg):
        return b'\x00\x00'

    monkeypatch.setattr(notes, 'resample_16k', resample)
    saved = _install_recognizer(texts)
    try:
        return asyncio.run(notes.make_notes(_config(), None, b'\x00\x00'))
    finally:
        _restore(saved)


def test_joined_results_at_the_cap_are_refused(monkeypatch):
    # 30000 + 30000 is the cap. The space between the two results makes 60001.
    try:
        _transcribe(monkeypatch, ['a' * 30000, 'b' * 30000])
    except ValueError as error:
        assert str(error) == 'Transcription text budget reached.'
    else:
        raise AssertionError('joined transcript over 60000 was returned')


def test_one_result_at_the_cap_is_kept(monkeypatch):
    out = _transcribe(monkeypatch, ['c' * 60000])
    assert out['status'] == 'transcribed'
    assert out['transcript'] == 'c' * 60000


def test_many_short_results_count_their_spaces(monkeypatch):
    # 1000 results of 60 characters sum to 60000. Joining them adds 999 spaces.
    pieces = ['d' * 60 for _ in range(1000)]
    try:
        _transcribe(monkeypatch, pieces)
    except ValueError as error:
        assert str(error) == 'Transcription text budget reached.'
    else:
        raise AssertionError('spaces between recognition results were not counted')
