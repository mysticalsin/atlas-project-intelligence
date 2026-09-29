"""Record atlas_voice.jev results for the JS customer-jev parity test (WOW_SPEC §F1.5).

Run from the repo root: uv run --with aiohttp python3 deploy/cloudflare-edge/test/gen_jev_parity.py
(jev.py imports aiohttp). Deterministic: a fixed "today", no sleeping, a fake HTTP session, no network.
Writes test/jev-customer.vectors.json, which test/customer-jev.test.js replays.
"""
import asyncio, json, sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice import jev

TODAY = '2026-09-29'


class FixedDate(date):
    @classmethod
    def today(cls):
        return cls.fromisoformat(TODAY)


SLEEPS = []


async def _sleep(seconds):
    SLEEPS.append(seconds)


jev.date = FixedDate                          # source_freshness(story) inside rank() uses date.today()
jev.asyncio = SimpleNamespace(sleep=_sleep)   # retries are recorded, not waited


def dist(score):
    """A valid 0..4 distribution whose expectation is `score` (mass on the two nearest levels)."""
    lo = min(int(score), 3); hi = lo + 1; w = score - lo
    p = {str(k): 0.0 for k in range(5)}; p[str(lo)] = round(1 - w, 10); p[str(hi)] = round(w, 10)
    return p


def answer(score, confidence=0.9, **over):
    a = {'type': 'score', 'score': score, 'confidence': confidence, 'probabilities': dist(score)}
    a.update(over); return a


def answers(scores, confidence=0.9, dims=('problem_fit', 'transferability', 'evidence', 'decision_value', 'recency')):
    return {k: answer(s, confidence) for k, s in zip(dims, scores)}


def run(fn, *args, **kw):
    try:
        return {'ok': fn(*args, **kw)}
    except ValueError as e:
        return {'error': str(e)}


FRESH = {'score': 4, 'known': True}
PARSE = {
    'good_v1': [{'model': 'jev-1.13.0', 'answers': answers([3.2, 2.5, 3.0, 1.75, 2.0])}, None],
    'good_v2_fresh': [{'model': 'jev-1.13.0', 'answers': answers([3.2, 2.5, 3.0, 1.75])}, FRESH],
    'no_model_key': [{'answers': answers([4, 4, 4, 4, 4], 0.99)}, None],
    'tie_rounding': [{'model': 'm', 'answers': answers([2.5, 2.5, 2.5, 2.5, 2.5])}, None],
    'low_confidence': [{'model': 'm', 'answers': {**answers([3, 3, 3, 3, 3]), 'evidence': answer(3, 0.41)}}, None],
    'unknown_freshness': [{'model': 'm', 'answers': answers([3.5, 3.4, 2.2, 1.1])}, {'score': 0, 'known': False}],
    'bad_type': [{'answers': {**answers([3, 3, 3, 3, 3]), 'problem_fit': answer(3, type='label')}}, None],
    'score_out_of_range': [{'answers': {**answers([3, 3, 3, 3, 3]), 'transferability': {**answer(3), 'score': 4.5}}}, None],
    'bool_score': [{'answers': {**answers([3, 3, 3, 3, 3]), 'evidence': {**answer(1), 'score': True}}}, None],
    'confidence_out_of_range': [{'answers': {**answers([3, 3, 3, 3, 3]), 'evidence': answer(3, 1.2)}}, None],
    'missing_level': [{'answers': {**answers([3, 3, 3, 3, 3]), 'evidence': {**answer(3), 'probabilities': {'0': 0, '1': 0, '2': 0, '3': 1}}}}, None],
    'sum_off': [{'answers': {**answers([3, 3, 3, 3, 3]), 'evidence': {**answer(3), 'probabilities': {'0': 0, '1': 0, '2': 0, '3': 0.9, '4': 0.05}}}}, None],
    'expectation_off': [{'answers': {**answers([3, 3, 3, 3, 3]), 'evidence': {**answer(3), 'score': 3.2}}}, None],
    'missing_dimension': [{'answers': answers([3, 3, 3])}, None],
    'not_a_dict': [[1, 2], None],
}
FRESHNESS = {
    'no_sources': {'sources': []},
    'undated': {'sources': [{'name': 'Dashboard export', 'version': 'v3'}]},
    'age_100': {'sources': [{'name': 'a', 'version': 'export 2026-06-21'}]},
    'age_300': {'sources': [{'name': 'a', 'version': '2025-12-03'}]},
    'age_600': {'sources': [{'name': 'a', 'version': '2025-02-06'}]},
    'age_1000': {'sources': [{'name': 'a', 'version': '2024-01-03'}]},
    'age_2000': {'sources': [{'name': 'a', 'version': '2021-04-08'}]},
    'boundaries': {'sources': [{'name': 'a', 'version': '2026-04-02'}, {'name': 'b', 'version': '2025-09-29'}]},
    'age_365': {'sources': [{'name': 'a', 'version': '2025-09-29'}]},
    'age_366': {'sources': [{'name': 'a', 'version': '2025-09-28'}]},
    'today': {'sources': [{'name': 'a', 'version': '2026-09-29'}]},
    'latest_wins': {'sources': [{'name': 'a', 'version': '2019-01-01 and 2025-06-30'}, {'name': 'b', 'version': '2024-12-31'}]},
    'future': {'sources': [{'name': 'a', 'version': '2026-06-01'}, {'name': 'b', 'version': '2027-01-01'}]},
    'impossible_day': {'sources': [{'name': 'a', 'version': '2024-02-30'}, {'name': 'b', 'version': '2025-01-01'}]},
    'leap_ok': {'sources': [{'name': 'a', 'version': '2024-02-29'}]},
    'leap_bad': {'sources': [{'name': 'a', 'version': '2023-02-29'}]},
    'year_zero': {'sources': [{'name': 'a', 'version': '0000-01-01'}]},
    'glued_digits': {'sources': [{'name': 'a', 'version': '12024-01-01 and 2024-01-012'}]},
    'version_none': {'sources': [{'name': 'a', 'version': None}]},
    'no_version_key': {'sources': [{'name': 'a'}]},
}
CUSTOMER = {'problem': 'Claims bounce between teams and payouts are slow', 'buyer': 'Head of claims operations at an insurer',
            'constraints': 'Regulated data, twelve month budget cycle', 'desired_outcome': 'Faster triage with a measurable queue'}
SHORT_STORIES = [
    {'id': 'b', 'eligible': True, 'title': 'Claims triage', 'tags': ['insurer'], 'sections': {'challenge': 'Claims bounced between teams', 'customer_fit': 'Any insurer with a queue', 'approach': 'Routing model with fallback', 'outcome': 'Triage faster', 'poor_fit': ''}},
    {'id': 'a', 'eligible': True, 'title': 'Claims triage', 'tags': ['insurer'], 'sections': {'challenge': 'Claims bounced between teams', 'customer_fit': 'Any insurer with a queue', 'approach': 'Routing model with fallback', 'outcome': 'Triage faster', 'poor_fit': ''}},
    {'id': 'c', 'eligible': False, 'title': 'Claims', 'sections': {'challenge': 'claims claims payouts'}},
    {'id': 'd', 'eligible': True, 'title': 'Retail loyalty app', 'sections': {'challenge': 'Stores needed an app'}},
    {'id': 'e', 'eligible': True, 'title': 'Payouts', 'tags': [], 'sections': {'outcome': 'Payouts measurable in the queue budget'}},
]
SHORTLIST = {
    'ranked': [SHORT_STORIES, CUSTOMER, 12],
    'limit_one': [SHORT_STORIES, CUSTOMER, 1],
    'stop_words_only': [SHORT_STORIES, {'problem': 'the customer needs more work', 'buyer': 'our team leader'}, 12],
    'non_string_values': [SHORT_STORIES, {'problem': 7, 'buyer': 'claims triage'}, 12],
}


def story(i, scores_version='2026-03-01', **extra):
    s = {'id': f's{i}', 'eligible': True, 'title': f'Story {i}', 'revision': i, 'content_hash': f'h{i}', 'stage': 'Production', 'kind': 'reference',
         'sections': {'challenge': 'the client had claims bouncing between teams', 'contribution': 'I built the routing model',
                      'outcome': 'Triage fell from 40 to 12 minutes', 'customer_fit': 'Any insurer with a queue', 'limitations': 'One region only', 'poor_fit': 'Not for tiny teams'},
         'sources': [{'name': 'Ops dashboard', 'version': scores_version}], 'tags': ['insurer'], 'owner_acl': 'never sent'}
    s.update(extra); return s


def reply(scores, confidence=0.9):
    return [200, {'model': 'jev-1.13.0', 'answers': answers(scores, confidence, dims=('problem_fit', 'transferability', 'evidence', 'decision_value'))}]


class FakeResponse:
    def __init__(self, status, body): self.status, self._body = status, body
    async def json(self): return self._body
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False


class FakeSession:
    def __init__(self, replies): self.replies, self.calls = list(replies), []
    def post(self, url, json=None, headers=None, timeout=None, allow_redirects=True):
        self.calls.append({'url': url, 'body': json, 'authorization': headers.get('Authorization'), 'allow_redirects': allow_redirects, 'timeout': timeout.total})
        status, body = self.replies.pop(0)
        return FakeResponse(status, body)


RANK = {
    'three_stories': [[story(1), story(2, '2021-01-01'), story(3, 'v2 undated')], CUSTOMER,
                      [reply([3.6, 3.4, 3.0, 3.2]), reply([3.8, 3.5, 3.5, 3.5]), reply([2.0, 1.5, 3.0, 2.0])]],
    'strong_match': [[story(1), story(2)], CUSTOMER, [reply([3.8, 3.6, 3.5, 3.4]), reply([1.2, 3.0, 3.0, 3.0])]],
    'low_confidence_review_first': [[story(1)], CUSTOMER, [reply([3.9, 3.9, 3.9, 3.9], 0.69)]],
    'confidence_at_threshold': [[story(1)], CUSTOMER, [reply([3.9, 3.9, 3.9, 3.9], 0.70)]],
    'retry_then_ok': [[story(1)], CUSTOMER, [[429, {}], [529, {}], reply([3.0, 3.0, 3.0, 3.0])]],
    'retries_exhausted': [[story(1)], CUSTOMER, [[429, {}], [429, {}], [429, {}]]],
    'server_error': [[story(1)], CUSTOMER, [[500, {'error': 'x'}]]],
    'redirect': [[story(1)], CUSTOMER, [[302, {}]]],
    'bad_distribution': [[story(1)], CUSTOMER, [[200, {'answers': {'problem_fit': {'type': 'score', 'score': 3, 'confidence': 0.9, 'probabilities': {'3': 1}}}}]]],
    'customer_missing_field': [[story(1)], {**CUSTOMER, 'buyer': '  '}, []],
    'customer_none_field': [[story(1)], {**CUSTOMER, 'constraints': None}, []],
    'customer_extra_field': [[story(1)], {**CUSTOMER, 'notes': 'x'}, []],
    'customer_too_long': [[story(1)], {**CUSTOMER, 'problem': 'é' * 3001}, []],
    'too_many_stories': [[story(i) for i in range(13)], CUSTOMER, []],
    'story_too_large': [[story(1, sections={'challenge': 'x' * 70000})], CUSTOMER, []],
}


async def rank_case(stories, customer, replies):
    SLEEPS.clear()
    session = FakeSession(replies)
    ranker = jev.JevRanker(session, key='test-key', model='jev-1.13.0')
    try:
        out = {'ok': await ranker.rank(stories, customer)}
    except ValueError as e:
        out = {'error': str(e)}
    return {'stories': stories, 'customer': customer, 'replies': replies, 'calls': session.calls, 'sleeps': list(SLEEPS), 'expected': out}


async def main():
    out = {
        'today': TODAY,
        'constants': {'rubric_version': jev.RUBRIC_VERSION, 'dimensions': {k: list(v) for k, v in jev.DIMENSIONS.items()}, 'levels': jev.LEVELS},
        'request_body': {'deterministic': jev.request_body({'id': 's1', 'title': 'T'}, CUSTOMER, 'jev-1.13.0', deterministic_freshness=True),
                         'full': jev.request_body({'id': 's1', 'title': 'T'}, CUSTOMER, 'jev-1.13.0')},
        'round': [[x, round(x, 1)] for x in (0.25, 0.35, 0.45, 0.75, 2.675, 62.25, 62.35, 62.45, 71.25, 71.35, 0.05, 99.95, 12.5, 0.0, 33.333333)],
        'parse_result': {k: [data, fresh, run(jev.parse_result, data, fresh)] for k, (data, fresh) in PARSE.items()},
        'source_freshness': {k: [s, jev.source_freshness(s, FixedDate.fromisoformat(TODAY))] for k, s in FRESHNESS.items()},
        'shortlist': {k: [stories, customer, limit, run(lambda: [s['id'] for s in jev.shortlist(stories, customer, limit)])] for k, (stories, customer, limit) in SHORTLIST.items()},
        'shortlist_not_dict': run(jev.shortlist, SHORT_STORIES, ['not', 'a', 'dict']),
        'rank': {k: await rank_case(*v) for k, v in RANK.items()},
    }
    # date objects (source_freshness returns ISO strings already); the fixed-date subclass never reaches JSON.
    (Path(__file__).parent / 'jev-customer.vectors.json').write_text(json.dumps(out, ensure_ascii=False, sort_keys=False) + '\n')
    print(len(out['parse_result']), len(out['source_freshness']), len(out['shortlist']), len(out['rank']))


asyncio.run(main())
