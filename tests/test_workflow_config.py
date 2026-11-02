"""The JSON workflow config must stay a faithful copy of the pack's YAML (decision D14). No YAML library: keys and list
values are read from the pack files line by line, which is enough for these flat, hand-written documents."""
import copy, json, re
from pathlib import Path
import pytest
from atlas_voice import workflow_config as wc

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / 'docs' / 'agent-brain-v2.1' / '11_Plug_and_Play_Config'
KEY = re.compile(r'(?:^|[\s{,\[-])([A-Za-z_][\w.]*):(?=\s|$)')
# Atlas additions to the workflow file (D7); the pack YAML has neither.
ADDED_TOP_LEVEL = ('purposes', 'requirement_purposes')


def yaml_facts(path):
    """-> (set of mapping keys, list of (key, tuple(items)) for every list value, flow or block)."""
    keys, lists, open_block = set(), [], None
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = re.sub(r'\s#.*$', '', raw).rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        item = re.match(r'\s*-\s+([^{\[:][^:]*)$', line)  # a block-list scalar: "- project.industry"
        if item and open_block and indent > open_block[0]:
            open_block[2].append(item.group(1).strip().strip('"'))
            continue
        if open_block and open_block[2]:
            lists.append((open_block[1], tuple(open_block[2])))
        open_block = None
        keys.update(KEY.findall(line))
        for k, body in re.findall(r'([A-Za-z_]\w*):\s*\[([^\]]*)\]', line):
            lists.append((k, tuple(x.strip() for x in body.split(',') if x.strip())))
        empty = re.match(r'\s*(?:-\s+)?([A-Za-z_]\w*):\s*$', line)
        if empty:
            open_block = (indent, empty.group(1), [])
    if open_block and open_block[2]:
        lists.append((open_block[1], tuple(open_block[2])))
    return keys, lists


def json_facts(value):
    keys, lists = set(), []
    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                keys.add(k)
                if isinstance(v, list) and v and all(isinstance(x, str) for x in v):
                    lists.append((k, tuple(v)))
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(value)
    return keys, lists


def pack_scalars(path, wanted):
    return {k: v.strip().strip('"') for k, v in re.findall(r'^(\w+):\s*(\S.*)$', path.read_text(encoding='utf-8'), re.M) if k in wanted}


def test_workflow_json_has_exactly_the_pack_yaml_keys_and_lists():
    cfg = {k: v for k, v in wc.WORKFLOW_CONFIG.items() if k not in ADDED_TOP_LEVEL}
    y_keys, y_lists = yaml_facts(PACK / 'atlas_workflow.yaml')
    j_keys, j_lists = json_facts(cfg)
    assert y_keys == j_keys, (sorted(y_keys - j_keys), sorted(j_keys - y_keys))
    assert sorted(y_lists) == sorted(j_lists)
    assert pack_scalars(PACK / 'atlas_workflow.yaml', ('version',)) == {'version': wc.WORKFLOW_CONFIG['version']}
    assert wc.WORKFLOW_CONFIG['workflow']['id'] == 'atlas_project_intelligence_lifecycle'


def test_visibility_json_has_exactly_the_pack_yaml_keys_and_lists():
    y_keys, y_lists = yaml_facts(PACK / 'field_visibility_policy.yaml')
    j_keys, j_lists = json_facts(wc.VISIBILITY_POLICY)
    assert y_keys == j_keys, (sorted(y_keys - j_keys), sorted(j_keys - y_keys))
    assert sorted(y_lists) == sorted(j_lists)
    assert pack_scalars(PACK / 'field_visibility_policy.yaml', ('version', 'template')) == {'version': '1.0', 'template': 'amaris_success_story_es'}


def test_destinations_match_the_yaml_flow_maps():
    text = (PACK / 'atlas_workflow.yaml').read_text(encoding='utf-8')
    pack = [(m[0], m[1], tuple(x.strip() for x in m[2].split(','))) for m in re.findall(r'\{id: (\w+), adapter: (\w+), requires: \[([^\]]*)\]\}', text)]
    pack = [(i.replace('mechat', 'michat'), ad.replace('MECHAT', 'MICHAT'), req) for i, ad, req in pack]  # the pack's "MeChat" is a typo for MiChat (Tony, 2026-10-31, D1)
    assert pack and pack == [(d['id'], d['adapter'], tuple(d['requires'])) for d in wc.WORKFLOW_CONFIG['workflow']['branches']['purpose_specific_projections']['destinations']]


def test_story_schema_is_the_pack_schema_with_every_object_locked():
    pack = json.loads((PACK / 'success_story_template.schema.json').read_text(encoding='utf-8'))
    def strip(n):
        if isinstance(n, dict):
            return {k: strip(v) for k, v in n.items() if k != 'additionalProperties'}
        return [strip(v) for v in n] if isinstance(n, list) else n
    assert strip(wc.STORY_SCHEMA) == pack
    s = wc.STORY_SCHEMA
    assert s['additionalProperties'] is False and s['properties']['project']['additionalProperties'] is False
    assert s['properties']['kpis']['items']['additionalProperties'] is False
    assert s['properties']['amaris_differentiator']['properties']['client_quote']['additionalProperties'] is False
    assert s['properties']['results']['properties']['before_after']['items']['additionalProperties'] is False


def test_maap_and_project_review_rubrics_are_left_to_the_process_owner():
    b = wc.WORKFLOW_CONFIG['workflow']['branches']
    assert b['maap_review']['rubric'] == b['project_review']['rubric'] == 'MUST_BE_CONFIGURED_BY_PROCESS_OWNER' == wc.RUBRIC_PLACEHOLDER
    assert b['maap_review']['workflow'] == 'MAAP_REVIEW' and b['project_review']['workflow'] == 'PROJECT_REVIEW'


def test_purposes_are_the_four_pack_ones_plus_two_pending():
    status = {p['id']: p['status'] for p in wc.WORKFLOW_CONFIG['purposes']}
    assert status == {'internal_knowledge': 'pack', 'cv': 'pack', 'bid_client_facing': 'pack', 'public_spotlight': 'pack',
                      'skills_profile': 'pending_owner_confirmation', 'matching': 'pending_owner_confirmation'}
    assert wc.WORKFLOW_CONFIG['requirement_purposes'] == {'dna_permission': 'skills_profile', 'cv_permission': 'cv', 'matching_permission': 'matching'}


def test_edge_constants_expose_the_three_objects():
    assert wc.EDGE_CONSTANTS == {'WORKFLOW_CONFIG': wc.WORKFLOW_CONFIG, 'VISIBILITY_POLICY': wc.VISIBILITY_POLICY, 'STORY_SCHEMA': wc.STORY_SCHEMA}


def test_internal_notes_are_never_public():
    s = wc.VISIBILITY_POLICY['sections']
    assert not any(f.startswith('internal_notes') for f in s['public_story']['fields'])
    assert {'spotlight_cms', 'client_docx', 'public_pdf', 'external_presentation'} <= set(s['internal_only']['never_export_to'])


# Validation rejects bad edits rather than loading them.
def bad(mutate, validate, base):
    cfg = copy.deepcopy(base); mutate(cfg)
    with pytest.raises(ValueError):
        validate(cfg)

def test_validation_rejects_broken_configs():
    w = wc.WORKFLOW_CONFIG
    bad(lambda c: c['purposes'].pop(0), wc.validate_workflow, w)
    bad(lambda c: c['purposes'][0].update(status='pending_owner_confirmation'), wc.validate_workflow, w)
    bad(lambda c: c['requirement_purposes'].update(cv_permission='nope'), wc.validate_workflow, w)
    bad(lambda c: c['workflow']['branches']['maap_review'].pop('rubric'), wc.validate_workflow, w)
    bad(lambda c: c['workflow']['branches']['spotlight'].update(requires=[]), wc.validate_workflow, w)
    bad(lambda c: c['workflow']['rejection_route'].update(return_to='nowhere'), wc.validate_workflow, w)
    bad(lambda c: c['workflow']['branches']['purpose_specific_projections']['destinations'][0]['requires'].append('x_permission'), wc.validate_workflow, w)
    bad(lambda c: c['sections']['public_story']['fields'].append('internal_notes.manager'), wc.validate_visibility, wc.VISIBILITY_POLICY)
    bad(lambda c: c['properties']['project'].pop('additionalProperties'), wc.validate_story_schema, wc.STORY_SCHEMA)
    bad(lambda c: c.update(additionalProperties=True), wc.validate_story_schema, wc.STORY_SCHEMA)
