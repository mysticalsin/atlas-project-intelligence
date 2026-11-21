# Browser voice phase (row 6)

Ticket: ask row A22. Tony, relayed verbatim via Jarvis, t2062u: "do the full build of everything that I ask you, and then fully QA test it."

Base: `main` `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
APP-FIT: FIT. The page already moves through idle, preparing, connecting, live, ending and error.
Risk in the inventory stays H. This run built it because the standing order names row 6. The reducer does not change consent, the socket URL, or who may start a session.

## Done when

- `voicePhase` is the only writer of `phase` after the initial `idle`.
- `status` returns without painting when the pair is illegal.
- The ready handler no longer assigns `phase` itself.
- Every legal pair moves, every other pair keeps the same state object and names `voice-phase`, the phase and the event.
- Every phase is reachable from `idle`. None is terminal.
- The four HTML aliases are rebuilt from this client.

## Tests

`tests/voice-phase.test.js`. 6 phases by 6 events. 24 legal, 12 refused.

## Overlap named, not stacked

#15 `cursor/atlas-identity-change-residual` and #2 `cursor/plan-a-cap-v2` also change `src/voice-client.js`. Neither is in the required check list for this run (#25, #27, #35, #37, #44, #45, #47, and the s01 branches). #44 changes the shell and the HTML aliases, not `voice-client.js`. This branch starts from `main`.
