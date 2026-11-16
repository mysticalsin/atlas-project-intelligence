#!/usr/bin/env python3
"""Render docs/privacy/PRIVACY_NOTICE.md and docs/privacy/RETENTION_SCHEDULE.md from atlas_voice/config/{privacy,retention}.json (v2.2 G2).

One source of truth: the Worker's /privacy page, the consent wording and these two documents all read the same JSON, so they cannot drift.
    python3 scripts/render_privacy_docs.py          write the files
    python3 scripts/render_privacy_docs.py --check  exit 1 when a file is out of date (tests/test_privacy_config.py runs this)
Wording, lawful bases and periods are placeholders and proposals that Mantu's DPO and legal team must confirm; nothing here is a compliance claim."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'atlas_voice' / 'config'
OUT = ROOT / 'docs' / 'privacy'
ACTION = {'delete': 'deleted', 'erase_content': 'content erased (an empty marker stays)', 'pseudonymise': 'pseudonymised (actor replaced, free text cleared)', 'platform': 'handled by the platform', 'forget': 'forgotten'}


def period(c):
    return f"{c['hours']} hours" if 'hours' in c else f"{c['days']} days"


def notice(privacy, retention):
    n = privacy['notice']
    out = [f"# {n['title']}", '', f"Version `{privacy['version']}`. {privacy['status']}.", '',
           '> Generated from `atlas_voice/config/privacy.json` by `scripts/render_privacy_docs.py`. Edit the JSON, not this file. The same text is served at `/privacy`.', '', n['intro'], '']
    for s in n['sections']:
        out += [f"## {s['title']}", '']
        out += [p + '\n' for p in s['paragraphs']]
        if s['id'] == 'retention':
            out += retention_table(retention) + ['']
    out += ['## The wording of the consent choices (what the consent dialog shows)', '']
    for key, t in privacy['toggles'].items():
        out += [f"- **{key}** ({'required' if t['required'] else 'optional'}): {t['text']}"] + ([f"  - typed interview: {t['text_mode_text']}"] if t.get('text_mode_text') else [])
    out += ['', '- Profile choices:'] + [f"  - **{k}**: {v['text']}" for k, v in privacy['profile_consents'].items()] + ['']
    return '\n'.join(out).rstrip() + '\n'


def retention_table(retention):
    rows = ['| What | Kept for | Counted from | Then | Enforced by | Status |', '|---|---|---|---|---|---|']
    for c in retention['categories']:
        rows.append(f"| {c['label']} | {period(c)} | {c['from']} | {ACTION.get(c['action'], c['action'])} | {c['enforced_by']} | {c['status']} |")
    return rows


def schedule(retention):
    out = ['# Retention schedule', '', f"Status: **{retention['status']}**. Generated from `atlas_voice/config/retention.json` by `scripts/render_privacy_docs.py`. Edit the JSON, not this file.", '', retention['note'], '']
    out += retention_table(retention) + ['']
    out += ['## How it is enforced', '',
            '- **Daily sweep.** The Worker cron (06:17 UTC) posts `scan-stale` to the LibraryStore, which runs `retention.js sweep` after its other daily housekeeping. The sweep returns counts only (never an id or a word of content) and a quiet day returns nothing.',
            '- **Erasure rather than row deletion.** Content is replaced by a tombstone (`{erased: true, at}`); ids, counts and joins stay so nothing else breaks. Drafts and expired requests are erased the same way or deleted outright as the table says.',
            '- **Audit trail.** Rows older than the period lose their actor (a random token per person per sweep) and their free text; the action, the record id and the time stay. Actor and detail are outside the hash, so later rows keep their links and the head does not move. The security log records `audit_chain_ok` / `AUDIT_PSEUDONYMISED`.',
            '- **Things the sweep never removes on its own.** Approved evidence, published references and bids are not retention targets: they are held for the DPO when a person asks for erasure (`erasure_holds`), and are withdrawn rather than deleted by the withdrawn-references rule only when no bid uses them and the DPO holds nothing on them.',
            '- **Not swept by this code (listed so silence is not read as done).** Security log lines (the log sink or the Cloudflare Workers Logs plan sets the period; to verify), private memory (pruned for that person each time memory is used; the person can erase it any time; a bank-wide sweep would need a list of every bank), the 24-hour checkpoint (a Durable Object alarm).',
            '- **Platform copies.** Durable Object point-in-time recovery can keep a deleted record for a period set by Cloudflare (to verify). The privacy notice says so.',
            '- **Test deployment.** A retention rule that deletes content is only as good as the clock and the data: the tests use a fake clock (`test/g2-retention.test.js`); no live deployment has run it.', '']
    return '\n'.join(out)


def render():
    privacy = json.loads((CONFIG / 'privacy.json').read_text(encoding='utf-8'))
    retention = json.loads((CONFIG / 'retention.json').read_text(encoding='utf-8'))
    return {OUT / 'PRIVACY_NOTICE.md': notice(privacy, retention), OUT / 'RETENTION_SCHEDULE.md': schedule(retention)}


if __name__ == '__main__':
    files = render()
    if '--check' in sys.argv[1:]:
        stale = [str(p.relative_to(ROOT)) for p, text in files.items() if not p.exists() or p.read_text(encoding='utf-8') != text]
        if stale:
            print('out of date: ' + ', '.join(stale) + '  (run python3 scripts/render_privacy_docs.py)')
            sys.exit(1)
        print('privacy docs are current')
    else:
        OUT.mkdir(parents=True, exist_ok=True)
        for p, text in files.items():
            p.write_text(text, encoding='utf-8')
            print('wrote', p.relative_to(ROOT))
