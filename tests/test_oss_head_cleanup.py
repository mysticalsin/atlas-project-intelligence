"""HEAD must not carry the personal mailbox or the live deployment identifiers.

The needles are concatenated so this file is not a match for git grep.
History is out of scope: the search is HEAD only.
"""
import os
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

MAILBOX = "tony.walteur" + "@" + "gmail.com"
HOST = "atlas." + "tony-walteur." + "workers.dev"
TEAM = "tony-walteur." + "cloudflareaccess.com"
AUD = "fc05e3d966db92b0" + "3ed3bf38b31e5c52" + "54e1508bb0e09082" + "5a56ce12a933f386"


def grep(needle):
    return subprocess.run(
        ["git", "grep", "-F", "-n", "-e", needle, "HEAD"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def locations(found):
    paths = []
    for line in found.stdout.splitlines():
        parts = line.split(":", 3)
        paths.append(parts[1] + ":" + parts[2] if len(parts) >= 3 else "match")
    return paths


def test_mailbox_absent_on_head():
    found = grep(MAILBOX)
    code = found.returncode
    where = locations(found)
    assert code == 1 and where == [], "mailbox still on HEAD: " + ", ".join(where)


def test_deployment_identifiers_absent_on_head():
    hits = []
    for needle in (HOST, TEAM, AUD):
        found = grep(needle)
        code = found.returncode
        where = locations(found)
        if code != 1 or where:
            hits.append(needle[:4] + " len=" + str(len(needle)) + " at " + ", ".join(where))
    assert hits == [], "; ".join(hits)


def test_git_publish_refuses_unset_email(tmp_path):
    repo = tmp_path / "repo"
    home = tmp_path / "home"
    repo.mkdir()
    home.mkdir()
    (repo / "scripts").mkdir()
    shutil.copy(ROOT / "scripts" / "git_publish.sh", repo / "scripts" / "git_publish.sh")
    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
    })
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, env=env, check=True)
    completed = subprocess.run(
        ["bash", "scripts/git_publish.sh"],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    email = subprocess.run(
        ["git", "config", "--get", "user.email"],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 1, completed.stderr[-500:]
    assert "user.email" in completed.stderr
    assert email.stdout.strip() == ""
