PYTHON ?= python3
.PHONY: build preview gateway test test-ui test-edge geo-ne-check doctor verify-package verify-dev-tree integrations-lock
build:
	$(PYTHON) build.py
preview: build
	$(PYTHON) scripts/preview.py
gateway: build
	PYTHON="$(PYTHON)" bash scripts/start_gateway.sh
test: build test-edge
	node --test tests/*.test.js
	$(PYTHON) -m pytest tests/test_*.py -q
test-edge:
	cd deploy/cloudflare-edge && node --test test/*.test.js
geo-ne-check:
	node tests/geo-ne-check.js
test-ui: build
	$(PYTHON) tests/studio_browser.py
	$(PYTHON) tests/sculpture_browser.py
	$(PYTHON) tests/intelligence_browser.py
	$(PYTHON) tests/depth_browser.py
	$(PYTHON) tests/autosave_browser.py
	$(PYTHON) tests/orb_touch_browser.py
	$(PYTHON) tests/library_browser.py
	$(PYTHON) tests/record_dialog_quality_browser.py
	$(PYTHON) tests/refusal_browser.py
	$(PYTHON) tests/audit_marker_browser.py
	$(PYTHON) tests/csp_console_browser.py
	$(PYTHON) tests/autosave_chain_browser.py
	$(PYTHON) tests/reuse_browser.py
	$(PYTHON) tests/memory_browser.py
	$(PYTHON) tests/sheet_browser.py
	$(PYTHON) tests/report_browser.py
	$(PYTHON) tests/bids_browser.py
	$(PYTHON) tests/ask_browser.py
	$(PYTHON) tests/trust_browser.py
	$(PYTHON) tests/storyboard_browser.py
	$(PYTHON) tests/confirm_browser.py
	$(PYTHON) tests/wow_edge_browser.py
	$(PYTHON) tests/zero_config_browser.py
	$(PYTHON) tests/zero_config_edge_browser.py
	$(PYTHON) tests/jev_rating_browser.py
	$(PYTHON) tests/admin_metrics_browser.py
	$(PYTHON) tests/sweep01_c_browser.py
	$(PYTHON) tests/sweep01_d_browser.py
	$(PYTHON) tests/confirm_csp_browser.py
	node --check deploy/cloudflare-edge/teams/vendor/teams-js.mjs
doctor:
	$(PYTHON) scripts/doctor.py --profile preview
# Usage: make verify-package PACKAGE=path/to/extracted-release
verify-package:
	@test -n "$(PACKAGE)" || { echo 'Usage: make verify-package PACKAGE=path/to/extracted-release (directory or .zip/.tar archive)'; exit 1; }
	$(PYTHON) scripts/check_handoff.py "$(PACKAGE)"
# Dev checkout only (never used on received release packages).
verify-dev-tree:
	$(PYTHON) scripts/check_handoff.py . --dev-git-index
integrations-lock:
	pip install --require-hashes -r requirements-integrations.txt
