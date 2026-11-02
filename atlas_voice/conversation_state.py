"""ATLAS conversation state machines (agent brain v2.1, plan §3i, decisions D8-D11 and D19). Pure: no I/O, and the clock is
read only when a caller omits `at`. Python is the source of truth; deploy/cloudflare-edge/src/conversation-state.js is a
parity-tested port (test/gen_state_parity.py records this module into test/state.vectors.json).

Two machines (D8):
  INTERVIEW  the live conversation (the Session). Discovery is one state; context|contribution|evidence|outcome|skills is a
             focus annotation inside it, in free order, and every move is audited as a `focus` event. pause and disconnect
             remember the state they left and resume/reconnect return to it (D9).
  EVIDENCE   what happens to the evidence after the consultant submits it (the Library): review, clarification, dispute,
             approval, downstream proposals, and withdrawal with an impact review once approved (D10, D11).
The interview ends in `summary_confirmed`; that becomes an owner-only `evidence_draft` (D19). Nothing is submitted except by
the explicit `submit` event, taken by the consultant (Tony's Q2). Only the consultant can consent, confirm, correct, skip,
pause, submit, dispute or withdraw; only a reviewer can approve, reject or ask for clarification: the agent (`atlas`) can
only steer the conversation, which keeps the "agent tools cannot approve or publish" rule in the table rather than in callers.

Every transition appends an audit entry {from, to, event, actor, at, workflow_version, reason} (plus `data` for focus and skip).
An illegal move raises StateError and changes nothing. Reasons are required for reject, close_rejected, withdraw and dispute.
Missing data is never inferred: a skipped field is recorded as skipped, not as absent or negative. (Since 2026-10-31 nothing fires `skip`: the consultant cannot skip a question, DECISION_LOG D-U2-2; the event stays in the machine unused.)
"""
import copy
import re
from datetime import datetime, timezone

WORKFLOW_VERSION = 'atlas-conversation-2.1.0'
FOCUS_AREAS = ['context', 'contribution', 'evidence', 'outcome', 'skills']
RETURN = '$return'  # transition target of resume/reconnect: the state that pause/disconnect remembered
_BLANK = ' \t\n\r'  # the only whitespace trimmed (the JS port trims exactly the same characters)
_FIELD = re.compile(r'[a-z][a-z0-9_]{0,63}')  # a skipped field is an internal field id, never free text

# The 21 statuses of the canonical workflow spec, in its order, and the three the domain model adds for the machines below.
CANONICAL_STATUSES = ['identified', 'context_prefilled', 'interview_in_progress', 'evidence_draft', 'submitted_for_review', 'needs_clarification',
                      'disputed', 'evidence_approved', 'projection_pending', 'maap_pending', 'maap_in_progress', 'maap_closed',
                      'project_review_pending', 'project_review_in_progress', 'project_review_closed', 'spotlight_draft',
                      'spotlight_approval_pending', 'publication_held', 'published', 'sync_partial', 'sync_complete']
EXTENSION_STATUSES = ['rejected', 'impact_review', 'withdrawn']


def _event(actors, reason=False, remember=False, restore=False, data=None):
    return {'actors': actors, 'reason': reason, 'remember': remember, 'restore': restore, 'data': data}


def _rows(*spec):  # (event, [from states], to) -> flat [event, from, to] rows
    return [[e, f, t] for e, froms, t in spec for f in froms]


_ACTIVE = ['welcome', 'purpose_permissions', 'discovery', 'summary', 'user_correction']
_PRE_APPROVAL = ['evidence_draft', 'submitted_for_review', 'reviewer_queue', 'needs_clarification', 'rejected', 'disputed']

MACHINES = ['interview', 'evidence']

STATES = {
    'interview': {'initial': 'welcome', 'transient': ['paused', 'suspended'], 'terminal': ['summary_confirmed', 'withdrawn', 'abandoned'],
                  'states': ['welcome', 'purpose_permissions', 'discovery', 'summary', 'user_correction', 'summary_confirmed', 'paused', 'suspended', 'withdrawn', 'abandoned']},
    'evidence': {'initial': 'evidence_draft', 'transient': [], 'terminal': ['closed_rejected', 'withdrawn'],
                 'states': ['evidence_draft', 'submitted_for_review', 'reviewer_queue', 'needs_clarification', 'approved', 'rejected', 'disputed',
                            'closed_rejected', 'downstream_proposals', 'impact_review', 'withdrawn']},
}

EVENTS = {
    'interview': {
        'start': _event(['atlas', 'user', 'system']),
        'consent_given': _event(['user']),
        'focus': _event(['atlas', 'user'], data={'key': 'focus', 'values': FOCUS_AREAS}),
        'skip': _event(['user'], data={'key': 'field', 'values': None}),
        'request_summary': _event(['atlas', 'user']),
        'continue_discovery': _event(['atlas', 'user']),
        'correct': _event(['user']),
        'confirm_summary': _event(['user']),
        'pause': _event(['user'], remember=True),
        'resume': _event(['user'], restore=True),
        'disconnect': _event(['system'], remember=True),
        'reconnect': _event(['system', 'user'], restore=True),
        'ttl_expired': _event(['system']),
        'withdraw': _event(['user'], reason=True),
    },
    'evidence': {
        'submit': _event(['user']),
        'enqueue': _event(['system']),
        'request_clarification': _event(['reviewer']),
        'revise': _event(['user']),
        'approve': _event(['reviewer']),
        'reject': _event(['reviewer'], reason=True),
        'dispute': _event(['user'], reason=True),
        'close_rejected': _event(['reviewer', 'user'], reason=True),
        'reopen_review': _event(['reviewer']),
        'propose_downstream': _event(['system', 'reviewer']),
        'withdraw': _event(['user'], reason=True),
        'complete_impact_review': _event(['reviewer']),
    },
}

TRANSITIONS = {
    'interview': _rows(
        ('start', ['welcome'], 'purpose_permissions'),
        ('consent_given', ['purpose_permissions'], 'discovery'),
        ('focus', ['discovery'], 'discovery'),
        ('skip', ['discovery'], 'discovery'),
        ('request_summary', ['discovery', 'user_correction'], 'summary'),
        ('continue_discovery', ['summary', 'user_correction'], 'discovery'),
        ('correct', ['summary', 'user_correction'], 'user_correction'),
        ('confirm_summary', ['summary', 'user_correction'], 'summary_confirmed'),
        ('pause', _ACTIVE, 'paused'),
        ('resume', ['paused'], RETURN),
        ('disconnect', _ACTIVE + ['paused'], 'suspended'),
        ('reconnect', ['suspended'], RETURN),
        ('ttl_expired', ['paused', 'suspended'], 'abandoned'),
        ('withdraw', _ACTIVE + ['paused', 'suspended'], 'withdrawn')),
    'evidence': _rows(
        ('submit', ['evidence_draft'], 'submitted_for_review'),
        ('enqueue', ['submitted_for_review'], 'reviewer_queue'),
        ('request_clarification', ['reviewer_queue', 'rejected', 'disputed'], 'needs_clarification'),
        ('revise', ['needs_clarification'], 'evidence_draft'),
        ('approve', ['reviewer_queue'], 'approved'),
        ('reject', ['reviewer_queue'], 'rejected'),
        ('dispute', ['rejected'], 'disputed'),
        ('close_rejected', ['rejected', 'disputed'], 'closed_rejected'),
        ('reopen_review', ['disputed'], 'reviewer_queue'),
        ('propose_downstream', ['approved'], 'downstream_proposals'),
        ('withdraw', _PRE_APPROVAL, 'withdrawn'),
        ('withdraw', ['approved', 'downstream_proposals'], 'impact_review'),
        ('complete_impact_review', ['impact_review'], 'withdrawn')),
}

# Interview/evidence state -> the canonical entity status. paused and suspended carry no status of their own: they report
# the status of the state they will return to. The abandoned interview falls back to context_prefilled (prefill happened,
# nothing was confirmed). `rejected`, `impact_review` and `withdrawn` are not in the canonical list (EXTENSION_STATUSES).
STATUS = {
    'interview': {'welcome': 'identified', 'purpose_permissions': 'context_prefilled', 'discovery': 'interview_in_progress',
                  'summary': 'interview_in_progress', 'user_correction': 'interview_in_progress', 'summary_confirmed': 'evidence_draft',
                  'withdrawn': 'withdrawn', 'abandoned': 'context_prefilled'},
    'evidence': {'evidence_draft': 'evidence_draft', 'submitted_for_review': 'submitted_for_review', 'reviewer_queue': 'submitted_for_review',
                 'needs_clarification': 'needs_clarification', 'approved': 'evidence_approved', 'rejected': 'rejected', 'disputed': 'disputed',
                 'closed_rejected': 'rejected', 'downstream_proposals': 'projection_pending', 'impact_review': 'impact_review', 'withdrawn': 'withdrawn'},
}

# Everything the edge port needs, merged into policy.generated.js by build_edge.py (one definition, no hand copies).
EDGE_CONSTANTS = {
    'CONVERSATION_WORKFLOW_VERSION': WORKFLOW_VERSION, 'CONVERSATION_FOCUS': FOCUS_AREAS, 'CONVERSATION_STATES': STATES,
    'CONVERSATION_EVENTS': EVENTS, 'CONVERSATION_TRANSITIONS': TRANSITIONS, 'CONVERSATION_STATUS': STATUS,
}


def _index():
    out = {}
    for kind in MACHINES:
        table = out[kind] = {}
        for event, src, dst in TRANSITIONS[kind]:
            if (event, src) in table:
                raise ValueError(f'{kind}: duplicate transition {event} from {src}')
            table[(event, src)] = dst
    return out


_INDEX = _index()


class StateError(ValueError):
    """An illegal or malformed move. `code` is stable across Python and JavaScript: unknown_event, illegal_transition,
    actor_not_allowed, bad_reason, reason_required, bad_data, bad_time, version_mismatch, corrupt."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _trim(text):
    return text.strip(_BLANK)


class Machine:
    def __init__(self, kind='interview'):
        if kind not in MACHINES:
            raise StateError('corrupt', f'unknown machine {kind!r}')
        self.kind = kind
        self.state = STATES[kind]['initial']
        self.focus = FOCUS_AREAS[0] if kind == 'interview' else None
        self.skipped = []  # fields the consultant chose to skip: recorded as skipped_by_user, never as empty or negative
        self.returns = []  # states remembered by pause/disconnect, innermost last
        self.audit = []

    @property
    def terminal(self):
        return self.state in STATES[self.kind]['terminal']

    @property
    def status(self):
        """The canonical entity status; a paused or suspended interview reports the status of the state it returns to."""
        state = self.returns[0] if self.state in STATES[self.kind]['transient'] and self.returns else self.state
        return STATUS[self.kind][state]

    def available_events(self):
        """Events the table allows from the current state, whoever may fire them."""
        return [e for e, src, _ in TRANSITIONS[self.kind] if src == self.state]

    def can_fire(self, event, actor=None):
        spec = EVENTS[self.kind].get(event) if isinstance(event, str) else None
        return spec is not None and (event, self.state) in _INDEX[self.kind] and (actor is None or actor in spec['actors'])

    def fire(self, event, actor, reason=None, at=None, data=None):
        """Take one transition and return the new state. Checks run in a fixed order and nothing changes on error."""
        spec = EVENTS[self.kind].get(event) if isinstance(event, str) else None
        if spec is None:
            raise StateError('unknown_event', f'{self.kind} has no event {event!r}')
        target = _INDEX[self.kind].get((event, self.state))
        if target is None:
            raise StateError('illegal_transition', f'{self.kind}: {event} is not allowed from {self.state}')
        if not isinstance(actor, str) or actor not in spec['actors']:
            raise StateError('actor_not_allowed', f'{event} may only be taken by {", ".join(spec["actors"])}')
        if reason is not None and not isinstance(reason, str):
            raise StateError('bad_reason', 'reason must be text')
        reason = _trim(reason) if reason is not None else None
        reason = reason or None
        if spec['reason'] and not reason:
            raise StateError('reason_required', f'{event} needs a reason')
        payload = self._payload(event, spec, data)
        if at is None:
            at = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        elif not isinstance(at, str) or not _trim(at):
            raise StateError('bad_time', 'at must be a timestamp string')
        if spec['restore'] and not self.returns:
            raise StateError('corrupt', f'{event} has no remembered state')
        before = self.state
        if spec['remember']:
            self.returns.append(before)
        if target == RETURN:
            target = self.returns.pop()
        if target in STATES[self.kind]['terminal']:
            self.returns = []
        self.state = target
        if payload:
            if event == 'focus':
                self.focus = payload['focus']
            elif event == 'skip' and payload['field'] not in self.skipped:
                self.skipped.append(payload['field'])
        entry = {'from': before, 'to': target, 'event': event, 'actor': actor, 'at': at, 'workflow_version': WORKFLOW_VERSION, 'reason': reason}
        if payload:
            entry['data'] = payload
        self.audit.append(entry)
        return target

    @staticmethod
    def _payload(event, spec, data):
        want = spec['data']
        if data is not None and not isinstance(data, dict):
            raise StateError('bad_data', f'{event} data must be an object')
        if want is None:
            if data:
                raise StateError('bad_data', f'{event} takes no data')
            return None
        if not data or list(data) != [want['key']]:
            raise StateError('bad_data', f'{event} needs exactly {want["key"]}')
        value = data[want['key']]
        ok = value in want['values'] if want['values'] is not None else isinstance(value, str) and _FIELD.fullmatch(value)
        if not (isinstance(value, str) and ok):
            raise StateError('bad_data', f'{event} {want["key"]} is not allowed')
        return {want['key']: value}

    def to_dict(self):
        return copy.deepcopy({'kind': self.kind, 'workflow_version': WORKFLOW_VERSION, 'state': self.state, 'focus': self.focus,
                              'skipped': self.skipped, 'returns': self.returns, 'audit': self.audit})

    @classmethod
    def from_dict(cls, d):
        """Restore a machine by replaying its audit trail through the table, then requiring the stored fields to match what
        the replay produced: a tampered, truncated or hand-edited snapshot is `corrupt`; another workflow version is not guessed at."""
        if not isinstance(d, dict) or d.get('kind') not in MACHINES:
            raise StateError('corrupt', 'not a machine snapshot')
        if d.get('workflow_version') != WORKFLOW_VERSION:
            raise StateError('version_mismatch', f'snapshot is {d.get("workflow_version")!r}, this is {WORKFLOW_VERSION}')
        audit = d.get('audit')
        if not isinstance(audit, list):
            raise StateError('corrupt', 'audit must be a list')
        m = cls(d['kind'])
        try:
            for entry in audit:
                if not isinstance(entry, dict):
                    raise StateError('corrupt', 'audit entry is not an object')
                m.fire(entry.get('event'), entry.get('actor'), entry.get('reason'), entry.get('at'), entry.get('data'))
                if m.audit[-1] != entry:
                    raise StateError('corrupt', 'audit entry differs from its replay')
        except StateError as err:
            raise StateError('corrupt', f'audit does not replay: {err}') from err
        if m.to_dict() != d:
            raise StateError('corrupt', 'snapshot fields differ from its audit trail')
        return m
