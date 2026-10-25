# Chat commands v2

Owned branch `codex/wave4-chat-commands` in the reused preserved
`.worktrees/wave3-owner-neighbors` worktree, based on actual main728.
The original scouting branch and ignored caches remain preserved.

API source implements the single registry and strict bounded preferences,
deterministic record/winrate/streak/lastgame/H2H/peak/oracle/uptime replies,
custom variable expansion, canonical command/viewer cooldowns, generic
Nightbot route, on-stream POST and owner-only saved-settings preview.
The existing bot connection remains opt-in and no message was sent.

The final affected API run passes73 tests across six suites, including46 new
registry, local Mongo history, authenticated settings, transport parity,
native-shaped H2H and lifecycle cases. Independent review found and fixed
native profile identity normalization and delayed Twitch reply handoff across
token/connection changes. Replay-watching fallbacks and honest session MMR
wording are covered. Final independent API review is clear. API types and
strict new-source/test lint pass; broad legacy containers retain their existing
function-length warnings, with no ESLint errors.

Web editor, generated guide/bio/Help and on-stream consumer are owned by
build_studio in this same worktree. Root owns API and this checkpoint,
ADR0050, CHANGELOG and owner notes. Do not stage the agent's unfinished web
work with API preservation. GameDesk732 source must be reconciled before
final Twitch routing verification. Final combined types,
tests, production build/budgets, browser proof and PR/remote gates remain.

No infrastructure or budget change, production mutation, actual chat post,
integration enabling, release/version action or AI/model call.
