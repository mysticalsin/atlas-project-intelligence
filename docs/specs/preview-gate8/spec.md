# Gate 8 preview URL

Backlog `GEN-WEB-HANDSON-PREVIEW-URL`. Tony has approved a non-production preview URL that uses synthetic data only. The preview is on Cloudflare. This change does not deploy it and does not use a token. Specs live in `docs/`. This one stays in the existing Wrangler file and the existing ledger. No second worker, no new service.

Tony's ruling, in his own words: "Turn live AI on in the preview, under the existing $5/month cap."

- Live AI is on. It is enforced by the existing $5/month fail-closed ledger. The Preview `ai` binding is `AI`. `LEDGER_MODE` is `enforce`. `PRODUCTION_MONTHLY_LIMIT_USD` is omitted, so the $5 default in `meter.js` applies. The Preview binds `SPEND_LEDGER` to `ProductionSpendLedger`, the same class as production. Cloudflare gives that Preview its own Durable Object namespace, so the production month is not spent. The class, the $5, and the refusal are the existing ledger. No separate preview cap.
- When the cap is hit, the stop is clean and visible. The existing sentence is "This month's AI budget is used up." The page shows that sentence and no helper text. A voice session sends `budget_exhausted`. The next paid call is not made.
- A separate preview cap is not added. The existing ledger is shared cleanly: same class, same $5, same fail-closed door.

The live script is `atlas` (`deploy/cloudflare-edge/wrangler.jsonc`). Its top level stays the production configuration. A Preview does not inherit those settings. The `previews` block is the preview configuration.

## What a preview is

- Empty Durable Object storage. Cloudflare gives each Preview its own namespaces for `Interview`, `LibraryStore` and `ProductionSpendLedger`. Nothing is seeded. There is no file of people.
- `DATA_MODE` is absent, so the existing test-mode rule stays: DNA pull and push stay `BLOCKED_EXTERNAL`, and a directory import accepts only synthetic addresses (`example.com`, `example.org`, `example.net`, `.test`). A real consultant address is rejected.
- `LEDGER_MODE` is `enforce`, or unset. Unset means enforce. `off` and `observe` are refused. The live Worker has no `SPEND_LEDGER` and no v3 migration. This file has both, and the preview upload refuses without them.
- Workers AI is on only when that same build binds `SPEND_LEDGER` to `ProductionSpendLedger` and the v3 migration creates that class. If the binding is missing at runtime, every AI call fails closed. It does not log and continue. Hindsight, TypeSafe, ElevenLabs and OpenAI stay off: their secrets are not in the file and are not copied onto the Preview.
- Every HTML page carries a visible banner: "Preview. Fake data only." The pages are `/`, `/confirm`, `/go/signed-in`, and the sign-in response. The banner is injected by the Worker. The built HTML file does not change.
- The Preview does not copy the production origin `https://atlas.tony-walteur.workers.dev`, the production Access audience, or the production Access team. A request whose host is that production host is refused. A Preview host is `https://<label>-atlas.tony-walteur.workers.dev`.
- `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` are not in `previews.vars`. `verifyAccess` (`app.js`) returns no identity without both, and the ledger route would otherwise skip its Access check when `ACCESS_AUD` is empty. A preview request with either value missing returns 403 `Preview Access is not configured.` It does not return the sign-in page, and it does not reach the ledger or a model call. There is no auth bypass.
- The preview Access application is a different application from production. Pass its audience and its team on the upload command. Do not commit them. Do not pass the production audience `fc05e3d966db92b03ed3bf38b31e5c5254e1508bb0e090825a56ce12a933f386` or the production team `tony-walteur.cloudflareaccess.com`: the Worker answers 503. The JWT issuer and the certs host are the team domain, so an application on the production team cannot be used. Create the preview application on another Zero Trust team, for the preview hostname only.
- The top-level cron stays on production. The `previews` block has no cron, no route, and no `script_name` pointing at `atlas`.
- Durable Object classes and migrations stay at the top level, which is where Cloudflare's preview docs say they belong. `previews` has no `migrations` key, so it cannot replace that list. `wrangler preview` has no dry-run. Assembling the deployment request calls `getPreviewDeployment` before it attaches migrations, and that call needs the network, so this repository does not execute the upload. What was run offline is `getPreviewMigrationsToUpload` from the installed Wrangler 4.158.0 (the same decision is in the published preview source, and `--var` has been on `wrangler preview` since 4.132.0). With no current migration tag it returns `new_tag: "v3"` and three steps, `new_sqlite_classes` `Interview`, `LibraryStore`, then `ProductionSpendLedger`. A preview whose latest deployment is already tag `v3` sends no steps. Cloudflare applying that payload was not observed.

## Later commands

Run these from `deploy/cloudflare-edge`, with Wrangler 4.135.0 or later. They upload a Preview. They do not deploy production, and they do not change the AI Gateway limit or account billing.

`bash preview.sh` runs `node preview-guard.mjs` first. The guard reads this `wrangler.jsonc`. If the `previews` block has no `SPEND_LEDGER` binding to `ProductionSpendLedger`, or this file has no v3 migration that creates that class, or `LEDGER_MODE` is set to anything other than `enforce` or unset, the guard exits 1 and wrangler is not started.

`ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` are plain text, supplied on this command. They are not secrets and they are not written into the file. Without them the upload can still be built, and every request then returns 403.

```sh
bash preview.sh --var ACCESS_AUD:<preview audience> --var ACCESS_TEAM_DOMAIN:<preview team>
npx --yes wrangler@4.135.0 preview secret put CSRF_SECRET --name gate8
```

The secret is a new random value for this Preview only. Do not put `HINDSIGHT_API_KEY`, `TYPESAFE_API_KEY`, `ELEVENLABS_API_KEY`, `DIRECTORY_PUSH_SECRET`, `TRIGGER_SECRET` or `ATLAS_LEDGER_TOKEN` on it.

Do not run `deploy.sh`, `wrangler deploy`, or `wrangler versions upload` (with or without `--preview-alias`). A version upload uses the production script. Version URLs are not generated for a Worker that has Durable Objects, and an alias does not isolate those objects.

Token scope: **Workers Scripts Write**. That is the group on the Preview update and delete operations. Create Preview did not publish a separate group. The same scope can also upload a version of the production script, so the command that is run is `wrangler preview`.

## What one session can spend

One short hands-on session, priced by `callCeilingNano` in `meter.js` at the list rates in `prices.js`. The Workers AI proxy on each binding call is `PROXY_PER_CALL_NANO` = 6,000,300 nano-dollars = $0.0060003. The session is ten speech-to-text calls of 30 seconds, one talker call of 2,000 input tokens and 300 output tokens, one text-to-speech call of 400 characters, and one analyst call of 8,000 input tokens and 3,000 output tokens. No memory, no JEV, no ElevenLabs, no realtime, no document conversion, no turn-detection call.

`priceOf` rounds each call up to the next nano-dollar, then `callCeilingNano` adds the proxy because each model id starts with `@cf/`.

- Speech, `@cf/deepgram/nova-3`, 30,000 ms: `ceil(30000/60000 * 0.0052 * 1e9)` = 2,600,000, plus the proxy = 8,600,300. Ten calls = 86,003,000.
- Talker, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, 2,000 in and 300 out: `ceil((2000*0.293 + 300*2.253) / 1e6 * 1e9)` = 1,261,900, plus the proxy = 7,262,200.
- Speech output, `@cf/deepgram/aura-2-en`, 400 characters: `ceil(400/1000 * 0.030 * 1e9)` = 12,000,000, plus the proxy = 18,000,300.
- Analyst, `@cf/openai/gpt-oss-120b`, 8,000 in and 3,000 out: `ceil((8000*0.35 + 3000*0.75) / 1e6 * 1e9)` = 5,050,000, plus the proxy = 11,050,300.

The sum is 122,315,800 nano-dollars, which is $0.1223158. Thirteen binding calls carry the proxy. The existing ledger stops the month at $5. The visible sentence is "This month's AI budget is used up." The provider is not called.
