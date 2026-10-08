# PDD404 Project Workpad

Last updated: 2026-10-09 Asia/Bangkok

## Snapshot
- Status: Runtime released; editorial review pending; automation prompt update approval-blocked
- Current focus: Implement approved data insights and outreach pages, daily snapshots and reviewed publication.
- Next step: Review the exact first editorial/material candidates; receive the real independent developer QR. Evening automation prompt update remains blocked by the tool approval policy.

## Project Goal
Provide readable, continuously updated public data at `/insights` and usable sharing materials at `/share`, while preserving parcel lookup, privacy and the distinction between clues, matches and actual returns.

## Scope
- Existing six lifetime homepage statistics, daily same-definition snapshots, 7/30-day history, reviewed dated observations and shared media directory.
- Independent developer-group configuration, navigation, anchored help links, copy/download interactions and honest missing-content states.
- Append-only publication versions and administrator audit, public allowlisted read APIs, immutable public assets, backup and restore coverage.
- Daily statistics collected independently with pg_cron at 20:00 Asia/Bangkok; local evening reports remain drafts until an exact artifact is approved in this chat.
- No invented historical data, news, video, QR codes, personal success rates, or changes to existing five-minute monitoring.

## Key Decisions
| Date | Decision | Reason | Status |
| --- | --- | --- | --- |
| 2026-10-08 | React/Edge pages on pdd404.app; automatic data and reviewed editorial content | User-approved implementation plan | Confirmed |
| 2026-10-08 | Preserve homepage lifetime metric contract; start history at first genuine snapshot | Earlier local report counts use a different definition | Confirmed |
| 2026-10-08 | Developer group is independent of the current parcel-finding group | User confirmed separate group; QR asset remains pending | Confirmed |
| 2026-10-08 | Third-party summary cards link to originals | Avoid unreviewed embeds and copied media | Confirmed |

## Task Board
### Now
- [x] Verify and seal complete current UI baseline: 1011 pairs, 1009 captured and 2 source-backed not-applicable, no gaps; existing runtime evidence retains its genuine original dates.
- [x] Implement snapshots, safe public content APIs and audited administrator publication, including read-only revision status after withdrawal.
- [x] Implement publication tooling, scoped backup/restore support and content preparation.
### Next
- [x] Implement both pages, responsive navigation and help anchors after baseline.
- [x] Complete candidate state matrix, database transactional/restore tests, check and build.
- [x] Seal production UI acceptance; PR #47 and database/API/frontend deployment are complete with real identity checks.
- [ ] Update existing evening automation to the new draft/review workflow — automatic approval rejected view/update because the tool requires approval while the active policy is never; original ACTIVE heartbeat remains unchanged.
### Done
- [x] User approved detailed implementation plan.
- [x] Created `codex/insights-outreach`; initial working tree was clean.
- [x] Verified baseline-time Vercel frontend `fbb6e99c688d723117236a63c12cd83bb24ed597`; subsequent release uses 0150ff9.

## Risks And Open Questions
| Type | Item | Impact | Next check | Status |
| --- | --- | --- | --- | --- |
| Asset | Real independent developer-group QR file/location not supplied | Group panel must show missing state | Await user location; content can update independently | Open |
| Content | No verified first news/video release links | Empty directory sections remain honest | Prepare reviewable directory without invented links | Open |
| Evidence | Current-runtime complete baseline | Required before first UI source edit | Live SHA, 12 static hashes and original matrix matched; 24 fresh captures added | Validated |
| Release | Complete candidate archive and production acceptance | Runtime rollout and acceptance complete | Candidate and production each 505 cases / 1159 pairs, 1157 captured + 2 source-backed N/A; production is entirely fresh | Validated |

## Implementation Notes
- Contract: [PRODUCT.md](PRODUCT.md); operational rules: [MONITORING.md](MONITORING.md).
- Private analysis, drafts, assets, backups and UI archives remain in ignored local directories.
- No daily editorial content is public merely because a draft exists or the runtime was deployed.

## Validation Log
| Date | Check | Result | Notes |
| --- | --- | --- | --- |
| 2026-10-08 | Initial Git status | Clean | Main at `78d349c` before branch creation |
| 2026-10-08 | Live Vercel production identity | READY | Existing six-statistics runtime `fbb6e99` |
| 2026-10-08 | Baseline archive | Complete | `output/playwright/releases/20261008T211542922621+0700-0-2-0-fbb6e99c688d-baseline-a4dbe7d2/` |
| 2026-10-08 | First full npm check | Passed | 285 Vitest + 63 Edge tests; 1 optional real-PG fixture skipped here, verified independently below |
| 2026-10-08 | First npm build | Passed | Subsequent final source still requires candidate check/build |
| 2026-10-08 | Disposable real PostgreSQL and encrypted scoped restore | Passed | Migration rollback/commit, concurrency, immutable sampling/publication, 28 tables / 293 rows, asset hash and old-manifest compatibility |
| 2026-10-08 | Preliminary UI | Passed | 12 new-page layouts at 320/390/1280; navigation, date/history, help anchors, copy, download and QR interaction |
| 2026-10-08 | Live cron timezone | GMT | Confirmed 13:00 UTC corresponds to Bangkok 20:00; independent new job only |
| 2026-10-08 | Frozen source check/build | Passed | 287 Vitest + 67 Edge checks, one optional fixture independently verified; configured/unconfigured immutable builds use runtime SHA0150ff9 |
| 2026-10-08 | Final clean candidate | Complete | 505 cases / 1159 pairs: 1157 captured and two source-backed N/A; five fresh non-QR fixture revisions, other source-identical evidence with original provenance |
| 2026-10-08 | PR #47 / CI run108 | Merged / Passed | Merge fdb0250e; runtime source remains 0150ff9 |
| 2026-10-08 | Actual database/API/frontend rollout | Passed | Canonical migration20261008133000, API29, worker25 unchanged, Vercel dpl_8RQwRLz8u9hcGUhFr5amJp8QCkiB READY/domain aliases correct |
| 2026-10-09 | Actual public acceptance | Passed | 15 API/route assertions, 12 static file hashes, empty unapproved content, no business/editorial submission |
| 2026-10-09 | Midnight real-PG verification-tool repair | Passed | 20:00 is cron schedule only; direct service-role first capture and rerun are tested at any time. 28 tables / 294 synthetic rows / 1 stored asset restored |
| 2026-10-09 | Follow-up project check | Passed | 287 Vitest + 67 Edge checks; runtime source and deployed bytes unchanged |
| 2026-10-09 | Evening heartbeat prompt change | Approval-blocked | Original ACTIVE daily heartbeat preserved. Exact new prompt ready locally; tool requires approval while active policy is never |
| 2026-10-09 | Production full state archive | Complete | 1159 pairs; 1157 fresh captured / 2 N/A, 2038 matrix PNGs, 16 native OS surfaces; manifest3a5605f9a9d7c5591d15555dc1bcfda013b6d00b3d0eaf6f2c6bafebba32b367 |
| 2026-10-09 | Actual public browser supplement | Passed | 21 completed-read first screens at320/390/1280; actualsource0150, no business submissions, sampling times separately preserved |

## Handoff Notes
- Backend, publication/backup and UI baseline subtasks operate in the same checkout with separate file ownership.
- Do not edit UI until baseline verification explicitly succeeds.
