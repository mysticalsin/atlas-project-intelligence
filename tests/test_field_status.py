"""Rows 2 and 4. Detail status is one write. The probe budget defers on the third plan."""
import pytest

from atlas_voice.field_status import (
    DEFER_SENTENCE, DETAIL_PHASES, PROBE_PHASES, classify_detail, detail_transition, probe_transition,
)

DETAIL_LEGAL = {('unset', 'classify'): 'reported'}


def test_detail_status_is_one_write():
    legal = illegal = 0
    for phase in DETAIL_PHASES:
        before = {'phase': phase}
        result = detail_transition(before, {'type': 'classify', 'kind': 'reported'})
        if (phase, 'classify') in DETAIL_LEGAL:
            legal += 1
            assert result['ok'] is True
            assert result['state']['phase'] == 'reported'
            assert result['state'] is not before
        else:
            illegal += 1
            assert result['illegal'] is True
            assert result['state'] is before
            assert result['rejection'] == {'id': 'detail-status', 'phase': phase, 'event': 'classify'}
    assert legal == 1 and illegal == 3
    for kind in ('unknown', 'uncertain', 'reported'):
        moved = detail_transition({'phase': 'unset'}, {'type': 'classify', 'kind': kind})
        assert moved['state']['phase'] == kind
    bad = detail_transition({'phase': 'unset'}, {'type': 'classify', 'kind': 'verified'})
    assert bad['illegal'] is True and bad['state']['phase'] == 'unset'


def test_classify_detail_matches_the_edge_labels():
    cases = [
        ('the team shipped the change last spring', False, 'reported'),
        ("we don't know the baseline yet", False, 'unknown'),
        ('about twelve minutes of delay', False, 'uncertain'),
        ('the team shipped the change last spring', True, 'uncertain'),
    ]
    for quote, uncertain, label in cases:
        assert classify_detail(quote, uncertain) == label


def test_probe_budget_asks_twice_then_defers():
    state = {'phase': 'open', 'plans': 0}
    first = probe_transition(state, {'type': 'plan'})
    assert first['effects'] == ['ask'] and first['state'] == {'phase': 'asking', 'plans': 1}
    second = probe_transition(first['state'], {'type': 'plan'})
    assert second['effects'] == ['ask'] and second['state'] == {'phase': 'asking', 'plans': 2}
    third = probe_transition(second['state'], {'type': 'plan'})
    assert third['effects'] == ['defer'] and third['state']['phase'] == 'deferred'
    again = probe_transition(third['state'], {'type': 'plan'})
    assert again['effects'] == ['defer'] and again['state'] is not third['state']
    refused = probe_transition({'phase': 'open', 'plans': 1}, {'type': 'plan'})
    assert refused['illegal'] is True and refused['state']['plans'] == 1
    assert DEFER_SENTENCE == 'Two clarification plans did not resolve this point; offer to collect it later.'


def test_no_probe_phase_is_unreachable_and_deferred_is_terminal():
    seen = set()
    phases = set()
    queue = [('open', 0)]
    while queue and len(seen) < 200:
        phase, plans = queue.pop(0)
        if (phase, plans) in seen:
            continue
        seen.add((phase, plans))
        phases.add(phase)
        result = probe_transition({'phase': phase, 'plans': plans}, {'type': 'plan'})
        if result['ok']:
            queue.append((result['state']['phase'], result['state']['plans']))
    assert phases == set(PROBE_PHASES)
    terminals = []
    for phase in PROBE_PHASES:
        leaves = False
        for plans in range(5):
            result = probe_transition({'phase': phase, 'plans': plans}, {'type': 'plan'})
            if result['ok'] and result['state']['phase'] != phase:
                leaves = True
        if not leaves:
            terminals.append(phase)
    assert terminals == ['deferred']


def test_ledgers_step_the_same_reducers():
    ledger = open('deploy/cloudflare-edge/src/ledger.js', encoding='utf-8').read()
    quality = open('atlas_voice/quality.py', encoding='utf-8').read()
    assert 'classifyDetail(' in ledger and 'probeTransition(' in ledger
    assert 'classify_detail(' in quality and 'probe_transition(' in quality
