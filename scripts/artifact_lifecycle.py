"""Pure lifecycle for one tree's generated page.

`transition` returns the next state or an `IllegalTransition`. It does not
read the environment, write a file, or call a deployer. The page pipeline
does not call this module. Deploy still compares the committed pin.
"""

import hashlib
import json
import logging

log = logging.getLogger("atlas.artifact_lifecycle")

STATE_NAMES = ("SourceChanged", "Built", "Pinned", "Verified", "Deployed")
EVENT_NAMES = (
    "edit",
    "build_ok",
    "build_fail",
    "pin_ok",
    "pin_fail",
    "verify_ok",
    "verify_fail",
    "deploy_request",
    "publish_ok",
    "publish_refused",
)

_FIELDS = {
    "SourceChanged": ("head", "tree"),
    "Built": ("head", "tree", "page_sha256", "nbytes", "csp_sha256", "atlas_home"),
    "Pinned": ("head", "tree", "page_sha256", "nbytes", "csp_sha256", "atlas_home", "pin"),
    "Verified": ("head", "tree", "page_sha256", "nbytes", "csp_sha256", "atlas_home", "pin", "packet"),
    "Deployed": (
        "head",
        "tree",
        "page_sha256",
        "nbytes",
        "csp_sha256",
        "atlas_home",
        "pin",
        "packet",
        "deployment_id",
    ),
}

# (state, event) -> (target state, guards). Anything absent is illegal.
# g_deploy_lookup is last on publish_ok. A miss stays Verified. Every other
# guard miss is IllegalTransition.
TRANSITIONS = {
    ("SourceChanged", "edit"): ("SourceChanged", ()),
    ("SourceChanged", "build_ok"): ("Built", ("g_double_build", "g_four_aliases")),
    ("SourceChanged", "build_fail"): ("SourceChanged", ()),
    ("Built", "pin_ok"): (
        "Pinned",
        ("g_same_head", "g_same_tree", "g_pin_matches_bytes", "g_home_annotation"),
    ),
    ("Built", "pin_fail"): ("Built", ()),
    ("Built", "edit"): ("SourceChanged", ()),
    ("Pinned", "verify_ok"): (
        "Verified",
        ("g_packet_head", "g_same_head", "g_same_tree", "g_packet_witness"),
    ),
    ("Pinned", "verify_fail"): ("Pinned", ()),
    ("Pinned", "edit"): ("SourceChanged", ()),
    ("Verified", "deploy_request"): (
        "Verified",
        ("g_main_ref", "g_confirm_deploy", "g_verified_packet", "g_ci_packet"),
    ),
    ("Verified", "publish_ok"): (
        "Deployed",
        ("g_verified_packet", "g_post_test_hash", "g_same_tree", "g_deploy_lookup"),
    ),
    ("Verified", "publish_refused"): ("Verified", ()),
    ("Verified", "edit"): ("SourceChanged", ()),
    ("Deployed", "edit"): ("SourceChanged", ()),
}


class IllegalTransition:
    def __init__(self, state_name, event_name, guard):
        self.state_name = state_name
        self.event_name = event_name
        self.guard = guard

    def __repr__(self):
        return f"IllegalTransition({self.state_name!r}, {self.event_name!r}, {self.guard!r})"

    def __eq__(self, other):
        return (
            isinstance(other, IllegalTransition)
            and (self.state_name, self.event_name, self.guard)
            == (other.state_name, other.event_name, other.guard)
        )


def _illegal(state_name, event_name, guard):
    log.warning(
        "illegal transition state=%s event=%s guard=%s",
        state_name,
        event_name,
        guard,
    )
    return IllegalTransition(state_name, event_name, guard)


def _hex64(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _ident(value):
    return isinstance(value, str) and value != "" and not any(ch.isspace() for ch in value)


def _checkout(event, key):
    value = event.get(key)
    if not _ident(value):
        return None
    return value


def _event_packet(event):
    packet = event.get("packet")
    return packet if isinstance(packet, dict) else None


def _state_packet(state):
    packet = state.get("packet")
    return packet if isinstance(packet, dict) else None


def packet_bytes(packet):
    return json.dumps(packet, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def packet_sha256(packet):
    return hashlib.sha256(packet_bytes(packet)).hexdigest()


def format_pin_line(page_sha256, nbytes, atlas_home, atlas_home_url="unset"):
    if not _hex64(page_sha256) or isinstance(nbytes, bool) or not isinstance(nbytes, int) or nbytes < 0:
        return None
    if not _ident(atlas_home) or not _ident(atlas_home_url):
        return None
    return f"{page_sha256}  {nbytes}  ATLAS_HOME={atlas_home}  ATLAS_HOME_URL={atlas_home_url}\n"


def parse_pin_line(line):
    if not isinstance(line, str) or line.count("\n") != 1 or not line.endswith("\n"):
        return None
    parts = line[:-1].split("  ")
    if len(parts) != 4:
        return None
    page, raw_nbytes, home_field, token_field = parts
    if not _hex64(page):
        return None
    if not raw_nbytes.isdigit() or (len(raw_nbytes) > 1 and raw_nbytes.startswith("0")):
        return None
    if not home_field.startswith("ATLAS_HOME=") or home_field == "ATLAS_HOME=":
        return None
    home = home_field[len("ATLAS_HOME="):]
    if not _ident(home):
        return None
    if not token_field.startswith("ATLAS_HOME_URL=") or token_field == "ATLAS_HOME_URL=":
        return None
    token = token_field[len("ATLAS_HOME_URL="):]
    if not _ident(token):
        return None
    return {
        "page_sha256": page,
        "nbytes": int(raw_nbytes),
        "atlas_home": home,
        "atlas_home_url": token,
    }


def _pin_line(state, event):
    supplied = event.get("pin")
    if isinstance(supplied, str):
        return supplied
    return format_pin_line(
        state.get("page_sha256"),
        state.get("nbytes"),
        state.get("atlas_home"),
        event.get("atlas_home_url", "unset"),
    )


def g_double_build(state, event):
    if event.get("wrote_voice") is not True:
        return False
    first = event.get("first_sha256")
    second = event.get("second_sha256")
    if not _hex64(first) or first != second:
        return False
    page = event.get("page_sha256")
    if page is not None and page != second:
        return False
    return True


def g_four_aliases(state, event):
    aliases = event.get("alias_sha256s")
    if not isinstance(aliases, (list, tuple)) or len(aliases) != 4:
        return False
    if not all(_hex64(item) for item in aliases):
        return False
    if len(set(aliases)) != 1:
        return False
    page = event.get("page_sha256")
    if page is not None and aliases[0] != page:
        return False
    return True


def g_same_head(state, event):
    checkout = _checkout(event, "checkout_head")
    return checkout is not None and state.get("head") == checkout


def g_same_tree(state, event):
    checkout = _checkout(event, "checkout_tree")
    if checkout is None or state.get("tree") != checkout:
        return False
    packet = _event_packet(event) or _state_packet(state)
    if packet is not None and packet.get("tree") != checkout:
        return False
    return True


def g_pin_matches_bytes(state, event):
    parsed = parse_pin_line(_pin_line(state, event) or "")
    if parsed is None:
        return False
    return parsed["page_sha256"] == state.get("page_sha256") and parsed["nbytes"] == state.get("nbytes")


def g_home_annotation(state, event):
    parsed = parse_pin_line(_pin_line(state, event) or "")
    origin = state.get("atlas_home")
    if parsed is None or not _ident(origin):
        return False
    # The ATLAS_HOME_URL token is recorded on the line. It is not this guard.
    return parsed["atlas_home"] == origin


def g_packet_head(state, event):
    packet = _event_packet(event) or _state_packet(state)
    checkout = _checkout(event, "checkout_head")
    if not isinstance(packet, dict) or checkout is None:
        return False
    return packet.get("version") == 1 and packet.get("head") == checkout


def g_verified_packet(state, event):
    packet = _state_packet(state)
    if packet is None:
        packet = _event_packet(event)
    if not isinstance(packet, dict) or packet.get("verified") is not True or packet.get("version") != 1:
        return False
    checkout_head = _checkout(event, "checkout_head")
    checkout_tree = _checkout(event, "checkout_tree")
    if checkout_head is None or checkout_tree is None:
        return False
    if packet.get("head") != checkout_head or packet.get("tree") != checkout_tree:
        return False
    if state.get("tree") != checkout_tree:
        return False
    return True


def g_packet_witness(state, event):
    packet = _event_packet(event) or _state_packet(state)
    if not isinstance(packet, dict):
        return False
    try:
        digest = packet_sha256(packet)
    except (TypeError, ValueError):
        return False
    if event.get("witness") != digest:
        return False
    record = event.get("deploy_record")
    if record is not None:
        if not isinstance(record, dict) or record.get("packet_sha256") != digest:
            return False
    if "csp_sha256" in packet and event.get("csp_actual") != packet.get("csp_sha256"):
        return False
    return True


def g_deploy_lookup(state, event):
    deployment_id = event.get("deployment_id")
    return _ident(deployment_id)


def g_ci_packet(state, event):
    packet = _state_packet(state) or _event_packet(event)
    return isinstance(packet, dict) and packet.get("source") == "ci"


def g_main_ref(state, event):
    return event.get("github_ref") == "refs/heads/main"


def g_confirm_deploy(state, event):
    return event.get("confirm") == "DEPLOY"


def g_post_test_hash(state, event):
    before = event.get("hash_before")
    after = event.get("hash_after")
    if not _hex64(before) or before != after:
        return False
    parsed = parse_pin_line(state.get("pin")) if isinstance(state.get("pin"), str) else None
    if parsed is None or parsed["page_sha256"] != before:
        return False
    packet = _state_packet(state)
    if isinstance(packet, dict) and isinstance(packet.get("pin"), str):
        packet_pin = parse_pin_line(packet["pin"])
        if packet_pin is None or packet_pin["page_sha256"] != before:
            return False
    return True


def g_stale_pin_file(state, event):
    pin_text = event.get("stale_pin_text", None)
    if pin_text is None or pin_text == "":
        return True
    if not isinstance(pin_text, str):
        return False
    parsed = parse_pin_line(pin_text if pin_text.endswith("\n") else pin_text + "\n")
    page = event.get("page_sha256") or state.get("page_sha256")
    if parsed is None or not _hex64(page):
        return False
    return parsed["page_sha256"] == page


GUARDS = {
    "g_double_build": g_double_build,
    "g_four_aliases": g_four_aliases,
    "g_same_head": g_same_head,
    "g_same_tree": g_same_tree,
    "g_pin_matches_bytes": g_pin_matches_bytes,
    "g_home_annotation": g_home_annotation,
    "g_packet_head": g_packet_head,
    "g_verified_packet": g_verified_packet,
    "g_packet_witness": g_packet_witness,
    "g_deploy_lookup": g_deploy_lookup,
    "g_ci_packet": g_ci_packet,
    "g_main_ref": g_main_ref,
    "g_confirm_deploy": g_confirm_deploy,
    "g_post_test_hash": g_post_test_hash,
    "g_stale_pin_file": g_stale_pin_file,
}


def load_packet(raw):
    if not isinstance(raw, dict) or raw.get("version") != 1:
        return _illegal("packet", "load", "version")
    tree = raw.get("tree")
    if not _ident(tree):
        return _illegal("packet", "load", "tree")
    try:
        return json.loads(packet_bytes(raw).decode("utf-8"))
    except (TypeError, ValueError):
        return _illegal("packet", "load", "version")


def _built_fields(event):
    page = event.get("page_sha256")
    nbytes = event.get("nbytes")
    csp = event.get("csp_sha256")
    home = event.get("atlas_home")
    if not _hex64(page) or isinstance(nbytes, bool) or not isinstance(nbytes, int) or nbytes < 0:
        return None
    if not _hex64(csp) or not _ident(home):
        return None
    return {"page_sha256": page, "nbytes": nbytes, "csp_sha256": csp, "atlas_home": home}


def _project(state, name):
    out = {"name": name}
    for key in _FIELDS[name]:
        if key not in state:
            return None
        value = state[key]
        if key == "packet":
            if not isinstance(value, dict):
                return None
            try:
                value = json.loads(packet_bytes(value).decode("utf-8"))
            except (TypeError, ValueError):
                return None
        out[key] = value
    return out


def _enter(state, event, target):
    state_name = state.get("name")
    event_name = event.get("name")
    if target == "SourceChanged":
        head = state.get("head")
        tree = state.get("tree")
        if event_name == "edit":
            if "head" in event:
                head = event.get("head")
            if "tree" in event:
                tree = event.get("tree")
        if not _ident(head) or not _ident(tree):
            return _illegal(state_name, event_name, "identity")
        return {"name": "SourceChanged", "head": head, "tree": tree}
    if target == "Built" and event_name == "build_ok":
        built = _built_fields(event)
        if built is None or not _ident(state.get("head")) or not _ident(state.get("tree")):
            return _illegal(state_name, event_name, "built_fields")
        return {"name": "Built", "head": state["head"], "tree": state["tree"], **built}
    if target == "Pinned":
        line = _pin_line(state, event)
        nxt = _project(state, "Built")
        if nxt is None or not isinstance(line, str):
            return _illegal(state_name, event_name, "pin")
        nxt["name"] = "Pinned"
        nxt["pin"] = line
        return nxt
    if target == "Verified" and event_name == "verify_ok":
        packet = load_packet(event.get("packet"))
        if isinstance(packet, IllegalTransition):
            return packet
        nxt = _project(state, "Pinned")
        if nxt is None:
            return _illegal(state_name, event_name, "shape")
        nxt["name"] = "Verified"
        nxt["packet"] = packet
        return nxt
    if target == "Deployed":
        nxt = _project(state, "Verified")
        if nxt is None or not _ident(event.get("deployment_id")):
            return _illegal(state_name, event_name, "g_deploy_lookup")
        nxt["name"] = "Deployed"
        nxt["deployment_id"] = event["deployment_id"]
        return nxt
    nxt = _project(state, target)
    if nxt is None:
        return _illegal(state_name, event_name, "shape")
    return nxt


def transition(state, event):
    if not isinstance(state, dict) or not isinstance(event, dict):
        return _illegal("?", "?", "shape")
    state_name = state.get("name")
    event_name = event.get("name")
    if state_name not in STATE_NAMES or event_name not in EVENT_NAMES:
        return _illegal(str(state_name), str(event_name), "table")
    row = TRANSITIONS.get((state_name, event_name))
    if row is None:
        return _illegal(state_name, event_name, "table")
    target, guards = row
    for guard_name in guards:
        if guard_name == "g_deploy_lookup":
            continue
        if not GUARDS[guard_name](state, event):
            return _illegal(state_name, event_name, guard_name)
    if "g_deploy_lookup" in guards and not g_deploy_lookup(state, event):
        log.warning(
            "publish lookup missing state=%s event=%s guard=g_deploy_lookup",
            state_name,
            event_name,
        )
        stayed = _project(state, state_name)
        if stayed is None:
            return _illegal(state_name, event_name, "shape")
        return stayed
    return _enter(state, event, target)
