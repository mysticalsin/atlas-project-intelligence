"""connections.json (v2.2 C1): schema consistency, the status ladder, the no-invention rule and parity with the edge connector's constants."""
import copy, json, re
from pathlib import Path
import pytest
from atlas_voice import connections_config as cc
from atlas_voice import workflow_config as wc

ROOT = Path(__file__).resolve().parents[1]
EDGE_SRC = ROOT / 'deploy' / 'cloudflare-edge' / 'src'
CFG = cc.CONNECTIONS_CONFIG
BY_ID = {c['id']: c for c in CFG['connections']}
NEVER = CFG['data_minimisation']['never_send_keys']
MODEL = CFG['data_minimisation']['never_to_model_keys']


def check(c):
    return cc.validate_connection(c, NEVER, MODEL)


def mutated(cid, **patch):
    c = copy.deepcopy(BY_ID[cid])
    c.update(patch)
    return c


def test_every_connection_in_tonys_workflow_is_present_with_direction_and_step():
    assert list(BY_ID) == ['identity', 'prefill_profile', 'staffing', 'opportunity', 'dna_skills', 'michat_cv', 'imp_capability', 'maap_review', 'project_review', 'spotlight_cms']
    assert {i for i, c in BY_ID.items() if c['direction'] == 'inbound'} == {'identity', 'prefill_profile', 'staffing', 'opportunity'}
    assert {i for i, c in BY_ID.items() if c['direction'] == 'outbound'} == {'dna_skills', 'michat_cv', 'imp_capability', 'maap_review', 'project_review', 'spotlight_cms'}
    assert all(1 <= c['workflow_step'] <= 11 for c in BY_ID.values())
    assert [BY_ID[i]['workflow_step'] for i in ('identity', 'staffing')] == [1, 1] and BY_ID['prefill_profile']['workflow_step'] == 2
    assert BY_ID['spotlight_cms']['workflow_step'] == 11 and BY_ID['dna_skills']['workflow_step'] == 10
    for c in CFG['connections']:
        check(c)


def test_michat_not_mechat():
    assert 'michat_cv' in BY_ID and 'mechat_cv' not in BY_ID
    c = BY_ID['michat_cv']
    assert c['label'] == 'MiChat CV' and (cc.CONFIG_DIR / 'contracts' / 'michat_cv').is_dir() and not (cc.CONFIG_DIR / 'contracts' / 'mechat_cv').exists()
    assert c['adapter'] == 'MICHAT_CV' and 'adapter_note' not in c  # the code-level adapter id carries the confirmed name (M1)


def test_existing_connections_are_marked_and_external_ones_are_not_configured():
    assert BY_ID['identity']['managed_by'] == 'existing_code' and BY_ID['staffing']['managed_by'] == 'existing_code'
    assert BY_ID['identity']['status'] == 'configured_untested', 'never exercised against a real Access or Entra tenant from the repository'
    for cid, c in BY_ID.items():
        if c['managed_by'] == 'http_connector':
            assert c['status'] == 'not_configured' and c['owner'] is None and c['endpoints'] == {} and c['field_mapping'] == {}, cid
            assert c['ack_rule'] is None or not any(v for k, v in c['ack_rule'].items() if k.endswith('_path')), cid
    assert not BY_ID['maap_review']['wired'] and not BY_ID['project_review']['wired']


def test_nothing_invented_no_url_no_secret_value_no_vendor_endpoint():
    text = (cc.CONFIG_DIR / 'connections.json').read_text(encoding='utf-8')
    assert 'http://' not in text and 'https://' not in text, 'connections.json holds env var names, never URLs'
    for c in CFG['connections']:
        for n in c['auth']['secret_names']:
            assert re.fullmatch(r'[A-Z][A-Z0-9_]{2,63}', n) and not re.search(r'(?i)(sk-|bearer |eyJ)', n), n
        assert c['base_url_var'] is None or re.fullmatch(r'[A-Z][A-Z0-9_]+', c['base_url_var'])
    for path in (cc.CONFIG_DIR / 'contracts').rglob('*.schema.json'):
        raw = path.read_text(encoding='utf-8')
        assert not re.search(r'https?://(?!json-schema\.org)', raw), path


def test_outbound_adapters_are_the_workflow_destinations_plus_cms_and_the_two_shells():
    dests = {d['adapter'] for d in wc.WORKFLOW_CONFIG['workflow']['branches']['purpose_specific_projections']['destinations']}
    assert {c['adapter'] for c in CFG['connections'] if c['direction'] == 'outbound'} == dests | {'SPOTLIGHT_CMS', 'MAAP', 'PROJECT_REVIEW'}
    assert set(cc.ADAPTERS) == {c['adapter'] for c in CFG['connections'] if c['adapter']}
    needs = {d['adapter']: d['requires'] for d in wc.WORKFLOW_CONFIG['workflow']['branches']['purpose_specific_projections']['destinations']}
    for adapter, requires in needs.items():
        permission = next(c for c in CFG['connections'] if c['adapter'] == adapter)['required_permission']
        assert all(r in permission for r in requires), (adapter, requires, permission)


def test_every_schema_ref_exists_is_marked_and_forbids_extra_properties():
    for c in CFG['connections']:
        for key in ('request_schema', 'response_schema'):
            if c.get(key):
                schema = cc.load_schema(c[key], c['schema_status'])
                assert schema['additionalProperties'] is False
                assert c[key].startswith(f"contracts/{c['id']}/")
    dirs = {p.name for p in (cc.CONFIG_DIR / 'contracts').iterdir() if p.is_dir()}
    assert dirs == {c['id'] for c in CFG['connections'] if c.get('request_schema') or c.get('response_schema')}, 'a contracts directory without a connection (or the reverse)'
    for cid in ('dna_skills', 'michat_cv', 'imp_capability', 'maap_review', 'project_review', 'spotlight_cms', 'prefill_profile', 'opportunity'):
        for key in ('request_schema', 'response_schema'):
            assert json.loads((cc.CONFIG_DIR / BY_ID[cid][key]).read_text(encoding='utf-8'))['x-status'].startswith(cc.DRAFT_MARK), (cid, key)


def test_request_schemas_never_define_a_never_send_property():
    def names(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == 'properties' and isinstance(v, dict):
                    yield from v.keys()
                yield from names(v)
        elif isinstance(node, list):
            for v in node:
                yield from names(v)
    for c in CFG['connections']:
        if c['direction'] == 'outbound':
            schema = json.loads((cc.CONFIG_DIR / c['request_schema']).read_text(encoding='utf-8'))
            assert not set(names(schema)) & set(NEVER), c['id']
    cms = json.loads((cc.CONFIG_DIR / BY_ID['spotlight_cms']['request_schema']).read_text(encoding='utf-8'))
    assert not set(names(cms)) & set(BY_ID['spotlight_cms']['never_send_extra'])


def test_never_send_keys_cover_what_the_mock_cms_already_forbids_and_the_interview_ids():
    src = (EDGE_SRC / 'adapters.js').read_text(encoding='utf-8')
    forbidden = re.search(r"FORBIDDEN_IN_CMS = \[([^\]]+)\]", src).group(1)
    assert set(re.findall(r"'([a-z_]+)'", forbidden)) <= set(NEVER)
    assert {'transcript', 'internal_notes', 'interview_id', 'session_id', 'ledger_id', 'item_id', 'source_refs', 'quote'} <= set(NEVER)
    assert {'name', 'email', 'manager_email', 'preferred_name'} <= set(MODEL)


def test_inbound_allowlists_never_expose_names_or_emails_to_a_model():
    for cid in ('prefill_profile', 'opportunity'):
        inb = BY_ID[cid]['inbound']
        assert not set(inb['model_fields']) & set(MODEL) and not set(inb['model_fields']) & set(inb['display_only_fields'])
    assert BY_ID['prefill_profile']['inbound']['model_fields'] == ['role']
    bad = mutated('prefill_profile'); bad['inbound'] = {**bad['inbound'], 'model_fields': ['role', 'name']}
    with pytest.raises(ValueError, match='never-to-model'):
        check(bad)
    bad = mutated('prefill_profile', field_mapping={'salary': 'x.y'})
    with pytest.raises(ValueError, match='not on the allowlist'):
        check(bad)


def test_status_ladder_and_enablement_rules_are_enforced():
    assert CFG['status_order'] == list(cc.STATUSES) == ['not_configured', 'configured_untested', 'contract_verified', 'live_verified']
    full = dict(status='configured_untested', owner='Owner Co', endpoints={'send': {'method': 'POST', 'path': '/x'}}, field_mapping={'entity_id': 'ref'},
                ack_rule={**BY_ID['dna_skills']['ack_rule'], 'record_id_path': 'id', 'version_path': 'v'})
    check(mutated('dna_skills', **full))  # a complete configuration passes
    for patch, msg in [({'owner': None}, 'confirmed owner'), ({'owner': 'TO CONFIRM'}, 'confirmed owner'), ({'endpoints': {}}, 'no endpoint'), ({'field_mapping': {}}, 'field_mapping is empty'),
                       ({'ack_rule': {**full['ack_rule'], 'version_path': None}}, 'record_id_path and version_path'),
                       ({'status': 'contract_verified'}, 'owner-confirmed schemas'),
                       ({'status': 'live_verified', 'schema_status': 'owner_confirmed'}, 'sandbox false')]:
        with pytest.raises(ValueError, match=msg):
            check(mutated('dna_skills', **{**full, **patch}))
    check(mutated('dna_skills', **{**full, 'status': 'live_verified', 'schema_status': 'owner_confirmed', 'sandbox': False}))
    with pytest.raises(ValueError, match='unwired'):
        check(mutated('maap_review', **{**full, 'ack_rule': {**BY_ID['maap_review']['ack_rule'], 'record_id_path': 'id', 'version_path': 'v'}}))
    cms = {**full, 'ack_rule': {**BY_ID['spotlight_cms']['ack_rule'], 'record_id_path': 'id', 'version_path': 'v'}}
    with pytest.raises(ValueError, match='publication paths'):
        check(mutated('spotlight_cms', **cms))
    with pytest.raises(ValueError, match='echo the revision hash'):
        check(mutated('spotlight_cms', ack_rule={**BY_ID['spotlight_cms']['ack_rule'], 'hash_echo_required': False}))


def test_mapping_sources_cannot_name_a_never_send_key_and_secrets_must_be_names():
    for src in ('transcript', 'assertions[].source_refs', 'internal_notes.manager', 'session_id'):
        with pytest.raises(ValueError, match='never-send'):
            check(mutated('dna_skills', field_mapping={src: 'x'}))
    with pytest.raises(ValueError, match='never-send'):
        check(mutated('spotlight_cms', field_mapping={'consultant_id': 'x'}))
    with pytest.raises(ValueError, match='UPPER_SNAKE'):
        check(mutated('dna_skills', auth={**BY_ID['dna_skills']['auth'], 'secret_names': ['sk-live-abc123 def'], 'secret_roles': {'token': 'sk-live-abc123 def'}}))
    with pytest.raises(ValueError, match='never a URL'):
        check(mutated('dna_skills', base_url_var='https://owner.example'))
    with pytest.raises(ValueError, match='path starting with /'):
        check(mutated('dna_skills', endpoints={'send': {'method': 'POST', 'path': 'https://owner.example/x'}}))


def test_schema_keyword_list_and_status_ladder_match_the_edge_code():
    schema_lite = (EDGE_SRC / 'schema-lite.js').read_text(encoding='utf-8')
    supported = set(re.findall(r"'([^']+)'", re.search(r"SUPPORTED = \[([^\]]+)\]", schema_lite).group(1)))
    assert supported == cc.SCHEMA_KEYWORDS
    connectors = (EDGE_SRC / 'connectors.js').read_text(encoding='utf-8')
    assert re.findall(r"'([a-z_]+)'", re.search(r"STATUS_ORDER = \[([^\]]+)\]", connectors).group(1)) == list(cc.STATUSES)
    bad = {'type': 'object', 'additionalProperties': False, 'properties': {}, 'allOf': []}
    with pytest.raises(ValueError, match='unsupported schema keyword'):
        cc._walk_schema(bad, 't')


def test_edge_receives_the_registry():
    assert cc.EDGE_CONSTANTS == {'CONNECTIONS_CONFIG': CFG}
    assert 'atlas_voice.connections_config' in (ROOT / 'deploy' / 'cloudflare-edge' / 'build_edge.py').read_text(encoding='utf-8')
