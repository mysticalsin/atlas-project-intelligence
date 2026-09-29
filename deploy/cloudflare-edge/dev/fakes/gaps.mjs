// T2 fake-model branches for F2 (WOW_SPEC §2.6). None is needed: gap requests (gaps.js) make no model call, and the gap
// interview's talker prompt (session.js gap mode) runs only in the Interview DO, which this fake model does not serve.
// Kept so dev/fakes/index.mjs has one branch per track; it matches no policy.
export function fake() { return null; }
