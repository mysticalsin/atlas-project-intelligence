"""Bounded concurrent interviews for one gateway process.

Replaces the single pilot lock. The limit bounds provider spend and gateway load;
one active interview per authenticated subject stops a user holding several slots.
Single event loop: check-and-take has no await, so no lock is needed.
"""


BUSY = {'full': 'All interview slots are in use. Try again shortly.',
        'duplicate': 'You already have an interview open. End it before starting another.'}


class VoiceCapacity:
    def __init__(self, limit=1):
        if not isinstance(limit, int) or limit < 1:
            raise ValueError('Interview capacity must be a positive integer.')
        self.limit = limit
        self.holders = set()

    def locked(self):
        """True when no further interview can start (compatible with the former Lock API)."""
        return len(self.holders) >= self.limit

    def try_acquire(self, subject_key):
        """Return 'ok', 'full' or 'duplicate'. Takes a slot only on 'ok'."""
        # The more specific answer first: a user who already holds a slot is told so even when full.
        if subject_key in self.holders:
            return 'duplicate'
        if self.locked():
            return 'full'
        self.holders.add(subject_key)
        return 'ok'

    def release(self, subject_key):
        self.holders.discard(subject_key)
