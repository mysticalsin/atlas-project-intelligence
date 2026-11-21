"""Row 3. The Kyutai and Workers interview run is one reducer. No continuation window is added."""
from atlas_voice.cascade_run import EVENTS, PHASES, initial_cascade_run, cascade_run_transition

LEGAL = {
    ('closed', 'open'): 'opening',
    ('opening', 'admit'): 'connecting',
    ('opening', 'fail'): 'failed',
    ('opening', 'release'): 'released',
    ('connecting', 'ready'): 'live',
    ('connecting', 'discard'): 'ending',
    ('connecting', 'fail'): 'failed',
    ('connecting', 'release'): 'released',
    ('live', 'finish'): 'ending',
    ('live', 'discard'): 'ending',
    ('live', 'fail'): 'failed',
    ('live', 'release'): 'released',
    ('ending', 'fail'): 'failed',
    ('ending', 'release'): 'released',
    ('failed', 'release'): 'released',
}


def test_every_legal_run_pair_and_every_other_pair_is_refused():
    legal = illegal = 0
    for phase in PHASES:
        for event in EVENTS:
            before = {'phase': phase}
            result = cascade_run_transition(before, {'type': event})
            key = (phase, event)
            if key in LEGAL:
                legal += 1
                assert result['ok'] is True, key
                assert result['state']['phase'] == LEGAL[key], key
                assert result['state'] is not before, key
            else:
                illegal += 1
                assert result['illegal'] is True, key
                assert result['state'] is before, key
                assert result['rejection'] == {'id': 'cascade-run', 'phase': phase, 'event': event}, key
    assert legal == len(LEGAL)
    assert illegal == len(PHASES) * len(EVENTS) - len(LEGAL)


def test_unknown_run_phase_or_event_keeps_the_stored_state():
    before = {'phase': 'archived'}
    result = cascade_run_transition(before, {'type': 'open'})
    assert result['state'] is before
    assert result['rejection']['phase'] == 'unknown'
    named = cascade_run_transition(initial_cascade_run(), {'type': 'reopen'})
    assert named['rejection']['event'] == 'unknown'


def test_no_run_phase_is_unreachable_and_released_is_the_only_terminal():
    seen = set()
    queue = [initial_cascade_run()]
    steps = 0
    while queue and steps < 200:
        state = queue.pop(0)
        if state['phase'] in seen:
            continue
        seen.add(state['phase'])
        steps += 1
        for event in EVENTS:
            result = cascade_run_transition(state, {'type': event})
            if result['ok']:
                queue.append(result['state'])
    for phase in PHASES:
        assert phase in seen, phase
    terminals = [phase for phase in PHASES if all(
        (not cascade_run_transition({'phase': phase}, {'type': event})['ok'])
        or cascade_run_transition({'phase': phase}, {'type': event})['state']['phase'] == phase
        for event in EVENTS)]
    assert terminals == ['released']


def test_cascade_run_steps_the_reducer():
    text = open('atlas_voice/cascade.py', encoding='utf-8').read()
    assert 'cascade_run_transition(' in text
    assert "step('open')" in text
    assert "step('release')" in text
