"""Pins the page-pipeline facts the artifact reducer must keep.

The first three tests are green on main before the reducer exists. They stay
green after it lands, because that reducer has no caller and does not rewrite
the committed pin. The rest lock the reducer table.
"""

import logging
from pathlib import Path

from scripts.artifact_lifecycle import (
    EVENT_NAMES,
    GUARDS,
    STATE_NAMES,
    TRANSITIONS,
    IllegalTransition,
    format_pin_line,
    g_ci_packet,
    g_confirm_deploy,
    g_deploy_lookup,
    g_double_build,
    g_four_aliases,
    g_home_annotation,
    g_main_ref,
    g_packet_head,
    g_packet_witness,
    g_pin_matches_bytes,
    g_post_test_hash,
    g_same_head,
    g_same_tree,
    g_stale_pin_file,
    g_verified_packet,
    load_packet,
    packet_sha256,
    parse_pin_line,
    transition,
)

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


HEAD = "a" * 40
TREE = "b" * 40
PAGE = "c" * 64
CSP = "d" * 64
HOME = "https://example.test"
NBYTES = 120


def test_writer_emits_the_committed_pin_line():
    raw = PIN.read_text(encoding="utf-8")
    parsed = parse_pin_line(raw)
    assert parsed is not None
    assert format_pin_line(
        parsed["page_sha256"],
        parsed["nbytes"],
        parsed["atlas_home"],
        parsed["atlas_home_url"],
    ) == raw


def test_reducer_source_does_not_perform_io():
    text = (ROOT / "scripts/artifact_lifecycle.py").read_text(encoding="utf-8")
    assert "os.environ" not in text
    assert "getenv" not in text
    assert "subprocess" not in text
    assert "wrangler" not in text


def _pin(token="unset"):
    return format_pin_line(PAGE, NBYTES, HOME, token)


def _source():
    return {"name": "SourceChanged", "head": HEAD, "tree": TREE}


def _built():
    return {
        "name": "Built",
        "head": HEAD,
        "tree": TREE,
        "page_sha256": PAGE,
        "nbytes": NBYTES,
        "csp_sha256": CSP,
        "atlas_home": HOME,
    }


def _pinned():
    state = _built()
    state["name"] = "Pinned"
    state["pin"] = _pin()
    return state


def _packet(source="ci", tree=TREE, verified=True, version=1):
    return {
        "version": version,
        "head": HEAD,
        "tree": tree,
        "verified": verified,
        "source": source,
        "pin": _pin(),
        "csp_sha256": CSP,
    }


def _verified(source="ci", **packet_edits):
    state = _pinned()
    state["name"] = "Verified"
    packet = _packet(source)
    packet.update(packet_edits)
    state["packet"] = packet
    return state


def _deployed():
    state = _verified()
    state["name"] = "Deployed"
    state["deployment_id"] = "version-1"
    return state


def _verify_event():
    packet = _packet()
    return {
        "name": "verify_ok",
        "checkout_head": HEAD,
        "checkout_tree": TREE,
        "packet": packet,
        "witness": packet_sha256(packet),
        "csp_actual": CSP,
    }


EVENTS = {
    "edit": lambda: {"name": "edit", "head": HEAD, "tree": TREE, "checkout_head": HEAD, "checkout_tree": TREE},
    "build_ok": lambda: {
        "name": "build_ok",
        "checkout_head": HEAD,
        "checkout_tree": TREE,
        "wrote_voice": True,
        "first_sha256": PAGE,
        "second_sha256": PAGE,
        "alias_sha256s": (PAGE, PAGE, PAGE, PAGE),
        "page_sha256": PAGE,
        "nbytes": NBYTES,
        "csp_sha256": CSP,
        "atlas_home": HOME,
    },
    "build_fail": lambda: {"name": "build_fail", "checkout_head": HEAD, "checkout_tree": TREE},
    "pin_ok": lambda: {
        "name": "pin_ok",
        "checkout_head": HEAD,
        "checkout_tree": TREE,
        "atlas_home_url": "unset",
        "pin": _pin(),
    },
    "pin_fail": lambda: {"name": "pin_fail", "checkout_head": HEAD, "checkout_tree": TREE},
    "verify_ok": _verify_event,
    "verify_fail": lambda: {"name": "verify_fail", "checkout_head": HEAD, "checkout_tree": TREE},
    "deploy_request": lambda: {
        "name": "deploy_request",
        "checkout_head": HEAD,
        "checkout_tree": TREE,
        "github_ref": "refs/heads/main",
        "confirm": "DEPLOY",
    },
    "publish_ok": lambda: {
        "name": "publish_ok",
        "checkout_head": HEAD,
        "checkout_tree": TREE,
        "hash_before": PAGE,
        "hash_after": PAGE,
        "deployment_id": "version-1",
    },
    "publish_refused": lambda: {"name": "publish_refused", "checkout_head": HEAD, "checkout_tree": TREE},
}

STATES = {
    "SourceChanged": _source,
    "Built": _built,
    "Pinned": _pinned,
    "Verified": _verified,
    "Deployed": _deployed,
}

# The plan table. Kept here so a new module row cannot mark itself legal.
EXPECTED = {
    ("SourceChanged", "edit"): "SourceChanged",
    ("SourceChanged", "build_ok"): "Built",
    ("SourceChanged", "build_fail"): "SourceChanged",
    ("Built", "pin_ok"): "Pinned",
    ("Built", "pin_fail"): "Built",
    ("Built", "edit"): "SourceChanged",
    ("Pinned", "verify_ok"): "Verified",
    ("Pinned", "verify_fail"): "Pinned",
    ("Pinned", "edit"): "SourceChanged",
    ("Verified", "deploy_request"): "Verified",
    ("Verified", "publish_ok"): "Deployed",
    ("Verified", "publish_refused"): "Verified",
    ("Verified", "edit"): "SourceChanged",
    ("Deployed", "edit"): "SourceChanged",
}


def test_cross_product_matches_the_plan_table():
    assert set(TRANSITIONS) == set(EXPECTED)
    assert len(STATE_NAMES) * len(EVENT_NAMES) == 50
    assert len(EXPECTED) == 14
    for state_name in STATE_NAMES:
        for event_name in EVENT_NAMES:
            result = transition(STATES[state_name](), EVENTS[event_name]())
            key = (state_name, event_name)
            if key in EXPECTED:
                assert not isinstance(result, IllegalTransition), key
                assert result["name"] == EXPECTED[key]
            else:
                assert isinstance(result, IllegalTransition), key
                assert result.guard == "table"


def test_publish_from_source_changed_is_illegal():
    result = transition(_source(), EVENTS["publish_ok"]())
    assert isinstance(result, IllegalTransition)
    assert result.state_name == "SourceChanged"
    assert result.event_name == "publish_ok"


def test_publish_ok_requires_a_verified_packet_for_this_tree():
    missing = _verified()
    del missing["packet"]
    assert isinstance(transition(missing, EVENTS["publish_ok"]()), IllegalTransition)

    unverified = _verified(verified=False)
    refused = transition(unverified, EVENTS["publish_ok"]())
    assert isinstance(refused, IllegalTransition)
    assert refused.guard == "g_verified_packet"

    other_tree = _verified(tree="e" * 40)
    refused = transition(other_tree, EVENTS["publish_ok"]())
    assert isinstance(refused, IllegalTransition)
    assert refused.guard == "g_verified_packet"


def test_unknown_packet_version_is_illegal():
    assert isinstance(load_packet({"version": 0, "tree": TREE}), IllegalTransition)
    assert isinstance(load_packet({"tree": TREE}), IllegalTransition)
    assert isinstance(load_packet({"version": 2, "tree": TREE}), IllegalTransition)
    assert load_packet({"version": 1}).guard == "tree"
    assert isinstance(load_packet({"version": 1, "tree": ""}), IllegalTransition)
    loaded = load_packet(_packet())
    assert loaded["version"] == 1
    assert loaded["tree"] == TREE


def test_home_url_token_is_recorded_and_is_not_a_gate():
    event = EVENTS["pin_ok"]()
    event["pin"] = _pin("https://example.test/other")
    event["atlas_home_url"] = "https://example.test/other"
    pinned = transition(_built(), event)
    assert pinned["name"] == "Pinned"
    assert pinned["pin"].endswith("ATLAS_HOME_URL=https://example.test/other\n")

    bad_home = EVENTS["pin_ok"]()
    bad_home["pin"] = format_pin_line(PAGE, NBYTES, "https://other.example", "unset")
    assert isinstance(transition(_built(), bad_home), IllegalTransition)

    state = _verified(source="local-run")
    state["pin"] = _pin("https://example.test/other")
    state["packet"] = _packet(source="local-run")
    state["packet"]["pin"] = state["pin"]
    published = transition(state, EVENTS["publish_ok"]())
    assert published["name"] == "Deployed"
    request = transition(state, EVENTS["deploy_request"]())
    assert isinstance(request, IllegalTransition)
    assert request.guard == "g_ci_packet"


def test_missing_deploy_lookup_stays_verified():
    event = EVENTS["publish_ok"]()
    del event["deployment_id"]
    result = transition(_verified(), event)
    assert not isinstance(result, IllegalTransition)
    assert result["name"] == "Verified"
    assert "deployment_id" not in result


def test_each_guard_allows_and_denies():
    built = _built()
    pinned = _pinned()
    verified = _verified()
    good_build = EVENTS["build_ok"]()
    bad_build = dict(good_build)
    bad_build["wrote_voice"] = False
    assert g_double_build(built, good_build) is True
    assert g_double_build(built, bad_build) is False
    short = dict(good_build)
    short["alias_sha256s"] = (PAGE, PAGE, PAGE)
    assert g_four_aliases(built, good_build) is True
    assert g_four_aliases(built, short) is False

    pin_event = EVENTS["pin_ok"]()
    assert g_same_head(built, pin_event) is True
    assert g_same_head({"head": "other"}, pin_event) is False
    assert g_same_tree(built, pin_event) is True
    assert g_same_tree({"tree": "other"}, pin_event) is False
    assert g_pin_matches_bytes(built, pin_event) is True
    wrong_len = dict(pin_event)
    wrong_len["pin"] = format_pin_line(PAGE, NBYTES + 1, HOME, "unset")
    assert g_pin_matches_bytes(built, wrong_len) is False
    assert g_home_annotation(built, pin_event) is True
    assert g_home_annotation(built, bad_home_event(pin_event)) is False

    verify = _verify_event()
    assert g_packet_head(pinned, verify) is True
    bad_version = dict(verify)
    bad_version["packet"] = dict(verify["packet"])
    bad_version["packet"]["version"] = 2
    assert g_packet_head(pinned, bad_version) is False
    assert g_packet_witness(pinned, verify) is True
    bad_witness = dict(verify)
    bad_witness["witness"] = "0" * 64
    assert g_packet_witness(pinned, bad_witness) is False
    publish = EVENTS["publish_ok"]()
    assert g_verified_packet(verified, publish) is True
    assert g_verified_packet(_source(), publish) is False
    assert g_post_test_hash(verified, publish) is True
    flipped = dict(publish)
    flipped["hash_after"] = "e" * 64
    assert g_post_test_hash(verified, flipped) is False
    assert g_deploy_lookup(verified, publish) is True
    assert g_deploy_lookup(verified, {"name": "publish_ok"}) is False
    assert g_ci_packet(verified, {}) is True
    assert g_ci_packet(_verified(source="local-run"), {}) is False
    assert g_main_ref({}, EVENTS["deploy_request"]()) is True
    assert g_main_ref({}, {"github_ref": "refs/heads/topic"}) is False
    assert g_confirm_deploy({}, EVENTS["deploy_request"]()) is True
    assert g_confirm_deploy({}, {"confirm": "no"}) is False
    assert g_stale_pin_file(built, {}) is True
    assert g_stale_pin_file(built, {"stale_pin_text": _pin(), "page_sha256": PAGE}) is True
    assert g_stale_pin_file(built, {"stale_pin_text": format_pin_line("a" * 64, 1, HOME), "page_sha256": PAGE}) is False
    for name in GUARDS:
        assert callable(GUARDS[name])


def bad_home_event(pin_event):
    event = dict(pin_event)
    event["pin"] = format_pin_line(PAGE, NBYTES, "https://other.example", "unset")
    return event


def test_illegal_transition_is_logged(caplog):
    caplog.set_level(logging.WARNING, logger="atlas.artifact_lifecycle")
    transition(_source(), EVENTS["publish_ok"]())
    assert "illegal transition" in caplog.text
    assert "publish_ok" in caplog.text


def test_edit_drops_the_pin_and_the_packet():
    result = transition(_deployed(), EVENTS["edit"]())
    assert result == {"name": "SourceChanged", "head": HEAD, "tree": TREE}
