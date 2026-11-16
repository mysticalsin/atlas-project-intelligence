# Retention schedule

Status: **PROPOSAL — DPO to confirm**. Generated from `atlas_voice/config/retention.json` by `scripts/render_privacy_docs.py`. Edit the JSON, not this file.

Every period below is a conservative engineering proposal, not a legal decision. Mantu's DPO and legal team set the real periods; change `days` here and the daily sweep follows (deploy/cloudflare-edge/src/retention.js). `sweep: false` means the period is documented but enforced elsewhere (platform, alarm or per-person prune).

| What | Kept for | Counted from | Then | Enforced by | Status |
|---|---|---|---|---|---|
| Private drafts never submitted for review (library drafts and evidence drafts) | 90 days | last change | deleted | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Withdrawn references | 90 days | withdrawal | content erased (an empty marker stays) | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Rejected or withdrawn evidence records and their claims | 180 days | last change | content erased (an empty marker stays) | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Expired confirmation requests and proof (gap) requests | 90 days | expiry | deleted | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Outreach messages and interview invitations that are finished | 90 days | sent, dismissed, done or expired | deleted | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Staffing import rows (who worked on which project, N+1) | 180 days | project end date, else last import | deleted | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Audit trail rows | 730 days | row date | pseudonymised (actor replaced, free text cleared) | LibraryStore daily sweep (the audit hash chain is re-sealed and its new head logged) | PROPOSAL — DPO to confirm |
| Consent receipts (records that a choice was made) | 2190 days | the person's latest receipt | deleted | LibraryStore daily sweep | PROPOSAL — DPO to confirm |
| Pseudonymous security-event log lines | 90 days | event | handled by the platform | the log sink or Cloudflare Workers Logs plan (to verify) | PROPOSAL — DPO to confirm |
| Private memory facts (Hindsight, only if the person turned memory on) | 365 days | last update | forgotten | pruned for that person each time memory is used; the person can erase it at any time | PROPOSAL — DPO to confirm |
| Interview checkpoint (resume after a dropped connection) | 24 hours | first write | deleted | Interview Durable Object alarm | Decided by Tony (24 h absolute) |

## How it is enforced

- **Daily sweep.** The Worker cron (06:17 UTC) posts `scan-stale` to the LibraryStore, which runs `retention.js sweep` after its other daily housekeeping. The sweep returns counts only (never an id or a word of content) and a quiet day returns nothing.
- **Erasure rather than row deletion.** Content is replaced by a tombstone (`{erased: true, at}`); ids, counts and joins stay so nothing else breaks. Drafts and expired requests are erased the same way or deleted outright as the table says.
- **Audit trail.** Rows older than the period lose their actor (a random token per person per sweep) and their free text; the action, the record id and the time stay. The row keeps an HMAC commit of the actor and detail. A sweep writes an erasure tombstone and a proof, and does not recompute later hashes, so the head does not move. The security log records `audit_chain_ok` / `AUDIT_PSEUDONYMISED`.
- **Things the sweep never removes on its own.** Approved evidence, published references and bids are not retention targets: they are held for the DPO when a person asks for erasure (`erasure_holds`), and are withdrawn rather than deleted by the withdrawn-references rule only when no bid uses them and the DPO holds nothing on them.
- **Not swept by this code (listed so silence is not read as done).** Security log lines (the log sink or the Cloudflare Workers Logs plan sets the period; to verify), private memory (pruned for that person each time memory is used; the person can erase it any time; a bank-wide sweep would need a list of every bank), the 24-hour checkpoint (a Durable Object alarm).
- **Platform copies.** Durable Object point-in-time recovery can keep a deleted record for a period set by Cloudflare (to verify). The privacy notice says so.
- **Test deployment.** A retention rule that deletes content is only as good as the clock and the data: the tests use a fake clock (`test/g2-retention.test.js`); no live deployment has run it.
