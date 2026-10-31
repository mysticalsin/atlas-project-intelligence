"""Uncertain speech spans (Agent Brain v2.1 §3f): which words of an utterance the recogniser was unsure of AND that matter.

uncertain_spans() reads the per-word confidences of one utterance ([{w, c, s, e}]: word, confidence 0..1, start and end seconds)
and returns the spans worth a spoken check, never a guess at the right word: numbers (digits or number words), the token next to a
percent or currency marker, and capitalised words that do not start a sentence (proper nouns, product and client names). A span is
reported only when its weakest word is below tau. The rule behind it: an unclear number or proper noun is confirmed, never silently
converted. Nothing here describes the person; it reports words of the transcript.

Pure and deterministic (no I/O, no model, no clock). build_edge.py exports EDGE_CONSTANTS and src/asr.js ports the functions
(parity vectors: test/gen_asr_parity.py -> test/asr.vectors.json). Only plain string operations are used, so Python and
JavaScript read every token identically.
"""
import re

TAU = 0.55            # default threshold; the Worker reads ASR_CONFIRM_TAU
MAX_WORDS = 400       # words read from one utterance (the transcriber bounds its output the same way)
MAX_SPANS = 6
MAX_TEXT_WORDS = 200  # words read from a correcting utterance by replacement()
MAX_TOKEN_CHARS = 40

PUNCT = '.,;:!?"\'“”‘’()[]{}…—–-'      # stripped from both ends of a token (never from inside: "3.5", "can't")
CLOSERS = '"\'”’)]}'                 # may follow the full stop that ends a sentence
SENTENCE_END = '.!?…'
NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
                'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty',
                'ninety', 'hundred', 'thousand', 'million', 'billion', 'trillion']
UNIT_AFTER = ['%', 'percent', 'dollar', 'dollars', 'euro', 'euros', 'pound', 'pounds', 'cent', 'cents', 'usd', 'eur', 'gbp']   # the number comes before
UNIT_BEFORE = ['$', '€', '£', '¥']                                                                                        # the number comes after
SLOT_AFTER = ['%', 'percent']   # only these (and UNIT_BEFORE) make a neighbouring non-number word a suspect number: "saved euros" is not
STOPWORDS = ['a', 'an', 'the', 'of', 'in', 'on', 'by', 'to', 'and', 'or', 'is', 'was', 'were', 'are', 'about', 'for', 'with', 'at', 'per',
             'it', 'that', 'this', 'than', 'from', 'as', 'so', 'but', 'my', 'our', 'we', 'i']
I_WORDS = ['i', "i'm", "i'll", "i've", "i'd"]
_DECIMAL = re.compile(r'\s*(?:[0-9]+\.?[0-9]*|\.[0-9]+)\s*')


def _core(token):
    return token.strip(PUNCT)


def _number(core):
    if any('0' <= ch <= '9' for ch in core):
        return True
    return all(part in NUMBER_WORDS for part in core.lower().split('-'))


def _upper_first(core):
    ch = core[:1]
    return ch != '' and ch.lower() != ch and ch.upper() == ch


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float('inf'), float('-inf')) else None


def _clean(words, limit):
    out = []
    for item in words[:limit] if isinstance(words, list) else []:
        item = item if isinstance(item, dict) else {}
        w = item.get('w')
        out.append({'w': w[:MAX_TOKEN_CHARS] if isinstance(w, str) else '', 'c': _num(item.get('c')), 's': _num(item.get('s')), 'e': _num(item.get('e'))})
    return out


def _groups(words):
    """Runs of consecutive tokens that form one number (with its unit marker) or one proper noun: [{kind, indices, text}]."""
    n = len(words)
    cores = [_core(x['w']) for x in words]
    low = [c.lower() for c in cores]
    role = [None] * n          # 'number' | 'proper_noun' | 'after' | 'before' | None
    for i in range(n):
        if not cores[i]:
            continue
        if low[i] in UNIT_AFTER:
            role[i] = 'after'
        elif low[i] in UNIT_BEFORE:
            role[i] = 'before'
        elif _number(cores[i]):
            role[i] = 'number'
        elif _upper_first(cores[i]) and len(cores[i]) >= 2 and low[i] not in I_WORDS:
            prev = words[i - 1]['w'].rstrip(CLOSERS) if i else ''
            if i and not (prev and prev[-1] in SENTENCE_END):    # not the first word of a sentence
                role[i] = 'proper_noun'
    # the word right next to a unit marker is where the number should be, so a misheard one ("dirty percent") is a number too
    for i in range(n):
        if role[i] == 'after' and low[i] in SLOT_AFTER and i and role[i - 1] is None and cores[i - 1] and low[i - 1] not in STOPWORDS:
            role[i - 1] = 'number'
        elif role[i] == 'before' and i + 1 < n and role[i + 1] is None and cores[i + 1] and low[i + 1] not in STOPWORDS:
            role[i + 1] = 'number'
    groups, current = [], None
    for i in range(n):
        if role[i] is None:
            current = None
            continue
        kind = 'proper_noun' if role[i] == 'proper_noun' else 'number'
        # a new group when the kind changes, after an "after" marker (5 percent | 10 percent) and before a "before" marker ($5 | $7)
        if current is None or current['kind'] != kind or role[i - 1] == 'after' or (role[i] == 'before' and role[i - 1] != 'before'):
            current = {'kind': kind, 'indices': []}
            groups.append(current)
        current['indices'].append(i)
    out = []
    for g in groups:
        # a lone marker is not a span, and a lone "one" is mostly a pronoun ("the one thing"), not a figure
        if any(role[i] in ('number', 'proper_noun') for i in g['indices']) and not (len(g['indices']) == 1 and low[g['indices'][0]] == 'one'):
            out.append({'kind': g['kind'], 'indices': g['indices'], 'text': ' '.join(cores[i] for i in g['indices'])})
    return out


def uncertain_spans(words, tau=TAU):
    """Merged spans [{text, kind, min_conf, start, end}] whose weakest word is below tau. Numbers first, then the weakest first.
    Words without a usable confidence are skipped (no confidence is no evidence of doubt); a malformed input gives no spans."""
    words = _clean(words, MAX_WORDS)
    tau = tau_from(tau)
    spans = []
    for g in _groups(words):
        confs = [words[i]['c'] for i in g['indices'] if words[i]['c'] is not None]
        if not confs or min(confs) >= tau:
            continue
        first, last = words[g['indices'][0]], words[g['indices'][-1]]
        spans.append({'text': g['text'], 'kind': g['kind'], 'min_conf': min(confs), 'start': first['s'], 'end': last['e'], 'at': g['indices'][0]})
    spans.sort(key=lambda s: (s['kind'] != 'number', s['min_conf'], s['at']))
    return [{k: v for k, v in s.items() if k != 'at'} for s in spans[:MAX_SPANS]]


def replacement(text, kind):
    """The consultant's corrected value inside a correcting utterance ("no, it was thirty five"): the last number group (kind
    number) or the last capitalised group (proper_noun) of its words, or None when there is none."""
    tokens = text.split()[:MAX_TEXT_WORDS] if isinstance(text, str) else []
    groups = [g for g in _groups([{'w': t[:MAX_TOKEN_CHARS], 'c': 1.0, 's': None, 'e': None} for t in tokens]) if g['kind'] == kind]
    return groups[-1]['text'] if groups else None


def tau_from(value, default=TAU):
    """A threshold from an env string or a number: a plain decimal above 0 and at most 1, else the default."""
    v = (float(value) if _DECIMAL.fullmatch(value) else None) if isinstance(value, str) else _num(value)
    return v if v is not None and 0 < v <= 1 else default


EDGE_CONSTANTS = {
    'ASR_TAU': TAU, 'ASR_MAX_WORDS': MAX_WORDS, 'ASR_MAX_SPANS': MAX_SPANS, 'ASR_MAX_TEXT_WORDS': MAX_TEXT_WORDS, 'ASR_MAX_TOKEN_CHARS': MAX_TOKEN_CHARS,
    'ASR_PUNCT': PUNCT, 'ASR_CLOSERS': CLOSERS, 'ASR_SENTENCE_END': SENTENCE_END, 'ASR_NUMBER_WORDS': NUMBER_WORDS, 'ASR_UNIT_AFTER': UNIT_AFTER,
    'ASR_UNIT_BEFORE': UNIT_BEFORE, 'ASR_SLOT_AFTER': SLOT_AFTER, 'ASR_STOPWORDS': STOPWORDS, 'ASR_I_WORDS': I_WORDS,
}
