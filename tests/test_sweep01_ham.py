"""Sweep 01 external review (HAM-04).

One client must not be able to fill the Entra sign-in table. Expired flows are
dropped. A different client can still start a sign-in after the flood.

The Microsoft client is a local stub. No identity provider is called.
"""
import pytest
from aiohttp import web

from atlas_voice.config import Config
from atlas_voice.identity import Identity


class FakeMsal:
    def initiate_auth_code_flow(self, scopes=None, redirect_uri=''):
        return {'auth_uri': 'https://login.example.test/authorize', 'state': 'synthetic-state'}


class Ask:
    def __init__(self, remote):
        self.remote = remote
        self.cookies = {}


@pytest.mark.asyncio
async def test_ham04_one_client_cannot_fill_the_sign_in_table(monkeypatch):
    clock = {'t': 1_000_000.0}
    monkeypatch.setattr('atlas_voice.identity.time.monotonic', lambda: clock['t'])
    ident = Identity(Config())
    ident.client = FakeMsal()
    ident.flows = {f'old-{i}': ({'auth_uri': 'https://login.example.test/old'}, clock['t'] - 1) for i in range(100)}
    opened = await ident.login(Ask('203.0.113.20'))
    assert opened.status == 302
    assert len(ident.flows) == 1

    attacker = Ask('203.0.113.10')
    refused = False
    for _ in range(500):
        try:
            await ident.login(attacker)
        except web.HTTPTooManyRequests:
            refused = True
            break
    assert refused, 'one client must be capped before 500 pending sign-ins'
    try:
        other = await ident.login(Ask('203.0.113.30'))
        status = other.status
    except web.HTTPTooManyRequests as exc:
        status = exc.status
    assert status == 302
