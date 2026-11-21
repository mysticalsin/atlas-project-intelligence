# PersonaPlex voice socket (row 5)

Ticket: ask row A22. Tony, relayed verbatim via Jarvis, t2062u: "do the full build of everything that I ask you, and then fully QA test it."

Base: `main` `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`.
APP-FIT: FIT. The lifecycle in `server.voice` matches the row: connect, stream, cancel, end, error, one browser socket.
Risk in the inventory stays H. This run built it because the standing order names row 5. The reducer does not change who may open a socket, and it does not add a second slot.

## Done when

- `voice_socket_transition` is the only writer of the socket phase on the PersonaPlex path.
- Every legal pair moves, every other pair keeps the same state object and names `voice-socket`, the phase and the event.
- `released` is reachable and is the only terminal. No phase is unreachable from `closed`.
- `server.voice` steps `open` after prepare, `reject` when the slot is busy, `admit` when the slot is held, `ready` after the handshake event, `finish` on a clean end or the deadline, `discard` on discard or `SessionCancelled`, `fail` in the error handlers, and `release` in `finally`.
- Event payloads, exception types and the OpenAI and Kyutai early returns stay as they were.

## Tests

`tests/test_voice_socket.py`. The cross product is 7 phases by 8 events. 16 legal, 40 refused.
