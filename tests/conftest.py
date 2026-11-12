"""The pytest process is a dev run: the meter is off unless a test sets it."""
import os

os.environ.setdefault('LEDGER_MODE', 'off')
os.environ.setdefault('ATLAS_AUTH', 'local')
os.environ.setdefault('ATLAS_BIND', '127.0.0.1')
