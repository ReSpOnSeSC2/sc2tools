# Wave 1 phase 2a review findings (unfixed)

Reviewed range 9942f97c..e90d48ae. "CONFIRMED" = an adversarial verifier reproduced it; "UNVERIFIED" = the verifier was cut off by the usage limit, so check it before fixing. Two were rejected by verifiers and are omitted (gdpr payload.context; definitions JSON CI staleness).

## [CONFIRMED, low] Report form chunk load failure in AppChrome or error.tsx takes down the whole app via global-error
`apps/web/components/chrome/AppChrome.tsx:377`

**Scenario:** LazyReportIssueModal uses next/dynamic (React.lazy), so a failed chunk import throws during render. AppChrome is mounted from AppShell in the root layout, so the only boundary above it is app/global-error.tsx. The same happens in app/error.tsx through ReportErrorAction, because an error thrown inside the root error boundary's own fallback goes up to global-error. Concrete case: a tab opened before a deploy, on Vercel with no skew protection, where the ReportIssueModal chunk hash changed. The player clicks ? > Report a problem (or the avatar menu item, or 'Report this problem' on an error screen). The old chunk 404s, ChunkLoadError is thrown, and the whole document is replaced by 'SC2 Tools hit a critical error'. A flaky connection does the same. This is the path people use when something is already wrong. SectionBoundary avoids it only because it wraps the same component in OmitOnError.

**Fix:** Wrap LazyReportIssueModal in a small error boundary (like OmitOnError) inside LazyReportIssueModal.tsx. On a load failure it should render nothing, or a mailto fallback via supportMailto, and never rethrow. Optionally retry the import once.

## [CONFIRMED, low] More sheet 'Stream Studio' entry leaves the sheet open when already on /settings
`apps/web/components/chrome/AppChrome.tsx:154`

**Scenario:** The new Stream Studio shortcut (/settings?tab=overlay) is a utility entry, so it appears in the phone More sheet under 'Your setup'. The sheet only closes on a pathname change (useEffect on [pathname]), and SheetLink has no onClick close. At 390px on /settings?tab=profile, the player opens More and taps Stream Studio. Only the search string changes, so the sheet stays open over ~80% of the screen with body scroll locked. SettingsShell switches to the Overlay tab behind it, or opens the discard-changes dialog behind the sheet if the form is dirty. The player has to dismiss the sheet by hand to see the result.

**Fix:** Close the sheet when any SheetLink or SheetHelpItem link is clicked (pass onClose and call it in onClick), or key the close effect on pathname plus useSearchParams.

## [CONFIRMED, low] 'Send another' leaves focus on the same button node, which now reads 'Cancel'
`apps/web/components/feedback/ReportIssueModal.tsx:234`

**Scenario:** Both footer states are fragments with two <Button>s in the same positions and no keys, so React reuses the DOM nodes. sendAnother() resets the form but never moves focus. A temporary test (focus.reviewtmp, since deleted) confirmed it: after clicking 'Send another', document.activeElement is the same node, now labelled 'Cancel'. A keyboard or screen-reader user hears nothing about the reset and is left on Cancel. A second Enter or Space closes the form they just cleared, and they have to tab backwards to reach Subject.

**Fix:** In sendAnother, focus subjectRef after the idle form renders (an effect on status === 'idle' after a send, or setTimeout(() => subjectRef.current?.focus())). Also give the two footer variants distinct keys so the nodes are not reused.

## [CONFIRMED, low] Help copy sends players to a ? button and avatar item that are missing where they read it
`apps/web/lib/help/articles/troubleshooting/troubleshooting-and-support.ts:34`

**Scenario:** troubleshooting-and-support now says 'Press the ? button in the top bar and choose Report a problem'. report-a-problem.ts:34-36 says the same and adds 'Your avatar menu has Report a problem too'. For signed-in players, AppChrome renders the ? button with 'hidden md:block', so at 390px there is no ? in the top bar. The /help/<slug> pages, where these articles are read, use the marketing Header: it has no ? button at any width, and its UserButton has no 'Report a problem' item. So a signed-in player reading /help/troubleshooting-and-support on a phone, or /help/report-a-problem on desktop, is told about controls that do not exist on that page.

**Fix:** Qualify the copy: 'Inside the app, press ? in the top bar (on a phone: More > Help & support)', and either say the avatar item is only inside the app or add the same UserButton.MenuItems to Header.tsx. Point readers on help pages to the 'Report a problem' button at the end of the article.

## [UNVERIFIED, medium] The site-stats poll hides the Reconnecting banner while the API is still down, which also stops its ping and recovery
`apps/web/components/chrome/ConnectionStatus.tsx:101`

**Scenario:** The SWR middleware watches every SWR hook under AppChrome. That includes SiteStats (AppChrome.tsx:294, useSWR('/api/site/stats'), which refreshes every 30 s). When the Render API is down, the Next route /api/site/stats returns 503 and fetchSiteStats throws a plain Error('Site statistics are temporarily unavailable'). toClientApiError gives that error status -1, so it counts as kind 'other' and isConnectivityError returns false. report() then treats it as 'the server answered', sets failures to 0 and calls setUnreachable(false). The steps: useApi requests fail with TypeError three times, so the banner appears and /v1/ping starts every 10 s. Within 30 s the SiteStats tick fails with that plain Error, and the banner disappears while the API is still unreachable. Because reconnecting is now false, the ping effect stops, so the 'first answer retries every failed request' recovery never runs. Failed sections fall back to SWR's exponential error backoff, which can stretch to minutes. That contradicts the help article ('the page checks every 10 seconds; as soon as the server answers ... the sections that failed load again'). I reproduced it in a throwaway vitest: 3 TypeError failures show the banner, then one useSWR rejecting with that Error hides it.

**Fix:** Only API answers should end the streak. Have useApi's fetcher call report(), instead of a global middleware on every SWR hook. Alternatively, in report() ignore errors that carry no HTTP status (toClientApiError(e).status < 0) rather than treating them as reachability. At minimum, exclude the /api/site/stats hook from the middleware.

## [UNVERIFIED, medium] A kept empty answer says 'Nothing matches' under the new filters while they are still loading, and the clicked action disappears
`apps/web/components/ui/QueryState.tsx:99`

**Scenario:** hasQueryData returns true for previous data that has no error, and QueryState then applies isEmpty and empty to that previous answer. On Battlefield with the default 12-worker preset and no games, the card shows 'No matchups match these filters' with a 'Widen to All time' button. The user clicks Widen. The filters change to All time and the new /v1/matchups request is still pending. QueryState keeps rendering the previous [] answer through NoFilterMatches, which reads the current filters. The card now states 'No matchups match these filters · Applied now: Dates: All time', the Widen button is gone, and keyboard focus has dropped to <body>, all while the request runs. That lasts seconds on a busy single instance, about 30 s on a cold start, and indefinitely if the request hangs. I reproduced it with a throwaway test that renders BattlefieldTab with real useApi and keepPreviousData, leaving the second fetch pending. The same applies to StrategiesTab ByOppStrategyView and BuildVsStrategyView, which compute their empty rows from previous data. No view reads isPreviousData, so nothing dims the stale content or marks it aria-busy.

**Fix:** In QueryState, when q.isPreviousData is true, do not evaluate isEmpty/empty: show the skeleton, or the previous children dimmed inside an aria-busy region. Apply the same rule in the hasQueryData early-return views before they compute empty rows. After Widen, Reset or Lower Min games, move focus to the card heading.

## [UNVERIFIED, medium] Making keepPreviousData global leaks the previous answer into views that were not migrated, and it stays after a failed request
`apps/web/components/chrome/ConnectionStatus.tsx:129`

**Scenario:** keepPreviousData: true now applies to every useApi hook under AppChrome. Only QueryState/hasQueryData views check isPreviousData together with error. Views that render .data directly now show the previous key's answer under the new label, both while loading and permanently after the new request fails. Example on the Today dashboard (DashboardKpiStrip.tsx:183): with All time, 'Games in range' shows 400. The user switches the global range to Last 7 days and /v1/timeseries returns 500. The card then reads 'Games in range 400 · Unable to load selected range' (confirmed with a throwaway test); before this wave it showed '—'. The Win rate card (wrStats, line 223) never reads its error. After picking another preset in its menu, it shows the old preset's win rate and W–L under the new 'Win rate · Last 30 days' label while loading, and for good if the request fails. MacroSummaryCard (`if (!data ...) return null`) likewise keeps the previous range's macro score after a failed refresh.

**Fix:** Make kept results opt-in for views that handle isPreviousData, rather than setting keepPreviousData in the shell's SWRConfig. Or have usePreviousDataScope return undefined data whenever the current key has an error. Make DashboardKpiStrip and MacroSummaryCard ignore data when error is set.

## [UNVERIFIED, low] Retry on the Opponents list unmounts its own button, so keyboard focus drops to the page body
`apps/web/lib/useApiPaginated.ts:155`

**Scenario:** RetryButton is documented as staying focusable while the retry runs (aria-busy instead of disabled), and it announces 'Still not loading' if the retry fails. For the Opponents list, retry() increments `attempt`, so requestKey changes and the hook returns emptyState (isLoading true, error null) on the next render. OpponentsTab renders `error ? <RequestError/> : ...`, so the panel, and the button that has focus, unmount immediately and the skeleton table appears. A keyboard or screen-reader user who presses Retry loses focus to <body> on every attempt. If the retry fails, a brand-new RequestError mounts with failedAgain=false, so the 'Still not loading' status never fires.

**Fix:** While a retry is in flight, keep the previous error in useApiPaginated (return the last error with isLoading true), or keep the RequestError mounted in OpponentsTab during the retry. Alternatively, move focus to the Opponents heading or region when the panel goes away.

## [UNVERIFIED, low] The dossier labels every 500 as 'busy, try again', hiding real server failures
`apps/web/components/analyzer/OpponentDossierStates.tsx:66`

**Scenario:** A real overload already arrives as 503 with code opponent_profile_busy (services/opponents.js:3726), which requestErrorKind maps to 'busy'. DOSSIER_ERROR_COPY also overrides the 'server' kind with the busy copy. So a persistent 500 internal_error, for example a crash while building one opponent's profile, tells the user 'The dossier is busy, try again in a moment … the server builds a few at a time'. That is false: retrying will not help. It also replaces the generic copy's 'If it keeps happening, report it with the Error ID'.

**Fix:** Drop the `server: DOSSIER_BUSY` override and keep the busy copy for the busy kind only, so 5xx shows the standard 'Something went wrong on our side … report it with the Error ID' text.

## [UNVERIFIED, low] The help article promises the site never shows 'no data' for a failed request, but the Today dashboard still does
`apps/web/lib/help/articles/troubleshooting/something-went-wrong.ts:37`

**Scenario:** The new article says the site 'never shows an empty "no data" message for a request that failed, so if you see one, your filters really did match nothing.' On /app the DashboardKpiStrip still falls back to '0' when a request fails: placeholder = isLoading ? '—' : '0'. A failed /v1/timeseries shows 'Games today 0 · No games yet today' and 'Win rate 0 · No games in this window'. A failed /v1/streak shows 'Active streak 0 · Tied or no recent games'. During an outage the help page tells the user to conclude they have no games today, which is false.

**Fix:** Make the KPI strip show '—' or an error hint when its requests fail, or soften the article to say that sections show Retry rather than claiming an empty message always means no matches.

## [UNVERIFIED, medium] Filter bar statically imports HelpLink, so the full help-article registry ships in the first-load JS of every /app route
`apps/web/components/analyzer/FilterBar.tsx:5`

**Scenario:** Before this wave, nothing in the /app shell imported HelpLink or @/lib/help. FilterBar.tsx:5 and FilterSheet.tsx:5 now import HelpLink statically. HelpLink calls getArticle from @/lib/help, and articles/index.generated.ts statically imports every article body. FilterBar is imported by AnalyzerFrame, which app/app/layout.tsx mounts, so the article text and HelpArticleBody land in the layout chunk of /app, /app/[section], /app/opponents, /app/opponents/[pulseId] and /app/game/[gameId]. The game route does not even render the bar. At e90d48ae the article sources are about 77 KB raw and about 22 KB gzipped. That is roughly 12% of the 180 kB budget for /app/opponents in perf-budget.json, and it grows with each article; the help-content-backfill item in progress adds about 27 more. The same integration (19a5b9cb) switched Settings to LazyHelpLink for exactly this reason, and LazyHelpLink's doc comment warns against this pattern, but the filter bar was missed.

**Fix:** Load the filter bar's '?' icon and the sheet's 'How filters work' link lazily. Either give LazyHelpLink an icon variant, or load HelpLink with next/dynamic (ssr:false) and fall back to a plain <a href="/help/analyzer-filters">. That keeps @/lib/help out of the /app layout chunk.

## [UNVERIFIED, medium] Win rate card says it only 'ignores the date filter' but also ignores the new Matchup picker, regions and Strategies picks
`apps/web/components/analyzer/DashboardKpiStrip.tsx:269`

**Scenario:** A player picks 'vs Z' in the new global Matchup picker. The chip row on Today shows 'Opponent race: Zerg'. The Win rate card's wrQuery (lines ~95-115) sends only its own preset dates plus exclude_too_short, map_pool, game_size and the length bounds; opp_race, race, regions, build and opp_strategy are never sent. The card therefore shows the all-matchup win rate (say 54%) under 'Own timeframe · ignores the date filter'. That wording implies every other active filter, including the matchup chip right above it, does apply, so the player reads 54% as their win rate vs Zerg. Picking a region or a Strategies build misleads the same way. Only the help article mentions that the card ignores matchup and region.

**Fix:** Make the card's copy complete, e.g. 'Own timeframe · ignores date, matchup, region and Strategies filters'. Or pass race, opp_race, regions, build and opp_strategy into wrQuery so the card ignores only the date, as its note now claims.

## [UNVERIFIED, low] Chip row, filter sheet and help article claim filters apply to every section, but Arcade, Daily Pulse and Ladder Pulse ignore all filters
`apps/web/components/dashboard/AnalyzerFrame.tsx:137`

**Scenario:** AnalyzerFrame renders ActiveFilterChips on every route except /app/game, including /app/arcade. Arcade's data comes from /v1/games/analysis-corpus?limit=… (useAnalysisGames.analysisGamesPageKey), which sends no filter at all. On Today, DailyPulse (useAnalysisGames) and LadderPulse (/v1/games?limit=40) also ignore every filter. With 'vs Z' and 'Regions: EU' set, /app/arcade shows 'Active filters: Opponent race: Zerg · Regions: EU' over data that includes every race and region. The phone sheet says 'Changes apply right away, to every section.' The new help article analyzer-filters.ts says Today 'count[s] only the games it lets through' (line 44), 'Every section now counts only games against that race' (line 72) and 'Nothing else narrows your games' (line 84). Its 'Cards with their own scope' list names only the KPI cards, not Daily Pulse or Ladder Pulse. So the chips show filters the data does not use, and the copy says otherwise.

**Fix:** Hide the chip row on /app/arcade, as on /app/game, or add a note there that Arcade ignores filters. Add Daily Pulse and Ladder Pulse to the help article's 'Cards with their own scope' list. Reword line 44, line 72 and the FilterSheet description so they no longer say 'every section'.

## [UNVERIFIED, low] Shared FILTER_LABELS rename makes the build explorer's scope note read 'Too-short games: true' when short games are hidden
`apps/web/components/builds/BuildCompositionExplorer.tsx:87`

**Scenario:** BuildCompositionExplorer now formats each raw query parameter as `${FILTER_LABELS[key]}: ${value}`. FILTER_LABELS renamed exclude_too_short from 'Exclude short games' to 'Too-short games' (the chip wording, where the value is 'Shown' or 'Hidden'). Open a build from the analyzer Builds tab with default filters; BuildEditorModal passes the dossier filtersToQuery(filters). A throwaway test at e90d48ae rendered the note as 'Too-short games: true · Maps: ladder · Players: 1v1 · From: 2026-09-30T04:00:00.000Z'. 'Too-short games: true' reads as 'too-short games included', the opposite of exclude_too_short=true. Before this wave it read 'Exclude short games: true'.

**Fix:** Format exclude_too_short in the explorer as 'Too-short games: Hidden' / 'Shown', reusing describeActiveFilters' wording. Or keep an explorer-specific label for that key so the raw boolean still reads correctly.

## [UNVERIFIED, low] Matchup picker runs an unbounded all-history aggregation on every analyzer page load just to decide whether to show 'My race'
`apps/web/components/analyzer/MatchupPicker.tsx:51`

**Scenario:** usePlayedRaces calls /v1/random-summary with no filters. Before this wave the web app did not call that endpoint. aggregations.randomSummary runs gamesMatchStage(userId, {}) over the user's entire history, adding computed fields and grouping every game, with no date bound and no server-side cache. FilterBar renders on every non-game /app route, so each full page load or new tab of the analyzer adds one whole-history scan per user on the single Render instance and the M10 cluster. SWR deduping only helps within one tab session. The page's other default queries are bounded by the 5.0.17 date window. For a heavy account with tens of thousands of games, this is the most expensive request on Today, and it only decides whether a select is shown.

**Fix:** Use a cheap, bounded source for 'races played': a distinct or index-backed lookup on myRace for the user, a value cached on the user or /v1/me, or a short server-side cache in randomSummary. Or limit the aggregation, e.g. $limit or the default date window, since one game per race is enough.

## [UNVERIFIED, medium] Bundle budget CI step will fail on /app and /app/opponents at e90d48ae: every /app route now ships the whole help library on first load, and the failure also skips the Playwright smoke
`apps/web/components/analyzer/FilterBar.tsx:5`

**Scenario:** The budgets in perf-budget.json were set about 24-26 kB above the last CI build table, run 39871527817 at 4943b81c, whose apps/web tree matches 9942f97c: /app 216 kB with a budget of 240, and /app/opponents 154 kB with a budget of 180. The wave then merged FilterBar.tsx:5 and FilterSheet.tsx:5, which do `import { HelpLink } from "@/components/help/HelpLink"`. FilterBar is rendered by AnalyzerFrame in the /app layout, so every /app/* client entry now statically includes HelpLink -> lib/help (every article body), HelpArticleBody, HelpWidget, ChatCommandsCard and lib/multichat/commandsGuide. I estimated this with esbuild, bundling the statically reachable client code of AppShell + AnalyzerFrame + the page component. Dynamic imports and react/next/clerk were left out, everything was minified and gzipped, and I compared the git-archived 9942f97c and e90d48ae trees. /app grew from 101.2 to 137.3 kB gz (+36) and /app/opponents from 81.0 to 118.3 kB gz (+37). So /app is about 252 kB against its 240 budget, and /app/opponents is about 191 kB against 180. /app/game/[gameId] (~436 vs 440) and /app/opponents/[pulseId] (~495 vs 500) are only just under. The help registry alone is about 26 kB of that: in the same measurement, swapping the two imports for LazyHelpLink brings /app to 110.8 and /app/opponents to 91.7, both inside budget. `npm run perf:budget` exits 1 when a route is over (I checked this against a fake .next). Because the "Bundle budget" step (web-ci.yml:107) runs before "Run responsive smoke" (web-ci.yml:125) in the same job, the PR's e2e-responsive job goes red and the Playwright smoke never runs. Users also download about 26 kB gz of help text on every analyzer page, which the Settings LazyHelpLink change in 19a5b9cb was meant to avoid.

**Fix:** Load the help link lazily in the /app layout. Give LazyHelpLink support for variant="icon", which it currently lacks, and use it in FilterBar.tsx and FilterSheet.tsx. Run `npm run perf:budget` against a real CI build before merging. Also move the Bundle budget step after the Playwright smoke, or give the smoke `if: always()`, so a budget miss does not hide e2e results.

## [UNVERIFIED, low] Safe-area top padding makes the app header taller in the installed iOS app, so the pinned review replay (sticky top-[50px]) slides under it
`apps/web/components/chrome/AppChrome.tsx:217`

**Scenario:** 9295d125 adds pt-[env(safe-area-inset-top)] to the sticky z-30 context bar. The installed iOS app uses black-translucent and viewport-fit=cover, so on a notched iPhone the bar grows from 50px to about 97-109px. ReviewPage.tsx:141 pins the replay panel by default (pinned starts true, below xl) with `sticky top-[50px] z-20`, which assumes the old 50px header. Example: open /reviews/<id> in the installed app on an iPhone 14 and scroll the comment thread. The top ~47-59px of the pinned replay (its controls and minimap) sit under the header and cannot be seen, because the header's z-30 is above the panel's z-20. Before this commit the pinned panel sat directly below the header. The phone HelpMenu dropdown (HelpMenu.tsx:160, `fixed top-14`) also opens over the lower half of the taller header for signed-out visitors on /community in the installed app.

**Fix:** Publish the header height the same way as --chrome-bottom (for example --chrome-top measured with a ResizeObserver), or use top-[calc(50px+env(safe-area-inset-top))] for the ReviewPage sticky panel and the HelpMenu phone dropdown.

## [UNVERIFIED, low] The manifest's "Today" shortcut and start_url can land on another section: TodayView redirects to the user's Default tab on a cold start
`apps/web/app/manifest.ts:68`

**Scenario:** The new shortcut {name: "Today", url: "/app"} and start_url "/app?source=pwa" both render TodayView. TodayView applies Settings -> Misc -> Default tab once per browser session: if sessionStorage has no `sc2tools.defaultTabApplied`, it calls router.replace(hrefForTab(target)). Example: a player has Default tab = Macro. They cold-start the installed app by long-pressing the icon and choosing "Today", which gives a fresh sessionStorage. They land on /app/macro, not Today. The install-app help article also says the installed app "starts on **Today**", which is not true for anyone with a Default tab set.

**Fix:** Point the Today shortcut at a URL that TodayView treats as an explicit choice, for example /app?view=today, and skip the default-tab redirect when that parameter is present. Change the article to say the app opens on Today, or on the Default tab chosen in Settings -> Misc.

## [UNVERIFIED, low] Choosing "Later" on the update prompt removes the focused button and drops keyboard focus to <body>
`apps/web/components/pwa/ServiceWorkerRegister.tsx:175`

**Scenario:** A keyboard or screen-reader user tabs to the new "Later" button and presses Enter. setLater(true) makes the component return null, so the focused button leaves the DOM and document.activeElement becomes <body>. The next Tab starts again from the skip link at the top of the page, and the screen reader gets no feedback. The Later button was added in 9295d125.

**Fix:** Before hiding the prompt, move focus to a sensible target, such as the element that was focused before the prompt appeared or #main-content (which has tabIndex=-1). Or keep a visually hidden live-region message such as "Update postponed".

## [UNVERIFIED, medium] Analytics 'Turn off' in Settings -> Misc leaves gtag.js running, so events keep going to Google for the rest of the visit
`apps/web/lib/analytics/consent.ts:77`

**Scenario:** ca46766a adds a Misc control that switches consent from granted to denied while the page stays open. Before this wave nothing could do that: the banner only appears while consent is unset. Turning analytics off does the following: setConsent('denied') saves the choice, GoogleAnalytics unmounts <GaScripts>, gtag gets consent update analytics_storage=denied, and the _ga cookies are deleted. window.gtag and the loaded gtag.js stay in place, though. gaEvent() in lib/analytics/gtag.ts only checks that window.gtag is a function. So after 'Turn off', every gaEvent call still reaches gtag.js: OverlayUrlRow copy, the review components, and OnboardingShell's onboarding_step on each /welcome step (the 'Run setup again' link sits right next to the switch). With analytics_storage denied, gtag.js sends these as cookieless pings to google-analytics.com, together with GA's automatic and enhanced-measurement events, until the next reload. I confirmed this with a throwaway vitest: with window.gtag set, setConsent('granted') then setConsent('denied'), and gaEvent('overlay_url_copied') still calls gtag('event', 'overlay_url_copied', ...). Three pieces of text say otherwise. The help article says 'Press Turn off ... it takes effect right away'. The commit message says 'Turning it off mid-visit also tells a running gtag'. gtag.ts documents its helpers as no-ops without consent.

**Fix:** When consent becomes denied, set window['ga-disable-' + GA_MEASUREMENT_ID] = true, which is Google's kill switch and stops every hit, automatic ones included. Clear it again on 'granted'. Also make gaEvent, pageview and tagSessionAsInternal return early unless readConsent() === 'granted'. Add a test that gaEvent after setConsent('denied') does not call window.gtag.

## [UNVERIFIED, low] Section highlighter fires on any hashchange, so 'Skip to content' outlines and scrolls the whole <main> on Settings
`apps/web/components/analyzer/settings/SettingsShell.tsx:259`

**Scenario:** c90e031e makes SettingsShell treat every hash and every hashchange as a deep link to a section (revealSectionAnchor(window.location.hash) on [active, anchorChanges]). It only skips the Help tab. On /settings, AppShell's 'Skip to content' link is <a href="#main-content">, and AppChrome's <main> has id main-content. Example: a keyboard user on /settings?tab=overlay presses Tab, then Enter on 'Skip to content'. The hash becomes #main-content, hashchange fires and revealSectionAnchor finds <main>. It then sets data-section-flash='on' on <main> (a 2px cyan outline plus an 8px halo around the entire page content for about 2.2s), adds scroll-margin-top: 5rem and calls scrollIntoView({behavior:'smooth'}). The #main-content hash also stays in the URL, so a refresh flashes the page again. I reproduced this with a throwaway vitest: a <main id=main-content> and a hashchange to #main-content end with main[data-section-flash='on'] and a scrollIntoView call.

**Fix:** Only reveal anchors that point inside the active tab panel: look the element up within the tabpanel, not the whole document, or keep an allowlist such as elements marked data-settings-section. Ignore #main-content and other chrome targets.

## [CONFIRMED, medium] Dossier 'Public profile' check runs a full scan of every user's opponents rows on each new opponent opened
`apps/api/src/services/community.js:1496`

**Scenario:** b3db9df4 made GET /v1/opponents/:pulseId (the private dossier, the most-used analyzer page) await community.opponentProfileAvailable(pulseId) inside Promise.all. On a cache miss (any opponent nobody opened in the last hour) that calls _opponentScope, which runs db.opponents.findOne({ pulseId, pulseCharacterId: {$type:'string',$ne:''} }) with no userId. The only opponents indexes are {lastSeen}, {userId,pulseId} (unique), {userId,lastSeen} and {userId,gameCount}, so none has pulseId as a prefix. I checked this with a throwaway test using the real ensureIndexes on mongodb-memory-server and 4,000 opponents rows: the winning plan was COLLSCAN with 4000 of 4000 docs examined. For the common case of an opponent with no resolved character id, the scan reads the whole collection. Before this change the scan only ran from the rarely visited public /community/opponents page. Now every player clicking through the Opponents tab triggers one full collection scan per opponent. On the single Render instance and M10 this adds latency to the dossier response, which waits for the scan, and evicts the working set.

**Fix:** Resolve the character id with an indexed lookup. Options: read it from pulseAccounts by toonHandle (it has a unique index), or from the requesting user's own opponents row via {userId, pulseId}, or add an opponents index {pulseId:1} (partial on pulseCharacterId being a string). Then add a test that runs explain() on the query and asserts it is not a COLLSCAN.

## [CONFIRMED, low] Community opponent outage goes to error.tsx, whose 'Try again' cannot refetch a server-component error
`apps/web/app/community/opponents/[pulseId]/page.tsx:72`

**Scenario:** Scenario: the API is asleep or returns a 5xx while a visitor opens /community/opponents/1-S2-1-123. The page throws Error('community_opponent_unavailable') and app/error.tsx renders 'Something broke on this page … hit an error it couldn't recover from'. Its 'Try again' button only calls reset(). In Next 15.5 (node_modules/next/dist/client/components/error-boundary.js) reset() only does setState({error:null}). The segment then re-renders the same cached RSC payload, which still holds the thrown error, so the error screen comes straight back however long the visitor waits. Only a manual browser reload recovers. Every other community page uses CommunityUnavailable for the same outage: a 'temporarily unavailable' panel with an <a href> full reload. The new help article ('Temporarily unavailable … press Try again in a moment') promises that recovery, which does not happen here. Each such visit also sends an exception to Sentry and nudges the visitor to email support about a server that is just waking up.

**Fix:** Render <CommunityUnavailable title="This opponent profile is temporarily unavailable" retryHref={`/community/opponents/${encodeURIComponent(pulseId)}`} standalone /> instead of throwing. The metadata already marks it noindex. Separately, error.tsx could call router.refresh() inside startTransition together with reset() so its Try again works for server errors.

## [CONFIRMED, low] 'Which pages are public?' says shared replays are open to everyone, but each shared replay requires sign-in
`apps/web/lib/help/articles/getting-started/a-page-asked-me-to-sign-in.ts:42`

**Scenario:** Under 'Open to everyone' the new article lists 'Replays and archives a player chose to share with a link.' In practice, middleware runs auth.protect() for isSharedReplayDetailPath (/players/<x>/replays/<gameId> and /p/<x>/replays/<gameId>), and that page's own metadata says 'Sign in to view this shared replay analysis'. A visitor who opens a friend's shared replay link, or clicks any game in a public archive, is sent to /sign-in. The article meant to explain sign-in walls says this cannot happen. Its 'Why a page asked me to sign in' section also blames 'one of the account pages above', and shared replays are not in that list.

**Fix:** Change the line to say a player's shared replay archive (the list) is public, and that opening an individual replay's analysis needs a free account. Also add shared replay analysis to the 'Needs a free account' list.

## [CONFIRMED, low] /builds and /builds/<slug> now render nothing until Clerk loads, and the e2e walk passes on a blank page
`apps/web/components/builds/BuildsLibrary.tsx:84`

**Scenario:** BuildsLibrary and BuildDetailView (BuildDetailView.tsx line 69) now `if (!isLoaded) return null`. On SSR, Clerk v6 reports isLoaded=false, so the server sends an empty page body and the route's loading.tsx skeleton is replaced by nothing. A signed-in player who hard-loads /builds therefore sees skeleton, then blank, then the library. Before this change the inner component showed its header and Skeleton rows during that time. If ClerkJS is slow or blocked, the page stays blank forever for visitors and players alike. The new tests/e2e/visitor-walk.spec.ts claims '/builds never … loads forever'. In its own harness Clerk never loads, so main is empty, toHaveCount(0) on .animate-pulse passes, and the test never checks that the visitor intro or sign-in prompt appears.

**Fix:** While !isLoaded, render the route skeleton (for example the BuildsLoading or Skeleton markup) instead of null. Better: server-render BuildsPublicIntro and BuildSignInPrompt, since both have no hooks. In visitor-walk.spec.ts, assert the 'Your own build library' and 'Sign in to open this build' headings are visible, not only that no skeleton remains.

## [CONFIRMED, medium] Save to my library fails with a false 'already have a build with this name' when the title is long, including after the user deletes their copy
`apps/web/components/community/SaveToLibraryButton.tsx:196`

**Scenario:** The copy's slug is built as `${slugifyBuildName(title)}-${stamp}` and then cut to 80 characters. slugifyBuildName already returns up to 80 characters, so for a title whose slug is 79 characters or longer the cut removes the time stamp completely, and from 74 characters it removes part of it. Every save of that build therefore gets the same slug. I checked this with a real 88-character title, 'PvZ - Stargate Oracle into Glaive Adepts with a fast third Nexus and Robo for Disruptors': saves an hour apart both produce 'pvz---stargate-oracle-into-glaive-adepts-with-a-fast-third-nexus-and-robo-for-di'. 68183418 made these saves create-only. The PUT route then returns 409 slug_taken whenever the slug exists, and app.js slugTaken also counts soft-deleted builds. Two results: (1) 'Save another copy' always fails with 'You already have a build with this name.' (2) The help article says 'Deleting your copy brings the Save button back'. After the user deletes the copy the button does come back, but every save from it fails with the same false message, permanently. Before this wave the save overwrote or revived that slug, so saving still worked.

**Fix:** Shorten the name part before adding the stamp, for example `const base = (slugifyBuildName(baseName) || "build").slice(0, 80 - stamp.length - 1); const slug = `${base}-${stamp}`;`. Optionally add a short random suffix so two saves in the same second cannot collide. Add a test with a title of 80 or more characters that saves twice.

## [CONFIRMED, medium] Build stats card swaps its error panel for a skeleton on every retry, so keyboard focus is lost and the alert repeats
`apps/web/components/builds/BuildDossier.tsx:142`

**Scenario:** BuildDossier checks `isLoading && !data` before `error && !data`. In SWR 2.3, every revalidation of a key with no cached data sets isLoading=true, and the error stays set. Example: /v1/custom-builds/:slug/matches returns 500. RequestError is shown, with role=alert, Retry and Copy Error ID. A keyboard user presses Retry, the panel unmounts and the skeleton renders, so focus drops to <body>. When the request fails again, a new panel mounts with failedAgain=false. The 'failed again' status that RetryButton is built for never appears, and the alert is announced again from scratch. useApi here has no shouldRetryOnError:false, so SWR's automatic error retries (about 5s, 10s, 20s…) cause the same swap with no user action. While the dossier keeps failing, the card flickers between skeleton and error, screen readers hear the alert again each time, and any focus on Retry or Copy is lost. BuildDetailView checks the error first and does not have this problem.

**Fix:** Check the error before loading, as QueryState and BuildDetailView do: move the `error && !data` branch above `isLoading && !data`. Or show the skeleton only when `isLoading && !error`. Add a test where the response goes from {error} to {error, isLoading:true} and the RequestError (and the focused Retry) stays mounted.

## [CONFIRMED, low] Help article promises 'you never end up with duplicates', but copies saved before this release are never recognised
`apps/web/lib/help/articles/builds/publish-community-builds.ts:42`

**Scenario:** The duplicate check finds a copy only through forkedFrom.communitySlug. That field is written only by saves made after cbe33d0f/68183418, and no backfill or migration matches older copies. A user who saved community build X last month opens X again and sees 'Save to my library', not 'In your library — Open'. One click creates a second copy, which the article says cannot happen ('Already saved this build? … so you never end up with duplicates by accident').

**Fix:** Qualify the copy, e.g. 'Copies saved from <date> on are recognised…'. Or backfill forkedFrom for existing copies whose name equals a community title and whose rules match its snapshot. At minimum, do not promise 'never'.

## [CONFIRMED, low] The 'In your library' lookup trusts the server filter blindly, so an API without forkedFrom returns an unrelated build
`apps/web/components/community/SaveToLibraryButton.tsx:168`

**Scenario:** existingSlug is just `lookup.data.items[0].slug` from GET /v1/custom-builds?forkedFrom=<slug>&limit=1&view=summary. The summary projection (customBuildPages.js line 170) leaves out forkedFrom, so the client cannot check that the row really came from this community build. The web (Vercel) and the API (Render) deploy separately. Until the API with cbe33d0f is live, or if its deploy is rolled back, the old parseBuildPageOptions ignores the unknown forkedFrom parameter and returns the user's most recently updated build. Every signed-in user with at least one build then sees 'In your library — Open' on every community build, linking to an unrelated private build, and the Save button is hidden. Any 'Save another copy' made during that time goes to the old validator, which drops forkedFrom, so that copy is never recognised later.

**Fix:** Return forkedFrom.communitySlug in the summary row, or call the lookup without view=summary. In the client, accept only items where `item.forkedFrom?.communitySlug === communitySlug`. Deploying the API before the web also avoids the window.

## [UNVERIFIED, low] /definitions can serve a page with no Guide links for up to 6 hours after one failed sitemap fetch
`apps/web/app/definitions/page.tsx:23`

**Scenario:** Before this change /definitions was a fully static page. It is now an ISR page whose only fetch is the guide sitemap (revalidate 21600s, 6s timeout). lib/guides/api.ts says ISR pages must throw on 'unavailable' 'so the outage is never cached'. This page instead turns 'unavailable' into `published = null` and renders without Guide links. If the Render API is cold or slow (more than 6s) during the Vercel build or an ISR regeneration, that page without links is cached and served until the next 6-hour revalidation or the nightly tag purge. Every card loses its Guide link for that whole time.

**Fix:** Follow the module's rule for this page: make the Guide links a small client or streamed section that fetches the published paths on its own. Or use a much shorter revalidate when the sitemap fetch fails (e.g. call fetchGuideSitemap and pass a short revalidate on failure). Or render the links from guideBuildPath without checking the published set and let the guide pages handle unpublished slugs.

## [UNVERIFIED, medium] Scouting card's new 'Games usually end' line names the streamer's own army, but the card and copy present it as the opponent's
`apps/web/components/overlay/scoutingCopy.ts:37`

**Scenario:** opponentPhaseProfile (apps/api/src/services/overlayLiveAggregations.js) calls prepareCompositionGame(game) with no perspective argument, so it defaults to "you": it reads macroBreakdown.unit_timeline[].my. typicalLateComp.units is therefore the STREAMER's late army. d2948828 now renders that on the opponent scouting card as 'GAMES USUALLY END  Mid/Late game · Carrier, Tempest, Mothership' (ScoutingWidget.tsx:249). The phaseLine JSDoc says 'the army they usually reach', and the help article and Stream Studio guide use the same wording. Concrete cases: (1) a Protoss streamer vs Terran 'Future' (the ScoutingWidget.liveGame test fixture) shows Carrier, Tempest, Mothership under Future's name. (2) The Settings Test payload shows the same Protoss units on a Zerg 'TestOpponent'. (3) In a mirror (PvP), viewers can't tell the units aren't the opponent's, so the stream gets false scouting intel.

**Fix:** Either compute the opponent side (prepareCompositionGame(game, "opponent") with oppRace on the row, and only when hasOpponentStats), or label the units as the streamer's ('Your army: Carrier, Tempest') and drop them from the opponent line. Fix the phaseLine JSDoc, the help article and the guide wording to match. Change the test fixtures so a Terran opponent never shows Protoss units as theirs.

## [UNVERIFIED, medium] Favourite opening / cheese alert are computed for a name-only (Tier C) match, contradicting the 'Battle.net account, not just the name' guarantee
`apps/api/src/services/overlayLive.js:749`

**Scenario:** buildFromOpponentName Tier C looks up opponents rows by displayNameSample alone and takes the one with the most games. It then builds opp = {pulseId: oppRow.pulseId, ...} and passes that to _opponentTendencies. Reproduced with a throwaway jest test against mongodb-memory-server. The streamer has 3 games vs barcode 'IIIIIIIIIIII' (Zerg, pulseId 2-S2-1-999), each opened 'Zerg - 12 Pool'. A pre-game envelope then arrives for a different barcode with the same name, no pulse_character_id and no toonHandle (the usual case when SC2Pulse can't resolve a barcode). Result: favOpening {name:'Zerg - 12 Pool', samples:3, of:3}, cheeseProbability 1, cheeseHistory {3 of 3}. The other player's cheese alert goes on stream. The commit JSDoc ('A bare display name is not used as identity') and the help article (opponent-scouting.ts lines 33 and 91: 'matched by their Battle.net account, not just the name', 'a name alone isn't enough') both say otherwise. Before this change the Tier C path got only the never-written openings map, so these widgets stayed blank.

**Fix:** Pass only the envelope's own identity (pcidString / opponentToonHandle) to _opponentTendencies, or skip tendencies when oppRow.matchedBy === 'display_name'. Otherwise, correct the help article and the JSDoc so they no longer promise account-level matching.

## [UNVERIFIED, medium] Restore runbook tells admins to re-run history wipes with wipeGames(userId, {}), which deletes the user's whole history when the original wipe was a date range
`docs/runbooks/restore-database.md:177`

**Scenario:** Settings → Delete game history sends since/until (SettingsBackups.tsx confirmWipeGames), and gdpr.wipeGames honours them. The gdpr_games_wiped log line (routes/me.js) records only {userId, counts}, not the range. Example: on Oct 20 a user wipes Oct 1–10. Admins later restore the cluster to Oct 15. Following step 5, they grep gdpr_games_wiped and run services.gdpr.wipeGames(userId, {}). That deletes every game the user has, including years outside the range, plus the matching R2 replay files and detail blobs. This is permanent data loss. Separately, admin-initiated wipes (POST /admin/users/:userId/wipe-games) log nothing, so the runbook's log search misses them.

**Fix:** Log since/until in gdpr_games_wiped, log the admin wipe route too, and change the runbook to re-run with the logged {since, until}. Until the logs carry the range, tell admins not to re-run without it and to ask the user instead.

## [UNVERIFIED, low] Backup freshness bands and admin copy assume one Atlas snapshot a day; the M10 default schedule is every 6 hours
`apps/api/src/services/backupStatus.js:36`

**Scenario:** The comment ('Atlas takes one snapshot a day under the default policy') sets FRESH_MAX_HOURS=26 and AGING_MAX_HOURS=50, and the card's aging notice says 'Atlas usually takes one a day'. The default Cloud Backup policy on M10 takes a snapshot every 6 hours (kept 2 days) plus daily, weekly and monthly items. The same card renders this from retention, e.g. 'Every 6 hours, kept 2 days'. Result: a 25 h-old snapshot (about 4 missed scheduled runs) shows a green 'On time' badge. The overdue alert first fires at 50 h, about 8 missed runs, by which point every 6-hourly snapshot from before the failure has already expired. The 'late' notice also contradicts the schedule row just above it. nextSnapshotAt, which would show a stuck schedule directly, is fetched but ignored.

**Fix:** Derive the bands from the parsed schedule: use the smallest interval, e.g. late after 2× interval plus slack and overdue after 4×, falling back to 26/50 h when the schedule is unreadable. Optionally treat nextSnapshotAt well in the past as late. Reword 'Atlas usually takes one a day' to state the actual schedule.

## [UNVERIFIED, low] An expired or rotated Atlas service-account secret is reported as a missing Project Read Only role
`apps/api/src/services/backupStatus.js:327`

**Scenario:** backupErrorCode matches /_http_(401|403)$/. That also catches atlas_oauth_http_401, which _requestToken throws when the OAuth token request fails, e.g. after ATLAS_SERVICE_ACCOUNT_SECRET expires or is rotated. The card (DatabaseBackupsCard.tsx:338) then says 'Atlas refused the backup check. Give the service account the Project Read Only role on this project', and the hourly alert stays silent because the status is unavailable. An admin following the card grants a role that is already there, while the real fix (a new secret) is not mentioned.

**Fix:** Map atlas_oauth_http_* (and atlas_oauth_invalid_response) to a separate code such as atlas_backup_auth_failed, with copy telling the admin to check or rotate the ATLAS_* secret and its expiry. Keep atlas_backup_forbidden for API 403s only.

## [UNVERIFIED, medium] Help says a failed request never shows a 'no data' message, but the Today KPI cards do exactly that
`apps/web/lib/help/articles/troubleshooting/something-went-wrong.ts:37`

**Scenario:** The article tells players that a failed request never shows an empty 'no data' message, so any empty message means their filters really matched nothing. CHANGELOG.md says the same: 'instead of wrongly showing no data'. On /app, DashboardKpiStrip ignores the error from useApi for Games today, Win rate, Active streak and MMR. I rendered DashboardKpiStrip in a throwaway vitest test (since deleted) with every useApi call returning { data: undefined, isLoading: false, error: {status: 500, requestId} }. It showed 'Games today 0 · No games yet today', 'Win rate 0 · No games in this window', 'Active streak 0 · Tied or no recent games' and 'MMR — Add a Pulse ID in Settings', with no RequestError and no Retry. Only 'Games in range' said 'Unable to load selected range'. So when /v1/timeseries or /v1/streak returns a 500 (a 5xx is not a connectivity error, so the Reconnecting bar never appears), the player sees zeros and the help article tells them the zeros are real.

**Fix:** Give the four KPI cards an error state: '—' plus 'Couldn't load' and a Retry or RequestError when q.error is set and there is no data, and an error hint for MMR. Until then, drop the absolute 'never' sentence from the article and from the CHANGELOG 'When something can't load' entry.

## [UNVERIFIED, medium] Articles and CHANGELOG send users to a '?' button in the top bar; the button shows a life-buoy icon
`apps/web/lib/help/articles/troubleshooting/report-a-problem.ts:34`

**Scenario:** report-a-problem.ts:34 says 'Press the **?** (Help & support) button in the top bar'. how-to-use-help.ts:48, troubleshooting-and-support.ts:34 and CHANGELOG.md:16 ('a ? menu in the top bar') say the same. HelpMenu.tsx draws the button with <LifeBuoy> (a ring) and no '?' glyph. Nothing else in the top bar shows a '?' (check-in alert, coaching alert, bell, theme toggle, avatar). The analyzer filter bar (FilterBar.tsx <HelpLink variant="icon">) and Settings do show real '?' (CircleHelp) icons. Those open a help article sheet, not the report menu. So a player on /app who follows 'press the ? button' clicks the filter bar '?' and gets the Filters article instead of Report a problem.

**Fix:** Either change the top-bar button icon to CircleHelp, or reword the three articles and the CHANGELOG to 'the Help & support button (life-buoy icon) in the top bar'.

## [UNVERIFIED, low] 'Something went wrong' says the server sleeps when idle; the API runs on a Render Starter plan, which does not sleep
`apps/web/lib/help/articles/troubleshooting/something-went-wrong.ts:100`

**Scenario:** The article says the most common reason for the Reconnecting bar is that the server is waking up: 'it goes to sleep when nobody has used it for a while and takes about 30 seconds to start again'. a-page-asked-me-to-sign-in.ts:74 and docs/design-system.md:344 ('one free-tier instance that sleeps when idle') say the same, and so does the new UI copy in lib/requestErrors.ts and CommunityUnavailable.tsx. But apps/api/render.yaml declares `plan: starter`, and docs/cloud/SETUP_CLOUD.md:323 (pre-existing) says this 'paid $7 Starter instance … does not spin down for inactivity'. During a real outage or a deploy restart, users are told it's a normal 30-second wake-up and to wait, which is not why the bar appears.

**Fix:** Describe the real causes (the connection dropped, or the server is restarting or being updated) and drop the sleep/idle claim from the article, design-system.md and the RequestError and Community copy. Or, if a sleeping instance is planned, change render.yaml and SETUP_CLOUD.md to match.

## [UNVERIFIED, low] Install article gives the wrong cutoff for old installs ('before October 2026')
`apps/web/lib/help/articles/getting-started/install-app.ts:91`

**Scenario:** The new manifest (id '/app', start_url '/app?source=pwa', four shortcuts) shipped in this wave on 22–23 Oct 2026. The manifest at 9942f97c had no id, start_url '/?source=pwa' and no shortcuts. Someone who installed the app on 10 Oct 2026 has the old install: it opens on the home page and has no shortcuts. The heading 'Installed it before October 2026?' tells them the reinstall advice doesn't apply. The CHANGELOG gets it right ('before this release').

**Fix:** Reword the heading to 'Installed it before 23 October 2026?' or 'Installed it before this update?'.

## [UNVERIFIED, low] Scouting article says a check-in correction changes every widget, but Best answer ignores corrections
`apps/web/lib/help/articles/stream-studio/opponent-scouting.ts:92`

**Scenario:** The article says the label used is the one you chose in build check-in, and that 'From the next game, the widgets count it your way'. Favourite opening does use the corrected label (opponentTendencies.personalOppStrategy). Best answer is then looked up with bestAnswerVsStrategy (overlayLiveAggregations.js:348), which matches the raw `opponent.strategy` field exactly against that name and groups by the raw `myBuild`. Example: a streamer relabels 3 PvZ games against an opponent from 'Zerg - Hatch First' to 'Zerg - 12 Pool'. Favourite opening shows '12 Pool, 3 of last 3 games', but none of those 3 games count toward Best answer because their raw label is still Hatch First. Best answer stays empty or reflects unrelated games, which contradicts the article.

**Fix:** Have bestAnswerVsStrategy match on the same correction-aware label (check-in override if present, else the raw label) for both opponent and own build. Or state in the article that Best answer reads the replay labels only.

## [UNVERIFIED, low] 'Which pages are public?' is called the full list but leaves out the public Reviews board
`apps/web/lib/help/articles/getting-started/a-page-asked-me-to-sign-in.ts:34`

**Scenario:** getting-started.ts (changed in this wave) links this article as 'the full list' of public pages. The 'Open to everyone' list leaves out the Review Exchange board (/reviews). That page is not protected in middleware.ts, appears as 'Reviews' in the signed-out header (headerNav.ts), and got a signed-out explainer in 7fc30b15. The list also leaves out Guides and Analyze replays (/try), which the signed-out header shows when they are enabled. Meanwhile 'Needs a free account' lists 'Asking for or writing replay reviews', so a visitor reading the article concludes the Reviews section needs an account.

**Fix:** Add 'Browse the [Review Exchange](/reviews)', and Guides and Analyze replays when enabled, to 'Open to everyone'. Or stop calling the article the full list in getting-started.ts.

## [UNVERIFIED, medium] Item 4's static HelpLink in the analyzer filter bar puts every help article into the first load of all /app routes
`apps/web/components/analyzer/FilterBar.tsx:5`

**Scenario:** app/app/layout.tsx -> AnalyzerFrame (client) -> FilterBar imports HelpLink statically (FilterSheet.tsx:5 does the same). HelpLink -> lib/help -> articles/index.generated.ts, so all 20 help articles (about 79 KB of source, about 22 KB gzip, measured at e90d48ae) plus HelpArticleBody and HelpSupportLine ship in the first-load JS of every /app, /app/[section] and /app/opponents page. At 9942f97c no /app route imported the registry. Two items worked to keep it out of first loads: app-shell-quick-fixes (InstallPrompt deliberately uses a plain Link; perf-budget.json caps /app/opponents at 180 kB and /app/[section] at 260 kB) and help-and-feedback-menu (LazyReportIssueModal). global-filter-clarity's report flagged this cost for app-shell-quick-fixes. Integration commit 19a5b9cb swapped in LazyHelpLink only for the Settings header and missed the analyzer filter bar. BuildsPublicIntro.tsx:4 does the same on /builds, because BuildsLibrary imports it statically, so signed-in users load it too. The cost grows with every article (the help-content-backfill adds about 27 more), so the CI Bundle budget step is likely to fail, or every analyzer page gets heavier.

**Fix:** Use LazyHelpLink in FilterBar, FilterSheet and BuildsPublicIntro. Add `variant="icon"` support to LazyHelpLink (its fallback can be the same small ? link with aria-label "Help: Filters…"), or load these pieces with next/dynamic. Keep the existing FilterBar test's accessible-name assertion working.

## [UNVERIFIED, low] Phone ? menu overlaps the top bar in the installed iOS app now that the header pads for the notch
`apps/web/components/chrome/HelpMenu.tsx:160`

**Scenario:** help-and-feedback-menu positions the phone menu at `fixed inset-x-4 top-14` (56 px), assuming the 48 px (h-12) header row starts at y=0. app-shell-quick-fixes added `pt-[env(safe-area-inset-top)]` to the same header (AppChrome.tsx:216), and the root layout uses the black-translucent status bar. Repro: installed iPhone app (safe-area-inset-top about 47–59 px), signed-out visitor at 390 px (the only case where the menu shows below md) on /community taps ?. The header row now spans about 47–95 px, and the menu is painted from 56 px on top of it (z-50 over the header's z-30), covering the logo, the ? button and Get started. On a Dynamic Island phone (inset 59) it covers the whole row.

**Fix:** Offset the phone menu by the safe area, e.g. `top-[calc(env(safe-area-inset-top,0px)+3.5rem)]`, or anchor it to the header's bottom edge instead of a fixed 56 px.

## [UNVERIFIED, low] Merged NoFilterMatches offers a 'Reset filters' that can only hide games when Too-short games is shown
`apps/web/components/analyzer/EmptyStates.tsx:187`

**Scenario:** Integration commit f4b1815a rebuilt NoFilterMatches on global-filter-clarity's describeActiveFilters, which reports `exclude_too_short: false` as an active facet. data-states-recovery's own helper deliberately left the too-short toggle out (its deleted test: 'reports nothing for the defaults (date preset and too-short toggle aside)'), because the empty state promises 'only the ways out that would change the answer'. Verified with a throwaway vitest run (since deleted): with filters {preset:'all', exclude_too_short:false, map_pool:'ladder', game_size:'1v1'}, 'Applied now' reads 'Dates: All time · Too-short games: Shown', and the only button is 'Reset filters'. It calls setFilters with exclude_too_short:true, which removes games (under 45 s) and can never turn 'Nothing matches' into a match. The user is told that a widening setting explains the empty result and is handed a dead-end action. The integrated NoFilterMatches test asserts 'Too-short games:Shown' is listed, so it locks this in.

**Fix:** In NoFilterMatches, also filter out the `exclude_too_short` facet (as is already done for `preset`), so it is neither listed as a cause nor reset. Alternatively, only count facets whose clearPatch widens the result. Update the 'uses the chip row's list' test to match.
