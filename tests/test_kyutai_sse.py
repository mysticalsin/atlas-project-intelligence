"""The talker keeps a chat delta when the body ends on that event, and when events are separated by CR.

Synthetic SSE only. No provider is called.
"""
import asyncio

from atlas_voice.kyutai import stream_chat


class Content:
    def __init__(self, parts):
        self.parts = parts

    async def iter_any(self):
        for part in self.parts:
            yield part


class SSE:
    def __init__(self, parts):
        self.content = Content(parts)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    def raise_for_status(self):
        pass


class Http:
    def __init__(self, parts):
        self.parts = parts

    def post(self, url, headers, json, timeout):
        assert json['stream'] is True
        return SSE(self.parts)


def collect(parts):
    async def run():
        return [delta async for delta in stream_chat(Http(parts), 'https://x.example/v1/chat/completions', 'm', '', [])]
    return asyncio.run(run())


def event(text):
    return b'data: {"choices":[{"delta":{"content":"' + text.encode('ascii') + b'"}}]}'


def test_cr_separated_events_are_kept():
    assert collect([event('Hel') + b'\r' + event('lo') + b'\r']) == ['Hel', 'lo']


def test_last_event_without_a_newline_is_kept():
    assert collect([event('Hel') + b'\n', event('lo')]) == ['Hel', 'lo']


def test_crlf_split_across_chunks_is_one_break():
    assert collect([event('Hel') + b'\r', b'\n' + event('lo') + b'\r\n' + b'data: [DONE]\r\n']) == ['Hel', 'lo']


def test_done_stops_later_events():
    body = event('Hel') + b'\n' + b'data: [DONE]\n' + event('late') + b'\n'
    assert collect([body]) == ['Hel']
    assert collect([event('Hel') + b'\ndata: [DONE]\n', event('late') + b'\n']) == ['Hel']


def test_a_delta_split_across_chunks_is_joined():
    parts = [
        b'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\ndata: {"choi',
        b'ces":[{"delta":{"content":"lo"}}]}\n\n: keepalive\ndata: [DONE]\n\ndata: {"choices":[{"delta":{"content":"late"}}]}\n',
    ]
    assert collect(parts) == ['Hel', 'lo']


def test_done_on_a_final_cr_line_stops_later_events():
    body = event('Hel') + b'\r' + b'data: [DONE]\r' + event('late') + b'\r'
    assert collect([body]) == ['Hel']
