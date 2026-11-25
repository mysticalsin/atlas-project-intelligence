"""The Entra audience check accepts one client UUID in either letter case.

Synthetic ids only. No network and no token service.
"""
import time

import pytest

from atlas_voice.config import Config
from atlas_voice.identity import Identity

TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
CLIENT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
OID = 'cccccccc-dddd-4eee-8fff-000000000001'
OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'


def _claims(aud, **extra):
    body = {
        'tid': TENANT,
        'oid': OID,
        'aud': aud,
        'roles': ['ATLAS.Interview'],
        'exp': time.time() + 60,
    }
    body.update(extra)
    return body


def _identity(client_id=CLIENT):
    return Identity(Config(tenant=TENANT, client_id=client_id))


def test_same_audience_uuid_matches_in_either_case():
    assert _identity().verify_claims(_claims(CLIENT.upper()))[0] == TENANT
    assert _identity(CLIENT.upper()).verify_claims(_claims(CLIENT))[0] == TENANT


def test_a_different_audience_uuid_is_still_rejected():
    with pytest.raises(ValueError, match='audience'):
        _identity().verify_claims(_claims(OTHER))
    with pytest.raises(ValueError, match='audience'):
        _identity().verify_claims(_claims(OTHER.upper()))


def test_a_non_uuid_audience_is_still_rejected():
    with pytest.raises(ValueError, match='audience'):
        _identity().verify_claims(_claims('another'))


def test_uppercase_audience_does_not_skip_role_or_expiry():
    with pytest.raises(ValueError, match='role'):
        _identity().verify_claims(_claims(CLIENT.upper(), roles=[]))
    with pytest.raises(ValueError, match='role'):
        _identity().verify_claims(_claims(CLIENT.upper(), exp=0))
