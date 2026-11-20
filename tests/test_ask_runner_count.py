"""Count argument of tests/run_ask_browser_stamped.sh.

One table. Invalid shapes exit 2 with a clear error before Python starts
and without truncating the log. Canonical integers 1..32, and an omitted
count (8), keep the existing loop. A failed run still exits 1.
"""
import os
import signal
import subprocess
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'tests' / 'run_ask_browser_stamped.sh'
MAX = 32
MESSAGE = "invalid count: '{value}' is not an integer from 1 to {cap}"

# (name, argument or None when the count is omitted, expected runs or 'reject')
TABLE = (
    ('zero', '0', 'reject'),
    ('neg', '-1', 'reject'),
    ('neg-far', '-5', 'reject'),
    ('neg-zero', '-0', 'reject'),
    ('double-zero', '00', 'reject'),
    ('leading-zero', '08', 'reject'),
    ('float', '1.5', 'reject'),
    ('float-whole', '8.0', 'reject'),
    ('float-half', '0.5', 'reject'),
    ('float-zero', '0.0', 'reject'),
    ('plus', '+8', 'reject'),
    ('plus-zero', '+0', 'reject'),
    ('space-before', ' 8', 'reject'),
    ('space-after', '8 ', 'reject'),
    ('tab', '8\t', 'reject'),
    ('word', 'abc', 'reject'),
    ('empty', '', 'reject'),
    ('blank', ' ', 'reject'),
    ('nan', 'NaN', 'reject'),
    ('nan-lower', 'nan', 'reject'),
    ('infinity', 'Infinity', 'reject'),
    ('bool', 'true', 'reject'),
    ('scientific', '1e2', 'reject'),
    ('hex', '0x10', 'reject'),
    ('underscore', '1_000', 'reject'),
    ('just-over-cap', '33', 'reject'),
    ('hundred', '100', 'reject'),
    ('huge', '1000000', 'reject'),
    ('overflow-digits', '9999999999999999999', 'reject'),
    ('min', '1', 1),
    ('explicit-default', '8', 8),
    ('cap', '32', 32),
    ('omitted', None, 8),
)

STUB = """#!/bin/sh
printf '%s\\n' "$*" >> "$ATLAS_ASK_STUB_LOG"
if [ -n "${ATLAS_ASK_STUB_FAIL_AT:-}" ]; then
  n=$(wc -l < "$ATLAS_ASK_STUB_LOG" | tr -d ' ')
  if [ "$n" = "$ATLAS_ASK_STUB_FAIL_AT" ]; then
    exit 1
  fi
fi
exit 0
"""

SLOW = {'infinity', 'huge', 'overflow-digits'}


def run(count, *, fail_at=None, timeout=20):
    with tempfile.TemporaryDirectory() as raw:
        td = Path(raw)
        log = td / 'ask.log'
        log.write_text('KEEP\n')
        stub_log = td / 'stub.log'
        stub_log.write_text('')
        bindir = td / 'bin'
        bindir.mkdir()
        stub = bindir / 'python3'
        stub.write_text(STUB)
        stub.chmod(0o755)
        env = os.environ.copy()
        env['PATH'] = str(bindir) + os.pathsep + env.get('PATH', '')
        env['ATLAS_ASK_STUB_LOG'] = str(stub_log)
        if fail_at is not None:
            env['ATLAS_ASK_STUB_FAIL_AT'] = str(fail_at)
        cmd = [str(SCRIPT), str(log)] if count is None else [str(SCRIPT), str(log), count]
        proc = subprocess.Popen(
            cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, start_new_session=True)
        try:
            out, err = proc.communicate(timeout=timeout)
            code, timed_out = proc.returncode, False
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            out, err = proc.communicate()
            code, timed_out = None, True
        calls = [line for line in stub_log.read_text().splitlines() if line]
        body = log.read_text() if log.exists() else ''
        return code, timed_out, out, err, calls, body


@pytest.mark.parametrize('name,count,expect', TABLE, ids=[row[0] for row in TABLE])
def test_count_table(name, count, expect):
    code, timed_out, _out, err, calls, body = run(count, timeout=3 if name in SLOW else 20)
    if expect == 'reject':
        assert not timed_out, name
        assert code == 2, (name, code, err)
        assert err == MESSAGE.format(value=count, cap=MAX) + '\n', (name, err)
        assert calls == [], (name, calls)
        assert body == 'KEEP\n', (name, body)
        assert 'seq:' not in err
        return
    assert not timed_out and code == 0, (name, code, err)
    assert calls == ['tests/ask_browser.py'] * expect, (name, len(calls))
    assert body.count('exit=0\n') == expect
    assert f'=== ask_browser run {expect}/{expect} ===' in body
    assert 'HEAD=' in body and 'TREE=' in body
    assert 'KEEP' not in body


def test_mixed_run_exits_1():
    code, timed_out, _out, err, calls, body = run('2', fail_at=2)
    assert not timed_out and code == 1, (code, err)
    assert calls == ['tests/ask_browser.py', 'tests/ask_browser.py']
    assert 'exit=0\n' in body and 'exit=1\n' in body
    assert '=== ask_browser run 2/2 ===' in body


def test_missing_log_is_usage_not_an_invalid_count():
    proc = subprocess.run([str(SCRIPT)], cwd=ROOT, capture_output=True, text=True, timeout=5)
    assert proc.returncode == 2
    assert 'usage:' in proc.stderr
    assert 'invalid count' not in proc.stderr
