"""A Bulgarian vowel hard sign is not named Russian.

Synthetic sentences only. No provider, Entra, Hindsight, or Teams call.
"""
from atlas_voice.languages import detect

# Bulgarian: U+044A is a vowel inside a word, not the Russian separator.
BG_QUEUE = (
    '\u0415\u043a\u0438\u043f\u044a\u0442 \u0441\u044a\u043a\u0440\u0430\u0442\u0438 '
    '\u0432\u0440\u0435\u043c\u0435\u0442\u043e \u0437\u0430 \u043e\u043f\u0430\u0448\u043a\u0430 '
    '\u0438 \u0440\u044a\u043a\u043e\u0432\u043e\u0434\u0438\u0442\u0435\u043b\u044f\u0442 '
    '\u043f\u0440\u0438\u0435 \u043d\u043e\u0432\u0438\u044f \u043f\u0440\u043e\u0446\u0435\u0441 '
    '\u0441\u043b\u0435\u0434 \u043f\u0438\u043b\u043e\u0442\u0430.'
)
BG_COUNTRY = (
    '\u0411\u044a\u043b\u0433\u0430\u0440\u0438\u044f \u0435 \u0440\u0435\u043f\u0443\u0431\u043b\u0438\u043a\u0430 '
    '\u043d\u0430 \u0411\u0430\u043b\u043a\u0430\u043d\u0438\u0442\u0435.'
)
# Russian with none of U+044B, U+044D, U+0451, or U+044A still uses the Cyrillic prior.
RU_PLAIN = (
    '\u041a\u043e\u043c\u0430\u043d\u0434\u0430 \u0441\u043e\u043a\u0440\u0430\u0442\u0438\u043b\u0430 '
    '\u0432\u0440\u0435\u043c\u044f \u043e\u0447\u0435\u0440\u0435\u0434\u0438 \u043f\u043e\u0441\u043b\u0435 '
    '\u043f\u0438\u043b\u043e\u0442\u0430.'
)
# Russian hard sign only before U+0435, U+0451, U+044E, or U+044F.
RU_SIGN = (
    '\u041f\u043e\u0434\u044a\u0435\u0437\u0434 \u0437\u0430\u043a\u0440\u044b\u0442 '
    '\u043f\u043e\u0441\u043b\u0435 \u0440\u0435\u043c\u043e\u043d\u0442\u0430.'
)
RU_MARK = (
    '\u041c\u044b \u0431\u044b\u043b\u0438 \u043d\u0430 \u0432\u0441\u0442\u0440\u0435\u0447\u0435 '
    '\u0438 \u044d\u0442\u043e \u0431\u044b\u043b\u043e \u043f\u043e\u043b\u0435\u0437\u043d\u043e.'
)
UK = (
    '\u041a\u043e\u043c\u0430\u043d\u0434\u0430 \u0441\u043a\u043e\u0440\u043e\u0442\u0438\u043b\u0430 '
    '\u0447\u0430\u0441 \u0447\u0435\u0440\u0433\u0438, \u0456 \u043a\u0435\u0440\u0456\u0432\u043d\u0438\u043a '
    '\u0443\u0445\u0432\u0430\u043b\u0438\u0432 \u043d\u043e\u0432\u0438\u0439 \u043f\u0440\u043e\u0446\u0435\u0441.'
)
# Ukrainian U+0456 stays Ukrainian even when U+044B is also present.
UK_MIXED = '\u041c\u0438 \u0431\u0443\u043b\u0438 \u0456 \u043c\u044b \u0432\u044b\u0448\u043b\u0438.'


def test_bulgarian_vowel_hard_sign_is_not_russian():
    queue = detect(BG_QUEUE)
    country = detect(BG_COUNTRY)
    assert queue['lang'] is None
    assert queue['strong'] is False
    assert country['lang'] is None
    assert country['strong'] is False


def test_russian_and_ukrainian_markers_stay():
    assert detect(RU_PLAIN)['lang'] == 'ru'
    assert detect(RU_SIGN)['lang'] == 'ru'
    assert detect(RU_MARK)['lang'] == 'ru'
    assert detect(UK)['lang'] == 'uk'
    assert detect(UK_MIXED)['lang'] == 'uk'
