"""Kyutai and Workers interview run (row 3). Pure. cascade.run runs the effects."""
PHASES = ('closed', 'opening', 'connecting', 'live', 'ending', 'failed', 'released')
EVENTS = ('open', 'admit', 'ready', 'finish', 'discard', 'fail', 'release')

_LEGAL = {
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


def initial_cascade_run():
    return {'phase': 'closed'}


def cascade_run_transition(state, event):
    phase = state.get('phase') if isinstance(state, dict) else None
    kind = event.get('type') if isinstance(event, dict) else None
    known_phase = phase if phase in PHASES else 'unknown'
    known_event = kind if kind in EVENTS else 'unknown'
    if known_phase == 'unknown' or known_event == 'unknown':
        return {'ok': False, 'illegal': True, 'state': state, 'effects': [],
                'rejection': {'id': 'cascade-run', 'phase': known_phase, 'event': known_event}}
    dest = _LEGAL.get((known_phase, known_event))
    if dest is None:
        return {'ok': False, 'illegal': True, 'state': state, 'effects': [],
                'rejection': {'id': 'cascade-run', 'phase': known_phase, 'event': known_event}}
    return {'ok': True, 'illegal': False, 'state': {'phase': dest}, 'effects': []}
