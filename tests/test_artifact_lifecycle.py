"""Pins the page-pipeline facts the artifact reducer must keep.

These checks are green on main before the reducer exists. They stay green
after it lands, because that reducer has no caller and does not rewrite the
committed pin.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIN = ROOT / "deploy/cloudflare-edge/generated/PAGE_SHA256.txt"
CALLERS = (
    ROOT / "build.py",
    ROOT / "scripts/verify_page_build.sh",
    ROOT / "deploy/cloudflare-edge/deploy.sh",
    ROOT / "scripts/check_handoff.py",
)

# The committed line on main 8b0972ec. Two spaces, then a trailing newline.
PIN_BYTES = (
    b"7a290026b91b2e3f732b31146927a158bb30243ed2bea6fd74f517ae31dd7d4a"
    b"  924015  ATLAS_HOME=https://atlas.tony-walteur.workers.dev"
    b"  ATLAS_HOME_URL=unset\n"
)


def test_committed_pin_line_is_the_current_spelling():
    assert PIN.read_bytes() == PIN_BYTES


def test_page_pipeline_does_not_call_artifact_lifecycle():
    for path in CALLERS:
        text = path.read_text(encoding="utf-8")
        assert "artifact_lifecycle" not in text, path.as_posix()


def test_deploy_still_compares_the_committed_pin():
    text = (ROOT / "deploy/cloudflare-edge/deploy.sh").read_text(encoding="utf-8")
    assert "generated/PAGE_SHA256.txt" in text
    assert "GITHUB_ACTIONS" not in text
    assert "sha256sum src/atlas.html" in text
