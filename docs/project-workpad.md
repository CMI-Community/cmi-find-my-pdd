# PDD404 Project Workpad

Last updated: 2026-10-09 Asia/Bangkok

## Snapshot
- Status: Hourly insights implementation in progress; existing runtime retained until acceptance
- Current focus: Implement the approved compact single-page six counters, hourly table/charts and timestamped neutral observation feed.
- Next step: Freeze and validate the hourly candidate, then release the data page and sampling. The user will provide a usable API key later after the existing-key probe returned429; the AI task stays disabled until then.

## Project Goal
Provide readable, continuously updated public data at `/insights` and usable sharing materials at `/share`, while preserving parcel lookup, privacy and the distinction between clues, matches and actual returns.

## Scope
- Existing six lifetime homepage statistics, new same-definition hourly snapshots, colored hourly charts/table and short timestamped observations retained in a folded feed; shared media directory remains available.
- Independent developer-group configuration, navigation, anchored help links, copy/download interactions and honest missing-content states.
- Append-only publication versions and administrator audit, public allowlisted read APIs, immutable public assets, backup and restore coverage.
- Hourly statistics collected independently with pg_cron, with visible-page data refresh. Hourly short observations use the approved deterministic fact-selection policy; manual directory/group publication keeps its administrator approval process.
- No invented historical data, news, video, QR codes, personal success rates, or changes to existing five-minute monitoring.

## Key Decisions
| Date | Decision | Reason | Status |
| --- | --- | --- | --- |
| 2026-10-08 | React/Edge pages on pdd404.app; automatic data and reviewed editorial content | User-approved implementation plan | Confirmed |
| 2026-10-08 | Preserve homepage lifetime metric contract; start history at first genuine snapshot | Earlier local report counts use a different definition | Confirmed |
| 2026-10-08 | Developer group is independent of the current parcel-finding group | User confirmed separate group; QR asset remains pending | Confirmed |
| 2026-10-08 | Third-party summary cards link to originals | Avoid unreviewed embeds and copied media | Confirmed |
| 2026-10-09 | One-page hourly data and short factual observations; 0–3 entries, older entries collapsed and retained | User replaced the explanatory daily-report design and approved execution | Confirmed |
| 2026-10-09 | Actual developer QR supplied; conservative display cutoff before October16 | User-provided group image and explicit execution authorization | Confirmed |
| 2026-10-09 | Isolated managed worktree on codex/hourly-insights | Preserve parallel task checkout and all accepted WeChat changes | Active |

## Task Board
### Now
- [x] Verify and seal current production7457d63 baseline: 513 cases / 1183 pairs, 1181 captured and 2 source-backed not-applicable, no gaps; retained images preserve genuine provenance.
- [x] Implement compact hourly page and public DTOs after baseline; independent UI checks are in progress.
- [ ] Validate new hourly snapshot and telemetry migration with real PostgreSQL transactions, concurrency and restore.
- [x] User explicitly chose reuse of the existing API key for the PDD404 server hourly task.
- [x] Implement the hourly model task with atomic independent call reservations, strict selection and failure handling.
- [ ] Enable actual AI generation after the user provides a usable key later; the one existing-key synthetic probe returned429 and was not retried.
- [ ] Upload and publish the supplied real QR using existing administrator authorization; no plaintext credentials in chat.
### Next
- [x] Implement both pages, responsive navigation and help anchors after baseline.
- [x] Complete candidate state matrix, database transactional/restore tests, check and build.
- [x] Seal production UI acceptance; PR #47 and database/API/frontend deployment are complete with real identity checks.
- [x] Update and read back the existing ACTIVE evening automation with the new draft/review workflow; schedule, name and target preserved after approval policy restoration.
### Done
- [x] User approved detailed implementation plan.
- [x] Created `codex/insights-outreach`; initial working tree was clean.
- [x] Verified baseline-time Vercel frontend `fbb6e99c688d723117236a63c12cd83bb24ed597`; subsequent release uses 0150ff9.

## Risks And Open Questions
| Type | Item | Impact | Next check | Status |
| --- | --- | --- | --- | --- |
| Asset | Real independent developer-group QR supplied | Upload/publication needs existing administrator authentication | Use verified pixel-identical metadata-free copy; show actual expiry | Prepared, not published |
| Credential | Existing key returned429; user chose to change key later | AI stays disabled; data sampling and the page can release independently | Configure and accept one real task when a usable key is supplied | Explicitly deferred by user |
| Content | No verified first news/video release links | Empty directory sections remain honest | Prepare reviewable directory without invented links | Open |
| Evidence | Current-runtime complete baseline | Required before first UI source edit | Live SHA7457d63, 13 static hashes and frozen accepted matrix matched | Validated |
| Release | Hourly candidate archive and production acceptance | Required before rollout | Expand state matrix; previous release evidence does not establish the new runtime | Pending |

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
| 2026-10-08–09 | Initial evening heartbeat prompt attempt | Rejected, then resolved | Initial tool policy was never; after the environment changed to auto_review, the same authorized update succeeded and saved content was read back |
| 2026-10-09 | Production full state archive | Complete | 1159 pairs; 1157 fresh captured / 2 N/A, 2038 matrix PNGs, 16 native OS surfaces; manifest3a5605f9a9d7c5591d15555dc1bcfda013b6d00b3d0eaf6f2c6bafebba32b367 |
| 2026-10-09 | Actual public browser supplement | Passed | 21 completed-read first screens at320/390/1280; actualsource0150, no business submissions, sampling times separately preserved |

| 2026-10-09 | Integrated main checks after PR48 | Passed | 289 Vitest + 67 Edge, build and actual PG; 28 tables / 298 synthetic rows / 1 asset, earlier294-row evidence preserved. This task did not deploy the separate WeChat change |
| 2026-10-09 | Hourly independent stage checks | Passed | 309 Vitest + 71 Edge; build, actual PG atomic/concurrent migration and 34 tables / 301 synthetic rows scoped restore. Hourly model code awaits credential choice |
| 2026-10-09 | Existing evening heartbeat prompt | Updated and read back | ACTIVE, same20:00 schedule and target; current page and short observations replace separate explanatory reports. Prompt SHA f1a1d9fe882d47e50dac774fa581e98fb78636e6a624baa70636a210cefa93b1 |

## Handoff Notes
- Backend, publication/backup and UI baseline subtasks operate in the same checkout with separate file ownership.
- Do not edit UI until baseline verification explicitly succeeds.
