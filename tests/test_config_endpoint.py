"""Operator endpoints stay plain URLs. A newline, an empty userinfo, or a bare ? or # is not a host."""
import pytest
from atlas_voice.config import Config, endpoint

def test_plain_endpoints_keep_their_host_and_path():
    assert endpoint('') == ''
    assert endpoint('http://127.0.0.1:8080/') == 'http://127.0.0.1:8080'
    assert endpoint('http://[::1]:8080') == 'http://[::1]:8080'
    assert endpoint('ws://127.0.0.1:8998/api/chat', websocket=True) == 'ws://127.0.0.1:8998/api/chat'
    assert endpoint('https://notes.example/v1') == 'https://notes.example/v1'
    assert endpoint('wss://voice.example/api/chat', websocket=True) == 'wss://voice.example/api/chat'

def test_cleartext_remote_endpoint_still_requires_tls():
    with pytest.raises(ValueError, match='verified TLS'):
        endpoint('http://notes.example/v1')

@pytest.mark.parametrize('raw', [
    'http://127.0.0.1:8080/\r\nHost: evil.example',
    'ws://127.0.0.1:8998/api/chat\r\nX: 1',
    'https://@notes.example/v1',
    'http://127.0.0.1:8080?',
    'http://127.0.0.1:8080#',
    'http://127.0.0.1:8080 ',
    'http://127.0.0.1:8080:80',
])
def test_endpoint_rejects_a_url_that_is_not_plain(raw):
    with pytest.raises(ValueError, match='plain configured endpoint'):
        endpoint(raw, websocket=raw.startswith('ws'))

def test_notes_url_with_a_newline_does_not_validate():
    raw = 'http://127.0.0.1:8080/\r\nHost: evil.example'
    with pytest.raises(ValueError, match='plain configured endpoint'):
        Config(notes_url=raw, notes_model='notes-synthetic').validate()
