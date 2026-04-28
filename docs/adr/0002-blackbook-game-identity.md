# ADR 0002: Black Book uses (Date, Map, Result) for game identity

**Status**: Accepted
**Date**: 2026-04-28
**Context**: Bug fix — back-to-back replays against the same opponent
losing rematch records in `MyOpponentHistory.json`.

## Summary

`DataStore.link_game` previously called `BlackBookStore.update_latest_game`
which patched `mu["Games"][-1]` blindly. When a second replay against the
same opponent in the same matchup deep-parsed before any new PowerShell
stub had landed, the second deep-parse overwrote the first record's
deep fields and the second game was never appended.

We now upsert by stable identity `(Date prefix, Map, Result)`. Each
replay finds its own record (or appends a new one). PowerShell stubs and
the Python deep-parse can write under the same key without
double-counting.

## Context

The on-disk repro (Mirtillo, PvP, 2026-04-28):

| When | Writer | What landed on disk |
| --- | --- | --- |
| 17:11:42 game ends (Loss) | PS scanner | Skipped — `OpponentId` empty (Random opp, no Pulse match). |
| 17:11:42 deep-parse | Python | `update_latest_game` returns False → `append_game` writes the Loss with full deep fields, increments `Losses` to 1. |
| 17:17:40 game ends (Win) | PS scanner | Same skip path. |
| 17:17:40 deep-parse | Python | `update_latest_game` returns True → patches `Games[-1]` (the Loss record!) with the Win's `Duration`, `opp_strategy`, `my_build`, `build_log`. **No new record. `Wins` never bumped.** |

Result on disk:

```json
"unknown:Mirtillo": {
  "Matchups": {
    "PvP": {
      "Wins": 0, "Losses": 1,
      "Games": [{
        "Date": "2026-04-28 17:11", "Result": "Defeat", "Map": "10000 Feet LE",
        "Duration": 317,            // Win's duration ←
        "my_build": "PvP - 1 Gate Nexus into 4 Gate",  // Win's build ←
        "opp_strategy": "Protoss - Standard Expand"    // Win's strategy ←
      }]
    }
  }
}
```

## Decision

Add `BlackBookStore.upsert_game(...)` keyed on
`(Date[:16], Map, Result)`. `link_game` calls only `upsert_game`. The
legacy `update_latest_game` is kept (deprecated) for one minor version
to avoid breaking external callers, then removed.

The PowerShell scanner now also falls back to `unknown:<Name>` when
`OpponentId` is empty so PS and Python share one key. The upsert
guarantees they can't double-count when both fire for the same replay.

## Why minute-precision Date is enough

- `Date` is stored as `"YYYY-MM-DD HH:MM"`. The replay timestamp is the
  game *start* time, taken from the replay header — deterministic.
- A user cannot start two SC2 ladder games inside one minute on the
  same map with the same result. Even an instant-leave is bounded
  by load-screen + lobby > 30 s, which means two consecutive starts
  rarely share an `HH:MM`. They CAN share if the user plays the same
  map twice with the same result back-to-back AND game 1's load+play
  finishes inside the same minute as game 2's start — physically
  impossible for human play.
- For paranoia, `Duration` could be added to identity. We chose not to
  for now because the same field arrives at two writers (PowerShell
  doesn't carry duration) and would require a second find-pass for
  records still missing the deep field.

## Consequences

**Positive**

- Back-to-back rematches against any opponent (Pulse-resolved or not)
  no longer clobber each other.
- PowerShell and Python now share a key for Random opponents — which
  enables future single-source-of-truth refactoring of the Black Book.
- `update_latest_game` is on a deprecation cycle: callers can migrate,
  then it's removed, with no public-API surprise.

**Negative**

- A deep-parse that arrives with a *changed* date string (clock skew,
  timezone bug) won't find its prior PS stub and will append a
  duplicate. Mitigated by the next stage's planned `replay_id`-based
  identity (see roadmap Stage 11).

## Migration

Existing on-disk records are unaffected — `upsert_game` reads them as
they are. The 2026-04-28 Mirtillo record was repaired in place from the
canonical fields in `meta_database.json` and committed as a one-shot
script (not part of routine operations).

## Rollback

Revert the patch and restore `link_game` to the patch-or-append flow.
On-disk data shape is unchanged either way; only the write code
differs.
