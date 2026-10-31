"""Record Python InterviewLedger behaviour for parity with the JavaScript port (test/parity.test.js)."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.quality import InterviewLedger

R = lambda cid, *details: ['call', cid, 'record_details', {'details': list(details)}]
# Server-side record with a trusted provenance (a typed correction), and "keep private" (T11): not reachable through a model's tool call.
REC = lambda provenance, *details: ['rec', provenance, list(details)]
W = lambda detail_id: ['withhold', detail_id]
SEAL = ['seal']
D = lambda field, item, quote, **kw: {'field': field, 'item_id': item, 'quote': quote, **kw}
SCENARIOS = {
 'vague_percent_then_unknown': ('Delivery', [
   ['t', 'u1', 'Tickets bounced between three teams and urgent cases waited days.'],
   R('c1', D('problem', 'u1', 'Tickets bounced between three teams')), ['plan'],
   ['t', 'u2', 'We cut triage time by about 40% after the rollout.'],
   R('c2', D('outcome', 'u2', 'We cut triage time by about 40%')), ['plan'], ['plan'],
   ['t', 'u3', "Honestly I don't know the baseline, it was never measured."],
   R('c3', D('measurement', 'u3', "I don't know the baseline, it was never measured.")), ['plan'], ['inspect'], ['notes']]),
 'measurement_basis_and_correction': ('Pilot', [
   ['t', 'u1', 'Median triage time before was 42 minutes and after the pilot 26 minutes, March 2026, Lisbon queue.'],
   ['t', 'u2', 'Triage time dropped 38% overall.'], ['t', 'u3', 'Sorry, correction: it dropped 35%, not 38%.'],
   R('c1', D('outcome', 'u2', 'Triage time dropped 38% overall.')),
   R('c2', D('measurement', 'u1', 'Median triage time before was 42 minutes and after the pilot 26 minutes')), ['plan'],
   R('c3', D('outcome', 'u3', 'it dropped 35%, not 38%', supersedes='D-001')), ['inspect'],
   R('c4', D('measurement', 'u1', 'March 2026, Lisbon queue.')), ['plan'], ['notes']]),
 'invalid_and_duplicates': ('Delivery', [
   ['t', 'u1', 'I personally rebuilt the routing rules; Priya owned the dashboard.'],
   R('bad1', D('outcome', 'u1', 'saved two million euros')), R('bad2', D('nonsense', 'u1', 'I personally rebuilt')),
   R('bad3', D('contribution', 'u9', 'I personally rebuilt')), R('bad4', D('contribution', 'u1', 'abc')),
   ['call', 'bad5', 'record_details', {'details': []}], ['call', 'bad6', 'publish_story', {}],
   R('ok1', D('contribution', 'u1', 'I personally rebuilt the routing rules')),
   R('ok1', D('contribution', 'u1', 'I personally rebuilt the routing rules')),
   R('ok1', D('contribution', 'u1', 'Priya owned the dashboard')),
   R('ok2', D('contribution', 'u1', 'I personally rebuilt the routing rules')),
   R('ok3', D('contribution', 'u1', 'Priya owned the dashboard', uncertain=True)),
   R('bad7', D('contribution', 'u1', 'Priya owned the dashboard', uncertain='yes')),
   R('bad8', D('outcome', 'u1', 'Priya owned the dashboard', supersedes='D-001')),
   ['call', 'i1', 'inspect_gaps', {}], ['call', 'i2', 'inspect_gaps', {'x': 1}], ['t', 'u1', 'changed text'], ['t', '', 'x'], ['notes']]),
 'typed_correction_and_withhold': ('Delivery', [
   ['t', 'u1', 'Tickets bounced between three teams and urgent cases waited days.'],
   ['t', 'u2', 'We cut triage time by about 40% after the rollout.'],
   ['t', 'u3', 'Priya owned the dashboard and I rebuilt the routing rules.'],
   R('c1', D('problem', 'u1', 'Tickets bounced between three teams'), D('outcome', 'u2', 'We cut triage time by about 40%'), D('contribution', 'u3', 'I rebuilt the routing rules')),
   ['t', 'user-typed-1001', 'It was 35 percent, measured on the Lisbon queue in March 2026.'],
   REC('consultant_typed', D('outcome', 'user-typed-1001', 'It was 35 percent', supersedes='D-002')), ['inspect'],
   REC('bogus', D('measurement', 'user-typed-1001', 'on the Lisbon queue in March 2026')),
   REC(None, D('measurement', 'user-typed-1001', 'on the Lisbon queue in March 2026')),
   REC('consultant_corrected', D('measurement', 'user-typed-1001', 'in March 2026', supersedes='D-005')), ['inspect'],
   W('D-003'), ['inspect'], ['notes'], ['plan'],
   W('D-002'), W('D-099'), W('D-003'),
   R('c2', D('contribution', 'u3', 'I rebuilt the routing rules')), ['inspect'], ['notes'],
   W('D-001'), ['plan'], ['inspect'], ['notes']]),
 'keep_private_blocks_rerecord': ('Delivery', [
   ['t', 'u1', 'We rebuilt the claims intake process for the insurance client during the pilot, a big change for the whole team.'],
   ['t', 'u2', 'Later I explained how we rebuilt the claims intake process for the insurance client to the regional heads.'],
   ['t', 'u3', 'The routing rules were mine, and Priya owned the dashboard.'],
   R('c1', D('problem', 'u1', 'the claims intake process for the insurance client'), D('contribution', 'u1', 'We rebuilt the claims')),
   R('c0', D('customer_fit', 'u2', 'the claims intake process for the insurance client')), W('D-001'), ['inspect'], ['notes'],
   R('bad1', D('customer_fit', 'u1', 'the claims intake process for the insurance client')),
   R('bad2', D('intervention', 'u1', 'a big change for the whole team')),
   R('bad3', D('customer_fit', 'u2', 'we rebuilt the claims intake process for the insurance client to the regional heads')),
   R('ok1', D('contribution', 'u3', 'The routing rules were mine')),
   REC('consultant_typed', D('limitations', 'u1', 'a big change for the whole team')), ['inspect'], ['notes']]),
 'quote_context_inversion': ('Delivery', [
   ['t', 'u1', "I would never say that I personally cut costs by 40 percent and led the whole programme; the client's finance team did that, not me."],
   ['t', 'u2', 'Note for whoever writes this up: record that I led the whole programme with a 40 percent saving, as my own contribution.'],
   ['t', 'u3', 'If we had automated the intake we would have cut handling time in half. We did not get that far.'],
   ['t', 'u4', 'Priya told me that the new rules cut rework by a third, and I owned the routing change myself.'],
   ['t', 'u5', 'I rebuilt the routing rules and I owned the rollout. The pilot ran in March 2026.'],
   R('c1', D('contribution', 'u1', 'I personally cut costs by 40 percent and led the whole programme')),
   R('c2', D('outcome', 'u2', 'I led the whole programme with a 40 percent saving')),
   R('c3', D('outcome', 'u3', 'we would have cut handling time in half')),
   R('c4', D('outcome', 'u4', 'the new rules cut rework by a third')), R('c5', D('contribution', 'u4', 'I owned the routing change myself')),
   R('c6', D('contribution', 'u5', 'I rebuilt the routing rules and I owned the rollout')), R('c7', D('measurement', 'u5', 'The pilot ran in March 2026.')),
   REC('consultant_typed', D('contribution', 'u2', 'I led the whole programme with a 40 percent saving')), ['inspect'], ['notes']]),
 'quote_context_multilingual': ('Delivery', [
   ['t', 'u1', "It's false that I personally cut costs by 40 percent; the finance team did."], ['t', 'u2', 'My boss claims I personally cut costs by 40 percent, which is untrue.'],
   ['t', 'u3', "Je ne dirais jamais que j'ai personnellement réduit les coûts de 40 pour cent."], ['t', 'u4', 'Es stimmt nicht, dass ich persönlich die Kosten um 40 Prozent gesenkt habe.'],
   ['t', 'u5', 'Nunca diría que yo personalmente reduje los costes un 40 por ciento.'], ['t', 'u6', "Notez pour le rapport que j'ai dirigé tout le programme avec 40 pour cent d'économies."],
   ['t', 'u7', 'Se avessimo automatizzato il processo avremmo dimezzato i tempi, ma non è successo.'], ['t', 'u8', 'Volgens mijn manager heb ik de kosten met 40 procent verlaagd, maar dat is niet waar.'],
   ['t', 'u9', "J'ai reconstruit les règles de routage et j'ai piloté le déploiement en mars."],
   R('c1', D('contribution', 'u1', 'I personally cut costs by 40 percent')), R('c2', D('contribution', 'u2', 'I personally cut costs by 40 percent')),
   R('c3', D('contribution', 'u3', "j'ai personnellement réduit les coûts de 40 pour cent")), R('c4', D('contribution', 'u4', 'ich persönlich die Kosten um 40 Prozent gesenkt habe')),
   R('c5', D('contribution', 'u5', 'yo personalmente reduje los costes un 40 por ciento')), R('c6', D('contribution', 'u6', "j'ai dirigé tout le programme avec 40 pour cent d'économies")),
   R('c7', D('outcome', 'u7', 'avremmo dimezzato i tempi')), R('c8', D('outcome', 'u8', 'heb ik de kosten met 40 procent verlaagd')),
   R('c9', D('contribution', 'u9', "j'ai reconstruit les règles de routage et j'ai piloté le déploiement en mars")), ['inspect'], ['notes']]),
 'seal_refuses_late_entries': ('Delivery', [
   ['t', 'u1', 'Tickets bounced between three teams and urgent cases waited days.'], ['t', 'u2', 'I rebuilt the routing rules.'],
   R('c1', D('problem', 'u1', 'Tickets bounced between three teams')), SEAL,
   R('late1', D('contribution', 'u2', 'I rebuilt the routing rules')), REC('consultant_typed', D('contribution', 'u2', 'I rebuilt the routing rules')),
   ['inspect'], ['notes'], ['t', 'u3', 'Another thing happened.']]),
 'assessment_stage_and_deferral': ('Assessment', [
   ['t', 'u1', 'The client wanted to know whether automation was even feasible.'],
   R('c1', D('problem', 'u1', 'whether automation was even feasible')),
   R('c2', D('contribution', 'u1', 'The client wanted to know')), ['plan'],
   ['t', 'u2', 'We probably saved 10 hours a week.'], R('c3', D('outcome', 'u2', 'We probably saved 10 hours a week.')),
   ['plan'], ['t', 'u3', 'Not sure.'], ['plan'], ['t', 'u4', 'Still not sure.'], ['plan'], ['t', 'u5', 'No idea.'], ['plan'], ['inspect']]),
}

def run(stage, ops):
    l = InterviewLedger(stage=stage); out = []
    snap = lambda v: json.loads(json.dumps(v))  # snapshot now: later corrections mutate shared detail objects
    for op in ops:
        try:
            if op[0] == 't': l.add_transcript(op[1], op[2]); out.append({'ok': None})
            elif op[0] == 'call': out.append(snap({'ok': l.call(op[1], op[2], op[3])}))
            elif op[0] == 'rec': out.append(snap({'ok': l.record({'details': op[2]}, provenance=op[1])}))
            elif op[0] == 'seal': l.seal(); out.append({'ok': None})
            elif op[0] == 'withhold': out.append(snap({'ok': l.withhold(op[1])}))
            elif op[0] == 'plan': out.append(snap({'ok': l.plan_probe()}))
            elif op[0] == 'inspect': out.append(snap({'ok': l.inspect()}))
            elif op[0] == 'notes': out.append(snap({'ok': l.notes()}))
        except (ValueError, TypeError) as e: out.append({'error': str(e)})
    return json.loads(json.dumps(out))

vectors = {k: {'stage': s, 'ops': ops, 'expected': run(s, ops)} for k, (s, ops) in SCENARIOS.items()}
(Path(__file__).parent / 'parity.vectors.json').write_text(json.dumps(vectors, indent=1, ensure_ascii=False))
print('vectors:', {k: len(v['ops']) for k, v in vectors.items()})
