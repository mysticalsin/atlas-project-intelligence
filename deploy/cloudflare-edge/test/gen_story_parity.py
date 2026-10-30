"""Record atlas_voice.success_story.project_for_audience for the JS parity test (test/story-projection.test.js).
Stdlib only:  python3 deploy/cloudflare-edge/test/gen_story_parity.py
"""
import copy, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.success_story import project_for_audience, ProjectionError, AudienceDenied  # noqa: E402

BASE = json.loads((ROOT / 'tests' / 'fixtures' / 'success_story_TEST_ONLY.json').read_text(encoding='utf-8'))
APPROVED = {'evidence_validated': True, 'project_owner_approved': True, 'customer_approved': True, 'confidentiality_reviewed': True,
            'brand_approved': True, 'public_release_authorized': True}
QUOTE = {'exact_text': 'Nos cambió la forma de trabajar.', 'speaker': 'Persona Test', 'title': 'Directora de Datos', 'company': 'Banco Ñandú',
         'source_ref': 'S1:D-004', 'permission': True}

def story(**changes):
    s = copy.deepcopy(BASE); s['approval_state'] = dict(APPROVED)
    s['project']['client_display'] = 'Banco Ñandú'; s['project']['client_permission'] = 'named_allowed'
    s['kpis'] = [{'label': 'Tiempo', 'before_value': 48, 'after_value': 4, 'unit': 'h', 'period': 'Q1-Q2 2026', 'method': 'Medición de tickets',
                  'source_refs': ['S1:D-002'], 'attribution': 'equipo', 'status': 'measured', 'public_permission': True}]
    s['amaris_differentiator']['client_quote'] = dict(QUOTE)
    for path, value in changes.items():
        node = s; parts = path.split('__')
        for part in parts[:-1]: node = node[part]
        if value is Ellipsis: node.pop(parts[-1], None)
        else: node[parts[-1]] = value
    return s

def kpi(i, status='measured', perm=True, **more):
    return {'label': f'KPI {i}', 'after_value': i, 'unit': '%', 'status': status, 'public_permission': perm, **more}

CASES = []
def add(s, audience): CASES.append([s, audience])

for aud in ('internal', 'client', 'public'):
    add(story(), aud)
    add(BASE, aud)  # the pack sample: no approvals, quote not permitted, no client_permission
add({'approval_state': {'evidence_validated': True}}, 'internal')  # minimal record
add({}, 'internal')
add(story(), 'board'); add(story(), ''); add(story(), None)
for bad in ([], None, 'story', 7): add(bad, 'internal'); add(bad, 'public')
# Every gate on its own, and values that are truthy but not exactly true.
for aud in ('client', 'public'):
    for gate in APPROVED:
        s = story(); s['approval_state'][gate] = False; add(s, aud)
        s = story(); s['approval_state'].pop(gate); add(s, aud)
        s = story(); s['approval_state'][gate] = 'true'; add(s, aud)
        s = story(); s['approval_state'][gate] = 1; add(s, aud)
    s = story(); s['approval_state'] = None; add(s, aud)
    s = story(); del s['approval_state']; add(s, aud)
s = story(); s['approval_state'] = {'evidence_validated': True, 'project_owner_approved': True, 'customer_approved': True, 'confidentiality_reviewed': True}; add(s, 'client'); add(s, 'public')
# KPIs: cap at three, unsupported statuses and blank labels never take a slot, public needs per-KPI permission.
s = story(kpis=[kpi(i) for i in range(1, 6)]); [add(s, a) for a in ('internal', 'client', 'public')]
s = story(kpis=[kpi(1, 'unverified'), kpi(2, 'omitted'), kpi(3, 'estimated'), kpi(4, 'qualitative'), kpi(5), kpi(6), kpi(7)]); [add(s, a) for a in ('internal', 'client', 'public')]
s = story(kpis=[kpi(1, perm=False), kpi(2, perm='yes'), {'label': 'Sin permiso', 'status': 'measured'}, kpi(4), kpi(5, status='measured', after_value=None, unit=None)]); [add(s, a) for a in ('client', 'public')]
s = story(kpis=[{'label': '  ', 'status': 'measured'}, {'label': None, 'status': 'measured'}, {'status': 'measured'}, 'text', None, 3, [], kpi(1)]); [add(s, a) for a in ('internal', 'public')]
for odd in ([], None, 'kpis', {'label': 'x', 'status': 'measured'}): add(story(kpis=odd), 'public')
s = story(kpis=[{**kpi(1), 'secret_margin': 0.42, 'source_refs': ['a', 'b'], 'period': None}]); add(s, 'public')
# Quote: only exact permission === true with text and source.
for q in ({**QUOTE, 'permission': False}, {**QUOTE, 'permission': 'true'}, {**QUOTE, 'permission': 1}, {k: v for k, v in QUOTE.items() if k != 'permission'},
          {**QUOTE, 'source_ref': None}, {**QUOTE, 'source_ref': '  '}, {k: v for k, v in QUOTE.items() if k != 'source_ref'},
          {**QUOTE, 'exact_text': ''}, {**QUOTE, 'exact_text': None}, {**QUOTE, 'extra': 'x'}, None, 'texto', []):
    for aud in ('internal', 'public'): add(story(amaris_differentiator__client_quote=q), aud)
add(story(amaris_differentiator__client_quote=Ellipsis), 'public')
add(story(amaris_differentiator=None), 'public')
# Client naming and anonymisation (also inside free text; a verbatim quote that names the client is dropped, never edited).
for perm in ('anonymize', 'internal_only', 'unknown', 'Named_Allowed', None, 7, Ellipsis):
    for aud in ('internal', 'client', 'public'): add(story(project__client_permission=perm), aud)
anon = story(project__client_permission='anonymize', summary__text='Trabajamos con banco ñandú y con BANCO ÑANDÚ en dos fases.',
             challenge__problem='Banco Ñandú tenía un proceso manual.', solution__technologies=['Python', 'banco ñandú API'],
             results__new_capability='Ahora Banco Ñandú decide el mismo día.')
for aud in ('internal', 'client', 'public'): add(anon, aud)
add({**anon, 'amaris_differentiator': {**anon['amaris_differentiator'], 'client_quote': {**QUOTE, 'exact_text': 'En Banco Ñandú todo cambió.'}}}, 'public')
for name in ('Ab', '   ', '', None, 12, 'A.B', 'a+b*c', 'Rojo (S.A.)'):
    add(story(project__client_permission='unknown', project__client_display=name, summary__text='Texto con A.B y a+b*c y Rojo (S.A.) y Ab.'), 'public')
add(story(project__client_permission='unknown', project__client_display=Ellipsis), 'public')
add(story(project=Ellipsis), 'public'); add(story(project=None), 'public'); add(story(project='x'), 'internal')
# Results table, nested unknown keys, unknown top-level keys and internal notes.
add(story(results__before_after=[{'indicator': 'Tiempo', 'before': 1, 'after': 2, 'unit': 'h', 'source_refs': ['a'], 'internal_cost': 9}, 'x', None, {'indicator': 'Errores'}]), 'public')
add(story(results__before_after=None), 'public'); add(story(results__before_after='x'), 'public'); add(story(results=Ellipsis), 'public')
s = story(); s['project']['secret_budget'] = 123; s['summary']['evidence_refs'] = ['S1:D-001']; s['unknown_top'] = {'internal_notes': {'manager': 'X'}}
s['internal_notes']['extra'] = 'no'; s['project']['client_permission'] = 'named_allowed'; [add(s, a) for a in ('internal', 'client', 'public')]
add(story(internal_notes=Ellipsis), 'internal'); add(story(internal_notes=None), 'internal'); add(story(internal_notes={'manager': 'M'}), 'internal'); add(story(internal_notes='texto'), 'internal')
add(story(project__technologies=['Python', 3, None], solution__technologies='texto', challenge__why_important=None), 'public')
add(story(summary__text='Resumen con "comillas" y\nsalto y emoji 🙂'), 'public')

def run(s, audience):
    try: return {'ok': project_for_audience(s, audience)}
    except AudienceDenied as e: return {'error': e.code, 'missing': e.missing}
    except ProjectionError as e: return {'error': e.code}

out = [[c[0], c[1], run(*c)] for c in CASES]
(Path(__file__).parent / 'story.vectors.json').write_text(json.dumps(out))
kinds = {}
for _, _, r in out: kinds[r.get('error', 'ok')] = kinds.get(r.get('error', 'ok'), 0) + 1
print(len(out), kinds)
