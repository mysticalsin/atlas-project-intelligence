# Live test bound

The Kyutai cascade has no continuation window.

`atlas_voice/cascade.py` `run` ends a consultant turn when `TurnDetector` in `atlas_voice/kyutai.py` hears words and then a pause above its threshold. The cascade does not hold a reply, retract it, or merge a later utterance into that turn. `Discarded` is a browser cancel or close while the session is still starting. It is not a continuation hold.

The continuation window is the edge interview session. That session's hold is not on this branch: `session.js` has no `hold` or `loudRun`. The state-machine inventory cites this file for that gap.
