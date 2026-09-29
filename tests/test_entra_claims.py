"""The Entra claims list that enable_entra.sh gives Cloudflare Access (docs/WOW_ZERO_CONFIG.md §5.5, §9).

Access trims the JWT `custom` object from the END of the claims list when it grows past about 1 KB, so the identity
claims the Worker needs (tid, oid, roles, preferred_username) must come first and the on-screen name claims last, and
"groups" must never be added. Standard library only; nothing is run against Cloudflare.
"""
import json
import re
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/cloudflare-edge/entra/enable_entra.sh'
EXPECTED = ["tid", "oid", "roles", "preferred_username", "name", "given_name", "family_name"]


def claims_lists():
    return [json.loads(m) for m in re.findall(r'"claims":(\[[^\]]*\])', SCRIPT.read_text())]


def test_the_claims_list_keeps_identity_claims_first_and_name_claims_last():
    lists = claims_lists()
    assert lists == [EXPECTED], lists


def test_no_groups_claim_and_the_identity_claims_the_worker_reads_are_all_there():
    (claims,) = claims_lists()
    assert 'groups' not in claims
    assert claims[:4] == ["tid", "oid", "roles", "preferred_username"]
    worker = (SCRIPT.parents[1] / 'src/app.js').read_text()
    for name in ('tid', 'oid', 'roles'):
        assert re.search(r'\b' + name + r'\b', worker), name  # entraIdentity reads them
    for name in ('given_name', 'family_name'):
        assert name in (SCRIPT.parents[1] / 'src/profile.js').read_text(), name  # nameClaims maps them


def test_the_script_still_refuses_without_the_approval_flag():
    text = SCRIPT.read_text()
    assert '--i-have-it-approval' in text and 'exit 2' in text
