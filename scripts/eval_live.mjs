#!/usr/bin/env node
// MANUAL ONLY. A stub for a future live conversation evaluation (the real talker model, real speech, real consultants or Tony's own test runs). It is NOT run by
// `make test`, `make test-eval`, CI or any test, and it never calls anything today: with authorisation it still stops and says what is missing.
//
// It refuses to start unless BOTH of these are set in the environment of the person running it:
//   ATLAS_EVAL_LIVE=I_HAVE_TONYS_WRITTEN_AUTHORISATION   (the exact words: a live run calls paid providers and may send conversation content to them)
//   ATLAS_EVAL_LIVE_TARGET=<the https origin of the deployment to evaluate; a test deployment only>
// Why: CLAUDE.md rules 4 and 5 (no paid provider calls, no real customer content, no cloud change without explicit authorisation). The offline evaluation
// (deploy/cloudflare-edge/test/eval-*.test.js) is the harness that runs by default; what it cannot judge (how humane the live model is, speech quality, latency) is
// listed in docs/agent-brain-v2.1/eval/COVERAGE.md and needs people.
const REQUIRED = 'I_HAVE_TONYS_WRITTEN_AUTHORISATION';
const fail = (code, msg) => { console.error('eval_live: ' + msg); process.exit(code); };

if (process.env.ATLAS_EVAL_LIVE !== REQUIRED) fail(2, 'refused. This script calls live providers. Set ATLAS_EVAL_LIVE=' + REQUIRED + ' only with Tony\'s written authorisation. Nothing was run.');
let target;
try { target = new URL(String(process.env.ATLAS_EVAL_LIVE_TARGET || '')); } catch { fail(2, 'refused. ATLAS_EVAL_LIVE_TARGET must be the https origin of a TEST deployment. Nothing was run.'); }
if (target.protocol !== 'https:' || target.pathname !== '/' || target.username || target.password) fail(2, 'refused. ATLAS_EVAL_LIVE_TARGET must be a bare https origin. Nothing was run.');
// Authorised, and still a stub: the transport, the synthetic consultant scripts and the rating sheet for human raters are not built.
fail(3, 'authorised for ' + target.origin + ', but this runner is a stub: no transport, no scripts and no rating sheet exist yet. Build them with the owner, then replace this message. Nothing was run.');
