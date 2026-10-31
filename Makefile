PYTHON ?= python3
.PHONY: build preview gateway test test-ui test-edge test-eval doctor verify-package
build:
	$(PYTHON) build.py
	cp ATLAS_Voice.html deploy/cloudflare-edge/src/atlas.html
preview: build
	$(PYTHON) scripts/preview.py
gateway: build
	PYTHON="$(PYTHON)" bash scripts/start_gateway.sh
test: build test-edge
	node --test tests/*.test.js
	$(PYTHON) -m pytest tests/test_*.py -q
test-edge: build
	cd deploy/cloudflare-edge && node --test test/*.test.js
# The v2.1 offline evaluation (docs/agent-brain-v2.1/eval/COVERAGE.md): pack scenarios 1-16 through the real Session and workflow code, W1-W12, the MAAP shell tests,
# the release gates that can be checked offline, and the rubric linter. A regression aid, not a measure of the live model (that needs pilot users and is never run here).
test-eval: build
	cd deploy/cloudflare-edge && node --test test/eval-conversation.test.js test/eval-workflow.test.js test/eval-rubric.test.js
# CHROMIUM_PATH: an explicit value wins; otherwise scripts/chromium_path.py picks a cached Chromium when Playwright's own revision is missing.
test-ui: export CHROMIUM_PATH := $(or $(CHROMIUM_PATH),$(shell $(PYTHON) scripts/chromium_path.py))
test-ui: build
	$(PYTHON) tests/studio_browser.py
	$(PYTHON) tests/sculpture_browser.py
	$(PYTHON) tests/intelligence_browser.py
	$(PYTHON) tests/depth_browser.py
	$(PYTHON) tests/autosave_browser.py
	$(PYTHON) tests/orb_touch_browser.py
	$(PYTHON) tests/library_browser.py
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
	$(PYTHON) tests/humane_browser.py
	$(PYTHON) tests/csp_browser.py
doctor:
	$(PYTHON) scripts/doctor.py --profile preview
verify-package:
	$(PYTHON) scripts/check_handoff.py
