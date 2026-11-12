"""The pytest process is a dev run: the meter is off unless a test sets it."""
import os

os.environ.setdefault('LEDGER_MODE', 'off')
