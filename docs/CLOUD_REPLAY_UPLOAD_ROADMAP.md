# Cloud-Side Replay Upload & Parser — Roadmap

Status: **proposal** · Owner: TBD · Target: post-Phase 17 web-app overhaul

## Why this exists

Today the cloud is a thin orchestrator: every `/v1/import/*` endpoint is a
shim that broadcasts a Socket.io request to the user's connected desktop
agent, and the agent does the actual replay parsing on the user's machine.
This works for power users who run the agent on their gaming PC, but
blocks four important flows:

1. **No-agent web-only sign-up.** A new user signs up on phone/tablet/work
   laptop and wants to drag in a `.SC2Replay` from a friend without ever
   installing the desktop client.
2. **Mobile sharing.** "Send me your replay" on Discord → drop into the
   web app on iOS Safari → analysed in 30 s.
3. **Multi-device parity.** A user with a mac laptop + Windows gaming PC
   shouldn't have to babysit which one the agent is running on.
4. **Community builds with reference replays.** Allow build-order authors
   to attach a single source replay without exposing their entire local
   library.

The deliverable: a real cloud-side ingestion pipeline — file upload →
storage → parser worker → existing `import_jobs` + `games` collections —
that lives next to the agent flow without replacing it.

## Architecture overview

```
 Browser ─── multipart upload ───► /v1/replay-uploads (Express, Node)
                                            │
                                            ▼
                              S3-compatible blob storage
                                  (per-user prefix)
                                            │
                                            ▼
                              Job queue (BullMQ on Redis)
                                            │
                                            ▼
                                Replay worker (Python+sc2reader,
                                long-running container)
                                            │
                                            ▼
                                Same DAL writes that the
                                desktop agent uses today:
                                games, builds, opponent_records,
                                import_jobs progress events
```

Why these choices:

- **S3-compatible storage** so we can run on Cloudflare R2 in prod and
  MinIO in dev without code changes; replay files are 100 KB–4 MB blobs
  with no special access pattern.
- **BullMQ on Redis.** The existing API already deploys Redis for
  Socket.io adapter + rate limit; reusing it avoids a new piece of
  infra. BullMQ's job UI is good enough for ops without writing one.
- **Python worker with `sc2reader`.** The parsing logic in
  `SC2Replay-Analyzer/core/replay_loader.py` is battle-tested and the
  current source of truth for what a "parsed replay" looks like in this
  codebase. Re-implementing in Node would be a large rewrite for no
  product benefit. Spin up a containerised Python worker that imports
  the existing `core/replay_loader.py` + `analytics/` modules.
- **Same DAL writes.** The schema is already defined and the agent path
  works — the cloud worker writes through the same Mongo collections so
  the rest of the app (analyzer pages, opponent dashboard, ML pipeline)
  stays untouched.

## Phases

### Phase A — File upload happy path · ~1 week

**Backend**

- New route `POST /v1/replay-uploads` accepting `multipart/form-data`,
  field name `file`, max 10 MB, MIME-allowlist `application/octet-stream`
  + extension `.SC2Replay`, content-type sniffing of the MPQ header
  (`MPQ\x1A`).
- Multer in-memory storage → stream straight to S3 with a server-side
  generated key `users/{userId}/inbox/{uuid}.SC2Replay`. Never trust
  client-supplied filenames in the storage path.
- Returns `{ uploadId, jobId }` and inserts an `import_jobs` row with
  `source: "cloud_upload"`, `status: "queued"`.
- Per-user rate limit: 30 uploads/10 min, 200/day; enforced via the
  existing rate-limit middleware (`apps/api/src/middleware/rateLimit`).
- Authn: existing Clerk `auth` middleware. No anonymous uploads.

**Storage**

- Buckets: `sc2tools-replay-inbox` (TTL 30 days, replays move to a
  permanent `processed/` prefix only after a successful parse + DB write
  — failed uploads age out).
- KMS-encrypted at rest. Object lock OFF — users can delete via GDPR
  export-and-delete flow.

**Frontend**

- Replace the no-op drop zone in `SettingsImportPanel` with a real
  upload component:
  - Multi-file picker; per-file progress; queue with concurrency 3.
  - Per-file states: `selected → uploading → parsing → done | error`.
  - Reuse the existing cyan `<ImportProgress>` bar; the `running` state
    is mapped from the worker's BullMQ job state via SSE/Socket.io.
- Surface errors with the existing `useToast`. Failed uploads
  retain a "retry" button.

- clean production quality frontend UI easy to use for non technical users, sticking with the same UI structure the rest of the program follows. production quality code no MOCK DATA. fully properly wired.

**Tests**

- `__tests__/imports/upload.spec.js` — multer round-trip, size + MIME
  guards, rate limiting.
- Browser e2e (Playwright) — drop a fixture .SC2Replay, assert the
  resulting `import_jobs` row + `games` row exist.

### Phase B — Python worker container · ~1 week

- New service `apps/replay-worker/` (Python 3.12, BullMQ-compatible
  consumer via `python-bullmq` or `celery+redis-bullmq` bridge).
- Container ships:
  - `sc2reader` (pinned to the version the desktop agent uses today)
  - The existing `SC2Replay-Analyzer/core/replay_loader.py`,
    `analytics/`, `detectors/` modules — moved to a shared package
    `packages/replay-core/` so both the agent and the worker depend on
    the same code.
- Worker loop:
  1. Reserve job from `replay-parse` queue.
  2. Stream blob from S3 to a temp file.
  3. Call `process_replay_task(temp_path, user_context)` — same fn the
     agent calls.
  4. Write the parsed `Game` doc + derived collections via the DAL.
  5. Mark `import_jobs` done (or failed with `errorBreakdown`).
  6. Move blob to `processed/` or delete on error.
- Resource budget: each parse is ~50–800 ms CPU + 80 MB RAM. Start with
  a single worker container at 2 vCPU / 1 GB RAM and a max concurrency
  of 4. BullMQ's per-queue rate limiter throttles burst pressure.
- Health: `/healthz` (Python http.server); Render auto-restart on crash.
  Telemetry to Sentry via `sentry-sdk` (matching the API + web app).

### Phase C — Per-game progress + UX parity · ~3 days

- The agent path already publishes per-game progress via
  `import:progress` Socket.io events. The cloud worker emits the same
  shape so the existing `SettingsImportPanel` progress UI works for
  both flows without a branch.
- Add `source` badge to job rows: `desktop agent` vs. `cloud upload`.
- Drop zone copy on the Import panel updates: top-line stays "Drop
  replays or click to browse"; secondary line becomes "Parsed in the
  cloud — no agent required."

### Phase D — Hardening · ~1 week

**Validation & abuse**

- Reject MPQ files larger than 10 MB before write (sc2reader will
  itself OOM on degenerate files).
- Hash check (`sha256`): if the same hash already exists for this user,
  return the cached result and skip the parse.
- Per-IP upload cap (anonymous middleware; signed-in users hit the
  per-user cap above).
- Replay date sanity check: reject anything claiming `< 2010` or
  `> now + 1 day`.

**Storage hygiene**

- Lifecycle rule: `inbox/` deletes after 30 days, `processed/` deletes
  90 days after the user's account is deleted (GDPR).
- Backup excluded — replay blobs are reproducible from the user's
  desktop and don't need to live in Atlas backups.

**Security**

- Pre-signed POST (S3 presigned URL) so the API never streams the file
  through itself; saves bandwidth and reduces attack surface. Worth
  doing only if upload volume justifies — defer until Phase A is live.
- File-type sniffing in the worker (re-validate the MPQ magic) so a
  malicious upload that bypasses the route handler still bounces.
- The Python worker runs in a non-root container with read-only root
  filesystem and a small `/tmp` tmpfs. sc2reader has no documented RCE
  but the defensive posture is cheap.

**Observability**

- BullMQ Bull Board UI behind admin-only Clerk role.
- Sentry tags: `feature: cloud-upload`, `worker: replay-parse`.
- Mongo index on `import_jobs.source + status + startedAt` to drive
  ops dashboards.

### Phase E — Web-only onboarding · ~3 days

Once the upload pipeline is stable:

- Onboarding wizard gets a third path: "Upload a few replays now" — for
  users who don't want to install the agent yet.
- After 5+ uploads we nudge them to install the agent for live syncing.
- Marketing copy on landing-page hero: "Drag a replay anywhere — works
  without installing anything."

### Phase F — Community builds w/ source replay · ~3 days

- Build authors attach a single reference replay when publishing a
  build. Stored in `users/{authorId}/community-builds/{buildSlug}.SC2Replay`,
  publicly downloadable via a signed-URL endpoint.
- Reuses the same upload route + storage with a `purpose: "community"`
  flag; the worker indexes the build but doesn't write to the author's
  game library.

## Migration & feature-flag plan

1. Ship Phases A–C behind a server flag `FEATURE_CLOUD_UPLOAD=false`.
2. Soft-launch to internal team + ~20 alpha users via a Clerk role
   (`flags:cloud_upload`).
3. Monitor parse failure rate, p95 parse latency, S3 cost per parse for
   2 weeks.
4. Flip default-on, leave the flag in place for fast rollback.
5. The desktop agent keeps working unchanged — the two paths coexist
   and the existing `import_jobs.source` field disambiguates origin.

## Out of scope

- A cloud-side **agent emulator** that walks user folders. The cloud
  cannot read user filesystems; this is by design.
- Real-time replay-as-it-happens streaming. Replays only exist after a
  game ends — this stays the agent's job because it has WebSocket
  contact with the running SC2 client.
- Re-parsing all historical replays in the cloud. The desktop agent has
  already imported them; re-doing the work would burn S3 + CPU for no
  product gain. New uploads only.
- **OBS overlay state** stays in the existing realtime path — overlay
  tokens + Socket.io. The cloud-upload pipeline is purely for game
  ingestion.

## Open questions

- **R2 vs S3** for storage backend — same code, but R2 has free egress
  which matters for the community-builds download flow. Defer to
  whoever picks up Phase A.
- **Per-user storage cap.** 200MB - **Zip-of-replays import.** Common pattern: "here's my replay folder
  zipped." Worth supporting in Phase A or pushing to Phase E? My read:
  Phase A — the worker can unzip and fan-out into N jobs with the same
  `import_jobs` parent.

## Pre-work that exists today

- `apps/api/src/services/import.js` already has the job lifecycle
  state machine (`scanning → running → done | cancelled | error`) and
  `reportProgress` ingestion path. The cloud worker just needs to call
  the same `reportProgress(userId, jobId, payload)` shape.
- `apps/web/components/analyzer/settings/SettingsImportPanel.tsx`
  already has the cyan `<ImportProgress>` bar, status badge with icons,
  cancel-confirm dialog, and history list. The drop zone is a stub
  ready to be wired.
- `SC2Replay-Analyzer/core/replay_loader.py` has the canonical parsing
  pipeline. Phase B's biggest task is packaging it as a shared module
  rather than rewriting it.

The total greenfield work is mostly: the upload route, S3 wiring, BullMQ
wiring, and the worker container. Everything downstream of "we have a
parsed Game object" already exists.
