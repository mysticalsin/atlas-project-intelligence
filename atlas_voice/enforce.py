"""The question ATLAS speaks is the question the selector chose (v2.2 Q1, items 3, 4 and 6).

The talker model says the selected move's question in its own words, and a real model drifts: it paraphrased "what was the problem?" six times, asked "which other
teams?" three times after "that's all", and answered an "I don't know" with a generic re-ask instead of the easier angle the selector chose. The selector is the only
planner (one Move per reply). This module is the check the Session runs on what the talker actually said, so the question spoken, the question logged as asked and the
question the side panel shows are the same one:

  on_move(question, expected, intent, lang)  True when the spoken question is on the move's question: the concrete angle of a re-angle (an example, a rough order of
                                             magnitude, who would know, what they saw: ANGLES, any hit), else enough of the move's own content words (OVERLAP, on stems).
  expected_question(say)                      the last question sentence of a move's wording (a held "that's all" carries a lead sentence before it).
  local_say(intent, field, why, lang)         the move's question in fr es pt de it nl when a localized line exists (every re-angle, and the held "that's all" for the three
                                             essentials); None otherwise (English moves use move.say; other languages are rendered by the talker, guarded).

When the spoken question is off the move, the Session replaces it with the selector's own wording (English), the localized line (fr es pt de it nl) or, for any other
language, one more talker call that renders exactly the move's question under the guard. The check is deliberately cheap and one-sided: a synonym the check does not know
costs only a replacement by the selector's own, equally natural question, never a wrong one. Pure Python, no I/O; src/enforce.js ports it (parity vectors:
test/gen_enforce_parity.py -> test/enforce.vectors.json). The localized lines are translations in the register of the cached opening (vous / tú / você / Sie / tu / je) and
need a native-speaker review like the acknowledgement banks (languages.py REVIEW_STATUS).
"""
import re
import unicodedata

# Words that carry no topic, in the seven bank languages (a stem of one of them is never evidence that two questions are about the same thing).
STOPWORDS = (
    'the a an and or but of to in on at by for with from as is are was were be been being do does did have has had it its this that these those there here what which who whom whose when where why how '
    'you your yours we our us they their them he she his her i my me not no yes can could would should will shall may might must than then so if about into over after before also just more most '
    'very much many some any one two tell me walk through could please let lets say said like what whats thats '
    'le la les un une des du de au aux et ou mais que qui quoi dans pour sur par avec sans est sont etait etaient ete vous votre vos nous notre nos ils elles leur leurs il elle ce cet cette ces ca ne pas plus '
    'el los las unos unas y o pero del al en con por para sin es son era eran fue fueron ser tu tus su sus nosotros ellos ellas este esta estos estas eso que quien cual como cuando donde '
    'um uma os as uns umas e ou mas do da dos das no na nos nas em com por para sem eh sao foi foram seu sua seus suas voce voces nos eles elas isso isto este esta que quem qual como quando onde '
    'der die das den dem des ein eine einer einen und oder aber von zu im in am an auf mit fur durch ohne ist sind war waren sie ihr ihre ihren wir unser sie es dies diese dieser was wer wie wann wo nicht '
    'il lo gli le di da un una uno e o ma del della dei delle nel nella con per senza sono era erano tu tuo tuoi suo sue noi loro questo questa che chi quale come quando dove non '
    'de het een en of maar van te in op aan met voor zonder is zijn was waren je jouw jullie wij ons onze zij hun dit dat deze die wat wie hoe wanneer waar niet'
).split()
STOP = frozenset(STOPWORDS)
STEM = 5          # a word is compared by its first five letters ("approach" / "approximately" differ, "problem" / "problems" / "problème" agree)
MIN_LEN = 3       # shorter words carry nothing
OVERLAP_NUM, OVERLAP_DEN = 1, 3   # on topic when the shared stems are at least a third of the smaller of the two stem sets (at least one): integers, no float parity risk

# The concrete angle of each easier re-angle (English): any hit in the spoken question is enough. Written in the regex subset Python (re.I | re.A) and JavaScript read alike.
ANGLES = {
    'reangle_example': r"\b(?:examples?|instances?|moments?|specific|concrete|remember|recall|time (?:when|that)|episodes?|situations? (?:where|when)|illustrat\w*|walk me through)\b",
    'reangle_scale': r"\b(?:rough|roughly|approximate\w*|order of magnitude|ranges?|ballpark|estimates?|guess|how (?:much|many|long|big|often|large|small)|percent\w*|a few|dozens?|hundreds?|thousands?|magnitude)\b",
    'reangle_who': r"\b(?:who|whom|which (?:person|colleague|people|teammate)|anyone|someone|somebody|colleagues?|teammates?)\b",
    'reangle_saw': r"\b(?:you (?:see|saw|seen|notice|noticed|observe|observed)|yourself|personally|first[- ]?hand|with your own|your own)\b",
}

# Moves that put a question the consultant did not answer again, or carry their own fixed wording: never replaced by the check.
LOCAL_REANGLE = {
    'reangle_example': {
        'fr': "Pour vous faciliter la tâche : quel exemple concret vous revient en mémoire, même petit ?",
        'es': "Te lo pongo más fácil: ¿qué ejemplo concreto recuerdas, por pequeño que sea?",
        'pt': "Vou facilitar: de que exemplo concreto você se lembra, por menor que seja?",
        'de': "Ich mache es einfacher: Welches konkrete Beispiel fällt Ihnen ein, auch wenn es klein ist?",
        'it': "Te lo rendo più facile: quale esempio concreto ricordi, anche piccolo?",
        'nl': "Ik maak het makkelijker: welk concreet voorbeeld herinner je je, hoe klein ook?",
    },
    'reangle_scale': {
        'fr': "Quel serait un ordre de grandeur approximatif, même à peu près ?",
        'es': "¿Cuál sería un orden de magnitud aproximado, aunque sea a grandes rasgos?",
        'pt': "Qual seria uma ordem de grandeza aproximada, mesmo que por alto?",
        'de': "Was wäre eine grobe Größenordnung, auch nur ungefähr?",
        'it': "Quale sarebbe un ordine di grandezza approssimativo, anche a spanne?",
        'nl': "Wat zou een grove ordegrootte zijn, al is het bij benadering?",
    },
    'reangle_who': {
        'fr': "Qui, sur le projet, le saurait le mieux ?",
        'es': "¿Quién en el proyecto lo sabría mejor?",
        'pt': "Quem no projeto saberia isso melhor?",
        'de': "Wer im Projekt wüsste das am besten?",
        'it': "Chi nel progetto lo saprebbe meglio?",
        'nl': "Wie in het project zou dat het best weten?",
    },
    'reangle_saw': {
        'fr': "Qu'avez-vous vu ou fait vous-même à ce moment-là ?",
        'es': "¿Qué viste o hiciste tú mismo en ese momento?",
        'pt': "O que você viu ou fez pessoalmente nesse momento?",
        'de': "Was haben Sie in diesem Moment selbst gesehen oder getan?",
        'it': "Che cosa hai visto o fatto tu stesso in quel momento?",
        'nl': "Wat heb je op dat moment zelf gezien of gedaan?",
    },
}
# "That's all" held until the three essentials are covered: ONE spoken line, what is still missing and the question that asks for it (the English line is the selector's own
# stop_missing lead plus its ladder question). Keyed by the field the held question is about.
LOCAL_HOLD = {
    'problem': {
        'fr': "Avant de conclure, il me manque encore le problème à résoudre. Que se passait-il ?",
        'es': "Antes de terminar, aún me falta el problema que había que resolver. ¿Qué estaba pasando?",
        'pt': "Antes de terminar, ainda me falta o problema a resolver. O que estava acontecendo?",
        'de': "Bevor wir abschließen, fehlt mir noch das Problem, das zu lösen war. Was war damals los?",
        'it': "Prima di chiudere, mi manca ancora il problema da risolvere. Che cosa stava succedendo?",
        'nl': "Voor we afronden, mis ik nog het probleem dat op te lossen was. Wat speelde er?",
    },
    'contribution': {
        'fr': "Avant de conclure, il me manque encore votre propre part. Qu'avez-vous personnellement fait ?",
        'es': "Antes de terminar, aún me falta tu propia parte. ¿Qué hiciste tú personalmente?",
        'pt': "Antes de terminar, ainda me falta a sua própria parte. O que você fez pessoalmente?",
        'de': "Bevor wir abschließen, fehlt mir noch Ihr eigener Anteil. Was haben Sie persönlich getan?",
        'it': "Prima di chiudere, mi manca ancora la tua parte. Che cosa hai fatto tu personalmente?",
        'nl': "Voor we afronden, mis ik nog jouw eigen aandeel. Wat heb je zelf gedaan?",
    },
    'outcome': {
        'fr': "Avant de conclure, il me manque encore le résultat que vous avez constaté. Qu'est-ce qui a changé ?",
        'es': "Antes de terminar, aún me falta el resultado que viste. ¿Qué cambió?",
        'pt': "Antes de terminar, ainda me falta o resultado que você viu. O que mudou?",
        'de': "Bevor wir abschließen, fehlt mir noch das Ergebnis, das Sie gesehen haben. Was hat sich verändert?",
        'it': "Prima di chiudere, mi manca ancora il risultato che hai visto. Che cosa è cambiato?",
        'nl': "Voor we afronden, mis ik nog het resultaat dat je zag. Wat is er veranderd?",
    },
}
LOCAL_LANGS = ('fr', 'es', 'pt', 'de', 'it', 'nl')


def _fold(text):
    t = unicodedata.normalize('NFD', text if isinstance(text, str) else '')
    return ''.join(c for c in t if not '̀' <= c <= 'ͯ').lower()


def _words(text):
    return re.findall(r"[a-z0-9]+", _fold(text).replace("'", ' ').replace('\u2019', ' '))


def stems(text):
    """The set of topic stems of a text: words of three letters or more that are not stop words, cut to five letters."""
    return {w[:STEM] for w in _words(text) if len(w) >= MIN_LEN and w not in STOP}


def last_question(text):
    """The last sentence of a wording that holds a question mark (a held "that's all" has a lead sentence before its question), else the last sentence, else ''."""
    t = ' '.join((text if isinstance(text, str) else '').split())
    parts = [p for p in re.split(r'(?<=[.!?؟？])\s+', t) if p.strip()]
    asked = [p for p in parts if re.search(r'[?？؟]', p)]
    return (asked[-1] if asked else parts[-1] if parts else '').strip()


def on_move(question, expected, intent='', lang='en'):
    """True when the spoken `question` is the move's question (`expected`, its wording in the language it is spoken in). A re-angle intent is judged by its concrete angle
    (English words), every other move by the overlap of content stems; nothing at all to compare with is never "on" the move."""
    q = stems(question)
    if not q:
        return False
    if lang == 'en' and intent in ANGLES and re.search(ANGLES[intent], ' '.join(_words(question)), re.I | re.A):
        return True
    s = stems(last_question(expected))
    if not s:
        return False
    need = max(OVERLAP_NUM, (min(len(q), len(s)) * OVERLAP_NUM + OVERLAP_DEN - 1) // OVERLAP_DEN)
    return len(q & s) >= need


def local_say(intent, field, why, lang):
    """The move's wording in a bank language other than English, or None: a re-angle's own line, or the held "that's all" line of its essential field."""
    if lang not in LOCAL_LANGS:
        return None
    if intent in LOCAL_REANGLE:
        return LOCAL_REANGLE[intent][lang]
    if isinstance(why, str) and why.startswith('stop_missing:') and field in LOCAL_HOLD:
        return LOCAL_HOLD[field][lang]
    return None


EDGE_CONSTANTS = {'ENFORCE_STOP': STOPWORDS, 'ENFORCE_ANGLES': ANGLES, 'ENFORCE_LOCAL_REANGLE': LOCAL_REANGLE, 'ENFORCE_LOCAL_HOLD': LOCAL_HOLD,
                  'ENFORCE_STEM': STEM, 'ENFORCE_MIN_LEN': MIN_LEN, 'ENFORCE_OVERLAP': [OVERLAP_NUM, OVERLAP_DEN]}
