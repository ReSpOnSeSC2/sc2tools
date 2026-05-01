# Release notes draft — v0.2.0 (2026-05-01)

> Drop this block into `CHANGELOG.md` in place of the current `## [Unreleased]`
> heading (rename it to `## [0.2.0] - 2026-05-01` and start a fresh, empty
> `## [Unreleased]` section above it). Same body works as the GitHub Release
> description — paste it into the release form when you cut the tag.

---

## [0.2.0] - 2026-05-01

First feature release after the v0.1.0 installer baseline. Headlines: voice
readout of pre-game scouting reports, a hardened durability layer that closes
out the April 30 file-truncation incident, and substantial UI rewrites across
the analyzer's Strategies / Maps / Trends / Opponents tabs.

### Added

- **Voice readout (Settings + overlay).** Optional TTS narration of the
  pre-game scouting card — opponent name, race, MMR, cheese flag, favorite
  opener, your best historical answer. New Settings sub-page
  `voice-settings.html` exposes voice, rate, volume, and per-trigger toggles
  (game start / win / loss / streak). Audio is piped through the default
  output device via the same overlay event bus the visual widgets use, so
  enabling it doesn't require a second integration.
  (`reveal-sc2-opponent-main/stream-overlay-backend/public/voice-settings.html`,
  `public/analyzer/components/settings-voice.jsx`,
  commit `78bc7d0`)
- **Opponent reconcile service.** Backend service
  (`services/opponent_reconcile.js`) consolidates opponent records across
  `MyOpponentHistory.json`, `meta_database.json`, and live SC2Pulse lookups,
  resolving name-collision and rename cases without losing W-L history.
  Backs the salvage logic that surfaces real W-L when Black Book misses.
- **Atomic-write CI guard.** `scripts/check_atomic_writes.py` greps the
  production trees for `os.replace` without a preceding `os.fsync` (Python)
  and bare `fs.writeFileSync` (Node). Self-tests against synthetic
  bug + fix; surfaced and fixed two violations in `analytics/spatial.py`
  and `analytics/win_probability.py`. Wired into pre-commit / CI as a
  hard gate — a future durability regression now fails the build.
  (commit `f5ee526`)
- **Test coverage for durability + identity resolution.** Five new core
  test files: `test_file_lock.py`, `test_pulse_resolver.py`,
  `test_data_store_find_by_name.py`, `test_data_store_merge_unknown.py`,
  `test_merge_unknown_pulse_ids.py`. ~1.4 K lines of asserts.
- **Windows installer (NSIS).** `packaging/installer.nsi` plus orchestrator
  `packaging/build-installer.ps1` produce
  `dist/SC2Tools-Setup-<version>.exe`. Bundles embeddable Python 3.12,
  pre-installs every Python and Node.js dependency at build time so the
  user installer needs no PyPI / npm registry access at install time,
  defaults to a per-user install at `%LOCALAPPDATA%\Programs\SC2Tools`,
  detects Node.js 18+ on PATH, registers an HKCU uninstaller, and drops
  Start Menu + Desktop shortcuts pointing at the Stage 3 launcher.
- **Release CI.** `.github/workflows/release.yml` builds the installer on
  tag push `v*.*.*` and on manual dispatch, runs the silent-install smoke
  test, and attaches the `.exe` plus `.sha256` sidecar to the GitHub
  Release.
- **Auto-update (Stage 12.1).** New `routes/version.js` exposes
  `GET /api/version` (1-hour cached lookup against the GitHub Releases API)
  and `POST /api/update/start` (localhost-only, same-origin, single-use
  nonce). The SPA gets an `<UpdateBanner>` at the top of every page that
  surfaces newer releases, and the existing Settings -> About "Check for
  updates" button is wired to the same endpoint. Helper
  `packaging/silent-update.ps1` waits for the backend to exit, downloads
  the new `.exe` to `%TEMP%`, verifies the published SHA256, runs the
  installer with `/S`, and relaunches via the install location stored in
  `HKCU\Software\SC2Tools`.
- **Version sync guard.** `.github/workflows/version-check.yml` asserts
  that `stream-overlay-backend/package.json` (canonical),
  `SC2Replay-Analyzer/__init__.py` `__version__`, and the SPA's
  `SETTINGS_VERSION` literal all agree on every PR. Drift breaks the
  build instead of shipping a confused About panel.
- **ADR 0014** documents the NSIS + bundled-Python decision and the
  per-user install path choice.
- **ADR 0015** records the auto-update architecture: version source of
  truth, cache + nonce + spawn-and-exit pattern, and the three-layer
  guard on `/api/update/start`.
- **ADR 0016 + Truncation Audit** (`docs/adr/0016-atomic-file-writes.md`,
  `docs/TRUNCATION_AUDIT.md`) — the rule, the byte-level evidence, and
  P1/P2/P3 follow-ups.
- **README + embedded screenshots.** Production-quality README with the
  full onboarding walkthrough, dashboard / My Builds / Opponents tour,
  Settings deep-dive, stream-overlay widget reference, three Mermaid
  diagrams, and seven embedded screenshots under `docs/images/`.

### Changed

- **Major UI rewrites in the analyzer SPA** — Strategies (+728 lines),
  Maps / Matchups (+551), Trends (+296), Opponents (+8). All four tabs
  now share a common filter-bar contract and the same color-graded
  win-rate bars. Per-row deep-dive modals were added to Strategies and
  Maps.
- **Pinned dependencies.** Every Python and Node.js dependency now uses
  an exact version pin. `SC2Replay-Analyzer/requirements.txt` and
  `reveal-sc2-opponent-main/requirements.txt` use `==`; the Express
  backend's `package.json` mirrors the resolved versions from
  `package-lock.json`. Prerequisite for reproducible installer builds.
- **Three duplicated `atomicWriteJson` impls collapsed** into thin shims
  around `lib/atomic-fs.js` (`_atomicWriteJsonSync` in `index.js`,
  `analyzer.js::persistMetaDb`, `routes/settings.js::atomicWriteJson` +
  `syncCharacterIdsFile`). Exported names preserved for back-compat.
  (commit `9ee7d2a`)
- **Python long-tail writers routed through `core.atomic_io`** —
  `core/error_logger.py` save/append, `gui/analyzer_app.py` CSV export +
  debug report, `core/custom_builds.py` binary backup,
  `core/data_store.py` backup marker. New `atomic_write_bytes` helper
  added for the binary case. (commit `25152c5`)

### Fixed

- **Scouting widget now scopes every stat to the live matchup.** The pre-game
  scouting card (and its three back-compat cousins — `rematch`,
  `favoriteOpening`, `rivalAlert`, `cheeseHistory`) was reporting lifetime
  numbers regardless of which race-pairing the user was about to play, so a
  player whose lifetime record vs an opponent was 7-1 across PvT could see a
  reassuring "5W-3L · 62%" right before stepping into PvZ where their actual
  record was 0-1. Six detection functions now accept `myRace` / `oppRace`
  and filter accordingly: `buildRematchSummary`, `_recordFromMetaDb`,
  `detectFavoriteOpening`, `detectRival`, `detectCheeseHistory`,
  `buildRecentGamesForOpponent`. New helpers `_matchupKey`, `_raceLetter`,
  `_gameMatchesMatchupHistory`, `_buildAndGameMatchMatchup` centralize the
  filter logic — history rows trust the `Matchup` field that `flattenGames`
  stamps; meta-DB rows cross-check `g.opp_race` against the build-name
  prefix (`PvZ - Phoenix into Robo`) so both halves of the matchup must
  agree. Payload now carries a `matchup: { my, opp, key, label }` block
  and a per-stat `matchup` echo so the widget can render a "· PvZ" tag in
  the header and degrade copy ("first PvZ meeting" instead of just
  "first meeting") when no in-matchup history exists.
  (`stream-overlay-backend/index.js`,
  `stream-overlay-backend/public/_ov/widgets/scouting.html`,
  `stream-overlay-backend/public/_ov/app.js`,
  `stream-overlay-backend/public/_ov/styles.css`)
- **Eliminate the file-truncation incident root cause.** Production
  data files (`meta_database.json`, `MyOpponentHistory.json`,
  `config.json`, `custom_builds.json`, `community_sync_queue.json`,
  `import_state.json`, `session.state.json`,
  `stream-overlay-backend/public/_ov/design-tokens.json`,
  `package.json`) and their tracked siblings were being silently
  truncated by writers that did `tempfile + os.replace` /
  `tempfile + fs.renameSync` without an intervening `flush + fsync`.
  Three NTFS-specific failure modes (lazy-writer truncation,
  indent-line truncation, null-byte padding) were observed in
  `data/*.broken-*` over a 96-hour window. Fixed in five phases:
  (1) `flush + fsync` added to `scripts/macro_cli.py` and
  `scripts/buildorder_cli.py` `_save_db`; (2) Python long-tail writers
  routed through `core.atomic_io.atomic_write_{json,text,bytes}`;
  (3) the three duplicated Node atomic-write impls collapsed to thin
  delegators against `lib/atomic-fs.js`; (4) `analytics/spatial.py`
  cache and `analytics/win_probability.py` model save paths picked up
  `flush + fsync`; (5) `scripts/check_atomic_writes.py` added as a
  pre-commit / CI guard. Three live data files (96 MB, 2.4 MB, 1.4 KB)
  recovered from the cleanest snapshot — `MyOpponentHistory.json`
  regained ~2,000 opponent records that the truncation had eaten;
  five secondary tracked JSONs restored from HEAD. See
  `docs/adr/0016-atomic-file-writes.md` and
  `docs/TRUNCATION_AUDIT.md`.
- **`_save_db` tmp now fsyncs before `os.replace`.** `macro_cli.py` and
  `buildorder_cli.py` were the original NTFS-lazy-writer offender —
  the rename published metadata before data blocks reached disk, so a
  kill / sleep / AV-lock in the window left the file truncated or
  null-padded. Both writers now `flush() + os.fsync()` before
  `os.replace`. (commit `2e8780d`)
- **Opponent widget shows real W-L when Black Book misses.** The merged
  opponent card was rendering 'first meeting' for opponents the user had
  played before whenever `MyOpponentHistory.json` was truncated mid-write,
  while the scouting card looked correct because its recent-games row reads
  `meta_database.json` directly. Backend now: (1) replaces the indent-
  specific `_attemptHistoryRepair` with a `_salvageJsonObject` salvage that
  walks `},\n` boundaries (handles both modern 4-space and legacy 15-space
  PowerShell indent), (2) wraps `readMetaDb` with the same salvage so the
  live overlay path keeps producing real numbers when meta_database is
  partially written, (3) falls back to a meta-DB-derived W-L when the
  Black Book has no entry for the opponent so opponentDetected and
  scoutingReport always agree on the record, and (4) resets the
  `lastOpponentText` dedup anchor when `opponent.txt` is cleared at
  game-end so a same-text rewrite next game still triggers a fresh emit.
  (`stream-overlay-backend/index.js`)
- **PowerShell `Write-FileAtomic` now fsyncs before rename.** The opponent
  scanner's atomic-write helper had `[System.IO.File]::WriteAllText`
  followed immediately by `Move-Item` — on Windows NTFS that returns once
  the bytes hit the OS write cache, NOT once they're durable on disk. A
  kill / sleep / AV between rename and lazy-flush left
  `MyOpponentHistory.json` truncated. The helper now opens the temp file
  via `FileStream`, writes the bytes, calls `Flush($true)`
  (FlushFileBuffers, the Win32 fsync) before closing, and only THEN
  renames. Mirrors the contract used by `core/atomic_io.py` and
  `analyzer.js::persistMetaDb`. (`Reveal-Sc2Opponent.ps1`)
- **PowerShell scanner now writes to `data/MyOpponentHistory.json`.** It
  was writing to the legacy project-root path while every other component
  reads `data/`, which let the two files drift (recently played opponents
  wouldn't show up on the overlay until the next Python writer ran). The
  scanner now resolves `$HistoryFilePath` to `data/MyOpponentHistory.json`
  (with a fallback to the legacy path if `data/` doesn't exist yet).
- **One-shot data repair.** Salvaged and rewrote
  `data/MyOpponentHistory.json` (3168 entries clean, plus 10 unique
  entries merged in from the legacy copy = 3178 total, including the
  `FIIClicK#670` record that triggered this debug session). Salvaged and
  rewrote `data/meta_database.json` (56 builds, 7921 games). All three
  files now parse cleanly via strict `JSON.parse`; the salvage fallback
  in the readers stays in place as defense-in-depth. Originals preserved
  as `.pre-repair-<ts>.bak`.
- **Recover live files after the truncation incident.**
  `MyOpponentHistory` regained ~2000 lost opponent records (1148 ->
  3152). `meta_database`, `config`, `package.json`, `design-tokens`,
  `import_state`, `sync_queue`, `migration-report`, `session.state` all
  parse cleanly. Forensic `*.live-broken-pre-recovery-20260430T205*`
  siblings preserved alongside but not committed.
  (commit `564d30d`)

### Notes

- This is the first installer release tagged after the v0.1.0 baseline.
  The pre-truncation-fix `dist/SC2Tools-Setup-512e301.exe` should be
  removed from the release page — users should not be served code that
  predates the durability work.
- Users on existing manual installs at `C:\SC2TOOLS\` are not migrated
  by the installer; they can either continue running from there or
  reinstall via the new `.exe`.
- Auto-update is opt-in: the SPA's `<UpdateBanner>` surfaces newer
  releases but does not install anything without user consent.
- Ten of the seventeen commits in this release were committed with the
  message `"updates"`. The release notes above were reconstructed from
  the diff and the seven well-described commits. Future releases should
  prefer descriptive commit messages so the changelog isn't a forensic
  exercise.

---

# How to push this release to GitHub

A clean release has six steps. Run them from a PowerShell window in the
repo root (`C:\SC2TOOLS`).

## 0. Pre-flight (once)

```powershell
# confirm you're on the branch you want to release from
git status
git branch --show-current

# pull anything you don't have locally
git fetch --all --tags
git pull
```

You should have a clean working tree (`git status` shows nothing) and be on
your main branch (likely `main` or `master`) before tagging. If `git status`
shows uncommitted changes from today's README work, commit those first:

```powershell
git add README.md docs/images/ RELEASE-v0.2.0-NOTES.md
git commit -m "docs: production-quality README + embedded screenshots"
```

## 1. Update CHANGELOG.md

Open `CHANGELOG.md`, find the `## [Unreleased]` heading, rename it to
`## [0.2.0] - 2026-05-01`, paste any missing bullets from the draft above
into the right `Added / Changed / Fixed` sub-sections (the existing
`[Unreleased]` already has most of it — voice readout, opponent reconcile,
test coverage, UI rewrites, and the README mention are the new additions),
and put a fresh empty `## [Unreleased]` section above it for the next
cycle.

```powershell
# after editing
git add CHANGELOG.md
git commit -m "chore: cut v0.2.0"
git push origin main
```

## 2. Bump the version numbers (the version-sync guard will fail otherwise)

Three files have to agree:

```powershell
# 1) Express backend (canonical)
# Edit reveal-sc2-opponent-main/stream-overlay-backend/package.json
#   "version": "0.2.0"

# 2) Python package
# Edit SC2Replay-Analyzer/__init__.py
#   __version__ = "0.2.0"

# 3) SPA literal
# Search the analyzer source for SETTINGS_VERSION and bump it to "0.2.0"

git add reveal-sc2-opponent-main/stream-overlay-backend/package.json `
        SC2Replay-Analyzer/__init__.py `
        reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/
git commit -m "chore: bump version to 0.2.0"
git push origin main
```

## 3. Tag the release

The release CI workflow triggers on tag push `v*.*.*`. Use an annotated
tag (`-a`) so the message shows up on the GitHub release page.

```powershell
git tag -a v0.2.0 -m "v0.2.0 - voice readout + durability hardening"
git push origin v0.2.0
```

That single `git push origin v0.2.0` is what kicks the release pipeline.
GitHub Actions will:

1. Check out the `v0.2.0` tag.
2. Run `packaging/build-installer.ps1` to produce
   `dist/SC2Tools-Setup-<commit-hash>.exe` and its `.sha256`.
3. Run the silent-install smoke test on a clean Windows runner.
4. Create a draft GitHub Release named `v0.2.0` and attach both files.

Watch it run at:
`https://github.com/<your-user>/<your-repo>/actions`

## 4. Publish the GitHub Release

Once the workflow finishes, go to:
`https://github.com/<your-user>/<your-repo>/releases`

The draft release will be sitting there. Click **Edit**, then:

- **Title:** `v0.2.0 - Voice readout + durability hardening`
- **Body:** paste the v0.2.0 section from `CHANGELOG.md` (everything from
  the heading through the Notes section).
- **Set as latest release:** ticked.
- Confirm the `.exe` and `.sha256` are attached.
- Click **Publish release**.

The auto-updater on installed clients will pick this up within an hour
(the `/api/version` cache TTL).

## 5. Retire the v0.1.0 installer

Go to the v0.1.0 release page → Edit → either delete the `.exe` /
`.sha256` assets or mark the whole release as **pre-release** so the
auto-updater never recommends it.

## 6. If something goes wrong — rollback

A pushed tag can be deleted both locally and remotely:

```powershell
git tag -d v0.2.0                    # local
git push origin :refs/tags/v0.2.0    # remote
```

Then fix whatever was wrong, re-tag, and re-push.

> **Tip — use a release branch for high-risk releases.** For really big
> releases, cut a `release/v0.2.0` branch off `main`, push the tag from
> *that* branch, and only fast-forward `main` once the release CI is
> green. Keeps `main` free of half-published versions if the build fails.

---

## TL;DR — copy/paste sequence

```powershell
# 1. clean slate
git status                                         # should be clean
git fetch --all --tags
git pull

# 2. cut the changelog + bump versions (manual edit)
git add CHANGELOG.md `
        reveal-sc2-opponent-main/stream-overlay-backend/package.json `
        SC2Replay-Analyzer/__init__.py
git commit -m "chore: cut v0.2.0"
git push origin main

# 3. tag + push -> CI builds + drafts the release
git tag -a v0.2.0 -m "v0.2.0 - voice readout + durability hardening"
git push origin v0.2.0

# 4. publish the draft release on GitHub manually after CI passes
```
