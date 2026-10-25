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

Current proof: 22 new API Mongo/parity cases, existing socket/backup cases;
52 focused new/updated web cases and 34 replay/guide/action consumers; 125
offscreen native cases. API/web types pass. Required engine prebuild smoke
passed at unchanged 604e9d4618a6414b and the shared slot was released immediately.
Remaining: final consumer/lint/build/budgets and actual responsive browser proof,
independent final review, fresh-main integration, scoped PR/current-head gates.
Prior Admin lifecycle PR730 remains separately owned at exact 32a9d83e; GitHub
checks are green but its existing Vercel deployment quota status still blocks
merge. No quota bypass, paid upgrade or new deployment was attempted.
