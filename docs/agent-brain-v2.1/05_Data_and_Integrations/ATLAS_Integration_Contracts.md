# Atlas Integration Contracts — Proposed

All contracts below are target designs. Confirm system owners, API schemas, authentication, rate limits, environments and live acknowledgements before implementation claims.

## 1. DNA — skills master
**Outbound proposal:** consultant stable ID; skill taxonomy ID; assertion/level; status; evidence references; reviewer; source revision; effective date.
**Required behaviour:** version-aware write; duplicate prevention; conflict response; acknowledgement with destination record ID and version.
**Do not:** write unverified AI claims or treat a story approval as skill approval.

## 2. MeChat — CV destination
**Input:** consultant ID; approved profile revision; approved contribution claims; language; audience/target role; template; inclusion and confidentiality permissions.
**Output:** CV document ID; version; generated status; timestamp; validation warnings.
**Do not:** send raw private interview transcript by default or include restricted client/project details.

## 3. IMP — availability and assignment context
**Read:** consultant ID; availability window; allocation; assignment state; constraints; freshness timestamp; source status.
Confirm official IC/TLO meanings, especially country-specific definitions. Atlas must not calculate or invent availability if IMP is authoritative.

## 4. Opportunity / CRM
**Read:** opportunity ID; role; mandatory criteria; preferred criteria; location/time-zone constraints; start date; lifecycle state; updated timestamp.
Mandatory eligibility is deterministic. Preferred fit is evidence-ranked and explained.

## 5. Spotlight / CMS
**Write proposal:** approved story revision ID; public-safe claims; customer naming/metric/logo permissions; language; channel; approved assets; CTA; approver IDs.
**Response:** CMS ID, canonical URL, publication state, publish timestamp and revision hash.
Only exact approved revision may publish. Any content change invalidates prior approval.

## 6. Bid/JEV retrieval
Input: prospect/industry/challenge/technology/context. Output: relevant story references, match explanation, permission status, source revision. Relevance does not confer approval.

## 7. Reliable job envelope
```json
{
  "job_id": "uuid",
  "idempotency_key": "source-revision:destination",
  "source_entity_id": "uuid",
  "source_revision": 4,
  "destination": "DNA|MeChat|IMP|Spotlight",
  "payload_hash": "sha256",
  "status": "queued|running|succeeded|retrying|failed|needs_reconciliation",
  "attempt": 0,
  "destination_ack": null,
  "created_at": "ISO-8601"
}
```

## 8. Reliability requirements
- Idempotency key per source revision and destination.
- Bounded retries with exponential backoff and jitter.
- Separate status per destination; partial success is normal and visible.
- Do not report success until destination acknowledgement.
- Reconcile source and destination revisions.
- Dead-letter queue and human recovery for repeated failure.
- Never overwrite a newer destination revision.
- Audit actor, payload hash, timestamps, attempts, acknowledgement and errors.
