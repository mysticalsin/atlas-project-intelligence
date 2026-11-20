// The prepared-statement tail, from node:sqlite's sourceSQL (sqlite3_prepare_v2).
// Workerd 2026-10-23 SqlStorage exposes exec and returns rows. It does not expose
// the unconsumed tail. This module is the equivalent real-SQLite check. On an
// isolate where node:sqlite is absent it returns null, and Library then refuses
// a semicolon that still has SQL after it.
//
// The statement lifecycle is one machine: idle, prepared, executed, remainder,
// finalized. The reducer is pure. Preparing and reading sourceSQL happen outside
// it. Empty input, whitespace, a bare semicolon, and a comment that prepares no
// statement land on finalized. Reading the remainder from that state is illegal
// and becomes SQL_EMPTY. The native ERR_INVALID_STATE does not leave this module.
import { slice, textOf } from './primordials.js';

export const STATEMENT_PHASES = Object.freeze(['idle', 'prepared', 'executed', 'remainder', 'finalized']);
export const STATEMENT_EVENTS = Object.freeze([
  'prepare_live', 'prepare_empty', 'prepare_failed', 'execute', 'read_remainder', 'finalize',
]);

const LEGAL = new Set([
  'idle:prepare_live',
  'idle:prepare_empty',
  'idle:prepare_failed',
  'prepared:read_remainder',
  'prepared:execute',
  'prepared:finalize',
  'executed:read_remainder',
  'executed:finalize',
  'remainder:execute',
  'remainder:finalize',
]);

const EMPTY_MESSAGE = 'This input prepares no statement.';

let scratch = null;
let unavailable = false;

export function initialStatement() {
  return { phase: 'idle', source: null, tail: null };
}

export function sourceIsPrefix(input, source) {
  if (typeof input !== 'string' || typeof source !== 'string') return false;
  if (source.length > input.length) return false;
  for (let i = 0; i < source.length; i++) if (input[i] !== source[i]) return false;
  return true;
}

function copyState(state) {
  return { phase: state.phase, source: state.source ?? null, tail: state.tail ?? null };
}

function done(state, extra = {}) {
  return {
    ok: true,
    illegal: false,
    denied: false,
    guard: null,
    state,
    effect: extra.effect ?? null,
    rejection: undefined,
  };
}

function deny(state, guard) {
  return {
    ok: false,
    illegal: false,
    denied: true,
    guard,
    state: copyState(state),
    effect: null,
    rejection: undefined,
  };
}

function illegal(state, event) {
  const known = !!(state && STATEMENT_PHASES.includes(state.phase));
  const phase = known ? state.phase : 'idle';
  const safe = known
    ? { phase, source: state.source ?? null, tail: state.tail ?? null }
    : { phase: 'idle', source: null, tail: null };
  return {
    ok: false,
    illegal: true,
    denied: false,
    guard: null,
    state: safe,
    effect: 'sql_empty',
    rejection: { atlas_metric: 'sql_tail', illegal: true, phase, event: event || 'unknown' },
  };
}

// Pure. No prepare, no sourceSQL, no logging. Anything not in LEGAL is illegal.
export function statementTransition(state, event) {
  const phase = state && STATEMENT_PHASES.includes(state.phase) ? state.phase : null;
  const type = event && typeof event.type === 'string' ? event.type : '';
  if (!phase || !LEGAL.has(phase + ':' + type)) return illegal(state, type || 'unknown');
  if (type === 'prepare_failed') return done({ phase: 'idle', source: null, tail: null });
  if (type === 'prepare_empty') return done({ phase: 'finalized', source: null, tail: null }, { effect: 'sql_empty' });
  if (type === 'prepare_live') return done({ phase: 'prepared', source: null, tail: null });
  if (type === 'read_remainder') {
    if (!sourceIsPrefix(event.input, event.source)) return deny(state, 'sourceIsPrefix');
    return done({ phase: 'remainder', source: event.source, tail: event.input.slice(event.source.length) });
  }
  if (type === 'execute') return done({ phase: 'executed', source: state.source ?? null, tail: state.tail ?? null });
  return done({ phase: 'finalized', source: state.source ?? null, tail: state.tail ?? null });
}

export function statementError(result) {
  if (!result || result.illegal || result.effect === 'sql_empty') {
    return Object.assign(new Error(EMPTY_MESSAGE), { status: 500, code: 'SQL_EMPTY' });
  }
  return null;
}

// The runner logs this marker. The reducer does not. The marker has no SQL text.
export function noteStatement(result) {
  if (!result || result.illegal !== true || !result.rejection) return;
  console.warn(JSON.stringify(result.rejection));
}

function databaseSync() {
  try {
    const mod = globalThis.process?.getBuiltinModule?.('node:sqlite');
    return mod?.DatabaseSync || null;
  } catch {
    return null;
  }
}

function fallback(phases) {
  return { effect: 'fallback', tail: null, phase: 'idle', phases, code: null };
}

function emptyResult(state, phases) {
  return { effect: 'sql_empty', tail: null, phase: state.phase, phases, code: 'SQL_EMPTY' };
}

function failClosed(moved, phases) {
  noteStatement(moved);
  phases.push(moved.state.phase);
  return emptyResult(moved.state, phases);
}

function ensureScratch(DatabaseSync) {
  if (scratch || unavailable) return scratch;
  try {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE refs (id, title, begin)');
    db.exec('CREATE TABLE audit (id, seq)');
    db.exec('CREATE TABLE consent_receipts (id)');
    scratch = db;
    return scratch;
  } catch {
    unavailable = true;
    return null;
  }
}

// True when sqlite3_prepare_v2 would compile no statement: whitespace, semicolons,
// and comments only. Preparing that text finalizes the handle immediately, and
// node:sqlite then crashes at process shutdown. The machine takes prepare_empty
// and does not call prepare. A later verb, including one after a leading
// semicolon, is not this guard.
export function preparesNoStatement(text) {
  if (typeof text !== 'string') return false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === ';') { i++; continue; }
    if (c === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i >= text.length) return true;
      i += 2;
      continue;
    }
    return false;
  }
  return true;
}

// One read, inside the guard. A finalized statement throws ERR_INVALID_STATE.
// That throw stays here. The machine then takes prepare_empty.
function readSource(stmt) {
  try {
    const source = stmt.sourceSQL;
    if (typeof source !== 'string') return { live: false, code: 'ERR_INVALID_STATE' };
    return { live: true, source };
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'ERR_INVALID_STATE';
    return { live: false, code };
  }
}

export function readStatementTail(sql) {
  const phases = ['idle'];
  if (unavailable) return fallback(phases);
  const DatabaseSync = databaseSync();
  if (!DatabaseSync) return fallback(phases);
  if (!ensureScratch(DatabaseSync)) return fallback(phases);
  const text = textOf(sql ?? '');
  if (typeof text !== 'string') return fallback(phases);
  let state = initialStatement();
  if (preparesNoStatement(text)) {
    const moved = statementTransition(state, { type: 'prepare_empty' });
    if (!moved.ok) return failClosed(moved, phases);
    phases.push(moved.state.phase);
    return emptyResult(moved.state, phases);
  }
  let stmt;
  try { stmt = scratch.prepare(text); }
  catch {
    const moved = statementTransition(state, { type: 'prepare_failed' });
    if (!moved.ok) return failClosed(moved, phases);
    phases.push(moved.state.phase);
    return { effect: 'fallback', tail: null, phase: moved.state.phase, phases, code: null };
  }
  const live = readSource(stmt);
  if (!live.live) {
    const moved = statementTransition(state, { type: 'prepare_empty' });
    if (!moved.ok) return failClosed(moved, phases);
    phases.push(moved.state.phase);
    return emptyResult(moved.state, phases);
  }
  let moved = statementTransition(state, { type: 'prepare_live' });
  if (!moved.ok) return failClosed(moved, phases);
  phases.push(moved.state.phase);
  state = moved.state;
  moved = statementTransition(state, { type: 'read_remainder', input: text, source: live.source });
  if (moved.denied) {
    const closed = statementTransition(moved.state, { type: 'finalize' });
    if (!closed.ok) return failClosed(closed, phases);
    phases.push(closed.state.phase);
    return { effect: 'fallback', tail: null, phase: closed.state.phase, phases, code: null };
  }
  if (!moved.ok) return failClosed(moved, phases);
  phases.push(moved.state.phase);
  const tail = slice(text, live.source.length);
  if (typeof tail !== 'string' || tail !== moved.state.tail) {
    const closed = statementTransition(moved.state, { type: 'finalize' });
    if (!closed.ok) return failClosed(closed, phases);
    phases.push(closed.state.phase);
    return { effect: 'fallback', tail: null, phase: closed.state.phase, phases, code: null };
  }
  const closed = statementTransition(moved.state, { type: 'finalize' });
  if (!closed.ok) return failClosed(closed, phases);
  phases.push(closed.state.phase);
  return { effect: 'tail', tail, phase: closed.state.phase, phases, code: null };
}

export function sqliteRemainder(sql) {
  const read = readStatementTail(sql);
  if (read.effect === 'sql_empty') throw statementError(read);
  if (read.effect === 'tail') return read.tail;
  return null;
}
