// Confidentiality masking (WOW_SPEC §2.3): the one module that produces every text reaching complete, embed or
// JEV, and every rendering of masked text.
// (a) Text a user types is PSEUDONYMISED: declared prospects and library clients -> [Company n], library contacts
//     -> [Person n], emails / phones / URLs -> [Email n] / [Phone n] / [Link n]. The placeholder map stays
//     server-side; the author gets their own words back (unmask), everyone else uniform labels (forOthers).
// (b) Record text reaches a model only through recordView: the record's own client -> "the client" (review.js
//     forModel), every other library client -> "another client", contacts -> "a contact", PII -> [email] etc.
// Known limitation: abbreviations, subsidiaries, misspellings and lower-case spellings of short or common-word
// client names ("axa", "total") are not masked. A stoplist-word name opening a sentence is masked (safe side).
// Text and names are compared in Unicode NFC, so a decomposed accent (text pasted from some PDFs) matches its
// composed form. Compatibility forms (full-width letters, ligatures) are not folded: NFKC would rewrite the
// author's own text ("m²" -> "m2").
import { forModel, clientScrub, contactLead, bindStoplist } from './review.js';

// Frequent English and French words (lower case). A client name that is one of these words is matched only in its
// stored and upper-case forms; a single-token contact that is one of these words is never matched.
export const STOPLIST = new Set(`
a able about above access across act action actions active add after again against age ago agree ahead aim air all allow
almost alone along already also always am among amount an and angel another answer any anyone anything apple april are
area areas arm army around art as ask at august author authority available away back bad ball bank base basic be
bear beautiful because become bed been before began begin behind being believe below best better between beyond big
bill black blue board body book both box boy bread bridge bright bring brown build building business but buy by call
can capital car care carry case cause cell center central certain chance change charge check child choice circle city
class clear close code cold college color come common community company complete concern control cost could country
course court cover create credit cross current cut dark data date day dead deal dean dear death decide deep delta
design develop development did die different digital direct director do does doing done door down draw dream drive
drop during each early earth east easy eat edge education effect effort eight either else end energy enough enter
even evening event ever every evidence example experience expert express eye face fact fair faith fall family far farm
fast father fear feel few field fight figure fill final find fine fire first five focus follow food foot for force
form forward four frank free friend from front full fund future gain game general get girl give global go gold good
got government grace grant great green ground group grow guy had hair half hand happen hard has have he head health
hear heart heat help her here high him his history hold home hope hot hour house how however human hundred idea if
image important in include industry information inside instead interest international into is issue it its itself
job join joy june just keep key kind king know land language large last late later law lead leader learn least leave
left less let level life light like line list little live local long look lose loss lot love low machine main major
make man manage many march mark market matter may me mean media meet member mention might mind minute miss model
moment money month more morning most mother move much music must my name nation national natural near need network
never new news next nice night nine no none north not note nothing now number of off offer office often oil old on
once one only open or oracle orange order other our out over own page paper parent part party pass past pay peace
people per perhaps person phone pick picture piece pioneer pink place plan plant play point police policy poor
position possible power present president pressure pretty price prime private problem process produce product program
project provide public pull purple push put quality question quick quite race rain raise range rate rather ray reach
read ready real reason receive record red region remain remember report research rest result return right rise risk
river road rock role room rose royal rule run safe same save say school science sea season second security see seem
sell send sense series serve service services set seven several shall share she shell short should show side sign
silver simple since single sister site six size sky small smart so social society some someone something son soon
sort sound source south space speak special spring staff stage stand star start state stay steel step still stone
stop story street strong student study such summer summit sun support sure system systems table take talk target task
team tell ten term test than thank that the their them then there these they thing think third this those though
three through time to today together too top total toward town trade train tree true trust try turn two type under
union unit united until up upon us use value very view vision visit voice wait walk wall want war watch water way we
week well west what when where which while white who whole why wide wife will win window winter with within without
woman word work world would write year yellow yes yet you young your
à afin ainsi alors an année années après argent au aucun aussi autre autres aux avant avec avenir avoir bas beau bien
blanc bleu bon bonne ça car ce ceci cela celle celui centre ces cet cette chaque chez chose ciel client clients comme
comment crédit dans de depuis des deux devant doit donc dont du elle elles en encore entre est et étoile été être eux
fait faire femme fin fois force grand grande gris groupe haut homme ici il ils jaune je jour jours juste la le les
leur leurs lui ma mais marché même mer mes moins mon monde nord nos notre nous nouveau nouvelle ou où ouest par parce
pas pays peu peut place plus pour pourquoi premier première prix quand que quel quelle qui rien rose rouge sa sans se
ses si soleil son sont sous sud sur ta tard temps terre toi ton total totale tous tout toute toutes très trois tu un
une vert vie ville vos votre vous
`.trim().split(/\s+/));
bindStoplist(STOPLIST);

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = alts => '(?<![\\p{L}\\p{N}])(?:' + alts.map(a => esc(a).replace(/\s+/g, '\\s+')).join('|') + ')(?![\\p{L}\\p{N}])';
const nfc = s => String(s ?? '').normalize('NFC');
const norm = s => nfc(s).replace(/\s+/g, ' ').trim();
const isStopWord = s => !/\s/.test(norm(s)) && STOPLIST.has(norm(s).toLowerCase());

// Non-overlapping spans from groups in priority order (an earlier group wins an overlap), replaced in one pass so a
// replacement is never matched again.
function applySpans(text, groups, replace) {
  const taken = [];
  for (const group of groups) for (const s of group) if (!taken.some(t => s.start < t.end && t.start < s.end)) taken.push(s);
  taken.sort((a, b) => a.start - b.start);
  let out = '', at = 0;
  for (const s of taken) { out += text.slice(at, s.start) + replace(s); at = s.end; }
  return out + text.slice(at);
}
const spansOf = (text, re, extra = {}) => re ? [...text.matchAll(re)].map(m => ({ start: m.index, end: m.index + m[0].length, text: m[0], ...extra })) : [];

// PII: URLs (https?:// or www.), emails, phone numbers (7+ digits with + ( ) - . or spaces). Overlaps resolve to
// the longest span, so a URL carrying an email, or an email on a www. host, is masked whole. The email parts are
// bounded (RFC 5321 lengths): unbounded, every start position in a 60k token rescanned to its end (seconds of CPU).
const URL_RE = /(?:\bhttps?:\/\/|(?<![\p{L}\p{N}.])www\.)[^\s<>"'`]+/giu;
const EMAIL_RE = /[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}.-]{1,253}\.\p{L}{2,63}/gu;
const PHONE_RE = /(?<![\p{L}\p{N}])\+?\(?\d(?:[ \t\u00a0().-]{0,2}\d){6,}\)?(?![\p{L}\p{N}])/gu;
const ISO_DATE = /^(?:19|20)\d\d-\d\d-\d\d$|^(?:19|20)\d\d\s?[-–]\s?(?:19|20)\d\d$/;
function piiSpans(text) {
  const url = spansOf(text, URL_RE, { kind: 'Link' }).map(s => { const t = s.text.replace(/[.,;:!?)\]}]+$/, ''); return { ...s, text: t, end: s.start + t.length }; });
  const mail = spansOf(text, EMAIL_RE, { kind: 'Email' });
  const phone = spansOf(text, PHONE_RE, { kind: 'Phone' }).filter(s => (s.text.match(/\d/g) || []).length >= 7 && !ISO_DATE.test(s.text.trim()));
  return [...url, ...mail, ...phone].sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
}

// One case group of names, matched with the semantics of the global regex (?<![\p{L}\p{N}])(?:n1|n2|…)(?![\p{L}\p{N}])
// over names sorted longest first, without one giant alternation (5,000 names over a 60k brief took ~27 s that way).
// Names are indexed by their first word; the text is scanned word by word, and only candidates sharing that word are
// tried, each with its own sticky regex. The rare names that do not start with a letter or digit use one small regex.
const WORD = /[\p{L}\p{N}]+/gu;
function nameGroup(entries, flags) {
  const byFirst = new Map(), odd = [];
  for (const { name, forms } of entries.sort((a, b) => b.name.length - a.name.length)) {
    const firsts = forms.map(f => /^[\p{L}\p{N}]+/u.exec(f)?.[0]);
    if (firsts.some(f => !f)) { odd.push({ name, forms }); continue; }
    const re = new RegExp('(?:' + forms.sort((a, b) => b.length - a.length).map(f => esc(f).replace(/\s+/g, '\\s+')).join('|') + ')(?![\\p{L}\\p{N}])', flags + 'y');
    for (const k of new Set(firsts.map(f => f.toLowerCase()))) { if (!byFirst.has(k)) byFirst.set(k, []); byFirst.get(k).push({ name, re }); }
  }
  const oddForms = odd.flatMap(o => o.forms.map(f => [f, o.name])).sort((a, b) => b[0].length - a[0].length), oddName = new Map(oddForms.map(([f, n]) => [flags.includes('i') ? f.toLowerCase() : f, n]));
  const oddRe = oddForms.length ? new RegExp(pattern(oddForms.map(([f]) => f)), 'g' + flags) : null;
  return text => {
    const out = []; let pos = 0;
    for (const w of text.matchAll(WORD)) {
      if (w.index < pos) continue;
      for (const c of byFirst.get(w[0].toLowerCase()) || []) {
        c.re.lastIndex = w.index; const m = c.re.exec(text);
        if (m) { out.push({ start: w.index, end: w.index + m[0].length, text: m[0], name: c.name }); pos = w.index + m[0].length; break; }
      }
    }
    for (const x of spansOf(text, oddRe)) out.push({ ...x, name: oddName.get(flags.includes('i') ? norm(x.text).toLowerCase() : norm(x.text)) || norm(x.text) });
    return out;
  };
}

// Matching rules (§2.3): word-bounded, longest first; case-insensitive only for names of 5+ characters that are not
// a single stoplist word, otherwise the stored and upper-case forms only. With { contacts: true }, single-token
// contacts that are stoplist words or shorter than 3 characters are skipped. replace(match, storedName) -> string.
export function nameMatcher(names, { contacts = false } = {}) {
  const kept = [...new Set((names || []).map(norm).filter(n => n.length >= 2))]
    .filter(n => !contacts || /\s/.test(n) || (n.length >= 3 && !isStopWord(n)));
  const ci = kept.filter(n => n.length >= 5 && !isStopWord(n)), ciSet = new Set(ci), cs = kept.filter(n => !ciSet.has(n));
  const ciGroup = nameGroup(ci.map(name => ({ name, forms: [name] })), 'iu');
  const csGroup = nameGroup(cs.map(name => ({ name, forms: [...new Set([name, name.toUpperCase()])] })), 'u');
  // Span offsets refer to the NFC form of the text (a no-op for the NFC text pseudonymise and recordText pass).
  const spans = text => { const s = nfc(text); return [ciGroup(s), csGroup(s)]; };
  const match = (text, replace = m => m) => typeof text === 'string' ? (s => applySpans(s, spans(s), x => replace(x.text, x.name)))(nfc(text)) : text;
  match.spans = spans;
  return match;
}

// Client names and contacts of every refs row, merged rows included; trimmed, length >= 2, deduped, longest first.
// A contact typed as "Jane Doe (Head of Claims)" also registers its leading name "Jane Doe" (review.contactLead);
// nameMatcher's contact rules then apply to it. Cached per Library instance, recompiled when the refs table changes.
const cache = new WeakMap();
function compiled(lib) {
  const k = lib.rows('SELECT COUNT(*) AS n, MAX(updated_at) AS u, SUM(revision) AS r FROM refs')[0] || {}, sig = `${k.n}|${k.u}|${k.r}`;
  const hit = cache.get(lib);
  if (hit && hit.sig === sig) return hit;
  const clients = new Set(), contacts = new Set();
  for (const r of lib.rows('SELECT data FROM refs')) {
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    const name = norm(d?.client?.name || ''), contact = norm(d?.client?.contact || '');
    if (name.length >= 2) clients.add(name);
    for (const c of [contact, contactLead(contact)]) if (c.length >= 2) contacts.add(c);
  }
  const longest = s => [...s].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const names = { clients: longest(clients), contacts: longest(contacts) };
  const entry = { sig, names, clients: nameMatcher(names.clients), contacts: nameMatcher(names.contacts, { contacts: true }) };
  cache.set(lib, entry);
  return entry;
}
export function libraryNames(lib) { const n = compiled(lib).names; return { clients: [...n.clients], contacts: [...n.contacts] }; }

const PLACEHOLDER = /\[(company|person|email|phone|link)\s+(\d+)\]/gi;
const TYPED = /\[(company|person|email|phone|link)(\s+\d+)?\]/gi;
const LABEL = { company: '[company]', person: '[person]', email: '[contact]', phone: '[contact]', link: '[contact]' };
const cap = t => t[0].toUpperCase() + t.slice(1).toLowerCase();
const deep = (v, f) => typeof v === 'string' ? f(v) : Array.isArray(v) ? v.map(x => deep(x, f))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, f)])) : v;

// User text -> placeholder form plus the (extended) map. Typed look-alikes of placeholders lose their brackets first,
// so nobody can type the masked form of a name and compare results. Identical spans share one placeholder. Spans
// are compared EXACTLY (not case-insensitively as §2.3 words it) and stored as typed, so unmask gives the author back
// every spelling unchanged: a case-folded round trip ("ZEBRACORP" shown as "Zebracorp") would be a visible trace of
// library membership, which ground rule 5 forbids. For the same reason every span gets a numbered placeholder, however
// large the map: a uniform-label fallback past a cap (the §2.3 "200 entries") cannot be unmasked, so the author would
// see "[company]" exactly for library names. Maps stay bounded by the callers' input limits; lookups are indexed.
export function pseudonymise(lib, text, { prospects = [], map = {} } = {}) {
  const out = { ...(map && typeof map === 'object' ? map : {}) }, src = nfc(text).replace(TYPED, m => m.slice(1, -1));
  const declared = [...new Set((Array.isArray(prospects) ? prospects : []).map(p => norm(String(p ?? ''))).filter(p => p.length >= 2))].sort((a, b) => b.length - a.length);
  const prospectRe = declared.length ? new RegExp(pattern(declared), 'giu') : null;
  const m = lib ? compiled(lib) : null, [cci, ccs] = m ? m.clients.spans(src) : [[], []], [pci, pcs] = m ? m.contacts.spans(src) : [[], []];
  const typed = (spans, kind) => spans.map(s => ({ ...s, kind }));
  const groups = [piiSpans(src), typed(spansOf(src, prospectRe), 'Company'), typed(cci, 'Company'), typed(ccs, 'Company'), typed(pci, 'Person'), typed(pcs, 'Person')];
  // Index of the incoming map, built once: kind + text -> first placeholder, and the highest number per kind.
  const byText = new Map(), last = {};
  for (const [p, t] of Object.entries(out)) {
    const k = /^\[([A-Za-z]+) (\d+)\]$/.exec(p);
    if (!k) continue;
    if (!byText.has(k[1] + '\n' + t)) byText.set(k[1] + '\n' + t, p);
    last[k[1]] = Math.max(last[k[1]] || 0, Number(k[2]));
  }
  const placeholder = s => {
    const key = s.kind + '\n' + s.text;
    if (!byText.has(key)) { const p = `[${s.kind} ${last[s.kind] = (last[s.kind] || 0) + 1}]`; out[p] = s.text; byText.set(key, p); }
    return byText.get(key);
  };
  return { text: applySpans(src, groups, placeholder), map: out };
}

// Deep over strings: placeholders in the map become the author's own words; any other placeholder its uniform label.
export function unmask(value, map) {
  const m = map && typeof map === 'object' ? map : {};
  return deep(value, s => s.replace(PLACEHOLDER, (all, t, n) => { const p = `[${cap(t)} ${n}]`; return Object.hasOwn(m, p) ? m[p] : LABEL[t.toLowerCase()]; }));
}
// Deep: one uniform label per kind, whether the span was a prospect or a library name.
export function forOthers(value) { return deep(value, s => s.replace(PLACEHOLDER, (all, t) => LABEL[t.toLowerCase()])); }

// What the author may see of the masking: declared prospects and contact details only. Library names are NEVER
// applied here (that would reveal library membership).
export function maskedPreview(text, prospects = []) {
  const src = nfc(text), declared = [...new Set((Array.isArray(prospects) ? prospects : []).map(p => norm(String(p ?? ''))).filter(p => p.length >= 2))].sort((a, b) => b.length - a.length);
  const re = declared.length ? new RegExp(pattern(declared), 'giu') : null;
  return applySpans(src, [piiSpans(src), spansOf(src, re, { kind: 'prospect' })], s => s.kind === 'prospect' ? '[prospect]' : '[contact]');
}

// Merges before WOW_ZERO_CONFIG §5.9 wrote "Contribution by <name or email>:" into a stored answer. Every record path
// to a model (recordView, snippets) passes recordText, so the legacy prefix loses the person here.
const LEGACY_MERGE = /(^|\n)[ \t]*Contribution by [^\n:]{1,200}:[ \t]*/g;
// Record masking for anything built from a record: other library clients, contacts and PII.
// authorText (author views only): the text this author sent to the model, in placeholder form. A client or contact
// span that text already carried to the model (case-insensitive, word-bounded) stays as the model wrote it: the
// author's "orange juice" echoed as "Orange juice" must not come back as "another client juice", a visible trace of
// library membership (§2.3 display rule). PII is always masked. Other views omit it and get the full masking.
export function recordText(lib, { authorText } = {}) {
  const m = compiled(lib), said = saidIn(authorText), keep = x => !said(x.text);
  return s => {
    if (typeof s !== 'string') return s;
    s = nfc(s).replace(LEGACY_MERGE, '$1Contribution by another consultant: ');
    const [cci, ccs] = m.clients.spans(s), [pci, pcs] = m.contacts.spans(s);
    const tag = { Email: '[email]', Phone: '[phone]', Link: '[link]' };
    return applySpans(s, [piiSpans(s), cci.filter(keep), ccs.filter(keep), pci.filter(keep).map(x => ({ ...x, contact: true })), pcs.filter(keep).map(x => ({ ...x, contact: true }))],
      x => x.kind ? tag[x.kind] : x.contact ? 'a contact' : 'another client');
  };
}
const fold = s => norm(s).toLowerCase();
function saidIn(text) {
  if (typeof text !== 'string' || !text.trim()) return () => false;
  const own = fold(text), seen = new Map();
  return span => { const k = fold(span); if (!seen.has(k)) seen.set(k, new RegExp(pattern([k]), 'u').test(own)); return seen.get(k); };
}
// Emails, phones and URLs only -> [email] / [phone] / [link]. It runs BEFORE the own-client scrub, which would
// otherwise rewrite a client name inside an address ("ops@acme.example" -> "ops@the client.example") and break it.
const PII_TAG = { Email: '[email]', Phone: '[phone]', Link: '[link]' };
export function piiText(s) { return typeof s === 'string' ? (t => applySpans(t, [piiSpans(t)], x => PII_TAG[x.kind]))(nfc(s)) : s; }
// The model's copy of a record: PII first, then forModel (own client -> "the client", from the untouched client
// fields), then recordText on every string.
export function recordView(lib, data) { return deep(forModel({ ...deep(data, piiText), client: data?.client }), recordText(lib)); }

// ---- Helpers added in T1 steps 1-4 (beyond the fixed §6.3 names) ----
// Deep recordText over a model output (placeholders untouched): what the proof engine stores.
export function recordMask(lib, { authorText } = {}) { const text = recordText(lib, { authorText }); return value => deep(value, text); }
// The display rule for a model output shown to the author of the text it came from (§2.3): recordText catches any
// real client name the model produced itself, then unmask restores only the author's own words. Pass the
// placeholder-form text the model received as authorText (see recordText).
export function forAuthor(lib, map, { authorText } = {}) { const mask = recordMask(lib, { authorText }); return value => unmask(mask(value), map); }
// The cached library-client matcher, i.e. nameMatcher(libraryNames(lib).clients) without recompiling (F6 filter).
export function clientMatcher(lib) { return compiled(lib).clients; }
// SafeSummary (§F1.2): Library.summary for the new endpoints. Without full access the owner email and client are
// empty and the title, headline and tags go through the record masking, so a public reader never gets an '@' or
// a client name. Library.summary itself is unchanged (pre-existing list() behaviour, Q7).
export function safeSummary(lib, row, level, user) {
  const s = lib.summary(row, level, user);
  if (level === 'full') return s;
  const own = clientScrub(row.data), other = recordText(lib), mask = v => deep(v, x => other(own(piiText(x))));
  return { ...s, owner: '', client: '', title: mask(s.title), headline: mask(s.headline), practice: mask(s.practice), industry: mask(s.industry),
    serviceLines: mask(s.serviceLines), technologies: mask(s.technologies) };
}

