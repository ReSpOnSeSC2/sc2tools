# Wave 4 desktop stream-title automation checkpoint

Isolated branch `codex/wave4-stream-titles` at
`C:/SC2TOOLS/.worktrees/wave4-stream-titles`, stacked on frozen GUI preview #694
`4c2e400d0b4430fa75ff1a81dba3ac07f3f046e1`. Root explicitly cleared ownership of
`agent-stream-automation` after the GUI pack. Read its complete final-plan
specification, augments (none), howto and dependencies (none).

## Required scope

- Streams title accepts `{mmr} {league} {record} {wins} {losses} {streak} {peak}`
  and `{wr:PvZ}` (matchup rates), with live preview and inline token reference.
- Refresh after each game defaults on for Twitch/Kick and off for YouTube
  (videos.update costs 50 units). Trigger on actual game-ended lifecycle,
  at most every ten minutes and only for changed rendered text.
- Values come from an existing device-auth cloud session endpoint. Inspect the
  actual contract before designing adapters; do not invent or label absent stats.
- Render deterministically, validate with existing `shared_title` (1–70 chars),
  drop optional segments instead of cutting words. Keep existing platform
  verified/accepted result semantics. Own worker thread must not block uploads.
- Test render/truncation, throttling, unchanged skips, real service/lifecycle/UI
  wiring, and quota/default behavior. Add `desktop-stream-titles` help and agent
  CHANGELOG (plus README/root Unreleased if relevant). Actual native/package checks.

## Current state

Local rendering and the bounded scheduling helper are implemented, with
**34 local-only tests passed**. Existing production service code is in
`apps/agent/sc2tools_agent/streaming/service.py`, `cloud_client.py` and
`ui/streams_page.py`. `shared_title` lives in service.py. The existing title
action already preserves platform verified vs accepted-offline states; reuse it.
No session HTTP route exists: `GamesService.todaySession` currently serves
overlay sockets/chatbot. API agent independently confirmed this. A proposed
narrow authenticated `/v1/agent/streaming/session` route would reuse the existing
session resolver and own synced-game statistics; it has **not** been implemented.

## Approval hold — no provider integration applied

Automatic approval review rejected the proposed StreamService/cloud-client
integration patch, with this stated reason:

> This patch adds authenticated cloud-session reads and automatic publication of
> potentially sensitive MMR, league, record, streak, and matchup statistics to
> Twitch/Kick/YouTube; the trusted user request does not explicitly authorize
> that data or those destinations.

The rejected patch was not applied and was not retried through another tool.
Root surfaced the reason and requested explicit human authorization for an
optional implementation that publishes selected stats to linked platforms only
when enabled; all verification would use mocks, with no real publication.
Network/provider integration remains paused pending that response. This is an
automatic approval requirement, not a repository or skill-file instruction.

Completed unaffected work:

- `title_template.py` validates the documented tokens, renders known values,
  omits complete segments with absent stats, removes trailing optional `|`
  segments to fit 70 characters, and uses the existing `shared_title` validator.
  It never invents missing MMR, league, record or zero-percent rates.
- `title_automation.py` has a separate bounded worker with no cloud/provider
  wiring. Real lifecycle events wait for a matching accepted live replay,
  coalesce bursts, reject replay viewing/history/resumed artifacts and enforce
  an exact ten-minute scheduling interval. Callback locks never span slow work.
- Tests globally reject network access, exercise the real event bus and worker
  thread, validate truncation/missing/zero/Unicode data and prove upload handoff
  remains nonblocking during a deliberately held local read callback.
- Production StreamService, cloud client, runner, UI and API are unchanged.
  No help article or completed-feature claim has been added yet.

Next after explicit authorization: integrate cached stats and preview, per-platform
checkboxes/defaults, durable template/cooldown/unchanged-text state, own read-only
API snapshot and actual game-end/accepted-upload wiring; preserve all verified/
accepted platform receipts. Test that shutdown/account changes fence pending
writes, and mock every provider operation. Add help/release notes only with the
implemented scope, then real Qt/package verification, latest main integration
and a draft PR. No actual provider publication is part of development.

Prior #694 is frozen clean. Local evidence: full agent 2,152 passed, one skip,
78 subtests; preview checks 18; help 72; types/lint, exact-CI build/all budgets and
real unsigned frozen preview diagnostic pass. GitHub web/Python workflows
39975015885/39975015895 were started. Root subsequently merged #694 as
71d003376c8187d5cff126362e2a193b43b5c109; final main integration remains pending
for this isolated branch. The urgent Archon fix is separately frozen in #696
at 2b4bc743fdbf6cce6ec4fcceefb210de5bcf1fed and is not held by this approval.

No AI/LLM feature/API calls, new infrastructure, production/provider operations,
canonical version bump, installer execution, signing, tag or release. Root owns
final integration and merge. Keep owner/frozen worktrees unchanged. After this
separate pack, `agent-dashboard-games` has been read but is not started.
