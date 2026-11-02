"""Connection registry (v2.2 C1): atlas_voice/config/connections.json, loaded and validated at import like workflow_config.
One entry per integration in Tony's canonical workflow. It holds NO real vendor endpoint, field name or credential: external
owners have not confirmed any (decisions D1-D5), so every external connection stays `not_configured` until they supply base
URL, auth, schema and samples. Secrets are referenced by Worker secret NAME only. The edge Worker receives the same object through
EDGE_CONSTANTS (policy.generated.js) and deploy/cloudflare-edge/src/connectors.js is its consumer. Pure stdlib."""
import json
import re
from pathlib import Path

CONFIG_DIR = Path(__file__).resolve().parent / 'config'
STATUSES = ('not_configured', 'configured_untested', 'contract_verified', 'live_verified')
AUTH_TYPES = ('none', 'bearer', 'oauth2_client_credentials', 'mtls', 'api_key_header')
DIRECTIONS = ('inbound', 'outbound')
SCHEMA_STATUSES = ('draft_from_atlas_side', 'owner_confirmed', 'atlas_defined', 'not_applicable')
DRAFT_MARK = 'draft — from Atlas side; owner to confirm'
OWNER_PLACEHOLDER = 'TO CONFIRM'
ENV_NAME = re.compile(r'^[A-Z][A-Z0-9_]{2,63}$')
# Adapters the edge knows: the four destinations plus the two shells (adapters.js CONTRACTS / createShell).
ADAPTERS = ('DNA_SKILLS_WRITEBACK', 'MICHAT_CV', 'IMP_CAPABILITY', 'SPOTLIGHT_CMS', 'MAAP', 'PROJECT_REVIEW')
SECRET_ROLES = {'bearer': ('token',), 'api_key_header': ('key',), 'oauth2_client_credentials': ('client_id', 'client_secret'), 'mtls': ('binding',), 'none': ()}
# The JSON-schema keywords deploy/cloudflare-edge/src/schema-lite.js supports; a schema using any other keyword is rejected.
SCHEMA_KEYWORDS = {'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength',
                   'pattern', 'minimum', 'maximum', 'oneOf', 'anyOf', '$ref', '$defs'}
SCHEMA_ANNOTATIONS = {'$schema', '$id', 'title', 'description', 'format', 'default', 'examples'}
RE_STEP = range(1, 12)


def _need(ok, message):
    if not ok:
        raise ValueError(f'connections config: {message}')


def _walk_schema(node, where):
    if isinstance(node, dict):
        kind = node.get('type')
        if 'properties' in node and (kind == 'object' or (isinstance(kind, list) and 'object' in kind)):
            _need(node.get('additionalProperties') is False, f'{where} must set additionalProperties:false')
        for key, value in node.items():
            _need(key in SCHEMA_KEYWORDS or key in SCHEMA_ANNOTATIONS or key.startswith('x-') or where.endswith('properties') or where.endswith('$defs'),
                  f'{where}: unsupported schema keyword {key!r}')
            _walk_schema(value, f'{where}/{key}')
    elif isinstance(node, list):
        for i, value in enumerate(node):
            _walk_schema(value, f'{where}[{i}]')


def load_schema(ref, status):
    path = CONFIG_DIR / ref
    _need(path.is_file(), f'schema {ref} does not exist')
    schema = json.loads(path.read_text(encoding='utf-8'))
    _need(isinstance(schema, dict) and schema.get('type') == 'object', f'schema {ref} root must be an object')
    _walk_schema(schema, ref)
    if status == 'draft_from_atlas_side':
        _need(str(schema.get('x-status', '')).startswith(DRAFT_MARK), f'schema {ref} must be marked "{DRAFT_MARK}"')
    return schema


def _paths(mapping, where):
    _need(isinstance(mapping, dict), f'{where} must be an object')
    for k, v in mapping.items():
        _need(isinstance(k, str) and k and isinstance(v, str) and v, f'{where} entries must be non-empty strings')


def _root_keys(path):
    return [seg.replace('[]', '') for seg in path.split('.')]


def validate_connection(c, never_send, never_to_model):
    cid = c.get('id')
    _need(isinstance(cid, str) and re.fullmatch(r'[a-z][a-z0-9_]*', cid or ''), f'bad id {cid!r}')
    w = f'connection {cid}'
    _need(c.get('direction') in DIRECTIONS, f'{w}: direction')
    _need(c.get('workflow_step') in RE_STEP and isinstance(c.get('workflow_step_label'), str), f'{w}: workflow_step must be 1-11 with a label')
    _need(isinstance(c.get('purpose'), str) and c['purpose'] and isinstance(c.get('required_permission'), str) and c['required_permission'], f'{w}: purpose and required_permission')
    _need(c.get('status') in STATUSES, f'{w}: status')
    _need(c.get('owner') is None or (isinstance(c['owner'], str) and c['owner']), f'{w}: owner must be null or a name')
    _need(c.get('managed_by') in ('existing_code', 'http_connector'), f'{w}: managed_by')
    _need(isinstance(c.get('wired'), bool), f'{w}: wired')
    _need(c['wired'] or c.get('wired_note'), f'{w}: an unwired connection needs wired_note')
    _need(c.get('adapter') is None or c['adapter'] in ADAPTERS, f'{w}: unknown adapter')
    _need((c['direction'] == 'outbound') == (c.get('adapter') is not None), f'{w}: outbound connections name an adapter, inbound ones do not')
    _need(c.get('schema_status') in SCHEMA_STATUSES, f'{w}: schema_status')
    sandbox = c.get('sandbox')
    _need(isinstance(sandbox, bool), f'{w}: sandbox flag')
    auth = c.get('auth')
    _need(isinstance(auth, dict) and auth.get('type') in AUTH_TYPES, f'{w}: auth.type')
    names = auth.get('secret_names')
    _need(isinstance(names, list) and all(isinstance(n, str) and ENV_NAME.fullmatch(n) for n in names) and len(set(names)) == len(names),
          f'{w}: secret_names must be unique UPPER_SNAKE names (never values)')
    roles = auth.get('secret_roles', {})
    if auth['type'] != 'none' and c['managed_by'] == 'http_connector':
        _need(isinstance(roles, dict) and tuple(sorted(roles)) == tuple(sorted(SECRET_ROLES[auth['type']])), f'{w}: secret_roles must be {SECRET_ROLES[auth["type"]]}')
        _need(sorted(roles.values()) == sorted(names), f'{w}: secret_roles values must be exactly secret_names')
        if auth['type'] == 'oauth2_client_credentials':
            _need(all(ENV_NAME.fullmatch(str(auth.get(k) or '')) for k in ('token_url_var',)), f'{w}: oauth2 needs token_url_var (an env var name)')
            _need(auth.get('token_auth', 'basic') in ('basic', 'post'), f'{w}: token_auth')
    if auth['type'] == 'none':
        _need(names == [], f'{w}: auth none has no secrets')
    base = c.get('base_url_var')
    _need(base is None or ENV_NAME.fullmatch(base), f'{w}: base_url_var must be an env var name (never a URL)')
    if c['managed_by'] == 'http_connector':
        _need(base is not None, f'{w}: http connector needs base_url_var')
    eps = c.get('endpoints')
    _need(isinstance(eps, dict), f'{w}: endpoints')
    for name, ep in eps.items():
        _need(name in ('send', 'read', 'health'), f'{w}: endpoint {name!r}')
        _need(isinstance(ep, dict) and ep.get('method') in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE') and isinstance(ep.get('path'), str) and ep['path'].startswith('/')
              and '://' not in ep['path'], f'{w}: endpoint {name} needs a method and a path starting with /')
    for key in ('request_schema', 'response_schema'):
        if c.get(key):
            load_schema(c[key], c['schema_status'])
    # field_mapping is the allowlist: nothing unmapped travels, and a forbidden key can never be a source.
    mapping = c.get('field_mapping', {})
    _paths(mapping, f'{w}: field_mapping')
    forbidden = set(never_send) | set(c.get('never_send_extra', []))
    if c['direction'] == 'outbound':
        for src in mapping:
            _need(not set(_root_keys(src)) & forbidden, f'{w}: field_mapping source {src!r} names a never-send key')
        _need(isinstance(c.get('static_fields', {}), dict), f'{w}: static_fields')
        _need(isinstance(c.get('idempotency'), dict) and re.fullmatch(r'[A-Za-z][A-Za-z0-9-]*', c['idempotency'].get('header', '')), f'{w}: idempotency.header')
    else:
        inb = c.get('inbound')
        if c['managed_by'] == 'http_connector':
            _need(isinstance(inb, dict), f'{w}: inbound allowlist missing')
            mv, do = inb.get('model_fields'), inb.get('display_only_fields')
            _need(isinstance(mv, list) and isinstance(do, list) and all(isinstance(x, str) for x in mv + do), f'{w}: inbound field lists')
            _need(not set(mv) & set(do), f'{w}: a field is both model-visible and display-only')
            _need(not set(mv) & set(never_to_model), f'{w}: model_fields includes a never-to-model key {sorted(set(mv) & set(never_to_model))}')
            _need(set(mapping) <= set(mv) | set(do), f'{w}: field_mapping maps a field that is not on the allowlist')
            _need(isinstance(inb.get('max_string_chars'), int) and isinstance(inb.get('max_list_items'), int), f'{w}: inbound bounds')
    ack = c.get('ack_rule')
    if c['direction'] == 'outbound':
        _need(isinstance(ack, dict) and ack.get('kind') in ('write', 'publication'), f'{w}: ack_rule.kind')
        if c['id'] == 'spotlight_cms':
            _need(ack['kind'] == 'publication' and ack.get('hash_echo_required') is True, f'{w}: the CMS must echo the revision hash and a published state')
    _need(isinstance(c.get('data_minimisation'), dict) and c['data_minimisation'].get('may_never_send') is not None, f'{w}: data_minimisation')
    if c['direction'] == 'outbound':
        _need(len(c['data_minimisation']['may_never_send']) > 0, f'{w}: data_minimisation.may_never_send must say what never leaves')
    rate = c.get('rate_limit')
    _need(rate is None or isinstance(rate, dict), f'{w}: rate_limit')
    _need(c.get('timeout_ms') is None or (isinstance(c['timeout_ms'], int) and 100 <= c['timeout_ms'] <= 30000), f'{w}: timeout_ms 100-30000')
    # Status ladder: nothing leaves not_configured without the owner's real contract.
    ready = STATUSES.index(c['status']) >= 1
    if ready and c['managed_by'] == 'http_connector':
        _need(c['wired'], f'{w}: an unwired connection cannot leave not_configured')
        _need(c['owner'] and c['owner'] != OWNER_PLACEHOLDER, f'{w}: set the confirmed owner before leaving not_configured')
        _need(eps.get('send') if c['direction'] == 'outbound' else eps.get('read'), f'{w}: no endpoint configured')
        _need(mapping, f'{w}: field_mapping is empty')
        if c['direction'] == 'outbound':
            _need(c['ack_rule'].get('record_id_path') and c['ack_rule'].get('version_path'), f'{w}: ack_rule needs record_id_path and version_path')
            if c['id'] == 'spotlight_cms':
                pub = c['ack_rule'].get('publication') or {}
                _need(all(pub.get(k) for k in ('state_path', 'published_values', 'canonical_url_path', 'published_at_path')) and c['ack_rule'].get('hash_echo_path'),
                      f'{w}: spotlight ack_rule needs the publication paths and hash_echo_path')
        if auth['type'] == 'api_key_header':
            _need(auth.get('header_name'), f'{w}: api_key_header needs header_name')
    if STATUSES.index(c['status']) >= 2 and c['managed_by'] == 'http_connector':
        _need(c['schema_status'] == 'owner_confirmed', f'{w}: contract_verified needs owner-confirmed schemas (schema_status owner_confirmed)')
    if c['status'] == 'live_verified' and c['managed_by'] == 'http_connector':
        _need(sandbox is False, f'{w}: live_verified is for the production environment (sandbox false)')
    return c


def validate_connections(cfg):
    _need(isinstance(cfg, dict) and cfg.get('status_order') == list(STATUSES), 'status_order must match the status ladder')
    dm = cfg.get('data_minimisation', {})
    for key in ('never_send_keys', 'never_to_model_keys'):
        _need(isinstance(dm.get(key), list) and dm[key] and all(isinstance(k, str) for k in dm[key]), f'data_minimisation.{key}')
    for must in ('transcript', 'internal_notes', 'interview_id', 'source_refs'):
        _need(must in dm['never_send_keys'], f'never_send_keys must include {must}')
    _need({'name', 'email'} <= set(dm['never_to_model_keys']), 'never_to_model_keys must include name and email')
    conns = cfg.get('connections')
    _need(isinstance(conns, list) and conns, 'connections missing')
    ids = [c.get('id') for c in conns]
    _need(len(set(ids)) == len(ids), 'duplicate connection id')
    for c in conns:
        validate_connection(c, dm['never_send_keys'], dm['never_to_model_keys'])
    return cfg


CONNECTIONS_CONFIG = validate_connections(json.loads((CONFIG_DIR / 'connections.json').read_text(encoding='utf-8')))

# MiChat CV, ready to connect (X2, Tony 2026-11-02): an ASSUMED contract kept beside the registry, never in it, so connections.json still says what is
# true (no owner has confirmed anything). The Worker overlays it on michat_cv only when MICHAT_CV_CONTRACT=assumed (deploy/cloudflare-edge/src/michat.js).
# The overlaid connection must pass the same validation as any configured connection. docs/MICHAT.md says what to replace when the owners answer.
MICHAT_ASSUMED_KEYS = ('owner', 'status', 'auth', 'endpoints', 'field_mapping', 'static_fields', 'ack_rule', 'timeout_ms')


def michat_assumed_connection(cfg=None, overlay=None):
    cfg = cfg or CONNECTIONS_CONFIG
    overlay = overlay if overlay is not None else MICHAT_ASSUMED_CONTRACT
    base = next(c for c in cfg['connections'] if c['id'] == 'michat_cv')
    merged = {**base, **{k: overlay[k] for k in MICHAT_ASSUMED_KEYS if k in overlay}}
    _need(merged['status'] == 'configured_untested', 'the assumed MiChat contract can only be configured_untested (never verified)')
    dm = cfg['data_minimisation']
    return validate_connection(merged, dm['never_send_keys'], dm['never_to_model_keys'])


MICHAT_ASSUMED_CONTRACT = json.loads((CONFIG_DIR / 'contracts' / 'michat_cv' / 'assumed' / 'contract.json').read_text(encoding='utf-8'))
_need(set(MICHAT_ASSUMED_CONTRACT) - {'x-status', 'x-activation'} <= set(MICHAT_ASSUMED_KEYS), 'the assumed MiChat contract may only set ' + ', '.join(MICHAT_ASSUMED_KEYS))
michat_assumed_connection()
EDGE_CONSTANTS = {'CONNECTIONS_CONFIG': CONNECTIONS_CONFIG, 'MICHAT_ASSUMED_CONTRACT': {k: v for k, v in MICHAT_ASSUMED_CONTRACT.items() if k in MICHAT_ASSUMED_KEYS}}
