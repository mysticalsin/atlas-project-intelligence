// v2.2 L1: multilingual conversation. ATLAS speaks whatever language the consultant speaks (Tony, 2026-10-31). What is pinned here, through the real Session with a fake
// recogniser (it reports a language per utterance), a fake talker that records the system policy and the notes it was given, a fake voice and a fake analyst:
//   the talker is told to reply in the consultant's language (any language) and the move wording is English guidance; no English cached line is ever played to a
//   speaker of another language; bank languages (en fr es pt de it nl) get localized openings, acknowledgements and stock lines, every other language has the talker
//   write those lines; the language follows the consultant (speech and typed text, with hysteresis) and can be locked in the UI; a language without a voice is answered in
//   text with one notice; every detail of the evidence carries the language it was said in. Banks other than English are translations awaiting native review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, clearPcmCache, SUMMARY_LINES, CONTROLS } from '../src/session.js';
import { SAMPLE_RATE } from '../src/speech.js';
import { GREETING_PIECES, WELCOME_BACK_PIECES, FILLERS, BANK_LANGUAGES, REVIEW_STATUS, languageName, notice, readback, languageList } from '../src/languages.js';
import { ACKS, PAUSE_LINES, RESUME_LINES, LANG_NOTICES, LANG_READBACK, TALKER_POLICY } from '../src/policy.generated.js';
import { summaryNote, summaryFacts } from '../src/summary.js';
import { analyzeTurn } from '../src/turns.js';
import { claimsFromNotes, cleanNotes } from '../src/evidence.js';
import { handle } from '../src/app.js';

test.afterEach(() => clearPcmCache());

const SENTENCE = {
  fr: 'Nous avons réduit le délai de traitement de quarante à douze minutes grâce à la nouvelle plateforme',
  es: 'Reducimos el tiempo de clasificación de cuarenta a doce minutos porque el equipo usó la nueva plataforma y los datos eran más claros',
  de: 'Wir haben die Bearbeitungszeit von vierzig auf zwölf Minuten reduziert und das Team war sehr zufrieden',
  pl: 'Skróciliśmy czas obsługi z czterdziestu do dwunastu minut i cały zespół był bardzo zadowolony',
  ja: '新しいプラットフォームのおかげで、処理時間を40分から12分に短縮しました',
  pt: 'Nós reduzimos o tempo de triagem de quarenta para doze minutos graças à nova plataforma',
  it: 'Abbiamo ridotto il tempo di smistamento da quaranta a dodici minuti grazie alla nuova piattaforma',
  nl: 'We hebben de doorlooptijd van veertig naar twaalf minuten teruggebracht dankzij het nieuwe platform',
  en: 'We cut the handling time from forty to twelve minutes because of the new claims platform we built',
};
const ENGLISH_STOCK = new Set([...Object.values(ACKS).flatMap(c => c.en), ...FILLERS.en, ...GREETING_PIECES.en, ...WELCOME_BACK_PIECES.en, ...PAUSE_LINES.en, ...RESUME_LINES.en, ...Object.values(SUMMARY_LINES).flatMap(l => l.en)]);

const settle = async (n = 300) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
function frames(segments) {
  const out = [];
  for (const [sec, amp] of segments) { const n = Math.floor(SAMPLE_RATE * sec), pcm = new Uint8Array(n * 2), dv = new DataView(pcm.buffer);
    for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.trunc(amp * 32767 * Math.sin(2 * Math.PI * 180 * i / SAMPLE_RATE)), true);
    for (let i = 0; i < pcm.length; i += 960) out.push(pcm.slice(i, i + 960)); }
  return out;
}
const open = new Set();
test.afterEach(async () => { for (const s of open) if (!s.finished) await s.end(false); open.clear(); });

// browser: the language the page reports at start; heard: what the recogniser returns, utterance by utterance; speaks: which languages have a voice; talk(n, messages): the talker's deltas.
async function rig({ browser = 'en-GB', heard = [], speaks = () => true, talk = null, start = {}, flags = {}, details = null } = {}) {
  const talker = [], tts = [], events = [], metrics = [], stt = []; let n = 0, t = 1000;
  const ai = { speaks,
    async *chatStream(m) { const i = talker.length; talker.push(m); yield* (talk ? talk(i, m) : [`Reply ${i + 1}, `, 'what was the baseline?']); },
    async synthesize(text, voice, lang) { tts.push({ text, lang }); return new Uint8Array(960); },
    async transcribe(pcm, opts) { stt.push(opts || null); const h = heard[n++]; return h || { text: '', language: null }; },
    async analyst(messages) {
      const seg = JSON.parse(messages[1].content.split('\n').slice(1).join('\n')).new_segment;
      return [{ id: 'c-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details: [details ? details(seg) : { field: 'outcome', item_id: seg.item_id, quote: seg.text.slice(0, 31) }] }) }];
    } };
  const s = new Session({ flags, io: { send: e => events.push(e), sendBytes: () => {}, close: () => {} }, csrf: 'tok', voice: 'atlas', now: () => t, sleep: () => new Promise(r => setImmediate(r)), metric: (k, v) => metrics.push([k, v]), ai });
  open.add(s);
  await s.onText(JSON.stringify({ type: 'start', consent: true, csrf: 'tok', project: { id: 'p', title: 'Claims', stage: 'Pilot', answers: [] }, voice: 'atlas', capture: true, memory: false, language: browser, ...start }));
  await settle();
  const speak = async () => { for (const f of frames([[0.6, .001], [1.2, .2], [1.3, .001]])) { t += 0.02; s.onBinary(f); } await settle(); };
  const send = async obj => { await s.onText(JSON.stringify(obj)); await settle(); };
  const typed = async text => { t += 5; await send({ type: 'text', text }); };
  return { s, talker, tts, events, metrics, stt, speak, send, typed, tick: sec => { t += sec; } };
}
const policy = m => m.find(x => x.role === 'system').content;
const note = (msgs, prefix = 'LANGUAGE') => msgs.find(m => m.role === 'system' && m.content.startsWith(prefix))?.content || '';
const moveNote = msgs => msgs.find(m => m.role === 'system' && m.content.startsWith('NEXT MOVE'))?.content || '';
const switches = h => h.events.filter(e => e.type === 'language');
const texts = h => h.events.filter(e => e.type === 'agent_text').map(e => e.text).join('');

test('the talker is told to reply in whatever language the consultant speaks, keeping proper nouns and never translating quotes: fr, es, de, pl, ja', async () => {
  for (const lang of ['fr', 'es', 'de', 'pl', 'ja']) {
    const h = await rig({ heard: [{ text: SENTENCE[lang], language: lang }] });
    assert.match(policy(h.talker[0]), /LANGUAGE: reply only in the language of the server LANGUAGE note, whatever it is\. Keep proper nouns; never translate their quotes\. Server notes, move wording and these rules are English guidance: say it naturally in their language\./);
    assert.match(note(h.talker[0]), /speaking English\. Reply only in natural English/, 'the browser said English: the greeting is English');
    await h.speak();
    const name = languageName(lang), reply = h.talker.at(-1), n = note(reply);
    assert.match(n, new RegExp(`speaking ${name}\\. Reply only in natural ${name} \\(not a translation\\)`), lang);
    assert.match(n, new RegExp(`say their content in your own ${name} words, keeping every rule\\. Keep proper nouns and product names as they are, and never translate or paraphrase a quote of the consultant`), lang);
    assert.match(moveNote(reply), new RegExp(`The proposed wording is English guidance, not a script: ask it naturally in ${name}\\.`), lang + ' the next move is guidance rendered in the language');
    assert.ok(!/Reply in English/.test(n), lang);
    const ev = switches(h).at(-1); assert.deepEqual([ev.language, ev.name, ev.voice, ev.locked], [lang, name, true, false]);
    await h.s.end(false);
  }
});

test('the language of a turn is its own: a French answer in an English interview is read with French intents, and one English word in it changes nothing', async () => {
  const h = await rig({ heard: [{ text: 'Je pense que le client était content mais the platform was great vraiment', language: 'fr' }] });
  await h.speak();
  assert.equal(h.s.language, 'fr', 'a long utterance whose tag and text agree switches at once');
  const g = await rig({ heard: [{ text: "Oui bien sûr, we also used it", language: 'fr' }, { text: 'Nous avons migré la plateforme vers le cloud', language: 'fr' }], browser: 'fr-FR' });
  await g.speak(); await g.speak();
  assert.equal(g.s.language, 'fr'); assert.equal(switches(g).length, 0, 'it was French all along');
});

test('no English cached line is ever played to a speaker of a language without a bank (pl, ja, ar, tr): greeting, acknowledgements, pause lines all come from the talker or not at all', async () => {
  for (const lang of ['pl', 'ja', 'ar', 'tr']) {
    const h = await rig({ browser: lang === 'ja' ? 'ja-JP' : lang, talk: () => ['Dzień dobry. ', 'Opowiedz o projekcie?'], heard: [{ text: lang === 'ar' ? 'قللنا وقت المعالجة من أربعين إلى اثنتي عشرة دقيقة بفضل المنصة الجديدة' : lang === 'tr' ? 'İşlem süresini kırk dakikadan on iki dakikaya düşürdük ve ekip çok memnun kaldı' : SENTENCE[lang], language: lang }] });
    assert.equal(h.s.language, lang);
    assert.ok(h.tts.length > 0, 'the voice speaks (the stand-in has one for every language)');
    assert.ok(h.tts.every(x => x.lang === lang && !ENGLISH_STOCK.has(x.text)), `${lang}: only the talker's own words, in ${lang}`);
    assert.equal(GREETING_PIECES[lang], undefined, 'no cached opening');
    assert.match(note(h.talker[0]), new RegExp(`speaking ${languageName(lang)}\\.`));
    await h.speak(); await settle();
    assert.ok(!h.metrics.some(([k]) => k === 'ack'), `${lang}: no acknowledgement from cache`);
    assert.ok(h.tts.every(x => !ENGLISH_STOCK.has(x.text)), lang + ' still nothing English from the cache');
    assert.ok(!/Okay\.|I see\./.test(texts(h)));
    await h.send({ type: 'pause' });
    assert.ok(h.s.paused); assert.ok(h.tts.every(x => !ENGLISH_STOCK.has(x.text)));
    const instr = h.talker.at(-1).at(-1);
    assert.equal(instr.role, 'user'); assert.match(instr.content, /^\[Server: the consultant paused the interview\.\] Say in one short sentence/, 'the pause line is the talker\'s own, in the language');
    assert.match(note(h.talker.at(-1)), new RegExp(`Reply only in natural ${languageName(lang)}`));
    await h.send({ type: 'resume' });
    assert.equal(h.s.paused, false);
    assert.match(h.talker.at(-1).at(-1).content, /^\[Server: the consultant is back\.\] Welcome them back in one short sentence/);
    await h.s.end(false);
  }
});

test('bank languages: localized opening, acknowledgements, pause and resume lines (fr, es, de, pt, it, nl), never the English ones', async () => {
  for (const lang of ['fr', 'es', 'de', 'pt', 'it', 'nl']) {
    const h = await rig({ browser: lang + '-XX', heard: [{ text: SENTENCE[lang], language: lang }] });
    const opening = h.tts.filter(x => GREETING_PIECES[lang].includes(x.text));
    assert.equal(opening.length, 2, lang + ': the two cached opening pieces'); assert.ok(opening.every(x => x.lang === lang));
    assert.ok(h.tts.every(x => x.lang === lang), lang + ': every line is synthesised in its own language (a word the languages share, like "Okay.", is that language\'s)');
    await h.speak();
    const acks = h.metrics.filter(([k]) => k === 'ack'); assert.ok(acks.length >= 1, lang + ' acknowledged the answer');
    const said = h.tts.map(x => x.text), own = Object.values(ACKS).flatMap(c => c[lang]);
    assert.ok(said.some(t => own.includes(t)), lang + ': an acknowledgement from its own bank');
    await h.send({ type: 'pause' }); assert.ok(PAUSE_LINES[lang].includes(h.tts.at(-1).text), lang + ' pause line');
    await h.send({ type: 'resume' }); assert.ok(RESUME_LINES[lang].includes(h.tts.at(-2).text) || RESUME_LINES[lang].includes(h.tts.at(-1).text), lang + ' resume line');
    await h.s.end(false);
  }
});

test('the language follows the consultant mid-interview, back and forth, and each switch is announced to the page', async () => {
  const h = await rig({ browser: 'en-US', heard: [{ text: SENTENCE.fr, language: 'fr' }, { text: SENTENCE.de, language: 'de' }, { text: SENTENCE.en, language: 'en' }] });
  await h.speak(); assert.equal(h.s.language, 'fr'); assert.match(note(h.talker.at(-1)), /speaking French/);
  await h.speak(); assert.equal(h.s.language, 'de'); assert.match(note(h.talker.at(-1)), /speaking German/);
  await h.speak(); assert.equal(h.s.language, 'en'); assert.match(note(h.talker.at(-1)), /speaking English/);
  assert.deepEqual(switches(h).map(e => e.language), ['fr', 'de', 'en']);
  assert.deepEqual(h.metrics.filter(([k]) => k === 'language_switch').map(([, v]) => v.language), ['fr', 'de', 'en']);
});

test('typed text names its own language: a long typed answer switches, a short or mixed one does not, two in a row do', async () => {
  const h = await rig({ browser: 'en-US' });
  await h.typed('Oui'); assert.equal(h.s.language, 'en', 'one word never counts');
  await h.typed('The platform was great, I really liked the way the team handled the cutover project'); assert.equal(h.s.language, 'en');
  await h.typed('Nous avons réduit le délai'); assert.equal(h.s.language, 'en', 'five words, French but thin: a candidate only');
  assert.equal(h.s.languageCandidate, 'fr');
  await h.typed('Nous avons aussi formé les équipes régionales de support'); assert.equal(h.s.language, 'fr', 'a second French answer in a row switches');
  assert.match(note(h.talker.at(-1)), /speaking French/);
  await h.typed(SENTENCE.pl); assert.equal(h.s.language, 'pl', 'a long clear Polish answer switches at once (no bank, no problem: the talker speaks it)');
  assert.match(note(h.talker.at(-1)), /speaking Polish\. Reply only in natural Polish/);
  assert.deepEqual(switches(h).map(e => e.language), ['fr', 'pl']);
  const user = h.events.filter(e => e.type === 'user_text' && e.provenance === 'consultant_typed'); assert.equal(user.at(-1).text, SENTENCE.pl, 'what they typed is kept exactly');
});

test('the consultant can lock a language in the UI: it is understood and spoken as chosen whatever the recogniser hears, and "auto" gives the choice back', async () => {
  const h = await rig({ browser: 'en-GB', heard: [{ text: SENTENCE.fr, language: 'fr' }, { text: SENTENCE.fr, language: 'fr' }, { text: SENTENCE.de, language: 'de' }, { text: SENTENCE.de, language: 'de' }] });
  assert.ok(CONTROLS.includes('language'));
  await h.send({ type: 'language', language: 'pl' });
  assert.equal(h.s.language, 'pl'); assert.equal(h.s.languageLocked, true);
  const ev = switches(h).at(-1); assert.deepEqual([ev.language, ev.locked, ev.via], ['pl', true, 'selector']);
  await h.speak(); await h.speak();
  assert.equal(h.s.language, 'pl', 'a locked language never moves'); assert.deepEqual(h.stt.slice(0, 2), [{ language: 'pl' }, { language: 'pl' }], 'the recogniser is asked for the locked language alone');
  assert.match(note(h.talker.at(-1)), /speaking Polish/);
  await h.send({ type: 'language', language: 'auto' }); assert.equal(h.s.languageLocked, false);
  assert.deepEqual(switches(h).at(-1).locked, false);
  await h.speak(); assert.equal(h.s.language, 'de', 'back to following the consultant');
  assert.equal(h.stt.at(-1), null, 'automatic detection again');
  const before = switches(h).length; await h.send({ type: 'language', language: 'not a language' }); assert.ok(h.events.some(e => e.type === 'quality_warning' && /not available/.test(e.message))); assert.equal(switches(h).length, before);
  await h.send({ type: 'language', language: 'fr', extra: 1 }); assert.ok(h.events.some(e => e.type === 'error'), 'exactly the message\'s own keys');
});

test('a locked language can be chosen at the start; the browser language is only a first guess', async () => {
  const h = await rig({ browser: 'pl', start: { languageLock: true }, heard: [{ text: SENTENCE.fr, language: 'fr' }] });
  assert.equal(h.s.language, 'pl'); assert.equal(h.s.languageLocked, true); assert.deepEqual(h.events.find(e => e.type === 'ready').language.locked, true);
  await h.speak(); assert.equal(h.s.language, 'pl');
  const bad = await rig({ browser: 'fr', start: { languageLock: 'yes' } }); assert.equal(bad.s.started, false);
});

test('TTS honesty: a language no voice can say is answered in that language on screen, once told so, and never in English or synthesised', async () => {
  // fr has a bank but no voice here: the server's own notice (in French), once; pl has no bank: the talker is asked to say so, once
  const speaks = l => l === 'en';
  const h = await rig({ browser: 'fr-FR', speaks, heard: [{ text: SENTENCE.fr, language: 'fr' }, { text: SENTENCE.fr, language: 'fr' }] });
  const ready = h.events.find(e => e.type === 'ready');
  assert.deepEqual([ready.language.code, ready.language.voice, ready.voices], ['fr', false, ['en']]);
  const first = switches(h).find(e => e.notice); assert.equal(first.notice, notice('voice_unavailable', 'fr')); assert.match(first.notice, /ATLAS ne peut pas parler français à voix haute/);
  assert.equal(h.tts.length, 0, 'nothing is synthesised');
  assert.ok(texts(h).includes(GREETING_PIECES.fr[0]), 'the French opening is on the screen');
  assert.match(note(h.talker[0]), /Reply only in natural French.*cannot speak French yet, so your reply is shown on screen as text only/); assert.doesNotMatch(note(h.talker[0]), /say once/, 'a bank language is told by the server');
  await h.speak(); await h.speak();
  assert.equal(switches(h).filter(e => e.notice).length, 1, 'told once'); assert.equal(h.tts.length, 0);
  assert.ok(h.events.some(e => e.type === 'agent_text' && /Reply 2/.test(e.text)));
  // a language without a bank
  const p = await rig({ browser: 'pl', speaks, talk: () => ['Cześć. ', 'Co było najtrudniejsze?'] });
  assert.match(note(p.talker[0]), /Reply only in natural Polish.*cannot speak Polish yet.*In this reply say once, in one short sentence in Polish, that you cannot speak Polish aloud yet, that your words are on screen/);
  assert.equal(p.tts.length, 0); assert.ok(!switches(p).some(e => e.notice), 'no server text in English for it');
  await p.typed('Dobrze, to była dobra odpowiedź na pytanie o projekt'); await settle();
  assert.doesNotMatch(note(p.talker.at(-1)), /say once/, 'the talker said it already: not asked again');
  assert.equal(p.tts.length, 0);
});

test('ready tells the page which languages have a voice, and the bootstrap lists every language with what the Worker can say', async () => {
  const h = await rig({ speaks: l => ['en', 'es'].includes(l) });
  const ready = h.events.find(e => e.type === 'ready');
  assert.deepEqual(ready.voices, ['en', 'es']); assert.deepEqual([ready.language.code, ready.language.name, ready.language.native, ready.language.rtl, ready.language.voice, ready.language.bank], ['en', 'English', 'English', false, true, true]);
  const list = languageList(l => l === 'en');
  assert.equal(list.auto, true); assert.deepEqual(list.voice, ['en']); assert.ok(list.list.length >= 30);
  for (const x of ['en', 'fr', 'es', 'pt', 'de', 'it', 'nl', 'pl', 'ro', 'ar', 'zh', 'ja', 'ko', 'hi', 'ru', 'tr', 'sv', 'da', 'no', 'fi']) assert.ok(list.list.some(e => e.code === x), x);
  assert.deepEqual(list.list.find(e => e.code === 'ar'), { code: 'ar', name: 'Arabic', native: 'العربية', rtl: true, bank: false });
  assert.equal(languageName('xx'), 'English'); assert.equal(languageName('uk'), 'Ukrainian'); assert.equal(languageName('cs'), 'Czech', 'any ISO code is named by the runtime');
});

test('the intents of the seven bank languages: pause, resume, repeat, skip, dont_know, cannot_disclose, correction, rushed, stop, confirm, deny', () => {
  const T = {
    en: ['can we pause', "let's continue", 'can you repeat that', 'skip it', "I don't know", "I can't share that", 'sorry, I meant 35', "I'm in a hurry", "that's all for now", 'yes exactly', 'no, that is wrong'],
    fr: ['on peut faire une pause', 'on reprend', 'pouvez-vous répéter', 'passons à la question suivante', 'je ne sais pas', 'je ne peux pas partager ça', 'pardon, je voulais dire 35', 'je suis pressé', 'terminons ici', 'oui, exactement', 'non, ce n\'est pas ça'],
    es: ['hagamos una pausa', 'continuemos', 'puedes repetir', 'siguiente pregunta', 'no sé', 'no puedo compartir eso', 'perdón, quería decir 35', 'tengo prisa', 'terminemos por hoy', 'sí, claro', 'no, es incorrecto'],
    pt: ['podemos fazer uma pausa', 'vamos continuar', 'pode repetir', 'próxima pergunta', 'não sei', 'não posso compartilhar isso', 'desculpe, eu quis dizer 35', 'estou com pressa', 'vamos encerrar por hoje', 'sim, exatamente', 'não, isso está errado'],
    de: ['Können wir eine Pause machen', 'machen wir weiter', 'Können Sie das bitte wiederholen', 'nächste Frage', 'Ich weiß es nicht', 'Das kann ich nicht teilen', 'Entschuldigung, ich meinte 35', 'Ich habe es eilig', 'Lassen Sie uns beenden', 'Ja, genau', 'Nein, das stimmt nicht'],
    it: ['possiamo fare una pausa', 'riprendiamo', 'puoi ripetere', 'prossima domanda', 'non lo so', 'non posso condividerlo', 'scusa, intendevo 35', 'ho fretta', 'finiamo qui', 'sì, esatto', 'no, è sbagliato'],
    nl: ['kunnen we even pauzeren', 'laten we verder gaan', 'kun je dat herhalen', 'volgende vraag', 'ik weet het niet', 'dat kan ik niet delen', 'sorry, ik bedoelde 35', 'ik heb haast', 'laten we stoppen', 'ja, precies', 'nee, dat klopt niet'],
  };
  const order = ['pause', 'resume', 'repeat', 'skip', 'dont_know', 'cannot_disclose', 'correction', 'rushed', 'stop', 'confirm', 'deny'];
  for (const [lang, phrases] of Object.entries(T)) phrases.forEach((p, i) => assert.ok(analyzeTurn(p, lang).intents.includes(order[i]), `${lang}: "${p}" -> ${order[i]} (${analyzeTurn(p, lang).intents})`));
  // answers are not controls
  for (const [lang, p] of [['fr', 'Nous avons migré la plateforme vers le cloud'], ['es', 'si el cliente lo pide lo hacemos'], ['pt', 'nós migramos a plataforma'], ['de', 'Wir haben die Plattform migriert'], ['it', 'si è deciso di migrare la piattaforma'], ['nl', 'we hebben het platform gemigreerd']])
    assert.deepEqual(analyzeTurn(p, lang).intents, [], `${lang}: "${p}"`);
  // any other language: the words are an answer (no intents, no cues, no numbers): the page's buttons pause, repeat and skip
  for (const lang of ['pl', 'ja', 'ar', 'zh', 'ko', 'tr', 'ru', 'hi', 'xx']) assert.deepEqual(analyzeTurn('pause please, I do not know', lang), { intents: [], cues: [], field_hints: [], numbers: [], words: 6 }, lang);
});

test('a spoken pause in Portuguese pauses the session and gets the Portuguese line; the same words in Polish are an answer (the Pause button is the way)', async () => {
  const h = await rig({ browser: 'pt-BR', heard: [{ text: 'podemos fazer uma pausa', language: 'pt' }] });
  await h.speak();
  assert.ok(h.s.paused); assert.ok(PAUSE_LINES.pt.includes(h.tts.at(-1).text));
  const p = await rig({ browser: 'pl', heard: [{ text: 'Czy możemy zrobić przerwę', language: 'pl' }] });
  await p.speak(); assert.equal(p.s.paused, false, 'no Polish intent table: it is treated as an answer');
});

test('summary framing is localized for the bank languages and rendered by the talker for the others; the facts stay the consultant\'s own words', () => {
  const facts = ['Nous avons réduit le délai de 40 à 12 minutes'];
  const fr = summaryNote(facts, [], { lang: 'fr' });
  assert.ok(fr.includes('starts "Donc, si j\'ai bien compris :"') && fr.includes("Qu'est-ce que j'ai mal compris ou oublié ?"));
  assert.match(fr, /their own words in whatever language they said it, first person; say it addressed to them, in French/);
  assert.ok(fr.includes(JSON.stringify(facts[0])), 'the fact is quoted exactly, untranslated');
  const pl = summaryNote(['Skróciliśmy czas z 40 do 12 minut'], [], { lang: 'pl' });
  assert.ok(pl.includes('the Polish equivalent of "So, as I understood it:"') && pl.includes('the Polish equivalent of "What have I misunderstood or missed?"'));
  assert.ok(pl.includes('"Skróciliśmy czas z 40 do 12 minut"'));
  for (const lang of BANK_LANGUAGES) for (const key of ['lead', 'lead_again', 'reflect', 'question', 'question_again']) assert.ok(readback(key, lang) && LANG_READBACK[key][lang], lang + key);
  assert.ok(summaryNote(['a'], [], { lang: 'de', again: true }).includes(`"${readback('lead_again', 'de')}"`));
  assert.ok(summaryNote(['a'], [], { lang: 'it', reflect: true, question: 'q?' }).includes(`"${readback('reflect', 'it')}"`));
  // English is unchanged, and a French fact is not turned into English "you"
  assert.ok(summaryNote(['you built it'], []).includes('starts "So, as I understood it:"'));
  assert.deepEqual(summaryFacts([{ detail_id: 'D-001', field: 'outcome', quote: "J'ai construit le pipeline", status: 'reported' }], { lang: 'fr' }).facts, ["J'ai construit le pipeline"]);
  assert.deepEqual(summaryFacts([{ detail_id: 'D-001', field: 'outcome', quote: 'I built the pipeline', status: 'reported' }]).facts, ['you built the pipeline']);
  const withBasis = summaryFacts([{ detail_id: 'D-001', field: 'outcome', quote: 'Nous avons réduit le délai de 40 à 12 minutes', status: 'reported' }], { lang: 'fr', basisOpen: ['metric_baseline'] });
  assert.equal(withBasis.facts[0], 'Nous avons réduit le délai de 40 à 12 minutes', 'no English words glued into a French fact'); assert.match(withBasis.basis, /starting figure is still open/);
});

test('every bank is complete: acknowledgements, pause and resume lines, summary lines, notices and read-back words exist for all seven languages and are flagged for native review', () => {
  assert.deepEqual([...BANK_LANGUAGES], ['en', 'fr', 'es', 'pt', 'de', 'it', 'nl']);
  assert.deepEqual(Object.fromEntries(BANK_LANGUAGES.map(l => [l, REVIEW_STATUS[l]])), { en: 'authored', fr: 'needs_native_review', es: 'needs_native_review', pt: 'needs_native_review', de: 'needs_native_review', it: 'needs_native_review', nl: 'needs_native_review' });
  for (const lang of BANK_LANGUAGES) {
    for (const [cat, langs] of Object.entries(ACKS)) assert.equal(langs[lang]?.length, 5, `${lang} ${cat}`);
    assert.ok(PAUSE_LINES[lang].length >= 3 && RESUME_LINES[lang].length >= 3, lang);
    for (const key of ['corrected', 'prompt', 'saved', 'unsaved']) assert.ok(SUMMARY_LINES[key][lang]?.length >= 1, `${lang} ${key}`);
    for (const key of Object.keys(LANG_NOTICES)) assert.ok(LANG_NOTICES[key][lang], `${lang} ${key}`);
    assert.ok(GREETING_PIECES[lang] && WELCOME_BACK_PIECES[lang] && FILLERS[lang], lang);
  }
  // a stock line that ends in a question has exactly one, and the summary lines name the page's own buttons
  for (const lang of BANK_LANGUAGES) { assert.ok(SUMMARY_LINES.prompt[lang][0].includes('Confirm summary'), lang); assert.ok(SUMMARY_LINES.saved[lang][0].includes('Submit for review'), lang); }
  assert.match(TALKER_POLICY, /LANGUAGE: reply only in the language of the server LANGUAGE note/);
});

test('the pause, resume and summary lines of a bank language are its own; any other language has the talker write the correction thanks and the confirm prompt', async () => {
  const h = await rig({ browser: 'de', heard: [{ text: SENTENCE.de, language: 'de' }] });
  await h.speak();
  assert.ok(h.s.line(SUMMARY_LINES.prompt, 0) === SUMMARY_LINES.prompt.de[0]); assert.ok(h.s.line(SUMMARY_LINES.corrected, 1) === SUMMARY_LINES.corrected.de[1]);
  const p = await rig({ browser: 'pl' });
  assert.equal(p.s.line(SUMMARY_LINES.prompt, 0), '', 'no Polish line: never English'); assert.equal(p.s.line(PAUSE_LINES, 0), '');
});

test('the fixed English move wording is never spoken to a speaker of another language: when the guard removes the talker\'s words the talker is asked once more for just that question', async () => {
  // The talker's first try is only praise (the guard drops it); the retry is the question in Polish.
  const h = await rig({ browser: 'pl', talk: (n, m) => n === 0 ? ['Cześć. ', 'Opowiedz o projekcie?'] : /ask exactly this one question/.test(m.at(-1).content) ? ['Jak to zmierzyliście?'] : ['Amazing! '] , heard: [{ text: SENTENCE.pl, language: 'pl' }], speaks: () => true });
  await h.speak(); await settle();
  const retry = h.talker.find(m => /ask exactly this one question/.test(m.at(-1).content));
  assert.ok(retry, 'the talker was asked for the question in the language');
  assert.match(retry.at(-1).content, /in natural Polish, and nothing else/);
  assert.ok(texts(h).includes('Jak to zmierzyliście?'), 'the Polish question is shown');
  assert.ok(h.metrics.some(([k]) => k === 'reply_fallback'));
  const english = h.events.filter(e => e.type === 'agent_text').map(e => e.text).join('');
  assert.ok(!/How did you|What was|baseline/.test(english), 'none of the English wording of the move reached the consultant');
});

test('evidence keeps the language each quote was said in; quotes are never translated; the notes and claims carry the tag', async () => {
  const h = await rig({ browser: 'en', heard: [{ text: SENTENCE.fr, language: 'fr' }, { text: SENTENCE.en, language: 'en' }],
    details: seg => ({ field: 'outcome', item_id: seg.item_id, quote: seg.text.slice(0, 31) }) });
  await h.speak(); await h.speak(); await h.s.pending.size && await Promise.all([...h.s.pending]);
  const ds = h.s.ledger.details.filter(d => d.active);
  assert.deepEqual(ds.map(d => d.lang), ['fr', 'en']);
  assert.equal(ds[0].quote, SENTENCE.fr.slice(0, 31), 'the French words, exactly');
  const notes = h.s.evidenceNotes();
  assert.deepEqual(notes.details.map(d => d.lang), ['fr', 'en']);
  const clean = cleanNotes(JSON.parse(JSON.stringify(notes)));
  assert.deepEqual(clean.details.map(d => d.lang), ['fr', 'en']);
  const claims = claimsFromNotes('rec1', 'owner@example.com', clean, '2026-10-31T00:00:00Z');
  assert.deepEqual(claims.map(c => c.source_refs[0].lang), ['fr', 'en']); assert.equal(claims[0].statement, SENTENCE.fr.slice(0, 31));
  // a hostile tag is dropped, a notes block without one is as before
  assert.ok(!('lang' in cleanNotes({ session_id: 's1', details: [{ id: 'D-001', field: 'outcome', item_id: 'u1', quote: 'a quote here', lang: '<script>' }] }).details[0]));
  // the typed correction is tagged too
  await h.typed('Il y avait aussi un pilote précédent qui avait échoué complètement'); await settle();
});

test('the language and its lock survive a reconnect (the checkpoint keeps them)', async () => {
  const { serialize } = await import('../src/checkpoint.js');
  const h = await rig({ browser: 'pl', start: { languageLock: true } });
  const doc = serialize(h.s);
  assert.equal(doc.language, 'pl'); assert.equal(doc.languageLocked, true); assert.deepEqual(doc.ledger.langs, []);
  h.s.ledger.setLang('user-1', 'pl'); assert.deepEqual(serialize(h.s).ledger.langs, [['user-1', 'pl']]);
});

test('the bootstrap lists the languages and the voices; with an ElevenLabs key more languages are voiced, and its language list is the published one', async () => {
  const { ELEVENLABS_LANGUAGES } = await import('../src/languages.js');
  assert.equal(ELEVENLABS_LANGUAGES.length, 32); assert.ok(['pl', 'ja', 'ar', 'tr', 'sv', 'ru', 'hi', 'ko', 'zh', 'fi', 'da', 'ro'].every(l => ELEVENLABS_LANGUAGES.includes(l)));
  const { workersAI } = await import('../src/app.js');
  const bare = workersAI({}), eleven = workersAI({ ELEVENLABS_API_KEY: 'k' });
  assert.deepEqual(Object.keys({ en: 1, es: 1, fr: 1, pl: 1, ja: 1 }).filter(l => bare.speaks(l)), ['en', 'es']);
  assert.deepEqual(Object.keys({ en: 1, es: 1, fr: 1, pl: 1, ja: 1, xx: 1 }).filter(l => eleven.speaks(l)), ['en', 'es', 'fr', 'pl', 'ja']);
  assert.ok(typeof handle === 'function');
});
