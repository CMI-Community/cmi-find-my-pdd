# PDD404 engineering rules

This is an independent product. Never deploy this checkout to the old Chiang Mai
swap site or reuse its database. The product specification in docs/PRODUCT.md is
the implementation contract. Record genuine deployment state in docs/releases/.

- Code and synthetic fixtures are MIT; local 资料/, production data, photos,
  contact details, credentials, .env files and backups must never enter Git.
- Public DTOs are explicit allowlists. The dedicated complete domestic-waybill
  POST query and dedicated complete-recipient-name POST queries may return the
  opposite registrant's supplied contact and note, as authorized for PDD404. Registration explains this disclosure.
  Public codes, tails, share pages and alternate query flags never grant this
  lookup or expose recipient names, private evidence, addresses or management capabilities.
- Browser users have no account or direct database access. Capabilities are
  random 32-byte secrets in headers; management URLs keep them in fragments.
- PDD404 accepts manual or locally barcode-decoded domestic waybills. Do not
  manufacture OCR evidence or activate old image drafts. Legacy extraction
  remains image-derived and read-only. Edits create a new input version.
  Old leased jobs may settle costs but cannot write data or create notifications.
- PDD404 matches equal normalized complete domestic waybills only. Normalize
  whitespace and letter case; retain leading zeroes. A match never confirms
  ownership. Legacy evidence matching retains type/quality/carrier restrictions.
- Approximate queries are suggestions only: normalized character similarity
  must exceed 70% and stay below 100%, with unreadable ?/* characters penalized.
  Return at most five allowlisted masked references, never contact or note;
  instruct screenshot and CMI assistant follow-up. Waybill registration remains
  full-number only; independent exact-name leads are a separate resource.
  Approximate suggestions never increment matched-parcel counts.
- Recipient names use NFC, trimmed/collapsed whitespace and ASCII case folding,
  preserve word spaces and symbols, and reject controls. Same-name people remain
  independent; only active independent name+side+validated-contact duplicates
  are suppressed. Name leads never increment parcel registration/match/return
  statistics. Do not infer names from legacy images or backfill private data.
- Worker calls require atomic budget reservation. Unknown cost retains the
  reservation. Do not loosen daily limits or retry indefinitely.
- No fabricated community QR, contacts, recognition output, progress or counters.
  Missing configuration is a visible service state.
- Only dedicated exact opposite-side waybill or complete-name POST queries may
  disclose self-submitted contact and registration note. Public/share DTOs never
  return names, contacts or notes. Name hits are leads, never parcel matches.
  Homepage counts
  derive from formal registrations and unique successful matching facts;
  successful matching does not increment actual-return statistics.
- Community feedback is administrator-only. Public submission returns only its
  receipt; status changes write audits without message or contact snapshots.
- Run npm run check and npm run build for changes affecting behavior. Use
  synthetic labels for API/OCR verification. Migrations require real transactional
  tests and a restore check; never reset production to fix a migration.
- Branch codex/..., review via PR, merge main after checks. Runtime release tags
  only after production acceptance; document-only edits are not new deployments.
- All administrative changes are audited; ownership and actual return are
  distinct actions. Only actual return increments recovery statistics.
- Query logs use server time. A lookup miss is a local pending draft, never a
  formal registration. Recheck each number transactionally at batch submission.
- The primary service does not depend on OpenAI. OCR writes stay disabled for
  this release; no automatic offsite notifications are promised.
