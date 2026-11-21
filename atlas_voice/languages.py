"""Conversation languages (Agent Brain v2.2 L1): which language the consultant is speaking or typing, and what ATLAS itself says in it.

Tony, 2026-10-31: "make sure the agent can speak any language the user is speaking, not just English". The design is:

* The talker (the conversation model) answers in WHATEVER language the consultant uses; it needs only the language's name (a server note).
  The next-move wording, the rules and the policy stay English guidance that it renders naturally. Nothing here limits it to a list.
* Words ATLAS says WITHOUT the talker (the cached opening, acknowledgements, pause and resume lines, the confirm-summary prompts, the read-back
  question) exist as banks for BANK_LANGUAGES only. For any other language they are never played in English: the session skips them or has the
  talker write that one short line in the consultant's language (session.js).
* detect() is a small deterministic detector for typed text (script ranges plus stopword sets), used with hysteresis in the session. Speech
  recognition gives its own language tag; this agrees with it or stands in for it.

Every bank other than English is a machine translation, accepted as is (Tony decision 2026-11-02, D-L2: no native-speaker dependency, ATLAS translates any
language automatically): REVIEW_STATUS says so, and translate.js renders any other text into any language with a confidence flag, never a human gate.
Pure data and functions (no I/O, no clock). The edge port of detect() moves to the interview slice with the code that calls it.
"""
import unicodedata

# ----- the languages ATLAS knows by name (any other BCP-47 tag is named by the Worker with Intl.DisplayNames) -----

LANGUAGE_NAMES = {
    'en': 'English', 'fr': 'French', 'es': 'Spanish', 'pt': 'Portuguese', 'de': 'German', 'it': 'Italian', 'nl': 'Dutch',
    'pl': 'Polish', 'ro': 'Romanian', 'ar': 'Arabic', 'zh': 'Chinese', 'ja': 'Japanese', 'ko': 'Korean', 'hi': 'Hindi', 'ru': 'Russian',
    'tr': 'Turkish', 'sv': 'Swedish', 'da': 'Danish', 'no': 'Norwegian', 'fi': 'Finnish',
    'uk': 'Ukrainian', 'el': 'Greek', 'he': 'Hebrew', 'th': 'Thai', 'bn': 'Bengali', 'ta': 'Tamil', 'te': 'Telugu', 'ka': 'Georgian',
    'hy': 'Armenian', 'fa': 'Persian', 'ur': 'Urdu',
}
NATIVE_NAMES = {
    'en': 'English', 'fr': 'Français', 'es': 'Español', 'pt': 'Português', 'de': 'Deutsch', 'it': 'Italiano', 'nl': 'Nederlands',
    'pl': 'Polski', 'ro': 'Română', 'ar': 'العربية', 'zh': '中文', 'ja': '日本語', 'ko': '한국어', 'hi': 'हिन्दी', 'ru': 'Русский',
    'tr': 'Türkçe', 'sv': 'Svenska', 'da': 'Dansk', 'no': 'Norsk', 'fi': 'Suomi',
    'uk': 'Українська', 'el': 'Ελληνικά', 'he': 'עברית', 'th': 'ไทย', 'bn': 'বাংলা', 'ta': 'தமிழ்', 'te': 'తెలుగు', 'ka': 'ქართული',
    'hy': 'Հայերեն', 'fa': 'فارسی', 'ur': 'اردو',
}
RTL = ('ar', 'he', 'fa', 'ur')
# Languages the talker always speaks to in its own words but that also have fixed lines ATLAS can say with no model call.
BANK_LANGUAGES = ('en', 'fr', 'es', 'pt', 'de', 'it', 'nl')
REVIEW_STATUS = {'en': 'authored', **{lang: 'machine_translated' for lang in BANK_LANGUAGES if lang != 'en'}}
# What Deepgram Nova-3 "multi" (automatic language detection and code-switching) understands. A consultant can lock another language in the
# UI; the Worker then asks the recogniser for that language alone (a monolingual request: live verification still open, see docs).
STT_AUTO = ('en', 'es', 'fr', 'de', 'hi', 'ru', 'pt', 'ja', 'it', 'nl')
# ElevenLabs Flash v2.5, the optional multilingual voice (ELEVENLABS_API_KEY), per ElevenLabs' published list of 32 languages.
ELEVENLABS_LANGUAGES = ('en', 'ja', 'zh', 'de', 'hi', 'fr', 'ko', 'pt', 'it', 'es', 'id', 'nl', 'tr', 'fil', 'pl', 'sv', 'bg', 'ro', 'ar', 'cs', 'el', 'fi',
                        'hr', 'ms', 'sk', 'da', 'ta', 'uk', 'ru', 'hu', 'no', 'vi')
# Workers AI ships Aura-2 for these two only (no other Workers AI text-to-speech model is assumed to exist).
NATIVE_VOICES = ('en', 'es')

# ----- the detector -----

DETECT_CHARS = 800      # only the start of a text is read
MIN_SCORE = 4           # two telling stopwords (or one and two marker letters): below this the text is too thin to name a language
STRONG_SCORE = 6        # three telling stopwords, and at least twice the runner-up
MARK_CAP = 4            # a marker letter counts one point each, at most this many per text

# (name, first code point, last code point). A letter is counted under the script of the range that holds it.
SCRIPT_RANGES = [
    ('latin', 0x41, 0x24F), ('latin', 0x1E00, 0x1EFF), ('greek', 0x370, 0x3FF), ('greek', 0x1F00, 0x1FFF), ('cyrillic', 0x400, 0x52F),
    ('armenian', 0x530, 0x58F), ('hebrew', 0x590, 0x5FF), ('arabic', 0x600, 0x6FF), ('arabic', 0x750, 0x77F), ('arabic', 0xFB50, 0xFDFF),
    ('arabic', 0xFE70, 0xFEFF), ('devanagari', 0x900, 0x97F), ('bengali', 0x980, 0x9FF), ('tamil', 0xB80, 0xBFF), ('telugu', 0xC00, 0xC7F),
    ('thai', 0xE00, 0xE7F), ('georgian', 0x10A0, 0x10FF), ('hangul', 0x1100, 0x11FF), ('hangul', 0x3130, 0x318F), ('hangul', 0xAC00, 0xD7AF),
    ('hiragana', 0x3040, 0x309F), ('katakana', 0x30A0, 0x30FF), ('katakana', 0x31F0, 0x31FF), ('katakana', 0xFF66, 0xFF9F),
    ('han', 0x3400, 0x4DBF), ('han', 0x4E00, 0x9FFF), ('han', 0xF900, 0xFAFF), ('han', 0x20000, 0x2A6DF),
]
# Scripts that name their language outright (Arabic, Cyrillic and Han are refined below).
SCRIPT_LANG = {'greek': 'el', 'armenian': 'hy', 'hebrew': 'he', 'devanagari': 'hi', 'bengali': 'bn', 'tamil': 'ta', 'telugu': 'te', 'thai': 'th',
               'georgian': 'ka', 'hangul': 'ko'}
# Letters that tell one language of a shared script from another (checked after the script is known).
ARABIC_MARKS = {'fa': 'پچژگ', 'ur': 'ٹڈڑںے'}
CYRILLIC_MARKS = {'uk': 'іїєґ', 'ru': 'ыэъё'}
# Latin-script languages: stopwords (two points each, one when another language lists the same word) and marker letters (one point each, at most MARK_CAP).
LATIN_STOPWORDS = {
    'en': 'the and is are was were to of in that it for with on as this have has had but not they we you i at be from or an by which what when how there their our your can will would about all been if more one so than then them these those do does did because just also its',
    'fr': 'le les des un une du et est sont était étaient à au aux ce cet cette ces que qui dans pour avec sur pas ne nous vous je il elle ils elles on mais ou où par sa son ses leur leurs mon ma mes ton ta tes très aussi comme j l d qu c n s m t été avons avez ont ai fait faire être avoir cela ça tout tous notre nos votre vos sous entre depuis jusqu après avant chaque toute toutes grâce',
    'es': 'el los las un una unos unas del y es son era fue que en por para con sin su sus lo le les al pero como más muy también este esta estos estas ese esa eso yo tú nosotros ellos ella me te nos mi mis tu hay ha han he hemos sido ser estar está están porque cuando donde qué cómo cuál quién nuestro nuestra nuestros nuestras sobre entre desde hasta después antes cada todo toda todos todas gracias',
    'pt': 'o os as um uma uns umas do da dos das e é são era foi que em no na nos nas por para com sem seu sua seus suas ao aos mas como mais muito também este esta isso isto eu você nós eles elas me te meu minha tem têm ser estar está estão porque quando onde não já ainda pelo pela pelos pelas num numa nosso nossa nossos nossas sobre entre até depois antes cada todo toda todos todas graças',
    'de': 'der die das den dem des ein eine einen einem einer und ist sind war waren nicht ich wir sie er es zu von mit auf für im in an bei nach aus aber auch wie noch nur oder wenn dass weil dann hat haben hatte wurde wurden wird werden sehr schon mehr dieser diese dieses mein meine unser unsere unserer unseren unserem vor über unter zwischen seit bis jeder jede jedes alle durch dank',
    'it': 'il lo i gli le un uno una di del della dei delle e è sono era erano che in per con su non ci si ma come più molto anche questo questa questi queste quello io tu noi voi loro mi ti ha hanno ho abbiamo stato essere perché quando dove cosa l un dell all nell nel nella nei nelle sul sulla sui sulle dal dalla dai dalle alla alle agli nostro nostra nostri nostre grazie tutto tutti tutta tutte dopo prima',
    'nl': 'het een en is zijn was waren niet ik we wij je jij u hij zij ze van met op voor in aan bij naar uit maar ook als nog alleen of dat omdat dan heeft hebben had werd werden wordt worden zeer al meer deze dit mijn onze ons over onder tussen sinds tot elke alle door dankzij',
    'pl': 'i w we z na do jest są był była było nie się to że jak ale po od dla przez co już tylko też który która które ten ta te jego jej ich mój nasz nasza być mieć mamy miał bardzo aby bo gdy kiedy gdzie tak czy o',
    'ro': 'și în cu pe este sunt era au nu se un o al ale că ce din pentru mai sau dar prin foarte cum când unde acest această aceste eu noi voi ei ele avea avem fost fi fiind mea meu nostru am cel cea cei cele lui lor noastră după înainte între toate toți tot fiecare',
    'tr': 've bir bu şu o için ile de da ama çok daha gibi ben biz siz onlar değil var yok oldu olan olarak ne nasıl neden çünkü kadar sonra önce her bütün bizim benim',
    'sv': 'och är det en ett i på av för med som att inte jag vi ni de han hon den detta har hade var varit till från men om eller så också mycket kan ska skulle vår min',
    'da': 'og er det en et i på af for med som at ikke jeg vi de han hun den dette har havde var været til fra men om eller så også meget kan skal ville vores min hvad noget mig nogle blev',
    'no': 'og er det en et i på av for med som å ikke jeg vi de han hun den dette har hadde var vært til fra men om eller så også mye kan skal ville vår min hva noe meg noen ble',
    'fi': 'ja on ei oli että se ovat mutta kun niin myös tai kuin joka tämä nämä minä me te he hän ollut olla sekä jos vain jo mitä miten miksi koska hyvin meidän minun',
}
LATIN_MARKS = {'es': 'ñ¿¡', 'pt': 'ãõ', 'de': 'ß', 'pl': 'ąćęłńśźż', 'ro': 'ășțşţ', 'tr': 'ığş', 'da': 'øæ', 'no': 'øæ', 'sv': 'åäö', 'fi': 'äö', 'fr': 'œ', 'nl': 'ĳ'}
CYRILLIC_STOPWORDS = {
    'ru': 'и в не на я что он она мы вы они это как но по из за для от все так его ее их был была были быть уже только еще когда если или то мой наш',
    'uk': 'і в не на я що він вона ми ви вони це як але по з за для від все так його її їх був була були бути вже тільки ще коли якщо або то мій наш та',
}

_STOP = {lang: frozenset(words.split()) for lang, words in LATIN_STOPWORDS.items()}
# A word that sits in several languages' lists ("de", "o", "en") says little: it scores one point, a word only one language has scores two.
_LISTED = {}
for _words in _STOP.values():
    for _w in _words:
        _LISTED[_w] = _LISTED.get(_w, 0) + 1
_CYR_STOP = {lang: frozenset(words.split()) for lang, words in CYRILLIC_STOPWORDS.items()}
_MARKS = {lang: frozenset(chars) for lang, chars in LATIN_MARKS.items()}


def _script(cp):
    for name, lo, hi in SCRIPT_RANGES:
        if lo <= cp <= hi:
            return name
    return None


def _tokens(text):
    """The lower-cased letter runs of a text (an apostrophe or any non-letter ends a run: "l'équipe" is "l", "équipe")."""
    out, run = [], []
    for ch in text:
        if ch.isalpha():
            run.append(ch)
        elif run:
            out.append(''.join(run).lower())
            run = []
    if run:
        out.append(''.join(run).lower())
    return out


def detect(text):
    """The language a short text is written in: {'lang': code or None, 'units': words (characters / 2 for scripts without spaces), 'score': int,
    'strong': bool}. 'lang' is None when the text is too thin or two languages tie; 'strong' means a long, unambiguous text (the session may then switch
    on this one utterance). Deterministic and pure; the JavaScript port gives the same result."""
    text = unicodedata.normalize('NFKC', str(text or ''))[:DETECT_CHARS]
    counts, letters = {}, 0
    for ch in text:
        if ch.isalpha():
            s = _script(ord(ch))
            letters += 1
            if s:
                counts[s] = counts.get(s, 0) + 1
    spaced = len([w for w in text.split() if any(c.isalpha() for c in w)])
    cjk = counts.get('han', 0) + counts.get('hiragana', 0) + counts.get('katakana', 0) + counts.get('hangul', 0) + counts.get('thai', 0)
    units = max(spaced, cjk // 2) if cjk * 2 >= letters else spaced
    out = {'lang': None, 'units': units, 'score': 0, 'strong': False}
    if letters < 2 or not counts:
        return out
    kana, han = counts.get('hiragana', 0) + counts.get('katakana', 0), counts.get('han', 0)
    top = max(sorted(counts), key=lambda k: counts[k])   # the script with most letters (ties: alphabetical)
    if kana and kana + han >= letters * 3 // 5:          # Japanese mixes kana and Han: neither alone holds a clear majority
        lang = 'ja'
        out.update(lang=lang, score=kana + han, strong=units >= 3 and (kana + han) * 10 >= letters * 8)
        return out
    if counts[top] * 5 < letters * 3:                    # no script holds three letters in five: mixed, not named
        return out
    if top == 'han':
        lang = 'zh'
    elif top == 'arabic':
        lang = next((code for code, marks in ARABIC_MARKS.items() if any(c in marks for c in text)), 'ar')
    elif top == 'cyrillic':
        toks = _tokens(text)
        mark = next((code for code, marks in CYRILLIC_MARKS.items() if any(c in marks for c in text.lower())), None)
        scores = {code: sum(1 for t in toks if t in words) for code, words in _CYR_STOP.items()}
        lang = mark or ('uk' if scores['uk'] > scores['ru'] else 'ru')
    elif top == 'latin':
        return _latin(text, out)
    else:
        lang = SCRIPT_LANG.get(top)
    out.update(lang=lang, score=counts[top], strong=bool(lang) and units >= 3 and counts[top] * 10 >= letters * 8)
    return out


def _latin(text, out):
    toks = _tokens(text)
    marks = {}
    for ch in text.lower():
        for lang, chars in _MARKS.items():
            if ch in chars:
                marks[lang] = marks.get(lang, 0) + 1
    scores = {}
    for lang, words in _STOP.items():
        scores[lang] = sum(2 if _LISTED[t] == 1 else 1 for t in toks if t in words) + min(MARK_CAP, marks.get(lang, 0))
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    (best_lang, best), second = ranked[0], ranked[1][1]
    out['score'] = best
    if best >= MIN_SCORE and best > second:
        out['lang'] = best_lang
        out['strong'] = best >= STRONG_SCORE and best >= 2 * second
    return out


# ----- ATLAS's own fixed lines, per language (BANK_LANGUAGES). Quoted button names stay as the page shows them (the page is not localised). -----

# What the consultant is told the first time ATLAS cannot speak their language aloud. Shown on screen (and said by the talker in its own words
# for languages outside the banks).
NOTICES = {
    'voice_unavailable': {
        'en': 'ATLAS cannot speak aloud here right now. Its replies appear on screen, and you can keep speaking or typing.',
        'fr': "ATLAS ne peut pas parler français à voix haute ici pour le moment. Ses réponses s'affichent à l'écran, et vous pouvez continuer à parler ou à écrire.",
        'es': 'ATLAS no puede hablar español en voz alta aquí por ahora. Sus respuestas aparecen en pantalla, y puedes seguir hablando o escribiendo.',
        'pt': 'A ATLAS não consegue falar português em voz alta aqui por enquanto. As respostas aparecem na tela, e você pode continuar falando ou escrevendo.',
        'de': 'ATLAS kann hier im Moment nicht auf Deutsch sprechen. Die Antworten erscheinen auf dem Bildschirm, und Sie können weiter sprechen oder schreiben.',
        'it': 'ATLAS non può parlare italiano ad alta voce qui per ora. Le risposte compaiono sullo schermo, e puoi continuare a parlare o a scrivere.',
        'nl': 'ATLAS kan hier nu geen Nederlands uitspreken. De antwoorden verschijnen op het scherm, en je kunt blijven praten of typen.',
    },
    # One screen line when the voice stays English. It names that fact in the consultant's language.
    # Japanese is included because an unspaced Japanese fallback has no bank greeting.
    'voice_stays_english': {
        'en': 'ATLAS understands you. Its voice stays English.',
        'fr': 'ATLAS comprend. La voix reste en anglais.',
        'es': 'ATLAS entiende. La voz sigue en inglés.',
        'pt': 'A ATLAS compreende. A voz fica em inglês.',
        'de': 'ATLAS versteht dich. Die Stimme bleibt Englisch.',
        'it': 'ATLAS capisce. La voce resta in inglese.',
        'nl': 'ATLAS begrijpt je. De stem blijft Engels.',
        'ja': 'ATLASは理解しています。音声は英語のままです。',
    },
    'typed_wait': {
        'en': "I'll take that as soon as I finish speaking.",
        'fr': "Je prends cela dès que j'ai fini de parler.",
        'es': 'Lo recojo en cuanto termine de hablar.',
        'pt': 'Eu anoto isso assim que terminar de falar.',
        'de': 'Ich nehme das auf, sobald ich ausgesprochen habe.',
        'it': 'Lo prendo non appena finisco di parlare.',
        'nl': 'Ik neem dat op zodra ik uitgesproken ben.',
    },
    'typed_busy': {
        'en': 'ATLAS is still replying. Wait a moment, then send that again.',
        'fr': "ATLAS est encore en train de répondre. Attendez un instant, puis renvoyez votre message.",
        'es': 'ATLAS todavía está respondiendo. Espera un momento y vuelve a enviarlo.',
        'pt': 'A ATLAS ainda está respondendo. Aguarde um instante e envie de novo.',
        'de': 'ATLAS antwortet noch. Warten Sie einen Moment und senden Sie es dann erneut.',
        'it': 'ATLAS sta ancora rispondendo. Aspetta un momento e invia di nuovo.',
        'nl': 'ATLAS is nog aan het antwoorden. Wacht even en stuur het dan opnieuw.',
    },
    'stt_failed': {
        'en': 'A speech segment could not be transcribed. Please repeat it or add it to your notes.',
        'fr': "Un passage n'a pas pu être transcrit. Répétez-le ou ajoutez-le à vos notes.",
        'es': 'No se pudo transcribir un fragmento. Repítelo o añádelo a tus notas.',
        'pt': 'Não foi possível transcrever um trecho. Repita ou acrescente às suas notas.',
        'de': 'Ein Abschnitt konnte nicht transkribiert werden. Bitte wiederholen Sie ihn oder ergänzen Sie ihn in Ihren Notizen.',
        'it': 'Non è stato possibile trascrivere un passaggio. Ripetilo o aggiungilo alle tue note.',
        'nl': 'Een fragment kon niet worden getranscribeerd. Herhaal het of voeg het toe aan je notities.',
    },
    'echo': {
        'en': 'ATLAS heard its own voice through the microphone and ignored it. Headphones prevent this.',
        'fr': "ATLAS a entendu sa propre voix dans le micro et l'a ignorée. Un casque évite cela.",
        'es': 'ATLAS oyó su propia voz por el micrófono y la ignoró. Con auriculares no ocurre.',
        'pt': 'A ATLAS ouviu a própria voz pelo microfone e a ignorou. Fones de ouvido evitam isso.',
        'de': 'ATLAS hat seine eigene Stimme über das Mikrofon gehört und ignoriert. Kopfhörer verhindern das.',
        'it': 'ATLAS ha sentito la propria voce dal microfono e l\'ha ignorata. Le cuffie lo evitano.',
        'nl': 'ATLAS hoorde zijn eigen stem via de microfoon en negeerde die. Met een koptelefoon gebeurt dat niet.',
    },
}
# Each voice_unavailable line names its own language. A language outside BANK_LANGUAGES has no notice: the talker says it once, in the language,
# from the server's language note.

# The lines said after the consultant corrects something, answers the read-back, or confirms it (session.js SUMMARY_LINES). Each is one or two sentences.
SUMMARY_LINES = {
    'corrected': {
        'en': ['Thank you, I have updated that. Is there anything else I have misunderstood or missed?', 'Thank you, that is updated. Is there anything else I should correct?'],
        'fr': ["Merci, c'est mis à jour. Y a-t-il autre chose que j'aurais mal compris ou oublié ?", "Merci, c'est corrigé. Y a-t-il autre chose que je devrais rectifier ?"],
        'es': ['Gracias, ya lo he actualizado. ¿Hay algo más que haya entendido mal o se me haya pasado?', 'Gracias, queda actualizado. ¿Hay algo más que deba corregir?'],
        'pt': ['Obrigado, já atualizei isso. Há mais alguma coisa que eu tenha entendido mal ou deixado passar?', 'Obrigado, está atualizado. Há mais alguma coisa que eu deva corrigir?'],
        'de': ['Danke, das ist aktualisiert. Habe ich sonst noch etwas falsch verstanden oder übersehen?', 'Danke, das ist angepasst. Soll ich sonst noch etwas korrigieren?'],
        'it': ["Grazie, ho aggiornato. C'è altro che ho capito male o che mi è sfuggito?", "Grazie, è aggiornato. C'è altro che dovrei correggere?"],
        'nl': ['Dank je, dat is bijgewerkt. Heb ik nog iets verkeerd begrepen of gemist?', 'Dank je, dat is aangepast. Moet ik nog iets corrigeren?'],
    },
    'prompt': {
        'en': ['Thanks, that is everything I need. When you are ready, press Confirm summary. It saves a private draft only you can see, and nothing goes to a reviewer until you submit it.'],
        'fr': ["Merci, j'ai tout ce qu'il me faut. Quand vous êtes prêt, appuyez sur « Confirm summary ». Cela enregistre un brouillon privé que vous seul voyez, et rien n'est transmis à un relecteur tant que vous ne l'envoyez pas."],
        'es': ['Gracias, tengo todo lo que necesito. Cuando estés listo, pulsa «Confirm summary». Guarda un borrador privado que solo tú ves, y nada llega a un revisor hasta que lo envíes.'],
        'pt': ['Obrigado, tenho tudo de que preciso. Quando estiver pronto, aperte «Confirm summary». Isso salva um rascunho privado que só você vê, e nada vai para um revisor até você enviar.'],
        'de': ['Danke, das ist alles, was ich brauche. Wenn Sie bereit sind, klicken Sie auf „Confirm summary“. Das speichert einen privaten Entwurf, den nur Sie sehen, und nichts geht an einen Prüfer, bevor Sie es einreichen.'],
        'it': ['Grazie, ho tutto quello che mi serve. Quando sei pronto, premi «Confirm summary». Salva una bozza privata che vedi solo tu, e nulla arriva a un revisore finché non la invii.'],
        'nl': ['Dank je, dat is alles wat ik nodig heb. Als je klaar bent, druk je op «Confirm summary». Dat bewaart een privéconcept dat alleen jij ziet, en niets gaat naar een beoordelaar totdat je het indient.'],
    },
    'saved': {
        'en': ['Thank you. Your summary is saved as a private draft that only you can see. Press Submit for review when you are ready; until then it goes nowhere.'],
        'fr': ["Merci. Votre résumé est enregistré comme brouillon privé que vous seul voyez. Appuyez sur « Submit for review » quand vous êtes prêt ; d'ici là, il ne va nulle part."],
        'es': ['Gracias. Tu resumen queda guardado como borrador privado que solo tú ves. Pulsa «Submit for review» cuando estés listo; hasta entonces no va a ninguna parte.'],
        'pt': ['Obrigado. Seu resumo foi salvo como rascunho privado que só você vê. Aperte «Submit for review» quando estiver pronto; até lá, ele não vai a lugar nenhum.'],
        'de': ['Danke. Ihre Zusammenfassung ist als privater Entwurf gespeichert, den nur Sie sehen. Klicken Sie auf „Submit for review“, wenn Sie bereit sind; bis dahin geht sie nirgendwohin.'],
        'it': ['Grazie. Il tuo riepilogo è salvato come bozza privata che vedi solo tu. Premi «Submit for review» quando sei pronto; fino ad allora non va da nessuna parte.'],
        'nl': ['Dank je. Je samenvatting is bewaard als privéconcept dat alleen jij ziet. Druk op «Submit for review» als je klaar bent; tot die tijd gaat het nergens heen.'],
    },
    'unsaved': {
        'en': ['Thank you. Your summary is confirmed, but it could not be saved to the library, so nothing was filed. You can try again from your notes.'],
        'fr': ["Merci. Votre résumé est confirmé, mais il n'a pas pu être enregistré dans la bibliothèque, donc rien n'a été classé. Vous pouvez réessayer depuis vos notes."],
        'es': ['Gracias. Tu resumen está confirmado, pero no se pudo guardar en la biblioteca, así que no se archivó nada. Puedes intentarlo de nuevo desde tus notas.'],
        'pt': ['Obrigado. Seu resumo foi confirmado, mas não foi possível salvá-lo na biblioteca, então nada foi arquivado. Você pode tentar de novo a partir das suas notas.'],
        'de': ['Danke. Ihre Zusammenfassung ist bestätigt, konnte aber nicht in der Bibliothek gespeichert werden, daher wurde nichts abgelegt. Sie können es über Ihre Notizen erneut versuchen.'],
        'it': ['Grazie. Il tuo riepilogo è confermato, ma non è stato possibile salvarlo nella libreria, quindi non è stato archiviato nulla. Puoi riprovare dalle tue note.'],
        'nl': ['Dank je. Je samenvatting is bevestigd, maar kon niet in de bibliotheek worden bewaard, dus er is niets opgeslagen. Je kunt het opnieuw proberen vanuit je notities.'],
    },
}

# How the spoken read-back is framed (summary.js): the opening of the first and second rounds, the mid-interview reflection, and the closing questions.
# The facts themselves are the consultant's own words, in whatever language they were said.
READBACK = {
    'lead': {'en': 'So, as I understood it:', 'fr': "Donc, si j'ai bien compris :", 'es': 'Entonces, tal como lo he entendido:', 'pt': 'Então, como eu entendi:',
             'de': 'Wenn ich es richtig verstanden habe:', 'it': "Quindi, per come l'ho capita:", 'nl': 'Dus, zoals ik het begrepen heb:'},
    'lead_again': {'en': 'So, I have added:', 'fr': "Donc, j'ai ajouté :", 'es': 'Entonces, he añadido:', 'pt': 'Então, acrescentei:', 'de': 'Dann habe ich ergänzt:',
                   'it': 'Quindi ho aggiunto:', 'nl': 'Dus ik heb toegevoegd:'},
    'reflect': {'en': 'So far it sounds like', 'fr': "Pour l'instant, on dirait que", 'es': 'Por ahora parece que', 'pt': 'Até agora parece que', 'de': 'Bisher klingt es so, als',
                'it': 'Finora sembra che', 'nl': 'Tot nu toe klinkt het alsof'},
    'question': {'en': 'What have I misunderstood or missed?', 'fr': "Qu'est-ce que j'ai mal compris ou oublié ?", 'es': '¿Qué he entendido mal o qué se me ha pasado?',
                 'pt': 'O que eu entendi mal ou deixei passar?', 'de': 'Was habe ich falsch verstanden oder übersehen?', 'it': 'Cosa ho capito male o cosa mi è sfuggito?',
                 'nl': 'Wat heb ik verkeerd begrepen of gemist?'},
    'question_again': {'en': 'Is there anything else I have missed?', 'fr': "Y a-t-il autre chose que j'ai oublié ?", 'es': '¿Hay algo más que se me haya pasado?',
                       'pt': 'Há mais alguma coisa que eu tenha deixado passar?', 'de': 'Habe ich noch etwas übersehen?', 'it': "C'è qualcos'altro che mi è sfuggito?",
                       'nl': 'Is er nog iets dat ik gemist heb?'},
}

# What the talker is told when a bank language has no line for something: the one-sentence job, in English. Languages outside the banks always use these.
GENERATED_LINES = {
    'pause': '[Server: the consultant paused the interview.] Say in one short sentence that you will wait and that they can press Resume when they are ready. Ask no question.',
    'resume': '[Server: the consultant is back.] Welcome them back in one short sentence and say you will repeat where you were. Ask no question.',
}


def english_voice_notice(lang):
    """The one screen notice, in the consultant's language, that the voice stays English."""
    bank = NOTICES['voice_stays_english']
    return bank.get(lang) or bank['en']


def has_bank(lang):
    return lang in BANK_LANGUAGES


EDGE_CONSTANTS = {
    'LANG_NAMES': LANGUAGE_NAMES, 'LANG_NATIVE': NATIVE_NAMES, 'LANG_RTL': list(RTL), 'LANG_BANKS': list(BANK_LANGUAGES), 'LANG_REVIEW': REVIEW_STATUS,
    'LANG_STT_AUTO': list(STT_AUTO), 'LANG_ELEVENLABS': list(ELEVENLABS_LANGUAGES), 'LANG_NATIVE_VOICES': list(NATIVE_VOICES),
    'LANG_DETECT': {'chars': DETECT_CHARS, 'min_score': MIN_SCORE, 'strong_score': STRONG_SCORE, 'mark_cap': MARK_CAP, 'ranges': [list(r) for r in SCRIPT_RANGES],
                    'script_lang': SCRIPT_LANG, 'arabic_marks': ARABIC_MARKS, 'cyrillic_marks': CYRILLIC_MARKS, 'latin_stopwords': LATIN_STOPWORDS,
                    'latin_marks': LATIN_MARKS, 'cyrillic_stopwords': CYRILLIC_STOPWORDS},
    'LANG_NOTICES': NOTICES, 'LANG_SUMMARY_LINES': SUMMARY_LINES, 'LANG_READBACK': READBACK, 'LANG_GENERATED_LINES': GENERATED_LINES,
}
