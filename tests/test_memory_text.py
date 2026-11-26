"""A blank memory item is not text.

A null field must not drop the other recalled preferences, and it must not
become the word None. Synthetic preferences only. No Hindsight call.
"""
import time

import pytest
from dataclasses import replace

from atlas_voice.config import Config
from atlas_voice.identity import Session
from atlas_voice.memory import PrivateMemory


def person():
    return Session('tenant', 'ada', 'Ada', 'csrf', time.monotonic() + 60)


def memory(client):
    return PrivateMemory(
        replace(Config(), hindsight_url='https://memory.example', bank_secret='z' * 32),
        client_factory=client,
    )


class BlankRecall:
    async def arecall(self, **kwargs):
        return {'results': [{'text': None}, {'text': 'Keep questions short'}]}

    async def aclose(self):
        return None


class BlankItem:
    def __init__(self, text):
        self.text = text


class ObjectRecall:
    async def arecall(self, **kwargs):
        return type('Response', (), {'results': [BlankItem(None), BlankItem('One question at a time.')]})()

    async def aclose(self):
        return None


@pytest.mark.asyncio
async def test_a_null_memory_item_keeps_the_other_preference():
    recalled = await memory(BlankRecall).recall(person())
    assert 'Keep questions short' in recalled
    assert 'None' not in recalled


@pytest.mark.asyncio
async def test_a_null_text_attribute_keeps_the_other_preference():
    recalled = await memory(ObjectRecall).recall(person())
    assert recalled == 'One question at a time.'


@pytest.mark.asyncio
async def test_a_missing_continuity_body_is_blank():
    opened = memory(BlankRecall)

    async def document(subject, delete=False):
        return type('Document', (), {'original_text': None})()

    opened._document = document
    assert await opened.get_continuity(person()) == ''


@pytest.mark.asyncio
async def test_a_continuity_string_stays_bounded():
    opened = memory(BlankRecall)

    async def document(subject, delete=False):
        return type('Document', (), {'original_text': 'K' * 4001})()

    opened._document = document
    assert await opened.get_continuity(person()) == 'K' * 4000
