# Wave 3 My reviews dashboard

Implements `reviews-coaching-expansion-2` and its `mine-dashboard` audit from `plan/final-plan.json`. Started from main `72b345d0`; integrated shipped coaching/admin main `93996497` and guides main `3d965f36`. Both integration conflicts were confined to CHANGELOG, where every entry was retained.

Latest continuation integrates current main `96a55ecdd9f007e9d37c0c3bf6c89c837515934f`, including shipped builds and desktop Dashboard work. The only conflict was CHANGELOG; the My reviews and all newer owner entries were retained. Help regeneration keeps all 74 articles and produces no content change.

## Behavior

- `GET /v1/me/reviews` preserves the asked/answered response while bounding each initial list to 20 and adding separate cursors and status counts. Section requests page 1–50 items. Requests sort by creation time and id; written reviews support newest and most upvoted, with timestamp/id tie breakers. Invalid or mismatched section/tab/sort cursors cannot change the owner or requested view.
- Counts and request filters use actual status: Needs is open with reviews, Waiting is open without reviews, Answered requires the chosen-best status, Closed is closed, and All excludes removed requests. Own hidden requests remain in their status. Helpful marks alone do not move a request to Answered.
- A small `reviewMine` module reuses the existing board cursor and public card/snippet shaping helpers. Authored-comment paging advances through raw bounded rows before checking parent visibility, so a hidden parent cannot leak through an authored review. A private empty page can still have a cursor; the UI explains how to continue.
- Status tabs show counts, default to Needs when positive or All otherwise, and preserve a linked `?tab=` plus unrelated query/hash context. Separate account-scoped SWR Infinite keys isolate section, filter, sort and cursor. Paging appends and deduplicates; tab/sort/account changes clear the previous view. Failed later pages or summary refreshes retain the displayed reviews and offer Retry.
- Your reviewer profile sits above Blocked reviewers. It shows the existing name, regional league badges, karma/review/helpful/best/upvote totals, earned badges and synced-game progress. The API adds an explicit missing-verification reason; the card links to the desktop app below the commenting requirement. The shared optimistic preference hook now lives in its own module; both Toggle controls save the PATCH response and roll back on failure.
- The board's weekly leaderboard replaces its duplicate checkboxes with the karma summary and direct reviewer-profile link. That anchor scrolls and focuses the profile card. The My reviews header has Review board, the existing in-place game picker and Help.
- The replay-reviews article adds `#your-reviewer-profile` and `#my-reviews`, retains all previous anchors and karma/badge rules, and explains status meaning, paging, verification, eligibility and the settings' new location. The help index was regenerated.

## Verification

- On the latest integrated source, full web/API TypeScript and changed-source lint passed. The existing API modules retain the same six function-length warnings. Review/help consumer tests passed **218 assertions across 30 files**, and the six real local MongoDB suites passed **49 assertions**. An initial sandbox Jest transform-cache rename failed before fixtures; the no-cache local Mongo rerun passed in full.

- 200 review/help Vitest assertions across 26 files passed before the final guide integration. The affected dashboard/recovery/help subset passed again after integration: 109 assertions across 14 files. Pagination tests use real SWR Infinite with isolated caches, not a stubbed paging hook.
- 49 real MongoDB assertions across six API suites passed: dashboard, moderation, privacy/grants, karma, reputation and regional leagues. The 17 dashboard cases passed again after adding the cross-sort cursor boundary. They cover all tabs/counts, bounded default/edge limits, equal-date and vote ties without duplicate/missing ids, owner isolation, removed/reply exclusion, private empty pages and authenticated-only access.
- An actual execution plan selects the new compound top-sort index using IXSCAN, without a blocking SORT in its winning plan and with at most five documents examined for a five-row query.
- Full API and web TypeScript passed. Strict ESLint passes for every changed web source/test and all new API code/tests. The three existing API modules retain exactly their existing six function-length warnings (2 connect, 1 routes, 3 service); baseline comparison found no added warnings and no errors.
- Nine Chromium scenarios at 360, 768 and 1280 pixels passed using actual production components, API hooks, SWR, CSS and fonts with explicit synthetic auth and intercepted local API data. They cover tab keyboard/URL changes, later-page failure/retry, server-sorted written paging, stat/badge/progress rendering, real preference PATCH rollback/save, profile focus, no horizontal overflow and zero page errors. A refresh-failure case opens/closes the real lazy Help drawer and retries while both existing lists remain visible. Only that separately browser-tested drawer is isolated in the dashboard unit harness to avoid a lazy-import/RTL interaction.
- Inspected screenshots: `screenshots/my-reviews-tabs-360.png`, `screenshots/my-reviewer-profile-360.png`, `screenshots/my-reviewer-profile-1280.png`.
- Production build uses the exact CI environment, including Reviews/Guides on, Instant Import all and required browser engine. The latest integrated build and every unchanged budget pass: landing **213.5/215**, app **235.2/240**, game **313.4/440**, opponent **493.2/500**, and guide **167.8/175 kB**. Final integrated build results are recorded in the PR.

## Deployment and limits

The usual API index setup adds `{authorId:1, upvotes:-1, createdAt:-1, _id:-1}`. Existing request-user/creation and comment-author/creation indexes remain. No data backfill or schema migration is required. Deploy the additive API fields/section endpoints before the new dashboard UI. Existing no-section consumers retain their shape and receive the intended bounded first page.

No AI features, AI API calls, production data changes, shared focus/filter/chrome edits or review-notification producer changes. Auth-return-to-context remains the separate later wave; the existing scoped My reviews sign-in behavior is preserved.
