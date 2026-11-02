# Language quality: machine pre-pass (2026-11-02), no native-speaker gate

**Tony decision 2026-11-02: no native-speaker dependency, auto-translate any language** (`DECISION_LOG.md` D-L2). ATLAS does not wait for a native speaker in any language. The banks for fr, es, pt, de, it and nl are machine translations used as they are (`REVIEW_STATUS` in `atlas_voice/languages.py` is `machine_translated`), and any other text is translated automatically into any language by `deploy/cloudflare-edge/src/translate.js`: language detection, any target language tag (a regional variety such as pt-PT or es-MX is kept), a glossary of terms kept as they are, and a confidence flag (high, medium, low, none) with reason flags. The confidence travels with every translation; it never blocks anything. The suggestions in sections B and C remain a list of optional improvements anyone may apply (a machine retranslation is enough); none is required.

Scope: what ATLAS says or shows in a language other than English.
- The opening and welcome-back (`INTRO`, `INTRO_AGAIN`, `INTRO_REST`, `deploy/cloudflare-edge/src/languages.js`), and the uptake fillers (`FILLERS`).
- The acknowledgement banks (`ACKS`, 11 categories x 5 lines), `PAUSE_LINES`, `RESUME_LINES` (`atlas_voice/persona.py`).
- `NOTICES`, `SUMMARY_LINES`, `READBACK` (`atlas_voice/languages.py`).
- The trailing-word lists (`TRAIL`, `languages.js`) and the client-mention pattern (`CLIENT_MENTION_SRC`, `persona.py`).
- Not in scope: the page itself (English only, not localised); English lines (authored).

## A. Decisions (resolved 2026-11-02 by Tony's D-L2: no native-speaker gate)

1. **ATLAS's grammatical gender per language. Resolved:** no reviewer decides it. New and machine-translated text avoids gendered self-reference (`translate.js` asks for gender-neutral wording); where a language forces a form, the translation's choice stands. The existing bank lines stay as they are and may be retranslated at any time without a review.
2. **The consultant's gender. Resolved:** translation uses gender-neutral address (no gender is known, and the translator is told never to assume one). The existing bank lines stay until retranslated; no sign-off is needed.
3. **Target varieties. Resolved:** the banks keep Spain Spanish and Brazilian Portuguese as defaults. Any other variety is produced on demand by giving a regional tag (for example `pt-PT`, `es-MX`, `fr-CA`) to `translate.js` or `MICHAT_CV_LANGUAGE`; no reviewer is needed to switch.
4. **Quotation marks around button names. Resolved:** kept as they are in the banks; machine translation uses the target language's usual quotation marks. Spoken lines do not depend on them.

## B. Line-by-line suggestions (machine pre-pass; optional improvements, no reviewer needed)

Format: current line → suggestion (why). "Minor" means it reads acceptably as is.

### French (vous)
- `typed_wait` "Je prends cela dès que j'ai fini de parler." → "Je m'en occupe dès que j'ai fini de parler." (more natural)
- `earned_result` "Cela ressemble à un solide résultat." → "Cela semble être un résultat solide." (word order)
- `earned_result` "Cela ressemble à une bonne issue." → "Cela semble être un bon aboutissement." ("issue" is odd for a project)
- `earned_result` "C'est un travail notable." → minor; check it is not cooler than meant
- `PAUSE_LINES` "quand vous êtes prêt" → "quand vous le souhaitez" (neutral, see A2); `SUMMARY_LINES` "que vous seul voyez" → "visible par vous seul(e)" or "que vous êtes seul à voir" (still gendered: pick the neutral one)
- `RESUME_LINES` "Content de vous retrouver." → "Rebonjour." or "Heureux de vous retrouver" with A1 applied
- `correction_thanks_fact` "Merci de rétablir les faits." → minor, slightly heavy; "Merci pour la précision."

### Spanish (tú, Spain)
- `typed_wait` "Lo recojo en cuanto termine de hablar." → "Lo leo en cuanto termine de hablar."
- `thanks_detail` "Eso me da la imagen, gracias." → "Con eso me hago una idea, gracias." (calque of English)
- `setback_neutral` "Suena a mucho que gestionar." → "Parece mucho que gestionar." (calque); "Es una posición difícil." → "Es una situación difícil."
- `earned_result` "Suena a un buen desenlace." → "Suena a un buen resultado final." ("desenlace" reads as the end of a story)
- `RESUME_LINES` "Esto es lo que estábamos viendo." → "Aquí es donde estábamos."; "Bienvenido de nuevo" → "Hola de nuevo" (neutral, A2); "cuando estés listo" → "cuando quieras"
- "Vale" (eight lines) is Spain only; for Latin America use "De acuerdo" or "Bien" (A3)

### Portuguese (você, Brazil)
- "Obrigado" in every line → "Obrigada" if ATLAS is feminine (A1)
- `neutral` "Percebi." → "Compreendi." (in Brazil "percebi" means "I noticed")
- `injection` "Sigo com a entrevista." → "Vou seguir com a entrevista." (reads as Spanish)
- `PAUSE_LINES` "Leve todo o tempo de que precisar." → "Fique à vontade, sem pressa." (calque); "quando estiver pronto" → "quando quiser" (A2)
- `RESUME_LINES` "Bem-vindo de volta." → "Que bom que voltou." (already used as line 1; "Oi de novo." also works)
- `thanks_detail` "Isso me dá o panorama, obrigado." → "Agora tenho o panorama, obrigada."
- Quotes «Confirm summary» → “Confirm summary” (A4)

### German (Sie)
- `setback_neutral` "Das klingt nach sehr viel zu bewältigen." → "Das klingt nach sehr viel, das zu bewältigen war." (ungrammatical as written)
- `setback_neutral` "Das klingt schwer zu bewältigen." → "Das klingt nach einer schwierigen Situation."
- `thanks_detail` "Das gibt mir ein Bild, danke." → "Damit habe ich ein Bild, danke."
- `confidential_ok` "Kein Problem, das bleibt draußen." → "Kein Problem, das lassen wir außen vor." (colloquial)
- `reangle` "Ich frage anders." → "Ich frage es anders."
- `echo` "ATLAS hat seine eigene Stimme" → see A1

### Italian (tu)
- `typed_wait` "Lo prendo non appena finisco di parlare." → "Lo leggo appena finisco di parlare."
- `thanks_detail` "Grazie, mi aiuta." → "Grazie, mi è utile."; "Mi dà il quadro, grazie." → "Così ho il quadro, grazie."
- `reangle` "Proviamo da un altro lato." → "Proviamo da un'altra prospettiva."
- `SUMMARY_LINES.unsaved` "salvarlo nella libreria" → "salvarlo nella raccolta" or "nell'archivio" ("libreria" is a bookshop or bookcase)
- `INTRO_REST` "riservato per il cliente" → "riservato del cliente" or "confidenziale per il cliente" (minor; the opening is Tony's wording, so a change needs his approval)
- `PAUSE_LINES` "quando sei pronto", `RESUME_LINES` "Bentornato" → "quando vuoi", "Eccoci di nuovo" (A2)

### Dutch (je)
- `NOTICES.voice_unavailable` "ATLAS kan hier nu geen Nederlands uitspreken." → "ATLAS kan hier nu niet hardop Nederlands praten." ("uitspreken" means "pronounce")
- `typed_wait` "Ik neem dat op zodra ik uitgesproken ben." → "Ik lees dat zodra ik klaar ben met praten." ("opnemen" reads as "record")
- `thanks_detail` "Dat geeft me het beeld, dank je." → "Zo heb ik een beeld, dank je."
- `echo` "zijn eigen stem" → see A1; quotes «» → “ ” (A4)

## C. Trailing-word lists (`TRAIL`): optional checks

The rule is precision first: a word on the list makes ATLAS treat an answer as unfinished and wait or nudge, so a word that often ENDS a finished answer is the harmful kind of mistake.
- fr: "la" (could the recogniser write "la" for "là", as in "c'est là"?); is "que" worth adding ("je pense que")?
- es: "o" and "y" are good signals; is "que" worth adding ("creo que")? Is "eh" kept by Nova-3?
- pt: "da", "do" and "tipo" look right; "tipo" can end a sentence in speech ("...e tal, tipo"): confirm it is rare enough.
- de: good; is "oder" missing (it is "or")? It also ends tag questions ("..., oder?"), which the question-mark rule catches only if the recogniser writes "?".
- it: "che", "lo" and "il": confirm a finished answer almost never ends on them; "cioè" can close a sentence in speech.
- nl: good; "of" also ends tag-like phrases ("..., of niet?") only with a question mark.
- All: confirm which hesitation sounds (euh, ähm, ehm) Nova-3 keeps at all; if it drops them, those entries are harmless but unused.

## D. Checklist (optional, if anyone fluent ever reads a language; not a gate)

1. Read the opening aloud (both pieces). It is about 22 seconds in English; is it natural spoken language, not written language?
2. Check the register (vous / tú / você / Sie / tu / je) is the right one for a consultant talking to a work tool, and that every bank line uses the same register.
3. Apply decisions A1 to A4 to every line.
4. Mark each line in section B: accept the suggestion, keep the current line, or write a better one.
5. Read every acknowledgement category against its English meaning (the comments in `persona.py` say what each one is for). In particular: `promising_unverified` must not agree with an unverified figure; `injection` must not accuse; `no_number_fine` must not invite skipping a number; `earned_result` must not be effusive (banned praise words apply).
6. Check section C for the language.
7. Sign off in this file (name, date, language), then change that language's `REVIEW_STATUS` in `atlas_voice/languages.py` (a code change with its tests) and rebuild (`build_edge.py`), so the edge tables follow.
