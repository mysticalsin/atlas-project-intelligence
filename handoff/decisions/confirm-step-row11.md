# Colleague confirm page (row 11)

Ask row A22. The confirm page lifecycle was scattered across `render`, `send`, and `load`. This record makes that lifecycle one reducer.

APP-FIT: **FIT**. The phases match the page that already ran: loading, choosing, submitting, recorded, empty, and a failed load.

The inventory marks row 11 H because the page records a human confirmation. This run's HIGH is auth, tenant isolation, erasure, or release gating. This page is none of those. The POST stays the existing fetch. `app.js` is not edited.

## Done when

- `confirmStep` is the only writer of `state.phase` on the confirm page.
- Eleven phase/event pairs are legal. The other twenty-five are refused. The refusal is `{ id: 'confirm-page', phase, event }` and the stored state is unchanged.
- A submit that is not ready stays on choosing. It is not a refusal.
- No phase is unreachable from loading. `failed` is the only terminal phase, and it is reachable.
- The served page inlines `confirmStep` and calls it as `confirmStep({ phase: state.phase }, event)`. The served HTML still has no animation, no transition, and no `innerHTML`.
- A second render of the same inbox stays on choosing. An empty inbox moves to empty.

## Tests

- `deploy/cloudflare-edge/test/confirm-step.test.js` — legal pairs, refused pairs, the ready guard, reachability.
- `deploy/cloudflare-edge/test/confirm-page.test.js` — the page steps through `confirmStep`, and the existing render tests stay green.

TEST COMMAND:

```sh
cd deploy/cloudflare-edge && node --test test/confirm-step.test.js test/confirm-page.test.js
```

## Rollback

```sh
git revert <head-sha>
```

That is an ordinary revert of this branch's commits. No reset, no force push.
