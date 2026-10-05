# CMI-Find my pdd engineering rules

This is an independent product. Never deploy this checkout to the old Chiang Mai
swap site or reuse its database. The product specification in docs/PRODUCT.md is
the implementation contract. Record genuine deployment state in docs/releases/.

- Code and synthetic fixtures are MIT; local 资料/, production data, photos,
  contact details, credentials, .env files and backups must never enter Git.
- Public DTOs are explicit allowlists. No alternate query flag may expose private
  evidence, WeChat IDs, addresses, complete numbers or management capabilities.
- Browser users have no account or direct database access. Capabilities are
  random 32-byte secrets in headers; management URLs keep them in fragments.
- Extraction is image-derived and read-only. Edits create a new input version.
  Old leased jobs may settle costs but cannot write data or create notifications.
- Exact matching requires same typed, clear, complete, non-shared individual
  waybill and no known carrier conflict. A match never confirms ownership.
- Worker calls require atomic budget reservation. Unknown cost retains the
  reservation. Do not loosen daily limits or retry indefinitely.
- No fabricated community QR, contacts, recognition output, progress or counters.
  Missing configuration is a visible service state.
- Run npm run check and npm run build for changes affecting behavior. Use
  synthetic labels for API/OCR verification. Migrations require real transactional
  tests and a restore check; never reset production to fix a migration.
- Branch codex/..., review via PR, merge main after checks. Runtime release tags
  only after production acceptance; document-only edits are not new deployments.
- All administrative changes are audited; ownership and actual return are
  distinct actions. Only actual return increments recovery statistics.
