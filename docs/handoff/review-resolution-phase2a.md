# Phase 2a review resolution

Repair follows PR #647, which was already merged when this continuation began. The original review remains intact. Entries below follow its exact order, including duplicate reports. No AI features or AI API calls were added.

## 1. [CONFIRMED, low] Report form chunk load failure in AppChrome or error.tsx takes down the whole app via global-error

Fixed: report chunk boundary and accessible email fallback; failure regression.

## 2. [CONFIRMED, low] More sheet 'Stream Studio' entry leaves the sheet open when already on /settings

Fixed: every More-sheet destination closes the sheet, including query-only navigation.

## 3. [CONFIRMED, low] 'Send another' leaves focus on the same button node, which now reads 'Cancel'

Fixed: distinct footer keys and Subject focus after Send another.

## 4. [CONFIRMED, low] Help copy sends players to a ? button and avatar item that are missing where they read it

Fixed: help copy identifies app/phone controls and article-page report action.

## 5. [UNVERIFIED, medium] The site-stats poll hides the Reconnecting banner while the API is still down, which also stops its ping and recovery

Fixed: same-origin cached stats responses cannot clear API outage state.

## 6. [UNVERIFIED, medium] A kept empty answer says 'Nothing matches' under the new filters while they are still loading, and the clicked action disappears

Fixed: previous empty arrays do not satisfy hasQueryData or render empty filter conclusions.

## 7. [UNVERIFIED, medium] Making keepPreviousData global leaks the previous answer into views that were not migrated, and it stays after a failed request

Fixed: useApi suppresses previous-key data after current-key failure, including legacy consumers.

## 8. [UNVERIFIED, low] Retry on the Opponents list unmounts its own button, so keyboard focus drops to the page body

Fixed: pagination retries preserve their error and recovery panel while loading.

## 9. [UNVERIFIED, low] The dossier labels every 500 as 'busy, try again', hiding real server failures

Fixed: genuine server errors retain standard server-failure copy; busy overrides only explicit busy errors.

## 10. [UNVERIFIED, low] The help article promises the site never shows 'no data' for a failed request, but the Today dashboard still does

Copy corrected: no absolute no-data guarantee. Today KPI error-state improvements are in the supplied phase 2b home patch.

## 11. [UNVERIFIED, medium] Filter bar statically imports HelpLink, so the full help-article registry ships in the first-load JS of every /app route

Already fixed at original PR head: FilterBar uses LazyHelpLink; import guard covers regressions.

## 12. [UNVERIFIED, medium] Win rate card says it only 'ignores the date filter' but also ignores the new Matchup picker, regions and Strategies picks

Fixed: Win-rate scope note names date, matchup, region and Strategies exclusions.

## 13. [UNVERIFIED, low] Chip row, filter sheet and help article claim filters apply to every section, but Arcade, Daily Pulse and Ladder Pulse ignore all filters

Fixed: Arcade hides global filters; sheet/article explain Daily Pulse and Ladder Pulse scope.

## 14. [UNVERIFIED, low] Shared FILTER_LABELS rename makes the build explorer's scope note read 'Too-short games: true' when short games are hidden

Fixed: explorer formats too-short values as Hidden or Shown.

## 15. [UNVERIFIED, low] Matchup picker runs an unbounded all-history aggregation on every analyzer page load just to decide whether to show 'My race'

Fixed: unfiltered randomSummary uses bounded 60-second coalesced cache; filtered calls remain fresh.

## 16. [UNVERIFIED, medium] Bundle budget CI step will fail on /app and /app/opponents at e90d48ae: every /app route now ships the whole help library on first load, and the failure also skips the Playwright smoke

Resolved: original final CI only exceeded /builds; conditional editors/charts bring all routes under unchanged budgets.

## 17. [UNVERIFIED, low] Safe-area top padding makes the app header taller in the installed iOS app, so the pinned review replay (sticky top-[50px]) slides under it

Fixed: review pin accounts for the installed-app safe area.

## 18. [UNVERIFIED, low] The manifest's "Today" shortcut and start_url can land on another section: TodayView redirects to the user's Default tab on a cold start

Fixed: explicit Today shortcut uses ?view=today; ordinary launch retains preferred tab.

## 19. [UNVERIFIED, low] Choosing "Later" on the update prompt removes the focused button and drops keyboard focus to <body>

Fixed: Later restores previous focus or focuses main content.

## 20. [UNVERIFIED, medium] Analytics 'Turn off' in Settings -> Misc leaves gtag.js running, so events keep going to Google for the rest of the visit

Fixed: analytics denial sets GA disable flag, consent-gates events and follows cross-tab changes.

## 21. [UNVERIFIED, low] Section highlighter fires on any hashchange, so 'Skip to content' outlines and scrolls the whole <main> on Settings

Fixed: Settings only highlights anchors within the active tab panel.

## 22. [CONFIRMED, medium] Dossier 'Public profile' check runs a full scan of every user's opponents rows on each new opponent opened

Fixed: covered pulseId-leading opponent index; real Mongo explain regression with 4,000 rows.

## 23. [CONFIRMED, low] Community opponent outage goes to error.tsx, whose 'Try again' cannot refetch a server-component error

Fixed: unavailable opponent profile renders recoverable CommunityUnavailable with full reload.

## 24. [CONFIRMED, low] 'Which pages are public?' says shared replays are open to everyone, but each shared replay requires sign-in

Fixed: public archive lists distinguished from sign-in-required individual replay analysis.

## 25. [CONFIRMED, low] /builds and /builds/<slug> now render nothing until Clerk loads, and the e2e walk passes on a blank page

Fixed: unresolved auth renders visible public intro/sign-in content; e2e now requires headings.

## 26. [CONFIRMED, medium] Save to my library fails with a false 'already have a build with this name' when the title is long, including after the user deletes their copy

Fixed: long-title slug reserves timestamp/random suffix; same-millisecond copies regression.

## 27. [CONFIRMED, medium] Build stats card swaps its error panel for a skeleton on every retry, so keyboard focus is lost and the alert repeats

Fixed: build dossier retains error panel before loading state and preserves Retry focus.

## 28. [CONFIRMED, low] Help article promises 'you never end up with duplicates', but copies saved before this release are never recognised

Fixed: help explicitly limits recognition to copies saved with provenance.

## 29. [CONFIRMED, low] The 'In your library' lookup trusts the server filter blindly, so an API without forkedFrom returns an unrelated build

Fixed: API summaries expose provenance and client validates matching communitySlug.

## 30. [UNVERIFIED, low] /definitions can serve a page with no Guide links for up to 6 hours after one failed sitemap fetch

Fixed: definitions route is dynamic while successful sitemap reads remain cached, so one outage cannot cache missing links for six hours.

## 31. [UNVERIFIED, medium] Scouting card's new 'Games usually end' line names the streamer's own army, but the card and copy present it as the opponent's

Fixed: end-game composition explicitly says Your army; API and type documentation match.

## 32. [UNVERIFIED, medium] Favourite opening / cheese alert are computed for a name-only (Tier C) match, contradicting the 'Battle.net account, not just the name' guarantee

Fixed: name-only Tier C rows cannot supply another account's opening/cheese identity or legacy fallback.

## 33. [UNVERIFIED, medium] Restore runbook tells admins to re-run history wipes with wipeGames(userId, {}), which deletes the user's whole history when the original wipe was a date range

Fixed: runbook requires original scope/range; shared service audits every wipe caller. Existing user logs already had counts.range.

## 34. [UNVERIFIED, low] Backup freshness bands and admin copy assume one Atlas snapshot a day; the M10 default schedule is every 6 hours

Fixed: backup freshness derives from shortest reported snapshot interval, with fallback for unreadable policy.

## 35. [UNVERIFIED, low] An expired or rotated Atlas service-account secret is reported as a missing Project Read Only role

Fixed: OAuth/401 credential failures have a distinct code and secret-rotation guidance.

## 36. [UNVERIFIED, medium] Help says a failed request never shows a 'no data' message, but the Today KPI cards do exactly that

Copy corrected; duplicate of finding 10. Behavioral KPI work remains part of phase 2b, not claimed shipped here.

## 37. [UNVERIFIED, medium] Articles and CHANGELOG send users to a '?' button in the top bar; the button shows a life-buoy icon

Fixed: help and changelog identify life-buoy Help & support controls and phone More.

## 38. [UNVERIFIED, low] 'Something went wrong' says the server sleeps when idle; the API runs on a Render Starter plan, which does not sleep

Fixed: help, design and error copy describe dropped connections/restarts rather than idle sleeping.

## 39. [UNVERIFIED, low] Install article gives the wrong cutoff for old installs ('before October 2026')

Fixed: install advice refers to this update rather than a month boundary.

## 40. [UNVERIFIED, low] Scouting article says a check-in correction changes every widget, but Best answer ignores corrections

Rejected by real writer regression: check-in correction writers already update myBuild and opponent.strategy atomically; best-answer uses corrected labels.

## 41. [UNVERIFIED, low] 'Which pages are public?' is called the full list but leaves out the public Reviews board

Fixed: public list includes Reviews and conditionally available Guides/Analyze replays; replay auth is precise.

## 42. [UNVERIFIED, medium] Item 4's static HelpLink in the analyzer filter bar puts every help article into the first load of all /app routes

Already fixed at original PR head; duplicate of finding 11, guarded by helpLinkImports test.

## 43. [UNVERIFIED, low] Phone ? menu overlaps the top bar in the installed iOS app now that the header pads for the notch

Fixed: phone Help menu accounts for safe-area inset.

## 44. [UNVERIFIED, low] Merged NoFilterMatches offers a 'Reset filters' that can only hide games when Too-short games is shown

Fixed: NoFilterMatches omits exclude_too_short, which widens results.

## Validation

Focused regressions cover report import failure/focus, build slugs/provenance/auth/retry, reconnect recovery, stale data, actual Mongo query plans, wipe bounds, backup cadence/authentication, analytics denial and scouting identity/corrections. The first production build passes every unchanged bundle budget; /builds is 182.8 kB against 270 kB (original failure: 362.9 kB). Final full-suite and CI results are recorded in the repair PR.
