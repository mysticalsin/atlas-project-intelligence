"""A spoken reply that still asks a question must not end the interview.
Synthetic lines only. No voice provider, microphone or network.
"""
from atlas_voice.cascade import TIME_UP, reply_closes


def test_an_ascii_question_is_not_a_closing():
    assert reply_closes(None, 'Is there anything else?', end_seen=True) is False


def test_a_question_mark_from_another_script_is_not_a_closing():
    # Fullwidth, Arabic, Greek, Armenian, and the Spanish opening mark.
    for said in (
        'Is there anything else\uff1f',
        'Hal tatabiqu ay shay akhar\u061f',
        'Yparxei kati allo\u037e',
        'Ka aylev ban\u055e',
        '\u00bfHay algo mas',
    ):
        assert reply_closes(None, said, end_seen=True) is False, said.encode('unicode_escape')


def test_a_statement_with_the_end_token_does_close():
    assert reply_closes(None, 'Thanks. I will prepare your report.', end_seen=True) is True


def test_time_up_closes_even_when_the_line_asks_a_question():
    assert reply_closes(TIME_UP, 'Is there anything else\uff1f', end_seen=False) is True


def test_an_admin_close_still_allows_a_question():
    assert reply_closes(None, 'Shall I stop\u061f', end_seen=True, admin=True) is True


def test_no_end_token_does_not_close():
    assert reply_closes(None, 'Thanks. I will prepare your report.', end_seen=False) is False
