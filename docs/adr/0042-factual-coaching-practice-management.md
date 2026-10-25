# 0042: Factual coaching practice management

Date: 2026-10-25

Status: Accepted

## Context

Practice plans already have immutable requirements, calendar-aware recurrence,
per-game eligibility and explicit student-approved sharing grants. Managing
history must preserve those boundaries and the Locker rule that coaching never
grades or scores a student's games.

## Decision

- Classify plan lists from stored UTC start/end boundaries and status only.
  Five countDocuments calls reuse the exact role/student/current accepted grant
  scope. Counts never compute game progress or interpret a met target as ended.
- Reuse the current progress aggregation for maximum qualifying game date.
  Evidence wins/losses are two counts over the same eligibility match, independent
  of page size; ties remain outside the decided percentage.
- Start coaches at a bounded newest-100 active-plan roster, shared with the
  existing workspace badge through one SWR key. Count distinct behind-schedule
  students, rather than plans. Truncation is disclosed as partial/lower-bound.
- Schedule pace is playedGames < floor(requiredGames × elapsed fraction) inside
  the current UTC bucket. It is a count against elapsed time, not a game grade.
  Streaks include only completed, finished consecutive periods; current/future
  completions cannot inflate them.
- Repeat a plan through the existing validated AssignmentModal, with a new
  request identity generated outside pure calendar math. Preserve its inclusive
  day length; align recurring starts forward to a calendar period boundary.
  Unavailable build selections are cleared with an inline validation error.
- Key the practice workspace by the loaded signed-in owner, drop local drafts
  through account transitions and fence held authentication before mutations.
  Keep evidence and student-filter data scoped without previous-answer reuse.
- Split cards, evidence and consent presentation out of the practice workspace;
  retain existing consent, idempotency, cancellation and replay-download rules.

## Consequences

The UI shows facts, source counts and known coverage. No production migration,
job, new collection, provider operation, infrastructure or budget increase is
needed. The recurrence helpers remain unchanged for the later personal-goals
extraction. Rollback is a code revert; stored plans stay compatible.
