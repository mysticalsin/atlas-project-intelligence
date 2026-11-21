"""Interview ledger status and probe budget (rows 2 and 4). Pure. The ledger runs the effects."""
import re

DETAIL_PHASES = ('unset', 'unknown', 'uncertain', 'reported')
PROBE_PHASES = ('open', 'asking', 'deferred')
DEFER_SENTENCE = 'Two clarification plans did not resolve this point; offer to collect it later.'
_KINDS = ('unknown', 'uncertain', 'reported')
_UNCERTAIN = re.compile(r'\b(?:guess|roughly|about|approximately|estimate|not sure|maybe|think|probably)\b', re.I)
_UNKNOWN = re.compile(r"\b(?:don.t know|not measured|no baseline|no measurement|unknown|not yet known|cannot share|can.t share|under NDA|not authorized to disclose)\b", re.I)


def detail_transition(state, event):
    phase = state.get('phase') if isinstance(state, dict) else None
    kind = event.get('type') if isinstance(event, dict) else None
    label = event.get('kind') if isinstance(event, dict) else None
    known_phase = phase if phase in DETAIL_PHASES else 'unknown'
    known_event = kind if kind == 'classify' else 'unknown'
    if known_phase != 'unset' or known_event != 'classify' or label not in _KINDS:
        return {'ok': False, 'illegal': True, 'state': state, 'effects': [],
                'rejection': {'id': 'detail-status', 'phase': known_phase, 'event': known_event}}
    return {'ok': True, 'illegal': False, 'state': {'phase': label}, 'effects': []}


def classify_detail(quote, uncertain):
    kind = 'unknown' if _UNKNOWN.search(quote) else 'uncertain' if uncertain is True or _UNCERTAIN.search(quote) else 'reported'
    return detail_transition({'phase': 'unset'}, {'type': 'classify', 'kind': kind})['state']['phase']


def probe_transition(state, event):
    phase = state.get('phase') if isinstance(state, dict) else None
    plans = state.get('plans') if isinstance(state, dict) else None
    kind = event.get('type') if isinstance(event, dict) else None
    known_phase = phase if phase in PROBE_PHASES else 'unknown'
    known_event = kind if kind == 'plan' else 'unknown'
    known_plans = plans if isinstance(plans, int) and plans >= 0 else None
    if known_phase == 'unknown' or known_event == 'unknown' or known_plans is None:
        return {'ok': False, 'illegal': True, 'state': state, 'effects': [],
                'rejection': {'id': 'probe-budget', 'phase': known_phase, 'event': known_event}}
    if known_phase == 'open' and known_plans == 0:
        return {'ok': True, 'illegal': False, 'state': {'phase': 'asking', 'plans': 1}, 'effects': ['ask']}
    if known_phase == 'asking' and known_plans == 1:
        return {'ok': True, 'illegal': False, 'state': {'phase': 'asking', 'plans': 2}, 'effects': ['ask']}
    if (known_phase == 'asking' and known_plans >= 2) or known_phase == 'deferred':
        return {'ok': True, 'illegal': False, 'state': {'phase': 'deferred', 'plans': known_plans}, 'effects': ['defer']}
    return {'ok': False, 'illegal': True, 'state': state, 'effects': [],
            'rejection': {'id': 'probe-budget', 'phase': known_phase, 'event': known_event}}
