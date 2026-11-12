"""Slice 1: the Python gateway script policy is hash-only. It does not claim GDPR compliance."""
from atlas_voice.config import Config
from atlas_voice.server import csp


def test_gateway_script_policy_has_no_unsafe_inline():
    policy = csp(Config(origin='https://atlas.example'))
    script = policy.split('script-src ', 1)[1].split(';', 1)[0]
    assert 'unsafe-inline' not in script
    assert "script-src-attr 'none'" in policy
    assert "style-src 'unsafe-inline'" in policy
    assert 'wss://atlas.example' in policy
