# Guide video library — guides-expansion-4

Branch: `codex/wave4-guide-videos`. Original replay branch and untracked `.cache/` preserved.

## Contract and bounds

- Public videos gain detected `matchup` and nullable `buildSlug`. A link requires exactly one catalog build and a current-era published guide clearing the same serve-time page floor. Ambiguous, unknown, unpublished and under-floor targets remain null. No admin fields leak.
- Existing 500-row, five-minute video metadata cache is retained. Publication is checked in one indexed batch (maximum 500 keys, 5-second query bound), shared by concurrent selectors but never retained with cached video metadata. Optional publication failure retains videos without guide links.
- The client island has nonzero matchup chips, Other for unclassified videos, folded title search, 24-card paging, focus on the first newly revealed card and polite result announcements. Old API payloads without matchup fields retain search/paging and hide chips.
- Dynamic server rendering applies the initial matchup filter. The full payload remains available for changing filters and complete valid, dated VideoObject structured data. The existing separate collapsed 8-worker archive is preserved.
- Guide links are separate same-tab anchors with bounded canonical path segments. Watch links retain existing validated YouTube URLs and new-tab behavior. View all videos remains same-tab.

## Verification

- API: 199 guide video/matching tests pass, including cache-warm unpublishing, page-floor/era checks, ambiguous matches, bounded single-flight publication lookup and failure fallback.
- Web: 348 guide page, shared guide and Help consumers pass, including server-rendered shared URL, complete JSON-LD, chips/counts, diacritic-insensitive search, paging/focus, legacy fields and safe separate guide links. An additional malformed-watch-URL focus regression covers omitted cards.
- API: a further 113 route/payload/floor/feed tests pass (312 total). API/web typechecks and scoped lint pass.
- Fresh main `b3825e6d` integrated cleanly. Required-engine production build passes every unchanged budget: landing 214.5/215 kB, Today 228.3/240, game 316.9/440, dossier 475.9/500 and guide build 168.9/175. Video library first load is 161 kB.
- 48 browser assertions pass at 375/1440px, light/dark, with actual consumers, production CSS and committed fonts. Matchup controls meet 44px touch targets; no horizontal overflow or browser errors. Nonlocal traffic is blocked; thumbnails are local synthetic SVG responses. Four captures: `docs/handoff/screenshots/guide-videos-{theme}-{width}.png`.

No production job, migration, provider/account operation, infrastructure, version or budget change. Revert the scoped PR to roll back; the additive fields are optional for older web/API deployments.
