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
test-ui: build
	@export CHROMIUM_PATH="$${CHROMIUM_PATH:-$$($(PYTHON) scripts/chromium_path.py)}"; \
	echo "CHROMIUM_PATH=$${CHROMIUM_PATH:-<playwright default>}"; \
	for t in studio sculpture intelligence depth autosave orb_touch library reuse memory sheet report bids ask trust storyboard confirm wow_edge zero_config zero_config_edge jev_rating humane csp; do \
	  echo "== $$t"; $(PYTHON) tests/$${t}_browser.py || exit 1; \
	done
doctor:
	$(PYTHON) scripts/doctor.py --profile preview
verify-package:
	$(PYTHON) scripts/check_handoff.py
