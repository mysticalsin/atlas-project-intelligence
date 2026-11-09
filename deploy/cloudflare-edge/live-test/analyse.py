"""Analysis of a live-test driver result (live-test/run.mjs output): per-mode cold/warm cells, discard rates, turn-model
outcomes, REST timings and ledger spend by component. Timings and counts only; no audio or text is in the input.
    python3 live-test/analyse.py live-run.json network-rtt.json > analysis.json
"""
import json, math, sys

PRICE = {'stt_min': 0.0052, 'turn_min': 0.00033795, 'in_m': 0.293, 'out_m': 2.253, 'tts_k': 0.030}


def pct(xs, p):
    v = sorted(x for x in xs if isinstance(x, (int, float)))
    return v[min(len(v) - 1, math.ceil(p / 100 * len(v)) - 1)] if v else None


def cell(xs):
    v = [x for x in xs if isinstance(x, (int, float))]
    return {'n': len(v), 'median': pct(v, 50), 'p90': pct(v, 90), 'p95': pct(v, 95)}


def talker_first(turn):
    """The reply's talker stream after end of speech: REST response headers of the first talker call at or after the
    transcript, or of an adopted draft started earlier (available no earlier than the transcript). A proxy for first
    token: streaming headers can precede the first generated token."""
    tr = turn['transcript_ms']
    calls = [c for c in turn['rest_calls'] if 'llama' in c['model']]
    adopted = any(m['metric'] == 'early_draft_adopted' and m['at_ms'] >= 0 for m in turn['metrics'])
    if adopted:
        before = [c for c in calls if c['at_ms'] <= (tr or 0) + 50]
        if before:
            return max(before[-1]['at_ms'], tr or 0), 'draft'
    after = [c for c in calls if tr is not None and c['at_ms'] >= tr - 5]
    return (after[0]['at_ms'], 'reply') if after else (None, None)


def main(run_path, rtt_path):
    r = json.load(open(run_path))
    rtt = json.load(open(rtt_path)) if rtt_path else None
    out = {'source': run_path, 'route': r['ledger'].get('route'), 'modes': {}, 'definitions': r.get('definitions'),
           'labels': 'measured on this VM: workerd (wrangler dev) calling the Workers AI REST API over the public internet; not inside a deployed Worker; identical routing for every mode'}
    for run in r['runs']:
        m = out['modes'].setdefault(run['mode'], {'sessions': 0, 'turns': [], 'errors': [], 'turn_model': {}, 'rest': {}})
        m['sessions'] += 1
        m['errors'] += run.get('errors') or []
        for c in run.get('rest_all') or []:
            k = c['model'].split('/')[-1]
            m['rest'].setdefault(k, {'calls': 0, 'non_200': 0, 'headers_ms': [], 'done_ms': []})
            e = m['rest'][k]; e['calls'] += 1; e['non_200'] += c['status'] != 200
            e['headers_ms'].append(c['headers_ms'])
            if c.get('done_ms') is not None: e['done_ms'].append(c['done_ms'])
        for t in run['turns']:
            names = [x['metric'] for x in t['metrics']]
            for x in t['metrics']:
                if x['metric'] == 'turn_check':
                    key = 'timeout' if x.get('reason') == 'timeout' else ('no_verdict' if x.get('complete') == -1 else f"verdict_{'complete' if x['complete'] == 1 else 'incomplete'}_{'confident' if x['probability'] >= 0.9 else 'unsure'}")
                    m['turn_model'][key] = m['turn_model'].get(key, 0) + 1
            first_tok, src = talker_first(t)
            gap = next((x for x in t['metrics'] if x['metric'] == 'reply_gap' and x['at_ms'] >= 0), None)
            m['turns'].append({'cold': t['index'] == 1, 'transcript_ms': t['transcript_ms'], 'first_text_ms': t['first_token_ms'],
                               'first_audio_sent_ms': t['first_audio_sent_ms'], 'talker_first_token_proxy_ms': first_tok, 'talker_source': src,
                               'acknowledgement_first': bool(gap and gap.get('filler')), 'withdrawn_reply': names.count('reply_withdrawn'),
                               'early_stt_sent': names.count('early_stt_sent'), 'early_stt_used': names.count('early_stt_used'),
                               'early_withdrawn': names.count('early_withdrawn'), 'early_late_discarded': names.count('early_late_discarded'),
                               'draft_sent': names.count('early_draft_sent'), 'draft_adopted': names.count('early_draft_adopted'), 'draft_withdrawn': names.count('early_draft_withdrawn')})
    for name, m in out['modes'].items():
        # A valid sample has a transcript after end of speech and no output before it (a reply to an earlier part of
        # the answer still playing is not a reply to this turn).
        for t in m['turns']:
            t['valid'] = t['transcript_ms'] is not None and (t['first_audio_sent_ms'] is None or t['first_audio_sent_ms'] >= t['transcript_ms'])
        m['excluded_turns'] = sum(not t['valid'] for t in m['turns'])
        T = [t for t in m['turns'] if t['valid']]
        s = lambda k: sum(t[k] for t in T)
        m['counts'] = {k: s(k) for k in ['early_stt_sent', 'early_stt_used', 'early_withdrawn', 'early_late_discarded', 'draft_sent', 'draft_adopted', 'draft_withdrawn', 'withdrawn_reply']}
        m['counts']['acknowledgement_first_turns'] = sum(t['acknowledgement_first'] for t in T)
        c = m['counts']
        m['early_stt_discard_rate'] = round(1 - c['early_stt_used'] / c['early_stt_sent'], 3) if c['early_stt_sent'] else None
        m['draft_discard_rate'] = round(1 - c['draft_adopted'] / c['draft_sent'], 3) if c['draft_sent'] else None
        m['cells'] = {k: {'cold': cell([t[k] for t in T if t['cold']]), 'warm': cell([t[k] for t in T if not t['cold']])}
                      for k in ['transcript_ms', 'first_text_ms', 'first_audio_sent_ms', 'talker_first_token_proxy_ms']}
        m['cells_no_acknowledgement'] = {k: cell([t[k] for t in T if not t['acknowledgement_first']]) for k in ['first_audio_sent_ms', 'talker_first_token_proxy_ms']}
        for e in m['rest'].values():
            e['headers_ms'] = cell(e['headers_ms']); e['done_ms'] = cell(e['done_ms'])
    l = r['ledger']; res = l['reserved']
    talker = res['inputTokens'] / 1e6 * PRICE['in_m'] + res['outputTokens'] / 1e6 * PRICE['out_m']
    tts = res['ttsChars'] / 1000 * PRICE['tts_k']
    audio = res['usd'] - talker - tts
    obs = l['observed']
    out['ledger'] = {'stopped': l['stopped'], 'sessions': l['sessions'], 'turns': l['turns'], 'reserved': res, 'by_kind_requests': l['byKind'], 'refusals': l['refusals'], 'observed': obs, 'in_flight': l['inFlight'],
                     'spend_by_component_usd (reserved ceilings, authoritative)': {
                         'talker incl. drafts (input+output)': round(talker, 6),
                         '  of which input': round(res['inputTokens'] / 1e6 * PRICE['in_m'], 6), '  of which output (300 reserved per call)': round(res['outputTokens'] / 1e6 * PRICE['out_m'], 6),
                         'speech synthesis (agent voice and synthetic test speech)': round(tts, 6),
                         'audio: speech recognition + turn model': round(audio, 6), 'total': round(res['usd'], 6), 'proxy item': 0.0},
                     'observed_units_estimate_usd (labelled estimate)': {
                         'talker output at ~4 chars per token': round(obs['outputChars'] / 4 / 1e6 * PRICE['out_m'], 6),
                         'note': 'input tokens are only known as the byte upper bound; audio by kind is not split in the ledger; Cloudflare-reported usage not read'}}
    if rtt: out['network_reference'] = rtt
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
