"""v2.2 X2 (red-team retest M9-M13, L14): the Python source of truth for the multilingual guards. The JavaScript ports are held to it by the parity vectors; these tests pin the behaviour itself."""
import pytest

from atlas_voice import privacy_config as pc
from atlas_voice.extension import reply
from atlas_voice.quality import context_cue
from atlas_voice.speech import ReplyGuard, asserts_verification, figures, has_unchecked_script
from atlas_voice.textfold import fold, plain
from atlas_voice.turns import analyze_turn


def test_fold_reads_look_alikes_invisible_and_full_width_forms_as_the_plain_word():
    assert fold('vеrified') == 'verified' and fold('v​erified') == 'verified' and fold('ＵＮＩＯＮ') == 'union'
    assert plain('Vérifié') == 'verifie' and plain('Straße') == 'strasse'


@pytest.mark.parametrize('text', ['Votre manager a vérifié et approuvé ce résultat.', 'Ihr Vorgesetzter hat das geprüft und freigegeben.', 'Tu responsable lo ha verificado y aprobado.',
                                  'Il tuo responsabile lo ha verificato e approvato.', 'Je manager heeft het geverifieerd en goedgekeurd.', 'O seu gestor verificou e aprovou isso.', 'Your manager signed it off.',
                                  'Your manager vеrified and аpproved it.'])
def test_a_claim_of_verification_is_caught_in_the_bank_languages(text):
    assert asserts_verification(text)


@pytest.mark.parametrize('text', ["Ce résultat n'a pas été vérifié.", 'Nadie lo ha verificado todavía.', 'Non è stato verificato.', 'Het is nog niet goedgekeurd.', 'Isso não foi aprovado.'])
def test_a_denial_is_not_a_claim(text):
    assert not asserts_verification(text)


def test_figures_in_other_forms_and_the_script_test():
    assert figures('four zero percent') == ['4', '40'] and figures('XL percent') == ['40'] and figures('a dozen') == ['12'] and figures('4x4') == ['4', '4', '16'] and figures('dreihunderttausend') == ['?']
    assert figures('the CV and the MD') == []
    assert has_unchecked_script('сорок') and not has_unchecked_script('Café über')
    g = ReplyGuard(summary_facts=['4 percent'])
    assert g.push('Ты сократил время на сорок процентов. ') == [] and g.stats['dropped_unknown_number'] == 1


def test_a_control_phrase_in_a_long_answer_is_an_answer():
    long_fr = "Nous avons dû mettre fin au contrat avec l'ancien prestataire, puis j'ai fini la migration des données en mars et le délai de traitement a baissé de 30 pour cent."
    assert 'stop' not in analyze_turn(long_fr, 'fr')['intents'] and 'stop' in analyze_turn('terminons ici', 'fr')['intents']


def test_only_a_short_explicit_yes_extends_in_any_language():
    for text, lang in (("Non merci, je préfère qu'on en reste à vingt minutes aujourd'hui.", 'fr'), ('Нет, спасибо, у меня сейчас начинается другая встреча.', 'ru')):
        t = analyze_turn(text, lang)
        assert reply(t['intents'], t['words']) == 'refused'


@pytest.mark.parametrize('text', ['I was off for chemo.', 'I was off for che​motherapy.', 'I was off for сhemotherapy.', 'I was off for c-h-e-m-o-t-h-e-r-a-p-y.', 'Я был на больничном из-за рака.',
                                  '私は癌の治療で休職していました。', 'Byłem na zwolnieniu z powodu raka.', '我患有癌症。'])
def test_special_category_phrases_survive_tricks_and_exist_for_the_new_languages(text):
    assert pc.special_categories(text)


def test_a_street_name_is_not_a_belief_and_unlisted_languages_are_flagged():
    assert pc.special_categories('The project was for Church Street Bank.') == [] and pc.special_categories('We went to church on Sunday.') == ['religion']
    assert pc.uncovered_language('Jag har cancer och är sjukskriven sedan i våras.') and not pc.uncovered_language('Das Projekt war ein Erfolg und das Team hat die Migration abgeschlossen.')


def test_quote_context_in_the_bank_languages():
    for said, quote in (("It's false that I personally cut costs by 40 percent; the finance team did.", 'I personally cut costs by 40 percent'), ('My boss claims I personally cut costs by 40 percent, which is untrue.', 'I personally cut costs by 40 percent'),
                        ("Je ne dirais jamais que j'ai personnellement réduit les coûts de 40 pour cent.", "j'ai personnellement réduit les coûts de 40 pour cent"),
                        ('Es stimmt nicht, dass ich persönlich die Kosten um 40 Prozent gesenkt habe.', 'ich persönlich die Kosten um 40 Prozent gesenkt habe')):
        assert context_cue(said, quote), said
    assert context_cue('We rebuilt the claims intake process for the insurance client.', 'the claims intake process') == ''
