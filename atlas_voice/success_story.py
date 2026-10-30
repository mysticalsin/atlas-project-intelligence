"""Success-story record: validation, audience projection and the pinned Spanish DOCX template (plan D16, task T14).

Stdlib only (zipfile + re), so the parity generator and the CLI run without aiohttp or python-docx.

* validate(story, schema) checks the JSON-Schema subset the pack schema uses (type, required, properties, items,
  maxItems, enum, x-visibility) and always rejects unknown top-level keys, whatever the schema file says.
* project_for_audience(story, audience) is the field-level allowlist (docs .../11_Plug_and_Play_Config/
  field_visibility_policy.yaml). internal sees the public fields plus the internal notes. client and public additionally
  need the approval gates below; public also needs per-KPI permission. Internal notes never leave in an external
  projection and an unknown audience, a missing gate or an unreadable story raises instead of guessing.
  src/story-projection.js ports this one function; test/gen_story_parity.py records the vectors.
* fill_docx(template, story, audience, out) fills the supplied 13-table template. The template is pinned by sha256, a
  per-table fingerprint and the internal-notes marker (TemplateMismatch on any drift, so a changed template asks for an
  adapter update instead of leaking). Client/public outputs drop the internal tables by marker cross-checked to the pinned
  indices, then every part of the written package is scanned for internal values and markers before the file appears.

The approval flags are bound to one story revision by whoever stores them (the evidence store resets them on any edit);
this module only reads them. A projection is a rendering view: the stored record is never modified.
"""
import copy
import functools
import hashlib
import io
import json
import os
import re
import zipfile
from html import unescape
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parent.parent
# Defaults come from the imported spec pack; pass schema= / policy= (or re-point these) to use another copy.
CONFIG_DIR = ROOT / 'docs' / 'agent-brain-v2.1' / '11_Plug_and_Play_Config'
SCHEMA_PATH = CONFIG_DIR / 'success_story_template.schema.json'
POLICY_PATH = CONFIG_DIR / 'field_visibility_policy.yaml'
TEMPLATE_PATH = ROOT / 'assets' / 'templates' / 'amaris_success_story_es.docx'

AUDIENCES = ('internal', 'client', 'public')
KPI_MAX = 3
KPI_STATUSES = ('measured', 'estimated', 'qualitative')  # the schema also allows unverified/omitted: never rendered
# Mirrors of the schema's item properties (tests assert equality), so a new schema key is not exported by accident.
KPI_KEYS = ('label', 'before_value', 'after_value', 'unit', 'period', 'method', 'source_refs', 'attribution', 'status', 'public_permission')
BEFORE_AFTER_KEYS = ('indicator', 'before', 'after', 'unit', 'source_refs')
QUOTE_KEYS = ('exact_text', 'speaker', 'title', 'company', 'source_ref')
ANONYMIZED_LABEL = 'Cliente anonimizado'
NAMED = 'named_allowed'  # project.client_permission value that allows an external audience to see the client name
INTERNAL_ROOTS = ('internal_notes', 'approval_state')  # never allowlisted for an external audience
# field_visibility_policy.yaml "requires" -> approval_state flags that must all be exactly true.
REQUIREMENT_GATES = {
    'evidence_validated': ('evidence_validated',),
    'exact_story_revision_approved': ('project_owner_approved',),
    'relevant_customer_and_confidentiality_permissions': ('customer_approved', 'confidentiality_reviewed'),
}
# Spotlight (workflow yaml spotlight.requires, governance 4): brand approval and the exact-revision publication authorization.
PUBLIC_EXTRA_GATES = ('brand_approved', 'public_release_authorized')


class StoryError(ValueError):
    """Base class for refusals in this module."""


class StoryInvalid(StoryError):
    def __init__(self, errors):
        super().__init__('story does not match the schema: ' + '; '.join(errors[:5]))
        self.errors = list(errors)


class ProjectionError(StoryError):
    def __init__(self, code, message=None):
        super().__init__(message or code)
        self.code = code


class AudienceDenied(ProjectionError):
    def __init__(self, audience, missing):
        super().__init__('denied', f'{audience} projection needs approval_state: ' + ', '.join(missing))
        self.audience, self.missing = audience, list(missing)


class TemplateMismatch(StoryError):
    """The template is not the pinned revision: an adapter update (and a new pin) is required before generating."""


class UnsupportedLanguage(StoryError):
    pass


class RenderCheckFailed(StoryError):
    def __init__(self, findings):
        super().__init__('post-render check failed: ' + ', '.join(findings))
        self.findings = list(findings)


# ---------------------------------------------------------------- configuration (schema + visibility policy)

def parse_policy_yaml(text):
    """The few YAML shapes field_visibility_policy.yaml uses: nested mappings, '- item' lists, inline [a, b] lists,
    quoted or bare scalars (kept as strings), full-line comments. Anything else raises rather than mis-parsing."""
    lines = []
    for raw in text.splitlines():
        if '\t' in raw:
            raise ValueError('tabs are not supported in the policy file')
        if raw.strip() and not raw.lstrip().startswith('#'):
            lines.append((len(raw) - len(raw.lstrip(' ')), raw.strip()))

    def scalar(s):
        s = s.strip()
        if s.startswith('[') and s.endswith(']'):
            return [scalar(x) for x in s[1:-1].split(',') if x.strip()]
        if len(s) >= 2 and s[0] == s[-1] and s[0] in '"\'':
            return s[1:-1]
        if s[:1] in '{|>&*!':
            raise ValueError(f'unsupported YAML value: {s}')
        return s

    def block(i, indent):
        if lines[i][1].startswith('- '):
            out = []
            while i < len(lines) and lines[i][0] == indent and lines[i][1].startswith('- '):
                out.append(scalar(lines[i][1][2:])); i += 1
            return out, i
        out = {}
        while i < len(lines) and lines[i][0] == indent and not lines[i][1].startswith('- '):
            key, sep, rest = lines[i][1].partition(':')
            if not sep or not key or ' ' in key:
                raise ValueError(f'unsupported YAML line: {lines[i][1]}')
            i += 1
            if rest.strip():
                out[key] = scalar(rest)
            elif i < len(lines) and lines[i][0] > indent:
                out[key], i = block(i, lines[i][0])
            else:
                out[key] = None
        if i < len(lines) and lines[i][0] > indent:
            raise ValueError(f'unexpected indentation near: {lines[i][1]}')
        return out, i

    if not lines:
        return {}
    value, end = block(0, lines[0][0])
    if end != len(lines):
        raise ValueError(f'unparsed policy text near: {lines[end][1]}')
    return value


@functools.lru_cache(maxsize=8)
def _load(path):
    text = Path(path).read_text(encoding='utf-8')
    return json.loads(text) if str(path).endswith('.json') else parse_policy_yaml(text)


def load_schema(path=None):
    return _load(str(path or SCHEMA_PATH))


def load_policy(path=None):
    return _load(str(path or POLICY_PATH))


def _dedupe(seq):
    return list(dict.fromkeys(seq))


def projection_config(policy=None):
    """Allowlists and gates for project_for_audience, derived from the visibility policy (fails closed on surprises)."""
    sections = (policy or load_policy()).get('sections') or {}
    public, internal = sections.get('public_story') or {}, sections.get('internal_only') or {}
    public_fields, internal_fields = list(public.get('fields') or []), list(internal.get('fields') or [])
    if not public_fields or not internal_fields:
        raise ValueError('visibility policy needs public_story.fields and internal_only.fields')
    for path in public_fields:
        if path.split('.')[0] in INTERNAL_ROOTS or path in internal_fields:
            raise ValueError(f'visibility policy would export an internal field: {path}')
    base = []
    for name in public.get('requires') or []:
        if name not in REQUIREMENT_GATES:
            raise ValueError(f'visibility policy requires {name!r}, which has no gate mapping')
        base += REQUIREMENT_GATES[name]
    if not base:
        raise ValueError('visibility policy has no release requirements')
    return {'audiences': list(AUDIENCES), 'public_fields': public_fields, 'internal_fields': internal_fields,
            'gates': {'client': _dedupe(base), 'public': _dedupe(base + list(PUBLIC_EXTRA_GATES))},
            'kpi_max': KPI_MAX, 'kpi_statuses': list(KPI_STATUSES), 'kpi_keys': list(KPI_KEYS),
            'before_after_keys': list(BEFORE_AFTER_KEYS), 'quote_keys': list(QUOTE_KEYS),
            'anonymized_label': ANONYMIZED_LABEL, 'named': NAMED}


# ---------------------------------------------------------------- validation

def _type_ok(value, name):
    if name == 'null': return value is None
    if name == 'boolean': return isinstance(value, bool)
    if name == 'string': return isinstance(value, str)
    if name == 'object': return isinstance(value, dict)
    if name == 'array': return isinstance(value, list)
    if name == 'number': return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == 'integer':
        return (isinstance(value, int) and not isinstance(value, bool)) or (isinstance(value, float) and value.is_integer())
    raise ValueError(f'unsupported schema type {name!r}')


def validate(story, schema=None):
    """Errors for the schema subset in use; [] when valid. Unknown top-level keys are always an error."""
    schema = schema or load_schema()
    errors = []

    def walk(value, node, path):
        types = node.get('type')
        if types is not None:
            names = types if isinstance(types, list) else [types]
            if not any(_type_ok(value, n) for n in names):
                errors.append(f'{path or "story"}: expected {"|".join(names)}'); return
        if 'enum' in node and value not in node['enum']:
            errors.append(f'{path}: not one of {node["enum"]}')
        if isinstance(value, dict):
            for key in node.get('required', []):
                if key not in value:
                    errors.append(f'{path + "." if path else ""}{key}: required')
            for key, sub in (node.get('properties') or {}).items():
                if key in value:
                    walk(value[key], sub, f'{path + "." if path else ""}{key}')
        if isinstance(value, list):
            if 'maxItems' in node and len(value) > node['maxItems']:
                errors.append(f'{path}: more than {node["maxItems"]} items')
            if isinstance(node.get('items'), dict):
                for i, item in enumerate(value):
                    walk(item, node['items'], f'{path}[{i}]')

    if not isinstance(story, dict):
        return ['story: expected object']
    for key in story:
        if key not in (schema.get('properties') or {}):
            errors.append(f'{key}: unknown top-level key')
    walk(story, schema, '')
    return errors


def ensure_valid(story, schema=None):
    errors = validate(story, schema)
    if errors:
        raise StoryInvalid(errors)


def internal_only_paths(schema=None):
    """Dotted paths whose schema node carries x-visibility: internal_only."""
    out = []

    def walk(node, path):
        if node.get('x-visibility') == 'internal_only':
            out.append(path)
        for key, sub in (node.get('properties') or {}).items():
            walk(sub, f'{path}.{key}' if path else key)

    walk(schema or load_schema(), '')
    return out


# ---------------------------------------------------------------- projection

def _is_set(v):
    return isinstance(v, str) and v.strip() != ''


def gate_failures(story, audience, cfg=None):
    """approval_state flags the audience needs that are not exactly true; [] for internal."""
    cfg = cfg or projection_config()
    needed = cfg['gates'].get(audience, [])
    state = story.get('approval_state') if isinstance(story, dict) else None
    state = state if isinstance(state, dict) else {}
    return [g for g in needed if state.get(g) is not True]


def _project_kpis(kpis, audience, cfg):
    out = []
    for k in kpis if isinstance(kpis, list) else []:
        if not isinstance(k, dict) or k.get('status') not in cfg['kpi_statuses'] or not _is_set(k.get('label')):
            continue
        if audience == 'public' and k.get('public_permission') is not True:
            continue
        out.append({key: copy.deepcopy(k[key]) for key in cfg['kpi_keys'] if key in k})
        if len(out) == cfg['kpi_max']:
            break
    return out


def _project_quote(quote, anonymize, cfg):
    """The quote object, or None. Only an explicitly permitted, sourced, verbatim quote survives."""
    if not isinstance(quote, dict) or quote.get('permission') is not True:
        return None
    if not _is_set(quote.get('exact_text')) or not _is_set(quote.get('source_ref')):
        return None
    out = {k: copy.deepcopy(quote[k]) for k in cfg['quote_keys'] if k in quote}
    out['permission'] = True
    if anonymize:
        out['speaker'], out['company'] = None, cfg['anonymized_label']
    return out


def _project_before_after(items, cfg):
    return [{k: copy.deepcopy(i[k]) for k in cfg['before_after_keys'] if k in i} for i in items if isinstance(i, dict)] \
        if isinstance(items, list) else []


def _lookup(obj, path):
    for part in path.split('.'):
        if not isinstance(obj, dict) or part not in obj:
            return False, None
        obj = obj[part]
    return True, obj


def _store(out, path, value):
    parts = path.split('.')
    for part in parts[:-1]:
        out = out.setdefault(part, {})
    out[parts[-1]] = value


def _scrub_strings(value, pattern, label):
    if isinstance(value, str): return pattern.sub(lambda m: label, value)
    if isinstance(value, list): return [_scrub_strings(v, pattern, label) for v in value]
    if isinstance(value, dict): return {k: _scrub_strings(v, pattern, label) for k, v in value.items()}
    return value


def anonymizing(story, audience):
    """An external audience only sees the client's name when project.client_permission is exactly named_allowed."""
    if audience == 'internal':
        return False
    project = story.get('project') if isinstance(story, dict) else None
    return not (isinstance(project, dict) and project.get('client_permission') == NAMED)


def project_for_audience(story, audience, policy=None):
    if audience not in AUDIENCES:
        raise ProjectionError('audience', f'unknown audience {audience!r}')
    if not isinstance(story, dict):
        raise ProjectionError('story', 'story must be an object')
    cfg = projection_config(policy)
    missing = gate_failures(story, audience, cfg)
    if missing:
        raise AudienceDenied(audience, missing)
    anonymize = anonymizing(story, audience)
    fields = cfg['public_fields'] + (cfg['internal_fields'] if audience == 'internal' else [])
    out = {}
    quote_path = 'amaris_differentiator.client_quote'
    for path in fields:
        found, value = _lookup(story, path)
        if not found:
            continue
        if path == 'kpis':
            value = _project_kpis(value, audience, cfg)
        elif path == 'results.before_after':
            value = _project_before_after(value, cfg)
        elif path == quote_path:
            value = _project_quote(value, anonymize, cfg)
            if value is None:
                continue
        else:
            value = copy.deepcopy(value)
        _store(out, path, value)
    if anonymize:
        project = story.get('project') if isinstance(story.get('project'), dict) else {}
        name = project.get('client_display')
        if isinstance(name, str) and len(name.strip()) >= 3:
            pattern = re.compile(re.escape(name.strip()), re.I)
            quote = out.get('amaris_differentiator', {}).pop('client_quote', None)
            out = _scrub_strings(out, pattern, cfg['anonymized_label'])
            if quote is not None and not pattern.search(quote['exact_text']):
                _store(out, quote_path, quote)  # verbatim text is never edited: a quote naming the client is dropped
        _store(out, 'project.client_display', cfg['anonymized_label'])
    return out


# ---------------------------------------------------------------- the pinned template

# sha256 of assets/templates/amaris_success_story_es.docx (identical to the pack's Entrevista_Caso_de_Exito_Consultores_Template.docx)
# and, per table of word/document.xml: [rows, cells per row, sha256[:16] of its paragraph text]. Regenerate with
# table_fingerprints() only together with the adapter code below when the template is deliberately replaced.
TEMPLATE_PIN = {
    'language': 'es',
    'sha256': 'b7b3915bbebe5b8ec90c4c63f54b84d1a10f2205ed5f0e1340ac9884843a672e',
    'tables': [[1, [2], '39090ef0d8262b0e'], [2, [4, 4], '10b7b8df7e5ff8fb'], [1, [2], 'eeefd08e507bb7d6'], [1, [2], '2e5e4a5d43588440'],
               [2, [3, 3], '065f3fdaa2e5e4ff'], [1, [2], '3c4ac5e57c444061'], [1, [2], 'e4da80185eb5105a'], [1, [2], '2364a9c2f62e4ba7'],
               [5, [3, 3, 3, 3, 3], 'ea098d9996ba8e8c'], [1, [2], '9d65257a82797aea'], [1, [2], '9694f3e3d2f8e699'],
               [1, [2], '9047e2df2b1f0fbc'], [2, [3, 3], 'f7363db8f8e65534']],
    'notes_marker': 'NOTAS INTERNAS',
    'notes_tables': (11, 12),  # heading table (carries the marker) and the manager/consultant/date table
    'quote_table': 10,
}
TEMPLATES = {'es': TEMPLATE_PIN}  # one pinned template per output language; FR/EN are separate versioned templates
EXTRA_LEAK_MARKERS = ('NO COMPARTIR CON CLIENTE', 'Manager a cargo')

_ROW = re.compile(r'<w:tr(?:\s[^>]*)?>.*?</w:tr>', re.S)
_CELL = re.compile(r'<w:tc(?:\s[^>]*)?>.*?</w:tc>', re.S)
_PARA = re.compile(r'<w:p(?:\s[^>]*)?>.*?</w:p>', re.S)
_RUN = re.compile(r'<w:r(?:\s[^>]*)?>.*?</w:r>', re.S)
_TEXT = re.compile(r'<w:t(?:\s[^>]*)?>(.*?)</w:t>', re.S)
_TBL = re.compile(r'<w:tbl>.*?</w:tbl>', re.S)
_XML_BAD = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]')


def _para_text(para):
    return ''.join(unescape(t) for t in _TEXT.findall(para))


def _split_tables(doc):
    """(segments, tables): body XML around the tables and the tables themselves (no nesting allowed)."""
    tables = _TBL.findall(doc)
    for t in tables:
        if t.count('<w:tbl>') != 1:
            raise TemplateMismatch('nested tables are not part of the pinned template')
    return _TBL.split(doc), tables


def table_fingerprints(doc):
    out = []
    for t in _split_tables(doc)[1]:
        text = '\n'.join(_para_text(p) for p in _PARA.findall(t))
        out.append([len(_ROW.findall(t)), [len(_CELL.findall(r)) for r in _ROW.findall(t)], hashlib.sha256(text.encode()).hexdigest()[:16]])
    return out


def _read_package(data):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            return [(i, z.read(i.filename)) for i in z.infolist()]
    except (zipfile.BadZipFile, OSError) as e:
        raise TemplateMismatch(f'template is not a readable package: {e}')


def check_template(data, pin=None):
    """TemplateMismatch unless data is the pinned template; returns (package entries, document.xml text)."""
    pin = pin or TEMPLATE_PIN
    if hashlib.sha256(data).hexdigest() != pin['sha256']:
        raise TemplateMismatch('template bytes differ from the pinned revision (sha256); update the adapter and the pin')
    entries = _read_package(data)
    doc = next((b for i, b in entries if i.filename == 'word/document.xml'), None)
    if doc is None:
        raise TemplateMismatch('word/document.xml is missing')
    doc = doc.decode('utf-8')
    if table_fingerprints(doc) != [list(t) for t in pin['tables']]:
        raise TemplateMismatch(f'table layout differs from the pinned {len(pin["tables"])}-table template; adapter update required')
    segments, tables = _split_tables(doc)
    marker = pin['notes_marker'].lower()
    hits = [i for i, t in enumerate(tables) if marker in '\n'.join(_para_text(p) for p in _PARA.findall(t)).lower()]
    outside = [s for s in segments if marker in '\n'.join(_para_text(p) for p in _PARA.findall(s)).lower()]
    if hits != [pin['notes_tables'][0]] or outside:
        raise TemplateMismatch('internal-notes marker is not exactly where the pin expects it')
    return entries, doc


# ---------------------------------------------------------------- DOCX editing (string level: the original XML is kept)

def _edit(xml, pattern, index, fn):
    matches = list(pattern.finditer(xml))
    if index >= len(matches):
        raise TemplateMismatch(f'expected element {index} not found')
    m = matches[index]
    return xml[:m.start()] + fn(m.group(0)) + xml[m.end():]


def _edit_para(tbl, row, cell, para, fn):
    return _edit(tbl, _ROW, row, lambda r: _edit(r, _CELL, cell, lambda c: _edit(c, _PARA, para, fn)))


def _t(text):
    """Run content for text, line breaks as <w:br/>; control characters XML forbids are dropped."""
    parts = _XML_BAD.sub('', str(text)).replace('\r\n', '\n').split('\n')
    esc = lambda s: s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    return '<w:br/>'.join(f'<w:t xml:space="preserve">{esc(p)}</w:t>' for p in parts)


def _restyle(rpr, italic=None, color=None, size=None):
    if italic is False:
        rpr = re.sub(r'<w:i(?:Cs)?/>', '', rpr)
    if color:
        rpr = re.sub(r'<w:color w:val="\w+"/>', f'<w:color w:val="{color}"/>', rpr)
    if size:
        rpr = re.sub(r'<w:sz w:val="\d+"/>', f'<w:sz w:val="{size}"/>', rpr)
        rpr = re.sub(r'<w:szCs w:val="\d+"/>', f'<w:szCs w:val="{size}"/>', rpr)
    return rpr


def _new_run(ref_run, text, **mods):
    m = re.search(r'<w:rPr>.*?</w:rPr>', ref_run, re.S)
    return f'<w:r>{_restyle(m.group(0), **mods) if m else ""}{_t(text)}</w:r>'


def _rewrite(para, items):
    """Rebuild a paragraph from its own runs: ('keep', i) keeps run i (template '*' markers removed),
    ('new', text, ref_i, mods) writes text in run ref_i's formatting. The paragraph properties are untouched."""
    runs = list(_RUN.finditer(para))
    head = para[:runs[0].start()] if runs else para[:-len('</w:p>')]
    body = []
    for item in items:
        if item[0] == 'keep':
            run = runs[item[1]].group(0)
            tidy = (lambda t: t.rstrip()) if len(item) > 2 else (lambda t: t)  # ('keep', i, 'rstrip') for a label followed by a value
            body.append(re.sub(r'(<w:t(?:\s[^>]*)?>)(.*?)(</w:t>)', lambda m: m.group(1) + tidy(re.sub(r'\s{2,}', ' ', m.group(2).replace('*', ''))) + m.group(3), run, flags=re.S))
        else:
            _, text, ref, mods = item
            body.append(_new_run(runs[ref].group(0), text, **mods))
    return head + ''.join(body) + '</w:p>'


PLAIN = {'italic': False, 'color': '262626'}  # a filled value replaces grey italic guidance with normal text
DASH = '—'


def _s(value):
    """Display text for a story value; missing is a dash, never a template placeholder or an invented number."""
    if value is None or isinstance(value, bool):
        return DASH
    if isinstance(value, (list, tuple)):
        parts = [_s(v) for v in value if v is not None and str(v).strip() != '']
        return ', '.join(p for p in parts if p != DASH) or DASH
    if isinstance(value, float):
        value = int(value) if value.is_integer() else value
        return str(value).replace('.', ',')
    text = str(value).strip()
    return text or DASH


def _amount(value, unit):
    v = _s(value)
    unit = unit.strip() if isinstance(unit, str) else ''
    if v == DASH or not unit or unit.lower() in v.lower():
        return v
    return f'{v}{unit}' if unit == '%' else f'{v} {unit}'


_STATUS_ES = {'measured': 'Medido', 'estimated': 'Estimado', 'qualitative': 'Cualitativo'}


def _kpi_texts(k):
    """(value, caption label, caption detail) for one projected KPI: baseline, after, unit, period, method, source kept."""
    after = _amount(k.get('after_value'), k.get('unit'))
    if after == DASH and k.get('status') == 'qualitative':
        after = _STATUS_ES['qualitative']
    elif k.get('status') == 'estimated' and after != DASH:
        after = '~' + after
    lines = []
    if k.get('before_value') is not None:
        lines.append(f'Antes: {_amount(k.get("before_value"), k.get("unit"))} → Después: {_amount(k.get("after_value"), k.get("unit"))}')
    for label, key in (('Período', 'period'), ('Método', 'method')):
        if _is_set(k.get(key)):
            lines.append(f'{label}: {k[key].strip()}')
    if k.get('source_refs'):
        lines.append(f'Fuente: {_s(k["source_refs"])}')
    if _is_set(k.get('attribution')):
        lines.append(f'Atribución: {k["attribution"].strip()}')
    lines.append(f'Estado: {_STATUS_ES[k["status"]]}')
    return after, k['label'].strip(), '\n'.join(lines)


_CATEGORIES = (('tiempo', 'time', 'plazo', 'duraci'), ('costo', 'cost', 'coste'), ('error', 'reproceso', 'rework', 'defect'))


def _result_rows(items):
    """Table 8 rows: first time / cost / error indicator fills its template row, the rest go to 'other' rows."""
    slots, other = [None, None, None], []
    for item in items:
        name = str(item.get('indicator') or '').lower()
        cat = next((i for i, words in enumerate(_CATEGORIES) if any(w in name for w in words)), None)
        if cat is not None and slots[cat] is None:
            slots[cat] = item
        else:
            other.append(item)
    return slots, other


def _result_texts(item):
    return (_s(item.get('indicator')), _amount(item.get('before'), item.get('unit')), _amount(item.get('after'), item.get('unit')))


def _render_document(doc, projection, audience, pin):
    segments, tables = _split_tables(doc)
    pr = projection
    g = lambda path: _lookup(pr, path)[1]

    # Table 0 banner: the logo placeholder shows the (possibly anonymised) client name.
    tables[0] = _edit_para(tables[0], 0, 1, 0, lambda p: _rewrite(p, [('new', _s(g('project.client_display')), 0, {})]))
    # Table 1 metadata card: [label, line break, placeholder] cells; the technologies cell has a second paragraph.
    card = {(0, 0): g('project.client_display'), (0, 1): g('project.industry'), (0, 2): g('project.year'),
            (0, 3): None if g('project.duration_months') is None else _s(g('project.duration_months')) + ' meses',
            (1, 0): g('project.consultant_count'), (1, 1): g('project.main_role'), (1, 2): g('project.country')}
    for (r, c), value in card.items():
        tables[1] = _edit_para(tables[1], r, c, 0, lambda p, v=value: _rewrite(p, [('keep', 0), ('keep', 1), ('new', _s(v), 2, PLAIN)]))
    tables[1] = _edit_para(tables[1], 1, 3, 1, lambda p: _rewrite(p, [('new', _s(g('project.technologies')), 0, PLAIN)]))

    # Table 4: up to three KPI tiles (value over caption); unused tiles stay a dash.
    kpis = g('kpis') or []
    for i in range(KPI_MAX):
        value, label, detail = _kpi_texts(kpis[i]) if i < len(kpis) else (DASH, 'Sin KPI verificado', '')
        tables[4] = _edit_para(tables[4], 0, i, 0, lambda p, v=value: _rewrite(p, [('new', v, 0, {})]))
        tables[4] = _edit_para(tables[4], 1, i, 0, lambda p, l=label, d=detail: _rewrite(
            p, [('new', l, 0, {})] + ([('keep', 1), ('new', d, 2, {'italic': False, 'color': '404040', 'size': 16})] if d else [])))

    # Table 8: before/after rows.
    slots, other = _result_rows([i for i in (g('results.before_after') or []) if isinstance(i, dict)])
    rows = [(1, slots[0]), (2, slots[1]), (3, slots[2])]
    extra = max(0, len(other) - 1)
    for _ in range(extra):  # more indicators than template rows: clone the last row
        last = _ROW.findall(tables[8])[-1]
        tables[8] = tables[8][:tables[8].rindex('</w:tbl>')] + last + '</w:tbl>'
    rows += [(4 + i, item) for i, item in enumerate(other)]
    for r, item in rows:
        if item is None:
            continue
        for c, text in enumerate(_result_texts(item)):
            ref = 0
            tables[8] = _edit_para(tables[8], r, c, 0, lambda p, t=text, ref=ref: _rewrite(p, [('new', t, ref, {})]))

    # Table 10: client quote, only when projection kept it. Otherwise the block is removed (no paraphrase in quotation marks).
    quote = g('amaris_differentiator.client_quote')
    drop = []
    if quote:
        who = ', '.join(x.strip() for x in (quote.get('speaker'), quote.get('title')) if _is_set(x))
        where = quote.get('company').strip() if _is_set(quote.get('company')) else ''
        attribution = '— ' + ' · '.join(x for x in (who, where) if x) if (who or where) else '—'
        tables[10] = _edit_para(tables[10], 0, 1, 0, lambda p: _rewrite(p, [('new', '"' + quote['exact_text'].strip() + '"', 0, {})]))
        tables[10] = _edit_para(tables[10], 0, 1, 1, lambda p: _rewrite(p, [('new', attribution, 0, {'italic': False, 'color': '404040'})]))
    else:
        drop.append(pin['quote_table'])

    # Table 12 (internal notes) is filled for internal exports and removed, with its heading table, for everyone else.
    if audience == 'internal':
        for c, key in enumerate(('manager', 'consultant', 'date')):
            tables[12] = _edit_para(tables[12], 1, c, 0, lambda p, k=key: _rewrite(p, [('new', _s(g('internal_notes.' + k)), 0, PLAIN)]))
    else:
        drop += list(pin['notes_tables'])

    def labelled(value):
        # the label run keeps its own formatting; the grey guidance runs after it are replaced by the value
        return lambda p: _rewrite(p, [('keep', 0, 'rstrip'), ('new', ' ' + _s(value), 2, PLAIN)])

    # Body paragraphs (between tables) addressed by the label they start with.
    body_fill = (('Resumen:', g('summary.text')), ('¿Qué problema tenía el cliente?', g('challenge.problem')),
                 ('¿Por qué era importante resolverlo?', g('challenge.why_important')), ('¿Qué hicimos?', g('solution.what_we_did')),
                 ('Tecnologías principales:', g('solution.technologies')), ('¿Cómo trabajamos con el cliente?', g('solution.client_working_model')),
                 ('¿Qué puede hacer el cliente ahora que antes no podía?', g('results.new_capability')),
                 ('¿Por qué nos eligieron o por qué fue clave nuestro rol?', g('amaris_differentiator.why_selected')),
                 ('¿Qué valoró más el cliente?', g('amaris_differentiator.client_valued')))
    done = set()
    for si, seg in enumerate(segments):
        def fix(p):
            text = _para_text(p)
            if text.startswith('💡'):
                return ''  # the template's authoring hint is guidance, not content
            for label, value in body_fill:
                if text.startswith(label):
                    done.add(label)
                    return labelled(value)(p)
            return p
        segments[si] = _PARA.sub(lambda m: fix(m.group(0)), seg)
    if done != {b[0] for b in body_fill}:
        raise TemplateMismatch('a pinned body label was not found: ' + ', '.join(sorted({b[0] for b in body_fill} - done)))

    out = [segments[0]]
    for i, t in enumerate(tables):
        if i not in drop:
            out.append(t)
        out.append(segments[i + 1])
    return ''.join(out), len(tables) - len(set(drop))


# ---------------------------------------------------------------- leak and placeholder scan

PLACEHOLDERS = ('XX%', 'XX hrs', 'X meses', 'Nombre empresa', '[Nombre', '[DD/MM/AAAA]', '[Logo', '[cliente]', '[solución]',
                '[resultado principal]', 'Frase del cliente sobre', '[Empresa]', '💡', 'KPI #')


def _views(name, data):
    """Searchable text of one package part: raw (entity-decoded) and, for WordprocessingML, paragraph-joined text."""
    if not name.endswith(('.xml', '.rels')):
        return []
    raw = unescape(data.decode('utf-8', 'replace'))
    views = [raw, re.sub(r'<[^>]+>', ' ', raw)]
    if '<w:p' in raw:
        views.append('\n'.join(_para_text(p) for p in _PARA.findall(raw)))
    return views


def scan_package(data, story, audience):
    """Findings (codes only, never the secret text) for a written package: internal values or markers surviving in an
    external export, an unpermitted quote, the client's name after anonymisation, or template placeholders."""
    findings = []
    views = []
    for info, blob in _read_package(data):
        views += [(info.filename, v) for v in _views(info.filename, blob)]
    notes = story.get('internal_notes') if isinstance(story.get('internal_notes'), dict) else {}
    cfg = projection_config()

    def has(pattern, flags=0):
        return any(re.search(pattern, v, flags) for _, v in views)

    if audience != 'internal':
        for marker in (TEMPLATE_PIN['notes_marker'],) + EXTRA_LEAK_MARKERS:
            if has(re.escape(marker), re.I):
                findings.append(f'internal_marker:{marker}')
        for key, value in notes.items():
            if isinstance(value, str) and value.strip() and has(r'(?<!\w)' + re.escape(value.strip()) + r'(?!\w)'):
                findings.append(f'internal_value:{key}')
    quote = (story.get('amaris_differentiator') or {}).get('client_quote') if isinstance(story.get('amaris_differentiator'), dict) else None
    if isinstance(quote, dict) and _is_set(quote.get('exact_text')) and _project_quote(quote, False, cfg) is None and has(re.escape(quote['exact_text'].strip())):
        findings.append('unpermitted_quote')
    project = story.get('project') if isinstance(story.get('project'), dict) else {}
    name = project.get('client_display')
    if anonymizing(story, audience) and isinstance(name, str) and len(name.strip()) >= 3 and has(re.escape(name.strip()), re.I):
        findings.append('client_name_after_anonymisation')
    for ph in PLACEHOLDERS:
        if has(re.escape(ph)):
            findings.append(f'placeholder:{ph}')
    return findings


# ---------------------------------------------------------------- fill_docx

def _core_properties(xml):
    """The template's last-modified-by is a person: replace it so no export carries that name."""
    return re.sub(r'(<cp:lastModifiedBy>).*?(</cp:lastModifiedBy>)', r'\1ATLAS\2', xml, flags=re.S)


def render_docx(template_bytes, story, audience, language='es', schema=None, policy=None, pin=None):
    """The filled package as bytes. Raises before returning anything unsafe."""
    if language not in TEMPLATES and pin is None:
        raise UnsupportedLanguage(f'no pinned template for {language!r}; add a versioned template and pin')
    pin = pin or TEMPLATES[language]
    entries, doc = check_template(template_bytes, pin)
    ensure_valid(story, schema)
    projection = project_for_audience(story, audience, policy)
    new_doc, _ = _render_document(doc, projection, audience, pin)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for info, blob in entries:
            if info.filename == 'word/document.xml':
                blob = new_doc.encode('utf-8')
            elif info.filename == 'docProps/core.xml':
                blob = _core_properties(blob.decode('utf-8')).encode('utf-8')
            if info.filename.endswith(('.xml', '.rels')):
                ElementTree.fromstring(blob)  # a malformed part would make Word refuse the file
            out_info = zipfile.ZipInfo(info.filename, info.date_time)
            out_info.compress_type, out_info.external_attr = zipfile.ZIP_DEFLATED, info.external_attr
            z.writestr(out_info, blob)
    data = buf.getvalue()
    findings = scan_package(data, story, audience)
    if findings:
        raise RenderCheckFailed(findings)
    return data


def fill_docx(template_path, story, audience, out_path, language='es', schema=None, policy=None, pin=None):
    data = render_docx(Path(template_path).read_bytes(), story, audience, language, schema, policy, pin)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + '.tmp')
    tmp.write_bytes(data)
    os.replace(tmp, out)
    return out


def _edge_constants():
    return {'STORY_PROJECTION': projection_config()}


EDGE_CONSTANTS = _edge_constants()
