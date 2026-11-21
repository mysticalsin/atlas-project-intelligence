"""Open-source readiness of the working tree.

History is out of scope: gitleaks here scans files, not commits.
The binary must be on PATH (or GITLEAKS_BIN). A missing binary fails the test.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEDIA = re.compile(r"docs/media/[\w./-]+\.(?:gif|png|webp|jpe?g)")


def test_license_file_exists():
    assert (ROOT / "LICENSE").is_file(), "LICENSE is missing"


def test_readme_media_links_resolve():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    links = MEDIA.findall(readme)
    assert links, "README must link to at least one file under docs/media"
    missing = [link for link in links if not (ROOT / link).is_file()]
    assert not missing, "README media links do not exist: " + ", ".join(missing)
    for link in links:
        assert (ROOT / link).stat().st_size < 3_000_000, link + " is 3 MB or larger"


def test_gitleaks_working_tree_clean():
    binary = os.environ.get("GITLEAKS_BIN") or shutil.which("gitleaks")
    assert binary, "gitleaks is not on PATH and GITLEAKS_BIN is unset"
    config = ROOT / ".gitleaks.toml"
    assert config.is_file(), ".gitleaks.toml is missing"
    completed = subprocess.run(
        [
            binary, "detect", "--no-git", "--redact", "--no-banner",
            "--log-level", "error", "--report-format", "json", "--report-path", "-",
            "--exit-code", "0", "--config", str(config), str(ROOT),
        ],
        cwd=ROOT, capture_output=True, text=True, check=False,
    )
    assert completed.returncode == 0, completed.stderr[-500:]
    findings = json.loads(completed.stdout or "[]")
    summary = [
        {"rule": item.get("RuleID"), "file": item.get("File"), "line": item.get("StartLine")}
        for item in findings
    ]
    assert summary == [], "gitleaks working-tree findings: " + json.dumps(summary)
