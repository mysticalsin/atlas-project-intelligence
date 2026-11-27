# ask_browser — deterministic synchronization

## Context
The suite used fixed `wait_for_timeout` delays after navigation, Ask POST, spoken-ask consent, and mocked `AtlasVoice.status()` overrides, which could finish before or after the DOM caught up under load.

## Decision
Wait on visible UI state and network completion: library landmarks, `#askStatus` text, `#askRecLine`, `expect_response` for `/api/library/ask` and `/api/transcribe`, and `wait_for_function` on `#askMic` disabled/enabled.

## Consequence
No added sleeps or retries. Five consecutive local runs passed.

## Residual
None observed on this host after the change. If CI flake returns, capture Playwright trace around `expect_response` for `/api/transcribe` (worklet + fake mic timing).