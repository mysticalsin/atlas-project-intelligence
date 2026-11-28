"""Attach an immutable success-story revision to a consultant, a group, or a project.

The gateway or the wiki registry calls StoryAttachmentStore. An attachment is a
reference: story id, revision, and content hash. It does not rewrite the
Markdown file and it does not change access, review, expiry, or withdrawal.
Those stay on the live registry. A later read asks the registry again.

A consultant target lists that consultant alone. A group or a project lists
the consultants involved. That list is a set. It is not a ranking and it is
not a customer claim. Private memory is not evidence and cannot be attached.
"""

import os
import re
import sqlite3
import time
import uuid
from pathlib import Path

from atlas_voice.wiki import valid_id

KINDS = ('consultant', 'group', 'project')
SUBJECT = re.compile(r'[a-f0-9]{32}\Z')
DIGEST = re.compile(r'[a-f0-9]{64}\Z')
CUSTOMER_AUDIENCE = 'customer-anonymized'
MAX_PARTICIPANTS = 24
SCOPED_STORY = ('id', 'title', 'revision', 'content_hash', 'sections', 'sources', 'tags', 'stage', 'kind')
BRIEF_NOTICE = (
    'Eligible story references for a customer brief. '
    'Rank stories only. Participants are not a ranking and not a customer claim. '
    'Private memory is not evidence.'
)


def stamp():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def open_story_attachments(root):
    """Open the reference store the gateway or registry can call."""
    return StoryAttachmentStore(root)


def subject_key(actor):
    key = getattr(actor, 'subject_key', None)
    if not isinstance(key, str) or SUBJECT.fullmatch(key) is None:
        raise PermissionError('A server-derived subject key is required')
    return key


def clean_participants(values):
    if isinstance(values, (str, bytes)) or not isinstance(values, (list, tuple, set, frozenset)):
        raise ValueError('Participants must be a set of subject keys')
    keys = []
    for item in values:
        if not isinstance(item, str) or SUBJECT.fullmatch(item) is None:
            raise ValueError('A participant must be a server-derived subject key')
        keys.append(item)
    unique = sorted(set(keys))
    if not unique:
        raise ValueError('Participants are required')
    if len(unique) > MAX_PARTICIPANTS:
        raise ValueError('Too many participants')
    return unique


def pinned_current(record, row):
    return record.get('revision') == row['revision'] and record.get('content_hash') == row['content_hash']


def customer_eligible(record, row):
    """Registry permission for this pin. The attachment itself is not a claim."""
    if row['detached']:
        return False
    return bool(
        pinned_current(record, row)
        and record.get('eligible') is True
        and not record.get('withdrawn')
        and record.get('audience') == CUSTOMER_AUDIENCE
    )


class StoryAttachmentStore:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.root / 'story-attachments.sqlite3'
        if path.is_symlink():
            raise ValueError('Attachment store must not be a symlink')
        self.db = sqlite3.connect(path, check_same_thread=False)
        os.chmod(path, 0o600)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(
            '''PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS targets(
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL CHECK(kind IN ('consultant','group','project')),
              created_by TEXT NOT NULL,
              created_at TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS participants(
              target_id TEXT NOT NULL,
              subject_key TEXT NOT NULL,
              PRIMARY KEY(target_id, subject_key),
              FOREIGN KEY(target_id) REFERENCES targets(id));
            CREATE TABLE IF NOT EXISTS attachments(
              id TEXT PRIMARY KEY,
              target_id TEXT NOT NULL,
              story_id TEXT NOT NULL,
              revision INTEGER NOT NULL,
              content_hash TEXT NOT NULL,
              attached_by TEXT NOT NULL,
              attached_at TEXT NOT NULL,
              detached INTEGER NOT NULL DEFAULT 0 CHECK(detached IN (0,1)),
              FOREIGN KEY(target_id) REFERENCES targets(id));
            CREATE UNIQUE INDEX IF NOT EXISTS attachment_pin
              ON attachments(target_id, story_id, revision, content_hash);
            CREATE TABLE IF NOT EXISTS attachment_audit(
              id INTEGER PRIMARY KEY,
              target_id TEXT,
              attachment_id TEXT,
              actor TEXT NOT NULL,
              action TEXT NOT NULL,
              at TEXT NOT NULL);
            '''
        )
        self.db.commit()

    def close(self):
        self.db.close()

    def _audit(self, actor_key, action, target_id, attachment_id=None):
        self.db.execute(
            'INSERT INTO attachment_audit(target_id,attachment_id,actor,action,at) VALUES(?,?,?,?,?)',
            (target_id, attachment_id, actor_key, action, stamp()),
        )

    def _target_row(self, target_id):
        if not valid_id(target_id):
            raise ValueError('Unknown target')
        row = self.db.execute('SELECT * FROM targets WHERE id=?', (target_id,)).fetchone()
        if row is None:
            raise ValueError('Unknown target')
        return row

    def _participants(self, target_id):
        rows = self.db.execute(
            'SELECT subject_key FROM participants WHERE target_id=? ORDER BY subject_key',
            (target_id,),
        ).fetchall()
        return [row['subject_key'] for row in rows]

    def _require_participant(self, target_id, actor_key):
        self._target_row(target_id)
        if actor_key not in self._participants(target_id):
            raise PermissionError('Only a participant can use this target')

    def _owner(self, vault, story_id):
        if not valid_id(story_id):
            return None
        row = vault.db.execute('SELECT owner FROM stories WHERE id=?', (story_id,)).fetchone()
        if row is None or not isinstance(row['owner'], str):
            return None
        return row['owner']

    def _present(self, row, record):
        view = {
            'attachment_id': row['id'],
            'target_id': row['target_id'],
            'story_id': row['story_id'],
            'revision': row['revision'],
            'content_hash': row['content_hash'],
            'detached': bool(row['detached']),
            'reference_only': True,
            'customer_claim': False,
            'private_memory': False,
            'accessible': record is not None,
            'customer_eligible': False,
            'pinned_current': False,
        }
        if record is None:
            return view
        current = pinned_current(record, row)
        view.update({
            'pinned_current': current,
            'registry_revision': record['revision'],
            'registry_content_hash': record['content_hash'],
            'registry_withdrawn': bool(record['withdrawn']),
            'registry_eligible': record.get('eligible') is True,
            'audience': record.get('audience'),
            'customer_eligible': customer_eligible(record, row),
        })
        if current:
            view['title'] = record.get('title')
            view['review_states'] = list(record.get('review_states') or [])
        return view

    def create_target(self, actor, spec):
        if not isinstance(spec, dict) or set(spec) != {'kind', 'participants'}:
            raise ValueError('A target needs a kind and participants, not a rank, a customer claim, or private memory')
        kind = spec['kind']
        if kind not in KINDS:
            raise ValueError('Target kind must be consultant, group, or project')
        actor_key = subject_key(actor)
        participants = clean_participants(spec['participants'])
        if kind == 'consultant' and participants != [actor_key]:
            raise PermissionError('A consultant target lists only that consultant')
        if kind == 'group' and len(participants) < 2:
            raise ValueError('A group needs multiple consultants')
        if kind == 'project' and len(participants) < 2:
            raise ValueError('A project needs multiple consultants')
        if actor_key not in participants:
            raise PermissionError('Only a participant can open a group or project target')
        target_id = uuid.uuid4().hex
        with self.db:
            self.db.execute(
                'INSERT INTO targets(id,kind,created_by,created_at) VALUES(?,?,?,?)',
                (target_id, kind, actor_key, stamp()),
            )
            self.db.executemany(
                'INSERT INTO participants(target_id,subject_key) VALUES(?,?)',
                [(target_id, key) for key in participants],
            )
            self._audit(actor_key, 'create-target', target_id)
        return self.target(actor, target_id)

    def target(self, actor, target_id):
        actor_key = subject_key(actor)
        self._require_participant(target_id, actor_key)
        row = self._target_row(target_id)
        return {
            'id': target_id,
            'kind': row['kind'],
            'participants': self._participants(target_id),
            'participant_order': 'set',
            'ranking': None,
            'score': None,
            'customer_claim': False,
            'participants_are_not_a_ranking': True,
            'participants_are_not_a_customer_claim': True,
            'participants_are_not_evidence': True,
            'private_memory_is_not_evidence': True,
            'staffing_verified': False,
        }

    def attach(self, actor, vault, target_id, spec):
        if not isinstance(spec, dict) or set(spec) != {'story_id', 'consent'}:
            raise ValueError(
                'An attachment is a story id and consent. It cannot rewrite the story, rank consultants, add a customer claim, or carry private memory'
            )
        if spec['consent'] is not True:
            raise PermissionError('Explicit consent is required to attach a story reference')
        story_id = spec['story_id']
        if not valid_id(story_id):
            raise ValueError('Unknown story')
        actor_key = subject_key(actor)
        self._require_participant(target_id, actor_key)
        record = vault.get(actor, story_id)
        if record.get('withdrawn'):
            raise ValueError('A withdrawn story cannot be attached')
        revision = record.get('revision')
        digest = record.get('content_hash')
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise ValueError('Registry revision is required')
        if not isinstance(digest, str) or DIGEST.fullmatch(digest) is None:
            raise ValueError('Registry content hash is required')
        with self.db:
            found = self.db.execute(
                'SELECT * FROM attachments WHERE target_id=? AND story_id=? AND revision=? AND content_hash=?',
                (target_id, story_id, revision, digest),
            ).fetchone()
            if found is not None and not found['detached']:
                attachment_id = found['id']
            elif found is not None:
                attachment_id = found['id']
                self.db.execute(
                    'UPDATE attachments SET detached=0, attached_by=?, attached_at=? WHERE id=?',
                    (actor_key, stamp(), attachment_id),
                )
                self._audit(actor_key, 'reattach-reference', target_id, attachment_id)
            else:
                attachment_id = uuid.uuid4().hex
                self.db.execute(
                    '''INSERT INTO attachments(
                         id,target_id,story_id,revision,content_hash,attached_by,attached_at,detached)
                       VALUES(?,?,?,?,?,?,?,0)''',
                    (attachment_id, target_id, story_id, revision, digest, actor_key, stamp()),
                )
                self._audit(actor_key, 'attach-reference', target_id, attachment_id)
        stored = self.db.execute('SELECT * FROM attachments WHERE id=?', (attachment_id,)).fetchone()
        return self._present(stored, record)

    def detach(self, actor, vault, attachment_id):
        if not valid_id(attachment_id):
            raise ValueError('Unknown attachment')
        row = self.db.execute('SELECT * FROM attachments WHERE id=?', (attachment_id,)).fetchone()
        if row is None or row['detached']:
            raise ValueError('Unknown attachment')
        actor_key = subject_key(actor)
        record = vault.get(actor, row['story_id'])
        owner = self._owner(vault, row['story_id'])
        if actor_key != row['attached_by'] and actor_key != owner:
            raise PermissionError('Only the attacher or the story owner can detach a reference')
        with self.db:
            self.db.execute('UPDATE attachments SET detached=1 WHERE id=? AND detached=0', (attachment_id,))
            self._audit(actor_key, 'detach-reference', row['target_id'], attachment_id)
        stored = self.db.execute('SELECT * FROM attachments WHERE id=?', (attachment_id,)).fetchone()
        return self._present(stored, record)

    def list_attachments(self, actor, vault, target_id):
        actor_key = subject_key(actor)
        self._require_participant(target_id, actor_key)
        rows = self.db.execute(
            'SELECT * FROM attachments WHERE target_id=? AND detached=0 ORDER BY story_id, revision, id',
            (target_id,),
        ).fetchall()
        views = []
        for row in rows:
            try:
                record = vault.get(actor, row['story_id'])
            except PermissionError:
                record = None
            views.append(self._present(row, record))
        return views

    def eligible_stories_for_brief(self, actor, vault, target_id):
        """Live eligible pins for a customer brief. Stories only, never consultants."""
        actor_key = subject_key(actor)
        self._require_participant(target_id, actor_key)
        rows = self.db.execute(
            'SELECT * FROM attachments WHERE target_id=? AND detached=0 ORDER BY story_id, revision',
            (target_id,),
        ).fetchall()
        chosen = {}
        for row in rows:
            try:
                record = vault.get(actor, row['story_id'])
            except PermissionError:
                continue
            if not customer_eligible(record, row):
                continue
            if any(key not in record for key in SCOPED_STORY):
                raise ValueError('Registry story is missing a field required for a customer brief')
            scoped = {key: record[key] for key in SCOPED_STORY}
            chosen[scoped['id']] = scoped
        return {
            'stories': [chosen[key] for key in sorted(chosen)],
            'ranks': 'stories',
            'consultant_ranking': None,
            'notice': BRIEF_NOTICE,
            'participants': {
                'subject_keys': self._participants(target_id),
                'order': 'set',
                'ranking': None,
                'customer_claim': False,
                'evidence': False,
            },
            'private_memory_is_not_evidence': True,
        }
