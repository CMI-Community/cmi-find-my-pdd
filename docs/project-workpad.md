# PDD404 Project Workpad

Last updated: 2026-10-08 Asia/Bangkok

## Snapshot
- Status: In Progress
- Current focus: Implement approved data insights and outreach pages, daily snapshots and reviewed publication.
- Next step: Freeze the checked candidate SHA, archive the complete candidate state matrix, then complete PR and production acceptance.

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
- [ ] Complete new state matrix, database transactional/restore tests, check and build.
- [ ] Review PR and complete authorized release/acceptance sequence with genuine evidence.
- [ ] Update existing evening automation to the new draft/review workflow.
### Done
- [x] User approved detailed implementation plan.
- [x] Created `codex/insights-outreach`; initial working tree was clean.
- [x] Verified Vercel production currently uses frontend `fbb6e99c688d723117236a63c12cd83bb24ed597`.

## Risks And Open Questions
| Type | Item | Impact | Next check | Status |
| --- | --- | --- | --- | --- |
| Asset | Real independent developer-group QR file/location not supplied | Group panel must show missing state | Await user location; content can update independently | Open |
| Content | No verified first news/video release links | Empty directory sections remain honest | Prepare reviewable directory without invented links | Open |
| Evidence | Current-runtime complete baseline | Required before first UI source edit | Live SHA, 12 static hashes and original matrix matched; 24 fresh captures added | Validated |
| Release | Complete candidate archive and production acceptance | Blocks runtime rollout until passed | 500 cases / 1149 pairs planned, including new public-page states | In Progress |

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

## Handoff Notes
- Backend, publication/backup and UI baseline subtasks operate in the same checkout with separate file ownership.
- Do not edit UI until baseline verification explicitly succeeds.
