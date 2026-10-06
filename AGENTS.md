# PDD404 engineering rules

This is an independent product. Never deploy this checkout to the old Chiang Mai
swap site or reuse its database. The product specification in docs/PRODUCT.md is
the implementation contract. Record genuine deployment state in docs/releases/.

- Code and synthetic fixtures are MIT; local 资料/, production data, photos,
  contact details, credentials, .env files and backups must never enter Git.
- Public DTOs are explicit allowlists. The dedicated complete domestic-waybill
  POST query may return the opposite registrant's supplied WeChat/phone, as
  explicitly authorized for PDD404. Registration explains this disclosure.
  Public codes, tails, share pages and alternate query flags never grant this
  lookup or expose private evidence, addresses or management capabilities.
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
  instruct screenshot and CMI assistant follow-up. Registration remains full
  waybill only; approximate suggestions never increment matched-parcel counts.
- Worker calls require atomic budget reservation. Unknown cost retains the
  reservation. Do not loosen daily limits or retry indefinitely.
- No fabricated community QR, contacts, recognition output, progress or counters.
  Missing configuration is a visible service state.
- Only exact opposite-side waybill matches may disclose self-submitted contact
  and registration note. Public/share DTOs never return either. Homepage counts
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
