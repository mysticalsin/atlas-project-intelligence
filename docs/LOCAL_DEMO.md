# Local demo: a typed interview on your own machine (v2.2 D1)

The offline local edge (`deploy/cloudflare-edge/dev/local-edge.mjs`) runs the real Worker, the real library and the **real interview**: the browser's
`/api/voice` WebSocket is served by a small built-in server and handed to the real `Interview` Durable Object class (`src/worker.js`), which runs the real
`Session` (selector, reply guard, ledger, read-back, confirmation). Only the models are fakes. Nothing leaves the machine: no network, no paid provider, no
Cloudflare account, loopback only. Never deploy any file under `dev/`.

## Start

```sh
python3 build.py && python3 deploy/cloudflare-edge/build_edge.py     # only if deploy/cloudflare-edge/src/atlas.html is missing (it is generated, not committed)
cd deploy/cloudflare-edge && ATLAS_ADAPTERS=mock node dev/local-edge.mjs 8810
```

Needs Node 22 or later (`node:sqlite`); no `npm install`. The console prints `ATLAS local edge on http://127.0.0.1:8810 ... offline fake models`.
Open **http://127.0.0.1:8810/?as=you@mantu.com** (use `127.0.0.1`, not `localhost`: the Worker checks the origin).

## Run an interview

1. Press **Type instead** (not "Start interview": there is no speech recognition or voice offline), tick the consent box, then press **Type instead** again in the dialog.
2. Answer ATLAS's questions in the box (Enter sends; one answer per 1.5 seconds). Answer in English, French, Spanish, Portuguese, German, Italian or Dutch:
   ATLAS follows your language. Give a few concrete facts (what was wrong, what you built, a before and after figure and where it came from, who used it).
3. After the last question ATLAS reads the story back and the **read-back card** appears: **Keep private**, **Correct** (type the right wording), **Confirm summary**.
4. Confirm saves a **private draft that only you can see** (the evidence workflow, owner-only). Nothing reaches a reviewer until you press **Submit for review**.
5. As **reviewer@mantu.com** (`?as=reviewer@mantu.com`) the submitted item appears in the review queue; before the click nobody else can read your draft.

6. **Download my data** and **Delete my data** (two steps, with a confirmation token) work here too: the person's own interview object and the library both have
   in-memory storage, so the export has its library and interview parts and the erasure completes. Per-person rate limits (interview starts, library exports and so on) fire locally as they do deployed.

## People

`?as=email` signs you in as that person and is remembered in a cookie; add `?as=other@mantu.com` to switch. The default is `consultant@mantu.com`.
Admin is `tony.walteur@gmail.com` (`ADMIN_EMAILS` overrides), reviewer is `reviewer@mantu.com` (`REVIEWER_EMAILS`). Each person has their own interview object and drafts.

## What is real and what is fake

| Real (the code that ships) | Fake (offline stand-ins, `dev/`) |
| --- | --- |
| The Worker's `handle()`: identity, origin and CSRF checks, kill switches, rate limits (6 interviews per person per hour, 20 per day; raise with `RL_INTERVIEW_HOUR` and `RL_INTERVIEW_DAY`) | Sign-in: a local signing key stands in for Cloudflare Access |
| The Interview Durable Object and the `Session`: consent receipts, language following, the selector's next move, the reply guard, the live ledger, read-back, Keep private, Correct, confirmation, checkpoints | The talker model: plays back the selector's own proposed question, with short fixed lines per language (`dev/fake-interviewer.mjs`); it is not a judgement of your answers |
| The library (SQLite): the owner-only evidence draft, Submit for review, the reviewer queue, audit chain | The analyst model: picks fields for your sentences by keywords and quotes them exactly; the real model reads meaning |
| The page, as built | Speech recognition (hears nothing), voices (silence), embeddings, the review and recommendation models (`dev/fake-model.mjs`), Hindsight memory |
| | Durable Object storage and alarms: in memory, gone when the process stops |

The read-back and the wording of follow-ups are therefore simpler than with the real models. Whether the interview is good is judged on the deployed Worker,
not here. Destinations such as DNA, MiChat, IMP, Spotlight, MAAP and Project Review stay mocks (`ATLAS_ADAPTERS=mock`), never "synced" or "published".

## Tests

`cd deploy/cloudflare-edge && node --test test/local-demo.test.js` starts the edge on a free port and runs a typed interview over a real socket (consent, answers,
read-back, Keep private, Correct, confirm, owner-only draft, Submit for review, and a French answer that gets a French reply). The browser suites do not use the
local socket: they route `**/api/voice` to a scripted stand-in in the page first, and that still works.
