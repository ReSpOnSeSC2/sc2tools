# Analysis corpus: the history-on-this-device UI (AC5, October 31 UTC)

The program remains active and incomplete. This is slice AC5 of roadmap item
`analysis-corpus-local-cache` (ledger ordinal 75). It meets the item's fifth
remaining requirement in source: "Add one-time history gate, count/refresh
footer, Backups & data local bytes/Clear controls and history-on-this-device
Help." AC5 builds on AC4
([PR #844](https://github.com/ReSpOnSeSC2/sc2tools/pull/844), merged as
`1d2353cc`), whose clearing it relies on. It changes the web app only; paths are
written in full.

With AC5, Daily Pulse's gate is the first place that asks to keep a copy, so
the device copy built in AC1 to AC4 starts being created for players who choose
it. No flag, provider setting or infrastructure changes. The item stays partial
in the ledger until its delivery is recorded.

## What players see

- **The one-time gate.** Daily Pulse
  (`apps/web/components/analyzer/DailyPulse.tsx`) still keeps the full history
  dormant until asked. Its gate reads "Loads your game history here. This
  browser keeps a copy when it can." with a "How it works" help link, and its
  button reads **Load my history**. Choosing it asks to keep the history on this
  device (`keepOnDevice`) and opens Daily Pulse, as **Show insights** did. A
  choice made before sign-in has finished loading applies to the account that
  loads next.
- **The footer.** Under the cards, `DailyPulseFooter`
  (`apps/web/components/analyzer/DailyPulseFooter.tsx`, loaded on demand) says
  when the history on screen last came from the server ("Updated 5m ago",
  moving on once a minute), "Updating…" while it updates, or "Couldn't update"
  after a failure. It shows how many games are on screen, and "on this device"
  when they are kept here.
  - **Refresh** checks now. It stays focusable but does nothing while an update
    runs, and reads **Try again** after a failure.
  - A failed update keeps the games already on screen. Only a first load that
    fails with nothing to show still shows the full "couldn't load" state.
  - **Keep on this device** appears for an account this browser does not keep:
    after Clear, Delete history or a restore, and for anyone who opened Daily
    Pulse before this slice. It updates when another tab starts keeping it, and
    focus moves to the status it changes.
  - Over the 20,000-game limit, when the browser refuses storage, or when this
    browser could not store the copy (for example when it is short of space),
    a line says so. One live region that stays mounted announces these, and,
    after Keep, that it worked.
  - If the footer's chunk cannot load, a small fallback under the cards still
    shows the update status with Refresh, or Try again after a failure.
- **Settings, Backups & data.** A new **Games on this device** section
  (`apps/web/components/analyzer/settings/DeviceHistorySection.tsx`) shows how
  many games this browser keeps for the signed-in account and about how much
  space they take, with **Clear**. Clear runs the AC4 clear, the toast says the
  games are still in the account, and focus moves to the row. A kept choice
  with no games explains why (more than 20,000 games, or a browser short of
  space). Settings search finds it as "Games stored on this device", and by
  "history".
- **Help.** A new article, "Your history on this device"
  (`apps/web/lib/help/articles/account-data/history-on-this-device.ts`),
  covers what each stored row holds (including Battle.net and SC2Pulse IDs),
  how it updates, when it is not kept, how to see and clear it, and shared
  computers, without speed or download claims. Today's article describes the
  new gate and footer; Today, Arcade and Backups & export link the new article,
  and so does Arcade's warm-up card.
- **Privacy policy.** "Data stored in your browser"
  (`apps/web/app/legal/privacy/page.tsx`, updated October 31, 2026) now
  discloses the copy: what each row holds, that it is a copy never sent back,
  the 20,000-game limit, and when it is removed.

## How it works

- **When the history last updated.** `useAnalysisGames`
  (`apps/web/components/analyzer/arcade/hooks/useAnalysisGames.ts`) gains
  `syncedAt`. Only a finished load or sync stamps it. A copy shown from this
  device before its changes arrive, a snapshot shown before it is saved, a
  reload in progress and a failed update all leave it null.
- **When keeping failed.** It also gains `keepFailed`: a finished load that
  should have left the history on this device and did not. That is a requested
  keep that could not start, or an account that keeps its history here whose
  copy could not be stored. The 20,000-game limit is not a failure. The next
  load tries again.
- **A keep before sign-in loads.** A keep asked for before Clerk names the
  account is remembered and applies to the account that loads next. It is
  dropped once Clerk finds nobody signed in.
- **Reading the size without loading the copy.** `readDeviceSummary`
  (`apps/web/lib/analysisCorpus/deviceStore.ts`) reads the account's record
  for the game count and samples up to 64 evenly spaced rows for an average
  size, in one read-only transaction. A record that does not check out, or a
  count with no rows behind it, reads as unreadable.
- **Settings never creates or touches another account's copy.** The section
  loads the device store only when the device note names the signed-in
  account, opens the database with `create: false`, drops a result when the
  note changed while it read, and binds each row to the account it was read
  for. It reads again after a wipe or restore on the page. A browser that
  refuses storage shows that, with nothing to clear.
- **Load on demand.** The footer is a `next/dynamic` chunk, and the Settings
  section loads the device store only when it has something to read.

## Tests

- **Gate and footer** (`apps/web/components/analyzer/__tests__/DailyPulse.test.tsx`,
  `apps/web/components/analyzer/__tests__/DailyPulseFooter.test.tsx`,
  `apps/web/components/analyzer/__tests__/DailyPulse.footerFallback.test.tsx`):
  the gate keeps the history and loads once; the footer's times and counts;
  Refresh held but focusable while updating; Try again after a failure with the
  cards still on screen; the keep offer and another tab's keep; the corpus
  limit; both kinds of refused storage; a failed keep with and without the
  offer; the announced keep outcome, once; the footer only under loaded
  history; and the fallback keeping focus through a retry.
- **The hook** (`apps/web/components/analyzer/arcade/__tests__/useAnalysisGames.test.ts`):
  `syncedAt` stamped after a finished load, null while reloading and after a
  failed update with the games kept, null for a stored copy until its changes
  are merged and for a first keep's snapshot until it is saved; `keepFailed`
  for storage that is missing, for a kept account whose save fails until it
  can be saved, and not over the corpus limit; a keep before sign-in loads,
  kept for the next account and dropped when nobody signs in.
- **The summary** (`apps/web/lib/analysisCorpus/__tests__/deviceStore.test.ts`):
  absent, kept, an empty copy, the exact size for a small copy, the sampled
  estimate, and unreadable records and missing rows.
- **The Settings section**
  (`apps/web/components/analyzer/settings/__tests__/DeviceHistorySection.test.tsx`):
  the count and size; Clear (the note and the database go, the account is
  untouched, focus moves to the row); another account's copy and a signed-out
  user (the database is never opened); a noted copy that is gone (never
  created); refused storage; a kept choice with no games and an unreadable
  copy; waiting for sign-in; an account switch; the re-read after a restore;
  and a clear that overtakes a read.
- **Privacy policy** (`apps/web/app/legal/privacy/__tests__/page.test.tsx`):
  the browser-storage section discloses the copy, what it holds, the
  20,000-game limit, that it is not sent back, and when it is removed.
- **Settings pages.** Tests that render Backups & data load the lazy help
  link's chunk first
  (`apps/web/components/help/__tests__/loadLazyHelpLink.tsx`). Tests run
  react-dom 19.0.0, whose rotating retry lanes are never marked suspended
  when several help links suspend around the page's first render, so a
  synchronous `act()` re-renders forever while the chunk cannot load. An
  inspector trace showed the four retry lanes rotating with no state updates.
  Production runs Next's own React build (a 19.2 canary). Measured outside
  `act()` while a lazy chunk loaded, it committed three to five times in 1.6
  seconds and did not cycle, in every shape tried, including the one that
  loops inside `act()` on 19.0.0.

## Review

Two independent read-only passes reviewed the slice, each a workflow with a
critic that checked every finding against the code.

- **First pass (at `d15c9da3`; one reviewer with three lenses: correctness and
  races; honesty, privacy, accessibility and mobile; tests).**
  - One medium finding, confirmed: the Help article, Today's help, the gate and
    Settings said history "opens at once" and "only downloads new games". The
    code guarantees neither: the stored copy waits for the device store to open
    and read, and the whole history downloads again after a wipe, a restore or
    a corpus change. The standing rules forbid latency and request-reduction
    claims.
  - Twelve low findings and two missed items. A keep asked for before Clerk
    loaded was dropped, and a keep that failed said nothing. A failed footer
    chunk left a failed refresh without Try again, and focus was lost after
    Refresh, Keep and Clear. Standalone help links were under 44 px. Help
    overstated what Delete history clears elsewhere and left out the IDs each
    row holds. The rest were test gaps. The critic judged the test helper's
    browser claim unverified.
  - `fb2907d8` fixed them all, and a measurement settled the helper (above).
- **Second pass (at `fb2907d8`; a verifier of every first-pass fix).**
  - Every first-pass finding was fixed except one: a keep whose save failed
    while its reset succeeded still counted as kept.
  - Three low findings were confirmed: that unstored copy, the footer
    fallback's Try again dropping focus, and keep outcomes not announced to
    screen readers. A fourth was refuted: a keep pressed after signing out
    cannot happen, because a sign-out refreshes `/app`, which redirects to
    sign-in.
  - `8d4a43a9` fixed the three. Nothing blocked merge.
- **After the passes.** Neither pass looked at the privacy policy, whose
  "Data stored in your browser" section described only Instant Analysis.
  `7e5c390a` added the copy Daily Pulse keeps, before any check of record.

## Verification

Local checks ran at `7e5c390a`, which contains AC4's merge (main `1d2353cc`)
and the first-load fix (PR #847's head `58c373fd`, merged as `81172b25` with the
same tree). The receipt is
`docs/handoff/validation/analysis-corpus-ui/local-verification.json`.

- **Web.**
  - Whole-web types pass.
  - Configured lint reports 190 warnings and 0 errors. The changed
    files add no message, and the new files have none.
  - The UI lint passes.
  - All 1,052 web test files pass with one isolated worker at a time:
    10,308 cases, with 1 skipped by the suites themselves.
- **API.** Unchanged by AC5.
- **Mutation.** 25 of 25 deliberate regressions are killed in AC5's suites.
  They ran at `e682311e`, before the privacy disclosure; every file they mutate
  or run is byte-identical at the tested commit, and the receipt checks that.
- **Bundle.** Local production builds use the public flags CI sets.
  - `/app` is 232.2 kB of first-load JavaScript (gzip), against 231.8 kB for
    the same local build of `58c373fd` (PR #847's head, whose tree main has
    after merging it), so AC5 adds 0.4 kB there. CI measured that head at
    230.6 kB, so `/app` is projected near 231.0 of its 240 kB.
  - Four other routes gain 0.1 kB each (`/community`, `/dock/[token]`,
    `/help`, `/settings`); the new Help article's index entry and Settings
    search field are the likely cause. Every other route is unchanged.
  - Local builds run about 1.2 kB larger than CI's on `/app`. The one route
    the local check flags (`/guides/[matchup]/[build]`, 175.3 of 175 kB) is
    flagged in the base build too; CI's own build remains the gate.

## Limitations

- The tests run on fake-indexeddb and jsdom. The gate, footer and Settings
  section were not checked in a real browser, on a phone, with a screen
  reader, or in Firefox and Safari.
- The size is an estimate from up to 64 sampled rows. It counts the stored
  rows' JSON, not the browser's own overhead.
- A copy kept on another device is not shown or cleared here; it goes when
  that device signs out or replaces it on its next load.
- "Updated" reflects this tab's last finished load. Another tab's sync does
  not move it.
- No latency, request-reduction or savings claim.

## Remaining for the item

- Exact-head CI, merge, deployment and production acceptance of AC1 to AC5,
  recorded with the item's delivery.
