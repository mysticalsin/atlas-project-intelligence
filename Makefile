PYTHON ?= python3
.PHONY: build preview gateway test test-ui test-edge doctor verify-package
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
test-ui: build
	$(PYTHON) tests/studio_browser.py
	$(PYTHON) tests/sculpture_browser.py
	$(PYTHON) tests/intelligence_browser.py
	$(PYTHON) tests/depth_browser.py
	$(PYTHON) tests/autosave_browser.py
	$(PYTHON) tests/orb_touch_browser.py
	$(PYTHON) tests/library_browser.py
	$(PYTHON) tests/refusal_browser.py
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
doctor:
	$(PYTHON) scripts/doctor.py --profile preview
verify-package:
	$(PYTHON) scripts/check_handoff.py
