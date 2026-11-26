"""The export index keeps one link when a story title contains a line break."""
import io
import time
import zipfile

from atlas_voice.identity import Session
from atlas_voice.wiki import SECTIONS, WikiVault
from atlas_voice.wiki_export import export_view


def person(name, roles=()):
    return Session('tenant', name, name, 'csrf', time.monotonic() + 60, roles)


def story(title):
    return {
        'title': title,
        'stage': 'Pilot',
        'kind': 'qualitative',
        'audience': 'internal',
        'tags': ['service-operations'],
        'sections': {
            k: 'Fictional ' + k + ' account, limited to one queue. Not a claimed company result.'
            for k in SECTIONS
        },
        'sources': [{
            'id': 'E1',
            'version': 'fictional-v1',
            'excerpt': 'Synthetic acceptance record, not a real customer source.',
            'supports': ['challenge', 'contribution', 'approach', 'outcome'],
        }],
        'customer_brief': 'Operations teams seeking predictable intake, with process ownership.',
    }


def test_export_index_keeps_a_title_line_break_inside_one_link(tmp_path):
    vault = WikiVault(tmp_path / 'wiki')
    try:
        title = 'FICTIONAL pilot\u2028\v\f\x85\u2029- [click](http://evil.example)'
        author = person('author')
        reviewer = person('reviewer', ('ATLAS.Review', 'ATLAS.Publish'))
        saved = vault.save(author, story(title))
        vault.grant(author, saved['id'], reviewer.subject_key)
        saved = vault.approve(
            reviewer, saved['id'], saved['content_hash'], 'facts',
            'Reviewed synthetic fixture', time.time() + 3600)
        archive = zipfile.ZipFile(io.BytesIO(export_view(vault, author, 'internal')))
        index = archive.read('index.md').decode('utf-8')
        topic = archive.read('topics/service-operations.md').decode('utf-8')
    finally:
        vault.close()
    breaks = ('\r', '\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029')
    items = [line for line in index.splitlines() if line.startswith('- [')]
    topic_items = [line for line in topic.splitlines() if line.startswith('- [')]
    assert len(items) == 1
    assert len(topic_items) == 1
    target = '](stories/' + saved['id'] + '.md)'
    assert target in items[0]
    assert '](http://evil.example)' not in index
    assert 'http://evil.example' in items[0]
    for text in (items[0], topic_items[0]):
        for br in breaks:
            assert br not in text
