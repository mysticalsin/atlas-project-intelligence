# Group 1 — scrub / redaction

Plan only. Debate this before anyone edits product code.

Pinned inputs: confirmer report sha256 `57c92dcb651ddef4b7abe9c23424065a2a59fa139d2cdfc6315ce227596eac1c`, main `8b0972ecf68228ab4a3bab5e4e90ffd5948826ec`, red tests `96712474b59d6b058ef00479f2bb2d4eb065801e` (PR #31).

Findings: H1, M1, L6.

## Done when

1. `node --test deploy/cloudflare-edge/test/sweep01-a-logic.test.js` shows the three H1 tests, both M1 tests, and the L6 test passing. The other tests in that file belong to other groups and may stay red. This group does not edit them, skip them, or mark them expected failures.
2. `node --test deploy/cloudflare-edge/test/scrub.test.js` still passes, including the existing word-boundary, stoplist, and NFD cases.
3. A client name or contact is removed only as a whole word (Unicode letters and digits), compared in NFC. A one-word stoplist contact such as `Will` does not rewrite `will`. A multi-word contact lead such as `Jane Doe` is still removed.
4. Two conversation retains whose timestamps differ by less than one second and by at least one millisecond receive different `document_id`s. The project document id `project-<localId>` stays a stable upsert key.

## Files this group may edit

- `deploy/cloudflare-edge/src/memory.js` (`scrub`, `retainItems`)
- `deploy/cloudflare-edge/src/sheet.js` (`scrub`, which `draftMessages` calls)
- `deploy/cloudflare-edge/src/review.js` (`clientScrub` only; do not change `contactLead`'s cut rules or `forModel`'s field dropping)
- `deploy/cloudflare-edge/src/scrub.js` (re-export the matcher so `rating.js` and `scrub.test.js` keep `import { STOPLIST, nameMatcher } from './scrub.js'`)
- `deploy/cloudflare-edge/src/name-match.js` (new). This is the one shared matcher. Nobody else edits it.

Do not edit `publication.js`, `library.js`, `util.js`, `profile.js`, `gaps.js`, `session.js`, `languages.js`, `breaker.js`, or any UI, CI, or Python file.

`memory-routes.js` already calls `scrub` from `memory.js`. Leave that import alone.

## Failing tests from PR #31

File: `deploy/cloudflare-edge/test/sweep01-a-logic.test.js`

| Test name | Finding |
|---|---|
| `H1 memory scrub keeps ordinary words and still removes a client name` | H1 |
| `H1 memory scrub removes a client name whether the record stored it decomposed` | H1 |
| `H1 sheet scrub keeps ordinary words when the client is Air or Will` | H1 |
| `M1 a one-word contact on the stoplist does not rewrite that ordinary word` | M1 |
| `M1 a multi-word contact is still removed from model text` | M1 (control that already passes; must stay passing) |
| `L6 two conversations in the same second get different memory document ids` | L6 |

TEST COMMAND:

```sh
node --test deploy/cloudflare-edge/test/sweep01-a-logic.test.js
node --test deploy/cloudflare-edge/test/scrub.test.js
```

Run the second command as the regression net. It is already green on main and must stay green.

## Threat model

Before: a signed-in consultant, or the interview text they cause to be retained, can store a short client name (`Air`, `Will`) or a decomposed spelling. `memory.scrub` and `sheet.scrub` compile those strings into one case-insensitive substring alternation. `Air` rewrites `repair` and `aircraft`. `Will` rewrites `will`. The sheet prompt sent to the model, and the Hindsight document, then say `the client` in place of ordinary words, and a name stored as NFD is left sitting in NFC text. `clientScrub` is already word-bounded and NFC, but it still puts a one-word contact on the case-insensitive matcher, so model text loses every `will`. Separately, two utterances in the same second share one Hindsight `document_id` (`conversation-<id>-YYYYMMDDHHMMSS`). The later retain replaces the earlier one. The first utterance is gone.

After: ordinary words stay. The client name is removed when it stands as a word, including when one side was NFD and the other NFC. A one-word stoplist contact is not a mask. Two utterances that differ at the millisecond get two conversation documents. The project document is still one upsert per project.

What an attacker still can do: a client whose legal name is the ordinary word `will` in lowercase, inside a sentence, is not masked by `clientScrub`. That is the existing stoplist rule in `scrub.test.js` ("single-token stoplist contacts are skipped"; a stoplist *name* at the start of a sentence is still masked in its stored and upper-case forms). Misspellings, subsidiaries, and names shorter than two characters stay unmasked. Two retains that pass the identical `now` string still share a conversation id.

## Chosen design

Move `STOPLIST`, `nameMatcher`, and the NFC / word-boundary helpers from `scrub.js` into `name-match.js`, with no imports from `review.js` or `scrub.js`. `scrub.js` re-exports them. `rating.js` (PR #17) does not change.

`maskOwnClient(text, clientOrNames)` in `name-match.js` builds the name list the way `clientScrub` already documents: client name, location, full contact, and `contactLead` when that lead contains whitespace. It runs `nameMatcher` with `{ contacts: true }`. Those rules are already tested:

- word boundaries are `(?<![\p{L}\p{N}])` and `(?![\p{L}\p{N}])`
- both sides are NFC
- a name of 5 or more characters that is not a single stoplist word is case-insensitive
- anything shorter, or a single stoplist word, matches only the stored spelling and the upper-case spelling
- a single-token contact that is a stoplist word or shorter than 3 characters is skipped

`memory.scrub` and `sheet.scrub` call `maskOwnClient` and do not keep their own `RegExp`. `clientScrub` calls the same function and returns the same replacer shape it returns today, so `forModel` stays a deep walk.

`contactLead` stays in `review.js`. `name-match.js` receives the lead as an argument. That avoids a cycle: `scrub.js` imports `forModel` and `contactLead` from `review.js`, and `review.js` imports the matcher from `name-match.js`, not from `scrub.js`.

L6: the conversation id uses the first 17 digits of `now` (year through milliseconds), not 14. `2026-09-27T10:00:00.100Z` and `...00.900Z` differ. The id stays `conversation-<safeId>-<digits>`. No random suffix, so a retry of the same payload and the same timestamp is the same document.

## Alternatives rejected

1. Keep three copies of the regex and add `\b` plus a short local deny-list (`will`, `air`) in each file. Rejected because `\b` is ASCII, the NFD case still fails, and a private deny-list drifts from the 500-word `STOPLIST` that `scrub.test.js` already freezes.
2. Make `clientScrub` import `nameMatcher` from `scrub.js`. Rejected because `scrub.js` already imports `clientScrub` from `review.js`. That cycle is how the two files are coupled today; turning it around makes the load order the behavior.
3. Give every conversation id a `crypto.randomUUID()` tail. Rejected because a retry of the same utterance becomes a second Hindsight document, and the red test only requires two different timestamps to differ. Milliseconds are deterministic and enough for the failing pair. Same-timestamp collision stays, and is called out above.

## Invariants and properties

No `test.skip`, no `it.skip`, no `xtest`, no expected-failure mark. No new npm dependency. Generate cases with a loop inside `node:test`.

Properties, in a new `deploy/cloudflare-edge/test/sweep01-g1-scrub-props.test.js` owned by this group:

- For every name in a fixed list of short stoplist words (`will`, `air`, `mark`, `total`, `orange`) and every carrier in `repair`, `aircraft`, `will`, `airline`, the masked sentence still contains the carrier when the client field is that word with an initial capital.
- For every pair of NFC and NFD spellings of `Société Générale` and `Ångström`, masking the NFD name removes the NFC word and the reverse.
- A multi-word contact `Jane Doe (Head of Claims)` still masks `Jane Doe` and does not mask `Jane` inside `Janeery`.
- For every millisecond offset `1..999`, `retainItems` at `2026-09-27T10:00:00.000Z` and at that offset produce different conversation ids, and the project id is `project-p-123` both times.
- Two calls with the same `now` and the same payload produce the same conversation id (retry).

Boundaries: empty client, name of length 2, name of length 4, name of length 5, contact that is only an email, text that is not a string, `now` with no fractional seconds (the 17-digit slice is shorter; the id must still be stable and must not throw).

## Data migration

Hindsight documents already stored under the 14-digit id are not rewritten. This group has no bank credentials and must not call Hindsight. A later retain of a new utterance in the same second writes a new id; the old collided document remains until the subject forgets the bank or a later, separate memory job deletes it. Do not add that job here.

Stories and sheets already saved with `the client` baked into ordinary words are not repaired. The scrub runs on the way out to a model and on the way into memory, not on stored library JSON.

## Rollback

Revert the group commit. Memory and sheet go back to substring replacement. No schema change, no backfill to undo.

## Open PRs #15–#30

No file overlap with #15–#30. PR #17 edits `rating.js`, which imports `STOPLIST` from `scrub.js`. The re-export keeps that import valid. Do not change stoplist membership or the case rules `scrub.test.js` already asserts, or #17's rating tests will fail for a reason that is not `onEnd`.

PR #31 is the red-test branch. Land the fix on a branch that contains those tests, or cherry-pick the test file. Do not weaken the assertions.

## Owner lockout

None. This does not touch sign-in, Access, kill switches, or the profile row. The worst product miss is a client whose name is a lowercase stoplist word remaining visible to a model. That is the current written rule, not a new outage.

## Diff size

About 150 lines of product code moved or rewritten, plus about 120 lines of property tests. `name-match.js` is mostly the existing `STOPLIST` and `nameMatcher` moved, not new logic. Review the move as a move.
