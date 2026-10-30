"""Deterministic next-move selector (Agent Brain v2.1 plan 3b + 3j; spec 02_Agent_Brain/ATLAS_Question_Selection_and_Evidence_Reasoning.md).

select() chooses what ATLAS should do next from facts only: the ledger's inspect() output (`plan`), the pre-pass of the
consultant's latest answer (`turn`, turns.analyze_turn), the moves already made (`asked`), what is known up front (`prefill`),
the interview phase and time left, uncertain speech spans (`asr`) and whether the consultant is rushed. No model, no clock, no
I/O. It returns a Move: kind (ask | confirm_asr | reflect | summary | close | offer_move_on | accept_and_move), intent, field,
rung (1-8, the follow-up ladder), say (what to ask, from QUESTION_BANK), why (a short code), reaction (none | ack | earned) and
ack_category (a key of persona.ACKS). The Move never contains a score: the ranking below orders questions, it is not a rating
of anyone, and nothing here describes the person (D18).

Priority (first that applies): wrap-up time > confirm an uncertain span > the consultant wants to stop > a correction (use their
version, narrow) > "I don't know" / "I can't share" / skip (accept, leave the field OPEN, ask something else, never ask it
again) > a contradiction in the plan (both versions, neutrally, never pick) > a metric without a basis (ONE part per move:
measured or estimated, period, baseline, source) > a vague verb (a concrete example, then ownership) > a team claim (their own
part, without diminishing the team) > a technology list (where and how deep) > a certification (issuer, date) > client praise
(who said it, never a quote) > one reflection when the interview moves to depth > the follow-up ladder (open exploration,
example, ownership, decision, evidence, impact, measurement, attribution), continuing from the THREAD just answered.

Ladder questions are ranked value x gain x relevance - effort - sensitivity - redundancy with the integer weights in CONFIG.
Redundancy: the field is already in the ledger, covered by THIS turn's field hints (the ledger lags one turn), prefilled, or
asked before. The same point is never asked a third time: after two unproductive attempts the selector offers to move on, and
a deferred or moved-on field is never asked again. Rushed mode asks only the essentials (context, contribution, outcome).
A question whose words are about 80% the same as one of the last six asked (3-gram Jaccard) uses the next variant or intent.

Pure Python, no I/O. build_edge.py exports EDGE_CONSTANTS (CONFIG, QUESTION_BANK, LINES) and src/selector.js ports select()
(parity vectors: test/gen_selector_parity.py -> test/selector.vectors.json). Every pattern is written in the regex subset that
Python (re.I) and JavaScript (flag i) read the same way. English only: any other language gets the English wording (the
pre-pass has cues for English only; fr/es wording would need native review).
"""
import re
import unicodedata

from .quality import FIELDS
from .turns import NOT_AN_ANSWER

PHASES = ['breadth', 'depth', 'closing', 'wrap']   # from least to most pressing; session.js / storyboard-core.js use the same words
ESSENTIALS = ['problem', 'contribution', 'outcome']  # context, contribution, outcome: all a rushed consultant is asked for
METRIC_PARTS = ['metric_kind', 'metric_period', 'metric_baseline', 'metric_source']
# Ledger fields the selector may ask about, in ledger order. rung = position on the follow-up ladder (1 open exploration,
# 2 specific example, 3 ownership, 4 decision, 5 evidence, 6 impact, 7 measurement, 8 attribution and transfer).
CONFIG = {
    'weights': {'effort': 2, 'sensitivity': 2, 'asked': 30},    # score = value*gain*relevance - effort*w - sensitivity*w - asked*attempts
    'fields': {
        'problem': {'value': 5, 'effort': 1, 'sensitivity': 0, 'rung': 1, 'intent': 'open_exploration'},
        'stakes': {'value': 3, 'effort': 2, 'sensitivity': 1, 'rung': 2, 'intent': 'stakes'},
        'contribution': {'value': 5, 'effort': 2, 'sensitivity': 1, 'rung': 3, 'intent': 'ownership'},
        'intervention': {'value': 4, 'effort': 2, 'sensitivity': 0, 'rung': 2, 'intent': 'example'},
        'decision': {'value': 3, 'effort': 3, 'sensitivity': 1, 'rung': 4, 'intent': 'decision'},
        'adoption': {'value': 3, 'effort': 2, 'sensitivity': 1, 'rung': 6, 'intent': 'adoption'},
        'outcome': {'value': 5, 'effort': 2, 'sensitivity': 0, 'rung': 6, 'intent': 'impact'},
        'measurement': {'value': 4, 'effort': 4, 'sensitivity': 2, 'rung': 7, 'intent': 'measurement'},
        'evidence': {'value': 4, 'effort': 4, 'sensitivity': 2, 'rung': 5, 'intent': 'evidence'},
        'limitations': {'value': 3, 'effort': 3, 'sensitivity': 1, 'rung': 8, 'intent': 'attribution'},
        'customer_fit': {'value': 2, 'effort': 3, 'sensitivity': 1, 'rung': 8, 'intent': 'customer_fit'},
        'poor_fit': {'value': 2, 'effort': 3, 'sensitivity': 1, 'rung': 8, 'intent': 'poor_fit'},
    },
    'gain': {'missing': 4, 'measurement_flagged': 5, 'measurement_qualitative': 2},
    'relevance': {'default': 3, 'next_rung': 5, 'same_rung': 3, 'ahead': 3, 'behind': 2, 'phase_bonus': 1, 'depth_rung': 5, 'breadth_rung': 3},
    'max_attempts': 2,        # asks on one point before the selector offers to move on
    'repeat_window': 6,       # compared with the last N asked says
    'repeat_num': 4, 'repeat_den': 5,   # similar when intersection / union of word 3-grams >= 4/5 (integers: no float parity risk)
    'wrap_s': 75,             # = cascade.WRAP_S: with this little time left the next move is the closing
    'closing_left_s': 210,    # = gaps.TIME_PLAN['closing_left_s']: only the essentials, then summary and close
    'reflect_min_fields': 3,
    'earned_gap': 3,          # no 'earned' reaction if one of the last 3 moves had it
    'detail_words': 20,       # a longer answer gets a "thanks for the detail" acknowledgement
    'ack_min_words': 8,       # a shorter plain answer gets no acknowledgement
    'span_chars': 60,
    'assessment_stages': ['assessment', 'proof of concept', 'lessons learned'],
    'period_units': ['week', 'month', 'quarter', 'year'],
    'patterns': {
        'number': r"\d+(?:[.,]\d+)?",
        'number_unit': r"(\d+(?:[.,]\d+)?)\s?(?:%|percent|hours?|hrs?|minutes?|mins?|seconds?|days?|weeks?|months?|quarters?|years?|ms|x|times|k|m|users?|tickets?|people|euros?|dollars?|usd|eur)?(?![a-z0-9])",
        'kind_words': r"\b(?:measured|measuring|estimate|estimated|estimates|tracked|approximately|roughly|about|guess|logged)\b",
        'junk': r"[ \t\n\r\f\v?{}]+",
    },
}

# Question bank: intent -> language -> variants. Every variant asks exactly ONE question (one "?") and is open (no yes/no
# leading question); confirm_asr is closed by design (a fact check, not an interview question). No praise anywhere. A variant
# is chosen by how often the intent was asked before, so the same point is worded differently the second time.
# {span} {a} {b} {labels} are filled from the turn / the plan, stripped of "?" and braces.
QUESTION_BANK = {
    # follow-up ladder, one intent per ledger field (rung in CONFIG['fields'])
    'open_exploration': {'en': ['Could you tell me about the project and how you became involved?', 'Could you walk me through what was happening before the project started?',
                                'What was the main problem the team needed to solve?']},
    'stakes': {'en': ['Why did that matter to the business at that point?', 'What was at stake if the problem stayed as it was?', 'Who felt that problem most, and how?']},
    'example': {'en': ['Could you walk me through one concrete change you made?', 'What did that look like in practice, step by step?', 'Which part of the work would be the best example to start with?']},
    'role': {'en': ['What was your role on the project?', 'What was your own role when the project got going?']},
    'ownership': {'en': ['What part of that did you personally take responsibility for?', 'Which decisions or deliverables were yours?',
                         'Who else contributed, and how were the responsibilities divided?']},
    'decision': {'en': ['How did you decide to do it that way?', 'What other options did you consider, and why did you choose this one?', 'What was the hardest decision, and what tipped it?']},
    'evidence': {'en': ['What would help someone verify that, such as a document, dashboard or repository?', 'Which artifact could a reviewer look at to check that?',
                        'Who could confirm that work, and are there limits on sharing it?']},
    'adoption': {'en': ['Who actually used it, and who owned it after you handed it over?', 'Who adopted this in practice?', 'What happened after the handover, and who looked after it?']},
    'impact': {'en': ['What changed for the customer or the team once it was in place?', 'What difference did people notice after the work was delivered?',
                      'How did things look afterwards compared with before?']},
    'impact_assessment': {'en': ['What decision or tested finding came out of this work?', 'What did the assessment let the customer decide or learn?']},
    'measurement': {'en': ['How did you tell that it had made a difference?', 'How, if at all, was that change measured?']},
    'attribution': {'en': ['Which part of that result can fairly be linked to your own work?', 'What else changed at the same time that could have affected the result?',
                           'What would this evidence not justify claiming?']},
    'customer_fit': {'en': ['Which kind of customer situation would this experience help with most?', 'Who else could benefit from what you did here?']},
    'poor_fit': {'en': ['Where would this approach not apply, or what would need to be in place first?', 'In which situations would you not recommend this approach?']},
    # one part of a metric's basis per move
    'metric_kind': {'en': ['Was that figure measured, or is it closer to an estimate?', 'Is that number from a measurement, or a rough estimate?']},
    'metric_period': {'en': ['Over what period was that measured?', 'Which dates or period does that figure cover?']},
    'metric_baseline': {'en': ['What was the figure before the change, for the same measure?', 'What baseline did you compare that against?']},
    'metric_source': {'en': ['Where does that number come from, such as a dashboard or a report?', 'Which source would a reviewer use to check that figure?']},
    # cue repairs
    'vague_example': {'en': ['Could you give me one concrete example of what that involved?', 'What did that look like for one specific piece of work?', 'Which task or deliverable comes to mind first?']},
    'team_ownership': {'en': ['What part of that work did you take on yourself, alongside the team?', 'Within the team effort, which piece was yours?',
                              'How were responsibilities split, and which part sat with you?']},
    'tech_depth': {'en': ['Which of those did you use most hands-on, and for what?', 'Where in the project did you actually work with those, and how deeply?']},
    'cert_details': {'en': ['Who issued that certification, and roughly when did you earn it?', 'Which exact certification was that, and what is its current status?']},
    'praise_source': {'en': ['Who said that, and roughly when?', 'Where did that feedback come from, and who gave it?']},
    'contradiction': {'en': ['I have two versions here, {a} and {b}. Which is accurate, or do they describe different things?',
                             "I've noted both {a} and {b}. How do they fit together, or is one of them off?"]},
    # accepting what the consultant said
    'correction': {'en': ["I'll narrow that to the part you described. What did you personally deliver within it?", "I'll use your version and leave the wider work with the team. Which piece was yours?"]},
    'correction_number': {'en': ["I'll use your figure instead. How was that number arrived at?", "Understood, I'll record it your way. What does that figure measure exactly?"]},
    'anonymise': {'en': ['We can keep names out of this. What can you say about the situation in general terms?',
                         "We can leave out the details you can't share. How would you describe it without naming anyone?"]},
    'offer_move_on': {'en': ['We can leave that open for now. What would you like to cover instead?', "That's fine, we don't have to settle it. What shall we turn to next?",
                             'It can stay open. Which part of the project would you rather talk about?']},
    # speech recognition: a closed check by design, then a repair when the consultant says no
    'confirm_asr': {'en': ['Just to check I heard right: was that {span}?', 'Sorry, I want to be sure: did you say {span}?', 'Quick check on what I heard: was it {span}?']},
    'asr_repair': {'en': ['Sorry, I may have misheard. What should I have written down?', 'Thanks for catching that. What was the right one?']},
    # one look back when the interview moves to depth
    'reflect': {'en': ["So far we've covered {labels}. What important thing have I missed?", 'I have {labels} so far. What would you add before we go deeper?']},
}
# Spoken lines that are not questions (no "?"): the hand to the read-back summary, and the close.
LINES = {
    'summary': {'en': ["Let me read back what I have so far, and you can tell me what I've misunderstood or missed.", "I'll read back what I've captured so far; please correct anything that's off."]},
    'close': {'en': ["That's all the time we have. Thank you for sharing this; I'll prepare your summary for you to review and correct.",
                     "We're at the end of our time. Thanks for walking me through it; you'll be able to review what I captured."]},
}
REPEAT_LAST = 'repeat_last'   # why-code of a move that puts the previous question again after a pause, a repeat request or a question to ATLAS
LEAD_RUSHED = "No problem, let's keep to the essentials."   # said once, before the first question of a rushed interview

# Intents asked about a ledger field that do not count as an attempt at the field's own question.
NOT_ATTEMPTS = ['offer_move_on', 'confirm_asr', 'asr_repair', 'correction', 'correction_number', 'anonymise', 'contradiction', 'reflect'] + METRIC_PARTS
FIELD_KEYS = list(FIELDS)

_FLAGS = re.I | re.A
_COMPILED = {}


def _re(src, flags=_FLAGS):
    k = (src, flags)
    r = _COMPILED.get(k)
    if r is None:
        r = _COMPILED[k] = re.compile(src, flags)
    return r


# ----- text helpers (identical on the JS side) -----

def _tokens(text):
    t = unicodedata.normalize('NFD', text or '')
    t = ''.join(c for c in t if not '̀' <= c <= 'ͯ').lower()
    return re.findall(r"[a-z0-9']+", t)


def _grams(text):
    toks = _tokens(text)
    if not toks:
        return set()
    if len(toks) < 3:
        return {' '.join(toks)}
    return {' '.join(toks[i:i + 3]) for i in range(len(toks) - 2)}


def similar(a, b):
    """Word 3-gram Jaccard >= 0.8, computed in integers (repeat_num / repeat_den)."""
    ga, gb = _grams(a), _grams(b)
    if not ga or not gb:
        return False
    inter = len(ga & gb)
    union = len(ga | gb)
    return inter * CONFIG['repeat_den'] >= union * CONFIG['repeat_num']


def _clean(text):
    """A span or value dropped into a question: no "?", braces or line breaks, at most span_chars characters."""
    s = _re(CONFIG['patterns']['junk'], 0).sub(' ', text if isinstance(text, str) else '').strip()
    return s[:CONFIG['span_chars']].strip()


def _render(template, params):
    return re.sub(r'\{(\w+)\}', lambda m: params[m.group(1)] if m.group(1) in params else m.group(0), template)


# ----- reading the inputs -----

def _present_fields(plan):
    """Fields with an active candidate that is not an "unknown" (those are deferred instead); or, for a hand-made plan, those not in `missing`."""
    present = set()
    details = plan.get('candidate_details')
    if isinstance(details, list):
        present |= {d.get('field') for d in details if isinstance(d, dict) and d.get('active', True) and d.get('status') != 'unknown'}
    if isinstance(plan.get('missing'), list) and not details:
        present |= set(FIELD_KEYS) - set(plan['missing'])
    return {f for f in present if f in FIELDS}


def _ledger_paused(plan):
    out = set()
    for d in plan.get('candidate_details') or []:
        if isinstance(d, dict) and d.get('active', True) and d.get('status') == 'unknown':
            out.add(d.get('field'))
    if isinstance(plan.get('unresolved_fields'), list):
        out |= set(plan['unresolved_fields'])
    if isinstance(plan.get('deferred_fields'), dict):
        out |= set(plan['deferred_fields'])
    return {f for f in out if f in FIELDS}


def _prefilled_fields(prefill):
    out = set()
    if not isinstance(prefill, dict):
        return out
    notes = prefill.get('prior_notes')
    if isinstance(notes, dict):
        notes = notes.get('fields', notes) if isinstance(notes.get('fields'), (list, dict)) else notes
    if isinstance(notes, dict):
        out |= {k for k, v in notes.items() if k in FIELDS and v}
    elif isinstance(notes, list):
        out |= {k for k in notes if isinstance(k, str) and k in FIELDS}
    out |= {k for k in FIELD_KEYS if prefill.get(k)}
    return out


def _numbers_in(quote):
    return [(m.group(1), ' '.join(m.group(0).split())) for m in _re(CONFIG['patterns']['number_unit']).finditer(quote or '')]


def contradiction(plan):
    """(field, a, b) for the first field with two ACTIVE candidates whose numbers each hold a value the other lacks; else None.
    {25} and {40} differ; {2, 25} and {25} do not (one version only adds a number)."""
    by = {}
    for d in plan.get('candidate_details') or []:
        if isinstance(d, dict) and d.get('active', True) and d.get('field') in FIELDS and isinstance(d.get('quote'), str):
            by.setdefault(d['field'], []).append(d['quote'])
    for f in FIELD_KEYS:
        qs = by.get(f, [])
        for i in range(len(qs)):
            for j in range(i + 1, len(qs)):
                na, nb = _numbers_in(qs[i]), _numbers_in(qs[j])
                sa, sb = {n for n, _ in na}, {n for n, _ in nb}
                if sa and sb and not sa <= sb and not sb <= sa:
                    a = next(t for n, t in na if n not in sb)
                    b = next(t for n, t in nb if n not in sa)
                    return f, _clean(a), _clean(b)
    return None


def effective_phase(phase, time_left):
    """The more pressing of the phase given and the one the time left implies (session.js and cascade.pace_notes use the same limits)."""
    idx = PHASES.index(phase) if phase in PHASES else 0
    if isinstance(time_left, (int, float)) and not isinstance(time_left, bool):
        if time_left <= CONFIG['wrap_s']:
            idx = max(idx, 3)
        elif time_left <= CONFIG['closing_left_s']:
            idx = max(idx, 2)
    return PHASES[idx]


def _context(plan, turn, asked, prefill, phase, time_left, rushed):
    plan = plan if isinstance(plan, dict) else {}
    turn = turn if isinstance(turn, dict) else {}
    asked = [a for a in (asked if isinstance(asked, list) else []) if isinstance(a, dict)]
    prefill = prefill if isinstance(prefill, dict) else {}
    intents = [i for i in turn.get('intents', []) if isinstance(i, str)] if isinstance(turn.get('intents'), list) else []
    cues = [c for c in turn.get('cues', []) if isinstance(c, str)] if isinstance(turn.get('cues'), list) else []
    hints = [h for h in turn.get('field_hints', []) if h in FIELDS] if isinstance(turn.get('field_hints'), list) else []
    words = turn.get('words') if isinstance(turn.get('words'), int) and not isinstance(turn.get('words'), bool) else 0
    last = asked[-1] if asked else None
    last_field = last.get('field') if last and last.get('field') in FIELDS else None
    answer_shaped = words >= 1 and not any(i in NOT_AN_ANSWER for i in intents)
    covered_now = set(hints) | {f for f in (plan.get('covered_fields') if isinstance(plan.get('covered_fields'), list) else []) if f in FIELDS}   # covered_fields: optional union of earlier turns' hints the ledger has not caught up with yet
    rung = lambda f: CONFIG['fields'][f]['rung']
    # the thread is where the consultant's answer got furthest along the ladder (the asked field wins a tie), else the field just asked
    thread = max(hints, key=lambda f: (rung(f), f == last_field, -FIELD_KEYS.index(f))) if hints else last_field
    present = _present_fields(plan)
    flags = plan.get('flags') if isinstance(plan.get('flags'), list) else []
    numeric_plan = bool(plan.get('measurement_gaps')) or any(isinstance(f, str) and f.startswith('Numerical outcome lacks') for f in flags)
    deferred = _ledger_paused(plan)
    for a in asked:
        m = re.match(r'^(?:dont_know|cannot_disclose|skip):([a-z_]+)(?:>|$)', a.get('why') if isinstance(a.get('why'), str) else '')
        if m and m.group(1) in FIELDS:
            deferred.add(m.group(1))
        if a.get('intent') == 'offer_move_on' and a.get('field') in FIELDS:
            deferred.add(a['field'])
    c = {
        'plan': plan, 'turn': turn, 'asked': asked, 'prefill': prefill, 'intents': intents, 'cues': cues, 'hints': hints, 'words': words,
        'numbers': turn.get('numbers') if isinstance(turn.get('numbers'), list) else [], 'last': last, 'last_field': last_field,
        'answer_shaped': answer_shaped, 'covered_now': covered_now, 'thread': thread, 'present': present, 'numeric_plan': numeric_plan,
        'deferred': deferred, 'prefilled': _prefilled_fields(prefill), 'rushed': bool(rushed) or 'rushed' in intents,
        'phase': effective_phase(phase, time_left), 'recent': [a.get('say') for a in asked[-CONFIG['repeat_window']:] if isinstance(a.get('say'), str)],
    }
    return c


def _real(a):
    """A move that is not just the previous question put again (those neither count as an attempt nor rotate the wording)."""
    return a.get('why') != REPEAT_LAST


def _count(c, intent, field=None, any_field=False):
    return sum(1 for a in c['asked'] if _real(a) and a.get('intent') == intent and (any_field or a.get('field') == field))


def _attempts(c, field):
    return sum(1 for a in c['asked'] if _real(a) and a.get('field') == field and a.get('intent') not in NOT_ATTEMPTS)


def _summarized(c):
    return any(a.get('kind') == 'summary' or a.get('intent') == 'summary' for a in c['asked'])


def _say(c, cand):
    """The wording for a candidate: the variant its count points at, else the next, skipping any that repeats a recent say."""
    entry = QUESTION_BANK[cand['intent']]
    bank = entry['en']
    start = _count(c, cand['intent'], any_field=True) % len(bank)
    lead = LEAD_RUSHED + ' ' if c['rushed'] and cand.get('lead') and not any(isinstance(a.get('why'), str) and 'rushed:' in a['why'] for a in c['asked']) else ''
    for k in range(len(bank)):
        text = lead + _render(bank[(start + k) % len(bank)], cand.get('params', {}))
        if not any(similar(text, r) for r in c['recent']):
            return text, ('' if k == 0 else '+rv')
    return None


# ----- candidates, in priority order -----

def _metric_part(c):
    """The next unanswered part of a metric's basis, or None: kind (measured or estimated), period, baseline, source."""
    plan, cues = c['plan'], c['cues']
    gaps = plan.get('measurement_gaps')
    known = 'measurement' in c['present'] and isinstance(gaps, list)   # the ledger holds a measurement account and says what it still lacks
    quotes = ' '.join(d.get('quote', '') for d in plan.get('candidate_details') or []
                      if isinstance(d, dict) and d.get('active', True) and d.get('field') in ('measurement', 'outcome') and isinstance(d.get('quote'), str))
    last = c['last']
    done = {a.get('intent') for a in c['asked'][:-1] if _real(a) and a.get('intent') in METRIC_PARTS}
    if last and last.get('intent') in METRIC_PARTS and c['answer_shaped']:
        done.add(last['intent'])
    if done:   # a later part asked means the earlier ones were settled or skipped (an estimate needs no "measured or estimated?")
        done |= set(METRIC_PARTS[:max(METRIC_PARTS.index(p) for p in done) + 1])
    units = {n.get('unit') for n in c['numbers'] if isinstance(n, dict)}
    if 'metric_kind' not in done and 'estimate' not in cues and not _re(CONFIG['patterns']['kind_words']).search(quotes):
        return 'metric_kind'
    if 'metric_period' not in done and not (known and 'period' not in gaps) and not any(u in CONFIG['period_units'] for u in units):
        return 'metric_period'
    if 'metric_baseline' not in done and len(c['numbers']) < 2 and not (known and 'before/after' not in gaps):
        return 'metric_baseline'
    if 'metric_source' not in done and not ({'evidence'} & (c['present'] | c['covered_now'] | c['prefilled'])):
        return 'metric_source'
    return None


def _ladder(c):
    """Ladder candidates for the fields still worth asking, best first. Returns (field, score) pairs."""
    cfg = CONFIG
    rung = lambda f: cfg['fields'][f]['rung']
    out = []
    for i, f in enumerate(FIELD_KEYS):
        fc = cfg['fields'][f]
        if f in c['deferred'] or f in c['present'] or f in c['covered_now'] or f in c['prefilled']:
            continue   # redundancy: known, covered by this turn's hints (the ledger lags a turn), prefilled, or left open on purpose
        if c['rushed'] and f not in ESSENTIALS:
            continue
        if c['phase'] == 'closing' and f not in ESSENTIALS:
            continue
        gain = cfg['gain']['missing']
        if f == 'measurement':
            if c['numeric_plan']:
                gain = cfg['gain']['measurement_flagged']
            elif 'outcome' in c['present'] or 'outcome' in c['covered_now']:
                gain = cfg['gain']['measurement_qualitative']
            else:
                continue
        rel = cfg['relevance']
        if c['thread'] is None:
            relevance = rel['default']
        else:
            d = rung(f) - rung(c['thread'])
            relevance = rel['next_rung'] if d == 1 else rel['same_rung'] if d == 0 else rel['ahead'] if d > 1 else rel['behind']
        if c['phase'] == 'depth' and rung(f) >= rel['depth_rung']:
            relevance += rel['phase_bonus']
        elif c['phase'] == 'breadth' and rung(f) <= rel['breadth_rung']:
            relevance += rel['phase_bonus']
        tries = _attempts(c, f)
        exhausted = tries >= cfg['max_attempts']   # no re-ask penalty: an exhausted point is offered for moving on as soon as it is the best next thing
        score = fc['value'] * gain * relevance - fc['effort'] * cfg['weights']['effort'] - fc['sensitivity'] * cfg['weights']['sensitivity'] \
            - (0 if exhausted else cfg['weights']['asked'] * tries)
        if score > 0 or exhausted:
            out.append((score, i, f))
    out.sort(key=lambda t: (-t[0], t[1]))
    return [(f, s) for s, _, f in out]


def _candidates(c):
    cues, rushed = c['cues'], c['rushed']
    cueing = not rushed and c['phase'] in ('breadth', 'depth')
    last_intent = c['last'].get('intent') if c['last'] else None
    if cueing:
        hit = contradiction(c['plan'])
        if hit:
            f, a, b = hit
            yield {'intent': 'contradiction', 'field': f, 'rung': CONFIG['fields'][f]['rung'], 'params': {'a': a, 'b': b}, 'why': 'contradiction:' + f, 'important': True}
        continuing = last_intent in METRIC_PARTS and c['answer_shaped']
        if 'measurement' not in c['deferred'] and ('metric' in cues or continuing or (c['numeric_plan'] and 'measurement' in c['hints'])):
            part = _metric_part(c)
            if part:
                yield {'intent': part, 'field': 'measurement', 'rung': 7, 'params': {}, 'why': 'metric:' + part[7:], 'important': True}
        if 'vague_verb' in cues or last_intent == 'vague_example':
            if last_intent == 'vague_example' or _count(c, 'vague_example', 'intervention') >= CONFIG['max_attempts']:
                if not ({'contribution'} & (c['present'] | c['covered_now'])) and last_intent not in ('ownership', 'role'):
                    yield {'intent': 'ownership', 'field': 'contribution', 'rung': 3, 'params': {}, 'why': 'vague:ownership', 'important': False}
            elif last_intent not in ('ownership', 'team_ownership'):
                yield {'intent': 'vague_example', 'field': 'intervention', 'rung': 2, 'params': {}, 'why': 'vague:example', 'important': False}
        if 'team_claim' in cues and last_intent not in ('team_ownership', 'ownership', 'role', 'vague_example') \
                and 'contribution' not in c['present'] and 'contribution' not in c['covered_now'] and 'contribution' not in c['prefilled']:
            yield {'intent': 'team_ownership', 'field': 'contribution', 'rung': 3, 'params': {}, 'why': 'team_claim', 'important': False}
        if 'tech_list' in cues and last_intent != 'tech_depth':
            yield {'intent': 'tech_depth', 'field': None, 'rung': 2, 'params': {}, 'why': 'tech_list', 'important': False}
        if 'certification' in cues and last_intent != 'cert_details':
            yield {'intent': 'cert_details', 'field': None, 'rung': None, 'params': {}, 'why': 'certification', 'important': False}
        if 'client_praise' in cues and last_intent != 'praise_source':
            yield {'intent': 'praise_source', 'field': None, 'rung': None, 'params': {}, 'why': 'client_praise', 'important': False}
        if c['phase'] == 'depth' and len(c['present']) >= CONFIG['reflect_min_fields'] and not any(a.get('kind') == 'reflect' or a.get('intent') == 'reflect' for a in c['asked']):
            labels = [FIELDS[f][0].lower() for f in FIELD_KEYS if f in c['present']][:3]
            text = labels[0] if len(labels) == 1 else ', '.join(labels[:-1]) + ' and ' + labels[-1]
            yield {'intent': 'reflect', 'kind': 'reflect', 'field': None, 'rung': None, 'params': {'labels': text}, 'why': 'reflect:depth', 'important': False}
    for f, _ in _ladder(c):
        fc = CONFIG['fields'][f]
        intent = fc['intent']
        if f == 'contribution' and not (c['prefill'].get('role') or _count(c, 'role', 'contribution')):
            intent = 'role'
        elif f == 'outcome' and str(c['prefill'].get('stage', '')).lower() in CONFIG['assessment_stages']:
            intent = 'impact_assessment'
        elif f == 'measurement' and c['numeric_plan']:
            intent = _metric_part(c)
            if intent is None:
                continue
        yield {'intent': intent, 'field': f, 'rung': fc['rung'], 'params': {}, 'why': ('rushed:' if rushed else '') + 'ladder:' + f, 'important': True, 'lead': rushed}


LADDER_INTENTS = [v['intent'] for v in CONFIG['fields'].values()] + ['role', 'impact_assessment']


def _blocked(c, cand):
    """True once the point has been asked twice: a ladder point counts every attempt on its field, other intents their own."""
    f, intent = cand['field'], cand['intent']
    if intent in LADDER_INTENTS and f in FIELDS:
        return _attempts(c, f) >= CONFIG['max_attempts']
    return _count(c, intent, f) >= CONFIG['max_attempts']


def _pick(c):
    """The first candidate that is neither deferred nor exhausted nor a repeat, with its words filled in; None when nothing is left."""
    suffix = ''
    for cand in _candidates(c):
        f = cand['field']
        if f in c['deferred']:
            continue
        if _blocked(c, cand):
            if cand['important'] and f in FIELDS and not any(a.get('intent') == 'offer_move_on' and a.get('field') == f for a in c['asked']):
                offer = {'intent': 'offer_move_on', 'kind': 'offer_move_on', 'field': f, 'rung': cand['rung'], 'params': {}, 'why': 'blocked:' + cand['intent'] + ':' + f}
                said = _say(c, offer)
                if said:
                    offer['say'] = said[0]
                    return offer
            continue
        said = _say(c, cand)
        if said is None:
            suffix = '+ri'
            continue
        cand['say'] = said[0]
        cand['why'] += said[1] + suffix
        return cand
    return None


# ----- reactions -----

def _reaction(c, accept=None):
    """(reaction, ack_category) for the consultant's latest answer. earned_result needs an achievement cue AND a known basis."""
    cues = c['cues']
    if accept == 'correction':
        return 'ack', 'correction_thanks'
    if 'describes_setback' in cues:
        return 'ack', 'setback_neutral'
    if accept in ('dont_know', 'skip'):
        numeric = c['thread'] in ('measurement', 'outcome') or 'metric' in cues or (c['last'] and c['last'].get('intent') in METRIC_PARTS + ['measurement', 'impact'])
        return 'ack', 'no_number_fine' if numeric else 'neutral'
    if accept == 'cannot_disclose':
        return 'ack', 'confidential_ok'
    if 'metric' in cues and 'measurement' not in c['present']:
        if 'describes_achievement' in cues or 'estimate' in cues:
            return 'ack', 'promising_unverified'
    basis_known = 'measurement' in c['present'] and not c['plan'].get('measurement_gaps')
    recent_earned = any(a.get('reaction') == 'earned' for a in c['asked'][-CONFIG['earned_gap']:])
    if 'describes_achievement' in cues and basis_known and not recent_earned:
        return 'earned', 'earned_result'
    if c['words'] >= CONFIG['detail_words']:
        return 'ack', 'thanks_detail'
    if c['words'] >= CONFIG['ack_min_words']:
        return 'ack', 'neutral'
    return 'none', None


def _move(kind, cand, say, why, reaction):
    return {'kind': kind, 'intent': cand['intent'], 'field': cand.get('field'), 'rung': cand.get('rung'), 'say': say, 'why': why,
            'reaction': reaction[0], 'ack_category': reaction[1]}


def _line(c, kind, why, reaction=('none', None)):
    bank = LINES[kind]['en']
    n = _count(c, kind, any_field=True) % len(bank)
    return {'kind': kind, 'intent': kind, 'field': None, 'rung': None, 'say': bank[n], 'why': why, 'reaction': reaction[0], 'ack_category': reaction[1]}


def _end(c, why, reaction=('none', None)):
    """No question is left: the read-back summary first, then the close."""
    if _summarized(c):
        return _line(c, 'close', 'close:' + why, reaction)
    return _line(c, 'summary', 'summary:' + why, reaction)


def _defer_field(c):
    if c['last_field'] in c['hints']:
        return c['last_field']
    return c['hints'][0] if c['hints'] else c['last_field']


def select(plan, turn, asked, prefill, phase, time_left, asr=None, rushed=False, lang='en'):
    """The next move. See the module docstring for the rules; every argument is optional data, a malformed one is ignored."""
    c = _context(plan, turn, asked, prefill, phase, time_left, rushed)
    intents, last = c['intents'], c['last']
    # 1. time is up: close, no question
    if c['phase'] == 'wrap':
        return _line(c, 'close', 'close:wrap')
    # 2. a span of speech the recogniser was unsure of (once per span), or the repair after a "no"
    if last and last.get('intent') == 'confirm_asr' and 'deny' in intents:
        cand = {'intent': 'asr_repair', 'field': None, 'rung': None, 'params': {}}
        said = _say(c, cand)
        if said and _count(c, 'asr_repair', any_field=True) < CONFIG['max_attempts']:
            return _move('ask', cand, said[0], 'asr_repair' + said[1], ('none', None))
    for span in asr if isinstance(asr, list) else []:
        text = _clean(span.get('text')) if isinstance(span, dict) else ''
        if not text or any(a.get('intent') == 'confirm_asr' and text.lower() in str(a.get('say', '')).lower() for a in c['asked']):
            continue
        cand = {'intent': 'confirm_asr', 'field': None, 'rung': None, 'params': {'span': text}}
        said = _say(c, cand)
        if said is None:
            said = (_render(QUESTION_BANK['confirm_asr']['en'][_count(c, 'confirm_asr', any_field=True) % 3], cand['params']), '+rv')
        return _move('confirm_asr', cand, said[0], 'asr_span' + said[1], ('none', None))
    # 3. the consultant wants to stop
    if 'stop' in intents:
        return _end(c, 'stop')
    # 4. a correction: use their version, narrow
    if 'correction' in intents:
        number = bool(c['numbers'])
        cand = {'intent': 'correction_number' if number else 'correction', 'field': c['thread'], 'rung': 7 if number else 3, 'params': {}}
        said = _say(c, cand)
        text = said[0] if said else _render(QUESTION_BANK[cand['intent']]['en'][0], {})
        return _move('accept_and_move', cand, text, 'correction' + (said[1] if said else ''), _reaction(c, 'correction'))
    # 5. a pause, a "say that again" or a question to ATLAS leaves the last question unanswered: put it again (not an attempt)
    if last and '?' in str(last.get('say', '')) and any(i in intents for i in ('pause', 'resume', 'repeat', 'question_to_atlas')):
        return {'kind': last['kind'] if last.get('kind') in ('confirm_asr', 'offer_move_on', 'reflect') else 'ask', 'intent': last.get('intent'),
                'field': last.get('field'), 'rung': last.get('rung'), 'say': last['say'], 'why': REPEAT_LAST, 'reaction': 'none', 'ack_category': None}
    # 5b. right after the read-back summary, a short reply ends the interview
    if last and (last.get('kind') == 'summary' or last.get('intent') == 'summary') and (c['words'] <= 6 or 'confirm' in intents):
        return _line(c, 'close', 'close:after_summary')
    # 6. "I don't know" / "I can't share" / skip: accept, leave the field open, ask something else (never that field again)
    accept = next((i for i in ('cannot_disclose', 'dont_know', 'skip') if i in intents), None)
    if accept:
        field = _defer_field(c)
        if field:
            c['deferred'].add(field)
        tag = accept + ':' + (field or '-')
        if accept == 'cannot_disclose' and field and not _count(c, 'anonymise', field):
            cand = {'intent': 'anonymise', 'field': field, 'rung': CONFIG['fields'][field]['rung'], 'params': {}}
            said = _say(c, cand)
            if said:
                return _move('accept_and_move', cand, said[0], tag + '>anonymise' + said[1], _reaction(c, accept))
        cand = _pick(c)
        if cand is None:
            return _end_after(c, tag, accept)
        return _move('accept_and_move', cand, cand['say'], tag + '>' + cand['why'], _reaction(c, accept))
    # 7. everything else: the best question
    cand = _pick(c)
    if cand is None:
        return _end(c, 'essentials' if c['rushed'] else 'closing' if c['phase'] == 'closing' else 'no_candidates')
    kind = cand.get('kind', 'ask')
    why = cand['why']
    reaction = ('none', None) if kind in ('offer_move_on', 'reflect') or cand['intent'] == 'contradiction' else _reaction(c)
    return _move(kind, cand, cand['say'], why, reaction)


def _end_after(c, tag, accept):
    end = _end(c, 'no_candidates', _reaction(c, accept))
    end['why'] = tag + '>' + end['why']
    return end


EDGE_CONSTANTS = {'SELECTOR_CONFIG': CONFIG, 'QUESTION_BANK': QUESTION_BANK, 'SELECTOR_LINES': LINES, 'SELECTOR_LEAD_RUSHED': LEAD_RUSHED,
                  'SELECTOR_NOT_ATTEMPTS': NOT_ATTEMPTS, 'SELECTOR_PHASES': PHASES, 'SELECTOR_ESSENTIALS': ESSENTIALS, 'SELECTOR_METRIC_PARTS': METRIC_PARTS}
