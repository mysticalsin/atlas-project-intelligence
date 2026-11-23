// One shared client-name matcher. No imports from review.js or scrub.js, so those files can both use it.
// Frequent English and French words (lower case). A client name of 3 or more characters is matched in every
// case, including a single word from this list. A name of 2 characters is matched only in its stored spelling
// and its upper-case spelling. A single-token contact that is one of these words is never matched.

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

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const pattern = alts => '(?<![\\p{L}\\p{N}])(?:' + alts.map(a => esc(a).replace(/\s+/g, '\\s+')).join('|') + ')(?![\\p{L}\\p{N}])';
export const nfc = s => String(s ?? '').normalize('NFC');
export const norm = s => nfc(s).replace(/\s+/g, ' ').trim();
const isStopWord = s => !/\s/.test(norm(s)) && STOPLIST.has(norm(s).toLowerCase());

// Non-overlapping spans from groups in priority order (an earlier group wins an overlap), replaced in one pass so a
// replacement is never matched again.
export function applySpans(text, groups, replace) {
  const taken = [];
  for (const group of groups) for (const s of group) if (!taken.some(t => s.start < t.end && t.start < s.end)) taken.push(s);
  taken.sort((a, b) => a.start - b.start);
  let out = '', at = 0;
  for (const s of taken) { out += text.slice(at, s.start) + replace(s); at = s.end; }
  return out + text.slice(at);
}
export const spansOf = (text, re, extra = {}) => re ? [...text.matchAll(re)].map(m => ({ start: m.index, end: m.index + m[0].length, text: m[0], ...extra })) : [];

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

// Matching rules: word-bounded, longest first. A name of 3 or more characters is case-insensitive as a whole word,
// including a single stoplist word. A name of 2 characters matches only its stored form and its upper-case form.
// With { contacts: true }, single-token contacts that are stoplist words or shorter than 3 characters are skipped.
// replace(match, storedName) -> string. The client name is not passed with { contacts: true }.
export function nameMatcher(names, { contacts = false } = {}) {
  // A letter or digit name shorter than 2 characters stays ignored. '[' and '\' are the length-1 literals the
  // metacharacter test requires, escaped below rather than compiled as regex syntax.
  const kept = [...new Set((names || []).map(norm).filter(n => n.length >= 2 || n === '[' || n === '\\'))]
    .filter(n => !contacts || /\s/.test(n) || (n.length >= 3 && !isStopWord(n)));
  const ci = kept.filter(n => n.length >= 3), ciSet = new Set(ci), cs = kept.filter(n => !ciSet.has(n));
  const ciGroup = nameGroup(ci.map(name => ({ name, forms: [name] })), 'iu');
  const csGroup = nameGroup(cs.map(name => ({ name, forms: [...new Set([name, name.toUpperCase()])] })), 'u');
  // Span offsets refer to the NFC form of the text (a no-op for the NFC text pseudonymise and recordText pass).
  const spans = text => { const s = nfc(text); return [ciGroup(s), csGroup(s)]; };
  const match = (text, replace = m => m) => typeof text === 'string' ? (s => applySpans(s, spans(s), x => replace(x.text, x.name)))(nfc(text)) : text;
  match.spans = spans;
  return match;
}

// Client name and location use the matcher with the contacts flag off. The full contact, and a contact lead that
// contains whitespace, use the contacts flag. The lead is computed by the caller (review.contactLead) so this file
// does not import review.js. Overlapping spans keep the longest.
export function maskOwnClient(client = {}, lead = '') {
  const c = client && typeof client === 'object' ? client : {};
  const own = nameMatcher([c.name, c.location]);
  const contactNames = [c.contact];
  if (typeof lead === 'string' && /\s/.test(lead)) contactNames.push(lead);
  const people = nameMatcher(contactNames, { contacts: true });
  return text => {
    if (typeof text !== 'string') return text;
    const s = nfc(text);
    const spans = [...own.spans(s).flat(), ...people.spans(s).flat()];
    spans.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const taken = [];
    for (const span of spans) if (!taken.some(t => span.start < t.end && t.start < span.end)) taken.push(span);
    taken.sort((a, b) => a.start - b.start);
    let out = '', at = 0;
    for (const span of taken) { out += s.slice(at, span.start) + 'the client'; at = span.end; }
    return out + s.slice(at);
  };
}
