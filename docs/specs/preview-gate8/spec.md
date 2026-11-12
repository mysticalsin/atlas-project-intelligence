# Gate 8 preview URL

Backlog `GEN-WEB-HANDSON-PREVIEW-URL`. Tony has approved a non-production preview URL that uses synthetic data only. Specs live in `docs/`. This one stays in the existing Wrangler file and the existing ledger. No second worker, no new service.

The live script is `atlas` (`deploy/cloudflare-edge/wrangler.jsonc`). Its top level stays the production configuration: `LEDGER_MODE=enforce`, no limit override, so the $5 UTC-month default applies. A Preview does not inherit those settings. The `previews` block is the preview configuration.

## What a preview is

- Empty Durable Object storage. Cloudflare gives each Preview its own namespaces for `Interview`, `LibraryStore` and `ProductionSpendLedger`. Nothing is seeded. There is no file of people.
- `DATA_MODE` is absent, so the existing test-mode rule stays: DNA pull and push stay `BLOCKED_EXTERNAL`, and a directory import accepts only synthetic addresses (`example.com`, `example.org`, `example.net`, `.test`). A real consultant address is rejected.
- `LEDGER_MODE` is set to `enforce`. Unset, `off` and `observe` are refused before any page or call. The $5 default is the cap. There is no preview-only override.
- Workers AI is on, under that cap. The binding name is `AI`. Hindsight, TypeSafe, ElevenLabs and OpenAI stay off: their secrets are not in the file and are not copied onto the Preview.
- When the cap is hit, the existing sentence is the stop: "This month's AI budget is used up." The next paid call is not made.
- Every HTML page carries a visible banner: "Preview. Fake data only." The pages are `/`, `/confirm`, `/go/signed-in`, and the sign-in response. The banner is injected by the Worker. The built HTML file does not change.
- The Preview does not copy the production origin `https://atlas.tony-walteur.workers.dev`, the production Access audience, or the production Access team. A request whose host is that production host is refused. A Preview host is `https://<label>-atlas.tony-walteur.workers.dev`.
- The top-level cron stays on production. The `previews` block has no cron, no route, and no `script_name` pointing at `atlas`.

## Later commands

Run these from `deploy/cloudflare-edge`, with Wrangler 4.135.0 or later. They upload a Preview. They do not deploy production.

```sh
npx --yes wrangler@4.135.0 preview --name gate8
npx --yes wrangler@4.135.0 preview secret put CSRF_SECRET --name gate8
```

The secret is a new random value for this Preview only. Do not put `HINDSIGHT_API_KEY`, `TYPESAFE_API_KEY`, `ELEVENLABS_API_KEY`, `DIRECTORY_PUSH_SECRET`, `TRIGGER_SECRET` or `ATLAS_LEDGER_TOKEN` on it.

Do not run `deploy.sh`, `wrangler deploy`, or `wrangler versions upload` (with or without `--preview-alias`). A version upload uses the production script. Version URLs are not generated for a Worker that has Durable Objects, and an alias does not isolate those objects.

Token scope: **Workers Scripts Write**. That is the group on the Preview update and delete operations. Create Preview did not publish a separate group. The same scope can also upload a version of the production script, so the command that is run is `wrangler preview`.

## What one session can spend

One short hands-on session, priced at the list rates already in `prices.js`, with the Workers AI proxy of $0.0060003 on each binding call: 10 turns of 30 seconds of speech, a talker call of 2,000 input tokens and 300 output tokens, 400 spoken characters, and one analyst call of 8,000 input tokens and 3,000 output tokens. No memory, no JEV, no ElevenLabs, no realtime, no document conversion.

That session is about $0.35. The month stops at $5.
