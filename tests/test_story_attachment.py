"""Reference attachments for a consultant, a group, or a multi-consultant project.

Synthetic stories only. No provider, Entra, Hindsight, or Teams calls.
"""

import json
import time

import pytest

from atlas_voice.identity import Session
from atlas_voice.jev import request_body
from atlas_voice.story_attachment import StoryAttachmentStore, open_story_attachments
from atlas_voice.wiki import SECTIONS, WikiVault


def person(name, roles=()):
    return Session('tenant', name, name, 'csrf', time.monotonic() + 60, roles)


def story(audience='customer-anonymized', title='FICTIONAL triage pilot'):
    return {
        'title': title,
        'stage': 'Pilot',
        'kind': 'qualitative',
        'audience': audience,
        'tags': ['service-operations'],
        'sections': {key: 'Fictional ' + key + ' account, limited to one queue. Not a claimed company result.' for key in SECTIONS},
        'sources': [{
            'id': 'E1',
            'version': 'fictional-v1',
            'excerpt': 'Synthetic acceptance record, not a real customer source.',
            'supports': ['challenge', 'contribution', 'approach', 'outcome'],
        }],
        'customer_brief': 'Operations teams seeking predictable intake, with process ownership.',
    }


def registry_counts(vault):
    return {
        name: vault.db.execute('SELECT COUNT(*) AS n FROM ' + name).fetchone()['n']
        for name in ('stories', 'access', 'approvals', 'audit')
    }


def markdown_bytes(vault):
    return sorted((path.relative_to(vault.root).as_posix(), path.read_bytes()) for path in vault.root.rglob('*.md'))


@pytest.fixture
def vault(tmp_path):
    opened = WikiVault(tmp_path / 'wiki')
    yield opened
    opened.close()


@pytest.fixture
def store(tmp_path):
    opened = open_story_attachments(tmp_path / 'attachments')
    yield opened
    opened.close()


def save_story(vault, author, audience='customer-anonymized', title='FICTIONAL triage pilot'):
    return vault.save(author, story(audience, title))


def review(vault, author, saved, audience):
    reviewer = person('reviewer', ('ATLAS.Review', 'ATLAS.Publish'))
    vault.grant(author, saved['id'], reviewer.subject_key)
    kinds = ('facts',) if audience == 'internal' else ('facts', 'permission')
    for kind in kinds:
        saved = vault.approve(
            reviewer, saved['id'], saved['content_hash'], kind, 'Reviewed synthetic fixture', time.time() + 3600
        )
    return reviewer, saved


def project_of(store, *people):
    return store.create_target(
        people[0],
        {'kind': 'project', 'participants': [person.subject_key for person in people]},
    )


def test_attach_reference_keeps_markdown_and_registry(vault, store):
    author = person('author')
    saved = save_story(vault, author)
    before_files = markdown_bytes(vault)
    before_counts = registry_counts(vault)
    consultant = store.create_target(author, {'kind': 'consultant', 'participants': [author.subject_key]})
    group = store.create_target(
        author,
        {'kind': 'group', 'participants': [author.subject_key, person('colleague').subject_key]},
    )
    project = project_of(store, author, person('colleague'))
    assert [consultant['kind'], group['kind'], project['kind']] == ['consultant', 'group', 'project']
    attached = []
    for target in (consultant, group, project):
        attached.append(store.attach(author, vault, target['id'], {'story_id': saved['id'], 'consent': True}))
        again = store.attach(author, vault, target['id'], {'story_id': saved['id'], 'consent': True})
        assert again['attachment_id'] == attached[-1]['attachment_id']
    assert markdown_bytes(vault) == before_files
    assert registry_counts(vault) == before_counts
    assert all(item['reference_only'] is True and item['customer_claim'] is False for item in attached)
    assert all(item['revision'] == saved['revision'] and item['content_hash'] == saved['content_hash'] for item in attached)
    assert all(item['customer_eligible'] is False for item in attached)
    for target in (consultant, group, project):
        brief = store.eligible_stories_for_brief(author, vault, target['id'])
        assert brief['stories'] == []
        assert brief['ranks'] == 'stories'
    blob = (store.root / 'story-attachments.sqlite3').read_bytes()
    assert b'Fictional challenge account' not in blob
    assert b'FICTIONAL triage pilot' not in blob
    assert b'Synthetic acceptance record' not in blob
    columns = {row['name'] for row in store.db.execute('PRAGMA table_info(attachments)')}
    assert {'markdown', 'sections', 'rank', 'score', 'memory'} & columns == set()


def test_group_and_project_need_multiple_consultants(vault, store):
    author = person('author')
    colleague = person('colleague')
    with pytest.raises(ValueError, match='multiple consultants'):
        store.create_target(author, {'kind': 'project', 'participants': [author.subject_key]})
    with pytest.raises(ValueError, match='multiple consultants'):
        store.create_target(author, {'kind': 'group', 'participants': [author.subject_key]})
    with pytest.raises(PermissionError, match='only that consultant'):
        store.create_target(
            author,
            {'kind': 'consultant', 'participants': [author.subject_key, colleague.subject_key]},
        )
    with pytest.raises(PermissionError):
        store.create_target(
            author,
            {'kind': 'project', 'participants': [colleague.subject_key, person('third').subject_key]},
        )
    with pytest.raises(ValueError, match='consultant, group, or project'):
        store.create_target(author, {'kind': 'memory', 'participants': [author.subject_key, colleague.subject_key]})


def test_participants_are_a_set_not_a_rank_or_a_claim(store):
    author = person('author')
    colleague = person('colleague')
    keys = sorted([author.subject_key, colleague.subject_key])
    created = store.create_target(
        author,
        {'kind': 'project', 'participants': [keys[1], keys[0], keys[1]]},
    )
    assert created['participants'] == keys
    assert created['participants'] != list(reversed(keys))
    assert created['participant_order'] == 'set'
    assert created['ranking'] is None and created['score'] is None
    assert created['customer_claim'] is False
    assert created['participants_are_not_a_ranking'] is True
    assert created['participants_are_not_a_customer_claim'] is True
    assert created['participants_are_not_evidence'] is True
    assert created['private_memory_is_not_evidence'] is True
    assert created['staffing_verified'] is False
    part_columns = {row['name'] for row in store.db.execute('PRAGMA table_info(participants)')}
    assert 'rank' not in part_columns and 'position' not in part_columns and 'score' not in part_columns


@pytest.mark.parametrize('extra', [
    'rank', 'ranking', 'score', 'claim', 'customer_claim', 'memory', 'bank',
    'hindsight', 'private_memory', 'markdown', 'sections', 'content_hash',
])
def test_memory_rank_and_rewrite_fields_are_refused(vault, store, extra):
    author = person('author')
    colleague = person('colleague')
    saved = save_story(vault, author)
    before = markdown_bytes(vault)
    with pytest.raises(ValueError, match='private memory'):
        store.create_target(author, {
            'kind': 'group',
            'participants': [author.subject_key, colleague.subject_key],
            extra: 'synthetic',
        })
    target = project_of(store, author, colleague)
    with pytest.raises(ValueError, match='private memory'):
        store.attach(author, vault, target['id'], {'story_id': saved['id'], 'consent': True, extra: 'synthetic'})
    assert markdown_bytes(vault) == before
    assert store.list_attachments(author, vault, target['id']) == []


def test_consent_and_story_access_required(vault, store):
    author = person('author')
    outsider = person('outsider')
    saved = save_story(vault, author)
    target = project_of(store, author, person('colleague'))
    with pytest.raises(PermissionError, match='Explicit consent'):
        store.attach(author, vault, target['id'], {'story_id': saved['id'], 'consent': 'yes'})
    with pytest.raises(PermissionError, match='Explicit consent'):
        store.attach(author, vault, target['id'], {'story_id': saved['id'], 'consent': False})
    with pytest.raises(ValueError, match='story id and consent'):
        store.attach(author, vault, target['id'], {'story_id': saved['id']})
    with pytest.raises(PermissionError):
        store.attach(outsider, vault, target['id'], {'story_id': saved['id'], 'consent': True})
    with pytest.raises(PermissionError):
        store.list_attachments(outsider, vault, target['id'])
    colleague = person('colleague')
    with pytest.raises(PermissionError):
        store.attach(colleague, vault, target['id'], {'story_id': saved['id'], 'consent': True})
    assert vault.db.execute('SELECT COUNT(*) AS n FROM access').fetchone()['n'] == 0
    assert store.db.execute('SELECT COUNT(*) AS n FROM attachments').fetchone()['n'] == 0


def test_attachment_does_not_grant_access_or_approval(vault, store):
    author = person('author', ('ATLAS.Review', 'ATLAS.Publish'))
    colleague = person('colleague')
    saved = save_story(vault, author)
    target = project_of(store, author, colleague)
    store.attach(author, vault, target['id'], {'story_id': saved['id'], 'consent': True})
    with pytest.raises(PermissionError):
        vault.get(colleague, saved['id'])
    assert vault.get(author, saved['id'])['eligible'] is False
    assert registry_counts(vault)['approvals'] == 0
    assert registry_counts(vault)['access'] == 0


def test_redacted_when_participant_cannot_read_story(vault, store):
    author = person('author')
    colleague = person('colleague')
    saved = save_story(vault, author, title='FICTIONAL hidden pin')
    target = project_of(store, author, colleague)
    store.attach(author, vault, target['id'], {'story_id': saved['id'], 'consent': True})
    visible = store.list_attachments(author, vault, target['id'])
    hidden = store.list_attachments(colleague, vault, target['id'])
    assert visible[0]['accessible'] is True and visible[0]['title'] == 'FICTIONAL hidden pin'
    assert hidden[0]['accessible'] is False
    assert hidden[0]['customer_claim'] is False and hidden[0]['customer_eligible'] is False
    assert 'title' not in hidden[0] and 'markdown' not in hidden[0] and 'sections' not in hidden[0]
    assert 'audience' not in hidden[0] and 'registry_content_hash' not in hidden[0]
    brief = store.eligible_stories_for_brief(colleague, vault, target['id'])
    assert brief['stories'] == []
    assert colleague.subject_key in brief['participants']['subject_keys']
    assert brief['participants']['customer_claim'] is False
    assert brief['participants']['evidence'] is False


def test_withdraw_expire_and_new_revision_are_not_customer_claims(vault, store):
    author = person('author')
    colleague = person('colleague')
    saved = save_story(vault, author)
    reviewer, saved = review(vault, author, saved, 'customer-anonymized')
    target = project_of(store, author, colleague)
    attached = store.attach(author, vault, target['id'], {'story_id': saved['id'], 'consent': True})
    assert attached['customer_eligible'] is True and attached['customer_claim'] is False
    vault.db.execute('UPDATE approvals SET expires=0')
    vault.db.commit()
    expired = store.list_attachments(author, vault, target['id'])[0]
    assert expired['registry_eligible'] is False and expired['customer_eligible'] is False
    assert store.eligible_stories_for_brief(author, vault, target['id'])['stories'] == []
    vault.db.execute('UPDATE approvals SET expires=?', (time.time() + 3600,))
    vault.db.commit()
    current = vault.get(author, saved['id'])
    vault.withdraw(author, saved['id'], current['content_hash'])
    withdrawn = store.list_attachments(author, vault, target['id'])[0]
    assert withdrawn['registry_withdrawn'] is True and withdrawn['customer_eligible'] is False
    assert store.eligible_stories_for_brief(author, vault, target['id'])['stories'] == []
    assert markdown_bytes(vault)
    with pytest.raises(ValueError, match='withdrawn'):
        store.attach(author, vault, target['id'], {'story_id': saved['id'], 'consent': True})
    revived = vault.save(author, story(), saved['id'], current['content_hash'])
    assert revived['revision'] == saved['revision'] + 1
    stale = store.list_attachments(author, vault, target['id'])[0]
    assert stale['pinned_current'] is False and stale['customer_eligible'] is False and 'title' not in stale
    assert len(markdown_bytes(vault)) == 2
    reviewer, revived = review(vault, author, revived, 'customer-anonymized')
    fresh = store.attach(author, vault, target['id'], {'story_id': revived['id'], 'consent': True})
    assert fresh['attachment_id'] != attached['attachment_id']
    assert fresh['revision'] == revived['revision'] and fresh['pinned_current'] is True
    brief = store.eligible_stories_for_brief(author, vault, target['id'])
    assert [item['id'] for item in brief['stories']] == [revived['id']]
    assert brief['stories'][0]['content_hash'] == revived['content_hash']
    assert len(markdown_bytes(vault)) == 2


def test_internal_story_stays_off_the_customer_brief(vault, store):
    author = person('author')
    saved = save_story(vault, author, audience='internal', title='FICTIONAL internal note')
    reviewer, saved = review(vault, author, saved, 'internal')
    assert saved['eligible'] is True and saved['audience'] == 'internal'
    target = project_of(store, author, person('colleague'))
    attached = store.attach(author, vault, target['id'], {'story_id': saved['id'], 'consent': True})
    assert attached['registry_eligible'] is True and attached['customer_eligible'] is False
    assert attached['customer_claim'] is False
    assert store.eligible_stories_for_brief(author, vault, target['id'])['stories'] == []


def test_detach_drops_the_reference_only(vault, store):
    author = person('author')
    colleague = person('colleague')
    reviewer = person('reader', ('ATLAS.Review',))
    saved = save_story(vault, author)
    vault.grant(author, saved['id'], colleague.subject_key)
    vault.grant(author, saved['id'], reviewer.subject_key)
    before = markdown_bytes(vault)
    target = project_of(store, author, colleague)
    by_author = store.attach(author, vault, target['id'], {'story_id': saved['id'], 'consent': True})
    with pytest.raises(PermissionError, match='attacher or the story owner'):
        store.detach(colleague, vault, by_author['attachment_id'])
    with pytest.raises(PermissionError, match='attacher or the story owner'):
        store.detach(reviewer, vault, by_author['attachment_id'])
    assert store.list_attachments(author, vault, target['id'])[0]['detached'] is False
    same_pin = store.attach(colleague, vault, target['id'], {'story_id': saved['id'], 'consent': True})
    assert same_pin['attachment_id'] == by_author['attachment_id']
    assert store.db.execute(
        'SELECT attached_by FROM attachments WHERE id=?', (by_author['attachment_id'],)
    ).fetchone()['attached_by'] == author.subject_key
    store.detach(author, vault, by_author['attachment_id'])
    by_colleague = store.attach(colleague, vault, target['id'], {'story_id': saved['id'], 'consent': True})
    assert by_colleague['attachment_id'] == by_author['attachment_id'] and by_colleague['detached'] is False
    dropped = store.detach(author, vault, by_colleague['attachment_id'])
    assert dropped['detached'] is True and dropped['customer_eligible'] is False
    assert store.list_attachments(author, vault, target['id']) == []
    assert vault.get(author, saved['id'])['withdrawn'] is False
    restored = store.attach(colleague, vault, target['id'], {'story_id': saved['id'], 'consent': True})
    assert restored['detached'] is False
    store.detach(colleague, vault, restored['attachment_id'])
    assert store.list_attachments(author, vault, target['id']) == []
    assert vault.get(author, saved['id'])['withdrawn'] is False
    assert markdown_bytes(vault) == before


def test_brief_passes_stories_not_consultants_to_jev_shape(vault, store):
    author = person('author')
    colleague = person('colleague')
    third = person('third')
    first = save_story(vault, author, title='FICTIONAL alpha queue')
    second = save_story(vault, author, title='FICTIONAL beta queue')
    _, first = review(vault, author, first, 'customer-anonymized')
    _, second = review(vault, author, second, 'customer-anonymized')
    target = store.create_target(author, {
        'kind': 'group',
        'participants': [author.subject_key, colleague.subject_key, third.subject_key],
    })
    store.attach(author, vault, target['id'], {'story_id': first['id'], 'consent': True})
    store.attach(author, vault, target['id'], {'story_id': second['id'], 'consent': True})
    brief = store.eligible_stories_for_brief(author, vault, target['id'])
    assert [item['id'] for item in brief['stories']] == sorted([first['id'], second['id']])
    assert brief['consultant_ranking'] is None and brief['ranks'] == 'stories'
    assert brief['private_memory_is_not_evidence'] is True
    assert 'Rank stories only' in brief['notice']
    assert brief['participants']['subject_keys'] == sorted([
        author.subject_key, colleague.subject_key, third.subject_key
    ])
    assert brief['participants']['ranking'] is None
    customer = {key: 'Synthetic ' + key + ' for a fictional buyer.' for key in (
        'problem', 'buyer', 'constraints', 'desired_outcome')}
    for item in brief['stories']:
        assert set(item) == {
            'id', 'title', 'revision', 'content_hash', 'sections', 'sources', 'tags', 'stage', 'kind'
        }
        body = request_body(item, customer, 'fixture-not-a-live-model', deterministic_freshness=True)
        encoded = json.dumps(body)
        assert author.subject_key not in encoded
        assert colleague.subject_key not in encoded
        assert third.subject_key not in encoded
        assert 'participant' not in body['state']['eligible_story']
        assert 'owner' not in body['state']['eligible_story']
        assert 'memory' not in body['state']['eligible_story']
        assert 'rank' not in body['state']['eligible_story']


def test_symlink_store_refused(tmp_path):
    root = tmp_path / 'attachments'
    root.mkdir()
    (root / 'story-attachments.sqlite3').symlink_to(tmp_path / 'elsewhere.sqlite3')
    with pytest.raises(ValueError, match='symlink'):
        StoryAttachmentStore(root)
