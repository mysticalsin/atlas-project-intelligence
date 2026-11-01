// JavaScript port of atlas_voice/speech.py EnergyTurns, sentences, Phrases, speakable, ReplyGuard and wav_bytes (parity-tested).
import { DIGIT_ZEROS, NUMBER_WORDS, NUMBER_CONNECTORS, UNVERIFIED_CLAIM_SRC, CLAIM_HEDGE_SRC, CLAIM_TERMS, HEDGE_TERMS, PERCENT_WORDS } from './policy.generated.js';
import { fold, plain } from './textfold.js';
export const SAMPLE_RATE = 24000;

export function rms(bytes) {
  const n = bytes.length >> 1;
  if (!n) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = view.getInt16(i * 2, true); sum += s * s; }
  return Math.sqrt(sum / n) / 32768;
}

const concat = (a, b) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

export class EnergyTurns {
  constructor(endSilence = 1.1, minSpeech = 0.30, maxSeconds = 90) {
    this.floor = 0.004; this.active = false; this.loud = 0; this.quiet = 0; this.spoken = 0;
    this.buffer = new Uint8Array(0); this.pre = new Uint8Array(0);
    this.endSilence = endSilence; this.minSpeech = minSpeech; this.maxBytes = Math.floor(maxSeconds * SAMPLE_RATE * 2);
  }

  // Returns [started, utteranceOrNull]. Same rules as the Python EnergyTurns.
  feed(pcm, agentSpeaking = false) {
    const seconds = pcm.length / (2 * SAMPLE_RATE), level = rms(pcm);
    const threshold = Math.max(0.012, this.floor * 3.2) * (agentSpeaking ? 4.0 : 1.0);
    let started = false, done = null;
    if (!this.active) {
      if (level < threshold) this.floor = this.floor * 0.97 + Math.min(level, 0.05) * 0.03;
      const pre = concat(this.pre, pcm), keep = Math.floor(0.3 * SAMPLE_RATE * 2);
      this.pre = pre.length > keep ? pre.slice(pre.length - keep) : pre;
      this.loud = level > threshold ? this.loud + seconds : 0;
      // While ATLAS is audible, a barge-in needs 450 ms of sustained loud speech, not a blip or echo.
      if (this.loud >= (agentSpeaking ? 0.45 : 0.08)) { this.active = true; started = true; this.buffer = this.pre.slice(); this.quiet = 0; this.spoken = 0; }
    } else {
      this.buffer = concat(this.buffer, pcm);
      this.spoken += seconds;
      this.quiet = level < threshold * 0.7 ? this.quiet + seconds : 0;
      if ((this.quiet >= this.endSilence && this.spoken >= this.minSpeech) || this.buffer.length >= this.maxBytes) {
        done = this.buffer; this.active = false; this.loud = 0; this.pre = new Uint8Array(0); this.buffer = new Uint8Array(0);
      }
    }
    return [started, done];
  }

  // End the current utterance now (semantic end-of-turn said the consultant has finished). Null when idle.
  flush() {
    if (!this.active || !this.buffer.length) return null;
    const done = this.buffer; this.active = false; this.loud = 0; this.pre = new Uint8Array(0); this.buffer = new Uint8Array(0); this.quiet = 0;
    return done;
  }
}

// 24 kHz PCM16 -> 16 kHz PCM16, the rate turn-detection models expect. Band-limited: a windowed-sinc low-pass at 7.2 kHz
// (below the new 8 kHz limit) evaluated at each output position, 1.5 input samples apart (so two kernel phases). Plain
// interpolation would fold 8-12 kHz into the speech band.
const FIR_HALF = 24, FIR_CUTOFF = 7200 / SAMPLE_RATE;
function firPhase(frac) {
  const taps = [];
  for (let j = 1 - FIR_HALF; j <= FIR_HALF; j++) {
    const t = j - frac, x = 2 * FIR_CUTOFF * t, window = 0.54 + 0.46 * Math.cos(Math.PI * t / FIR_HALF);
    taps.push((x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * window);
  }
  const sum = taps.reduce((a, b) => a + b, 0);
  return Float64Array.from(taps, v => v / sum); // unity gain at DC
}
const FIR = [firPhase(0), firPhase(0.5)];
export function to16k(pcm) {
  const n = pcm.length >> 1, view = new DataView(pcm.buffer, pcm.byteOffset, n * 2), src = new Float64Array(n);
  for (let i = 0; i < n; i++) src[i] = view.getInt16(i * 2, true);
  const m = Math.floor(n * 2 / 3), out = new Uint8Array(m * 2), dst = new DataView(out.buffer);
  for (let i = 0; i < m; i++) {
    const a = (i * 3) >> 1, taps = FIR[i & 1]; // input position 1.5 i = a + (0 or 0.5)
    let y = 0;
    for (let j = 1 - FIR_HALF, k = 0; j <= FIR_HALF; j++, k++) y += taps[k] * src[Math.min(n - 1, Math.max(0, a + j))];
    dst.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(y))), true);
  }
  return out;
}

export function isEcho(text, recentAgentText) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_']+/gu) || [], agent = new Set(recentAgentText.toLowerCase().match(/[\p{L}\p{N}_']+/gu) || []); // any script
  if (words.length < 3 || !agent.size) return false;
  return words.filter(w => agent.has(w)).length / words.length >= 0.7;
}

// A sentence end: . ! ? or the Arabic question mark (then any closing quote, bracket or markdown) before whitespace, or a CJK or Devanagari stop.
const END = /([.!?\u061f]+)["'\u201d\u2019\u00bb)\]*_`]*(\s+)|[\u3002\uff01\uff1f\u0964]\s*/gu;
const ABBREVIATIONS = new Set('mr mrs ms dr prof st jr sr vs etc cf approx inc ltd corp dept mme mlle hr sra dott sig dhr mevr ca'.split(' '));
export const MIN_PIECE = 40; // characters: shorter sentences join the next piece, and the first clause goes early only from here
const CLAUSE = new RegExp(`^(.{${MIN_PIECE},}?[,;:\u2014\u2013])\\s+`, 'su');
const chars = s => [...s].length; // code points, as in Python

// [end, next] of each sentence end in text: text.slice(0, end) is finished and the next sentence starts at next.
function boundaries(text) {
  const cuts = []; let start = 0;
  for (const m of text.matchAll(END)) {
    const next = m.index + m[0].length;
    let end = m.index + 1;
    if (m[1] !== undefined) {
      end = next - m[2].length;
      if (!/[!?\u061f]/.test(m[1])) { // full stops only: maybe an initial, an abbreviation or a list number
        if (/^\p{Ll}/u.test(text.slice(next))) continue; // a lowercase word continues the sentence ("data... and", "etc. were")
        const before = text.slice(start, m.index);
        if (/^\s*[0-9]{1,2}$/.test(before)) continue; // "1." opens a list item
        if (m[1] === '.') {
          const token = /[\p{L}.]*$/u.exec(before)[0];
          if (token.split('.').every(part => chars(part) === 1) || ABBREVIATIONS.has(token.toLowerCase())) continue; // "A.I.", "e.g.", "U.S.", "J.", "Dr.", "vs."
        }
      }
    }
    cuts.push([end, next]); start = next;
  }
  return cuts;
}

export function sentences(buffer) {
  const done = []; let start = 0;
  for (const [end, next] of boundaries(buffer)) { if (buffer.slice(start, end).trim()) done.push(buffer.slice(start, end)); start = next; }
  return [done, buffer.slice(start)];
}

// Streaming reply text -> the pieces to synthesise, each an exact slice of the text (trimmed). The first piece goes as soon
// as it is a whole sentence, or a clause of MIN_PIECE characters, so ATLAS starts talking early. After it, a sentence
// shorter than MIN_PIECE joins the next one while more text is coming: the voice gets whole phrases with natural
// intonation instead of clipped fragments with a pause after each.
export class Phrases {
  constructor() { this.text = ''; this.first = true; }
  feed(delta) {
    this.text += delta;
    const out = []; let start = 0;
    for (const [end, next] of boundaries(this.text)) {
      const piece = this.text.slice(start, end).trim();
      if (this.first || !piece || chars(piece) >= MIN_PIECE) { if (piece) { out.push(piece); this.first = false; } start = next; }
    }
    if (this.first) { const m = CLAUSE.exec(this.text.slice(start)); if (m) { out.push(m[1].trim()); this.first = false; start += m[0].length; } }
    this.text = this.text.slice(start);
    return out;
  }
  flush() { const piece = this.text.trim(); this.text = ''; return piece ? [piece] : []; }
}

// What the voice says for a piece of reply text: markdown and list markers removed, whitespace collapsed (the on-screen
// text keeps them). Empty when nothing speakable is left.
export function speakable(text) {
  const t = text.replace(/^\s*(?:#{1,6}|[-*\u2022]|[0-9]{1,2}[.)])\s+/gmu, '').replace(/\*\*|__|[*`]/g, '').split(/\s+/).filter(Boolean).join(' ');
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

export const GUARD_MAX_WORDS = 45; // most words ATLAS says in one reply (v2.2 V1: the cap lands on a sentence end; a sentence that has begun is finished, never cut)
export const CAP_SLACK_WORDS = 25; // ...unless that one sentence runs on this far past the cap: then it is cut, at a clause when it has one, else at a word
const PRAISE_MAX_WORDS = 8; // a sentence this short that is only praise is dropped
const REACTION_MAX_WORDS = 12; // a leading sentence longer than this is an answer, not a reaction: the repeated-opener rule leaves it alone
export const DEFAULT_BANNED_PRAISE = '\\b(amazing|incredible|brilliant|awesome|fantastic)\\b'; // persona BANNED_PRAISE_SRC replaces it when wired
const TERMINAL = /[.!?\u061f\u3002\uff01\uff1f\u0964]+$/u, CLOSERS = /[\s"'\u201d\u2019\u00bb)\]*_`]+$/u;
const NUMBER = /[0-9]+(?:[.,][0-9]+)*/g, THOUSANDS = /^[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?$/;
const TRIM = /[\s,;:\u2014\u2013-]+$/u;
export const GUARD_STATS = ['dropped_after_question', 'dropped_praise', 'dropped_repeat_opener', 'capped_words', 'dropped_unknown_number', 'dropped_unverified_claim'];

// The words of a text: whitespace-separated tokens with a letter or digit (a dash or a bullet is not a word).
const words = text => text.split(/\s+/).filter(t => /[\p{L}\p{N}]/u.test(t));
// Lower case, apostrophes and punctuation removed, whitespace collapsed: how two reactions are compared.
const norm = text => text.toLowerCase().replace(/['\u2019]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).join(' ');
// A numeral in one form, so '35%' and '35', '1,200' and '1200', '3.50' and '3.5' are the same figure.
function numeral(token) {
  token = THOUSANDS.test(token) ? token.replaceAll(',', '') : token.replaceAll(',', '.');
  return token.includes('.') ? token.replace(/0+$/, '').replace(/\.$/, '') : token;
}
// Every figure of a text as a numeral, however it is written (speech.py figures; red L3): full-width digits fold to ASCII (NFKC), invisible format characters go, and
// spelled-out numbers become digits ("forty percent" -> "40 percent"). Magnitude words stay words, as "2 million" has always been the figure 2.
const L = '\\p{L}', NUM_ALT = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)).join('|');
const NUM_RUN = new RegExp(`(?<!${L})(?:${NUM_ALT})(?:(?:[\\s-]+(?:${NUMBER_CONNECTORS.join('|')})[\\s-]+|[\\s-]+)(?:${NUM_ALT}))*(?!${L})`, 'giu');
const FOLD = new RegExp(`(?<!${L})(${NUM_ALT})fold(?!${L})`, 'giu'), HALF = new RegExp(`(?<!${L})half(?!${L})`, 'giu');
const QUATRE_VINGT = new RegExp(`(?<!${L})quatre[\\s-]+vingts?(?!${L})`, 'giu');
function runValue(run) {
  const parts = run.toLowerCase().split(/[\s-]+/).filter(w => w && !NUMBER_CONNECTORS.includes(w));
  if (parts.length === 1 && parts[0] === 'one') return null; // a lone "one" is the pronoun
  let total = 0;
  for (const w of parts) { const v = NUMBER_WORDS[w] ?? 0; total = w === 'hundred' ? (total || 1) * v : total + v; }
  return total;
}
// A run of single-digit words ("four zero", "deux cinq") can also be read digit by digit: "40", "25". null when it is not such a run.
function digitReading(run) {
  const parts = run.toLowerCase().split(/[\s-]+/).filter(w => w && !NUMBER_CONNECTORS.includes(w));
  if (parts.length < 2 || parts.some(w => !(w in NUMBER_WORDS) || NUMBER_WORDS[w] > 9)) return null;
  return parseInt(parts.map(w => NUMBER_WORDS[w]).join(''), 10);
}
// Digits of other scripts (speech.py DIGIT_ZEROS) fold to ASCII, so a figure written in them is the same figure.
const DIGITS = new RegExp('[' + DIGIT_ZEROS.map(z => String.fromCharCode(z) + '-' + String.fromCharCode(z + 9)).join('') + ']', 'g');
const asciiDigits = text => text.replace(DIGITS, c => String(c.charCodeAt(0) - DIGIT_ZEROS.findLast(z => z <= c.charCodeAt(0))));
// Other ways to say a figure (red M10; speech.py): a roman numeral before a percent word, "a dozen", "a couple of million", a product ("4x4"), and the compound numerals of
// German and Dutch written as one word, which cannot be read here: such a word stands for an unknown figure ('?').
const ROMAN = new RegExp(`(?<!${L})([ivxlcdm]{2,8})(?=\\s*${PERCENT_WORDS}(?!${L}))`, 'gu'), ROMAN_VALID = /^m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;
const ROMAN_VALUES = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
const DOZEN = new RegExp(`(?<!${L})dozen(?!${L})`, 'gu'), COUPLE = new RegExp(`(?<!${L})couple(?=\\s+of\\s+(?:million|thousand|billion|hundred)(?!${L}))`, 'gu');
const PRODUCT = /(?<![0-9.,])([0-9]+)\s*[x\u00d7*]\s*([0-9]+)(?![0-9.,])/g;
const COMPOUND = new RegExp(`(?<!${L})${L}*(?:hundert|tausend|honderd|duizend)${L}*(?!${L})`, 'u');
function romanValue(s) {
  if (!s || !ROMAN_VALID.test(s)) return s;
  let total = 0;
  for (let i = 0; i < s.length; i++) { const v = ROMAN_VALUES[s[i]], n = i + 1 < s.length ? ROMAN_VALUES[s[i + 1]] : 0; total += n > v ? -v : v; }
  return ` ${total} `;
}
export function figures(text) {
  let t = asciiDigits(fold(String(text)));
  t = t.replace(QUATRE_VINGT, 'quatrevingt').replace(FOLD, (_, w) => ` ${runValue(w)} `).replace(HALF, ' 0.5 ');
  t = t.replace(ROMAN, (_, r) => romanValue(r)).replace(DOZEN, ' 12 ').replace(COUPLE, ' 2 ');
  const extra = COMPOUND.test(t) ? ['?'] : [], products = [...t.matchAll(PRODUCT)].map(m => String(parseInt(m[1], 10) * parseInt(m[2], 10)));
  const spelled = t.replace(NUM_RUN, run => { const v = runValue(run); if (v === null) return run; const d = digitReading(run); return d === null || d === v ? ` ${v} ` : ` ${v} ${d} `; });
  return [...(spelled.match(NUMBER) || []).map(numeral), ...products, ...extra];
}
// True when the text has a letter outside the Latin script (Cyrillic, Arabic, CJK, Greek ...): no number table exists for those languages, so a spelled-out figure in them
// cannot be read (red M10). Summary mode voices no sentence like that.
export const hasUncheckedScript = text => /(?!\p{Script=Latin})\p{L}/u.test(String(text).normalize('NFKC'));
// A sentence that says something was verified, approved or confirmed by someone, without a hedge or a denial (speech.py asserts_verification; red L3/L4/M10): the English
// source and the seven bank languages' term lists, matched on the accent-free folded text.
const LETTER = '\\p{L}', escapeRe = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function termsRe(terms) {
  const alts = terms.map(t => {
    const stem = t.endsWith('*');
    return plain(t.replace(/\*$/, '')).split(' ').map(escapeRe).join('[\\s-]+') + (stem ? `${LETTER}*` : `(?!${LETTER})`);
  });
  return new RegExp(`(?<!${LETTER})(?:${alts.join('|')})`, 'iu');
}
const CLAIM = new RegExp(UNVERIFIED_CLAIM_SRC, 'i'), HEDGE = new RegExp(CLAIM_HEDGE_SRC, 'i');
const CLAIMS = termsRe(Object.values(CLAIM_TERMS).flat()), HEDGES = termsRe(Object.values(HEDGE_TERMS).flat());
export function assertsVerification(text) { const t = plain(text).replaceAll('\u2019', "'"); return (CLAIM.test(t) || CLAIMS.test(t)) && !(HEDGE.test(t) || HEDGES.test(t)); }

// A finished sentence whose closing punctuation holds a question mark ('?', the full-width one or the Arabic one), quotes and markup aside.
function isQuestion(sentence) { const m = TERMINAL.exec(sentence.replace(CLOSERS, '')); return !!m && /[?\uff1f\u061f]/.test(m[0]); }
// The start of text up to its count-th word, trailing commas and dashes trimmed (an exact slice).
function firstWords(text, count) {
  if (count <= 0) return '';
  let seen = 0;
  for (const m of text.matchAll(/\S+/g)) if (/[\p{L}\p{N}]/u.test(m[0]) && ++seen >= count) return text.slice(0, m.index + m[0].length).replace(TRIM, '');
  return text;
}

// The start of text up to its count-th word, ended at the last clause mark (comma, semicolon, colon, dash) in its second half when it has one.
function clauseCut(text, count) {
  const head = firstWords(text, count), at = Math.max(...[',', ';', ':', '\u2014', '\u2013'].map(c => head.lastIndexOf(c)));
  return at >= Math.floor(head.length / 2) && at > 0 ? head.slice(0, at).replace(TRIM, '') : head;
}

// Streaming filter over the spoken pieces (Phrases) of one reply. It enforces the shape of a reply in code, whatever the
// model wrote: at most one question, no empty praise, no repeated reaction, a short reply, and (in summary mode) no number
// that is not one of the given facts. Same rules as the Python ReplyGuard.
//
// push(piece) returns the pieces to voice: exact slices of the piece (so the on-screen text can be cut at them), possibly
// trimmed or none. done turns true once the first question sentence has been reached (voiced or not) or the word cap has
// cut the reply; the caller then stops reading the model stream. stats counts each rule's drops, never text.
//
// Options: bannedPraise, a regex source (case-insensitive); recentOpeners, the leading reaction of the last replies (only the
// last 3 count); maxWords, null for no cap; summaryFacts, null, or the list of figures the reply may use (an empty list
// allows none): summary mode; allowStatus, true for a factual status line from the server (else a sentence that says something was verified or approved is dropped).
//
// A sentence is judged when its first piece arrives. A first clause already voiced is not taken back, and the rest of that
// sentence follows it (a dropped first clause drops the rest). Words are whitespace-separated: a language written without
// spaces is not capped.
export class ReplyGuard {
  constructor({ bannedPraise = null, recentOpeners = [], maxWords = GUARD_MAX_WORDS, summaryFacts = null, allowStatus = false } = {}) {
    this.praise = new RegExp(bannedPraise ?? DEFAULT_BANNED_PRAISE, 'i');
    this.openers = [...(recentOpeners || [])].slice(-3).map(norm).filter(Boolean);
    this.max = maxWords;
    this.allowed = summaryFacts == null ? null : new Set(summaryFacts.flatMap(f => figures(f)));
    this.allowStatus = !!allowStatus; // a factual status line from the server may say that something was approved
    this.counts = Object.fromEntries(GUARD_STATS.map(k => [k, 0]));
    this.spoken = 0; // words voiced so far
    this.open = null; // the sentence in progress when the last piece ended mid-sentence: 'voiced' or 'dropped'
    this.lead = true; // the next sentence that gets this far is the reply's leading one
    this.stop = null; // 'question' or 'cap'
    this.finish = false; // the cap was reached inside a sentence that is being finished
  }
  get done() { return this.stop !== null; }
  get stats() { return { ...this.counts }; }

  repeatsOpener(text) {
    const n = norm(text);
    return !!n && words(text).length <= REACTION_MAX_WORDS && this.openers.some(o => n === o || n.startsWith(o + ' ') || o.startsWith(n + ' '));
  }

  // [text to voice or '', whether the sentence is the first question]. Applies the rules to one sentence or clause.
  judge(text, ended, continuing) {
    const question = ended && isQuestion(text);
    if (continuing && this.open === 'dropped') return ['', question];
    if (!continuing && !question) {
      if (words(text).length <= PRAISE_MAX_WORDS && this.praise.test(text)) { this.counts.dropped_praise++; return ['', question]; }
      if (this.lead) {
        this.lead = false;
        if (this.repeatsOpener(text)) { this.counts.dropped_repeat_opener++; return ['', question]; }
      }
    }
    if (!question && !this.allowStatus && assertsVerification(text)) { this.counts.dropped_unverified_claim++; return ['', question]; }
    if (this.allowed && (hasUncheckedScript(text) || figures(text).some(m => !this.allowed.has(m)))) { this.counts.dropped_unknown_number++; return ['', question]; }
    if (this.max !== null) {
      const n = words(text).length;
      if (this.finish || n > this.max - this.spoken) {
        if (continuing || !this.spoken) {
          // A sentence already begun (or the reply's first one) is finished, never cut: the cap lands on its end. Only a sentence that
          // runs on far past the cap is cut, at a clause when it has one.
          if (!this.finish) { this.counts.capped_words++; this.finish = true; }
          const ceiling = this.max + CAP_SLACK_WORDS - this.spoken;
          if (n > ceiling) { this.stop = 'cap'; return [clauseCut(text, ceiling), false]; }
          if (ended) this.stop = 'cap';
          return [text, question];
        }
        this.counts.capped_words++; this.stop = 'cap';
        return ['', false]; // a sentence that does not fit whole is left out
      }
    }
    return [text, question];
  }

  push(piece) {
    piece = piece || '';
    const spans = []; let start = 0;
    for (const [end, next] of boundaries(piece + ' ')) { if (piece.slice(start, end).trim()) spans.push([start, Math.min(end, piece.length), true]); start = next; }
    if (piece.slice(start).trim()) spans.push([start, piece.length, false]);
    const runs = []; let last = -2;
    spans.forEach(([a, b, ended], i) => {
      while (a < b && /\s/u.test(piece[a])) a++;
      if (this.stop) { if (this.stop === 'question') this.counts.dropped_after_question++; return; }
      const [text, question] = this.judge(piece.slice(a, b).trim(), ended, i === 0 && this.open !== null);
      if (text) {
        b = a + text.length; this.spoken += words(text).length;
        if (last === i - 1) runs[runs.length - 1][1] = b; else runs.push([a, b]);
        last = i;
      }
      this.open = ended ? null : (text ? 'voiced' : 'dropped');
      if (question && !this.stop) this.stop = 'question';
    });
    return runs.map(([a, b]) => piece.slice(a, b));
  }
}

export function wav(pcm, rate = SAMPLE_RATE) {
  const header = new ArrayBuffer(44), v = new DataView(header), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  return concat(new Uint8Array(header), pcm);
}
