# ATLAS on Cloudflare — Tunnel + Access

The ATLAS gateway (`atlas_voice/server.py`) runs **unchanged** on one always-on host. Cloudflare provides the public HTTPS hostname, WebSocket transport and an outer access gate. Nothing in the application stack is replaced, and the Markdown/SQLite vault stays on durable local disk.

```
Browser ──HTTPS/WSS──▶ Cloudflare edge ──Access policy──▶ cloudflared (outbound tunnel)
                                                           │ http://127.0.0.1:8080, Host pinned
                                                           ▼
                                               ATLAS gateway (one process, Entra auth)
                                                           │ server-side secrets
                                                           ▼
                                        OpenAI Realtime · Hindsight (private) · TypeSafe JEV
```

## Why this shape
- Workers cannot run the aiohttp gateway, and Containers have ephemeral disk. Either option would mean rewriting the vault/registry layer, which the handoff forbids without a measured need.
- The gateway keeps its own exact Host/Origin, CSRF and cookie checks. `cloudflared` pins `Host` to the public hostname, so those checks pass unmodified.
- No inbound port is opened. The gateway binds `127.0.0.1` and is reachable only through the tunnel.
- **Access is an outer gate, not the app identity.** `ATLAS_AUTH=local` is refused off loopback by `Config.validate()`, on purpose: every user would share one identity, one Hindsight bank and no independent reviewer. Entra (`ATLAS_AUTH=entra`) stays mandatory.

## Prerequisites (operator-owned; none are in this repository)
| Item | Needed for |
|---|---|
| Cloudflare account with a zone (domain) you control, plus Zero Trust enabled | Tunnel, DNS record, Access |
| Always-on host: Linux VM (preferred) or a Mac that stays awake, Python 3.11+ | Gateway process + vault disk |
| `cloudflared` on that host | Tunnel connector |
| OpenAI API key with access to the configured Realtime and transcription models | Hosted voice |
| Entra app registration: redirect `https://<host>/auth/callback`, client secret, app roles `ATLAS.Interview` / `ATLAS.Review` / `ATLAS.Publish` assigned to real users | App identity and review separation |
| Optional: private Hindsight service (pinned fork), TypeSafe key | Continuity, JEV matching |

## Steps
1. **Gateway host.**
   ```sh
   python3 -m venv /opt/atlas/venv
   /opt/atlas/venv/bin/python -m pip install -r requirements.txt
   PATH="/opt/atlas/venv/bin:$PATH" make install-integrations
   cp deploy/cloudflare/atlas.env.example .env && chmod 600 .env   # then fill it in securely
   /opt/atlas/venv/bin/python scripts/doctor.py --profile cloudflare --env-file .env
   ```
   Use a private durable `ATLAS_WIKI_ROOT` outside any sync folder, and back up its Markdown and SQLite together.
2. **Tunnel.**
   ```sh
   cloudflared tunnel login                         # browser consent to your Cloudflare account
   cloudflared tunnel create atlas                  # writes <TUNNEL_UUID>.json credentials
   cloudflared tunnel route dns atlas atlas.example.com
   ```
   Copy `config.yml.example`, replace the tunnel UUID, the credentials path and **both** hostname fields, and keep the final `http_status:404` rule.
3. **Access application.** Zero Trust → Access → Applications → *Self-hosted*, set the hostname to your ATLAS hostname. Add Microsoft Entra ID as the login method and allow only the Entra group that holds `ATLAS.Interview`. Keep the Access session no shorter than the app's 1-hour session, so the Entra callback is never interrupted mid-flow.
4. **Zone settings for the hostname.** Turn off Rocket Loader, Email Address Obfuscation and automatic Web Analytics injection. Each one rewrites HTML or injects scripts, which the strict CSP blocks. Leave WebSockets on. The gateway sends `Cache-Control: no-store` on every response. Do not add cache rules.
5. **Run.** Start the gateway, then the tunnel:
   ```sh
   bash scripts/start_gateway.sh          # or install deploy/cloudflare/atlas-gateway.service.example
   cloudflared tunnel run atlas           # or: sudo cloudflared service install
   ```
6. **Smoke test.** Open `https://<host>` → Access login → ATLAS sign-in page → Entra → interview page. Run acceptance rows V01–V03 and I01–I02 from `handoff/ACCEPTANCE.md` with two real test identities.

## Operating limits (unchanged by Cloudflare)
- One process and one active interview. Never run a second gateway replica or a second tunnel connector against another vault copy.
- A gateway restart drops in-memory sessions and any live interview. Users sign in again.
- `curl -I http://127.0.0.1:8080/` from the host returns **403**, because Host must equal the public origin. That is expected.
- Stop/rollback: `cloudflared tunnel` service stop (the public hostname then fails closed with Cloudflare error 1033), stop the gateway, restore the jointly backed-up vault if needed.

Configuring these files does not prove a live path. Record each live acceptance result in `handoff/BUILD_STATUS.md`.
