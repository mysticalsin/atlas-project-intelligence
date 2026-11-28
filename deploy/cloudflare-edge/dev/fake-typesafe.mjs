// In-memory stand-in for TypeSafe System One (POST https://api.typesafe.ai/v1/systemone) for local runs and browser
// tests: same request and answer shapes as https://docs.typesafe.ai/api.md. Generic and deterministic, so every JEV
// path works locally (story rating, classification, the ranker, memory relevance). Never used in production code.
// Answers (mode `ok`): a Score peaks at a level taken from the length of the text at the first backticked path of its
// instructions; a Noul is 0.9 when that text is non-empty, else 0.1; a Choice picks its first option. The model id is
// `fake-jev-local`, so a rating made by the fake always says so. Modes: `ok`, `down` (529 overloaded) and `unsure`
// (every Score [0.25, 0.05, 0.10, 0.60] at confidence 0.4 for four levels, every Noul 0.9, a Choice's first option at 0.99).
const MODES = ['ok', 'down', 'unsure'];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const round = x => Math.round(x * 1e4) / 1e4;

function at(state, instructions) {
  const path = /`([^`]+)`/.exec(String(instructions || ''))?.[1];
  // memories[0] is the same lookup as memories.0. Relevance questions use the bracket form.
  const keys = path ? path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean) : null;
  const v = keys ? keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), state) : state;
  return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
}
// The demo shape of https://docs.typesafe.ai/confidence.md, extended to n options: (n × largest − 1) / (n − 1).
const confidenceOf = p => { const n = p.length; return round(Math.max(0, (n * Math.max(...p) - 1) / (n - 1))); };

function score(q, text, mode) {
  const n = q.criteria.length, top = n - 1;
  let p;
  if (mode === 'unsure') {
    p = n === 4 ? [0.25, 0.05, 0.10, 0.60] : n === 2 ? [0.4, 0.6] : Array.from({ length: n }, (_, k) => (k === 0 ? 0.25 : k === top ? 0.6 : 0.15 / (n - 2)));
  } else {
    const len = text.trim().length, level = len === 0 ? 0 : Math.min(top, len < 40 ? 1 : len < 120 ? 2 : 3);
    p = Array(n).fill(0); p[level] = 0.9; p[level > 0 ? level - 1 : level + 1] = 0.1;
  }
  p = p.map(round);
  return { type: 'score', score: round(p.reduce((s, x, k) => s + k * x, 0)), legend: Object.fromEntries(q.criteria.map((c, k) => [String(k), typeof c === 'string' ? c : JSON.stringify(c)])),
    probabilities: Object.fromEntries(p.map((x, k) => [String(k), x])), confidence: mode === 'unsure' ? 0.4 : confidenceOf(p) };
}
function choice(q) {
  const keys = Object.keys(q.criteria), rest = keys.length > 1 ? round(0.01 / (keys.length - 1)) : 0;
  const probabilities = Object.fromEntries(keys.map((k, i) => [k, i === 0 ? (keys.length > 1 ? 0.99 : 1) : rest]));
  return { type: 'choice', choice: keys[0], probabilities, confidence: keys.length > 1 ? 0.99 : 1 };
}

export function fakeTypesafe({ key = 'local-fake-key' } = {}) {
  let mode = 'ok';
  const f = async (url, init = {}) => {
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? (typeof init.headers?.get === 'function' ? init.headers.get('Authorization') : '');
    if (auth !== 'Bearer ' + key) return json({ error: 'Invalid or missing API key' }, 401);
    if (new URL(url).pathname !== '/v1/systemone' || String(init.method || 'GET').toUpperCase() !== 'POST') return json({ error: 'Not found' }, 404);
    if (mode === 'down') return json({ error: 'Service temporarily overloaded' }, 529);
    let body;
    try { body = JSON.parse(init.body); } catch { return json({ error: 'Request validation failed' }, 422); }
    if (!body || !body.model || body.state === undefined || !body.questions || typeof body.questions !== 'object') return json({ error: 'Request validation failed' }, 422);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const text = at(body.state, q?.instructions);
      if (q?.type === 'score' && Array.isArray(q.criteria) && q.criteria.length >= 2) answers[id] = score(q, text, mode);
      else if (q?.type === 'noul') answers[id] = { type: 'noul', noul: mode === 'unsure' || text.trim() ? 0.9 : 0.1 };
      else if (q?.type === 'choice' && q.criteria && typeof q.criteria === 'object' && Object.keys(q.criteria).length) answers[id] = choice(q);
      else return json({ error: 'Request validation failed' }, 422);
    }
    return json({ model: 'fake-jev-local', answers, usage: { input_tokens: Math.ceil(String(init.body).length / 4), output_tokens: 0 } });
  };
  f.setMode = m => { if (!MODES.includes(m)) throw new Error('Unknown fake TypeSafe mode: ' + m); mode = m; };
  Object.defineProperty(f, 'mode', { get: () => mode });
  return f;
}
