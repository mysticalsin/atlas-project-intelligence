"""Row 5. The PersonaPlex socket lifecycle is one reducer. The handler runs the effects."""
import pytest

from atlas_voice.voice_socket import EVENTS, PHASES, initial_voice_socket, voice_socket_transition

LEGAL = {
    ('closed', 'open'): 'opening',
    ('opening', 'reject'): 'failed',
    ('opening', 'admit'): 'connecting',
    ('opening', 'fail'): 'failed',
    ('opening', 'release'): 'released',
    ('connecting', 'ready'): 'streaming',
    ('connecting', 'discard'): 'ending',
    ('connecting', 'fail'): 'failed',
    ('connecting', 'release'): 'released',
    ('streaming', 'finish'): 'ending',
    ('streaming', 'discard'): 'ending',
    ('streaming', 'fail'): 'failed',
    ('streaming', 'release'): 'released',
    ('ending', 'fail'): 'failed',
    ('ending', 'release'): 'released',
    ('failed', 'release'): 'released',
}


def test_every_legal_socket_pair_and_every_other_pair_is_refused():
    legal = illegal = 0
    for phase in PHASES:
        for event in EVENTS:
            before = {'phase': phase}
            result = voice_socket_transition(before, {'type': event})
            key = (phase, event)
            if key in LEGAL:
                legal += 1
                assert result['ok'] is True, key
                assert result['illegal'] is False, key
                assert 'rejection' not in result, key
                assert result['state']['phase'] == LEGAL[key], key
                assert result['state'] is not before, key
            else:
                illegal += 1
                assert result['illegal'] is True, key
                assert result['ok'] is False, key
                assert result['state'] is before, key
                assert result['effects'] == [], key
                assert result['rejection'] == {'id': 'voice-socket', 'phase': phase, 'event': event}, key
    assert legal == len(LEGAL)
    assert legal + illegal == len(PHASES) * len(EVENTS)
    assert illegal == len(PHASES) * len(EVENTS) - len(LEGAL)


def test_unknown_phase_or_event_keeps_the_stored_state():
    before = {'phase': 'archived'}
    result = voice_socket_transition(before, {'type': 'open'})
    assert result['state'] is before
    assert result['rejection']['phase'] == 'unknown'
    assert result['rejection']['event'] == 'open'
    named = voice_socket_transition(initial_voice_socket(), {'type': 'reopen'})
    assert named['rejection']['event'] == 'unknown'
    assert named['rejection']['phase'] == 'closed'


def test_no_socket_phase_is_unreachable_and_every_terminal_is_reachable():
    seen = set()
    queue = [initial_voice_socket()]
    steps = 0
    while queue and steps < 200:
        state = queue.pop(0)
        key = state['phase']
        if key in seen:
            continue
        seen.add(key)
        steps += 1
        for event in EVENTS:
            result = voice_socket_transition(state, {'type': event})
            if result['ok']:
                queue.append(result['state'])
    for phase in PHASES:
        assert phase in seen, phase
    terminals = [phase for phase in PHASES if all(
        (not voice_socket_transition({'phase': phase}, {'type': event})['ok'])
        or voice_socket_transition({'phase': phase}, {'type': event})['state']['phase'] == phase
        for event in EVENTS)]
    assert terminals == ['released']
    for phase in terminals:
        assert phase in seen


def test_persona_handler_steps_the_socket_reducer():
    text = open('atlas_voice/server.py', encoding='utf-8').read()
    assert 'voice_socket_transition(' in text
    assert 'step(\'open\')' in text
    assert 'step(\'release\')' in text
