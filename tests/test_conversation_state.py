"""Conversation state machines (v2.1 T8, plan §3i, D8-D11, D19). Pure logic, synthetic inputs only."""
import json
import pytest
from atlas_voice import conversation_state as cs
from atlas_voice.conversation_state import (CANONICAL_STATUSES, EDGE_CONSTANTS, EVENTS, EXTENSION_STATUSES, FOCUS_AREAS, RETURN, STATES, STATUS,
                                            TRANSITIONS, WORKFLOW_VERSION, Machine, StateError)

AT = '2026-11-01T10:00:00.000Z'


def interview(*steps):
    m = Machine('interview')
    for step in steps:
        event, actor, *rest = step
        m.fire(event, actor, **(rest[0] if rest else {}))
    return m


def code(machine, *args, **kw):
    with pytest.raises(StateError) as err:
        machine.fire(*args, **kw)
    return err.value.code


def at_state(kind, target):
    """Shortest legitimate path to `target`: breadth-first over the table with each event's first allowed actor."""
    seen, queue = {}, [Machine(kind)]
    while queue:
        m = queue.pop(0)
        if m.state == target:
            return m
        for event in m.available_events():
            spec = EVENTS[kind][event]
            n = Machine.from_dict(m.to_dict())
            n.fire(event, spec['actors'][0], reason='because' if spec['reason'] else None, data=None if not spec['data'] else
                   {spec['data']['key']: (spec['data']['values'] or ['metric'])[0]})
            key = (n.state, tuple(n.returns))
            if key not in seen:
                seen[key] = True
                queue.append(n)
    raise AssertionError(f'{kind}: {target} is unreachable')


# ---- the table itself ----
def test_version_and_machines():
    assert WORKFLOW_VERSION == 'atlas-conversation-2.1.0'
    assert FOCUS_AREAS == ['context', 'contribution', 'evidence', 'outcome', 'skills']
    assert STATES['interview']['states'] == ['welcome', 'purpose_permissions', 'discovery', 'summary', 'user_correction', 'summary_confirmed',
                                              'paused', 'suspended', 'withdrawn', 'abandoned']
    assert set(STATES['evidence']['states']) == {'evidence_draft', 'submitted_for_review', 'reviewer_queue', 'needs_clarification', 'approved', 'rejected',
                                                  'disputed', 'closed_rejected', 'downstream_proposals', 'impact_review', 'withdrawn'}


@pytest.mark.parametrize('kind', cs.MACHINES)
def test_table_is_well_formed(kind):
    states, events = set(STATES[kind]['states']), EVENTS[kind]
    assert len(states) == len(STATES[kind]['states']) and STATES[kind]['initial'] in states and set(STATES[kind]['terminal']) <= states
    seen = set()
    for event, src, dst in TRANSITIONS[kind]:
        assert event in events and src in states and (dst in states or dst == RETURN)
        assert (event, src) not in seen, 'one target per event and state'
        seen.add((event, src))
        assert src not in STATES[kind]['terminal'], f'{src} is terminal but has {event}'
    assert {e for e, _, _ in TRANSITIONS[kind]} == set(events), 'every event is used, and only those'
    for spec in events.values():
        assert spec['actors'] and set(spec['actors']) <= {'user', 'atlas', 'system', 'reviewer'}
    for state in states:  # every state can be reached
        assert at_state(kind, state).state == state


def test_the_agent_can_steer_but_never_decide():
    atlas = {e for kind in cs.MACHINES for e, s in EVENTS[kind].items() if 'atlas' in s['actors']}
    assert atlas == {'start', 'focus', 'request_summary', 'continue_discovery'}
    for gate in ('consent_given', 'confirm_summary', 'correct', 'skip', 'withdraw'):
        assert EVENTS['interview'][gate]['actors'] == ['user']
    assert EVENTS['evidence']['submit']['actors'] == ['user'] and EVENTS['evidence']['approve']['actors'] == ['reviewer']
    assert all('atlas' not in s['actors'] for s in EVENTS['evidence'].values())


def test_status_maps_to_the_canonical_statuses():
    for kind in cs.MACHINES:
        assert set(STATUS[kind]) == set(STATES[kind]['states']) - set(STATES[kind]['transient'])
        assert set(STATUS[kind].values()) <= set(CANONICAL_STATUSES) | set(EXTENSION_STATUSES)
    assert len(CANONICAL_STATUSES) == 21 and STATUS['interview']['summary_confirmed'] == 'evidence_draft'
    assert STATUS['interview']['welcome'] == 'identified' and STATUS['interview']['discovery'] == 'interview_in_progress'
    assert STATUS['evidence']['approved'] == 'evidence_approved' and STATUS['evidence']['downstream_proposals'] == 'projection_pending'


def test_edge_constants_are_json_and_complete():
    assert json.loads(json.dumps(EDGE_CONSTANTS)) == EDGE_CONSTANTS
    assert set(EDGE_CONSTANTS) == {'CONVERSATION_WORKFLOW_VERSION', 'CONVERSATION_FOCUS', 'CONVERSATION_STATES', 'CONVERSATION_EVENTS',
                                   'CONVERSATION_TRANSITIONS', 'CONVERSATION_STATUS'}


# ---- every edge of the pack's diagram (04_Workflows/ATLAS_Conversation_State_Machine.md), as this implementation spells it ----
PACK_EDGES = [  # (machine, state before, event, actor, state after)
    ('interview', 'welcome', 'start', 'atlas', 'purpose_permissions'),                       # Welcome --> PurposeAndPermissions
    ('interview', 'purpose_permissions', 'consent_given', 'user', 'discovery'),              # --> ContextDiscovery (and the rest of discovery, below)
    ('interview', 'discovery', 'focus', 'atlas', 'discovery'),                               # Context --> Contribution --> Evidence --> Outcome --> Skills
    ('interview', 'discovery', 'request_summary', 'atlas', 'summary'),                       # SkillsAndLearning --> Summary
    ('interview', 'summary', 'correct', 'user', 'user_correction'),                          # Summary --> UserCorrection
    ('interview', 'user_correction', 'request_summary', 'atlas', 'summary'),                 # UserCorrection --> Summary: corrections
    ('interview', 'user_correction', 'confirm_summary', 'user', 'summary_confirmed'),        # UserCorrection --> Submitted: confirm (becomes evidence_draft, D19)
    ('evidence', 'evidence_draft', 'submit', 'user', 'submitted_for_review'),                # ... Submitted, only by the explicit click (Q2)
    ('evidence', 'submitted_for_review', 'enqueue', 'system', 'reviewer_queue'),             # Submitted --> ReviewerQueue
    ('evidence', 'reviewer_queue', 'request_clarification', 'reviewer', 'needs_clarification'),  # ReviewerQueue --> NeedsClarification
    ('evidence', 'needs_clarification', 'revise', 'user', 'evidence_draft'),                 # NeedsClarification --> back to capture
    ('evidence', 'reviewer_queue', 'approve', 'reviewer', 'approved'),                       # ReviewerQueue --> Approved
    ('evidence', 'reviewer_queue', 'reject', 'reviewer', 'rejected'),                        # ReviewerQueue --> Rejected
    ('evidence', 'approved', 'propose_downstream', 'system', 'downstream_proposals'),        # Approved --> DownstreamProposals
]
D_EDGES = [  # D9-D11
    ('interview', 'discovery', 'pause', 'user', 'paused'), ('interview', 'suspended', 'ttl_expired', 'system', 'abandoned'),
    ('interview', 'discovery', 'disconnect', 'system', 'suspended'), ('interview', 'discovery', 'withdraw', 'user', 'withdrawn'),
    ('evidence', 'rejected', 'request_clarification', 'reviewer', 'needs_clarification'), ('evidence', 'rejected', 'dispute', 'user', 'disputed'),
    ('evidence', 'rejected', 'close_rejected', 'reviewer', 'closed_rejected'), ('evidence', 'approved', 'withdraw', 'user', 'impact_review'),
    ('evidence', 'downstream_proposals', 'withdraw', 'user', 'impact_review'), ('evidence', 'impact_review', 'complete_impact_review', 'reviewer', 'withdrawn'),
]


@pytest.mark.parametrize('kind,before,event,actor,after', PACK_EDGES + D_EDGES)
def test_every_pack_edge_is_legal(kind, before, event, actor, after):
    m = at_state(kind, before)
    spec = EVENTS[kind][event]
    data = {spec['data']['key']: (spec['data']['values'] or ['metric'])[0]} if spec['data'] else None
    assert m.fire(event, actor, reason='because' if spec['reason'] else None, at=AT, data=data) == after == m.state


def test_all_five_discovery_areas_are_reachable_in_any_order_and_audited_as_focus_events():
    m = interview(('start', 'atlas'), ('consent_given', 'user'))
    for area in ('outcome', 'context', 'skills', 'evidence', 'contribution', 'context'):
        assert m.fire('focus', 'atlas', data={'focus': area}) == 'discovery' and m.focus == area
    focus = [e for e in m.audit if e['event'] == 'focus']
    assert [e['data']['focus'] for e in focus] == ['outcome', 'context', 'skills', 'evidence', 'contribution', 'context']
    assert all(e['from'] == e['to'] == 'discovery' and e['actor'] == 'atlas' for e in focus)
    assert code(m, 'focus', 'user', data={'focus': 'people'}) == 'bad_data'  # no person-assessment areas
    assert code(m, 'focus', 'user') == 'bad_data' and code(m, 'focus', 'user', data={'focus': 'skills', 'x': 1}) == 'bad_data'
    assert code(m, 'focus', 'user', data='skills') == 'bad_data'


def test_skip_is_an_event_and_the_field_is_recorded_as_skipped_by_the_user():
    m = interview(('start', 'atlas'), ('consent_given', 'user'))
    m.fire('skip', 'user', data={'field': 'metric_baseline'})
    m.fire('skip', 'user', data={'field': 'metric_baseline'})
    assert m.skipped == ['metric_baseline'] and m.audit[-1]['data'] == {'field': 'metric_baseline'}
    assert code(m, 'skip', 'atlas', data={'field': 'metric'}) == 'actor_not_allowed'  # the agent cannot skip for the user
    assert code(m, 'skip', 'user', data={'field': 'Free text with spaces'}) == 'bad_data'
    assert code(m, 'skip', 'user') == 'bad_data'


# ---- illegal moves ----
def test_illegal_moves_raise_and_change_nothing():
    m = Machine('interview')
    before = m.to_dict()
    assert code(m, 'submit', 'user') == 'unknown_event'          # welcome -> submitted: the interview has no submit
    assert code(m, 'confirm_summary', 'user') == 'illegal_transition'
    assert code(m, 'consent_given', 'user') == 'illegal_transition'  # purposes cannot be skipped
    assert code(m, 'approve', 'reviewer') == 'unknown_event'
    assert code(m, '__proto__', 'user') == 'unknown_event' and code(m, None, 'user') == 'unknown_event'
    assert m.to_dict() == before
    e = Machine('evidence')
    e.fire('submit', 'user'); e.fire('enqueue', 'system'); e.fire('reject', 'reviewer', reason='no source for the metric')
    assert code(e, 'approve', 'reviewer') == 'illegal_transition' and e.state == 'rejected'  # rejected -> approved is not an edge
    assert code(e, 'submit', 'user') == 'illegal_transition'
    a = at_state('evidence', 'approved')
    assert code(a, 'enqueue', 'system') == 'illegal_transition' and a.state == 'approved'  # approved -> reviewer_queue directly
    assert code(a, 'reopen_review', 'reviewer') == 'illegal_transition' and code(a, 'reject', 'reviewer', reason='x') == 'illegal_transition'


def test_terminal_states_have_no_exit():
    for kind in cs.MACHINES:
        for state in STATES[kind]['terminal']:
            m = at_state(kind, state)
            assert m.terminal and m.available_events() == []
            for event, spec in EVENTS[kind].items():
                assert code(m, event, spec['actors'][0], reason='r') == 'illegal_transition'


def test_summary_confirmation_is_not_submission():
    m = at_state('interview', 'summary_confirmed')
    assert m.status == 'evidence_draft' and 'submit' not in EVENTS['interview']
    e = Machine('evidence')
    assert e.state == 'evidence_draft' and e.status == 'evidence_draft'  # owner-only draft until the consultant clicks Submit
    assert code(e, 'enqueue', 'system') == 'illegal_transition' and code(e, 'submit', 'atlas') == 'actor_not_allowed' and code(e, 'submit', 'reviewer') == 'actor_not_allowed'
    assert e.fire('submit', 'user') == 'submitted_for_review'


def test_actor_must_be_allowed_for_the_event():
    m = at_state('interview', 'purpose_permissions')
    for actor in ('atlas', 'system', 'reviewer', '', None, 5, 'USER'):
        assert code(m, 'consent_given', actor) == 'actor_not_allowed'
    assert m.state == 'purpose_permissions' and m.fire('consent_given', 'user') == 'discovery'
    e = at_state('evidence', 'reviewer_queue')
    assert code(e, 'approve', 'user') == 'actor_not_allowed' and code(e, 'approve', 'atlas') == 'actor_not_allowed'
    assert e.fire('approve', 'reviewer') == 'approved'


# ---- pause, suspend, return ----
def test_paused_returns_to_the_prior_state_without_repeating_anything():
    for kind_state in ('welcome', 'purpose_permissions', 'discovery', 'summary', 'user_correction'):
        m = at_state('interview', kind_state)
        n = len(m.audit)
        assert m.fire('pause', 'user') == 'paused' and m.status == STATUS['interview'][kind_state]
        assert m.fire('resume', 'user') == kind_state and len(m.audit) == n + 2 and m.returns == []
    m = interview(('start', 'atlas'), ('consent_given', 'user'), ('focus', 'user', {'data': {'focus': 'evidence'}}), ('pause', 'user'), ('resume', 'user'))
    assert m.focus == 'evidence' and m.state == 'discovery'  # the discovery focus survives a pause


def test_suspended_returns_and_nesting_unwinds_in_order():
    m = at_state('interview', 'discovery')
    m.fire('pause', 'user'); m.fire('disconnect', 'system')
    assert m.state == 'suspended' and m.returns == ['discovery', 'paused'] and m.status == 'interview_in_progress'
    assert m.fire('reconnect', 'system') == 'paused' and m.fire('resume', 'user') == 'discovery'
    assert code(m, 'resume', 'user') == 'illegal_transition' and code(m, 'reconnect', 'system') == 'illegal_transition'
    m.fire('disconnect', 'system')
    assert m.fire('reconnect', 'user') == 'discovery'


def test_ttl_abandons_and_forgets_what_it_remembered():
    for pre in (['disconnect'], ['pause'], ['pause', 'disconnect']):
        m = at_state('interview', 'discovery')
        for e in pre:
            m.fire(e, 'user' if e == 'pause' else 'system')
        assert m.fire('ttl_expired', 'system') == 'abandoned' and m.returns == [] and m.terminal
        assert m.status == 'context_prefilled'  # prefill happened, nothing was confirmed
    assert code(at_state('interview', 'discovery'), 'ttl_expired', 'system') == 'illegal_transition'  # a live socket does not time out
    m = at_state('interview', 'discovery'); m.fire('disconnect', 'system')
    assert code(m, 'ttl_expired', 'user') == 'actor_not_allowed'


# ---- reasons ----
@pytest.mark.parametrize('kind,before,event,actor', [
    ('evidence', 'reviewer_queue', 'reject', 'reviewer'), ('evidence', 'rejected', 'close_rejected', 'reviewer'), ('evidence', 'disputed', 'close_rejected', 'user'),
    ('evidence', 'rejected', 'dispute', 'user'), ('evidence', 'evidence_draft', 'withdraw', 'user'), ('evidence', 'approved', 'withdraw', 'user'),
    ('interview', 'discovery', 'withdraw', 'user'), ('interview', 'suspended', 'withdraw', 'user')])
def test_reason_is_required_for_reject_close_rejected_withdraw_and_dispute(kind, before, event, actor):
    m = at_state(kind, before)
    snap = m.to_dict()
    for bad in (None, '', '   ', ' \n\t\r '):
        assert code(m, event, actor, reason=bad) == 'reason_required'
    assert code(m, event, actor, reason=7) == 'bad_reason' and code(m, event, actor, reason=['x']) == 'bad_reason'
    assert m.to_dict() == snap
    m.fire(event, actor, reason='  the client objected \n', at=AT)
    assert m.audit[-1]['reason'] == 'the client objected'


def test_reason_is_optional_elsewhere_and_stored_null_when_blank():
    m = Machine('interview')
    m.fire('start', 'atlas', reason='  ')
    m.fire('consent_given', 'user', reason='explained and agreed')
    assert [e['reason'] for e in m.audit] == [None, 'explained and agreed']
    assert {e for k in cs.MACHINES for e, s in EVENTS[k].items() if s['reason']} == {'withdraw', 'reject', 'dispute', 'close_rejected'}


# ---- evidence branches (D10, D11) ----
def test_rejection_has_three_exits_and_keeps_the_loop_open():
    for event, actor, kw, expected in (('request_clarification', 'reviewer', {}, 'needs_clarification'), ('dispute', 'user', {'reason': 'wrong'}, 'disputed'),
                                       ('close_rejected', 'reviewer', {'reason': 'no source'}, 'closed_rejected')):
        e = at_state('evidence', 'rejected')
        assert sorted(e.available_events()) == ['close_rejected', 'dispute', 'request_clarification', 'withdraw']
        assert e.fire(event, actor, **kw) == expected
    e = at_state('evidence', 'needs_clarification')
    assert e.fire('revise', 'user') == 'evidence_draft' and e.fire('submit', 'user') == 'submitted_for_review'  # explicit resubmit
    d = at_state('evidence', 'disputed')
    assert d.fire('reopen_review', 'reviewer') == 'reviewer_queue' and code(at_state('evidence', 'disputed'), 'approve', 'reviewer') == 'illegal_transition'


def test_withdrawal_after_approval_goes_through_impact_review():
    for before in ('approved', 'downstream_proposals'):
        e = at_state('evidence', before)
        assert e.fire('withdraw', 'user', reason='permission withdrawn') == 'impact_review' and not e.terminal and e.status == 'impact_review'
        assert code(e, 'withdraw', 'user', reason='again') == 'illegal_transition'
        assert e.fire('complete_impact_review', 'reviewer') == 'withdrawn' and e.terminal
    for before in ('evidence_draft', 'submitted_for_review', 'reviewer_queue', 'needs_clarification', 'rejected', 'disputed'):
        assert at_state('evidence', before).fire('withdraw', 'user', reason='r') == 'withdrawn'  # nothing was approved: no derivatives to review


# ---- audit ----
def test_audit_entry_fields():
    m = Machine('interview')
    m.fire('start', 'atlas', at=AT)
    m.fire('consent_given', 'user', reason='read the purposes', at='2026-11-01T10:00:01.000Z')
    assert m.audit[0] == {'from': 'welcome', 'to': 'purpose_permissions', 'event': 'start', 'actor': 'atlas', 'at': AT, 'workflow_version': WORKFLOW_VERSION, 'reason': None}
    assert m.audit[1] == {'from': 'purpose_permissions', 'to': 'discovery', 'event': 'consent_given', 'actor': 'user', 'at': '2026-11-01T10:00:01.000Z',
                          'workflow_version': WORKFLOW_VERSION, 'reason': 'read the purposes'}
    assert 'data' not in m.audit[0]
    m.fire('focus', 'atlas', at=AT, data={'focus': 'outcome'})
    assert m.audit[2]['data'] == {'focus': 'outcome'} and set(m.audit[2]) == set(m.audit[0]) | {'data'}


def test_timestamps_default_to_utc_and_must_be_text():
    m = Machine('interview')
    m.fire('start', 'user')
    assert m.audit[0]['at'].endswith('Z') and len(m.audit[0]['at']) == 24
    n = Machine('interview')
    for bad in ('', '  ', 5, ['x']):
        assert code(n, 'start', 'user', at=bad) == 'bad_time'
    assert n.state == 'welcome' and n.audit == []


def test_audit_trail_is_the_full_history_and_chains():
    m = at_state('evidence', 'withdrawn')
    trail = m.audit
    assert trail[0]['from'] == 'evidence_draft' and trail[-1]['to'] == m.state
    assert all(a['to'] == b['from'] for a, b in zip(trail, trail[1:]))
    assert all(e['workflow_version'] == WORKFLOW_VERSION for e in trail)


# ---- serialization ----
@pytest.mark.parametrize('kind,target', [(k, s) for k in cs.MACHINES for s in STATES[k]['states']])
def test_serialization_round_trip(kind, target):
    m = at_state(kind, target)
    d = json.loads(json.dumps(m.to_dict()))
    r = Machine.from_dict(d)
    assert r.to_dict() == m.to_dict() and (r.state, r.status, r.returns, r.focus, r.skipped) == (m.state, m.status, m.returns, m.focus, m.skipped)
    if not m.terminal:  # the restored machine carries on exactly as the original
        event = m.available_events()[0]
        spec = EVENTS[kind][event]
        args = dict(reason='because' if spec['reason'] else None, at=AT, data={spec['data']['key']: (spec['data']['values'] or ['metric'])[0]} if spec['data'] else None)
        assert r.fire(event, spec['actors'][0], **args) == m.fire(event, spec['actors'][0], **args) and r.to_dict() == m.to_dict()


def test_to_dict_is_a_copy():
    m = at_state('interview', 'discovery')
    d = m.to_dict()
    d['audit'].clear(); d['returns'].append('x'); d['skipped'].append('x')
    assert len(m.audit) == 2 and m.returns == [] and m.skipped == []


def test_tampered_or_foreign_snapshots_are_rejected():
    m = at_state('interview', 'discovery')
    m.fire('pause', 'user'); m.fire('disconnect', 'system')
    good = m.to_dict()

    def bad(edit, expected='corrupt'):
        d = json.loads(json.dumps(good)); edit(d)
        with pytest.raises(StateError) as err:
            Machine.from_dict(d)
        assert err.value.code == expected

    bad(lambda d: d.update(workflow_version='atlas-conversation-2.0.0'), 'version_mismatch')
    bad(lambda d: d.pop('workflow_version'), 'version_mismatch')
    bad(lambda d: d.update(state='discovery')); bad(lambda d: d.update(returns=[])); bad(lambda d: d.update(focus='skills')); bad(lambda d: d.update(skipped=['x']))
    bad(lambda d: d.update(extra=1)); bad(lambda d: d.pop('skipped')); bad(lambda d: d.update(kind='review')); bad(lambda d: d.update(audit={}))
    bad(lambda d: d['audit'].pop()); bad(lambda d: d['audit'].pop(0)); bad(lambda d: d['audit'][2].update(event='start')); bad(lambda d: d['audit'][1].update(actor='atlas'))
    bad(lambda d: d['audit'][0].update(at='')); bad(lambda d: d['audit'][0].update(note='x')); bad(lambda d: d['audit'].append('x'))
    bad(lambda d: d['audit'][1].update(workflow_version='atlas-conversation-2.0.0'))
    for junk in (None, [], 'x', 5):
        with pytest.raises(StateError):
            Machine.from_dict(junk)
    assert Machine.from_dict(good).to_dict() == good


def test_unknown_machine_kind_is_rejected():
    with pytest.raises(StateError) as err:
        Machine('review')
    assert err.value.code == 'corrupt'


def test_can_fire_and_available_events():
    m = at_state('interview', 'discovery')
    assert m.can_fire('focus') and m.can_fire('focus', 'atlas') and not m.can_fire('focus', 'reviewer') and not m.can_fire('confirm_summary') and not m.can_fire('nope') and not m.can_fire(None)
    assert m.available_events() == ['focus', 'skip', 'request_summary', 'pause', 'disconnect', 'withdraw']


def test_no_person_assessment_vocabulary_in_the_tables():
    # D6/D18: the machine describes where the conversation is, never what a person is like.
    text = json.dumps(EDGE_CONSTANTS).lower()
    for word in ('sentiment', 'mood', 'emotion', 'personality', 'turnover', 'attrition', 'performance_score', 'peer_rank', 'engagement_score'):
        assert word not in text
