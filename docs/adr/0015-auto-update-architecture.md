# ADR 0015 -- Auto-update architecture (Stage 12.1)

Status: Accepted
Date: 2026-04-30
Owner: packaging / release

## Context

Stage 12 shipped a Windows installer. Stage 12.1 adds the loop that
keeps users on it: the SPA notices when GitHub has a newer release,
shows a banner, and one click later the user is on the new version
without leaving the page. The brief specified the user-visible flow
(banner, "Update now", silent install, restart) and four touch points
(version stamp, /api/version endpoint, banner UI, helper script).
This ADR records the decisions that filled in the rest.

## Decisions

### 1. Single source of truth for the version: package.json

`stream-overlay-backend/package.json` holds the canonical version
string. The two other places that need a version literal read or copy
that:

- `SC2Replay-Analyzer/__init__.py` reads `package.json` at import time
  via `_read_canonical_version()`. If the file is missing or malformed
  the module falls back to a `0.0.0+unknown` sentinel and CI rejects it.
- `public/analyzer/components/settings-foundation.jsx` keeps a
  literal `SETTINGS_VERSION` for offline display when the SPA cannot
  reach the backend. The CI guard at `.github/workflows/version-check.yml`
  asserts the literal matches `package.json` on every PR.

Alternatives considered: `__init__.py` canonical (rejected -- our
release.yml already extracts the tag into `package.json` automatically),
or a shared `VERSION` file at the repo root (rejected -- adds another
file to keep aligned without buying anything over the package.json
+ CI check pair).

### 2. /api/version: cached, anonymous, GH releases as upstream

The `/api/version` route in `stream-overlay-backend/routes/version.js`:

- Hits `GET https://api.github.com/repos/<owner>/<repo>/releases/latest`
  anonymously (the request header sets `User-Agent: sc2tools-update-check`
  so GitHub doesn't 403 us). The repo defaults to
  `ReSpOnSeSC2/sc2tools` and is overridable via constructor option for
  tests.
- Caches the response in-memory for one hour. A user mashing the
  Settings → About "Check for updates" button cannot fan out to the
  GitHub API.
- Returns `{ current, latest, updateAvailable, releaseUrl,
  releaseNotes, exeUrl, sha256Url, checkedAt, updateNonce }`. The
  installer asset URLs are pulled from the release's `assets` array by
  filename suffix (`.exe` and `.sha256`) so a release that renames the
  installer breaks the route loud rather than silently downloading
  the wrong file.

### 3. Three-layer guard on POST /api/update/start

The "Update now" button POSTs to `/api/update/start`. That handler
spawns a PowerShell script that downloads + runs an installer -- the
single most dangerous endpoint in the suite. We layer three checks:

1. **Localhost only.** `req.ip` must be `127.0.0.1`, `::1`, or
   `::ffff:127.0.0.1`. The Express backend is bound to localhost in
   normal operation; this check turns "not exposed by default" into
   "refuses anyway if exposed by accident".
2. **Same-origin.** The `Origin` header's host must match `Host`.
   A malicious site at `evil.com` cannot trigger an update from a
   browser the user happens to have open against
   `http://localhost:5050/analyzer/`.
3. **Single-use nonce.** Every `/api/version` response carries a
   16-byte hex nonce with a 5-minute TTL. `/api/update/start`
   requires the nonce in the body and consumes it on first use.
   Even if a CSRF gets past the first two layers it would need a
   live nonce, which it can't read across origins.

Alternatives considered: native confirmation dialog (tkinter) before
spawning the helper. Rejected because the SPA's "Update now" click
is itself the confirmation -- a second native dialog adds friction
without a clear threat model the three checks above don't already
cover.

### 4. Spawn-and-exit pattern for the helper

`silent-update.ps1` is spawned detached from the Express backend; the
backend then schedules `process.exit(0)` after a 5-second grace
period. The helper waits up to 30 seconds for the parent PID to die
before running the installer. Why this dance:

- The installer needs to overwrite files in `python\` and
  `reveal-sc2-opponent-main\stream-overlay-backend\node_modules\`
  that the running backend has open. We have to exit before the
  installer touches them.
- Exiting *immediately* after spawn would race the HTTP 202 response
  back to the SPA -- the user would see a network error before the
  banner could update.
- Detached + 5s grace lets the response complete cleanly and gives
  the helper time to scrape the parent PID before it disappears.

### 5. SHA256 verification at download time, not just build time

`silent-update.ps1` downloads the `.sha256` sidecar published by
`build-installer.ps1`, parses the expected hash, and verifies the
downloaded `.exe` matches before running anything. The hash is
embedded in a sidecar (not a query param or response header) so a
GitHub Releases mirror or proxy can't substitute the body without
also forging the sidecar. A tampered `.exe` aborts the helper before
any process is spawned.

## Consequences

- The auto-update path **only** works after at least one GitHub
  Release exists with the convention `SC2Tools-Setup-<version>.exe`
  + matching `.sha256`. The release.yml workflow shipped in Stage 12
  produces both, so this is automatic on tag push.
- A network outage at update-check time renders a friendly fallback
  ("Could not reach the update service") instead of a hard error.
  The banner simply doesn't appear when `latest === current` or the
  fetch fails.
- Future migration to a signed installer (Authenticode) only requires
  bumping the helper to also call `Get-AuthenticodeSignature` after
  the SHA256 check. The current SHA256 channel coexists with that.

## Rollback plan

If a release breaks the auto-update flow in the field:

1. Mark the offending GitHub Release as a draft so the public
   download URL disappears. The SPA falls through to "you're on the
   latest version" because the latest non-draft tag is older.
2. Push a hotfix tag. The standard release flow rebuilds and
   republishes.
3. Users who already pulled the broken update can reinstall by
   downloading the previous good `.exe` directly from the Releases
   page and double-clicking; the installer overwrites in place.

## See also

- `reveal-sc2-opponent-main/stream-overlay-backend/routes/version.js`
- `packaging/silent-update.ps1`
- `reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html` (`UpdateBanner`)
- `.github/workflows/version-check.yml`
- `SC2Replay-Analyzer/__init__.py`
- ADR 0014 -- Windows installer (Stage 12)
