# Replay library controls

Branch: `codex/wave3-replay-library-control` in the preserved `wave4-agent-dashboard` worktree. Integrated main through strength PR713 and the frozen dossier B source `ccf60cba34de805e829e7d5c7351442016695494` before the production build. No production queries, deletions, account changes, schema migrations, new indexes or infrastructure were executed.

## Contract and recovery

- Authenticated `PATCH /v1/games/:gameId` accepts only `excluded` and a fixed hide reason; `DELETE` accepts only `{confirmation:"DELETE GAME"}`. Both use the existing exclusive owner mutation fence and drain that game's classifier writers. The middleware exemption is limited to these exact methods and path depth.
- Hiding preserves owner playback and analysis, excludes only that uploader's contribution, updates the affected opponent counter, and reversibly fences guide samples. Another uploader's copy remains eligible. Cached public reference tables retain their existing recompute schedule. Public guide examples contain no per-game identifier, so the conservative owner example scrub is disclosed in Help until the next scheduled update.
- Pending deletion records retain original metadata only until initial cleanup finishes, plus three booleans identifying required storage backends. Final suppression markers use the existing unique owner/game row and contain no original metadata or detail. Post-cleanup failures retain only these booleans for retry; success clears them.
- Raw replay cleanup uses the single-game delete method in both passes; unrelated pending uploads remain intact. Storage failures propagate. Missing required backends return503 on individual retries and full account erasure; another game's pending marker cannot block a correctly scoped single-game deletion.
- Ingest, queued detail writes, playback uploads, build-intent writes and private/public ownership checks cannot revive a pending or deleted replay. Ordinary history wipes preserve suppression markers; older snapshots prune suppressed games and recount only affected opponents. Full account exports include markers and full erasure removes them after cleanup succeeds. Active review grants close while existing discussion text stays.

## Bounded access

| Surface | Bound |
| --- | --- |
| Hidden games | One owner/game-indexed metadata page,25 control records plus one sentinel,5s query deadline; completed tombstones never appear as replays. |
| Account catalog | Owner-only slim metadata aggregate, at most20 handles,5s deadline; one projected profile read, no Pulse/detail calls. |
| Account cohort | At most20 literal SC2 toon handles, strict shared validation and1,300-character wire bound; invalid cohorts fail closed. |
| Hide/delete | At most25 browser-selected games, processed serially; one affected opponent recount per game, generation-fenced cache invalidation, no live public corpus recompute. |
| Cleanup recovery check | One projected first-match read through the existing owner/game index,5s deadline, retaining the caller's full owner/game scope. |
| Replay CSV | Private metadata cursor, batch100, at most50,000 rows plus one bounded truncation sentinel; streamed with backpressure and abort/close cleanup, one export/minute/user. |

The export serializer and21-column Help dictionary share `replayExportColumns.json`. CSV carries a UTF-8 BOM, RFC4180 quoting and formula-safe string cells, plus replay-time MMR, matchup, region, effective build and canonical game URL. `X-Export-Truncated` and attachment headers are exposed to the authenticated browser.

## Browser behavior

The real React fixture mounts AnalyzerProvider, FilterBar, ActiveFilterChips, ReplayLibrary, HiddenGames and GameDetailShell with GameDataMenu, production CSS, and explicit local auth/API boundaries. Remote network is blocked. Owner, auth-loading and filter changes cancel pending token/body callbacks. Bulk controls capture the exact reviewed selection; Cancel receives default focus, exact typing gates deletion, and in-flight confirmation focus remains inside the dialog. The header clips decorative art separately so dropdown buttons remain visible and pointer-accessible.

## Validation

Final source gates and CI status are recorded in the pull request. Disposable MongoDB and fake object stores cover independent uploader isolation, suppression across ingest/restore, real writer-lease waiting, target-only pending object cleanup, pre/post cleanup recovery, full-erasure backend loss, late detail writes, private lists and50,001-row CSV truncation. No real account mutation or external provider traffic is part of this evidence.
