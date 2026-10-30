"""Machine-readable workflow configuration (decision D14): the pack's YAML/JSON-schema files as JSON in config/, loaded and
validated at import so a bad edit fails the build instead of the gate. Pure stdlib. The edge Worker receives the same
objects through EDGE_CONSTANTS (policy.generated.js); deploy/cloudflare-edge/src/policy-gate.js is the only consumer of
the workflow and visibility objects, and test/gen_*_parity.py is not needed because the gate reads the data, not a port."""
import json
from pathlib import Path

CONFIG_DIR = Path(__file__).resolve().parent / 'config'
# The pack leaves the MAAP and Project Review rubrics to the process owner (decisions D2, D3). Atlas never fills it in.
RUBRIC_PLACEHOLDER = 'MUST_BE_CONFIGURED_BY_PROCESS_OWNER'
PACK_PURPOSES = ('internal_knowledge', 'cv', 'bid_client_facing', 'public_spotlight')
PURPOSE_STATUSES = ('pack', 'pending_owner_confirmation')


def _load(name):
    return json.loads((CONFIG_DIR / name).read_text(encoding='utf-8'))


def _need(ok, message):
    if not ok:
        raise ValueError(f'workflow config: {message}')


def _strings(value, where):
    _need(isinstance(value, list) and value and all(isinstance(v, str) and v for v in value), f'{where} must be a non-empty list of strings')
    _need(len(set(value)) == len(value), f'{where} has a duplicate')
    return value


def validate_workflow(cfg):
    _need(isinstance(cfg, dict) and isinstance(cfg.get('workflow'), dict), 'workflow section missing')
    wf = cfg['workflow']
    _strings(wf.get('sequence'), 'workflow.sequence')
    _strings(wf.get('global_rules'), 'workflow.global_rules')
    _need(isinstance(wf.get('rejection_route'), dict) and wf['rejection_route'].get('return_to') in wf['sequence'], 'rejection_route.return_to must be a sequence step')
    branches = wf.get('branches')
    _need(isinstance(branches, dict), 'branches missing')
    dests = branches.get('purpose_specific_projections', {}).get('destinations')
    _need(isinstance(dests, list) and dests, 'destinations missing')
    _need(len({d.get('id') for d in dests}) == len(dests), 'duplicate destination id')
    for d in dests:
        _need(isinstance(d.get('id'), str) and isinstance(d.get('adapter'), str), 'destination needs id and adapter')
        _strings(d.get('requires'), f"destination {d.get('id')} requires")
    for name in ('maap_review', 'project_review'):
        _need(isinstance(branches.get(name), dict) and isinstance(branches[name].get('rubric'), str) and branches[name]['rubric'], f'{name}.rubric missing')
    _strings(branches.get('spotlight', {}).get('requires'), 'spotlight.requires')
    purposes = cfg.get('purposes')
    _need(isinstance(purposes, list), 'purposes missing')
    ids = [p.get('id') for p in purposes]
    _need(len(set(ids)) == len(ids) and set(PACK_PURPOSES) <= set(ids), 'purposes must include the four pack purposes once each')
    _need(all(p.get('status') in PURPOSE_STATUSES for p in purposes), 'purpose status must be pack or pending_owner_confirmation')
    _need(all(p['status'] == 'pack' for p in purposes if p['id'] in PACK_PURPOSES), 'a pack purpose cannot be flagged pending')
    mapping = cfg.get('requirement_purposes')
    _need(isinstance(mapping, dict) and set(mapping.values()) <= set(ids), 'requirement_purposes must point at declared purposes')
    needed = {r for d in dests for r in d['requires'] if r.endswith('_permission')}
    _need(needed <= set(mapping), f'no purpose declared for {sorted(needed - set(mapping))}')
    return cfg


def validate_visibility(policy):
    s = policy.get('sections') if isinstance(policy, dict) else None
    _need(isinstance(s, dict), 'visibility sections missing')
    public, internal = s.get('public_story', {}), s.get('internal_only', {})
    _strings(public.get('fields'), 'public_story.fields')
    _strings(internal.get('fields'), 'internal_only.fields')
    _strings(internal.get('never_export_to'), 'internal_only.never_export_to')
    _need(not set(public['fields']) & set(internal['fields']), 'a field is both public and internal')
    return policy


def validate_story_schema(schema):
    """Every object node (the root and nested ones) must forbid unknown properties."""
    def walk(node, path):
        if isinstance(node, dict):
            kind = node.get('type')
            if 'properties' in node and (kind == 'object' or (isinstance(kind, list) and 'object' in kind)):
                _need(node.get('additionalProperties') is False, f'{path or "root"} must set additionalProperties:false')
            for key, value in node.items():
                walk(value, f'{path}/{key}')
        elif isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, f'{path}[{i}]')
    _need(isinstance(schema, dict) and schema.get('type') == 'object', 'story schema root must be an object')
    walk(schema, '')
    return schema


WORKFLOW_CONFIG = validate_workflow(_load('atlas_workflow.json'))
VISIBILITY_POLICY = validate_visibility(_load('field_visibility_policy.json'))
STORY_SCHEMA = validate_story_schema(_load('success_story_template.schema.json'))

EDGE_CONSTANTS = {'WORKFLOW_CONFIG': WORKFLOW_CONFIG, 'VISIBILITY_POLICY': VISIBILITY_POLICY, 'STORY_SCHEMA': STORY_SCHEMA}
