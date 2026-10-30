"""Success-story safety (plan D16, T14): schema validation, audience projection, the pinned Spanish DOCX template.
t1..t10 are the pack's template acceptance tests (docs/agent-brain-v2.1/07_Evaluation_and_QA/ATLAS_v2.1_Workflow_and_Template_Acceptance_Tests.md);
the rest pin the gates, the leak scan and the config seam. Stdlib only: documents are read back with zipfile + ElementTree."""
import copy, hashlib, io, json, re, subprocess, sys, zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
import pytest
from atlas_voice import success_story as ss

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / 'tests' / 'fixtures' / 'success_story_TEST_ONLY.json'
PACK = ROOT / 'docs' / 'agent-brain-v2.1'
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
TEMPLATE = ss.TEMPLATE_PATH
NOTES = {'manager': 'MANAGER_INTERNAL_TEST', 'consultant': 'CONSULTANT_INTERNAL_TEST', 'date': '30/10/2026'}


def fixture():
    return json.loads(FIXTURE.read_text(encoding='utf-8'))


def approved(**over):
    """The fixture with every approval, a named client, a permitted sourced quote and one public KPI."""
    s = fixture()
    s['approval_state'].update(project_owner_approved=True, customer_approved=True, confidentiality_reviewed=True, brand_approved=True, public_release_authorized=True)
    s['project']['client_permission'] = 'named_allowed'
    s['amaris_differentiator']['client_quote'].update(permission=True, source_ref='S1:D-004', exact_text='Nos cambió la forma de trabajar.')
    for k in s['kpis']:
        k['public_permission'] = True
    s.update(over)
    return s


def package(path):
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n) for n in z.namelist()}


def texts(path):
    """Every package part as plain text (paragraphs joined), parts keyed by name."""
    out = {}
    for name, blob in package(path).items():
        if name.endswith(('.xml', '.rels')):
            root = ET.fromstring(blob)
            paras = [''.join(t.text or '' for t in p.iter(W + 't')) for p in root.iter(W + 'p')]
            out[name] = '\n'.join(paras) if paras else ' '.join(root.itertext())
    return out


def alltext(path):
    return '\n'.join(texts(path).values())


def doc_text(path):
    return texts(path)['word/document.xml']


def n_tables(path):
    return len(ET.fromstring(package(path)['word/document.xml']).find(W + 'body').findall(W + 'tbl'))


def fill(tmp_path, story, audience, name=None):
    return ss.fill_docx(TEMPLATE, story, audience, tmp_path / (name or f'{audience}.docx'))


def rewrite_template(mutate):
    """The template package with word/document.xml (str) passed through mutate; returns bytes."""
    src = package(TEMPLATE)
    src['word/document.xml'] = mutate(src['word/document.xml'].decode('utf-8')).encode('utf-8')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for n, b in src.items(): z.writestr(n, b)
    return buf.getvalue()


# ------------------------------------------------------------------ T1-T10 (pack acceptance tests)

def test_t1_field_mapping_covers_every_metadata_and_narrative_field(tmp_path):
    s = approved()
    tokens = {}
    def tok(path, value=None):
        tokens[path] = value or f'ZZ{len(tokens):02d}'
        return tokens[path]
    p = s['project']
    p.update(client_display=tok('client'), industry=tok('industry'), year=2031, duration_months=7, consultant_count=9, main_role=tok('role'),
             country=tok('country'), technologies=[tok('tech1'), tok('tech2')])
    s['summary']['text'] = tok('summary')
    s['challenge'].update(problem=tok('problem'), why_important=tok('why'))
    s['solution'].update(what_we_did=tok('did'), technologies=[tok('stech1'), tok('stech2')], client_working_model=tok('model'))
    s['results']['new_capability'] = tok('capability')
    s['results']['before_after'] = [{'indicator': tok('ind_time') + ' tiempo', 'before': tok('b1'), 'after': tok('a1')}]
    s['amaris_differentiator'].update(why_selected=tok('selected'), client_valued=tok('valued'))
    s['amaris_differentiator']['client_quote'].update(exact_text=tok('quote'), speaker=tok('speaker'), title=tok('qtitle'), company=tok('qcompany'))
    s['internal_notes'] = {'manager': tok('manager'), 'consultant': tok('consultant'), 'date': '01/02/2027'}
    text = doc_text(fill(tmp_path, s, 'internal'))
    for path, token in tokens.items():
        assert token in text, f'{path} not in the document'
    for needle in ('2031', '7 meses', '01/02/2027'):
        assert needle in text
    # and every Spanish section of the template is still there
    for label in ('CASO DE ÉXITO', 'RESUMEN DEL PROYECTO', 'NÚMEROS CLAVE', 'CONTEXTO Y DESAFÍO', 'SOLUCIÓN IMPLEMENTADA', 'RESULTADOS OBTENIDOS', 'EL DIFERENCIAL DE AMARIS'):
        assert label in text


def test_t2_at_most_three_kpis_and_unsupported_ones_are_omitted(tmp_path):
    kpi = lambda i, status='measured', **k: {'label': f'KPI{i}ZZ', 'after_value': i, 'unit': '%', 'status': status, 'public_permission': True, **k}
    # the projection is a hard cap: a 4th supported KPI is dropped, an unsupported one never takes a slot
    s = approved(kpis=[kpi(1, 'unverified'), kpi(2, 'omitted'), kpi(3), kpi(4, 'estimated'), kpi(5, 'qualitative'), kpi(6), kpi(7)])
    for aud in ('internal', 'client', 'public'):
        assert [k['label'] for k in ss.project_for_audience(s, aud)['kpis']] == ['KPI3ZZ', 'KPI4ZZ', 'KPI5ZZ']
    # a record with four KPIs is not a valid record at all (schema maxItems), so no document is produced
    with pytest.raises(ss.StoryInvalid):
        fill(tmp_path, approved(kpis=[kpi(i) for i in range(1, 5)]), 'public')
    # unverified KPIs are not rendered, supported ones are
    text = doc_text(fill(tmp_path, approved(kpis=[kpi(1, 'unverified'), kpi(2), kpi(3, 'estimated')]), 'internal'))
    assert 'KPI1ZZ' not in text and 'KPI2ZZ' in text and 'KPI3ZZ' in text and 'Sin KPI verificado' in text


def test_t3_kpi_preserves_baseline_after_unit_period_method_and_source(tmp_path):
    k = {'label': 'Tiempo de cierre', 'before_value': 48, 'after_value': 4, 'unit': 'h', 'period': 'Q1-Q2 2026', 'method': 'Medición de tickets en Jira',
         'source_refs': ['S1:D-002'], 'attribution': 'equipo', 'status': 'measured', 'public_permission': True}
    s = approved(kpis=[k])
    for aud in ('client', 'public'):
        assert ss.project_for_audience(s, aud)['kpis'] == [k]
    text = doc_text(fill(tmp_path, s, 'public'))
    for needle in ('Tiempo de cierre', '48 h', '4 h', 'Q1-Q2 2026', 'Medición de tickets en Jira', 'S1:D-002', 'Medido'):
        assert needle in text, needle
    est = approved(kpis=[{**k, 'status': 'estimated'}])
    assert '~4 h' in doc_text(fill(tmp_path, est, 'public', 'est.docx')) and 'Estimado' in doc_text(tmp_path / 'est.docx')


def test_t4_no_numeric_impact_is_invented(tmp_path):
    s = approved(); s.pop('kpis'); s['results'].pop('before_after')
    for aud in ('internal', 'client', 'public'):
        text = doc_text(fill(tmp_path, s, aud))
        for placeholder in ('XX%', 'XX hrs', 'X meses', 'KPI #', 'Ej:', '[Nombre', '[DD/MM/AAAA]', '[Logo', 'Nombre empresa', '💡'):
            if placeholder == '[Nombre' and aud == 'internal':
                continue
            assert placeholder not in text, placeholder
        assert not re.search(r'\d+\s*%', text)
    # a story with only qualitative impact stays qualitative
    q = approved(kpis=[{'label': 'Adopción', 'status': 'qualitative', 'public_permission': True}])
    text = doc_text(fill(tmp_path, q, 'public', 'q.docx'))
    assert 'Cualitativo' in text and not re.search(r'\d+\s*%', text)
    # missing fields become a dash, not template text
    sparse = {'project': {'year': 2026, 'country': 'Chile'}, 'summary': {'text': 'Resumen'}, 'challenge': {'problem': 'P'}, 'solution': {'what_we_did': 'S'},
              'approval_state': {'evidence_validated': True, 'public_release_authorized': False}}
    text = doc_text(fill(tmp_path, sparse, 'internal', 'sparse.docx'))
    assert 'Nombre empresa' not in text and 'Banca / Retail' not in text and '—' in text and 'Ej: 3' not in text


def test_t5_quote_is_verbatim_and_permission_checked_and_paraphrase_never_quoted(tmp_path):
    s = approved()
    text = doc_text(fill(tmp_path, s, 'public'))
    assert '"Nos cambió la forma de trabajar."' in text and 'Persona Test' in text
    assert text.count('"') == 2 and not re.search('[“”«»]', text)  # the quote is the only quoted text in the document
    assert s['amaris_differentiator']['client_valued'] in text and f'"{s["amaris_differentiator"]["client_valued"]}' not in text
    # permission false, no source, no text: the quote is absent in every audience, block included
    for bad in ({'permission': False}, {'source_ref': None}, {'source_ref': ''}, {'exact_text': ' '}):
        s2 = approved(); s2['amaris_differentiator']['client_quote'].update(bad)
        for aud in ('internal', 'client', 'public'):
            assert 'client_quote' not in ss.project_for_audience(s2, aud).get('amaris_differentiator', {})
            out = fill(tmp_path, s2, aud, f'{aud}-bad.docx')
            assert 'Nos cambió' not in alltext(out) and '"' not in doc_text(out)
    # permission must be the boolean true: anything else is no permission in the projection and an invalid record for the document
    for bad in ('true', 1, None, [True]):
        s2 = approved(); s2['amaris_differentiator']['client_quote']['permission'] = bad
        assert 'client_quote' not in ss.project_for_audience(s2, 'internal').get('amaris_differentiator', {})
        with pytest.raises(ss.StoryInvalid):
            fill(tmp_path, s2, 'internal')
    # pack sample: permission false, so the quote text 'Cita de prueba' appears nowhere
    sample = fixture()
    assert 'Cita de prueba' not in alltext(fill(tmp_path, sample, 'internal', 'sample.docx'))
    # a verbatim quote that names an anonymised client is dropped, not edited
    s3 = approved(); s3['project']['client_permission'] = 'anonymize'; s3['amaris_differentiator']['client_quote']['exact_text'] = 'En CLIENTE TEST todo cambió.'
    assert 'client_quote' not in ss.project_for_audience(s3, 'public')['amaris_differentiator']


def test_t6_internal_notes_are_a_separate_restricted_object():
    schema = ss.load_schema()
    assert ss.internal_only_paths(schema) == ['internal_notes']
    for aud in ('client', 'public'):
        proj = ss.project_for_audience(approved(), aud)
        assert 'internal_notes' not in proj and 'approval_state' not in proj
        assert NOTES['manager'] not in json.dumps(proj, ensure_ascii=False)
    proj = ss.project_for_audience(approved(), 'internal')
    assert proj['internal_notes'] == NOTES
    cfg = ss.projection_config()
    assert not any(f.startswith('internal_notes') for f in cfg['public_fields'])
    # an internal field sneaking into the public allowlist is refused outright
    bad = copy.deepcopy(ss.load_policy()); bad['sections']['public_story']['fields'].append('internal_notes.manager')
    with pytest.raises(ValueError):
        ss.projection_config(bad)
    bad = copy.deepcopy(ss.load_policy()); bad['sections']['public_story']['fields'].append('approval_state.public_release_authorized')
    with pytest.raises(ValueError):
        ss.projection_config(bad)


@pytest.mark.parametrize('audience', ['client', 'public'])
def test_t7_external_docx_has_no_internal_notes_heading_or_values(tmp_path, audience):
    out = fill(tmp_path, approved(), audience)
    assert n_tables(out) == 11  # 13 minus the two internal tables
    for name, text in texts(out).items():
        for forbidden in ('NOTAS INTERNAS', 'NO COMPARTIR CON CLIENTE', 'Manager a cargo', *NOTES.values()):
            assert forbidden.lower() not in text.lower(), (name, forbidden)
    assert ss.scan_package(out.read_bytes(), approved(), audience) == []


def test_t8_internal_docx_retains_the_restricted_notes(tmp_path):
    out = fill(tmp_path, approved(), 'internal')
    assert n_tables(out) == 13
    text = doc_text(out)
    for needle in ('NOTAS INTERNAS', 'NO COMPARTIR CON CLIENTE', 'Manager a cargo', *NOTES.values()):
        assert needle in text


def test_t9_template_layout_is_version_pinned_and_fails_safely(tmp_path):
    data = TEMPLATE.read_bytes()
    assert hashlib.sha256(data).hexdigest() == ss.TEMPLATE_PIN['sha256'] and len(ss.TEMPLATE_PIN['tables']) == 13
    assert data == (PACK / '10_Source_References' / 'Entrevista_Caso_de_Exito_Consultores_Template.docx').read_bytes()
    pin = lambda blob: {**ss.TEMPLATE_PIN, 'sha256': hashlib.sha256(blob).hexdigest()}  # a pin that accepts the bytes, so the structure checks run
    def refuse(blob, why, custom_pin=True):
        with pytest.raises(ss.TemplateMismatch) as e:
            ss.render_docx(blob, approved(), 'public', pin=pin(blob) if custom_pin else None)
        assert why in str(e.value), str(e.value)
    # altered bytes: the sha pin refuses before anything else
    refuse(data[:-1] + bytes([data[-1] ^ 1]), 'sha256', custom_pin=False)
    refuse(rewrite_template(lambda d: d.replace('RESUMEN DEL PROYECTO', 'RESUMEN DEL PROYECTO.')), 'sha256', custom_pin=False)
    refuse(b'not a docx', 'sha256', custom_pin=False)
    # structure changes with a re-pinned sha: a dropped table, an extra table, a reordered table, edited label text
    first = ss._TBL.search(package(TEMPLATE)['word/document.xml'].decode()).group(0)
    refuse(rewrite_template(lambda d: d.replace(first, '', 1)), 'table layout')
    refuse(rewrite_template(lambda d: d.replace(first, first + first, 1)), 'table layout')
    refuse(rewrite_template(lambda d: d.replace('Indicador', 'Métrica')), 'table layout')
    def last_table_dropped(d):
        tables = ss._TBL.findall(d); return d.replace(tables[12], '', 1)
    refuse(rewrite_template(last_table_dropped), 'table layout')
    def drop_row(d):
        t = ss._TBL.findall(d)[8]; row = ss._ROW.findall(t)[2]; return d.replace(row, '', 1)
    refuse(rewrite_template(drop_row), 'table layout')
    # the marker is split across runs ('NOTAS', ' ', 'INTERNAS'): a raw-XML substring search would never find it, the paragraph text does
    assert 'NOTAS INTERNAS' not in package(TEMPLATE)['word/document.xml'].decode()
    # marker renamed: the pinned fingerprint no longer matches, and with re-pinned fingerprints the marker check still refuses
    renamed = rewrite_template(lambda d: d.replace('INTERNAS  (', 'PRIVADAS  ('))
    with pytest.raises(ss.TemplateMismatch):
        ss.render_docx(renamed, approved(), 'public', pin=pin(renamed))
    doc = package(TEMPLATE)['word/document.xml'].decode().replace('INTERNAS  (', 'PRIVADAS  (')
    moved = {**pin(renamed), 'tables': ss.table_fingerprints(doc)}
    with pytest.raises(ss.TemplateMismatch) as e:
        ss.render_docx(renamed, approved(), 'public', pin=moved)
    assert 'marker' in str(e.value)
    # nothing is written when the template is refused
    out = tmp_path / 'never.docx'
    bad = tmp_path / 'bad.docx'; bad.write_bytes(data[:-1] + b'\x01')
    with pytest.raises(ss.TemplateMismatch):
        ss.fill_docx(bad, approved(), 'public', out)
    assert not out.exists() and not list(tmp_path.glob('*.tmp'))


def test_t10_spanish_labels_remain_and_output_language_is_selected_by_pinned_template(tmp_path):
    text = doc_text(fill(tmp_path, approved(), 'internal'))
    for label in ('Cliente', 'Industria', 'Año', 'Duración', 'Nro. consultores', 'Rol principal', 'País', 'Tecnologías principales', 'Indicador', 'Antes',
                  'Después / Resultado', '¿Qué problema tenía el cliente?', '¿Qué hicimos?', '¿Cómo trabajamos con el cliente?',
                  '¿Qué puede hacer el cliente ahora que antes no podía?', '¿Qué valoró más el cliente?', 'Resumen:', 'Manager a cargo', 'Consultor', 'Fecha'):
        assert label in text, label
    assert 'Summary' not in text and 'Customer' not in text
    assert set(ss.TEMPLATES) == {'es'}
    with pytest.raises(ss.UnsupportedLanguage):
        ss.fill_docx(TEMPLATE, approved(), 'public', tmp_path / 'en.docx', language='en')
    assert not (tmp_path / 'en.docx').exists()


# ------------------------------------------------------------------ schema, policy, projection

def test_fixture_is_the_pack_sample_with_kpi_status_and_validates():
    sample = json.loads((PACK / '11_Plug_and_Play_Config' / 'sample_story_TEST_ONLY.json').read_text(encoding='utf-8'))
    fixed = copy.deepcopy(sample)
    for k in fixed['kpis']: k['status'] = 'measured'
    assert fixture() == fixed
    assert ss.validate(sample) != [] and ss.validate(fixture()) == []  # the pack's own sample lacked the required KPI status
    assert 'TEST' in FIXTURE.name


def test_unknown_top_level_keys_are_rejected_whatever_the_schema_says():
    s = fixture(); s['secret_margin'] = 0.4
    assert any('secret_margin' in e for e in ss.validate(s))
    loose = {'type': 'object', 'additionalProperties': True, 'properties': {k: {} for k in ss.load_schema()['properties']}}
    assert any('unknown top-level key' in e for e in ss.validate(s, loose))
    with pytest.raises(ss.StoryInvalid):
        ss.ensure_valid(s)
    with pytest.raises(ss.StoryInvalid):
        ss.fill_docx(TEMPLATE, {**approved(), 'extra': {}}, 'internal', '/nonexistent-dir-should-not-be-created/x.docx')
    assert not Path('/nonexistent-dir-should-not-be-created').exists()


def test_validate_covers_the_keywords_in_use():
    ok = fixture()
    assert ss.validate(ok) == [] and ss.validate([]) == ['story: expected object']
    def errs(path, value):
        s = fixture(); node = s; parts = path.split('.')
        for p in parts[:-1]: node = node[p]
        if value is Ellipsis: del node[parts[-1]]
        else: node[parts[-1]] = value
        return ss.validate(s)
    assert errs('project.year', '2026') and errs('project.year', True) and errs('project.year', 2026.0) == []  # type, bool is not an integer, 2026.0 is
    assert errs('project.country', Ellipsis) and errs('project', Ellipsis) and errs('approval_state.evidence_validated', 'yes')  # required, type
    assert errs('project.client_permission', 'public') and errs('project.client_permission', 'anonymize') == []  # enum
    assert errs('project.industry', None) == [] and errs('project.industry', 3)  # type list with null
    assert errs('kpis', [{'label': 'a', 'status': 'measured'}] * 4) and errs('kpis', [{'label': 'a', 'status': 'measured'}] * 3) == []  # maxItems
    assert errs('kpis', [{'label': 'a'}]) and errs('kpis', [{'label': 'a', 'status': 'great'}])  # items: required + enum
    assert errs('project.technologies', ['a', 3]) and errs('project.technologies', 'a')  # items type
    assert errs('amaris_differentiator.client_quote', None) == [] and errs('amaris_differentiator.client_quote', {'permission': 'true'})
    assert errs('kpis', [{'label': 'a', 'status': 'measured', 'after_value': [1]}])  # number|string|null


def test_policy_parser_reads_the_pack_yaml_and_matches_the_config():
    policy = ss.load_policy()
    text = ss.POLICY_PATH.read_text(encoding='utf-8')
    assert policy['version'] == '1.0' and policy['template'] == 'amaris_success_story_es'
    listed = [l.strip()[2:] for l in text.splitlines() if l.strip().startswith('- ')]
    cfg = ss.projection_config()
    assert cfg['public_fields'] + [] == listed  # every '- field' line of the YAML, in order, is a public field
    assert cfg['internal_fields'] == ['internal_notes.manager', 'internal_notes.consultant', 'internal_notes.date']
    assert policy['sections']['internal_only']['never_export_to'] == ['client_docx', 'spotlight_cms', 'public_pdf', 'external_presentation']
    assert policy['sections']['public_story']['requires'] == ['evidence_validated', 'exact_story_revision_approved', 'relevant_customer_and_confidentiality_permissions']
    assert cfg['gates']['client'] == ['evidence_validated', 'project_owner_approved', 'customer_approved', 'confidentiality_reviewed']
    assert cfg['gates']['public'] == cfg['gates']['client'] + ['brand_approved', 'public_release_authorized']
    for bad in ('a: {b: 1}', 'a:\n\tb: 1', 'a: |', '- x\ny: 1', 'a:\n  b: 1\n    c: 2'):
        with pytest.raises(ValueError):
            ss.parse_policy_yaml(bad)
    assert ss.parse_policy_yaml('# c\nk: "v"\nl: [a, "b"]\nn:\n  - x\n  - y\nm:\n  z: 1\n') == {'k': 'v', 'l': ['a', 'b'], 'n': ['x', 'y'], 'm': {'z': '1'}}
    unknown = copy.deepcopy(policy); unknown['sections']['public_story']['requires'].append('legal_signed_off')
    with pytest.raises(ValueError):
        ss.projection_config(unknown)  # a requirement this code cannot evaluate fails closed


def test_policy_and_constants_agree_with_the_schema():
    schema = ss.load_schema()
    def node(path):
        n = schema
        for part in path.split('.'): n = n['properties'][part]
        return n
    cfg = ss.projection_config()
    internal = ss.internal_only_paths(schema)
    for path in cfg['public_fields']:
        node(path); assert not any(path == i or path.startswith(i + '.') for i in internal), path
    for path in cfg['internal_fields']:
        node(path); assert any(path.startswith(i + '.') for i in internal), path
    assert set(ss.KPI_KEYS) == set(node('kpis')['items']['properties']) and set(ss.BEFORE_AFTER_KEYS) == set(node('results.before_after')['items']['properties'])
    assert set(ss.QUOTE_KEYS) | {'permission'} == set(node('amaris_differentiator.client_quote')['properties'])
    assert set(ss.KPI_STATUSES) <= set(node('kpis')['items']['properties']['status']['enum']) and ss.KPI_MAX == node('kpis')['maxItems']
    assert set(ss.REQUIREMENT_GATES['exact_story_revision_approved'] + ss.PUBLIC_EXTRA_GATES) <= set(node('approval_state')['properties'])
    assert set(ss.EDGE_CONSTANTS['STORY_PROJECTION']) == set(cfg)


@pytest.mark.parametrize('gate', ['evidence_validated', 'project_owner_approved', 'customer_approved', 'confidentiality_reviewed', 'brand_approved', 'public_release_authorized'])
def test_external_projection_needs_every_gate_exactly_true(gate):
    for audience in ('client', 'public'):
        needed = gate in ss.projection_config()['gates'][audience]
        for value in (False, None, 'true', 1, [True]):
            s = approved(); s['approval_state'][gate] = value
            if needed:
                with pytest.raises(ss.AudienceDenied) as e:
                    ss.project_for_audience(s, audience)
                assert e.value.missing == [gate]
            else:
                ss.project_for_audience(s, audience)
        s = approved(); s['approval_state'].pop(gate)
        assert (gate in ss.gate_failures(s, audience)) == needed
    s = approved(); s['approval_state'][gate] = False
    assert ss.project_for_audience(s, 'internal')  # internal needs no gate


def test_projection_refuses_unknown_audience_and_unreadable_story():
    for audience in ('board', '', None, 'PUBLIC'):
        with pytest.raises(ss.ProjectionError) as e: ss.project_for_audience(approved(), audience)
        assert e.value.code == 'audience'
    for story in ([], None, 'x', 3):
        with pytest.raises(ss.ProjectionError) as e: ss.project_for_audience(story, 'internal')
        assert e.value.code == 'story'
    assert ss.project_for_audience(fixture(), 'internal')['internal_notes'] == NOTES
    with pytest.raises(ss.AudienceDenied):
        ss.project_for_audience(fixture(), 'public')  # the pack sample is not approved
    s = approved(); del s['approval_state']
    with pytest.raises(ss.AudienceDenied):
        ss.project_for_audience(s, 'client')


def test_public_kpis_need_their_own_permission_and_client_kpis_do_not():
    mk = lambda perm: {'label': 'T', 'after_value': 1, 'status': 'measured', **({} if perm is None else {'public_permission': perm})}
    s = approved(kpis=[mk(False), mk(None), mk('yes'), mk(True)])
    assert len(ss.project_for_audience(s, 'public')['kpis']) == 1
    assert len(ss.project_for_audience(s, 'client')['kpis']) == 4 - 1  # capped at three
    assert len(ss.project_for_audience(s, 'internal')['kpis']) == 3


def test_client_name_needs_named_allowed_and_is_scrubbed_from_free_text(tmp_path):
    s = approved(); s['project']['client_display'] = 'Banco Ñandú'
    s['summary']['text'] = 'Trabajamos con banco ñandú y BANCO ÑANDÚ.'; s['amaris_differentiator']['client_valued'] = 'Banco Ñandú valoró la rapidez.'
    named = ss.project_for_audience(s, 'public')
    assert named['project']['client_display'] == 'Banco Ñandú' and named['summary']['text'] == s['summary']['text']
    for perm in ('anonymize', 'internal_only', 'unknown', None):
        t = copy.deepcopy(s); t['project']['client_permission'] = perm
        if perm is None: del t['project']['client_permission']
        for aud in ('client', 'public'):
            proj = ss.project_for_audience(t, aud)
            assert proj['project']['client_display'] == ss.ANONYMIZED_LABEL and 'ñandú' not in json.dumps(proj, ensure_ascii=False).lower()
            assert proj['summary']['text'] == 'Trabajamos con Cliente anonimizado y Cliente anonimizado.'
            assert 'ñandú' not in alltext(fill(tmp_path, t, aud)).lower()
        assert ss.project_for_audience(t, 'internal')['project']['client_display'] == 'Banco Ñandú'
    # short or missing names are not scrubbed (nothing sensible to match), but the label still replaces the field
    t = copy.deepcopy(s); t['project']['client_permission'] = 'anonymize'; t['project']['client_display'] = 'Ab'; t['summary']['text'] = 'Ab y ab'
    proj = ss.project_for_audience(t, 'public')
    assert proj['summary']['text'] == 'Ab y ab' and proj['project']['client_display'] == ss.ANONYMIZED_LABEL


def test_projection_keeps_only_allowlisted_nested_keys():
    s = approved()
    s['project']['secret_budget'] = 1; s['kpis'][0]['secret_margin'] = 2; s['results']['before_after'][0]['internal_cost'] = 3
    s['amaris_differentiator']['client_quote']['internal_flag'] = 4; s['unknown_top'] = {'x': 1}; s['summary']['evidence_refs'] = ['S1:D-001']
    s['internal_notes']['extra'] = 'x'
    text = json.dumps({a: ss.project_for_audience(s, a) for a in ('internal', 'client', 'public')})
    for leaked in ('secret_budget', 'secret_margin', 'internal_cost', 'internal_flag', 'unknown_top', 'evidence_refs', '"extra"', 'approval_state'):
        assert leaked not in text, leaked


# ------------------------------------------------------------------ rendering safety

def test_output_is_deterministic_well_formed_and_carries_no_template_author(tmp_path):
    a, b = fill(tmp_path, approved(), 'public', 'a.docx'), fill(tmp_path, approved(), 'public', 'b.docx')
    assert a.read_bytes() == b.read_bytes()
    parts = package(a)
    for name, blob in parts.items():
        if name.endswith(('.xml', '.rels')): ET.fromstring(blob)
    assert list(parts) == list(package(TEMPLATE)) and parts['word/media/image1.png'] == package(TEMPLATE)['word/media/image1.png']
    assert 'URREA' not in parts['docProps/core.xml'].decode() and 'lastModifiedBy>ATLAS<' in parts['docProps/core.xml'].decode()
    assert not list(tmp_path.glob('*.tmp'))


def test_values_with_markup_and_control_characters_stay_valid_xml(tmp_path):
    s = approved(); s['summary']['text'] = 'A <b>&</b> "x" \u0007 línea\nsegunda línea'
    s['solution']['technologies'] = ['C#', 'R&D <beta>']
    out = fill(tmp_path, s, 'public')
    text = doc_text(out)
    assert 'A <b>&</b> "x"  línea' in text and 'segunda línea' in text and 'R&D <beta>' in text
    assert 'Resumen:' in text


def test_many_result_rows_extend_the_table_and_extra_kinds_map_to_template_rows(tmp_path):
    s = approved(); s['results']['before_after'] = [{'indicator': f'Indicador {i}', 'before': i, 'after': i + 1, 'unit': 'u'} for i in range(5)] + \
        [{'indicator': 'Costo de soporte', 'before': '10 k', 'after': '8 k'}, {'indicator': 'Tiempo de ciclo', 'before': 5, 'after': 3, 'unit': 'd'}]
    text = doc_text(fill(tmp_path, s, 'public'))
    for i in range(5): assert f'Indicador {i}' in text and f'{i} u' in text
    assert 'Costo de soporte' in text and 'Tiempo de ciclo' in text and '3 d' in text


def test_leak_scan_blocks_a_regression_and_writes_nothing(tmp_path, monkeypatch):
    real_render, real_project = ss._render_document, ss.project_for_audience
    out = tmp_path / 'leak.docx'
    story = {**approved(), 'internal_notes': NOTES}
    # a renderer that forgot to drop the internal tables leaves the heading and labels behind
    monkeypatch.setattr(ss, '_render_document', lambda doc, projection, audience, pin: real_render(doc, projection, 'internal', pin))
    with pytest.raises(ss.RenderCheckFailed) as e:
        ss.fill_docx(TEMPLATE, story, 'public', out)
    assert 'internal_marker:NOTAS INTERNAS' in e.value.findings and not out.exists()
    # ... and a projection that forgot the allowlist leaks the values as well
    monkeypatch.setattr(ss, 'project_for_audience', lambda s, aud, policy=None: real_project(s, 'internal', policy))
    with pytest.raises(ss.RenderCheckFailed) as e:
        ss.fill_docx(TEMPLATE, story, 'client', out)
    assert {'internal_value:manager', 'internal_value:consultant', 'internal_value:date'} <= set(e.value.findings)
    assert NOTES['manager'] not in str(e.value) and not out.exists() and not list(tmp_path.glob('*.tmp'))


def test_leak_scan_reads_every_part_headers_footers_footnotes_and_properties():
    base = package(TEMPLATE)
    story = approved()
    def with_part(name, replace):
        parts = dict(base); parts[name] = replace(parts[name].decode()).encode()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as z:
            for n, b in parts.items(): z.writestr(n, b)
        return buf.getvalue()
    assert ss.scan_package(TEMPLATE.read_bytes(), {**story, 'internal_notes': NOTES}, 'public') == ['internal_marker:NOTAS INTERNAS', 'internal_marker:NO COMPARTIR CON CLIENTE', 'internal_marker:Manager a cargo'] + \
        [f'placeholder:{p}' for p in ss.PLACEHOLDERS if p in alltext_bytes(TEMPLATE.read_bytes())]
    for part, edit in (('word/header1.xml', lambda x: x.replace('</w:hdr>', '<w:p><w:r><w:t>MANAGER_INTERNAL_TEST</w:t></w:r></w:p></w:hdr>')),
                       ('word/footer1.xml', lambda x: x.replace('</w:ftr>', '<w:p><w:r><w:t>CONSULTANT_</w:t></w:r><w:r><w:t>INTERNAL_TEST</w:t></w:r></w:p></w:ftr>')),
                       ('word/footnotes.xml', lambda x: x.replace('</w:footnotes>', '<w:footnote><w:p><w:r><w:t>30/10/2026</w:t></w:r></w:p></w:footnote></w:footnotes>')),
                       ('docProps/core.xml', lambda x: x.replace('<dc:title></dc:title>', '<dc:title>Notas internas MANAGER_INTERNAL_TEST</dc:title>')),
                       ('docProps/app.xml', lambda x: x.replace('<Manager></Manager>', '<Manager>MANAGER_INTERNAL_TEST</Manager>'))):
        found = ss.scan_package(with_part(part, edit), {**story, 'internal_notes': NOTES}, 'public')
        assert any(f.startswith('internal_') and 'NOTAS INTERNAS' not in f for f in found), (part, found)
    # the same values are fine in an internal export, and a value that is only part of a longer word is not a leak
    assert not [f for f in ss.scan_package(with_part('word/footer1.xml', lambda x: x.replace('</w:ftr>', '<w:p><w:r><w:t>MANAGER_INTERNAL_TEST</w:t></w:r></w:p></w:ftr>')), {**story, 'internal_notes': NOTES}, 'internal') if f.startswith('internal_')]
    assert 'internal_value:manager' not in ss.scan_package(with_part('word/footer1.xml', lambda x: x.replace('</w:ftr>', '<w:p><w:r><w:t>XMANAGER_INTERNAL_TESTS</w:t></w:r></w:p></w:ftr>')), {**story, 'internal_notes': NOTES}, 'public')


def alltext_bytes(data):
    return '\n'.join(re.sub(r'<[^>]+>', ' ', b.decode('utf-8', 'replace')) for n, b in package_bytes(data).items() if n.endswith('.xml'))


def package_bytes(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z: return {n: z.read(n) for n in z.namelist()}


def test_post_render_scan_flags_anonymised_client_name_and_unpermitted_quote(tmp_path, monkeypatch):
    s = approved(); s['project']['client_permission'] = 'anonymize'
    real = ss.project_for_audience
    monkeypatch.setattr(ss, 'project_for_audience', lambda story, aud, policy=None: real({**story, 'project': {**story['project'], 'client_permission': 'named_allowed'}}, aud, policy))
    with pytest.raises(ss.RenderCheckFailed) as e:
        ss.fill_docx(TEMPLATE, s, 'public', tmp_path / 'x.docx')
    assert 'client_name_after_anonymisation' in e.value.findings
    monkeypatch.undo()
    q = approved(); q['amaris_differentiator']['client_quote']['permission'] = False
    q['summary']['text'] = q['amaris_differentiator']['client_quote']['exact_text']  # the unpermitted wording leaked into another field
    with pytest.raises(ss.RenderCheckFailed) as e:
        ss.fill_docx(TEMPLATE, q, 'public', tmp_path / 'y.docx')
    assert e.value.findings == ['unpermitted_quote'] and not (tmp_path / 'y.docx').exists()


def test_the_template_asset_and_cli(tmp_path):
    script = ROOT / 'scripts' / 'fill_success_story.py'
    story = tmp_path / 'story.json'; story.write_text(json.dumps(approved()), encoding='utf-8')
    run = lambda *a: subprocess.run([sys.executable, str(script), *map(str, a)], capture_output=True, text=True, cwd=tmp_path)
    r = run(TEMPLATE, story, tmp_path / 'sub' / 'pub.docx', '--audience', 'public')
    assert r.returncode == 0, r.stderr
    assert n_tables(tmp_path / 'sub' / 'pub.docx') == 11 and 'MANAGER_INTERNAL_TEST' not in alltext(tmp_path / 'sub' / 'pub.docx')
    r = run(TEMPLATE, story, tmp_path / 'int.docx')  # audience defaults to internal
    assert r.returncode == 0 and 'MANAGER_INTERNAL_TEST' in alltext(tmp_path / 'int.docx')
    unapproved = tmp_path / 'raw.json'; unapproved.write_text(FIXTURE.read_text(encoding='utf-8'), encoding='utf-8')
    r = run(TEMPLATE, unapproved, tmp_path / 'no.docx', '--audience', 'client')
    assert r.returncode == 2 and 'approval_state' in r.stderr and not (tmp_path / 'no.docx').exists()
    tampered = tmp_path / 'tpl.docx'; tampered.write_bytes(TEMPLATE.read_bytes()[:-1] + b'\x01')
    r = run(tampered, story, tmp_path / 'no2.docx', '--audience', 'public')
    assert r.returncode == 2 and 'template' in r.stderr.lower() and not (tmp_path / 'no2.docx').exists()
    assert 'MANAGER_INTERNAL_TEST' not in r.stdout + r.stderr
