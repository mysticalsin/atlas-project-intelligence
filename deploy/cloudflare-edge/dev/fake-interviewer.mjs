// Offline stand-ins for the interview's two models, for the local edge (dev only; deterministic, no network, no provider):
//   fakeTalker(messages)  -> the reply text the real Session would stream from the talker model. It reads only what the server hands
//                            the talker (the LANGUAGE note, the NEXT MOVE note, the SUMMARY FACTS list, the instruction) and says it back.
//   fakeAnalyst(messages) -> the tool call the real analyst model would make: record_details with exact quotes from the new answer.
// Neither judges anything. The wording is plain on purpose; the real models replace them when the Worker is deployed.
import { LANGUAGES } from '../src/languages.js';
import { readback } from '../src/languages.js';

const CODE = Object.fromEntries(Object.entries(LANGUAGES).map(([code, name]) => [name, code]));
const json = s => { try { return JSON.parse(s); } catch { return ''; } };

// Fixed lines per language (stand-in wording for the offline demo, not a reviewed translation). h(x): the consultant's own words, quoted.
const L = {
  en: { open: 'To start, could you tell me about the project and what you were brought in to do? Take your time.', opp: 'First, what is the opportunity ID (Opp ID) for this project?', thinking: 'Take your time, I am listening.',
    ask: 'Could you give me one concrete example of that?', askHook: h => `You mentioned "${h}". Could you give me one concrete example of that?`, confirm: 'Did I hear that right?', move: 'Shall we move on from this point?', ext: 'We are at the planned time. Would you like to carry on for a few more minutes?',
    skip: 'No problem, we can leave that. What changed in practice once the new approach was in place?', confirmed: 'Thank you. It is saved as a private draft that only you can see, and goes nowhere until you press Submit for review.',
    prompt: 'Thank you. Press Confirm summary when you are ready: it saves a private draft only you can see, and nothing goes to a reviewer until you press Submit for review yourself.', corrected: 'Thank you, I have updated it.', close: 'Thank you for sharing all of this. I will prepare your report.' },
  fr: { open: 'Pour commencer, pouvez-vous me parler du projet et de ce pour quoi on vous a sollicité ? Prenez votre temps.', opp: "D'abord, quel est l'identifiant de l'opportunité (Opp ID) de ce projet ?", thinking: "Prenez votre temps, je vous écoute.",
    ask: "Pouvez-vous m'en dire un peu plus, avec un exemple concret ?", askHook: h => `Vous avez parlé de « ${h} ». Pouvez-vous m'en dire un peu plus, avec un exemple concret ?`, confirm: "Ai-je bien compris ?", move: 'On passe à autre chose ?', ext: 'Nous avons atteint le temps prévu. Voulez-vous continuer quelques minutes ?',
    skip: "Pas de souci, on laisse cela. Qu'est-ce qui a changé concrètement une fois la nouvelle approche en place ?", confirmed: "Merci. C'est enregistré comme brouillon privé que vous seul voyez, et rien ne part avant que vous n'appuyiez sur Soumettre pour relecture.",
    prompt: "Merci. Appuyez sur Confirmer le résumé quand vous êtes prêt : cela enregistre un brouillon privé que vous seul voyez, et rien ne part en relecture avant que vous n'appuyiez vous-même sur Soumettre.", corrected: "Merci, je l'ai mis à jour.", close: 'Merci pour tout ce partage. Je prépare votre rapport.' },
  es: { open: 'Para empezar, ¿puedes contarme sobre el proyecto y para qué te contrataron? Tómate tu tiempo.', opp: 'Primero, ¿cuál es el identificador de la oportunidad (Opp ID) de este proyecto?', thinking: 'Tómate tu tiempo, te escucho.',
    ask: '¿Puedes darme un ejemplo concreto de eso?', askHook: h => `Mencionaste «${h}». ¿Puedes darme un ejemplo concreto de eso?`, confirm: '¿Lo he entendido bien?', move: '¿Pasamos a otra cosa?', ext: 'Hemos llegado al tiempo previsto. ¿Quieres seguir unos minutos más?',
    skip: 'Sin problema, lo dejamos. ¿Qué cambió en la práctica cuando el nuevo enfoque estuvo en marcha?', confirmed: 'Gracias. Queda guardado como borrador privado que solo tú ves, y no va a ningún sitio hasta que pulses Enviar a revisión.',
    prompt: 'Gracias. Pulsa Confirmar resumen cuando estés listo: guarda un borrador privado que solo tú ves, y nada llega a un revisor hasta que pulses Enviar a revisión tú mismo.', corrected: 'Gracias, lo he actualizado.', close: 'Gracias por compartir todo esto. Preparo tu informe.' },
  pt: { open: 'Para começar, você pode me contar sobre o projeto e para que foi chamado? Fique à vontade.', opp: 'Primeiro, qual é o identificador da oportunidade (Opp ID) deste projeto?', thinking: 'Fique à vontade, estou ouvindo.',
    ask: 'Você pode me dar um exemplo concreto disso?', askHook: h => `Você mencionou «${h}». Você pode me dar um exemplo concreto disso?`, confirm: 'Entendi corretamente?', move: 'Vamos passar para outro ponto?', ext: 'Chegamos ao tempo previsto. Quer continuar mais alguns minutos?',
    skip: 'Sem problema, deixamos isso. O que mudou na prática quando a nova abordagem entrou em uso?', confirmed: 'Obrigada. Fica salvo como rascunho privado que só você vê, e não vai a lugar nenhum até você apertar Enviar para revisão.',
    prompt: 'Obrigada. Aperte Confirmar resumo quando estiver pronto: ele salva um rascunho privado que só você vê, e nada vai a um revisor até você apertar Enviar para revisão.', corrected: 'Obrigada, atualizei.', close: 'Obrigada por compartilhar tudo isso. Vou preparar seu relatório.' },
  de: { open: 'Zum Anfang: Können Sie mir von dem Projekt erzählen und wofür man Sie geholt hat? Lassen Sie sich Zeit.', opp: 'Zuerst: Wie lautet die Opportunity-ID (Opp ID) dieses Projekts?', thinking: 'Lassen Sie sich Zeit, ich höre zu.',
    ask: 'Können Sie mir dafür ein konkretes Beispiel geben?', askHook: h => `Sie haben „${h}“ erwähnt. Können Sie mir dafür ein konkretes Beispiel geben?`, confirm: 'Habe ich das richtig verstanden?', move: 'Sollen wir hier weitergehen?', ext: 'Die geplante Zeit ist um. Möchten Sie noch ein paar Minuten weitermachen?',
    skip: 'Kein Problem, das lassen wir. Was hat sich in der Praxis geändert, als der neue Ansatz lief?', confirmed: 'Danke. Es ist als privater Entwurf gespeichert, den nur Sie sehen, und geht nirgendwohin, bis Sie auf Zur Prüfung einreichen drücken.',
    prompt: 'Danke. Drücken Sie Zusammenfassung bestätigen, wenn Sie bereit sind: Das speichert einen privaten Entwurf, den nur Sie sehen, und nichts geht an einen Prüfer, bis Sie selbst auf Zur Prüfung einreichen drücken.', corrected: 'Danke, ich habe es angepasst.', close: 'Danke, dass Sie das alles geteilt haben. Ich bereite Ihren Bericht vor.' },
  it: { open: "Per cominciare, puoi parlarmi del progetto e di cosa ti era stato chiesto di fare? Prenditi il tuo tempo.", opp: "Prima di tutto, qual è l'ID dell'opportunità (Opp ID) di questo progetto?", thinking: 'Prenditi il tuo tempo, ti ascolto.',
    ask: 'Puoi farmi un esempio concreto?', askHook: h => `Hai parlato di «${h}». Puoi farmi un esempio concreto?`, confirm: "Ho capito bene?", move: 'Passiamo ad altro?', ext: 'Siamo al tempo previsto. Vuoi continuare ancora qualche minuto?',
    skip: "Nessun problema, lo lasciamo. Cosa è cambiato in pratica quando il nuovo approccio è entrato in uso?", confirmed: 'Grazie. È salvato come bozza privata che vedi solo tu, e non va da nessuna parte finché non premi Invia in revisione.',
    prompt: 'Grazie. Premi Conferma riepilogo quando sei pronto: salva una bozza privata che vedi solo tu, e nulla va a un revisore finché non premi tu stesso Invia in revisione.', corrected: "Grazie, l'ho aggiornato.", close: 'Grazie per aver condiviso tutto questo. Preparo il tuo rapporto.' },
  nl: { open: 'Om te beginnen: kun je me vertellen over het project en waarvoor je was ingehuurd? Neem de tijd.', opp: 'Eerst: wat is de opportunity-ID (Opp ID) van dit project?', thinking: 'Neem de tijd, ik luister.',
    ask: 'Kun je me daar één concreet voorbeeld van geven?', askHook: h => `Je noemde «${h}». Kun je me daar één concreet voorbeeld van geven?`, confirm: 'Heb ik dat goed begrepen?', move: 'Zullen we verdergaan?', ext: 'We zijn bij de geplande tijd. Wil je nog een paar minuten doorgaan?',
    skip: 'Geen probleem, dat laten we. Wat veranderde er in de praktijk toen de nieuwe aanpak liep?', confirmed: 'Dank je. Het is opgeslagen als privé-concept dat alleen jij ziet, en gaat nergens heen tot je op Ter beoordeling indienen drukt.',
    prompt: 'Dank je. Druk op Samenvatting bevestigen als je klaar bent: dat slaat een privé-concept op dat alleen jij ziet, en niets gaat naar een beoordelaar tot je zelf op Ter beoordeling indienen drukt.', corrected: 'Dank je, ik heb het aangepast.', close: 'Dank je voor het delen van dit alles. Ik bereid je rapport voor.' },
};

// The facts joined into one passage the read-back guard accepts (it caps a read-back at 90 words): as many whole facts as fit in 70.
const story = list => { let used = 0; return list.map(f => f.replace(/[\s.!?]+$/, '')).filter(f => (used += f.split(/\s+/).length) <= 70).join('; ') + (list.length ? '.' : ''); };

export function fakeTalker(messages) {
  const sys = messages.filter(m => m.role === 'system').map(m => String(m.content)), all = sys.join('\n');
  const lang = CODE[/the consultant is speaking ([A-Za-z]+)\./.exec(all)?.[1]] || 'en', t = L[lang] || L.en;
  const instruction = messages.at(-1)?.role === 'user' ? String(messages.at(-1).content) : '';
  const asked = /^\[Server: ask exactly this one question[^\]]*\]\s*(".*")\s*$/s.exec(instruction);
  if (asked) return json(asked[1]) || t.ask;
  if (instruction.startsWith('[Session start')) return /"oppId":\s*"[^"]/.test(messages.map(m => m.content).join('\n')) ? t.open : t.opp;
  if (instruction.startsWith('[Server: the consultant went quiet')) return t.thinking;
  if (instruction.startsWith('[Server: the consultant has nothing to add')) return t.prompt;
  if (instruction.startsWith('[Server: the consultant confirmed')) return /could not be saved/.test(instruction) ? 'Thank you. It could not be saved to the library, so nothing was filed.' : t.confirmed;
  if (instruction.startsWith('[Server: the consultant corrected')) return t.corrected + ' ' + readback('question_again', lang);
  if (instruction.startsWith('[Server: the consultant chose to skip')) return t.skip;
  if (instruction.startsWith('[Server: the time for this interview is up')) return t.close + ' [[END]]';
  const move = /NEXT MOVE \(server[^)]*\): kind: (\w+)[^]*?proposed wording: ("(?:[^"\\]|\\.)*")/.exec(all);
  const facts = key => [...new RegExp(key + ' \\(server[^:]*\\): ([^]*?)\\. (?:Say|Then)').exec(all)?.[1].matchAll(/\d+\) ("(?:[^"\\]|\\.)*")/g) || []].map(m => json(m[1])).filter(Boolean);
  const hook = json(/Refer to their words ("(?:[^"\\]|\\.)*")/.exec(all)?.[1] || '""');
  if (!move) return t.ask;
  const [, kind, wording] = move, say = json(wording) || t.ask;
  if (kind === 'summary') { const f = facts('SUMMARY FACTS'); return [readback('lead', lang), story(f), readback('question', lang)].filter(Boolean).join(' '); }
  if (kind === 'summary_again') return [readback('lead_again', lang), story(facts('SUMMARY CHANGES')), readback('question_again', lang)].filter(Boolean).join(' ');
  if (kind === 'reflect') return [readback('reflect', lang), story(facts('REFLECTION FACTS').slice(0, 2)), lang === 'en' ? say : t.confirm].filter(Boolean).join(' ');
  if (kind === 'close') return t.close + ' [[END]]';
  if (lang === 'en') return say; // the selector's own question, already addressed to them
  return kind === 'confirm_asr' ? t.confirm : kind === 'offer_move_on' ? t.move : kind === 'offer_extension' ? t.ext : hook ? t.askHook(hook) : t.ask;
}

// Which field a sentence of the answer belongs to, by plain keywords in the supported languages (a stand-in for a model's reading).
const RULES = [
  ['measurement', /(\d|measur|baseline|median|average|percent|mesur|moyenne|medi[dr]|promedio|gemessen|durchschnitt|misur|media |gemeten|gemiddeld)/i],
  ['outcome', /(dropp|reduc|improv|increas|fell|saved|result|went from|baisse|réduit|réduction|amélior|diminu|bajó|redujo|mejor|reduziu|melhor|gesenkt|verbessert|gesunken|ridott|migliorat|verbeterd|gedaald)/i],
  ['contribution', /(\bI (designed|built|led|owned|wrote|ran|created|proposed)|personally|my (role|part)|j'ai (conçu|construit|dirigé|piloté|créé|développé)|mon rôle|yo (diseñé|construí|lideré|creé)|mi (rol|parte)|eu (projetei|construí|liderei|criei)|ich (habe|entwarf|baute|leitete)|mein (beitrag|anteil)|io (ho|progettai|costruii)|ik (ontwierp|bouwde|leidde))/i],
  ['decision', /(decid|instead of|rather than|alternative|trade-?off|chose|plutôt que|décid|choisi|en lugar de|en vez de|em vez de|statt|entschieden|invece di|in plaats van|besloten)/i],
  ['adoption', /(adopt|used by|owner|handover|rolled out|utilis|déploy|usan|usam|nutz|übernommen|usano|gebruikt|overgenomen)/i],
  ['evidence', /(report|document|audit|ticket|slides|rapport|informe|relatório|bericht|rapporto|verslag)/i],
  ['problem', /(problem|slow|delay|bouncing|issue|struggl|manual|backlog|complain|probl[eè]me|lent|retard|lento|retraso|langsam|verzögerung|probleem|traag)/i],
  ['stakes', /(cost|risk|penalt|lost|coût|risque|perte|coste|riesgo|custo|risco|kosten|risiko|costo|rischio|risico)/i],
  ['intervention', /(built|designed|implemented|introduced|rebuilt|created|conçu|construit|mis en place|diseñ|implement|constru|gebaut|eingeführt|costru|introdotto|gebouwd|ingevoerd)/i],
];
const ORDER = ['problem', 'intervention', 'contribution', 'outcome', 'measurement', 'decision', 'adoption', 'evidence', 'limitations', 'customer_fit', 'poor_fit', 'stakes'];

export function fakeAnalyst(messages) {
  const context = json(String(messages[1]?.content || '').split('\n').slice(1).join('\n')), seg = context?.new_segment;
  if (!seg?.text) return { tool_calls: [] };
  const have = new Set((context.active_candidates || []).map(d => d.field)), used = new Set(), details = [];
  for (const raw of seg.text.match(/[^.!?。\n]+[.!?。]?/g) || []) {
    const quote = raw.trim();
    if (quote.length < 12 || details.length >= 4) continue;
    const hit = RULES.find(([field, re]) => re.test(quote) && !used.has(field))?.[0] || ORDER.find(f => !have.has(f) && !used.has(f)) || 'customer_fit';
    used.add(hit); details.push({ field: hit, item_id: seg.item_id, quote: quote.slice(0, 400) });
  }
  return { tool_calls: details.length ? [{ id: 'fake-' + seg.item_id, name: 'record_details', arguments: JSON.stringify({ details }) }] : [] };
}
