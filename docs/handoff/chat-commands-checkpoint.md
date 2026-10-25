# Chat commands v2

Owned branch `codex/wave4-chat-commands` in the reused preserved
`.worktrees/wave3-owner-neighbors` worktree, reconciled through actual main
34b14d7f (GameDesk732) and the owner's9bb native/Randomizer work.
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

Combined GameDesk/chat verification passes113 API tests across9 suites.
Web source, generated guide/bio/Help and on-stream consumer are preserved at
6a66b585:25 focused and111 related web assertions, full types and strict
changed-source lint pass. Independent API and web source reviews are clear.
The actual GameDesk squash reconciliation introduced a duplicate Help block;
it was removed explicitly, restoring byte-equivalent API/web source to6a66.

Real-UI/SWR browser proof passes232 grouped checks at320/390/768/1440 in
both themes with32 captures and no page errors/unexpected API calls. It uses
the real command service with synthetic owners/stat lines; all external
traffic is blocked. No real chat post, bot connection or account save occurs.
Root inspected phone custom/preview and desktop builtins; independent review
inspected representative screen families and checked no captures are blank.

Required engine build/smoke passes f96c086eb83fdc40. Final production build
and all unchanged budgets pass:Today238.8/240,Dock214.6/225,
landing214.6/215,guide169/175,HelpArticle190.8/200,Widget318.3/325kB.
Final-head remote checks/Vercel and a fresh main merge tree remain PR gates.

No infrastructure or budget change, production mutation, actual chat post,
integration enabling, release/version action or AI/model call.

Actual main b2f49312 (Ghost734 plus owner7ada scouting/queue work) is
integrated. The exact current-main native upload assembly barrier is retained;
both Ghost and Chat preferences keep their dedicated validation and private
no-store routes. No Series feature or ProfileView change is included.

Final combined integration passes 86 API tests, 36 web tests, 9 native gate
tests and both full typechecks. Required f96 engine smoke and the final
Next-only production build/all unchanged budgets pass: landing214.8/215,
Today239/240,Dock214.7/225,AIO236/240,widget320.1/325kB. Existing independent
source/visual review and232-check browser evidence remain applicable; this
merge adds only already-shipped Ghost/owner code and preserves both contracts.
Current expected-head checks and Vercel remain required; no deployment quota
bypass, provider action, integration enabling or production mutation occurred.

