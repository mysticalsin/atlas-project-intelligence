# Native-speaker review: machine pre-pass and checklist (2026-11-02)

Status: **a machine pre-pass only.** Every line below was read by the agent, not by a native speaker. Nothing in the code was changed by this pass: the strings are pinned by tests and the opening is Tony's own wording, so each suggestion waits for a native speaker (one per language) to accept, reject or rewrite it. `REVIEW_STATUS` in `atlas_voice/languages.py` stays `needs_native_review` for fr, es, pt, de, it and nl until that sign-off.

Scope: what ATLAS says or shows in a language other than English.
- The opening and welcome-back (`INTRO`, `INTRO_AGAIN`, `INTRO_REST`, `deploy/cloudflare-edge/src/languages.js`), and the uptake fillers (`FILLERS`).
- The acknowledgement banks (`ACKS`, 11 categories x 5 lines), `PAUSE_LINES`, `RESUME_LINES` (`atlas_voice/persona.py`).
- `NOTICES`, `SUMMARY_LINES`, `READBACK` (`atlas_voice/languages.py`).
- The trailing-word lists (`TRAIL`, `languages.js`) and the client-mention pattern (`CLIENT_MENTION_SRC`, `persona.py`).
- Not in scope: the page itself (English only, not localised); English lines (authored).

## A. Decisions before the line-by-line review (for Tony)

1. **ATLAS's grammatical gender per language.** The copy is not consistent. Portuguese presents ATLAS as feminine ("eu sou a ATLAS", "A ATLAS ainda está respondendo") but she says "Obrigado" (masculine speaker form) everywhere; German and Dutch use masculine or neuter possessives ("seine eigene Stimme", "zijn eigen stem"); French and Italian speaker agreements are masculine ("Merci de m'avoir corrigé", "Content de vous retrouver", "Grazie per avermi corretto"). Pick one per language. If ATLAS is "she" (as in the English docs): pt "Obrigada", fr "corrigée" / "Contente", it "corretta", de "ihre eigene Stimme", nl "haar eigen stem".
2. **The consultant's gender.** Every language addresses the consultant in the masculine: fr "quand vous êtes prêt", "que vous seul voyez"; es "cuando estés listo", "Bienvenido de nuevo"; pt "quando estiver pronto", "Bem-vindo de volta"; it "quando sei pronto", "Bentornato". Suggested neutral forms are in section B (no gender is known, and guessing one is worse than a neutral phrase).
3. **Target varieties.** Spanish is Spain Spanish ("vale", "pulsa", "se me ha pasado", the present perfect); Portuguese is Brazilian ("você", "tela", "fones de ouvido", "aperte"). Confirm these match the consultants (for example Latin American Spanish speakers, or Portugal for Portuguese), or the reviewers will rewrite toward the wrong variety.
4. **Quotation marks around button names.** «Confirm summary» is right for French, Spanish and Italian, but Brazilian Portuguese and Dutch normally use “ ”. The pause lines name Resume with no quotes at all. Decide whether a spoken line needs quotes at all (they are shown on screen as the transcript).

## B. Line-by-line suggestions (machine pre-pass; a native speaker decides)

Format: current line → suggestion (why). "Minor" means it reads acceptably as is.

### French (vous)
- `typed_wait` "Je prends cela dès que j'ai fini de parler." → "Je m'en occupe dès que j'ai fini de parler." (more natural)
- `earned_result` "Cela ressemble à un solide résultat." → "Cela semble être un résultat solide." (word order)
- `earned_result` "Cela ressemble à une bonne issue." → "Cela semble être un bon aboutissement." ("issue" is odd for a project)
- `earned_result` "C'est un travail notable." → minor; check it is not cooler than meant
- `PAUSE_LINES` "quand vous êtes prêt" → "quand vous le souhaitez" (neutral, see A2); `SUMMARY_LINES` "que vous seul voyez" → "visible par vous seul(e)" or "que vous êtes seul à voir" (still gendered: a native speaker should choose)
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
- `RESUME_LINES` "Bem-vindo de volta." → "Que bom que voltou." (already used as line 1; a native speaker may prefer "Oi de novo.")
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

## C. Trailing-word lists (`TRAIL`): what a native speaker should check

The rule is precision first: a word on the list makes ATLAS treat an answer as unfinished and wait or nudge, so a word that often ENDS a finished answer is the harmful kind of mistake.
- fr: "la" (could the recogniser write "la" for "là", as in "c'est là"?); is "que" worth adding ("je pense que")?
- es: "o" and "y" are good signals; is "que" worth adding ("creo que")? Is "eh" kept by Nova-3?
- pt: "da", "do" and "tipo" look right; "tipo" can end a sentence in speech ("...e tal, tipo"): confirm it is rare enough.
- de: good; is "oder" missing (it is "or")? It also ends tag questions ("..., oder?"), which the question-mark rule catches only if the recogniser writes "?".
- it: "che", "lo" and "il": confirm a finished answer almost never ends on them; "cioè" can close a sentence in speech.
- nl: good; "of" also ends tag-like phrases ("..., of niet?") only with a question mark.
- All: confirm which hesitation sounds (euh, ähm, ehm) Nova-3 keeps at all; if it drops them, those entries are harmless but unused.

## D. Checklist for each native reviewer (one per language)

1. Read the opening aloud (both pieces). It is about 22 seconds in English; is it natural spoken language, not written language?
2. Check the register (vous / tú / você / Sie / tu / je) is the right one for a consultant talking to a work tool, and that every bank line uses the same register.
3. Apply decisions A1 to A4 to every line.
4. Mark each line in section B: accept the suggestion, keep the current line, or write a better one.
5. Read every acknowledgement category against its English meaning (the comments in `persona.py` say what each one is for). In particular: `promising_unverified` must not agree with an unverified figure; `injection` must not accuse; `no_number_fine` must not invite skipping a number; `earned_result` must not be effusive (banned praise words apply).
6. Check section C for the language.
7. Sign off in this file (name, date, language), then change that language's `REVIEW_STATUS` in `atlas_voice/languages.py` (a code change with its tests) and rebuild (`build_edge.py`), so the edge tables follow.
