"""Privacy configuration (v2.2 G2): consent wording, the privacy notice, the retention proposal and the special-category phrase guard.

All four live as JSON in atlas_voice/config/ (privacy.json, retention.json, special_categories.json), loaded and validated at import, so a bad edit fails the
build instead of production. The edge Worker receives them through EDGE_CONSTANTS (policy.generated.js): deploy/cloudflare-edge/src/privacy.js renders the
notice and hashes the consent texts, retention.js sweeps by the periods. special_categories() is the source of truth for the phrase matcher.
The edge port of that matcher moves to the interview slice with the code that calls it.

Nothing here is a legal conclusion: wording, lawful bases and periods are proposals that Mantu's DPO and legal team must confirm. Pure stdlib."""
import json
import re
import unicodedata
from pathlib import Path

from .languages import detect
from .textfold import fold

CONFIG_DIR = Path(__file__).resolve().parent / 'config'
PURPOSES = ('transcription', 'draft', 'checkpoint', 'memory', 'notice')
RETENTION_ACTIONS = ('delete', 'erase_content', 'pseudonymise', 'platform', 'forget')
PROPOSAL = 'PROPOSAL — DPO to confirm'
LANGS = ('en', 'fr', 'es', 'pt', 'de', 'it', 'nl', 'ru', 'pl', 'ar', 'ja', 'zh')
CATEGORIES = ('health', 'union', 'religion', 'politics', 'sexual_orientation', 'ethnicity')


def _load(name):
    return json.loads((CONFIG_DIR / name).read_text(encoding='utf-8'))


def _need(ok, message):
    if not ok:
        raise ValueError(f'privacy config: {message}')


def validate_privacy(cfg):
    _need(isinstance(cfg, dict) and isinstance(cfg.get('version'), str) and cfg['version'], 'version missing')
    _need(tuple(cfg.get('purposes', ())) == PURPOSES, 'purposes must be exactly ' + ', '.join(PURPOSES))
    toggles = cfg.get('toggles')
    _need(isinstance(toggles, dict) and set(toggles) == {'capture', 'checkpoint', 'memory', 'notice'}, 'toggles must be capture, checkpoint, memory, notice')
    seen = []
    for name, t in toggles.items():
        _need(isinstance(t.get('text'), str) and len(t['text']) > 20, f'toggle {name}: text')
        _need(isinstance(t.get('required'), bool), f'toggle {name}: required flag')
        _need(isinstance(t.get('purposes'), list) and t['purposes'] and set(t['purposes']) <= set(PURPOSES), f'toggle {name}: purposes')
        seen += t['purposes']
    _need(sorted(seen) == sorted(PURPOSES), 'every purpose belongs to exactly one toggle')
    _need(toggles['capture']['required'] and not any(toggles[n]['required'] for n in ('checkpoint', 'memory', 'notice')), 'only the capture toggle is required')
    cap = toggles['capture']
    _need(cap.get('text_mode_purposes') == ['draft'] and isinstance(cap.get('text_mode_text'), str), 'capture needs the text-mode variant (draft only)')
    notice = cfg.get('notice')
    _need(isinstance(notice, dict) and isinstance(notice.get('title'), str) and isinstance(notice.get('intro'), str), 'notice title and intro')
    ids = [s.get('id') for s in notice.get('sections', [])]
    _need(len(ids) == len(set(ids)) and {'controller', 'purposes', 'data', 'special', 'recipients', 'transfers', 'retention', 'rights', 'checkpoint', 'text', 'automated', 'contact'} <= set(ids), 'notice sections incomplete')
    for s in notice['sections']:
        _need(isinstance(s.get('title'), str) and isinstance(s.get('paragraphs'), list) and s['paragraphs'] and all(isinstance(p, str) and p for p in s['paragraphs']), f"notice section {s.get('id')}")
    pc = cfg.get('profile_consents')
    _need(isinstance(pc, dict) and set(pc) == {'spoken_ask', 'jev_rating'} and all(isinstance(v.get('text'), str) and len(v['text']) > 20 for v in pc.values()), 'profile_consents: spoken_ask and jev_rating wording')
    _need(isinstance(cfg.get('special_category_sentence'), str), 'special_category_sentence')
    special = next(s for s in notice['sections'] if s['id'] == 'special')
    _need(cfg['special_category_sentence'] in ' '.join(special['paragraphs']), 'the notice must carry the special-category sentence')
    _need('[' in json.dumps(notice) and 'DPO' in json.dumps(notice), 'the notice must keep its DPO placeholders until Mantu fills them')
    _need('compliant' not in json.dumps(cfg).lower(), 'no compliance claim in privacy wording')
    return cfg


def validate_retention(cfg):
    _need(isinstance(cfg, dict) and cfg.get('status') == PROPOSAL, f'retention.status must be {PROPOSAL!r}')
    cats = cfg.get('categories')
    _need(isinstance(cats, list) and cats, 'retention categories')
    ids = [c.get('id') for c in cats]
    _need(len(ids) == len(set(ids)) and {'drafts', 'withdrawn_refs', 'rejected_evidence', 'audit', 'outreach', 'staffing_imports', 'consent_receipts', 'security_logs', 'checkpoint'} <= set(ids), 'retention categories incomplete')
    for c in cats:
        w = f"retention {c.get('id')}"
        _need(isinstance(c.get('label'), str) and isinstance(c.get('from'), str) and isinstance(c.get('enforced_by'), str), f'{w}: label, from, enforced_by')
        _need(c.get('action') in RETENTION_ACTIONS, f'{w}: action')
        _need(isinstance(c.get('sweep'), bool), f'{w}: sweep flag')
        amount = [k for k in ('days', 'hours') if k in c]
        _need(len(amount) == 1 and isinstance(c[amount[0]], int) and not isinstance(c[amount[0]], bool) and c[amount[0]] > 0, f'{w}: one positive integer days or hours')
        _need(c.get('status') == PROPOSAL or c['id'] == 'checkpoint', f'{w}: every period is a proposal except the 24 h checkpoint Tony decided')
    return cfg


# Scripts written without spaces between words (and Arabic, whose words carry attached prefixes): their phrases match anywhere in the text, not as whole words.
_NOSPACE = re.compile('[\u0600-\u06ff\u3040-\u30ff\u3400-\u9fff\u0e00-\u0e7f]')
_HAN = re.compile('[\u3400-\u9fff]')


def _nospace(phrase):
    return bool(_NOSPACE.search(phrase))


def normalize(text):
    """The matcher's one normal form (red M13): folded first (textfold.fold: NFKC, invisible characters gone, look-alike letters read as Latin), German transliteration,
    accents stripped, lower case, everything but letters and digits is one space, and a run of three or more single letters ("c h e m o", "c-h-e-m-o") is one word."""
    s = fold(text).replace('\u00e4', 'ae').replace('\u00f6', 'oe').replace('\u00fc', 'ue').replace('\u00df', 'ss')
    s = ''.join(ch for ch in unicodedata.normalize('NFKD', s) if not unicodedata.category(ch).startswith('M'))
    tokens, out, run = re.sub(r'[\W_]+', ' ', s).strip().split(' '), [], []
    for t in tokens + ['']:
        if len(t) == 1 and t.isalpha():
            run.append(t)
            continue
        if run:
            out.extend([''.join(run)] if len(run) >= 3 else run)
            run = []
        if t:
            out.append(t)
    return ' '.join(out)


def validate_special(cfg):
    cats = cfg.get('categories') if isinstance(cfg, dict) else None
    _need(isinstance(cats, dict) and tuple(cats) == CATEGORIES, 'special categories must be ' + ', '.join(CATEGORIES))
    table = {}
    for cat, langs in cats.items():
        _need(isinstance(langs, dict) and set(langs) <= set(LANGS) and 'en' in langs, f'{cat}: languages')
        phrases = []
        for lang, words in langs.items():
            _need(isinstance(words, list) and words and all(isinstance(w, str) for w in words), f'{cat}/{lang}: phrases')
            for w in words:
                n = normalize(w)
                _need(len(n) >= (4 if '\u0600' <= n[:1] <= '\u06ff' else 1 if _HAN.fullmatch(n) else 2 if _nospace(n) else 3), f'{cat}/{lang}: phrase {w!r} is too short')
                if n not in phrases:
                    phrases.append(n)
        table[cat] = phrases
    return table


def validate_exclude(cfg):
    ex = cfg.get('context_exclude', []) if isinstance(cfg, dict) else None
    _need(isinstance(ex, list) and all(isinstance(x, str) and len(normalize(x)) >= 5 for x in ex), 'context_exclude: normalisable strings of five characters or more')
    return [normalize(x) for x in ex]


_SPECIAL_CFG = _load('special_categories.json')
PRIVACY = validate_privacy(_load('privacy.json'))
RETENTION = validate_retention(_load('retention.json'))
SPECIAL = validate_special(_SPECIAL_CFG)  # {category: [normalised phrase, ...]}
SPECIAL_EXCLUDE = validate_exclude(_SPECIAL_CFG)


def special_categories(text):
    """The special categories whose phrases appear in `text`, in the fixed category order. A flag on a sentence, never a statement about a person:
    callers use it to offer 'keep this private?' and to keep the text out of memory, and never store it against anyone. A place name listed in context_exclude
    ("Church Street") is removed first (red L14); a phrase in a script written without spaces matches anywhere, any other only as whole words."""
    s = ' ' + normalize(text) + ' '
    for x in SPECIAL_EXCLUDE:
        s = s.replace(' ' + x + ' ', ' | ')
    return [cat for cat, phrases in SPECIAL.items() if any((p in s) if _nospace(p) else (' ' + p + ' ' in s) for p in phrases)]


def uncovered_language(text):
    """True when `text` is written in a language that has no phrase list here (the detector names it and it is not one of LANGS): the guard cannot judge it, so callers
    keep such model-written text out of private memory rather than retain it unchecked (red M13). False for short or unnamed text."""
    lang = detect(text).get('lang')
    return lang is not None and lang not in LANGS


EDGE_CONSTANTS = {'PRIVACY': PRIVACY, 'RETENTION': RETENTION, 'SPECIAL_PHRASES': SPECIAL, 'SPECIAL_EXCLUDE': SPECIAL_EXCLUDE, 'SPECIAL_LANGS': list(LANGS)}
