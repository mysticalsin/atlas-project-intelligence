"""The gateway uses the same limits as deploy/cloudflare-edge/src/prices.js."""
import json

from atlas_voice.limits import LIMITS, cap_pcm, cap_text, input_tokens, output_tokens, realtime_reservation


def test_limits_match_the_price_table():
    assert LIMITS['talker']['maxTokens'] == 300
    assert output_tokens('talker') == 300
    assert output_tokens('gatewayAnalyst') == LIMITS['gatewayAnalyst']['maxTokens'] + LIMITS['gatewayAnalyst']['reasoningTokens']
    assert output_tokens('editor') == 4500
    assert input_tokens('ab') == 2
    assert input_tokens('') == 1


def test_audio_and_realtime_caps():
    pcm = b'\x00' * ((LIMITS['stt']['maxAudioMs'] + 1000) * LIMITS['pcmBytesPerMs'])
    assert len(cap_pcm(pcm, LIMITS['stt']['maxAudioMs'])) == LIMITS['stt']['maxAudioMs'] * LIMITS['pcmBytesPerMs']
    assert len(cap_text('é' * (LIMITS['tts']['maxChars'] + 5), LIMITS['tts']['maxChars'])) == LIMITS['tts']['maxChars']
    book = realtime_reservation(LIMITS['realtime']['maxSeconds'] + 50)
    assert book['seconds'] == LIMITS['realtime']['maxSeconds']
    assert book['outputTokens'] == book['seconds'] * LIMITS['realtime']['outputTokensPerSecond'] + LIMITS['realtime']['maxResponseTokens']
    assert book['stopOutput'] == book['seconds'] * LIMITS['realtime']['outputTokensPerSecond']


def test_jev_body_is_the_context_cap():
    from atlas_voice.limits import jev_body
    raw = 'x' * LIMITS['jev']['contextTokens']
    assert jev_body(raw) == raw
    try:
        jev_body(raw + 'y')
    except ValueError as error:
        assert 'context' in str(error)
    else:
        raise AssertionError('a body past the context cap was accepted')
    assert json.dumps(LIMITS['markdown']['maxPages']) == '30'
