# Atlas Domain Model & Schema Blueprint

## 1. Core entities
- `Person`: immutable internal ID, workforce identity references, locale, status.
- `Project`: immutable project ID, account/client reference, country, practice, dates, lifecycle, scope, owner.
- `ProjectParticipation`: person/project relationship, role, dates, allocation (if authoritative), responsibilities.
- `Contribution`: specific actions, decisions and deliverables attributable to a person/team.
- `EvidenceItem`: artifact/source reference, type, access class, owner, checksum/reference, created date, retention.
- `Claim`: atomic factual statement, subject, predicate, value, unit, source refs, attribution, status, revision.
- `Outcome`: baseline, after-state, unit, period, method, source, attribution and confidence label.
- `SkillTaxonomyItem`: stable taxonomy ID, name, definition, aliases, version, parent.
- `SkillAssertion`: person, skill ID, level claim, evidence refs, status, last-used date.
- `Assessment`: assessor, rubric/version, result, date, scope, evidence refs.
- `Credential`: exact name, issuer, issue/expiry, verification status/source.
- `MAAPReview`, `ReviewResponse`, `ReviewAction`, `ReviewAmendment`.
- `Story`, `StoryRevision`, `PublicationPermission`, `Approval`.
- `ProfileRevision`, `CVDocumentReference`.
- `OpportunityReference`, `AvailabilitySnapshot`, `MatchExplanation`.
- `IntegrationJob`, `IntegrationAttempt`, `AuditEvent`.

## 2. Relationship rules
Person ↔ ProjectParticipation ↔ Project; Participation ↔ Contribution; Contribution ↔ EvidenceItem/Claim/Outcome; SkillAssertion ↔ TaxonomyItem and EvidenceItem; Assessment ↔ SkillAssertion; MAAPReview ↔ Person/Project/ReviewAction; StoryRevision ↔ Project/Claim/EvidenceItem/Permission/Approval; ProfileRevision ↔ approved claims; IntegrationJob ↔ source revision and destination acknowledgement.

Project outcome and individual contribution must be distinct. A team result must not be copied as an individual achievement without attribution.

## 3. Suggested Claim schema
```json
{
  "claim_id": "uuid",
  "subject_type": "person|project|team|client",
  "subject_id": "stable-id",
  "claim_type": "responsibility|deliverable|technology|outcome|metric|credential",
  "statement": "Consultant designed the ingestion pipeline",
  "value": null,
  "unit": null,
  "baseline": null,
  "after_state": null,
  "measurement_period": null,
  "attribution": "individual|team|client|unknown",
  "source_refs": [],
  "evidence_status": "consultant_reported",
  "review_status": "draft",
  "revision": 1,
  "created_by": "actor-id",
  "created_at": "ISO-8601"
}
```

## 4. Evidence status enums
`draft`, `needs_clarification`, `submitted`, `validated`, `disputed`, `rejected`, `superseded`, `withdrawn`.
Evidence origin: `consultant_reported`, `artifact_supported`, `manager_validated`, `client_validated`, `independently_measured`, `estimated`, `unknown`.

## 5. Permissions
Permission grant should include subject, purpose, destination, content scope, channel, geography, expiry, grantor, legal basis/consent reference where applicable, status and revocation time. Purposes: `internal_knowledge`, `cv`, `bid_client_facing`, `public_spotlight`.

## 6. Versioning
- Stable entity IDs; immutable revisions for claims, stories, profile outputs and reviews.
- Every approval binds to an exact revision hash.
- Corrections create successor revisions and identify derivatives.
- Optimistic concurrency with `expected_revision`.
- Do not store LLM reasoning traces as evidence. Store concise rationale and structured decision outcomes where appropriate.
