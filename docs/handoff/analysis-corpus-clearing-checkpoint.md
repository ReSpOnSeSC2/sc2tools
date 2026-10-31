# Analysis corpus: clearing history kept on this device (AC4, October 31 UTC)

The program remains active and incomplete. This is slice AC4 of roadmap item
`analysis-corpus-local-cache` (ledger ordinal 75). It meets the item's fourth
remaining requirement in source: "Clear disk on sign-out, account switch and
Delete history; retire stale owner/version work." AC4 is stacked on AC3
([PR #842](https://github.com/ReSpOnSeSC2/sc2tools/pull/842)), whose device copy
it clears, and merges after it. It changes the web app only; paths are written
in full.

It is dormant in production. No device copy exists until AC5's one-time gate
asks to keep one. Until then, signed-in pages read one or two localStorage keys,
and Delete history, restore and account deletion run a clear that finds nothing
to remove. No flag, provider setting or infrastructure changes. The item stays
partial.

## When the copy goes

- **Sign-out and account switch.** `DeviceHistoryGuard`
  (`apps/web/components/chrome/DeviceHistoryGuard.tsx`) is mounted on every
  signed-in surface, in both Clerk branches of `apps/web/app/AppShell.tsx`. Once
  Clerk has loaded, it reads the device note. A note naming another account, or
  any account while nobody is signed in, loads the clearing code and removes the
  copy.
  - It reads the note again when that code arrives, so a copy another tab just
    started keeping for the signed-in account stays.
  - If the chunk cannot load (a deploy replaced it), an inline fallback forgets
    the note, deletes the database and moves the clear mark.
  - When the note cannot be read, it deletes the database: no copy is kept
    without a note this browser can read (below).
  - When an earlier clear's delete was never seen to finish, it issues that
    delete again (below).
- **Delete history and restore.** Settings, Backups & data
  (`apps/web/components/analyzer/settings/SettingsBackups.tsx`) clears the copy
  after a wipe or a restore succeeds. It also clears the copy after a wipe or
  restore whose outcome is unknown (no answer, or a server error), since a retry
  may never get that far: a wipe's dry run then counts no games. A definite
  rejection (a 4xx), or a browser that was offline, keeps it. Starting a data
  repair refreshes the page's data but keeps the copy: a repair neither deletes
  nor restores history.
- **Account deletion.** The dialog
  (`apps/web/components/analyzer/settings/AccountDeleteDialog.tsx`) clears the
  copy before signing out, once erasure succeeds or the API confirms an earlier
  success whose answer was lost. An erasure that fails with an unknown outcome
  clears it too, by the same rule as a wipe.
- **What a clear does.** `forgetDeviceCopy`
  (`apps/web/lib/analysisCorpus/deviceClear.ts`) forgets the note, queues the
  database's delete, then moves the clear mark, each step in its own try. A sync
  that reads the new mark therefore opens after the delete, and full storage
  still forgets the note. Other tabs' connections close on `versionchange`, and
  the delete finishes after them; nothing waits for it.
- **A delete that never finishes.** Until the delete succeeds, or a later
  successful open shows it finished, it is recorded as owed. If a frozen tab
  holds it, or the browser closes first, the guard issues it again on a later
  page. An older delete never settles a newer clear's.

## The note names the copy's owner

Whenever the note can be read, the database holds no rows of an account other
than the one the note names. The note is how a sign-out or another account finds
a copy.

- **Note first.** A first keep clears any copy the note does not name as this
  account's, then notes the account before it opens or creates the database.
  A sign-out in any tab therefore finds the copy for as long as any of it can
  exist, and no other account's rows sit under the new note, even if the
  snapshot that would replace them fails. A keep that holds no usable copy of
  its own also drops whatever is in the database before its snapshot, so
  another account's rows cannot outlive a delete that errored. A first keep
  that cannot open the device takes back the note it just wrote, so later loads
  skip the probe.
- **The choice at once.** A database a keep creates records the account's
  choice in the same upgrade, so no other connection ever finds it without
  one. A probe in another tab of the same account then reads "kept" and stores
  its own snapshot beside the keep, rather than mistaking the keep for a missing
  copy.
- **Every write checks the note.** Each device write also requires the note to
  still name the account. When two accounts start keeping at once in one
  browser, the one whose note was replaced stops before it writes.
- **Only a full clear removes the note.** A sync that finds the note naming its
  account but no copy it can explain (no database, or no record of the account
  in it) clears in full. The clear moves the mark, so nothing can go on writing
  under a note that is gone. A sync that is no longer current (cancelled, or
  cleared since it began) leaves the note alone, since a newer keep may have
  written it. `noteDeviceCopy` cannot forget the note.
- **Fail closed.** `noteDeviceCopy` (`apps/web/lib/analysisCorpus/deviceNote.ts`)
  is true only when the note reads back as asked. A browser whose storage
  refuses the write keeps its history in memory, and creates nothing. A browser
  that cannot read the note keeps no copy at all: the sync and the guard delete
  any database they find there.

## Stale owner and version work

- **The clear mark.** Every clear moves a mark in localStorage. A sync reads it
  when it starts, and checks it, with the note, before it shows a stored copy,
  before and after every device write, and before it shows a fetched snapshot.
- **After a clear.** A sync whose copy is no longer its own writes nothing more
  and reads the corpus again, in memory only. What it read before the clear may
  predate a wipe or restore in another tab, which sends no change event, so
  showing it would bring deleted games back until the next load. A sync that a
  clear stopped, or that was cancelled, and that finds the note gone clears
  again, so the record its open may have recreated goes too. A copy it could
  neither replace nor drop is deleted only while the copy is still its own.
- **Owner changes.** A sync for an account that signed out is cancelled by the
  provider when the account changes; the mark stops it from writing if the clear
  lands first. Cancellation still ends a sync without a result, as in AC3.
- **An interrupted keep.** A first keep stopped by a clear keeps its request, so
  that tab's next load tries again. A probe stops a first keep only when the
  probe's open ran before the keep's and found no database at all.
- **Version changes.** A wipe or restore elsewhere still bumps the corpus
  version, so the next sync drops a copy that missed the clear (AC2 and AC3).

## Bundle

The guard reads one or two localStorage keys and holds the small fallback;
everything else loads on demand. The clearing code sits in its own module, which
only the guard's dynamic import, the settings chunks and the sync chunk load, so
it is outside every page's first-load JavaScript. `useAnalysisGames` still
imports only the note's read.

## Tests

- **Note, clear and store** (`apps/web/lib/analysisCorpus/__tests__/deviceNote.test.ts`,
  `apps/web/lib/analysisCorpus/__tests__/deviceClear.test.ts`,
  `apps/web/lib/analysisCorpus/__tests__/deviceStore.test.ts`): naming one
  account and failing closed; a clear's order (the delete before the mark), its
  separate tries, the owed delete and which clear settles it; storage or
  IndexedDB refused; which failures may have gone through; the owner's choice
  recorded only by the upgrade that creates the database.
- **Guard** (`apps/web/components/chrome/__tests__/DeviceHistoryGuard.test.tsx`):
  the owner's copy kept; signed out, another account, before Clerk loads, a
  signed-in account with no note, an unreadable note; an owed delete issued
  again, but not under the owner's note; the re-read before clearing; and the
  fallback when the chunk cannot load, with its own re-read. The tests wait on
  the guard's own import, not on a fixed number of ticks.
- **Sync** (`apps/web/components/analyzer/arcade/__tests__/analysisCorpusSync.test.ts`):
  a first keep noted before its rows exist, and its note taken back in a full
  clear when the device cannot open; nothing created when the note cannot be
  written; a copy noted for another account or for nobody cleared before a
  keep, while the account's own copy is used; an unreadable note; a probe
  beside a first keep, a probe that is no longer current or was cancelled, a
  copy its note does not explain, and another account's keep taking the note;
  clears during a changes read (a delta and a refusal), a snapshot read, a save,
  a merge, a drop (that works or fails) and the open, each followed by an
  in-memory read, with the device writes counted; a cancelled keep that a clear
  stopped; a stale copy kept from a newer keep, and deleted when its run is
  cancelled; owed deletes settled only by an open they came before; another
  account's rows dropped by the keep itself; and a first keep whose open lands
  after the 3 s deadline, taken back or cancelled.
- **Settings** (`apps/web/components/analyzer/settings/__tests__/SettingsBackups.test.tsx`,
  `apps/web/components/analyzer/settings/__tests__/AccountDeleteDialog.test.tsx`):
  clears after a wipe or restore that finished or may have (no answer, a 500 or
  a 502), none after a 400, a 409, an offline attempt or a repair; after erasure
  (including the lost-answer path) before sign-out, after an erasure with an
  unknown outcome, and not after a rejected one.
- **Mounting** (`apps/web/app/AppShell.test.tsx`): the guard renders in both
  Clerk branches and never on the token or status routes.

## Review

Five independent read-only passes reviewed the slice. Each was a workflow of
read-only lenses and a critic that checked every finding against the code.

- **First pass (at `645e8518`; lenses: clearing, privacy, tests).**
  - Three medium findings: a first keep saved its rows before writing its note,
    so a sign-out during the save could leave them unfound; a browser that
    refused localStorage reads still kept a copy; and the clearing code sat in
    `/app`'s first-load JavaScript.
  - Nine low findings, including a shared try that skipped removing the note
    when storage was full, a data repair that cleared the copy, and test gaps.
  - `6bd21dd0` fixed them all: the note is written first and fails closed, the
    clearing code moved to its own on-demand module, and a sync reads again in
    memory after a clear.
- **Second pass (at `6bd21dd0`; lenses: privacy, sync, tests and bundle).**
  - One high finding: a probe in a second tab removed only the note when it
    found the copy missing, so a first keep running elsewhere could save rows
    under no note.
  - Eight low findings.
  - `31a09daa` made that removal a full clear and fixed the rest.
- **Third pass (at `31a09daa`; lenses: races, over-clearing, tests).**
  - Two medium findings: two accounts keeping at once could leave one account's
    rows under the other's note, and a probe could cancel a first keep that had
    not saved yet, or erase its choice.
  - Nine low findings, including deletes that were not durable.
  - `13aa4048` added the note to every write check, the owner's record to the
    creating upgrade, the delete before the mark and owed deletes.
  - The mutation run at `31a09daa` then showed that three sync tests asserted
    on mock calls after `vi.restoreAllMocks()`, which clears their history in
    Vitest 2; those were fixed there too.
- **Fourth pass (at `13aa4048`; lenses: mechanisms, tests).**
  - One medium finding: counting "offline when the failure arrives" as "never
    sent" kept the copy after a wipe whose answer was lost.
  - Six low findings.
  - `b2bb333a` dropped that rule, deleted a stale copy only while the sync still
    owned it, settled owed deletes on a successful open, and cleared the record
    a stopped keep left.
- **Fifth pass (at `b2bb333a`; lenses: logic, tests).**
  - No high or medium findings; the critic found nothing that blocks merge.
  - Six low findings, mostly about deletes that error, plus test gaps.
  - `2e123355`, `0022a49e` and `3c36f05d` made a keep drop whatever it did
    not write and clear again after any stopped run, and added the tests.

## Verification

Local checks ran at `3c36f05d`, on AC3's head `4e779f16`. The receipt is
`docs/handoff/validation/analysis-corpus-clearing/local-verification.json`.

- **Web.**
  - Whole-web types pass.
  - Configured lint reports 190 warnings and 0 errors. The changed
    files add no message, and the new files have none.
  - The UI lint passes.
  - All 1,045 web test files pass with one isolated worker at a time:
    10,245 cases, with 1 skipped by the suites themselves.
- **API.** Unchanged by AC4.
- **Mutation.** 59 of 59 deliberate regressions are killed in AC4's suites.
  Two earlier runs each left one survivor, and both were fixed before this run:
  - 40 of 41 at `31a09daa`: three assertions on mock calls ran after
    `vi.restoreAllMocks()`, which clears their history in Vitest 2.
  - 58 of 59 at `0022a49e`: nothing pinned the first-keep clear for a copy
    noted for nobody, which only a keep cancelled before its own drop depends
    on. `3c36f05d` adds that test.
- **Bundle.** Local production builds use the public flags CI sets.
  - `/app` is 240.6 kB of first-load JavaScript (gzip), against
    240.5 kB for the same local build of AC3.
  - Six other routes (`/`, `/app/game/[gameId]`, `/app/opponents`, `/builds`,
    `/community`, `/dock/[token]`) are 0.1 kB more, from the guard in the
    shared shell, and every other route is unchanged.
  - Local builds run 1.2 kB larger than CI's on `/app`: AC3's own CI build
    measured 239.3 kB against 240.5 kB locally. So CI is projected near 239.4
    of `/app`'s 240 kB and 189.5 of `/community`'s 190 kB, and its own build
    remains the gate.

## Limitations

- Dormant until AC5's gate calls `keepOnDevice`; nothing in production creates
  a copy before then.
- A local wipe or restore forgets the keep choice with the copy, so AC5's gate
  has to offer keeping again afterwards (an entry criterion for AC5). A wipe or
  restore done elsewhere keeps the choice: this device's next sync only
  replaces its copy.
- A copy on another device goes when that device signs out, or when its next
  sync sees the bumped corpus version.
- The clearing tests run on fake-indexeddb and jsdom. No real-browser check was
  done of the delete after `versionchange`, of how a blocked delete behaves when
  the page closes, of localStorage timing across tabs, or of Firefox and Safari.
- How quickly Clerk tells other tabs about a sign-out or a session switch was
  not measured, nor whether a brief signed-out state (a pending session task, a
  failed token refresh) can occur. If one does, the guard clears the owner's
  copy, and keeping history again needs the gate.
- A page load in another tab within the few milliseconds between a first
  keep's clear and that delete's success can cancel the keep; it tries again
  on that tab's next load.
- A copy that could be neither replaced nor dropped is deleted at the end of
  its sync even if another tab of the same account refreshed it meanwhile; the
  keep choice goes with it. This fails safe.
- No latency, request-reduction or savings claim.

## Remaining for the item

- **AC5, web:** the one-time history gate, the count and refresh footer, Backups
  & data local bytes and Clear controls, and Help.
