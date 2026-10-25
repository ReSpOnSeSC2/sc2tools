# Synced Ghost practice checkpoint

Pack: `ghost-synced-practice` (Wave 4), ADR0049. Branch
`codex/wave4-ghost-practice`, reused preserved `wave3-my-reviews` worktree.

Implemented the bounded account preference service, source-priority practice
actions, explicit browser migration, owner-specific offline cache, synced replay
grading/Undo/disarm, permanent OBS URLs and socket precedence. All specified
build/guide/community/definition surfaces use the shared split trigger. App
chrome displays the selected first assignment plus an honest extra-slot count.
Native code changes only two stale OBS setup notes; native panel controls and
reference semantics remain separate.

Root identified and the implementation corrected notification-capacity and
held bootstrap/resync races. Atomic sibling revisions now travel with every
snapshot and lower revisions cannot replace newer overlay/SWR/cache data. A real
backup-restore regression proves old archives preserve the current assignment
and revision. No new infrastructure, migration, provider enabling or production
mutation. API/web/native tests use synthetic local data and mocked boundaries.

Final integration includes owner main `9bb3f5ca95a65c71ce81e5ebfbacc895de854d47`.
The required engine prebuild and smoke passed at `f96c086eb83fdc40`; the shared
slot was released immediately. No release/version action was initiated here.

Final source also fences read tokens and bodies with an owner epoch, including
A→B→A transitions, and bounds token/body waits with real deadlines. Large
practice, grading and reference controls load on demand with local chunk-error
recovery. The Ghost transport remains framework-free so server-rendered guides
do not eagerly pull Clerk/SWR into their first-load graph. Source replay targets
must match the selected own race, including definitions edited after capture.

Proof: 107 API cases across seven Mongo/socket/backup suites (including 22 new
service/parity cases), 695 web consumers across 78 files, then 16 final source
race/picker regressions, and 125 offscreen native cases passed. API/web types
and scoped lint pass. The production build and every existing bundle budget
pass, including landing 214.6/215 kB, Today 238.8/240, Dock 224.5/225, Guides
168.5/175, opponent 471.4/500, widget 315.1/325 and global trends 509/520.
No budget was increased.

The actual consumer browser fixture passed 92 checks at 375/1440 px in both
themes, using two isolated browser contexts, synthetic accounts and 20 mocked
local writes. All eight captures in `screenshots/ghost-practice-*` were
individually inspected; logos render and layouts do not overflow. No live
account, provider, OBS or production mutation was used.

Remaining: independent final review and scoped PR/current-head gates.
Prior Admin lifecycle PR730 remains separately owned at exact 32a9d83e; GitHub
checks are green but its existing Vercel deployment quota status still blocks
merge. No quota bypass, paid upgrade or new deployment was attempted.
