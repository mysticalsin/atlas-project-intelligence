# Group 1 — scrub / redaction

Plan only. Debate this before anyone edits product code. Revision v5 (Devin recheck `e29dfaaf` of `9ce5ea97`: G1 REVISE). A stoplist client name of 3 or more characters is masked in every case as a whole word. `deploy/cloudflare-edge/test/library.test.js` lines 157-162 are the contract. There is no 5-character floor, and a single stoplist word is not excluded from that match. A name of 2 characters stays the stored spelling and the upper-case spelling. The client name is not passed with `{ contacts: true }`.

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

This group also owns `deploy/cloudflare-edge/test/library.test.js` test `forModel regression: a client named "Air" no longer turns "repair" into "repthe client"` and the case-rule assertions in `deploy/cloudflare-edge/test/scrub.test.js` named below. Do not edit any other test in those files. It also owns the two review-#12 tests in `deploy/cloudflare-edge/test/masking-routes.test.js` (the comment at lines 78-81 and the assertions at lines 99, 100, 103, 116, 119, and 122) and two spec lines, `docs/WOW_SPEC.md` line 191 and line 533. Do not edit any other line of that spec or any other test in `masking-routes.test.js`.

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

After: a client name that stands as a whole word is removed in every case, including a stoplist name in lowercase (`air`, `Air`, `AIR`). A longer word that merely contains that name (`repair`, `aircraft`) stays. A one-word stoplist contact is not a mask, so contact `Will` leaves `will` in the sentence. Two utterances that differ at the millisecond get two conversation documents. The project document is still one upsert per project.

What an attacker still can do: a name shorter than 3 characters (`GE`) is still only the stored spelling and the upper-case spelling. Misspellings and subsidiaries stay unmasked. Two retains that pass the identical `now` string still share a conversation id.

## Chosen design

Move `STOPLIST`, `nameMatcher`, and the NFC / word-boundary helpers from `scrub.js` into `name-match.js`, with no imports from `review.js` or `scrub.js`. `scrub.js` re-exports them. `rating.js` (PR #17) does not change.

One rule, `nameMatcher`, for every name. `{ contacts: true }` is only how a contact is passed in. It is not applied to the client name or the location. Passing the client name with `{ contacts: true }` drops stoplist names such as `Air` and `Will` before they can match, and the frozen tests still mask those spellings. The rule is:

`maskOwnClient` calls `nameMatcher` once for the client name and the location, with the contacts flag off, and once for the full contact and for `contactLead` when that lead contains whitespace, with the contacts flag on.

- word boundaries are `(?<![\p{L}\p{N}])` and `(?![\p{L}\p{N}])`
- both sides are NFC
- a client name or location of 3 or more characters is case-insensitive as a whole word, including when the name is on `STOPLIST`. Client name `Air` masks `air`, `Air`, and `AIR`, and does not mask `repair` or `aircraft`. Client name `Will` masks `will`, `Will`, and `WILL`. `acme` and `ibm` stay in this bucket
- a client name of 2 characters matches only the stored spelling and the upper-case spelling (`GE`, not `ge`)
- a single-token contact that is a stoplist word or shorter than 3 characters is skipped, so contact `Will` does not rewrite `will`. That skip applies only to the contact pass. It does not apply to the client name
- every name is escaped before it is compiled, so a metacharacter is a literal character

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

- For every stoplist client name in `will`, `air`, `mark`, `total`, `orange`, the lowercase, stored, and upper-case spellings are masked as whole words, and every carrier in `repair`, `aircraft`, `airline` still contains that carrier. The carrier is a longer word, not the name itself.
- For every pair of NFC and NFD spellings of `Société Générale` and `Ångström`, masking the NFD name removes the NFC word and the reverse.
- A multi-word contact `Jane Doe (Head of Claims)` still masks `Jane Doe` and does not mask `Jane` inside `Janeery`.
- For every millisecond offset `1..999`, `retainItems` at `2026-09-27T10:00:00.000Z` and at that offset produce different conversation ids, and the project id is `project-p-123` both times.
- Two calls with the same `now` and the same payload produce the same conversation id (retry).

Boundaries: empty client, name of length 2 (stored and upper-case only), name of length 3 or more (any case, including length 4 and length 5; length 5 is not a separate cutoff), contact that is only an email, text that is not a string, `now` with no fractional seconds (the 17-digit slice is shorter; the id must still be stable and must not throw).

## v2 — Sentinel

File: `deploy/cloudflare-edge/test/sweep01-g1-scrub-props.test.js`. Write these before the fix. No skip, no expected failure.

| Sentinel | Change | Red test |
|---|---|---|
| M1 | A client name of 3 or more characters matches as a whole word in any case, including a single stoplist word. `acme` masks `acme`, `Acme`, and `ACME`, and does not mask `acmeware`. Length 2 (`GE`) stays stored-form and upper-case only. | `M1 a three-letter client name is masked in any case` |
| Devin | The client name is not passed with `{ contacts: true }`. Client name `Air` masks `air`, `Air`, and `AIR`, and does not mask `repair`. Client name `Will` masks `will`, `Will`, and `WILL`. Contact `Will`, with no client name, does not mask `will`. One matcher implements both. | `D1 a stoplist client name stays masked and the same word as a contact does not` |
| L1 | `memory.scrub` and `sheet.scrub` run on every string those paths put into a retain item or a sheet draft, including nested sheet fields. Plant `acme` in each string and assert the output has no `acme` in any case. | `L1 every retain item and sheet field is masked` |
| L2 | Compile names with escaped literals. A client name `a+`, `(acme)`, `.*`, `[`, or `\` masks that literal text and does not mask a bare `a` or `acme`. A pathological name (a long run of `a+` metacharacters against a few thousand `a`s) finishes in under one second. | `L2 a client name of regex metacharacters is a literal and a pathological name finishes within one second` |

## Data migration

Hindsight documents already stored under the 14-digit id are not rewritten. This group has no bank credentials and must not call Hindsight. A later retain of a new utterance in the same second writes a new id; the old collided document remains until the subject forgets the bank or a later, separate memory job deletes it. Do not add that job here.

Stories and sheets already saved with `the client` baked into ordinary words are not repaired. The scrub runs on the way out to a model and on the way into memory, not on stored library JSON.

## Rollback

Revert the group commit. Memory and sheet go back to substring replacement. No schema change, no backfill to undo.

## Open PRs #15–#30

No file overlap with #15–#30. PR #17 edits `rating.js`, which imports `STOPLIST` from `scrub.js`. The re-export keeps that import valid. Do not change stoplist membership. The case-insensitive floor is 3 characters, and a stoplist client name is included. Keep the `GE` length-2 assertion. Update the `scrub.js` comment that still says a lowercase stoplist client name is not masked. In `scrub.test.js`, the case-rule title that says "5+" becomes 3, `nameMatcher(['Air'])` also masks lowercase `air`, client `Total` masks `total`, and client `Orange` masks `orange`. The contact assertion that `Will` does not mask `will` stays. Do not weaken it, or #17's rating tests will fail for a reason that is not `onEnd`.

`library.test.js` lines 157-162 stay the contract. Client `Air` makes `air`, `Air`, and `AIR` into `the client`, leaves `repair`, masks `Lyon`, and leaves `Lyonnais`. `clientScrub` of that name on `HR teams repair air ducts` still yields `HR teams repair the client ducts`. This group does not change those expected strings.

`masking-routes.test.js` lines 78-81 say client `Orange` is matched case-sensitively and that Kim's lowercase `orange` reaches the model unmasked. That comment is now wrong. `Orange` is a stoplist client name of 3 or more characters, so `orange` is masked as a whole word before the model. Alias `Heron` matches no library client, so the first company placeholder is `[Company 1]` and the map stores the typed span `orange`. Rewrite that comment. Change only these expectations. `Zebracorp` stays `another client` everywhere an assertion already says so.

- Line 99. `seen[0]` no longer starts with `orange juice`. The assertion becomes `assert.match(seen[0], /^\[Company 1\] juice/)`.
- Line 100. The fake model capitalizes the first sentence, which now starts with `[`, so `recordMask` stores the placeholder. Author `unmask` restores the typed spelling `orange`, not the capitalised echo `Orange`. The first requirement becomes `'orange juice supply chain experience is required for this tender.'` The second stays `'Claims routing like another client is needed.'`
- Line 103. The other view is `forOthers(recordText(stored))`. The stored first requirement is the placeholder, not the word `Orange`, so it becomes `'[company] juice supply chain experience is required for this tender.'` The second stays `'Claims routing like another client is needed.'` The old `'another client juice...'` string was the mask of the capitalised echo, and that echo is gone.
- Line 116. Ask's model still returns `why: 'Orange juice supply chains match.'` `forAuthor` passes the placeholder form of the question as `authorText`. `saidIn` does not see the word `orange` there, so `recordText` masks `Orange`. `r.why` becomes `'another client juice supply chains match.'` `r.caveat` stays `'Unlike another client, smaller.'`
- Line 119. The same echo. `r.why` becomes `'another client juice supply chains match.'` `r.transferable` becomes `['another client juice planning']`. `r.caveat` stays `'Unlike another client, smaller.'`
- Line 122. The slides model still returns the `Orange juice` strings, and the context was sent as a placeholder, so the author echo is masked. `s.title` becomes `'another client juice logistics'`. `s.summary` becomes `'another client juice planning, unlike another client.'` The bullet becomes `'another client juice supply chain was slow.'`

`docs/WOW_SPEC.md` line 191 is the case rule that still says 5 characters and not a single `STOPLIST` word, and that client `Total` does not mask `total cost of ownership` and client `Orange` does not touch `orange juice`. Replace that sentence. A client name of 3 or more characters, including a single stoplist word, is case-insensitive. `Total` masks `total` in `total cost of ownership`. `Orange` masks `orange` in `orange juice`. A name of 2 characters stays the stored spelling and the upper-case spelling. Line 192, the contact skip for `Will` and `Mark`, stays. Line 533, the F1.10 bullet, lists those same `Total` / `total cost` and `Orange` / `orange juice` pairs as the unmasked cases. Those lowercase forms are now masked. Contact `Will` versus `the supplier will` stays unmasked, and `Zebracorp` versus `zebracorp` stays masked.

PR #31 is the red-test branch. Land the fix on a branch that contains those tests, or cherry-pick the test file. Do not weaken the assertions.

## Owner lockout

None. This does not touch sign-in, Access, kill switches, or the profile row. A client named `Will` now masks the ordinary word `will`. That is the library test's case rule. Contact `Will` still does not.

## Diff size

About 150 lines of product code moved or rewritten, plus about 120 lines of property tests. `name-match.js` is mostly the existing `STOPLIST` and `nameMatcher` moved, not new logic. Review the move as a move.

## Known limits

A client name of 2 characters is still only the stored spelling and the upper-case spelling. A stoplist word that is only a contact is not masked. Misspellings and subsidiaries are not masked. Two retains with the same `now` string still share a conversation id.
