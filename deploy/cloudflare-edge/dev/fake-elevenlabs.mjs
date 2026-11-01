// In-memory stand-in for the three ElevenLabs endpoints the Settings sheet uses (GET /v2/voices, GET /v1/user, POST /v1/text-to-speech/{voice}), for local runs and browser tests. Used only
// with FAKE_ELEVENLABS=1 (dev/local-edge.mjs); without it every request to api.elevenlabs.io is refused, so a local run never reaches the real service. The one key it accepts is `key`.
// Every request is recorded in `calls` (path only, never a key) for the tests to read from /__elevenlabs_calls. Never used in production code.
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
export function fakeElevenlabs({ key }) {
  const calls = [];
  const VOICES = [['EXAVITQu4vr4xnSDxMaL', 'Sarah', 'american', 'female'], ['pNInz6obpgDQGcFmaJgB', 'Adam', 'american', 'male'], ['XB0fDUnXU5powFXDhCwa', 'Charlotte', 'english-swedish', 'female'], ['onwK4e9ZLuTAKqWW03F9', 'Daniel', 'british', 'male']];
  const fn = (url, init = {}) => {
    const u = new URL(String(url)), headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method: init.method || 'GET', path: u.pathname, search: u.searchParams.get('search') || '' });
    if (headers['xi-api-key'] !== key) return json({ detail: { status: 'invalid_api_key' } }, 401);
    if (u.pathname === '/v2/voices') {
      const q = (u.searchParams.get('search') || '').toLowerCase(), rows = VOICES.filter(v => !q || v[1].toLowerCase().includes(q));
      return json({ voices: rows.map(([voice_id, name, accent, gender]) => ({ voice_id, name, category: 'premade', labels: { accent, gender, use_case: 'conversational' }, verified_languages: [{ language: 'en' }] })), has_more: false });
    }
    if (u.pathname === '/v1/user') return json({ subscription: { tier: 'creator', character_count: 1200, character_limit: 100000, status: 'active' } });
    if (/^\/v1\/text-to-speech\/[A-Za-z0-9]+$/.test(u.pathname)) { // half a second of a 440 Hz tone at 24 kHz, 16-bit mono
      const pcm = new Int16Array(12000); for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / 24000) * 6000);
      return new Response(new Uint8Array(pcm.buffer), { headers: { 'Content-Type': 'audio/pcm' } });
    }
    return json({}, 404);
  };
  fn.calls = calls;
  return fn;
}
