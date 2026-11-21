"""Privacy configuration (v2.2 G2): consent wording, notice, retention proposal and the special-category guard. Wording and periods are proposals for the DPO."""
import copy
import json
import re
from pathlib import Path

import pytest

from atlas_voice import privacy_config as pc

ROOT = Path(__file__).resolve().parents[1]


def test_the_shipped_config_validates_and_marks_every_period_a_proposal():
    assert pc.PRIVACY['version'] and tuple(pc.PRIVACY['purposes']) == pc.PURPOSES
    assert pc.RETENTION['status'] == pc.PROPOSAL
    for c in pc.RETENTION['categories']:
        assert c['status'] == pc.PROPOSAL or c['id'] == 'checkpoint'
    cp = next(c for c in pc.RETENTION['categories'] if c['id'] == 'checkpoint')
    assert cp['hours'] == 24 and 'Tony' in cp['status']


def test_only_the_capture_toggle_is_required_and_text_mode_needs_only_the_draft():
    t = pc.PRIVACY['toggles']
    assert [n for n, x in t.items() if x['required']] == ['capture']
    assert t['capture']['purposes'] == ['transcription', 'draft'] and t['capture']['text_mode_purposes'] == ['draft']
    assert t['memory']['required'] is False and t['checkpoint']['required'] is False


def test_the_wording_names_the_private_draft_and_makes_no_compliance_claim():
    blob = json.dumps(pc.PRIVACY).lower()
    assert 'private draft' in blob and 'submit for review' in blob and '24 hours' in blob
    assert 'compliant' not in blob and 'gdpr compliant' not in blob
    assert 'automatically' not in pc.PRIVACY['toggles']['capture']['text'].lower().replace('automatically after', '')


def test_the_notice_keeps_its_placeholders_and_the_special_category_sentence():
    text = json.dumps(pc.PRIVACY['notice'])
    for needle in ('[CONTROLLER', '[DPO', '[LAWFUL BASIS', '[TRANSFER MECHANISMS', '[PRIVACY CONTACT'):
        assert needle in text
    assert pc.PRIVACY['special_category_sentence'] in text


@pytest.mark.parametrize('mutate,message', [
    (lambda c: c['toggles']['memory'].update(required=True), 'only the capture toggle'),
    (lambda c: c['toggles']['capture'].pop('text_mode_text'), 'text-mode variant'),
    (lambda c: c.update(purposes=['transcription']), 'purposes must be exactly'),
    (lambda c: c.update(special_category_sentence='something else'), 'special-category sentence'),
    (lambda c: c['toggles']['notice'].update(text='This service is GDPR compliant, so tick here please.'), 'no compliance claim'),
])
def test_a_bad_privacy_config_is_refused(mutate, message):
    cfg = copy.deepcopy(json.loads((ROOT / 'atlas_voice/config/privacy.json').read_text()))
    mutate(cfg)
    with pytest.raises(ValueError, match=message):
        pc.validate_privacy(cfg)


@pytest.mark.parametrize('mutate,message', [
    (lambda c: c.update(status='final'), 'must be'),
    (lambda c: c['categories'][0].update(days=0), 'positive integer'),
    (lambda c: c['categories'][0].update(action='shred'), 'action'),
    (lambda c: c['categories'][0].update(status='approved'), 'proposal'),
    (lambda c: c['categories'].pop(), 'incomplete'),
])
def test_a_bad_retention_config_is_refused(mutate, message):
    cfg = copy.deepcopy(json.loads((ROOT / 'atlas_voice/config/retention.json').read_text()))
    mutate(cfg)
    with pytest.raises(ValueError, match=message):
        pc.validate_retention(cfg)


def test_special_guard_flags_a_sentence_in_seven_languages_and_stays_quiet_on_project_talk():
    cases = {'I was diagnosed with cancer': 'health', 'Je suis syndiqué': 'union', 'mi fe y mi iglesia': 'religion', 'meu partido político': 'politics',
             'Ich bin schwanger': 'health', 'la mia orientazione sessuale': None, 'orientamento sessuale': 'sexual_orientation', 'mijn etniciteit': 'ethnicity'}
    for text, cat in cases.items():
        got = pc.special_categories(text)
        assert (cat in got) if cat else got == [], text
    assert pc.special_categories('We cut claim triage from 40 to 12 minutes with a routing model.') == []
    assert pc.special_categories('A race condition and a union of two sets.') == []


def test_normalisation_is_one_form_for_accents_case_and_german_transliteration():
    assert pc.normalize('Ärzte über Straße') == 'aerzte ueber strasse'
    assert pc.normalize("  J'ai  VOTÉ ") == 'j ai vote'
    assert pc.special_categories('GEWÄHLT') == [] and pc.special_categories('Krebs') == ['health']


def test_every_phrase_is_normalised_unique_per_category_and_not_trivially_short():
    for cat, phrases in pc.SPECIAL.items():
        assert len(set(phrases)) == len(phrases) and all((len(p) >= 3 or pc._nospace(p)) and p == pc.normalize(p) for p in phrases), cat  # (v2.2 X2: phrases of scripts without spaces may be one or two characters)


def test_edge_constants_carry_the_three_objects():
    assert set(pc.EDGE_CONSTANTS) == {'PRIVACY', 'RETENTION', 'SPECIAL_PHRASES', 'SPECIAL_EXCLUDE', 'SPECIAL_LANGS'}
    gen = (ROOT / 'deploy/cloudflare-edge/src/policy.generated.js').read_text()
    for name in ('PRIVACY', 'RETENTION'):
        assert re.search(rf'^export const {name} = ', gen, re.M)
    for name in ('SPECIAL_PHRASES', 'SPECIAL_EXCLUDE', 'SPECIAL_LANGS', 'FOLD_CONFUSABLES'):
        assert not re.search(rf'^export const {name} = ', gen, re.M)


def test_the_privacy_documents_are_generated_from_the_json_and_current():
    import subprocess, sys
    r = subprocess.run([sys.executable, str(ROOT / 'scripts/render_privacy_docs.py'), '--check'], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr


def test_the_hand_written_privacy_documents_exist_and_never_claim_compliance():
    for name in ('PROCESSORS.md', 'ROPA.md', 'DPIA_DRAFT.md', 'WORKS_COUNCIL_PACK.md', 'PRIVACY_NOTICE.md', 'RETENTION_SCHEDULE.md'):
        text = (ROOT / 'docs' / 'privacy' / name).read_text()
        assert len(text) > 800, name
        low = text.lower()
        for bad in ('gdpr compliant', 'fully compliant', 'is compliant', 'production-ready', 'production ready'):
            assert bad not in low, (name, bad)
    proc = (ROOT / 'docs/privacy/PROCESSORS.md').read_text()
    assert 'personal Cloudflare account' in proc and 'OWNER-DECISION' in proc and 'to verify' in proc
    assert 'DRAFT' in (ROOT / 'docs/privacy/DPIA_DRAFT.md').read_text() and 'DPO' in (ROOT / 'docs/privacy/ROPA.md').read_text()
    assert 'PROPOSAL' in (ROOT / 'docs/privacy/RETENTION_SCHEDULE.md').read_text()
