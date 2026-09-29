// F3.3 the /confirm page (WOW_SPEC §F3.3): the 60-second confirmation page for an N+1 or, when enabled, a client
// contact. Served by app.js at GET /confirm after sign-in, under the standard CSP (inline script and style only,
// connect-src 'self'). Self-contained: no external asset, no <script src>, no web font, no animation.
// All data is written with textContent (never innerHTML). The link carries only the request id in the #fragment;
// authorisation is the sign-in (the inbox lists only requests addressed to the signed-in email).
const STYLE = ':root{color-scheme:dark}*{box-sizing:border-box}'
  + 'body{margin:0;background:#101011;color:#F8F8F8;font:16px/1.55 Arial,system-ui,sans-serif;-webkit-text-size-adjust:100%}'
  + 'main{max-width:40rem;margin:0 auto;padding:24px 16px 48px}h1{font-size:24px;line-height:1.25;font-weight:600;margin:0 0 8px}'
  + 'h2{font-size:20px;line-height:1.3;font-weight:600;margin:0 0 8px}p{margin:0 0 12px}.eyebrow{font-size:11px;letter-spacing:.14em;color:#A9A9BC;margin-bottom:16px}'
  + '.muted{color:#A9A9BC}.note{border-left:3px solid #F6EB4B;padding-left:10px}.claims{list-style:none;margin:20px 0;padding:0}'
  + '.claim{border:1px solid #2F3440;border-radius:12px;padding:14px;margin:0 0 12px;background:#17171D}'
  + '.topic{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#A9A9BC;margin:0 0 4px}.text,h1,h2,p,a{overflow-wrap:anywhere}'
  + '.choices{display:flex;flex-wrap:wrap;gap:8px}button{font:inherit;border:1px solid #666A78;background:transparent;color:#F8F8F8;border-radius:8px;padding:10px 14px;min-height:44px;cursor:pointer}'
  + 'button[aria-pressed="true"]{background:#F6EB4B;border-color:#F6EB4B;color:#101011;font-weight:600}.primary{background:#3E007A;border-color:#3E007A;color:#fff;padding:12px 20px}'
  + 'button:disabled{opacity:.45;cursor:not-allowed}button:focus-visible,a:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{outline:3px solid #F6EB4B;outline-offset:3px}'
  + 'label{display:block;margin:10px 0 4px;color:#A9A9BC}textarea{display:block;width:100%;font:inherit;background:#101011;color:#F8F8F8;border:1px solid #666A78;border-radius:8px;padding:8px}'
  + 'a{color:#F6EB4B}.others{margin-top:28px}.others ul{padding-left:20px}.alert{color:#FFB4A8}[hidden]{display:none!important}';

// The page script. It exposes window.AtlasConfirm (el, render, heading, choose, ready, state) so node tests can drive it
// with a DOM double; it loads data only when fetch exists (a real browser).
const SCRIPT = String.raw`(function () {
  'use strict';
  var doc = document, state = { csrf: '', items: [], current: null, decisions: {}, busy: false };
  var TOPIC = { 1: 'Contribution', 2: 'Approach', 3: 'Outcome', 4: 'Evidence' };
  var CHOICES = [['confirm', 'Confirm'], ['correct', 'Correct…'], ['cant_say', 'Can’t say']];
  // The only way data reaches the page: createElement + setAttribute + textContent.
  function el(tag, attrs, text) {
    var e = doc.createElement(tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, String(attrs[k]));
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function byId(id) { return doc.getElementById(id); }
  function heading(item) {
    var n = item.claims.length, who = (item.reference && item.reference.consultant && item.reference.consultant.name) || 'a colleague';
    return 'Confirm ' + n + (n === 1 ? ' point' : ' points') + ' for ' + who + ', about 60 seconds';
  }
  function showError(message) { var e = byId('confirmError'); e.textContent = message; e.hidden = false; }
  function ready() {
    var cs = state.current ? state.current.claims : [];
    return cs.length > 0 && cs.every(function (c) { var d = state.decisions[c.id]; return !!d && (d.decision !== 'correct' || d.note.trim().length > 0); });
  }
  function update() { var b = byId('confirmSubmit'); if (b) b.disabled = state.busy || !ready(); }
  function choose(claimId, decision) {
    var row = state.rows[claimId]; if (!row) return;
    state.decisions[claimId] = { decision: decision, note: row.note.value || '' };
    row.buttons.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-decision') === decision ? 'true' : 'false'); });
    row.wrap.hidden = decision !== 'correct';
    if (decision === 'correct') row.note.focus();
    update();
  }
  function claimRow(c, k) {
    var li = el('li', { 'class': 'claim', 'data-claim': c.id }), textId = 'claim-' + k, noteId = 'note-' + k;
    li.appendChild(el('p', { 'class': 'topic' }, TOPIC[c.topic] || 'Point'));
    li.appendChild(el('p', { 'class': 'text', id: textId }, c.text));
    var group = el('div', { 'class': 'choices', role: 'group', 'aria-labelledby': textId }), wrap = el('div', { 'class': 'correction' });
    var note = el('textarea', { id: noteId, maxlength: '500', rows: '3' }), buttons = [];
    wrap.hidden = true;
    wrap.appendChild(el('label', { 'for': noteId }, 'What should it say? (required)'));
    wrap.appendChild(note);
    CHOICES.forEach(function (d) {
      var b = el('button', { type: 'button', 'data-decision': d[0], 'aria-pressed': 'false' }, d[1]);
      b.addEventListener('click', function () { choose(c.id, d[0]); });
      buttons.push(b); group.appendChild(b);
    });
    note.addEventListener('input', function () { if (state.decisions[c.id]) state.decisions[c.id].note = note.value || ''; update(); });
    state.rows[c.id] = { buttons: buttons, wrap: wrap, note: note };
    li.appendChild(group); li.appendChild(wrap);
    return li;
  }
  // Renders the request named by the hash (or the first one); returns its heading, or null when there is nothing.
  function render(items, hash) {
    var box = byId('confirmInbox'); clear(box);
    byId('confirmDone').hidden = true; byId('confirmError').hidden = true;
    state.items = items || []; state.decisions = {}; state.rows = {}; state.current = null;
    if (!state.items.length) {
      box.appendChild(el('h1', { id: 'confirmTitle', tabindex: '-1' }, 'Nothing to confirm'));
      box.appendChild(el('p', { 'class': 'muted' }, 'There is no open confirmation request for you. A request closes when it is answered, when the reference changes, or after 14 days.'));
      return null;
    }
    var want = String(hash || '').replace(/^#/, ''), item = null;
    state.items.forEach(function (i) { if (!item && i.request.id === want) item = i; });
    if (want && !item) box.appendChild(el('p', { 'class': 'note', role: 'note' }, 'That request is no longer open: it was answered, cancelled, changed or has expired.'));
    item = item || state.items[0]; state.current = item;
    var h = el('h1', { id: 'confirmTitle', tabindex: '-1', 'data-request': item.request.id }, heading(item));
    box.appendChild(h);
    box.appendChild(el('p', { 'class': 'muted' }, (item.reference.title || 'A project reference') + ' · revision ' + item.reference.revision));
    box.appendChild(el('p', {}, 'For each point, confirm it, correct it, or say you can’t tell. Only your decisions and notes are recorded.'));
    var list = el('ol', { 'class': 'claims' });
    item.claims.forEach(function (c, k) { list.appendChild(claimRow(c, k)); });
    box.appendChild(list);
    var submit = el('button', { id: 'confirmSubmit', type: 'button', 'class': 'primary' }, 'Send my answers');
    submit.disabled = true; submit.addEventListener('click', send);
    box.appendChild(submit);
    var others = state.items.filter(function (i) { return i !== item; });
    if (others.length) {
      var more = el('div', { 'class': 'others' }), ul = el('ul');
      more.appendChild(el('h2', {}, 'Also waiting for you'));
      others.forEach(function (i) { var li = el('li'); li.appendChild(el('a', { href: '#' + i.request.id }, heading(i))); ul.appendChild(li); });
      more.appendChild(ul); box.appendChild(more);
    }
    return h;
  }
  function done(item) {
    state.items = state.items.filter(function (i) { return i !== item; }); state.current = null;
    clear(byId('confirmInbox'));
    var next = byId('confirmNext'); clear(next);
    if (state.items.length) next.appendChild(el('a', { href: '#' + state.items[0].request.id }, 'Next: ' + heading(state.items[0])));
    var d = byId('confirmDone'); d.hidden = false; d.focus();
  }
  function send() {
    if (!ready() || state.busy) return;
    var item = state.current;
    var body = { decisions: item.claims.map(function (c) { var d = state.decisions[c.id]; return d.decision === 'correct' ? { claimId: c.id, decision: d.decision, note: d.note.trim() } : { claimId: c.id, decision: d.decision }; }) };
    state.busy = true; update(); byId('confirmError').hidden = true;
    fetch('/api/library/confirmations/' + encodeURIComponent(item.request.id), { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Atlas-CSRF': state.csrf }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Your answers could not be recorded. Try again.'); return j; }); })
      .then(function () { state.busy = false; done(item); }, function (e) { state.busy = false; update(); showError(e.message); });
  }
  function load() {
    fetch('/api/bootstrap', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('Sign in to confirm.'); return r.json(); })
      .then(function (boot) {
        state.csrf = boot.csrf || '';
        if (!boot.features || !boot.features.claims) throw new Error('Confirmations are not available on this deployment.');
        return fetch('/api/library/confirmations/inbox', { credentials: 'same-origin' });
      })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Your requests could not be loaded.'); return j; }); })
      .then(function (j) { var h = render(j.items || [], location.hash); if (h && location.hash) h.focus(); })
      .catch(function (e) { clear(byId('confirmInbox')); showError(e.message); });
    window.addEventListener('hashchange', function () { var h = render(state.items, location.hash); if (h) h.focus(); });
  }
  state.rows = {};
  window.AtlasConfirm = { el: el, render: render, heading: heading, choose: choose, ready: ready, state: state };
  if (typeof fetch === 'function') load();
})();`;

export const CONFIRM_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<meta name="robots" content="noindex"><title>ATLAS: confirm points</title><style>' + STYLE + '</style></head><body><main>'
  + '<p class="eyebrow">ATLAS · CONFIRMATION</p>'
  + '<div id="confirmInbox" aria-live="polite"><p class="muted">Loading your requests…</p></div>'
  + '<div id="confirmDone" hidden tabindex="-1" role="status"><h2>Recorded. Thank you. Nothing else is shared.</h2><p id="confirmNext"></p></div>'
  + '<p id="confirmError" class="alert" role="alert" hidden></p>'
  + '</main><script>' + SCRIPT + '</script></body></html>';
