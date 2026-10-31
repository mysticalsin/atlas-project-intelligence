"""Adaptive interview length (Tony, 2026-10-31): "20-30 min to get everything we need".

The interview is planned for INTERVIEW_SOFT_S of active time (paused time excluded; the 45-minute wall cap is separate). When that end is near and the
selector still has an essential question to ask (essential fields, open speech-recognition doubts, figures that disagree), ATLAS asks ONCE, politely, whether
the consultant can spare a few more minutes on that point. A yes moves the end to INTERVIEW_HARD_S, the hard cap; a no, a hurry or anything unclear goes to the
read-back now. A rushed consultant is never asked. If nothing essential is left the selector closes early, as before. This module is pure data and functions:
build_edge.py exports EDGE_CONSTANTS and src/extension.js ports the functions (parity vectors, test/gen_extension_parity.py).
"""

INTERVIEW_SOFT_S = 1200   # the planned end: 20 minutes of active interview time
INTERVIEW_HARD_S = 1800   # the end once the consultant agreed to continue, and the cap whatever happens: 30 minutes of active time
CLOSING_LEFT_S = 270      # = gaps.TIME_PLAN['closing_left_s']: the offer is made when this much of the planned end is left, so a read-back always fits before it
EXTENSION_OFFER = "We've covered most of it. Could we take a few more minutes on {point}?"
# How each open point is named aloud: the interview fields, and the selector moves that have no field.
POINTS = {
    'problem': 'what the problem was', 'stakes': 'what was at stake for the client', 'contribution': 'what you personally did', 'intervention': 'what was done',
    'decision': 'the options you weighed', 'adoption': 'who used it afterwards', 'outcome': 'what changed', 'measurement': 'how the change was measured',
    'evidence': 'something a reviewer could look at', 'limitations': 'what else may have affected the result', 'customer_fit': 'which other clients it would help',
    'poor_fit': 'where it would not work as well',
    '_asr': 'a few words I want to check I heard right', '_contradiction': 'the two figures that differ', '_other': 'a couple of remaining points',
}
# Selector move kinds that are still a question to the consultant (summary and close are not).
QUESTION_KINDS = ('ask', 'confirm_asr', 'reflect', 'accept_and_move')  # (an offer to move on from a stuck point is no reason to ask for more time)
# Replies to the offer that decline it, and the one that agrees.
REFUSING = ('deny', 'stop', 'rushed', 'skip', 'dont_know', 'cannot_disclose')
YES_MAX_WORDS = 14  # a yes is a short answer: a longer reply that merely starts with one ("Yes, but I have a meeting in ten minutes ...") is not a clean yes


def hard_limit(soft_s):
    """The hard cap for a planned end of soft_s seconds (proportional, so a short test session scales the same way)."""
    return round(soft_s * INTERVIEW_HARD_S / INTERVIEW_SOFT_S)


def offer_point(field, intent):
    """The open point a move is about, as ATLAS says it."""
    if intent == 'confirm_asr' or intent == 'asr_repair': return POINTS['_asr']
    if intent == 'contradiction': return POINTS['_contradiction']
    return POINTS[field] if isinstance(field, str) and not field.startswith('_') and field in POINTS else POINTS['_other']


def offer_text(field, intent):
    return EXTENSION_OFFER.format(point=offer_point(field, intent))


def should_offer(kind, rushed, extension, time_left, closing_left_s=CLOSING_LEFT_S):
    """Whether the move the selector chose (kind) is replaced by the offer: a question is still essential, the planned end is near, the consultant is not in a
    hurry, and the offer has not been made. extension: None (never offered), 'offered', 'accepted' or 'refused'."""
    return extension is None and not rushed and kind in QUESTION_KINDS and time_left <= closing_left_s


def reply(intents, words=None):
    """'accepted' or 'refused': the consultant's answer to the offer, from the turn pre-pass. Only an explicit yes (the `confirm` intent) extends the interview; a refusal,
    a long answer that says neither, and any language the intent rules do not cover all mean no (red M9: a long reply used to count as yes, so a polite refusal
    in French or Russian extended the interview to 30 minutes). The yes must also be short (YES_MAX_WORDS) and `words` must be known."""
    intents = [i for i in intents if isinstance(i, str)]
    if any(i in REFUSING for i in intents): return 'refused'
    return 'accepted' if 'confirm' in intents and isinstance(words, int) and words <= YES_MAX_WORDS else 'refused'


EDGE_CONSTANTS = {'INTERVIEW_HARD_S': INTERVIEW_HARD_S, 'EXTENSION_OFFER': EXTENSION_OFFER, 'EXTENSION_POINTS': POINTS, 'EXTENSION_QUESTION_KINDS': list(QUESTION_KINDS),
                  'EXTENSION_REFUSING': list(REFUSING), 'EXTENSION_YES_MAX_WORDS': YES_MAX_WORDS}
