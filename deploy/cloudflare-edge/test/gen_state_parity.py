"""Record the Python conversation state machines (atlas_voice/conversation_state.py) for the JS parity test.
Cases are event sequences with the outcome of every step (new state and status, or the error code) and the final snapshot;
errors do not stop a sequence, so each one also proves the machine was left unchanged. `matrix` fires every event from every
reachable machine position (`positions`: the shortest path to each), with its legitimate actor and then with ones that are not
allowed; `restore` replays snapshots, good and tampered."""
import copy, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.conversation_state import EVENTS, MACHINES, STATES, TRANSITIONS, Machine, StateError, WORKFLOW_VERSION

def at(i): return f'2026-11-01T10:00:{i % 60:02d}.{i // 60:03d}Z'
def data_for(spec, field='metric'): return None if spec['data'] is None else {spec['data']['key']: spec['data']['values'][3] if spec['data']['values'] else field}
def good(kind, event):
    spec = EVENTS[kind][event]
    return [event, spec['actors'][0], 'because' if spec['reason'] else None, data_for(spec)]

def run(kind, steps):
    m, results = Machine(kind), []
    for i, (event, actor, reason, data) in enumerate(steps):
        try: m.fire(event, actor, reason, at(i), data); results.append({'ok': True, 'state': m.state, 'status': m.status})
        except StateError as e: results.append({'error': e.code})
    return {'kind': kind, 'steps': [[e, a, r, at(i), d] for i, (e, a, r, d) in enumerate(steps)], 'results': results, 'final': m.to_dict(),
            'terminal': m.terminal, 'available': m.available_events()}

def S(kind, *names): return [good(kind, n) for n in names]
def step(kind, event, actor=None, reason=None, data=None):
    spec = EVENTS[kind][event] if event in EVENTS[kind] else None
    return [event, actor or (spec['actors'][0] if spec else 'user'), reason, data]

CASES = {
    'interview_happy': run('interview', S('interview', 'start', 'consent_given', 'focus', 'skip', 'request_summary', 'correct', 'correct', 'request_summary', 'confirm_summary')),
    'interview_free_focus': run('interview', [step('interview', 'start'), step('interview', 'consent_given')] +
        [step('interview', 'focus', 'atlas', data={'focus': f}) for f in ('outcome', 'context', 'skills', 'evidence', 'contribution', 'outcome')] +
        [step('interview', 'focus', 'user', data={'focus': 'people'}), step('interview', 'focus', 'user', data={'focus': 'skills', 'x': 1}), step('interview', 'focus', 'user'),
         step('interview', 'focus', 'user', data='skills'), step('interview', 'skip', 'user', data={'field': 'Bad Field'}), step('interview', 'skip', 'user', data={'field': 'metric'}),
         step('interview', 'skip', 'user', data={'field': 'metric'}), step('interview', 'skip', 'user', data={'field': 'baseline'}), step('interview', 'skip', 'atlas', data={'field': 'x'}),
         step('interview', 'request_summary', 'atlas'), step('interview', 'focus', 'user', data={'focus': 'skills'})]),
    'pause_returns_to_prior': run('interview', S('interview', 'start', 'consent_given') + [step('interview', 'focus', 'user', data={'focus': 'evidence'})] + S('interview', 'pause', 'resume', 'request_summary', 'pause', 'resume', 'correct', 'pause', 'resume')),
    'pause_in_welcome_and_permissions': run('interview', S('interview', 'pause', 'resume', 'start', 'pause', 'resume', 'consent_given')),
    'nested_pause_disconnect': run('interview', S('interview', 'start', 'consent_given', 'pause', 'disconnect', 'reconnect', 'resume', 'disconnect', 'reconnect', 'pause', 'disconnect', 'ttl_expired')),
    'disconnect_ttl': run('interview', S('interview', 'start', 'consent_given', 'disconnect', 'ttl_expired', 'reconnect', 'resume')),
    'withdraw_from_suspended': run('interview', S('interview', 'start', 'disconnect', 'withdraw', 'start')),
    'interview_errors': run('interview', [step('interview', 'submit'), step('interview', 'approve', 'reviewer'), step('interview', 'consent_given'), step('interview', 'start', 'reviewer'), step('interview', 'start', 'atlas'),
        step('interview', 'consent_given', 'atlas'), step('interview', 'withdraw', 'user'), step('interview', 'withdraw', 'user', '   '), step('interview', 'withdraw', 'user', 5), step('interview', 'resume'),
        step('interview', 'reconnect', 'system'), step('interview', 'ttl_expired', 'system'), step('interview', '__proto__', 'user'), step('interview', 'pause', 5), step('interview', None, 'user')]),
    'withdraw_reason_trimmed': run('interview', [step('interview', 'start'), step('interview', 'withdraw', 'user', '  changed my mind \n')]),
    'evidence_approved': run('evidence', S('evidence', 'submit', 'enqueue', 'approve', 'propose_downstream')),
    'evidence_clarify_loop': run('evidence', S('evidence', 'submit', 'enqueue', 'request_clarification', 'revise', 'submit', 'enqueue', 'approve')),
    'evidence_rejected_branches': run('evidence', S('evidence', 'submit', 'enqueue', 'reject', 'request_clarification', 'revise', 'submit', 'enqueue', 'reject', 'dispute', 'reopen_review', 'reject', 'close_rejected')),
    'evidence_disputed_paths': run('evidence', S('evidence', 'submit', 'enqueue', 'reject', 'dispute', 'request_clarification', 'revise')),
    'evidence_dispute_closed': run('evidence', S('evidence', 'submit', 'enqueue', 'reject', 'dispute', 'close_rejected')),
    'evidence_withdraw_after_approval': run('evidence', S('evidence', 'submit', 'enqueue', 'approve', 'withdraw', 'complete_impact_review')),
    'evidence_withdraw_after_downstream': run('evidence', S('evidence', 'submit', 'enqueue', 'approve', 'propose_downstream', 'withdraw', 'complete_impact_review')),
    'evidence_withdraw_before_approval': run('evidence', S('evidence', 'withdraw')),
    'evidence_errors': run('evidence', [step('evidence', 'enqueue'), step('evidence', 'approve', 'reviewer'), step('evidence', 'submit', 'reviewer'), step('evidence', 'submit', 'atlas'), step('evidence', 'submit'), step('evidence', 'enqueue', 'system'),
        step('evidence', 'approve', 'user'), step('evidence', 'reject', 'reviewer'), step('evidence', 'reject', 'reviewer', ''), step('evidence', 'reject', 'reviewer', 'no source for the metric'), step('evidence', 'approve', 'reviewer'),
        step('evidence', 'close_rejected', 'reviewer'), step('evidence', 'dispute', 'user'), step('evidence', 'withdraw', 'atlas', 'x'), step('evidence', 'start', 'user'), step('evidence', 'close_rejected', 'user', 'accepted')]),
}

# Every event from every machine position (state + remembered states), legitimate actor then a wrong one, reason and data variations.
def positions(kind):
    seen, queue, out = {}, [[]], []
    while queue:
        path = queue.pop(0); m = Machine(kind)
        for event, actor, reason, data in path: m.fire(event, actor, reason, at(0), data)
        key = (m.state, tuple(m.returns), m.focus)
        if key in seen: continue
        seen[key] = path; out.append(path)
        for event in m.available_events(): queue.append(path + [good(kind, event)])
        if kind == 'interview' and m.state == 'discovery' and m.focus == 'context': queue.append(path + [['focus', 'user', None, {'focus': 'skills'}]])
    return out

POSITIONS = {kind: positions(kind) for kind in MACHINES}
MATRIX = []
for kind in MACHINES:
    for index, path in enumerate(POSITIONS[kind]):
        base = Machine(kind)
        for i, (event, actor, reason, data) in enumerate(path): base.fire(event, actor, reason, at(i), data)
        for event, spec in EVENTS[kind].items():
            good_step = good(kind, event)
            variants = [good_step, [event, 'nobody', good_step[2], good_step[3]], [event, 'atlas' if 'atlas' not in spec['actors'] else 'reviewer' if 'reviewer' not in spec['actors'] else 'system', good_step[2], good_step[3]]]
            if spec['reason']: variants.append([event, good_step[1], None, good_step[3]])
            if spec['data']: variants.append([event, good_step[1], good_step[2], None])
            for v in variants:
                m = Machine.from_dict(base.to_dict())
                try: m.fire(v[0], v[1], v[2], at(len(path)), v[3]); result = {'state': m.state, 'focus': m.focus, 'returns': m.returns, 'skipped': m.skipped, 'status': m.status, 'audit': len(m.audit)}
                except StateError as e: result = {'error': e.code}
                MATRIX.append([kind, index, [v[0], v[1], v[2], at(len(path)), v[3]], result])

def tamper(d, fn): d = copy.deepcopy(d); fn(d); return d
def snapshot(kind, *names): return run(kind, S(kind, *names))['final']
def restore(name, d):
    try: return {'name': name, 'dict': d, 'result': {'ok': True, 'dict': Machine.from_dict(d).to_dict()}}
    except StateError as e: return {'name': name, 'dict': d, 'result': {'error': e.code}}
a, b = snapshot('interview', 'start', 'consent_given', 'pause', 'disconnect'), snapshot('evidence', 'submit', 'enqueue', 'approve', 'withdraw')
RESTORE = [restore('interview_suspended_over_paused', a), restore('evidence_impact_review', b), restore('fresh_interview', Machine('interview').to_dict()), restore('fresh_evidence', Machine('evidence').to_dict()),
    restore('terminal_interview', snapshot('interview', 'start', 'consent_given', 'request_summary', 'confirm_summary')),
    restore('other_version', tamper(a, lambda d: d.update(workflow_version='atlas-conversation-2.0.0'))),
    restore('no_version', tamper(a, lambda d: d.pop('workflow_version'))),
    restore('wrong_state', tamper(a, lambda d: d.update(state='discovery'))), restore('wrong_returns', tamper(a, lambda d: d.update(returns=[]))),
    restore('wrong_focus', tamper(a, lambda d: d.update(focus='skills'))), restore('wrong_skipped', tamper(a, lambda d: d.update(skipped=['x']))),
    restore('extra_key', tamper(a, lambda d: d.update(extra=1))), restore('missing_key', tamper(a, lambda d: d.pop('skipped'))),
    restore('truncated_audit_keeps_state', tamper(a, lambda d: d['audit'].pop())),
    restore('missing_first_entry', tamper(a, lambda d: d['audit'].pop(0))),
    restore('illegal_audit_event', tamper(b, lambda d: d['audit'][1].update(event='approve'))),
    restore('audit_actor_not_allowed', tamper(b, lambda d: d['audit'][2].update(actor='user'))),
    restore('audit_edited_time', tamper(b, lambda d: d['audit'][0].update(at=''))),
    restore('audit_edited_reason', tamper(b, lambda d: d['audit'][3].update(reason=None))),
    restore('audit_extra_key', tamper(b, lambda d: d['audit'][0].update(note='x'))),
    restore('audit_not_object', tamper(b, lambda d: d['audit'].append('x'))), restore('audit_not_list', tamper(b, lambda d: d.update(audit={}))),
    restore('unknown_kind', tamper(a, lambda d: d.update(kind='review'))), restore('not_a_dict', []), restore('none', None)]

out = {'workflow_version': WORKFLOW_VERSION, 'cases': CASES, 'positions': {k: [[[e, a, r, at(i), d] for i, (e, a, r, d) in enumerate(p)] for p in v] for k, v in POSITIONS.items()}, 'matrix': MATRIX, 'restore': RESTORE,
       'tables': {k: {'states': len(STATES[k]['states']), 'transitions': len(TRANSITIONS[k])} for k in MACHINES}}
(Path(__file__).parent / 'state.vectors.json').write_text(json.dumps(out))
print({'cases': len(CASES), 'matrix': len(MATRIX), 'restore': len(RESTORE)})
