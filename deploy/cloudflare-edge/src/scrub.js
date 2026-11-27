// Confidentiality masking (WOW_SPEC §2.3): the one module that produces every text reaching complete, embed or
// JEV, and every rendering of masked text.
// (a) Text a user types is PSEUDONYMISED: declared prospects and library clients -> [Company n], library contacts
//     -> [Person n], emails / phones / URLs -> [Email n] / [Phone n] / [Link n]. The placeholder map stays
//     server-side; the author gets their own words back (unmask), everyone else uniform labels (forOthers).
// (b) Record text reaches a model only through recordView: the record's own client -> "the client" (review.js
//     forModel), every other library client -> "another client", contacts -> "a contact", PII -> [email] etc.
// Known limitation: abbreviations, subsidiaries and misspellings are not masked. A client name of 2 characters
// is matched only in its stored spelling and its upper-case spelling. A single-token stoplist contact is not
// masked. A client name of 3 or more characters, including a single stoplist word, is masked in every case.
// Text and names are compared in Unicode NFC, so a decomposed accent (text pasted from some PDFs) matches its
// composed form. Compatibility forms (full-width letters, ligatures) are not folded: NFKC would rewrite the
// author's own text ("m²" -> "m2").
import { forModel, clientScrub, contactLead } from './review.js';
import { applySpans, nameMatcher, nfc, norm, pattern, spansOf } from './name-match.js';
export { STOPLIST, nameMatcher } from './name-match.js';

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

