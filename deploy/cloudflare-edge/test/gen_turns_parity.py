"""Record Python analyze_turn on a table of utterances (plus edge cases) for the JS parity test."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.turns import analyze_turn

EN = [
    'I helped improve the platform', 'we delivered the migration', 'about 80% faster', "I can't share the client name", 'can we pause for a sec',
    'sorry, it was 35 not 38', "I don't know", "yes that's right", "no, that's wrong", 'the pilot failed and we had to roll back',
    'we used Python, Kafka and Terraform', 'AWS Solutions Architect certified', 'the client said it was the best team they had',
    "I'm in a hurry, can we keep this short", 'Can you repeat the question?', 'what do you mean by baseline?', "let's continue", "I'm back, let's carry on",
    'can we skip this one', 'next question please', "that's all for now", "I'm done", 'we paused the rollout for two weeks', 'no idea', 'no measurement was taken',
    "I'm not sure", "I'm not sure, maybe 40%", 'it saved about $1.5 million a year', 'cut costs by 1,200 euros over 3 months', 'latency fell from 800 ms to 250ms',
    'roughly 3x faster, ~12 hours a week', 'we handled 2k tickets and 5.5k users', 'I led the design and we rolled it out to 12 teams', 'It was under NDA so I cannot name them',
    "That's confidential", 'the customer was delighted and told us it was fantastic', 'we had a great NPS of 72', 'it did not work the first time and we hit a snag',
    'I was involved in the migration and worked on the pipeline', 'We streamlined onboarding', 'We streamlined onboarding by 30%', 'I personally owned the cutover plan',
    'Yes, we migrated the billing platform to Azure', 'Right, so the main problem was the legacy batch jobs and the backlog', 'No problem, go ahead', 'no',
    'uh, no.', 'Nope, it was the other team', 'okay', 'sure thing, we also used Docker, Kubernetes, Helm and Jenkins on GitHub Actions',
    'The risk was a regulatory fine; we chose Kafka instead of RabbitMQ and measured the baseline per week', 'Who adopted it? The ops team took over after handover',
    'It only works for customers with a data platform; it would not work without a sponsor', 'I think it was probably ten percent, give or take',
    'CISSP and PMP, also a Scrum Master', 'on time and under budget', '', '   ', '?', 'a', 'x' * 40, 'Why are you asking that?', 'can you rephrase that',
    'one sec', 'hold on a moment', 'Sorry, what did you say?', 'I meant March, not April', 'Actually it was 27', 'we continue to use Kafka', 'we need to go through the logs',
    'I have to go now', 'brb', '1.000 users and 3,5 hours', '$5 million and 2h and 250ms', '3m records', '1,2,3', '99999999999999999999 widgets',
    'Café résumé: naïve déjà vu, we used Python, Kafka and Terraform', 'the ‘client’ said “it was the best team they had”', 'we delivered the migration',
    'I CAN’T SHARE THE CLIENT NAME', 'NO, THAT’S WRONG', 'That is not correct', 'you are right', 'agreed', 'I disagree', 'Not really', 'not sure about that',
    'I do not know that', 'we served 1.000.000 users and 2.500 tickets', 'latency fell about forty percent', 'go ahead', 'we did not have a problem with it',
    'Well... it depends', 'the team delivered it and the sponsor loved it', 'we rolled it out in 2023 and it was successful',
    # v2.1 H1: stopping words that must beat "deny", setback cues, the "zero data loss" strip, wider hints, praise and achievement words, a client being named
    "I think we covered it, I have nothing more to say.", "No, I think that is all, thank you.", "That's everything from me, thanks", "No, that is all", "that's it for me",
    "no, that's all wrong", "yes, that's it", "That is all right", "nothing else to add", "we've covered everything", "That's all I have, thank you very much indeed for your time today everyone", "I think we covered it and there is nothing more to say about this project at all, so thanks for asking all of those questions",
    "It was really frustrating, the team was exhausted and the new sponsor did not care about the project at all.", "the sponsor left halfway", "there was a lot of pushback and resistance from the ops team",
    "It went live on time with zero data loss, around two million records.", "we had no outage and without any downtime", "we had data loss on the first night", "a difficult tough conflict",
    "Mostly I worked on the release pipeline and the monitoring, making things more efficient for everyone.", "I was responsible for the cutover", "I handled the runbooks and I owned the rollback plan",
    "It was a data migration for a bank", "this was an enterprise cloud rollout for a retailer", "The release manager and the two squads used it every day after we left, they owned it.",
    "Deployments went down by 80 percent, it was a huge success and the client loved it.", "the client loved it", "the customers were really happy", "it dropped and we were faster and had fewer tickets",
    "Report preparation went from 10 days to 2 days per study.", "I can not name the client, it is a big pharma company under NDA, but we rebuilt their clinical trial reporting.",
    "I can not share the documents, they are confidential.", "I can't say who they are", "which bank was it", "I don't have the numbers", "I don't have that data", "We do not have the figures for that.", "we have the numbers",
]
OTHER = [
    ('on peut faire une pause ?', 'fr'), ('on reprend', 'fr'), ('pouvez-vous répéter la question', 'fr'), ('passons à la question suivante', 'fr'), ('je ne sais pas', 'fr'),
    ('Je ne peux pas partager le nom du client', 'fr'), ('terminons ici', 'fr'), ('oui, exactement', 'fr'), ('non, ce n\'est pas ça', 'fr'), ('non', 'fr'), ('nous avons livré la migration', 'fr'),
    ('Podemos hacer una pausa', 'es'), ('continuemos', 'es'), ('puedes repetir la pregunta', 'es'), ('siguiente pregunta', 'es'), ('no sé', 'es'), ('no se hizo así', 'es'),
    ('no puedo compartir el nombre del cliente', 'es'), ('terminemos por hoy', 'es'), ('sí, claro', 'es'), ('si el cliente lo pide lo hacemos', 'es'), ('no, es incorrecto', 'es'), ('entregamos la migración', 'es'),
    ('pause please', 'de'), ('ありがとう', 'ja'), ('I helped improve the platform', 'fr'), ('I helped improve the platform', 'EN-us'), ('yes', 'en_GB'), ('yes', None), ('yes', ''),
]
CONTEXT = [
    ('We moved the batch jobs to Kafka last spring', 'en', {'asked_field': 'adoption'}), ('yes', 'en', {'asked_field': 'adoption'}), ('I do not know that', 'en', {'asked_field': 'outcome'}),
    ('It took about a quarter of the time', 'en', {'asked_field': 'measurement'}), ('We were all over the place', 'en', {'asked_field': 'nope'}), ('We were all over the place really', 'en', {'asked_field': 'poor_fit'}),
    ('We were all over the place really', 'en', 'adoption'), ('We were all over the place really', 'en', ['adoption']), ('We were all over the place really', 'en', {'asked_field': 3}),
]
cases = [[t, 'en', None] for t in EN] + [[t, l, None] for t, l in OTHER] + [[t, l, c] for t, l, c in CONTEXT]
cases += [[None, 'en', None], [42, 'en', None], [['a'], 'en', None], ['we delivered the migration. ' * 400, 'en', None], ['3 ' * 600, 'en', None]]
out = [[c, analyze_turn(*c)] for c in cases]
(Path(__file__).parent / 'turns.vectors.json').write_text(json.dumps(out, ensure_ascii=False))
print(len(out))
