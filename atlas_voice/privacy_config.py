"""Privacy configuration (v2.2 G2): consent wording, the privacy notice, the retention proposal and the special-category phrase guard.

All four live as JSON in atlas_voice/config/ (privacy.json, retention.json, special_categories.json), loaded and validated at import, so a bad edit fails the
build instead of production. The edge Worker receives them through EDGE_CONSTANTS (policy.generated.js): deploy/cloudflare-edge/src/privacy.js renders the
notice and hashes the consent texts, retention.js sweeps by the periods, special.js matches the phrases. special_categories() is the source of truth for the
matcher and special.vectors.json holds the JS port to it.

Nothing here is a legal conclusion: wording, lawful bases and periods are proposals that Mantu's DPO and legal team must confirm. Pure stdlib."""
import json
import re
import unicodedata
from pathlib import Path

CONFIG_DIR = Path(__file__).resolve().parent / 'config'
PURPOSES = ('transcription', 'draft', 'checkpoint', 'memory', 'notice')
RETENTION_ACTIONS = ('delete', 'erase_content', 'pseudonymise', 'platform', 'forget')
PROPOSAL = 'PROPOSAL — DPO to confirm'
LANGS = ('en', 'fr', 'es', 'pt', 'de', 'it', 'nl')
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


def normalize(text):
    """The matcher's one normal form: German transliteration, accents stripped, lower case, everything but letters and digits is one space."""
    s = str(text).replace('ä', 'ae').replace('ö', 'oe').replace('ü', 'ue').replace('Ä', 'ae').replace('Ö', 'oe').replace('Ü', 'ue').replace('ß', 'ss')
    s = ''.join(ch for ch in unicodedata.normalize('NFKD', s) if not unicodedata.combining(ch)).lower()
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


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
                _need(len(n) >= 3, f'{cat}/{lang}: phrase {w!r} is too short')
                if n not in phrases:
                    phrases.append(n)
        table[cat] = phrases
    return table


PRIVACY = validate_privacy(_load('privacy.json'))
RETENTION = validate_retention(_load('retention.json'))
SPECIAL = validate_special(_load('special_categories.json'))  # {category: [normalised phrase, ...]}


def special_categories(text):
    """The special categories whose phrases appear in `text`, in the fixed category order. A flag on a sentence, never a statement about a person:
    callers use it to offer 'keep this private?' and to keep the text out of memory, and never store it against anyone."""
    s = ' ' + normalize(text) + ' '
    return [cat for cat, phrases in SPECIAL.items() if any(' ' + p + ' ' in s for p in phrases)]


EDGE_CONSTANTS = {'PRIVACY': PRIVACY, 'RETENTION': RETENTION, 'SPECIAL_PHRASES': SPECIAL}
