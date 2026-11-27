"""Stubs for a multi-instance gateway. They refuse to connect.

Today one process keeps sessions, locks, and throttles in memory, and the wiki
registry in a local SQLite file with Markdown revisions on the local disk.
More than one instance needs Postgres for that shared state and Blob storage
for the immutable revisions. These adapters name that contract. They do not
open a socket, retain a connection string, or talk to Key Vault.
"""


class AdapterRefused(RuntimeError):
    """A multi-instance adapter was asked to connect and refused."""


class PostgresAdapter:
    """Shared sessions, locks, throttles, and the wiki registry.

    Not wired into the running gateway. ``connect`` and every operation refuse.
    """

    def __init__(self, dsn=''):
        if not isinstance(dsn, str):
            raise TypeError('Postgres DSN must be a string.')
        # The argument is not retained. configured is only whether a string was passed.
        self.configured = bool(dsn)

    def connect(self):
        raise AdapterRefused('Postgres adapter refuses to connect.')

    def session(self, key):
        self.connect()

    def lock(self, name):
        self.connect()

    def throttle(self, key):
        self.connect()

    def registry(self):
        self.connect()


class BlobAdapter:
    """Immutable Markdown revisions for more than one instance.

    Not wired into the running gateway. ``connect`` and every operation refuse.
    """

    def __init__(self, url=''):
        if not isinstance(url, str):
            raise TypeError('Blob URL must be a string.')
        self.configured = bool(url)

    def connect(self):
        raise AdapterRefused('Blob adapter refuses to connect.')

    def put(self, name, body):
        self.connect()

    def get(self, name):
        self.connect()
