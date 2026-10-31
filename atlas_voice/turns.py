"""Deterministic pre-pass over ONE consultant utterance (Agent Brain v2.1 §3b, D18).

analyze_turn() reads the words of a single utterance and reports what the WORDS do: which conversational request they make
(`intents`), which kinds of claim they contain (`cues`), which ledger fields they probably cover (`field_hints`) and the numbers
they mention. It never describes the person: no mood, emotion, sentiment or personality, only events in the text. Pure and fast
(regexes over at most MAX_CHARS characters, no I/O, no model, no clock).

This module is the source of truth for the edge Worker: build_edge.py exports EDGE_CONSTANTS into src/policy.generated.js and
src/turns.js ports analyze_turn (parity vectors: test/gen_turns_parity.py -> test/turns.vectors.json). Every pattern here is
written in the subset of regex syntax that Python (re.I | re.A) and JavaScript (flag i) read identically; the text is normalised
the same way on both sides (accents stripped, lower-cased, curly quotes straightened, whitespace collapsed).
English has intents, cues and field hints; French, Spanish, Portuguese, German, Italian and Dutch have intents only (the control requests of v2.2 L1: pause, resume, repeat,
skip, dont_know, cannot_disclose, correction, rushed, stop, confirm, deny); any other language returns empty lists, so its words are treated as an answer and the page's
buttons are the way to pause, repeat or skip.
"""
import re
import unicodedata

from .quality import FIELDS, NUMERIC, UNCERTAIN, UNKNOWN
from .regex_gate import gate, passes

MAX_CHARS = 1500       # only the start of a very long answer (about 250 words) is read for intents, cues and numbers; keeps the pass near 1 ms
MAX_NUMBERS = 20
INTENT_ORDER = ['pause', 'resume', 'repeat', 'skip', 'dont_know', 'cannot_disclose', 'correction', 'rushed', 'stop',
                'question_to_atlas', 'confirm', 'deny']
CUE_ORDER = ['metric', 'estimate', 'vague_verb', 'team_claim', 'tech_list', 'certification', 'client_praise',
             'describes_setback', 'describes_achievement', 'names_party', 'describes_problem', 'period_stated', 'describes_action']
LANGS_WITH_CUES = ('en',)
LANGS_WITH_INTENTS = ('en', 'fr', 'es', 'pt', 'de', 'it', 'nl')

_END = r"(?=\s*[,.;!?]|\s*$)"   # a bare word ends here (so "no idea" is not a "no")


def _rule(intent, src, max_words=None, unless_intents=(), unless_src=''):
    """One intent rule. max_words: only utterances this short. unless_intents: skipped when one of those matched earlier in
    the list. unless_src: skipped when this pattern also matches the utterance. gate: the literals the pattern cannot match without (regex_gate.py)."""
    return {'intent': intent, 'src': src, 'max_words': max_words, 'unless_intents': list(unless_intents), 'unless_src': unless_src, 'gate': gate(src)}


# Order matters: a rule may only look back at intents matched by earlier rules.
INTENT_RULES = {
    'en': [
        _rule('pause', r"\b(?:(?:can|could|may|shall|should) we (?:just |please )?pause|(?:let'?s|please|i(?: want| need|'d like) to|can i|could i|may i|i'?ll|let me) (?:just )?pause|pause (?:for (?:a |one |just )?(?:sec|second|moment|minute|bit|break)|the (?:interview|session|conversation|call)|this|it|please|here)|need a (?:break|breather|minute|moment|sec|second)|take a (?:break|breather|minute|moment)|(?:give me|just) a (?:sec|second|moment|minute)|one (?:sec|second|moment|minute)|(?:wait|hang on|hold on) a (?:sec|second|moment|minute)|be right back|brb)\b|^(?:(?:ok|okay|sorry|um|uh|wait)[, ]+)*(?:pause|hold on|hang on)\b"),
        _rule('resume', r"\b(?:(?:let'?s|can we|could we|please|ok(?:ay)?,?|we can|shall we|ready to|i'?m ready to|i am ready to) (?:just )?(?:continue|resume|carry on|keep going|go on|get back|pick (?:it |this )?up)|i'?m back|i am back|i'?m ready|i am ready)\b|^\W*(?:continue|resume|go ahead|carry on|keep going)\W*$"),
        _rule('resume', r"\bgo ahead\b", max_words=5),
        _rule('repeat', r"\b(?:say (?:that|it) again|(?:ask|say) (?:that|it|the question) (?:one more time|again)|repeat (?:that|the question|it|please|your question)|can you repeat|could you repeat|would you repeat|come again|pardon|sorry,? (?:what|i didn'?t (?:catch|hear|get))|i (?:didn'?t|did not|couldn'?t|could not) (?:catch|hear|get) (?:that|the question|what you)|what was (?:that|the question)|what did you (?:say|ask)|didn'?t hear you)\b"),
        _rule('skip', r"\b(?:(?:let'?s|can we|could we|please|we can|i(?:'d| would) like to|shall we|time to|i want to) (?:just )?(?:skip|move on|move along|go on to|go to the next|pass)|i(?:'d| would) rather not (?:answer|say|get into)|prefer not to (?:answer|say))\b|^\W*(?:(?:ok|okay|um|uh|so|and)[, ]+)*(?:skip (?:it|this|that)|skip|pass|(?:(?:let'?s )?(?:go|move|jump) (?:on )?to |on to )?(?:the )?next (?:question|one)(?: please)?)\W*$"),
        _rule('cannot_disclose', r"\b(?:(?:can'?t|cannot|can not|couldn'?t|am not (?:able|allowed|permitted|authori[sz]ed) to|aren'?t allowed to|not (?:able|allowed|permitted|authori[sz]ed) to|unable to|not at liberty to|don'?t think i (?:can|should)) (?:really )?(?:share|disclose|say|reveal|discuss|name|tell you|talk about|give)|under (?:an )?nda|nda|non[- ]disclosure|(?:it'?s|that'?s|this is|that is|it is|they are|is|all) (?:strictly |highly )?confidential|confidentiality (?:agreement|clause|reasons)|i'?d rather not (?:name|say|share)|can'?t (?:go into|get into)|not authori[sz]ed to disclose)\b"),
        # Reuses quality.UNKNOWN (not measured, no baseline, don't know, ...); a disclosure refusal is not "I don't know".
        _rule('dont_know', UNKNOWN.pattern, unless_intents=['cannot_disclose']),
        _rule('dont_know', r"\b(?:(?:don'?t|do not|dont) (?:really |actually |exactly |quite )?know|dunno|no idea|no clue|(?:can'?t|cannot|don'?t|do not|didn'?t) (?:really |quite )?(?:remember|recall)|never (?:measured|tracked)|we never (?:measured|tracked)|couldn'?t say|i have no way (?:of|to) know|(?:don'?t|do not|dont) have (?:the |any |that |those |exact |these )*(?:numbers?|data|figures?|stats|statistics|metrics?|baseline|measurements?))\b", unless_intents=['cannot_disclose']),
        _rule('dont_know', r"^\W*(?:(?:um|uh|hmm|well|honestly|sorry|er)[, ]+)*(?:i'?m |i am )?(?:not (?:really )?sure|unsure|not certain)\b", max_words=8, unless_src=r'\d'),
        _rule('correction', r"\b(?:sorry,? (?:i meant|i mean|it was|it'?s|that was|that'?s|i said)|i meant|correction|let me (?:correct|rephrase)|to correct (?:myself|that)|i misspoke|actually,? (?:it was|it'?s|that was|that'?s|i meant|no|it is)|no,? (?:it was|it'?s|i meant|wait)|scratch that|strike that|make that|wait,? (?:no|that'?s|it was|i)|\d+(?:[.,]\d+)?\s*%?\s*,?\s*not\s+\d)"),
        # implicit corrections: "actually it was 3 days", "actually the reporting was for four studies", "four studies, not all of them". Written to start with a literal, so a long
        # answer with none of these words costs next to nothing.
        _rule('correction', r"(?:was|is) actually (?:\d|only|just|about|around|closer to|more like|for|in|at|from|with|the)\b|actually,? (?:the|that|it|this|they|we|i|there)\s+(?:\w+\s+){0,3}?(?:was|were|is|are|had|did)\b"),
        _rule('correction', r",\s*not\s+(?:all|every|the whole|everything|everyone|the rest)\b"),
        _rule('rushed', r"\b(?:in a (?:hurry|rush)|short on time|(?:running|pressed|pushed) for time|running late|(?:have|got|i have|i'?ve got) (?:a|another) (?:meeting|call) (?:in|at|soon|now)|got to run|gotta run|have to run|(?:keep|make) (?:this|it) (?:short|quick|brief)|be brief|only (?:have )?(?:a )?(?:few|couple|five|ten|\d+) (?:minutes?|mins?)|(?:five|ten|\d+) (?:minutes?|mins?) (?:left|only|max)|not much time|(?:shorter|short) version|wrap (?:this|it) up quickly|(?:i|i'?ve) (?:really )?(?:need|have|got|gotta) to (?:go|leave|run|jump off|hop off|drop off)\b(?! through| over| into| back| with| live| to))\b"),
        _rule('stop', r"\b(?:(?:let'?s|can we|could we|i(?:'d| would) like to|i want to|i need to|please|we can|i'?m going to|time to|shall we|i think we should|i'?m ready to) (?:just |please )?(?:stop|end|finish|wrap up|call it|quit|conclude)(?: (?:here|now|the (?:interview|session|conversation|call)|this|it|for today|there))?|that'?s (?:all|enough|it) for (?:now|today)|(?:i'?m|we'?re|we are|i am) done(?! with| (?:the|that|this) )|stop (?:the )?(?:interview|session|recording)|end (?:the )?(?:interview|session|conversation)|call it a day|enough for (?:now|today)|that'?s all i (?:have|got|can))\b|^\W*stop\W*$"),
        # "nothing more to add", "we've covered it", "that is all, thank you": a short closing remark (a bare "that's it" is left to `confirm`, it answers a yes/no check)
        _rule('stop', r"\bnothing (?:more|else) to (?:add|say)\b|\b(?:i think )?we(?:'ve| have)? covered (?:it|everything)\b|^\W*(?:no,? )?(?:i think )?(?:that'?s|that is) (?:all|everything)(?: (?:from me|for me|i have))?\W*(?:thank you|thanks)?\W*$|^\W*(?:no,? )?(?:i think )?(?:that'?s|that is) it (?:from|for) me\W*(?:thank you|thanks)?\W*$", max_words=14),
        _rule('question_to_atlas', r"\b(?:what do you mean|what does that mean|i don'?t understand (?:the|your) question|can you (?:rephrase|clarify|explain)|could you (?:rephrase|clarify|explain)|why (?:are|do) you (?:ask|asking)|what are you asking)\b", max_words=30,
              unless_intents=['pause', 'resume', 'repeat', 'skip', 'stop', 'rushed']),
        _rule('question_to_atlas', r"""^(?:(?:so|and|but|well|ok|okay|sorry|um|uh|hmm)[, ]+)*(?:what|why|how|who|which|when|where|can you|could you|would you|do you|did you|are you|is this|is that|is it|does this|does that|should i|can i|may i|am i)\b.*\?["')\s]*$""", max_words=25,
              unless_intents=['pause', 'resume', 'repeat', 'skip', 'stop', 'rushed']),
        _rule('question_to_atlas', r"""\b(?:you|your|atlas|this question|that question|mean)\b.*\?["')\s]*$""", max_words=20,
              unless_intents=['pause', 'resume', 'repeat', 'skip', 'stop', 'rushed']),
        _rule('confirm', r"^\W*(?:(?:ok|okay|um|uh|well|so|hmm)[, ]+)*(?:yes|yeah|yep|yup|correct|exactly|absolutely|precisely|indeed|affirmative|that'?s (?:right|correct|true|it|exactly)|that is (?:right|correct|true)|you'?re right|you are right|sounds (?:right|correct|good)|that sounds (?:right|correct|good)|spot on|i agree|agreed)\b"),
        _rule('confirm', r"\bthat'?s (?:right|correct|exactly right)\b"),
        _rule('confirm', r"^\W*(?:ok|okay|sure|right|fine|alright|uh huh|mm hmm|mhm|good|got it)\W*$", max_words=4),
        _rule('deny', r"^\W*(?:(?:ok|okay|um|uh|well|so|hmm)[, ]+)*(?:no" + _END + r"|no (?:that|thats|that's|it|its|it's|they|we|i|you|not|never|way|absolutely|definitely|wait|actually|sorry|because)\b|nope|nah|not really|not quite|negative|wrong|incorrect|that'?s (?:wrong|incorrect|not (?:right|correct|true|quite right|accurate|what i said|it))|that is (?:wrong|incorrect|not (?:right|correct|true))|you'?re (?:wrong|not right)|you are (?:wrong|not right)|not (?:right|correct|accurate)|i disagree|disagree)\b", unless_intents=['stop']),
        _rule('deny', r"\bthat'?s (?:wrong|incorrect|not (?:right|correct|true|accurate))\b", unless_intents=['stop']),
    ],
    'fr': [
        _rule('pause', r"\b(?:(?:faire|faisons|une|petite|besoin d'une) pause|un (?:petit )?(?:instant|moment)|une (?:petite )?(?:seconde|minute)|deux secondes)\b|^\W*(?:(?:ok|bon|euh|attendez|alors)[, ]+)*(?:pause|attendez|attends)\b"),
        _rule('resume', r"\b(?:reprenons|continuons|on reprend|on peut reprendre|on peut continuer|vous pouvez continuer|continuez|je suis de retour|je suis pret|je suis prete|allons-y)\b"),
        _rule('repeat', r"\b(?:repeter|repetez|repete|redire|redites|je n'ai pas (?:bien )?(?:compris|entendu|saisi)|pardon|quelle etait la question|encore une fois)\b"),
        _rule('skip', r"\b(?:(?:passons|sautons) (?:cette|a|au|ce|la|cela|ca)|on (?:peut|pourrait) (?:passer|sauter)|(?:question|point) suivante?|prochaine question|je prefere ne pas (?:repondre|en parler|dire)|je prefere passer|passer cette question|laissons tomber|laisse tomber|on passe a (?:la suivante|autre chose|la question suivante))\b"),
        _rule('cannot_disclose', r"\b(?:je ne peux pas (?:partager|divulguer|dire|reveler|en parler|donner|communiquer|citer|nommer)|(?:c'est|est|sont|tout est|strictement|ca reste|reste) (?:strictement )?confidentiel(?:le)?s?|nda|accord de confidentialite|clause de confidentialite|je n'ai pas le droit|ne suis pas autorise(?:e)?|secret professionnel|je prefere ne pas (?:nommer|citer|divulguer))\b"),
        _rule('dont_know', r"\b(?:je ne sais pas|je sais pas|j'en sais rien|aucune idee|pas la moindre idee|je ne (?:me )?(?:rappelle|souviens) pas|je ne me souviens plus|pas mesure|jamais mesure|pas de (?:mesure|reference|baseline)|aucune mesure|on ne sait pas)\b", unless_intents=['cannot_disclose']),
        _rule('correction', r"\b(?:pardon,? (?:je voulais dire|c'etait|je veux dire)|je voulais dire|je veux dire|correction|laissez(?:-moi)? corriger|je me corrige|je corrige|rectification|disons plutot|ou plutot|en fait,? (?:c'etait|c'est|je voulais dire)|non,? (?:c'etait|je voulais dire|attendez)|oubliez ca|\d+(?:[.,]\d+)?\s*%?\s*,?\s*(?:et )?pas\s+\d)"),
        _rule('rushed', r"\b(?:je suis presse|je suis pressee|je manque de temps|pas beaucoup de temps|peu de temps|j'ai (?:une|un autre) (?:reunion|appel) (?:dans|a|bientot|maintenant)|je dois filer|je dois courir|soyons (?:brefs?|rapides?)|restons (?:brefs?|rapides?)|version (?:courte|rapide)|faisons court|en vitesse|vite fait|plus que (?:cinq|dix|\d+) minutes|(?:cinq|dix|\d+) minutes (?:maximum|max|seulement))\b"),
        _rule('stop', r"\b(?:on (?:peut )?(?:s'arreter|arreter|terminer|finir|conclure)|arretons|terminons|finissons|j'ai fini|c'est tout (?:pour|ce que)|on s'arrete la|on en reste la|je dois y aller|je dois partir|fin de l'entretien|mettre fin|arretez|assez pour aujourd'hui|ca suffit|ca sera tout)\b|^\W*stop\W*$"),
        _rule('confirm', r"^\W*(?:(?:ok|bon|alors|bah|ben|euh)[, ]+)*(?:oui|ouais|exactement|exact|tout a fait|absolument|d'accord|c'est (?:bien )?(?:ca|exact|correct|juste|vrai)|voila|parfaitement|effectivement|certainement|bien sur|en effet|correct|ok|okay|entendu|yep)\b"),
        _rule('deny', r"^\W*(?:(?:ok|bon|alors|bah|ben|euh)[, ]+)*(?:non" + _END + r"|non (?:c'est|ce|pas|jamais|ca)\b|pas du tout|pas vraiment|faux|incorrect|c'est (?:faux|incorrect|pas (?:ca|vrai|correct|exact|juste))|ce n'est pas (?:ca|vrai|correct|exact|juste)|pas exactement|absolument pas|je ne suis pas d'accord|pas d'accord|nope|nan\b)"),
        _rule('deny', r"\b(?:c'est (?:faux|incorrect)|ce n'est pas (?:ca|vrai|correct|exact|juste)|c'est pas (?:ca|vrai|correct|exact|juste))\b"),
    ],
    'es': [
        _rule('pause', r"\b(?:hacer una pausa|haz una pausa|una pausa|un momento|un segundo|un minuto|un instante|dame un (?:momento|segundo)|necesito (?:un momento|una pausa))\b|^\W*(?:(?:ok|vale|oye|perdon)[, ]+)*(?:pausa|espera|espere|esperame)\b"),
        _rule('resume', r"\b(?:continuemos|sigamos|podemos (?:seguir|continuar|retomar)|retomemos|ya volvi|ya estoy (?:aqui|de vuelta)|estoy de vuelta|estoy list[oa]|puedes continuar|puede continuar|puedes seguir)\b|^\W*adelante\b"),
        _rule('repeat', r"\b(?:(?:puedes|puede|podrias|podria|por favor|favor de) repetir|repite(?:lo)?|repita(?:lo)?|no (?:te |le )?(?:he )?(?:oido|entendido|escuchado)|no entendi|cual era la pregunta|que dijiste|que has dicho|(?:dilo|decirlo|digalo) (?:otra vez|de nuevo)|otra vez por favor)\b"),
        _rule('skip', r"\b(?:(?:saltemos|omitamos|pasemos) (?:esta|este|eso|esto|la|a)|(?:podemos|puedo) (?:saltar|omitir|pasar)|siguiente pregunta|prefiero no (?:responder|contestar|hablar|decir)|dejemos (?:esto|eso|este tema|ese tema)|pasemos a la siguiente|mejor pasemos)\b"),
        _rule('cannot_disclose', r"\b(?:no puedo (?:compartir|revelar|divulgar|decir|hablar|dar|mencionar|nombrar)|(?:es|son|esta|todo es|totalmente|estrictamente) (?:totalmente |estrictamente )?confidencial(?:es)?|nda|acuerdo de confidencialidad|no estoy autorizad[oa]|no tengo permiso|no me esta permitido|prefiero no (?:nombrar|decir el nombre|mencionar))\b"),
        _rule('dont_know', r"\b(?:no se(?=\s*(?:[,.;!?]|$)|\s+(?:nada|mucho|bien|exactamente|cuanto|cuantos|cuantas|cual|cuales|quien|por que|cuando|donde|como|si|la respuesta|realmente))|no lo se|ni idea|no tengo (?:ni )?idea|no recuerdo|no me acuerdo|no lo sabemos|no sabemos|no se midio|nunca se midio|sin linea base|no hay medicion)\b", unless_intents=['cannot_disclose']),
        _rule('correction', r"\b(?:perdon,? (?:queria decir|era|fue)|queria decir|quise decir|correccion|dejame corregir|me corrijo|corrijo|mejor dicho|en realidad (?:era|fue|es|queria decir)|no,? (?:era|fue|queria decir|espera)|olvida eso|borra eso|\d+(?:[.,]\d+)?\s*%?\s*,?\s*no\s+\d)"),
        _rule('rushed', r"\b(?:tengo prisa|ando con prisa|estoy con prisa|poco tiempo|falta de tiempo|no tengo mucho tiempo|tengo (?:una|otra) (?:reunion|llamada) (?:en|a|ahora|pronto)|tengo que irme corriendo|vayamos rapido|seamos breves|version (?:corta|breve)|hagamoslo corto|solo (?:tengo )?(?:cinco|diez|\d+) minutos|(?:cinco|diez|\d+) minutos (?:maximo|nada mas))\b"),
        _rule('stop', r"\b(?:terminemos|paremos|acabemos|podemos (?:terminar|parar|acabar)|vamos a (?:terminar|parar)|ya termine|eso es todo|es todo por (?:hoy|ahora)|tengo que irme|debo irme|finalicemos|fin de la entrevista|basta por hoy|dejemos (?:aqui|la entrevista|por hoy)|quiero (?:terminar|parar))\b"),
        _rule('confirm', r"^\W*(?:(?:ok|vale|bueno|pues|eh)[, ]+)*(?:si(?=\s*(?:[,.;!?]|$)|\s+(?:es correcto|eso es|es asi|asi es|claro|correcto|exacto|exactamente|por supuesto|lo es|es verdad|tienes razon|tiene razon))|claro|exacto|exactamente|correcto|asi es|eso es|de acuerdo|vale|ok|okay|perfecto|efectivamente|por supuesto|cierto|afirmativo|asi mismo)\b"),
        _rule('deny', r"^\W*(?:(?:ok|vale|bueno|pues|eh)[, ]+)*(?:no" + _END + r"|no es (?:correcto|cierto|asi|verdad|eso)|para nada|incorrecto|falso|eso no es (?:correcto|cierto|asi|verdad)|asi no)"),
    ],
    # pt, de, it and nl (v2.2 L1): the control intents only (pause, resume, repeat, skip, cannot_disclose, dont_know, correction, rushed, stop, confirm, deny), written like the
    # fr and es tables: accent-free lower case (the text is normalised first), a rule may look back only at earlier intents. Every table needs a native-speaker review.
    'pt': [
        _rule('pause', r"\b(?:(?:podemos|vamos|posso|quero) (?:fazer )?(?:uma )?pausa|preciso de (?:uma |um )?(?:pausa|intervalo|minuto|momento)|me da (?:um|uma) (?:momento|minuto|segundo)|ja volto|volto ja)\b|^\W*(?:(?:ok|certo|desculpe|um)[, ]+)*(?:pausa|espera|espere|aguarde)\b"),
        _rule('pause', r"\b(?:um|uma) (?:momento|momentinho|minuto|minutinho|segundo|segundinho|instante)\b", max_words=5),   # a bare "one moment" is a request only in a short remark ("em um momento do projeto..." is an answer)
        _rule('resume', r"\b(?:vamos (?:continuar|retomar|seguir)|podemos (?:continuar|retomar|seguir)|pode (?:continuar|seguir)|retomemos|continuemos|ja voltei|estou de volta|voltei|estou pront[oa])\b|^\W*(?:continuar|retomar|seguir|pode ir|vamos la)\W*$"),
        _rule('repeat', r"\b(?:repet(?:e|a|ir)|(?:pode|poderia|podia) repetir|(?:diz|diga|fala|fale) de novo|nao (?:entendi|ouvi|escutei|compreendi)|qual (?:era|foi) a pergunta|o que (?:voce )?(?:disse|perguntou)|de novo,? por favor)\b"),
        _rule('skip', r"\b(?:(?:vamos|podemos|posso|quero) (?:pular|passar|seguir em frente|ir para a proxima)|proxima pergunta|(?:prefiro|preferia) nao (?:responder|falar|dizer|comentar)|pular (?:essa|esta|isso)|passemos a proxima|deixa pra la|deixemos isso)\b"),
        _rule('cannot_disclose', r"\b(?:nao (?:posso|consigo|tenho permissao para|estou autorizad[oa] a) (?:compartilhar|partilhar|divulgar|dizer|revelar|falar|citar|mencionar|nomear|dar)|(?:e|esta|sao|tudo e|isso e|isso esta) (?:estritamente |totalmente )?confidenciais?|confidencial|nda|acordo de confidencialidade|clausula de confidencialidade|nao tenho (?:o )?direito|prefiro nao (?:nomear|citar|divulgar|dizer o nome|mencionar)|sigilo)\b"),
        _rule('dont_know', r"\b(?:(?:eu )?nao sei|nao faco ideia|sem ideia|nem ideia|nao (?:me )?(?:lembro|recordo)|nunca (?:medimos|medi)|nao (?:foi|era) medido|nao medimos|nao temos (?:esse |os )?(?:numero|dado|dados|numeros)|nao tenho (?:esse |os )?(?:numero|dado|dados|numeros))\b", unless_intents=['cannot_disclose']),
        _rule('dont_know', r"^\W*(?:(?:hum|bem|olha|sinceramente)[, ]+)*(?:nao tenho certeza|nao estou (?:muito )?cert[oa])\b", max_words=8, unless_src=r'\d'),
        _rule('correction', r"\b(?:desculpe,? (?:eu quis dizer|era|foi)|quis dizer|quero dizer|correcao|deixa eu corrigir|deixe-me corrigir|me corrijo|na verdade (?:era|foi|e|quis dizer)|nao,? (?:era|foi|quis dizer|espera)|esquece isso|\d+(?:[.,]\d+)?\s*%?\s*,?\s*nao\s+\d)"),
        _rule('rushed', r"\b(?:estou com pressa|tenho pressa|estou sem tempo|pouco tempo|nao tenho muito tempo|tenho (?:uma|outra) (?:reuniao|ligacao|chamada) (?:em|as|agora|logo)|preciso sair correndo|vamos rapido|seja breve|versao (?:curta|resumida)|vamos resumir|so tenho (?:cinco|dez|\d+) minutos|(?:cinco|dez|\d+) minutos (?:no maximo|apenas))\b"),
        _rule('stop', r"\b(?:vamos (?:encerrar|terminar|parar|finalizar)|podemos (?:encerrar|terminar|parar|finalizar)|quero (?:encerrar|terminar|parar)|(?:encerrar|terminar) (?:aqui|por hoje|a entrevista|a sessao)|por hoje (?:e|eh) so|isso e tudo|e so isso|ja terminei|tenho que ir|preciso ir|chega por hoje|fim da entrevista|nada mais a acrescentar|nao tenho mais nada a (?:dizer|acrescentar|adicionar))\b|^\W*(?:parar|chega)\W*$"),
        _rule('confirm', r"^\W*(?:(?:ok|bom|entao|bem|hum)[, ]+)*(?:sim|isso mesmo|isso|exato|exatamente|correto|certo|claro|com certeza|concordo|perfeito|e isso|e verdade|tem razao|de acordo|ok|okay|pois e|uhum|aham)\b"),
        _rule('deny', r"^\W*(?:(?:ok|bom|entao|bem|hum)[, ]+)*(?:nao" + _END + r"|nao (?:e|foi|era|isso|assim|nunca|exatamente|esta|concordo)\b|de jeito nenhum|nada disso|negativo|errado|incorreto|discordo|(?:isso|esta|e) (?:esta )?(?:errado|incorreto|falso))", unless_intents=['stop']),
    ],
    'de': [
        _rule('pause', r"\b(?:(?:konnen|konnten|durfen) wir (?:kurz |mal |bitte )?(?:eine )?pause|(?:lass uns|lassen sie uns|ich mochte|ich brauche|ich will) (?:kurz |mal )?(?:eine )?pause|kurze pause|moment mal|bin gleich wieder da|bin gleich zuruck)\b|^\W*(?:(?:ok|okay|entschuldigung|warte|wart)[, ]+)*(?:pause|moment|warten sie|warte)\b"),
        _rule('pause', r"\b(?:einen (?:moment|augenblick|kleinen moment)|(?:eine|einen) (?:sekunde|minute))\b", max_words=5),   # a bare "one moment" is a request only in a short remark
        _rule('resume', r"\b(?:machen wir weiter|(?:konnen|konnten) wir weitermachen|wir konnen weitermachen|lass uns weitermachen|lassen sie uns weitermachen|weitermachen|fortsetzen|bin wieder da|ich bin zuruck|ich bin bereit|bin bereit|es kann weitergehen)\b|^\W*(?:ok(?:ay)?[, ]+)?(?:weiter|los gehts|los geht's|bitte weiter)\W*$"),
        _rule('repeat', r"\b(?:(?:konnen sie|kannst du|konnten sie|wurden sie) (?:das |die frage |es )?(?:bitte )?(?:noch ?mal |nochmal |nochmals )?wiederholen|bitte (?:noch ?mal )?wiederholen|wiederholen sie|wiederhole (?:das|die frage|es|bitte)|noch ?mal bitte|nochmals bitte|sagen sie (?:das )?noch ?mal|sag (?:das )?noch ?mal|nicht (?:richtig |ganz )?(?:verstanden|gehort|mitbekommen)|wie bitte|was war die frage|was haben sie gesagt|was hast du gesagt|wie war die frage)\b"),
        _rule('skip', r"\b(?:(?:lass uns|lassen sie uns|konnen wir|wir konnen) (?:das |diese frage )?(?:uberspringen|weiter(?:gehen)? zur nachsten|zur nachsten (?:frage )?(?:ubergehen|gehen))|nachste frage|(?:ich mochte|mochte|lieber) (?:lieber )?nicht (?:antworten|darauf antworten|dazu (?:etwas )?sagen)|uberspringen|lassen wir das)\b|^\W*(?:(?:ok|okay)[, ]+)*(?:ich passe|passe)\W*$"),
        _rule('cannot_disclose', r"\b(?:(?:kann|darf|konnte|durfte) (?:ich )?(?:das |dazu |es |ihnen |dir )?(?:leider )?(?:nicht|nichts) (?:teilen|weitergeben|offenlegen|sagen|verraten|nennen|preisgeben|besprechen)|(?:ist|sind|alles) (?:streng |strikt |vollig )?vertraulich|vertraulich|nda|geheimhaltung|schweigepflicht|ich bin nicht berechtigt|darf ich nicht)\b"),
        _rule('dont_know', r"\b(?:ich )?wei(?:ss|ß) (?:ich )?(?:es )?nicht\b|\b(?:keine ahnung|ich erinnere mich nicht|erinnere mich nicht|nie gemessen|nicht gemessen|wir haben (?:das )?nie gemessen|(?:ich )?habe (?:dazu |dafur )?keine (?:zahlen|daten|angaben|messung(?:en)?)|haben wir nicht)\b", unless_intents=['cannot_disclose']),
        _rule('dont_know', r"^\W*(?:(?:hm|also|ehrlich gesagt|na ja|ahm)[, ]+)*(?:ich bin (?:mir )?nicht (?:ganz |so )?sicher|nicht sicher|bin mir nicht sicher)\b", max_words=8, unless_src=r'\d'),
        _rule('correction', r"\b(?:entschuldigung,? (?:ich meinte|das war|es war|ich meine)|ich meinte|ich meine (?:eigentlich|naturlich|doch)|korrektur|lass mich korrigieren|ich korrigiere|eigentlich (?:war|ist|es war|meinte)|nein,? (?:es war|ich meinte|warte|moment)|streich das|vergiss das|\d+(?:[.,]\d+)?\s*%?\s*,?\s*nicht\s+\d)"),
        _rule('rushed', r"\b(?:ich habe es eilig|ich bin in eile|ich bin unter zeitdruck|wenig zeit|nicht viel zeit|keine zeit|ich habe (?:gleich )?(?:noch )?(?:einen|ein) (?:termin|meeting|anruf)|ich muss (?:gleich )?los|fassen wir uns kurz|machen wir es kurz|halten wir es kurz|kurzfassung|kurze version|nur (?:noch )?(?:funf|zehn|\d+) minuten|(?:funf|zehn|\d+) minuten (?:hochstens|nur|maximal))\b"),
        _rule('stop', r"\b(?:(?:lass uns|lassen sie uns|konnen wir|wir konnen|ich mochte|ich will|ich muss) (?:hier |jetzt |das )?(?:beenden|aufhoren|abschliessen|abschlie(?:ss|ß)en|schlie(?:ss|ß)en|stoppen)|das (?:ist|war) (?:alles|genug) fur (?:heute|jetzt)|das ware alles|das war's|das wars|ich bin (?:fertig|durch)|interview beenden|das interview beenden|genug fur heute|schluss fur heute|ich muss (?:jetzt )?gehen|mehr habe ich nicht|nichts (?:mehr|weiter) hinzuzufugen|nichts weiter zu sagen)|^\W*(?:stopp|stop|schluss|ende)\W*$"),
        _rule('confirm', r"^\W*(?:(?:ok|okay|also|na ja|ja ja|nun|hm)[, ]+)*(?:ja|jawohl|genau|exakt|richtig|stimmt|korrekt|absolut|auf jeden fall|ganz genau|das stimmt|das ist richtig|das ist korrekt|das passt|so ist es|einverstanden|in ordnung|klar|sicher|na klar|okay|ok|passt)\b"),
        _rule('deny', r"^\W*(?:(?:ok|okay|also|na ja|nun|hm)[, ]+)*(?:nein" + _END + r"|nein (?:das|es|so|nicht|wir|ich|stimmt|ganz|absolut|auf keinen|warte|moment|eigentlich)\b|nee\b|nope|nicht (?:richtig|korrekt|ganz|wirklich)|falsch|inkorrekt|das ist (?:falsch|nicht (?:richtig|korrekt|wahr|so))|das stimmt nicht|stimmt nicht|auf keinen fall|uberhaupt nicht|ich widerspreche|so nicht)", unless_intents=['stop']),
    ],
    'it': [
        _rule('pause', r"\b(?:(?:possiamo|posso|facciamo|vorrei|devo) (?:fare )?(?:una )?(?:breve )?pausa|ho bisogno di (?:una pausa|un momento|un attimo)|una pausa|aspetta un (?:momento|attimo|secondo)|torno subito)\b|^\W*(?:(?:ok|scusa|scusi)[, ]+)*(?:pausa|aspetta|aspetti)\b"),
        _rule('pause', r"\b(?:un momento|un attimo|un secondo|un minuto|un istante)\b", max_words=5),   # a bare "one moment" is a request only in a short remark
        _rule('resume', r"\b(?:riprendiamo|continuiamo|possiamo (?:riprendere|continuare|andare avanti)|andiamo avanti|sono tornat[oa]|eccomi|sono pront[oa]|puoi continuare|puo continuare|vai pure|proseguiamo)\b"),
        _rule('repeat', r"\b(?:(?:puoi|puo|potresti|potrebbe|mi puoi|mi puo) ripetere|ripeti(?:lo|la)?|ripeta(?:lo|la)?|non (?:ho )?(?:capito|sentito|inteso)|come scusa|scusa,? (?:cosa|come)|qual era la domanda|cosa hai detto|cosa ha detto|ancora una volta|di nuovo,? per favore)\b"),
        _rule('skip', r"\b(?:(?:saltiamo|passiamo|andiamo) (?:questa|questo|quella|quello|alla|al|oltre)|(?:possiamo|posso) (?:saltare|passare|andare oltre)|prossima domanda|domanda successiva|preferisco non (?:rispondere|dirlo|dire|parlarne|parlare)|saltiamola|lasciamo perdere|meglio passare)\b"),
        _rule('cannot_disclose', r"\b(?:non posso (?:condividere|condividerlo|divulgare|dire|dirlo|rivelare|rivelarlo|parlarne|parlare|nominare|citare|fare il nome|dare)|(?:e|sono|e tutto|tutto e|e strettamente|e completamente) (?:strettamente |completamente )?riservat[oaie]|confidenzial[ei]|nda|accordo di riservatezza|clausola di riservatezza|obbligo di riservatezza|non sono autorizzat[oa]|non mi e permesso|preferisco non (?:nominare|citare|divulgare|dire il nome))\b"),
        _rule('dont_know', r"\b(?:non lo so|non so|(?:non )?ne ho idea|nessuna idea|non ho idea|non ricordo|non mi ricordo|non lo ricordo|mai misurat[oaie]|non (?:e stato|e stata|sono stati|sono state) misurat[oaie]|non l'abbiamo misurat[oaie]|non abbiamo (?:misurato|numeri|dati|cifre)|non ho (?:i |il |quei |quel |questi )?(?:numeri|dati|numero|dato|cifre))\b", unless_intents=['cannot_disclose']),
        _rule('dont_know', r"^\W*(?:(?:beh|boh|ehm|sinceramente)[, ]+)*(?:non sono (?:molto |del tutto )?sicur[oa]|non ne sono sicur[oa]|non sono cert[oa])\b", max_words=8, unless_src=r'\d'),
        _rule('correction', r"\b(?:scusa,? (?:intendevo|volevo dire|era)|intendevo|volevo dire|correzione|lascia che corregga|mi correggo|correggo|anzi,? (?:era|e|intendevo)|in realta (?:era|e|intendevo)|no,? (?:era|intendevo|aspetta)|dimentica (?:questo|quello)|cancella (?:questo|quello)|\d+(?:[.,]\d+)?\s*%?\s*,?\s*non\s+\d)"),
        _rule('rushed', r"\b(?:ho fretta|vado di fretta|ho poco tempo|non ho molto tempo|sono di (?:corsa|fretta)|ho (?:una|un'altra|un altro) (?:riunione|chiamata|call) (?:tra|alle|subito|adesso|a breve)|devo scappare|facciamo (?:in )?breve|facciamo veloce|versione (?:breve|corta)|solo (?:cinque|dieci|\d+) minuti|(?:cinque|dieci|\d+) minuti (?:al massimo|soltanto))\b"),
        _rule('stop', r"\b(?:(?:finiamo|chiudiamo|fermiamoci|terminiamo|concludiamo)(?: qui| ora| adesso| per oggi)?|(?:possiamo|vorrei|voglio|devo) (?:finire|chiudere|fermarmi|terminare|concludere|smettere)|e tutto per (?:oggi|ora)|per oggi basta|basta cosi|ho finito|devo andare|fine dell'intervista|e tutto quello che ho|non ho altro da aggiungere|niente altro da aggiungere|nient'altro da aggiungere)\b|^\W*(?:stop|basta|fine)\W*$"),
        _rule('confirm', r"^\W*(?:(?:ok|beh|allora|ecco|mh|mhm|eh)[, ]+)*(?:si(?=\s*(?:[,.;!?]|$)|\s+(?:esatto|certo|giusto|corretto|e cosi|e vero|hai ragione|ha ragione|va bene|confermo))|esatto|esattamente|giusto|corretto|certo|certamente|assolutamente|perfetto|proprio cosi|e cosi|e vero|hai ragione|ha ragione|d'accordo|va bene|ok|okay|confermo|appunto)\b"),
        _rule('deny', r"^\W*(?:(?:ok|beh|allora|ecco|mh|eh)[, ]+)*(?:no" + _END + r"|no (?:e|non|e cosi|e vero|era|mai|assolutamente|affatto|aspetta|in realta|e sbagliato)\b|assolutamente no|per niente|affatto|sbagliato|errato|scorretto|non e (?:vero|giusto|corretto|cosi|esatto)|non sono d'accordo|non esattamente|non proprio)", unless_intents=['stop']),
    ],
    'nl': [
        _rule('pause', r"\b(?:(?:kunnen|mogen) we (?:even |kort )?(?:een )?(?:pauze|pauzeren)|(?:laten we|ik wil|ik moet|ik heb) (?:even |kort )?(?:een )?(?:pauze|pauzeren)|even pauze|even wachten|wacht even|ik ben zo terug|zo terug|ik heb een pauze nodig)\b|^\W*(?:(?:ok|oke|sorry|wacht|even)[, ]+)*(?:pauze|wacht|momentje)\b"),
        _rule('pause', r"\b(?:een momentje|een moment|een seconde|een minuutje)\b", max_words=5),   # a bare "one moment" is a request only in a short remark
        _rule('resume', r"\b(?:laten we (?:doorgaan|verder gaan|verdergaan|hervatten)|kunnen we (?:doorgaan|verder gaan|verdergaan|hervatten)|we kunnen (?:doorgaan|verder)|ga (?:maar )?(?:verder|door)|ik ben (?:er )?weer|ik ben terug|ik ben klaar om|hervatten|doorgaan)\b|^\W*(?:verder|ga door|ga verder)\W*$"),
        _rule('repeat', r"\b(?:(?:kun|kunt|zou|kan) (?:je|u) (?:dat|de vraag|het) (?:nog (?:een )?(?:keer|eens) )?(?:herhalen|zeggen)|herhaal (?:dat|de vraag|het)|nog (?:een )?(?:keer|eens),? (?:alsjeblieft|graag)|zeg (?:dat|het) (?:nog (?:een )?(?:keer|eens)|opnieuw)|niet (?:verstaan|begrepen|gehoord)|wat zei je|wat zei u|wat was de vraag|pardon|hoe zei je)\b"),
        _rule('skip', r"\b(?:(?:laten we|kunnen we|ik wil) (?:deze |dit |die |dat )?(?:vraag )?(?:overslaan|passeren|laten|doorgaan naar de volgende)|volgende vraag|ik (?:wil|zou) liever niet (?:antwoorden|zeggen|daarop ingaan|erover praten)|sla (?:dit|deze|die|dat) (?:vraag )?over|overslaan|laat maar|laten we dat laten)\b"),
        _rule('cannot_disclose', r"\b(?:(?:ik )?(?:kan|mag) (?:dat |het |dit |er |daar |hier )?(?:helaas )?niet (?:delen|vertellen|zeggen|onthullen|bekendmaken|noemen|openbaar maken|bespreken|geven|over praten|erover praten)|(?:kan|mag) ik (?:dat |het |dit )?(?:helaas )?niet (?:delen|vertellen|zeggen|noemen)|(?:is|zijn|alles is) (?:strikt |streng |volledig )?vertrouwelijk|vertrouwelijk(?:heid)?|nda|geheimhoudingsverklaring|geheimhouding|ik ben niet bevoegd|ik mag niet)\b"),
        _rule('dont_know', r"\b(?:ik weet (?:het )?niet|weet (?:ik )?(?:het )?niet|geen idee|ik herinner (?:het )?me (?:het )?niet|weet ik niet meer|nooit gemeten|niet gemeten|we hebben (?:dat )?nooit gemeten|(?:ik )?heb (?:daar |daarvoor )?geen (?:cijfers|getallen|data|gegevens|metingen))\b", unless_intents=['cannot_disclose']),
        _rule('dont_know', r"^\W*(?:(?:hm|nou|tja|eerlijk gezegd)[, ]+)*(?:ik ben (?:er )?niet (?:helemaal |zo )?zeker|niet zeker|weet niet zeker)\b", max_words=8, unless_src=r'\d'),
        _rule('correction', r"\b(?:sorry,? (?:ik bedoelde|dat was|het was|ik bedoel)|ik bedoelde|ik bedoel (?:eigenlijk|natuurlijk)|correctie|laat me (?:even )?corrigeren|ik corrigeer|eigenlijk (?:was|is|het was|bedoelde)|nee,? (?:het was|ik bedoelde|wacht|even)|vergeet dat|schrap dat|\d+(?:[.,]\d+)?\s*%?\s*,?\s*niet\s+\d)"),
        _rule('rushed', r"\b(?:ik heb haast|ik ben in haast|weinig tijd|niet veel tijd|ik heb (?:zo )?(?:nog )?(?:een|een andere) (?:afspraak|meeting|gesprek|call)|ik moet (?:zo )?(?:rennen|weg)|houd het kort|laten we het kort houden|kort houden|korte versie|maar (?:vijf|tien|\d+) minuten|(?:vijf|tien|\d+) minuten (?:hooguit|maximaal|maar))\b"),
        _rule('stop', r"\b(?:(?:laten we|kunnen we|we kunnen|ik wil|ik moet) (?:hier |nu |het |dit )?(?:stoppen|afronden|afsluiten|beeindigen|ophouden)|dat is (?:alles|genoeg) voor (?:vandaag|nu)|dat was het|ik ben er klaar mee|ik ben klaar met|interview (?:stoppen|beeindigen|afronden)|genoeg voor vandaag|ik moet (?:nu )?gaan|niets meer toe te voegen|verder niets toe te voegen|meer heb ik niet)\b|^\W*(?:stop|stoppen|einde)\W*$"),
        _rule('confirm', r"^\W*(?:(?:ok|oke|nou|tja|ja ja|hm)[, ]+)*(?:ja|jawel|precies|inderdaad|klopt|correct|juist|zeker|absoluut|dat klopt|dat is (?:juist|correct|waar)|mee eens|akkoord|prima|oke|ok|okay|exact|idd)\b"),
        _rule('deny', r"^\W*(?:(?:ok|oke|nou|tja|hm)[, ]+)*(?:nee" + _END + r"|nee (?:dat|het|zo|niet|we|ik|wacht|even|eigenlijk|absoluut)\b|neen|nope|niet (?:juist|correct|waar|helemaal|echt)|fout|onjuist|dat is (?:fout|onjuist|niet (?:juist|correct|waar|zo))|dat klopt niet|klopt niet|absoluut niet|helemaal niet|oneens|niet mee eens)", unless_intents=['stop']),
    ],
}

# A first-person action with a named practice or artifact ("I tried to hold the scope with weekly steering meetings", "we wrote the reconciliation
# scripts"): already a concrete example of what was done, so the intervention is not asked for again.
_ACTION_VERBS = (r"held|hold|holding|ran|run|set up|setup|wrote|write|built|build|introduced|introduce|started|created|create|configured|added|established|negotiated|rewrote|trained|facilitated"
                 r"|organi[sz]ed|scheduled|drafted|prepared|implemented|automated|replaced|reviewed|tested|designed|rolled out|migrated|standardi[sz]ed|chaired|adopted|tracked|logged")
_ACTION_OBJECTS = (r"meetings?|reviews?|workshops?|scripts?|pipelines?|dashboards?|checklists?|templates?|runbooks?|playbooks?|documents?|process(?:es)?|policy|policies|standups?|stand-ups?"
                   r"|retrospectives?|tests?|monitors?|monitoring|alerts?|automation|workflows?|rules?|guidelines?|plans?|sessions?|tickets?|reports?|models?|reconciliation|cutover|checks?|gates?")
CONCRETE_ACTION = r"\b(?:i|we)\b(?:\W+\w+){0,4}?\W+(?:" + _ACTION_VERBS + r")\b(?:\W+\w+){0,8}?\W+(?:" + _ACTION_OBJECTS + r")\b"

# The CLIENT's problem, said in the consultant's words ("the main problem was releases took a whole weekend", "the business was frustrated"), is not a
# setback the consultant went through. Words only: the subject is a problem noun or the business side, never a judgement of a person. The first form stops
# before the consultant's own side (sponsor, team, I, we), which stays a setback.
_PAIN = r"(?:frustrated|unhappy|annoyed|struggling|losing|stuck|overwhelmed|failing|worried|complaining|angry|upset|suffering|under pressure|exposed)"
_CLIENT_SUBJ = r"(?:business|client|customers?|users|stakeholders|organi[sz]ation|company|operations team|ops team)"
_CLIENT_PAIN = _CLIENT_SUBJ + r"\s+(?:(?:was|were|is|are|had been|got|became|kept)\s+(?:\w+\s+){0,2}?" + _PAIN + r"|struggled|suffered|complained|lost)\b"
# (no leading \b on purpose: a pattern that starts with a literal is scanned much faster, and a word that merely ends in one of these is no harm to a cue)
CLIENT_PROBLEM = (r"(?:problems?|issues?|pain points?|challenges?)\s+(?:was|were|is|are)\b(?:(?!\b(?:sponsor|team|we|i|my|our)\b)[^.;!?])*"
                  r"|" + _CLIENT_PAIN + r"[^.;!?]*")
# a period said in words: "over six months", "the first quarter after go live", "in Q3", "in 2025"
PERIOD_WORDS = (r"(?:over|for|within|during|across|in)\s+(?:the\s+)?(?:(?:first|last|next|past|following|initial)\s+)?(?:(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|few|\d+)\s+)?(?:weeks?|months?|quarters?|years?)\b"
                r"|(?:first|second|third|fourth|last|next|past)\s+(?:week|month|quarter|half|year)\b|q[1-4]\b|h[12]\b"
                r"|(?:in|during|since|by|from)\s+(?:january|february|march|april|june|july|august|september|october|november|december|20\d\d)\b|fy\s?\d{2,4}\b"
                r"|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|few)\s+(?:weeks?|months?|quarters?|years?)\b")

# English cues. Plain pattern strings; the logic that combines them lives in analyze_turn (and in turns.js).
CUE_SRC = {
    # a number with a unit, a currency amount, a multiplier word, or a from-to comparison (quality.NUMERIC is tried first)
    'metric_extra': r"\b[a-z]+(?:[- ][a-z]+)?\s+(?:percent|per cent)\b|\d+(?:[.,]\d+)?\s*(?:x|×|times|fold|ms|users?|customers?|tickets?|requests?|transactions?|servers?|incidents?|defects?|bugs?|errors?|people|engineers?|fte|euros?|dollars?|eur|usd|gbp|points?|pp|bps|basis points|gb|tb|mb|rows|records|jobs|cases|applications?|systems?|licen[cs]es|weeks?|months?|years?|seconds?|secs?|hrs?|mins?|billion|thousand)\b|\b(?:doubled|tripled|halved|quadrupled|cut in half|twice as|three times|four times|ten times)\b|\b(?:from|down from|up from)\s+\d[\d.,]*\s*(?:%|\w+)?\s+(?:to|down to|up to)\s+\d",
    # an estimate marker; only counts when a metric is present
    'estimate_extra': r"\b(?:around|ballpark|something like|nearly|almost|close to|up to|more or less|give or take|circa|approx)\b|~\s*\d",
    # helped / was involved in / worked on: work without a stated owner or result. Always vague.
    'vague_strong': r"\b(?:helped|helping|assisted|assisting|contributed|contributing|participated in|took part in|was involved in|were involved in|involved in|worked on|working on|played a (?:key |big |small |major |supporting )?(?:role|part)|had a hand in|dealt with|(?:was|am|i'?m) (?:a )?part of|part of the team that)\b",
    # improved / streamlined / leveraged: vague only when no number backs them
    'vague_weak': r"\b(?:improve|improved|improving|enhance|enhanced|enhancing|optimi[sz]e|optimi[sz]ed|streamline|streamlined|leverage|leveraged|drove|drive|spearheaded|spearhead)\b",
    'we': r"\b(?:we|our team|the team|my team|the group|together we)\b",
    'i': r"\b(?:i|i'(?:m|ve|d|ll)|my own|personally|myself)\b",
    'team_verb': r"\b(?:we|our team|the team|my team|the group)\s+(?:\w+\s+){0,2}?(?:built|delivered|launched|migrated|shipped|designed|implemented|created|developed|deployed|reduced|improved|cut|saved|achieved|completed|rolled out|introduced|redesigned|automated|moved|rebuilt|replaced|set up|stood up|ran|led|owned|managed|handled|fixed|solved|increased|decreased|boosted|won|finished|released|trained|integrated|upgraded|modernis?ed|modernized|refactored|optimi[sz]ed|scaled)\b",
    # technology names (regex fragments); three distinct ones in one utterance read as a list
    'tech_terms': ['python', 'java', 'javascript', 'typescript', 'kotlin', 'scala', 'golang', 'rust', 'ruby', 'php', r'c#', r'c\+\+', r'\.net', 'sql', 'nosql',
                   'kafka', 'spark', 'flink', 'hadoop', 'airflow', 'dbt', 'terraform', 'ansible', 'puppet', 'kubernetes', 'k8s', 'docker', 'helm', 'jenkins',
                   'gitlab', 'github', r'github actions', 'azure', 'aws', 'gcp', 'google cloud', 'cloudflare', 'linux', 'windows server', 'postgres', 'postgresql',
                   'mysql', 'mongodb', 'redis', 'oracle', 'snowflake', 'databricks', 'bigquery', 'elasticsearch', 'kibana', 'splunk', 'sentinel', 'datadog', 'grafana',
                   'prometheus', 'rabbitmq', 'nginx', 'graphql', 'react', 'angular', 'vue', r'node\.?js', 'django', 'flask', 'fastapi', 'spring boot', 'tableau',
                   'power bi', 'salesforce', 'sap', 'servicenow', 'okta', 'entra', 'active directory', 'tensorflow', 'pytorch', 'excel', 'jira'],
    'tech_min': 3,
    'certification': r"\b(?:certified|certification|certifications|accredited|accreditation|(?:aws|azure|gcp|google cloud|cisco|comptia|microsoft|oracle|scrum|itil|safe)\s+(?:solutions? architect|developer|administrator|associate|professional|practitioner|specialty|security|fundamentals|master|product owner|foundation|expert|engineer)|pmp|prince2|cissp|cism|cisa|ceh|oscp|togaf|cka|ckad|ccna|ccnp|csm|psm|ccsp|scrum master|az-\d{3}|dp-\d{3})\b",
    # who said it, then praise in the words that follow, or a direct praise phrase
    'client_praise_said': r"\b(?:client|customer|sponsor|ceo|cio|cto|cfo|stakeholders?|management|leadership|executives?|board|steering committee|manager|director|partner|they|users?)\b.{0,40}\b(?:said|told|praised|loved|thanked|complimented|appreciated|was (?:thrilled|delighted|impressed|pleased)|were (?:thrilled|delighted|impressed|pleased)|called (?:it|us|me|the team)|described|rated|recommended|renewed|extended)\b.{0,60}\b(?:best|great|excellent|amazing|fantastic|brilliant|outstanding|exceptional|perfect|impressed|loved|recommend|top|favou?rite|never seen|incredible|superb|wonderful)\b",
    'client_praise_direct': r"\b(?:(?:clients?|customers?|sponsors?|ceo|cio|cto|cfo|stakeholders?|management|leadership|users?|they) (?:really )?(?:loved it|(?:was|were) (?:really )?happy)|(?:great|excellent|glowing|positive|amazing) (?:feedback|review|testimonial|reference)|(?:won|received|got) (?:an? )?(?:award|recognition|praise|kudos|commendation)|(?:delighted|thrilled|impressed|satisfied|pleased) (?:client|customer|sponsor)s?|(?:nps|csat) (?:of|score|was))\b",
    'describes_setback': r"\b(?:fail|failed|fails|failure|failures|went wrong|rolled back|roll back|rollback|roll-back|outage|crashed|crash|broke|delayed|slipped|overran|over budget|missed the deadline|missed the target|setback|abandoned|cancell?ed|scrapped|shelved|didn'?t work|did not work|backfired|regressed|regression|fell short|underperformed|unsuccessful|struggled|ran into (?:problems|issues|trouble)|hit a snag|roadblock|mistake|data loss|frustrat\w*|exhausted|chaotic|kept changing|(?:sponsor|manager|lead) (?:left|quit)|pushback|resist\w*|did(?:n'?t| not) care|conflict|tough|difficult)\b",
    # "zero data loss", "no outage": the absence of a setback is a result, removed before the setback words are looked for
    'setback_strip': r"\b(?:zero|no|without(?: any)?) (?:data loss|outage|downtime|incidents?)\b",
    'describes_achievement': r"\b(?:delivered|launched|shipped|won|achieved|reduced|cut|saved|increased|improved|boosted|grew|doubled|tripled|completed|built|designed|implemented|migrated|automated|rolled out|deployed|introduced|created|developed|reached|exceeded|surpassed|accelerated|eliminated|streamlined|modernis?ed|modernized|rebuilt|redesigned|standardis?ed|standardized|scaled|went live|successfully|on time|ahead of schedule|under budget|award|promoted|adopted|success|successful|went (?:down|up)|dropped|fell|halved|faster|quicker|fewer|lower)\b",
    # the consultant refers to the client, customer, company or a name: a refusal to share is then about who, not about the content
    'names_party': r"\b(?:client|customer|company|name|names|who they are|which (?:bank|company|client))\b",
    # work actually done, in the consultant's words (a first-person verb of doing, or a first-person action on a named practice): "what we did" alone is not
    'action': r"\b(?:we|i) (?:\w+ )?(?:migrated|implemented|built|introduced|deployed|rolled out|automated|redesigned|replaced|moved|set up|configured|rebuilt|refactored|integrated|installed|created)\b|" + CONCRETE_ACTION,
    'client_problem': CLIENT_PROBLEM,
    'period_words': PERIOD_WORDS,
}

# Ledger fields (quality.FIELDS) an utterance probably covers. Wording cues for the NEXT question, never a verifier.
HINT_SRC = {
    'problem': r"\b(?:(?<!\bno )problem|issue|pain point|challenge|struggling|used to|was (?:slow|manual|broken|failing)|legacy|backlog|complaints?|complained|unable to|couldn'?t|(?:it|this) was an? [a-z ]{0,30}(?:migration|project|programme|rollout|implementation|transformation))\b|" + _CLIENT_PAIN,
    'stakes': r"\b(?:costing|costs?|risk|penalt(?:y|ies)|fines?|revenue|lost|losing|sla|compliance|regulators?|regulatory|deadline|churn|downtime|at stake|exposure|missed)\b",
    'contribution': r"\b(?:i (?:personally )?(?:led|owned|built|designed|wrote|did|was responsible|was the|managed|drove|architected|implemented|created|set up|ran|developed|delivered)|my (?:role|part|responsibility|contribution|job)|i was (?:the )?(?:lead|architect|owner|responsible|in charge)|personally|myself|i took|i (?:mostly |mainly )?(?:worked on|was responsible for|handled|owned|took care of|led|built|designed|wrote))\b",
    'intervention': r"\b(?:(?:we|i) (?:\w+ )?(?:migrated|implemented|built|introduced|deployed|rolled out|automated|redesigned|replaced|moved|set up|configured|rebuilt|refactored|integrated|installed|created)|the (?:solution|approach|design|architecture|pipeline|platform)|what we (?:did|changed))\b|" + CONCRETE_ACTION,
    'decision': r"\b(?:instead of|rather than|alternatives?|trade-?offs?|chose|chosen|decided|decision|considered|compared|versus|options?|rejected|opted|picked|why we)\b",
    'adoption': r"\b(?:adopt(?:ed|ion)?|used by|rolled out to|onboarded|handed over|handover|hand-?off|owned (?:it )?after|maintained by|support team|operations team|ops team|run team|took over|trained|training|in production|went live|daily|weekly|used (?:it|this|them) (?:every|each)|every day|day[- ]to[- ]day|(?:they|team|squads?|users?) owned (?:it|this))\b",
    'outcome': r"\b(?:result|resulted|outcome|improved|reduced|increased|decreased|faster|slower|better|saved|achieved|as a result|ended up|impact|went down|went up|gained|success|successful)\b",
    'measurement': r"\b(?:baseline|measured|measure|measurement|before and after|compared (?:to|with)|average|median|kpi|metrics?|tracked|telemetry|dashboard|sample|per (?:day|week|month|year|ticket|release)|over (?:a|the|\d+) (?:\w+ )?(?:week|month|quarter|year|period)s?)\b",
    'evidence': r"\b(?:documents?|documented|documentation|report|runbook|dashboard|ticket|jira|confluence|wiki|slides?|deck|case study|testimonial|artifact|repository|pull request|post-?mortem|retro(?:spective)?|contract|sow|statement of work|invoice|audit|screenshot|diagram|signed off|approved by|can confirm|confirmed by|verified by)\b",
    'limitations': r"\b(?:limitations?|limited|caveats?|only (?:worked|applies|for)|other factors|also changed|at the same time|confound\w*|attribut\w+|can'?t claim|couldn'?t claim|partly|partially|small sample|one team|excluded|not (?:production|a production)|pilot only|just a pilot|poc|proof of concept|doesn'?t prove|next time|would (?:not|never) (?:\w+ ){0,4}again|do differently)\b",
    'customer_fit': r"\b(?:(?:another|other|any|similar|future) (?:customers?|clients?)|would (?:be useful|help|apply|suit|fit)|customers? (?:who|that|with|like)|ideal(?:ly)? for|good fit|works well (?:for|when|if)|best (?:for|suited)|relevant (?:for|to)|similar (?:situation|context|environment|organi[sz]ation))\b",
    'poor_fit': r"\b(?:wouldn'?t (?:work|apply|fit)|would not (?:work|apply|fit)|not (?:a )?good fit|poor fit|doesn'?t (?:apply|fit)|prerequisites?|pre-?requisites?|only if|unless|depends on|not suitable|not recommended|wouldn'?t recommend|won'?t work|would struggle|doesn'?t scale|too (?:small|large|big)|without (?:a|an|the) (?:\w+ )?(?:team|budget|sponsor|data|platform|cloud))\b",
}
HINT_FROM_TO = r"\b(?:from|down from|up from)\s+\d[\d.,]*\s*(?:%|\w+)?\s+(?:to|down to|up to)\s+\d"   # a before/after pair also hints "measurement"
# Intents that mean the utterance is not an answer to the question asked: the asked_field context does not apply.
NOT_AN_ANSWER = ['pause', 'resume', 'repeat', 'skip', 'stop', 'rushed', 'question_to_atlas', 'dont_know', 'cannot_disclose']
ASKED_MIN_WORDS = 4

# One number with an optional currency symbol before it and an optional unit after it. Groups: 1 currency, 2 digits,
# 3 attached symbol (% or x), 4 attached letters (k m b ms h), 5 spaced/attached unit word.
NUMBER_SRC = (r"(?<![\w.,$€£])(?:([$€£])\s*)?(\d+(?:[.,]\d+)*)(?:\s*(%|×)|(x|k|m|b|ms|h)(?![a-z0-9])|\s?(percent|per cent|times|fold|hours?|hrs?|minutes?|mins?|seconds?|secs?|days?|weeks?|months?|quarters?|years?|"
              r"ms|milliseconds?|million|billion|thousand|users?|customers?|tickets?|people|engineers?|euros?|dollars?|eur|usd|gbp)\b)?")
UNIT_CANON = {'%': '%', 'percent': '%', 'per cent': '%', 'x': 'x', '×': 'x', 'times': 'x', 'fold': 'x', 'ms': 'ms', 'millisecond': 'ms', 'milliseconds': 'ms', 'h': 'hour', 'hour': 'hour', 'hours': 'hour',
              'hr': 'hour', 'hrs': 'hour', 'minute': 'minute', 'minutes': 'minute', 'min': 'minute', 'mins': 'minute', 'second': 'second', 'seconds': 'second',
              'sec': 'second', 'secs': 'second', 'day': 'day', 'days': 'day', 'week': 'week', 'weeks': 'week', 'month': 'month', 'months': 'month',
              'quarter': 'quarter', 'quarters': 'quarter', 'year': 'year', 'years': 'year', 'user': 'user', 'users': 'user', 'customer': 'customer',
              'customers': 'customer', 'ticket': 'ticket', 'tickets': 'ticket', 'people': 'person', 'engineer': 'engineer', 'engineers': 'engineer',
              'euro': '€', 'euros': '€', 'eur': '€', 'dollar': '$', 'dollars': '$', 'usd': '$', 'gbp': '£'}
SCALE = {'k': 1000, 'thousand': 1000, 'm': 1000000, 'million': 1000000, 'b': 1000000000, 'billion': 1000000000}
THOUSANDS = r'^\d{1,3}(?:,\d{3})+(?:\.\d+)?$'
PLAIN_NUMBER = r'^\d+(?:\.\d+)?$'
DOT_THOUSANDS = r'^[1-9]\d{0,2}(?:\.\d{3}){2,}$'   # 1.000.000
AMBIGUOUS_DOT = r'^[1-9]\d{0,2}\.\d{3}$'            # 1.000: a thousand or one point zero, so no value is reported

WHITESPACE = r'[ \t\n\r\f\v   -     　﻿]+'
_FLAGS = re.I | re.A
_COMPILED = {}


def _re(src):
    r = _COMPILED.get(src)
    if r is None:
        r = _COMPILED[src] = re.compile(src, _FLAGS)
    return r


_WS = re.compile(WHITESPACE)
_QUOTES = {'‘': "'", '’': "'", 'ʼ': "'", '“': '"', '”': '"'}


def normalize(text):
    """Same on both sides: first MAX_CHARS characters, accents stripped, lower-cased, quotes straightened, spaces collapsed."""
    t = unicodedata.normalize('NFD', text[:MAX_CHARS])
    t = ''.join(c for c in t if not '̀' <= c <= 'ͯ')
    for k, v in _QUOTES.items():
        t = t.replace(k, v)
    return _WS.sub(' ', t.lower()).strip()


def _lang(lang):
    return str(lang or 'en').lower().replace('_', '-').split('-')[0]


def _number_value(digits):
    s = digits
    if _re(AMBIGUOUS_DOT).match(s):
        return None
    if _re(THOUSANDS).match(s):
        s = s.replace(',', '')
    elif _re(DOT_THOUSANDS).match(s):
        s = s.replace('.', '')
    elif ',' in s and '.' not in s and s.count(',') == 1:
        s = s.replace(',', '.')
    if not _re(PLAIN_NUMBER).match(s) or len(s) > 15:
        return None
    v = float(s)
    return int(v) if v == int(v) else v


def numbers(norm, probe=None):
    out = []
    if not passes(NUMBER_GATE, (probe or _Probe(norm)).has):    # no digit, no number
        return out
    for m in _re(NUMBER_SRC).finditer(norm):
        cur, digits, sym, letters, word = m.group(1), m.group(2), m.group(3), m.group(4), m.group(5)
        item = {'text': m.group(0)}
        value = _number_value(digits)
        unit = UNIT_CANON.get(sym or letters or word or '')
        scale = SCALE.get(letters or word or '')
        if value is not None and scale:
            value = value * scale
            unit = None
            if not isinstance(value, int) and value == int(value):
                value = int(value)
        if cur:
            unit = cur
        if value is not None:
            item['value'] = value
        if unit:
            item['unit'] = unit
        out.append(item)
        if len(out) >= MAX_NUMBERS:    # stop scanning at the cap, not one match later
            break
    return out


def intents(norm, lang, words, probe=None):
    rules = INTENT_RULES.get(lang)
    if not rules:
        return []
    probe = probe or _Probe(norm)
    found = set()
    for r in rules:
        if r['intent'] in found:
            continue
        if r['max_words'] is not None and words > r['max_words']:
            continue
        if any(i in found for i in r['unless_intents']):
            continue
        if not probe.search(r['src'], r['gate']):
            continue
        if r['unless_src'] and _re(r['unless_src']).search(norm):
            continue
        found.add(r['intent'])
    return [i for i in INTENT_ORDER if i in found]


# A cheap substring test in front of EVERY costlier pattern (cue, hint, number, intent rule): regex_gate.gate() derives, from the pattern itself, the literals a match
# cannot do without, and the pattern is only run when the text holds one literal of each requirement. A text with none of those words (a long answer of anything else)
# then costs next to nothing, and a literal is looked up once per utterance however many patterns share it. The same lists are read by turns.js.
TECH_SRC = r'(?<![\w.#+])(?:' + '|'.join(CUE_SRC['tech_terms']) + r')(?![\w#+])'
CUE_GATES = {name: gate(src) for name, src in CUE_SRC.items() if isinstance(src, str)}
CUE_GATES['tech'] = gate(TECH_SRC)
CUE_GATES['numeric'] = gate(NUMERIC.pattern)
CUE_GATES['uncertain'] = gate(UNCERTAIN.pattern)
HINT_GATES = {name: gate(src) for name, src in HINT_SRC.items()}
HINT_GATES['from_to'] = gate(HINT_FROM_TO)
NUMBER_GATE = gate(NUMBER_SRC)


class _Probe:
    """One utterance's substring lookups: each gate literal is searched for once, however many patterns share it."""
    __slots__ = ('norm', 'seen')

    def __init__(self, norm):
        self.norm = norm
        self.seen = {}

    def has(self, w):
        v = self.seen.get(w)
        if v is None:
            v = self.seen[w] = w in self.norm
        return v

    def search(self, src, gates):
        """The regex match, or None without running it when the text lacks a word the pattern needs."""
        return _re(src).search(self.norm) if passes(gates, self.has) else None


def _sub_setback_strip(norm, probe):
    return _re(CUE_SRC['setback_strip']).sub(' ', norm) if passes(CUE_GATES['setback_strip'], probe.has) else norm


def setback_words(norm, client_problem=None, probe=None):
    """True when the words describe a setback: the setback words that are left once "zero data loss" and the CLIENT's own problem ("the business was frustrated") are taken out.
    client_problem: whether the text holds the client's problem, when the caller has already looked (else it is looked for here)."""
    probe = probe or _Probe(norm)
    stripped = _sub_setback_strip(norm, probe)
    if client_problem is None:
        client_problem = bool(probe.search(CUE_SRC['client_problem'], CUE_GATES['client_problem']))
    if client_problem:
        stripped = _re(CUE_SRC['client_problem']).sub(' ', stripped)
    return bool((probe if stripped == norm else _Probe(stripped)).search(CUE_SRC['describes_setback'], CUE_GATES['describes_setback']))


def cues(norm, probe=None):
    probe = probe or _Probe(norm)
    S, G, find = CUE_SRC, CUE_GATES, probe.search
    metric = bool(find(NUMERIC.pattern, G['numeric']) or find(S['metric_extra'], G['metric_extra']))
    out = set()
    if metric:
        out.add('metric')
        if find(UNCERTAIN.pattern, G['uncertain']) or find(S['estimate_extra'], G['estimate_extra']):
            out.add('estimate')
    if find(S['vague_strong'], G['vague_strong']) or (not metric and find(S['vague_weak'], G['vague_weak'])):
        out.add('vague_verb')
    if find(S['team_verb'], G['team_verb']) and not find(S['i'], G['i']):
        out.add('team_claim')
    if passes(G['tech'], probe.has) and len({m.group(0) for m in _re(TECH_SRC).finditer(norm)}) >= S['tech_min']:
        out.add('tech_list')
    if find(S['certification'], G['certification']):
        out.add('certification')
    if find(S['client_praise_said'], G['client_praise_said']) or find(S['client_praise_direct'], G['client_praise_direct']):
        out.add('client_praise')
    problem = bool(find(S['client_problem'], G['client_problem']))
    if problem:
        out.add('describes_problem')
    if setback_words(norm, problem, probe):
        out.add('describes_setback')
    if find(S['describes_achievement'], G['describes_achievement']):
        out.add('describes_achievement')
    if find(S['names_party'], G['names_party']):
        out.add('names_party')
    if find(S['period_words'], G['period_words']):
        out.add('period_stated')
    if find(S['action'], G['action']):
        out.add('describes_action')
    return [c for c in CUE_ORDER if c in out]


def field_hints(norm, words, found_intents, context, probe=None):
    probe = probe or _Probe(norm)
    hits = {f for f, src in HINT_SRC.items() if probe.search(src, HINT_GATES[f])}
    if 'measurement' not in hits and probe.search(HINT_FROM_TO, HINT_GATES['from_to']):
        hits.add('measurement')
    asked = context.get('asked_field') if isinstance(context, dict) else None
    if words >= ASKED_MIN_WORDS and asked in FIELDS and not any(i in found_intents for i in NOT_AN_ANSWER):
        hits.add(asked)
    return [f for f in FIELDS if f in hits]


def analyze_turn(text, lang='en', context=None):
    """Analyse one consultant utterance. Returns exactly: intents, cues, field_hints, numbers, words.

    context (optional dict): {'asked_field': <FIELDS key>}, the field ATLAS's last question was about. An answer-shaped
    utterance of at least ASKED_MIN_WORDS words then also hints that field. Anything else in context is ignored."""
    text = text if isinstance(text, str) else ''
    norm = normalize(text)
    probe = _Probe(norm)
    words = len([w for w in _WS.split(text) if w])   # the whole utterance, not just the part analysed
    lg = _lang(lang)
    found = intents(norm, lg, words, probe) if lg in LANGS_WITH_INTENTS else []
    full = lg in LANGS_WITH_CUES
    return {'intents': found,
            'cues': cues(norm, probe) if full else [],
            'field_hints': field_hints(norm, words, found, context, probe) if full else [],
            'numbers': numbers(norm, probe) if full else [],
            'words': words}


EDGE_CONSTANTS = {
    'TURN_MAX_CHARS': MAX_CHARS, 'TURN_MAX_NUMBERS': MAX_NUMBERS, 'TURN_INTENT_ORDER': INTENT_ORDER, 'TURN_CUE_ORDER': CUE_ORDER,
    'TURN_LANGS_WITH_CUES': list(LANGS_WITH_CUES), 'TURN_LANGS_WITH_INTENTS': list(LANGS_WITH_INTENTS),
    'TURN_INTENT_RULES': INTENT_RULES, 'TURN_CUE_SRC': CUE_SRC, 'TURN_TECH_SRC': TECH_SRC, 'TURN_HINT_SRC': HINT_SRC, 'TURN_HINT_FROM_TO': HINT_FROM_TO,
    'TURN_CUE_GATES': CUE_GATES, 'TURN_HINT_GATES': HINT_GATES, 'TURN_NUMBER_GATE': NUMBER_GATE, 'TURN_NOT_AN_ANSWER': NOT_AN_ANSWER, 'TURN_ASKED_MIN_WORDS': ASKED_MIN_WORDS, 'TURN_NUMBER_SRC': NUMBER_SRC, 'TURN_UNIT_CANON': UNIT_CANON,
    'TURN_SCALE': SCALE, 'TURN_THOUSANDS_SRC': THOUSANDS, 'TURN_DOT_THOUSANDS_SRC': DOT_THOUSANDS, 'TURN_AMBIGUOUS_DOT_SRC': AMBIGUOUS_DOT, 'TURN_PLAIN_NUMBER_SRC': PLAIN_NUMBER, 'TURN_WHITESPACE_SRC': WHITESPACE,
}
