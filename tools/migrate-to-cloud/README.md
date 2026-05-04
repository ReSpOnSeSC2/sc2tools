# `migrate-to-cloud`

One-shot migrator that lifts a local SC2 Tools install into a cloud
SaaS account. Reads the JSON files the local app maintains in its
`data/` folder and POSTs them to the cloud API.

```
local install (data/*.json)        cloud SaaS (sc2tools_saas)
┌──────────────────────────┐       ┌───────────────────────────┐
│ MyOpponentHistory.json   │  ───► │ opponents collection       │
│ meta_database.json       │  ───► │ games collection           │
│ custom_builds.json       │  ───► │ custom_builds collection   │
│ profile.json             │  ───► │ profiles collection (/me)  │
└──────────────────────────┘       └───────────────────────────┘
```

Idempotent — safe to re-run after partial failures. Records key on
`{userId, gameId}` and `{userId, pulseId}` so duplicates are impossible.

---

## Install

The script has zero third-party dependencies. With Node 20+ already on
the box you can run it directly:

```bash
cd tools/migrate-to-cloud
node bin/migrate-to-cloud.js --help
```

If you'd rather have a global `sc2tools-migrate` binary:

```bash
npm install --global ./tools/migrate-to-cloud
sc2tools-migrate --help
```

---

## Usage

The migrator needs three things:

1. **A path to your local app's data folder.** The default is
   `reveal-sc2-opponent-main/data` relative to the SC2 Tools repo
   root. Override with `--local <path>`.
2. **The cloud API base URL.** Default: `https://api.sc2tools.app`.
   Override with `--api <url>` (e.g. `--api http://localhost:8080` for
   a local dev API).
3. **A Clerk personal token** so the API can identify which account
   to write into. Get one from
   [`https://dashboard.clerk.com/`](https://dashboard.clerk.com/) →
   **Users** → click your user → **Sessions** → **Create session
   token** (or paste an existing one). The script prompts for it on
   stdin if you don't pass `--token`.

### Dry run (recommended first)

```bash
sc2tools-migrate --dry-run
```

Reads everything, prints a summary of what *would* be written, and
exits without contacting the cloud. Use this to sanity-check counts
before committing.

### Full run

```bash
sc2tools-migrate \
  --local reveal-sc2-opponent-main/data \
  --api  https://api.sc2tools.app \
  --token clerk_session_xyz...
```

Output is a stream of `kind=games batch=4 ok=100 skipped=0 errors=0`
lines so you can tell a 30-minute import isn't stuck.

### Reconcile

After a real run:

```bash
sc2tools-migrate --reconcile-only \
  --api https://api.sc2tools.app \
  --token clerk_session_xyz...
```

Hits `/v1/games?limit=1` and `/v1/opponents?limit=1` to count cloud
records, then compares against the local file totals. Prints a
side-by-side diff.

---

## Flags

| Flag                  | Purpose                                                    | Default                                  |
| --------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `--local <path>`      | Local app's `data/` folder                                 | `reveal-sc2-opponent-main/data`          |
| `--api <url>`         | Cloud API base                                             | `https://api.sc2tools.app`               |
| `--token <token>`     | Clerk personal/session token                               | prompted on stdin                        |
| `--dry-run`           | Read + transform; do not write                             | off                                      |
| `--reconcile-only`    | Skip uploads, only print local-vs-cloud counts             | off                                      |
| `--batch <n>`         | Games per POST                                             | `25`                                     |
| `--only <kinds>`      | Comma list of `games,opponents,builds,profile`             | all                                      |
| `--verbose`           | Per-record trace                                           | off                                      |
| `--help`              | Show usage                                                 |                                          |

---

## What gets written

| Local file                       | Cloud target                | How                                          |
| -------------------------------- | --------------------------- | -------------------------------------------- |
| `profile.json`                   | `PUT /v1/me`                | one PUT, fills the user's profile fields     |
| `MyOpponentHistory.json`         | `POST /v1/games` (batched)  | one game per `Matchups[*].Games[*]` entry    |
| `meta_database.json`             | `POST /v1/games` (merge)    | enriches games above with `myBuild`, `buildLog`, `macroScore` when matchable on `(date, opponent, map)` |
| `custom_builds.json`             | `PUT /v1/custom-builds/<slug>` | one PUT per build                          |

Note that the cloud API auto-creates `opponents` records as a
side-effect of `POST /v1/games`, so the migrator never writes
opponents directly — it just guarantees every game record carries the
opponent fields the API needs to do the upsert.

---

## Resume / dedupe

- **Games** are keyed by deterministic `gameId` (a hash of
  `pulseId|date|map|durationSec` for entries from `MyOpponentHistory.json`,
  or the existing `id` field for entries from `meta_database.json`).
  Re-running upserts the same `_id` rather than duplicating.
- **Opponents** are keyed by `(userId, pulseId)` server-side. Re-runs
  are no-ops once stats converge.
- **Builds** are keyed by `(userId, slug)`. Re-runs upsert.
- **Profile** is a single PUT; re-runs overwrite, which is fine.

If the script crashes mid-run, just re-run it. Already-written records
are skipped server-side; only the rest are uploaded.

---

## Troubleshooting

**`401 Unauthorized` on every POST** — the Clerk token is wrong, expired,
or for a different application than your API expects. Generate a new
session token from the Clerk dashboard.

**`429 Too Many Requests`** — the API enforces 120 req/min/user by
default. The script auto-backs-off on 429; if you hit it constantly,
lower `--batch`.

**Counts don't match after reconcile** — check the
`tools/migrate-to-cloud/migration-report.json` file the script writes
on completion. It lists every record that was rejected and why.

---

## Cross-references

- [`docs/CLOUD_SCHEMA.md`](../../docs/CLOUD_SCHEMA.md) — cloud
  collection shapes the script writes into
- [`apps/api/src/validation/gameRecord.js`](../../apps/api/src/validation/gameRecord.js)
  — the schema each game must pass
- [`docs/cloud/REMAINING_WORK.md`](../../docs/cloud/REMAINING_WORK.md) —
  the migration script's place in the roadmap
