// Language detection (src/lang-detect.js), parity with atlas_voice/languages.py detect() on test/lang.vectors.json, plus what the detector is for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detect } from '../src/lang-detect.js';

const V = JSON.parse(readFileSync(new URL('./lang.vectors.json', import.meta.url)));

test('lang-detect parity with Python on every recorded text', () => {
  assert.ok(V.length >= 80);
  for (const [[text], expected] of V) assert.deepEqual(detect(text), expected, String(text).slice(0, 60));
});

test('the detector names the language of a clear sentence in each of the twenty languages, and stays silent when the text is thin or mixed', () => {
  const want = { en: 'We moved the claims platform to the cloud last year and the team was happy with it', fr: 'Nous avons réduit le délai de traitement de quarante à douze minutes',
    es: 'Reducimos el tiempo de clasificación a doce minutos y el equipo quedó contento', pt: 'Nós reduzimos o tempo de triagem de quarenta para doze minutos', de: 'Wir haben die Bearbeitungszeit von vierzig auf zwölf Minuten reduziert',
    it: 'Abbiamo ridotto il tempo di smistamento da quaranta a dodici minuti', nl: 'We hebben de doorlooptijd van veertig naar twaalf minuten teruggebracht', pl: 'Skróciliśmy czas obsługi z czterdziestu do dwunastu minut i zespół był zadowolony',
    ro: 'Am redus timpul de procesare de la patruzeci la douăsprezece minute și echipa a fost foarte mulțumită de noua platformă', ar: 'قللنا وقت المعالجة من أربعين إلى اثنتي عشرة دقيقة', zh: '我们把处理时间从四十分钟缩短到十二分钟', ja: '処理時間を40分から12分に短縮しました',
    ko: '처리 시간을 40분에서 12분으로 줄였습니다', hi: 'हमने प्रसंस्करण का समय चालीस मिनट से घटाकर बारह मिनट कर दिया', ru: 'Мы сократили время обработки с сорока до двенадцати минут',
    tr: 'İşlem süresini kırk dakikadan on iki dakikaya düşürdük ve ekip çok memnun kaldı', sv: 'Vi minskade handläggningstiden från fyrtio till tolv minuter och teamet var nöjt',
    fi: 'Lyhensimme käsittelyaikaa neljästäkymmenestä kahteentoista minuuttiin ja tiimi oli tyytyväinen' };
  for (const [lang, text] of Object.entries(want)) assert.equal(detect(text).lang, lang, lang);
  // Danish and Norwegian share most of their words: with no telling word the detector declines instead of guessing; a telling word decides.
  assert.equal(detect('Vi reducerede sagsbehandlingstiden fra fyrre til tolv minutter og holdet var glad').lang, null);
  assert.equal(detect('Vi reduserte saksbehandlingstiden fra førti til tolv minutter. Hva var det som skjedde med meg, og noe ble bra').lang, 'no');
  assert.equal(detect('Oui').lang, null); assert.equal(detect('ok thanks').lang, null); assert.equal(detect('').lang, null); assert.equal(detect(null).lang, null);
  // One English word in a French answer is still French; a strong, long sentence is "strong", a short one is not.
  assert.equal(detect('Je pense que le client était content mais the platform was great').lang, 'fr');
  assert.equal(detect('Nous avons réduit le délai de traitement de quarante à douze minutes').strong, true);
  assert.equal(detect('ça va très bien').strong, false);
});

test('units: words for spaced scripts, characters / 2 for scripts written without spaces', () => {
  assert.equal(detect('Nous avons réduit le délai').units, 5);
  assert.ok(detect('処理時間を40分から12分に短縮しました').units >= 3);
  assert.ok(detect('我们把处理时间从四十分钟缩短到十二分钟').units >= 3);
});
