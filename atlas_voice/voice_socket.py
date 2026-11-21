"""PersonaPlex browser socket (row 5). Pure. server.voice runs the effects."""
PHASES = ('closed', 'opening', 'connecting', 'streaming', 'ending', 'failed', 'released')
EVENTS = ('open', 'reject', 'admit', 'ready', 'finish', 'discard', 'fail', 'release')

_LEGAL = {
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


def initial_voice_socket():
    return {'phase': 'closed'}


def voice_socket_transition(state, event):
    phase = state.get('phase') if isinstance(state, dict) else None
    kind = event.get('type') if isinstance(event, dict) else None
    known_phase = phase if phase in PHASES else 'unknown'
    known_event = kind if kind in EVENTS else 'unknown'
    if known_phase == 'unknown' or known_event == 'unknown':
        return {'ok': False, 'illegal': True, 'state': state, 'effects': [],
                'rejection': {'id': 'voice-socket', 'phase': known_phase, 'event': known_event}}
    dest = _LEGAL.get((known_phase, known_event))
    if dest is None:
        return {'ok': False, 'illegal': True, 'state': state, 'effects': [],
                'rejection': {'id': 'voice-socket', 'phase': known_phase, 'event': known_event}}
    return {'ok': True, 'illegal': False, 'state': {'phase': dest}, 'effects': ['occupy'] if dest == 'connecting' else []}
