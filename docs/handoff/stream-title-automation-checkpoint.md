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

Implementation has not started. Existing code is in
`apps/agent/sc2tools_agent/streaming/service.py`, `cloud_client.py` and
`ui/streams_page.py`. `shared_title` lives in service.py. The existing title
action already preserves platform verified vs accepted-offline states; reuse it.
The exact cloud session endpoint and available stat fields are not traced yet.

Prior #694 is frozen clean. Local evidence: full agent 2,152 passed, one skip,
78 subtests; preview checks 18; help 72; types/lint, exact-CI build/all budgets and
real unsigned frozen preview diagnostic pass. GitHub web/Python workflows
39975015885/39975015895 are running. #691 merged all green into main441582d0.

No AI/LLM feature/API calls, new infrastructure, production/provider operations,
canonical version bump, installer execution, signing, tag or release. Root owns
final integration and merge. Keep owner/frozen worktrees unchanged. After this
separate pack, `agent-dashboard-games` has been read but is not started.
