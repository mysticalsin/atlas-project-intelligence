"""The voice page puts one websocket origin in connect-src. Synthetic origins only."""

from atlas_voice.csp import html_csp, legacy_csp


def test_connect_value_cannot_add_another_directive_or_origin():
    injected = 'wss://good.example; worker-src *'
    for policy in (html_csp(connect=injected), legacy_csp(connect=injected)):
        assert 'worker-src *' not in policy
        assert 'good.example' not in policy
        assert "connect-src 'self'" in policy
    assert 'evil.example' not in html_csp(connect='wss://good.example https://evil.example')
    kept = html_csp(connect='wss://good.example', script_blob=True)
    assert "connect-src 'self' wss://good.example" in kept
    assert "connect-src 'self' ws://127.0.0.1:8080" in legacy_csp(connect='ws://127.0.0.1:8080')
    assert "connect-src 'self' wss://[::1]:8443" in html_csp(connect='wss://[::1]:8443')
