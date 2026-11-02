"""Record Python EnergyTurns on deterministic synthetic PCM for the JS parity test."""
import json, math, struct, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.speech import EnergyTurns, Phrases, ReplyGuard, sentences, speakable, figures, asserts_verification, has_unchecked_script, SAMPLE_RATE

def tone(sec, amp, hz=180):
    n = int(SAMPLE_RATE * sec); return [int(amp * 32767 * math.sin(2 * math.pi * hz * i / SAMPLE_RATE)) for i in range(n)]
CASES = {'one_turn': [(1.3, .001), (1.2, .2), (1.3, .001)], 'short_pause': [(.5, .001), (.6, .2), (.4, .001), (.6, .2), (1.3, .001)],
         'blip': [(.5, .001), (.04, .3), (1.3, .001)], 'two_turns': [(.4, .002), (.8, .15), (1.2, .002), (.9, .25), (1.3, .002)],
         'echo_agent': [(.5, .001), (.8, .03), (1.3, .001)]}
out = {}
for name, segs in CASES.items():
    samples = sum((tone(s, a) for s, a in segs), [])
    agent = name == 'echo_agent'
    t = EnergyTurns(); events = []
    for i in range(0, len(samples), 480):
        started, utt = t.feed(struct.pack('<%dh' % len(samples[i:i + 480]), *samples[i:i + 480]), agent)
        if started: events.append(['start', i])
        if utt: events.append(['utt', i, len(utt)])
    out[name] = {'segments': segs, 'agent': agent, 'events': events, 'floor': round(t.floor, 12)}
out['_sentences'] = [[s, sentences(s)] for s in ('Thanks. What was the baseline? And', 'No end yet', 'One! Two? Three.', 'Merci. Quelle était la référence ? Et', 'ありがとう。基準は何でしたか？そして', 'धन्यवाद। आधार क्या था? और',
    # Not sentence ends: initialisms, abbreviations, an ellipsis or a full stop before a lowercase word, decimals, list numbers.
    'We used A.I. to triage. Then we', 'For example, e.g. Kafka, i.e. a queue. It', 'Mr. Smith and Dr. Patel led it. And',
    'The U.S. team grew 3.5 times. Next', 'We had data... and more data... So', 'Kafka, Spark, etc. were used vs. the old stack. Ok',
    'It ended. ', 'Really? ', 'He said "done." Then', '1. We migrated. 2. We trained. 3', 'Mme. Durand a dit oui. Et')]
from atlas_voice.speech import is_echo
out['_echo'] = [[a, b, is_echo(a, b)] for a, b in (('quelle était la référence', 'Quelle était la référence avant le projet ?'), ('基準 は 何 でした か', '基準 は 何 でした か？'), ('Мы сократили время обработки', 'Как вы измерили время?'), ('what problem were you trying to solve', 'What problem were you trying to solve with it?'))]
# Streaming pieces for the voice: what each delta releases, then what the end of the reply releases.
def phrase_steps(deltas):
    p = Phrases(); return [p.feed(d) for d in deltas] + [p.flush()]
out['_phrases'] = [[d, phrase_steps(d)] for d in (
    ['Thanks. ', 'What was ', 'the baseline?'],
    ['Great. ', 'That is clear. ', 'So it worked. ', 'Who measured the change before and after?', ' Ok.'],
    ['Before we get into the numbers and the detail, ', 'tell me who ', 'owned it.'],
    ['Right, so the budget, ', 'who owned it?', ' And'],
    ['We used A.', 'I. models, e.g. ', 'GPT, in the U.S. ', 'market. It worked.'],
    ['Well...', ' it depends.', ' Right.'],
    ['Two things:\n', '- the budget\n', '- the scope. ', 'Which mattered more?'],
    ['Merci. ', 'Quelle était la référence ? ', 'Et comment l\'avez-vous mesurée ?'],
    ['ありがとう。', '基準は何でしたか？', 'そして'])]
out['_speakable'] = [[t, speakable(t)] for t in (
    '**Budget**: we cut __costs__ by `40%`.', '## Summary\nWe moved.', '- the budget\n- the scope', '1. We migrated.\n2) We trained.',
    'C# and F# stay, -5 degrees, 3.5 times.', '*really* good', '**', ' - ', 'Plain text stays as it is.', 'Quelle était la référence ?')]
# ReplyGuard: pieces in (given directly, or the pieces Phrases makes of streamed deltas), what each push voices, the final
# stats, and the push after which the guard was done (null: never). Every piece is pushed, also after done.
RAMBLE = ' '.join('We looked at the numbers again and again for the quarter and the pipeline.' for _ in range(5))  # 5 x 14 words
LONG_ONE = ' '.join('word%d' % i for i in range(60))
GUARD = [
    ('one question', {}, ['What was the baseline?']),
    ('reaction then question', {}, ['Thanks. What was the baseline before the change?']),
    ('second question in the same piece', {}, ['Got it, thanks for that.', 'Who owned it? And what changed afterwards?']),
    ('piece after the question', {}, ['Who owned it?', 'And what about the budget?', 'Tell me more.']),
    ('question split across pieces', {}, {'deltas': ['Before we get into the numbers and the detail, ', 'tell me who ', 'owned it?', ' And what did you choose instead?']}),
    ('amazing alone', {}, ['Amazing!', 'What did you own?']),
    ('praise inside the question is kept', {}, ["That's an amazing team effort \u2014 what did you own?"]),
    ('praise sentence of 8 words goes, 9 stays', {}, ["That's a fantastic and truly brilliant result overall.", "That's honestly a fantastic and truly brilliant result overall.", 'Who led it?']),
    ('repeated opener, prefix', {'recent_openers': ['Got it, thanks for that.', 'I see']}, ['Got it, thanks for that detail.', 'Who owned it?']),
    ('repeated opener, exact and shorter', {'recent_openers': ['I see', 'Thanks for walking me through that.']}, ['I see.', 'Thanks.', 'Who owned it?']),
    ('opener not repeated', {'recent_openers': ['Got it']}, ['Makes sense.', 'Who owned it?']),
    ('long leading sentence is not a reaction', {'recent_openers': ['thanks']}, ['Thanks to the new pipeline the tickets dropped in the first quarter after launch.', 'Who owned it?']),
    ('praise then repeated opener', {'recent_openers': ['makes sense']}, ['Awesome!', 'Makes sense. Who owned it?']),
    ('only the last three openers count', {'recent_openers': ['Right', 'Got it', 'I see', 'Fine']}, ['Right.', 'Who owned it?']),
    ('60-word ramble in sentences', {}, [RAMBLE, 'Who owned it?']),
    ('60 words in one sentence', {}, [LONG_ONE + '.']),
    ('ramble, no question, one sentence per piece', {}, ['We looked at the numbers again and again for the quarter and the pipeline.'] * 5),
    ('small cap', {'max_words': 6}, ['That is clear.', 'It worked well for us.', 'Who owned it?']),
    ('no cap', {'max_words': None}, [RAMBLE, 'Who owned it?']),
    ('cap cuts inside a sentence under way', {}, ['Before we get into the numbers and the detail,', 'tell me ' + ' '.join('w%d' % i for i in range(45)) + '.']),
    ('summary with an unknown number', {'summary_facts': ['35%', '12 weeks']}, ['Tickets dropped 35% over 12 weeks.', 'That saved us 40 hours.', 'What have I misunderstood or missed?']),
    ('summary numerals normalised', {'summary_facts': ['1,200', '3.50', '\u20ac2M']}, ['We handled 1200 tickets.', 'Cost fell 3.5%.', 'It saved $1.2M.', 'It cost 2 million.', 'Is that right?']),
    ('summary with no facts allows no number', {'summary_facts': []}, ['You worked on it for two years.', 'It took 3 teams.', 'What did I miss?']),
    ('summary question with a made-up number', {'summary_facts': ['35%']}, ['Did it really reach 80%?', 'And then?']),
    ('Spanish', {}, ['Gracias por compartirlo.', '\u00bfQui\u00e9n lider\u00f3 ese cambio?', '\u00bfY cu\u00e1nto tiempo tom\u00f3?']),
    ('Spanish inverted mark mid piece', {}, ['Gracias. \u00bfQui\u00e9n lider\u00f3 eso? \u00bfY cu\u00e1nto tard\u00f3?']),
    ('Japanese', {}, ['\u3042\u308a\u304c\u3068\u3046\u3002\u57fa\u6e96\u306f\u4f55\u3067\u3057\u305f\u304b\uff1f\u305d\u3057\u3066\u4f55\u3092\u5909\u3048\u307e\u3057\u305f\u304b\uff1f']),
    ('French space before the mark', {}, ['Merci. ', 'Quelle \u00e9tait la r\u00e9f\u00e9rence ?', 'Et ensuite ?']),
    ('Hindi', {}, ['\u0927\u0928\u094d\u092f\u0935\u093e\u0926\u0964 \u0906\u0927\u093e\u0930 \u0915\u094d\u092f\u093e \u0925\u093e? \u0914\u0930 \u0915\u094d\u092f\u093e?']),
    ('quoted question', {}, ['Right \u2014 "who owned it?"', 'Next.']),
    ('markdown question', {}, ['**Who owned it?** And the budget?']),
    ('custom banned praise, any case', {'banned_praise': r'\b(great|nice)\b'}, ['GREAT!', 'Amazing.', 'What was the baseline?']),
    ('dropped first clause drops the rest', {}, ['Awesome brilliant fantastic,', 'what did you own?', 'Next?']),
    ('first clause repeating an opener drops the sentence', {'recent_openers': ['before we get into the numbers']}, ['Before we get into the numbers and the detail,', 'tell me who owned it?']),
    ('voiced first clause is not taken back', {}, ['Before we get into the numbers and the detail,', 'that was amazing. Who owned it?']),
    ('empty and blank pieces', {}, ['', '   ', 'We shipped it.', '', 'Who owned it?']),
    ('no question, nothing dropped', {}, ['We shipped it.', 'It went well.']),
    ('question mark after an abbreviation', {}, ['Dr. Patel led it. And the U.S. team? Who ran it?']),
    # Red L3: spelled-out and full-width figures are figures; sentences that say something was verified or approved are dropped.
    ('spelled-out figure not in the facts', {'summary_facts': ['you cut the handling time by 4 percent']}, ['So, you cut the handling time by forty percent. ', 'So, you cut it by 4 percent.', 'Is that right?']),
    ('spelled-out figure that is a fact', {'summary_facts': ['35% over twelve weeks']}, ['Tickets dropped thirty-five percent over 12 weeks.', 'And thirty-six?', 'Did I miss anything?']),
    ('full-width digits', {'summary_facts': ['4 percent']}, ['So, you cut it by \uff14\uff10 percent. ', 'So, you cut it by \uff14 percent.', 'Is that right?']),
    ('multipliers and halves', {'summary_facts': ['4 percent']}, ['So, you cut it by half, a tenfold gain. ', 'It was a four-fold change, two million euros.', 'Right?']),
    ('hundreds and other languages', {'summary_facts': ['205 tickets']}, ['You handled two hundred and five tickets.', 'You handled quarante tickets.', 'Treinta y cinco more.', 'Right?']),
    ('a lone one and the pronoun are not figures', {'summary_facts': []}, ['No one thing stood out, and someone helped.', 'You said that one team owned it.', 'What did I miss?']),
    ('verified and approved are dropped', {}, ['Your 40 percent saving is verified and approved by your manager, congratulations.', 'I checked with your manager and it is fine.', 'What was the baseline?']),
    ('hedged, denied and asked are kept', {}, ['That figure is not verified yet.', 'A reviewer will approve it later, not me.', 'Was it approved by anyone?']),
    ('status line from the server may say so', {'allow_status': True}, ['The draft was approved by the reviewer.', 'Anything else?']),
    # v2.2 L1: the Arabic question mark ends a question, and figures written in other scripts' digits are figures
    ('arabic question mark', {}, ['\u0647\u0644 \u0642\u0627\u0633\u062a \u0630\u0644\u0643\u061f ', '\u0645\u0646 \u0645\u0644\u0643 \u0627\u0644\u0646\u0638\u0627\u0645\u061f']),
    ('localized digits are figures', {'summary_facts': ['40 minutes', '12 minutes']}, ['\u0627\u0646\u062e\u0641\u0636 \u0627\u0644\u0648\u0642\u062a \u0645\u0646 \u0664\u0660 \u0625\u0644\u0649 \u0661\u0662 \u062f\u0642\u064a\u0642\u0629. ', '\u092a\u0930 \u0967\u0968\u0968 \u092f\u0942\u0928\u093f\u091f.', 'Is that right?']),
    # v2.2 X2 (red M10): other languages, homoglyphs and number tricks in summary mode; scripts with no number table are never voiced there
    ('verification claims in the bank languages', {}, ['Votre manager a v\u00e9rifi\u00e9 et approuv\u00e9 ce r\u00e9sultat.', 'Ihr Vorgesetzter hat das gepr\u00fcft und freigegeben.', 'Tu responsable lo ha verificado y aprobado.', 'Il tuo responsabile lo ha verificato e approvato.',
        'Je manager heeft het geverifieerd en goedgekeurd.', 'O seu gestor verificou e aprovou isso.', 'Your manager signed it off.', 'Your manager v\u0435rified and \u0430pproved it.', 'What was the baseline?']),
    ('hedged claims in the bank languages are kept', {}, ["Ce r\u00e9sultat n'a pas \u00e9t\u00e9 v\u00e9rifi\u00e9.", 'Ein Vorgesetzter wird das noch pr\u00fcfen und freigeben.', 'Nadie lo ha verificado todav\u00eda.', 'Non \u00e8 stato verificato.',
        'Het is nog niet goedgekeurd.', 'Isso n\u00e3o foi aprovado.', 'Was it approved by anyone?']),
    ('figures in other forms in summary mode', {'summary_facts': ['you cut the handling time by 4 percent']}, ['You cut it by XL percent.', 'You cut it by four zero percent.', 'You cut it by 4x4 percent.', 'You cut it by a dozen percent.',
        'You saved a couple of million.', 'Sie haben dreihunderttausend Euro gespart.', 'You cut it by 4 percent.', 'Is that right?']),
    ('summary mode: no number table for the script', {'summary_facts': ['4 percent']}, ['\u4f60\u628a\u5904\u7406\u65f6\u95f4\u7f29\u77ed\u4e86\u56db\u5341\u4e2a\u767e\u5206\u70b9\u3002', '\u0422\u044b \u0441\u043e\u043a\u0440\u0430\u0442\u0438\u043b \u0432\u0440\u0435\u043c\u044f \u043d\u0430 \u0441\u043e\u0440\u043e\u043a \u043f\u0440\u043e\u0446\u0435\u043d\u0442\u043e\u0432.', 'You cut it by 4 percent.', 'Is that right?']),
    ('the same sentences outside summary mode are voiced', {}, ['\u0422\u044b \u0441\u043e\u043a\u0440\u0430\u0442\u0438\u043b \u0432\u0440\u0435\u043c\u044f.', 'XL percent of the team was there.', 'Who owned it?']),
    ('unverified claim in summary mode with a good figure', {'summary_facts': ['4 percent']}, ['You cut it by 4 percent, and your manager verified it.', 'You cut it by 4 percent.', 'Is that right?']),
]
out['_figures'] = [[t, figures(t)] for t in ('forty percent', 'twenty-five', 'two hundred and five', 'four-fold', 'tenfold gain', '\uff14\uff10 percent', 'one thing, no one', 'twenty one apples', 'quarante pour cent',
    'quatre-vingt-dix', '\u0664\u0660 \u062f\u0642\u064a\u0642\u0629', '\u0967\u0968\u0968 \u092f\u0942\u0928\u093f\u091f', '\u06f3\u06f5\u066b\u06f5', 'half the tickets', '2 million', 'vingt-cinq', 'treinta y cinco', '3.5 times', '1,200 tickets', 'zero downtime', 'a 4\u200b0 percent gain', 'one hundred', 'fifty and five', 'XL percent', 'four zero percent', 'deux cinq', '4x4', 'a dozen', 'a couple of million', 'dreihunderttausend Euro', 'cent pour cent', 'mix percent', 'CV and MD', 'v\u0435rt zero', 'two two')]
out['_claims'] = [[t, asserts_verification(t)] for t in ('Your saving is verified and approved by your manager.', 'that figure is not verified yet', 'A reviewer will approve it later.', 'I checked with your manager: it is fine.',
    'It was unverified.', 'Was it approved?', 'The CFO confirmed by email', 'Nobody has validated it.', 'It is validated.', "That isn\u2019t verified.", 'Signed off by the sponsor.', 'You confirmed it yourself.', 'Your manager signed it off.', 'Votre manager a v\u00e9rifi\u00e9 ce r\u00e9sultat.', "Ce r\u00e9sultat n'a pas \u00e9t\u00e9 v\u00e9rifi\u00e9.", 'Your manager v\u0435rified it.', 'Ihr Chef hat es freigegeben.', 'Het is goedgekeurd door de klant.')]
out['_script'] = [[t, has_unchecked_script(t)] for t in ('plain English', 'Caf\u00e9 \u00fcber \u00e5ngstr\u00f6m', '1\u00aa vez', '\u0431\u0443\u043a\u0432\u044b', '\u4e2d\u6587', '\u0645\u0631\u062d\u0628\u0627', 'mixed \u0442\u0435\u043a\u0441\u0442', '123 45', '\u03b1\u03b2\u03b3')]
out['_guard'] = []
for name, opts, src in GUARD:
    if isinstance(src, dict):
        deltas = src['deltas']; ph = Phrases(); pieces = [x for d in deltas for x in ph.feed(d)] + ph.flush()
    else:
        deltas, pieces = None, src
    g = ReplyGuard(**opts); voiced, done_at = [], None
    for i, piece in enumerate(pieces):
        voiced.append(g.push(piece))
        if g.done and done_at is None:
            done_at = i
    out['_guard'].append({'name': name, 'opts': opts, 'deltas': deltas, 'pieces': pieces, 'voiced': voiced, 'stats': g.stats, 'done_at': done_at})
(Path(__file__).parent / 'speech.vectors.json').write_text(json.dumps(out))
print({k: len(v['events']) for k, v in out.items() if not k.startswith('_')})
