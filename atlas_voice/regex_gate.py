"""Cheap necessary-condition prefilters for regular expressions (v2.2 M1).

gate(src) reads a regex source and returns a list of REQUIREMENTS; each requirement is a list of lowercase literal strings, and every match of
the pattern must contain at least one literal from EVERY requirement. A text that fails a requirement (none of its literals occurs in it) cannot
match, so the regex is not run. This is what keeps the turn pre-pass flat on long answers: the costly word-alternation patterns are only scanned when one
of their own words is present.

Soundness rests on three facts: the pattern is matched case-insensitively with ASCII folding on text that normalize() has already lower-cased (so a
literal is compared lower-cased), only parts that MUST take part in a match are used (optional parts, lookarounds and back-references add nothing),
and anything the analysis does not understand is simply "no requirement" (gate() then returns [] and the regex always runs). The Python and JavaScript
sides read the same lists, so they gate identically; tests/test_turns.py samples matching strings from every pattern to prove no gate rejects a match.
Uses the standard library's regex parser (`re._parser`, an internal module): if it is missing, every gate is [] and nothing is skipped.
"""
import re

try:                                            # pragma: no cover - the import path differs only by Python version
    from re import _parser as _sre, _constants as _c
except ImportError:                             # very old/new interpreters: no gates, no harm
    _sre = _c = None

MAX_VARIANTS = 12      # a short class (`[sz]`, `[1-4]`, `\d`) widens a literal run into at most this many strings
MAX_REQUIREMENTS = 2   # the most selective requirements kept per pattern


def _members(av):
    """The characters a plain (non-negated) character class stands for, or None when it is too large or not a plain set."""
    out = []
    for op, a in av:
        if op == _c.LITERAL:
            out.append(chr(a))
        elif op == _c.RANGE:
            if a[1] - a[0] >= MAX_VARIANTS:
                return None
            out.extend(chr(i) for i in range(a[0], a[1] + 1))
        elif op == _c.CATEGORY and a == _c.CATEGORY_DIGIT:
            out.extend('0123456789')
        else:                                   # NEGATE, other categories (\w \s ...): not a small literal set
            return None
        if len(out) > MAX_VARIANTS:
            return None
    return sorted(set(out))


def _prune(alts):
    """Lower-case, de-duplicate and drop any alternative that contains another (the shorter one is implied by it)."""
    alts = sorted({a.lower() for a in alts}, key=lambda s: (len(s), s))
    kept = []
    for a in alts:
        if not any(k in a for k in kept):
            kept.append(a)
    return kept


def _requirements(seq):
    """Every necessary alternative-list of a parsed sequence (a list of (op, av))."""
    reqs, run = [], ['']

    def flush():
        nonlocal run
        if run != [''] and all(run):
            reqs.append(run)
        run = ['']

    for op, av in seq:
        if op == _c.LITERAL:
            run = [r + chr(av) for r in run]
            continue
        if op == _c.IN:
            mem = _members(av)
            if mem and len(run) * len(mem) <= MAX_VARIANTS:
                run = [r + m for r in run for m in mem]
                continue
        flush()
        sub = None
        if op == _c.SUBPATTERN:
            if not av[1] and not av[2]:         # no inline flag changes
                sub = _best(_requirements(av[3]))
        elif op in (_c.MAX_REPEAT, _c.MIN_REPEAT, _c.POSSESSIVE_REPEAT):
            if av[0] >= 1:
                sub = _best(_requirements(av[2]))
        elif op == _c.BRANCH:
            branches = [_best(_requirements(b)) for b in av[1]]
            if all(branches):
                sub = [a for b in branches for a in b]
        if sub:
            reqs.append(sub)
    flush()
    return reqs


def _score(req):
    """Longer literals are rarer; between equals, a requirement that is only digits is the weakest (a numeric text has them all), then fewer alternatives."""
    return (min(len(a) for a in req), not all(a.isdigit() for a in req), -len(req))


def _best(reqs):
    """The single most selective requirement of a list, or None."""
    reqs = [_prune(r) for r in reqs if r]
    return max(reqs, key=_score) if reqs else None


def gate(src):
    """[[literal, ...], ...]: see the module docstring. [] when nothing can be required."""
    if _sre is None:
        return []
    try:
        reqs = [_prune(r) for r in _requirements(_sre.parse(src, re.I | re.A))]
    except Exception:                           # an unexpected parse shape: no gate, the regex runs as before
        return []
    reqs.sort(key=_score, reverse=True)
    out = []
    for r in reqs:
        if any(set(r) == set(o) for o in out):
            continue
        out.append(r)
        if len(out) == MAX_REQUIREMENTS:
            break
    return out


def passes(gates, has):
    """True when the text can match: every requirement has a literal that `has` reports present. An empty gate always passes."""
    for req in gates:
        for w in req:
            if has(w):
                break
        else:
            return False
    return True
