# Overlay token rotation checkpoint

Branch: `codex/wave4-token-rotation`

Worktree: `C:\SC2TOOLS\.worktrees\wave3-my-reviews`

Scope: exact W4 `token-rotation`, ADR0043. Coaching721 and original Rivals and
Mechanics branches remain preserved. OBS foundation ecda8ec8 is integrated;
the native slice is coordinated with its owner. No real account, provider, OBS,
integration or production database action has been performed.

## Implemented

- Owner-scoped resumable rotation, rename and explicit multi-token URL selector.
- Hidden reserved destination; bounded single-instance write admission/drain;
  durable restart fence; canonical Studio copy and four batched engagement rekeys.
- Immediate old-room retirement, boolean-only terminal notices and replaced UI;
  pending-token fanout exclusion and independent healthy-token predictions/clips.
- Exact running-bot token replacement without provider reconnect and pending
  startup/configure recovery. Ready terminal chain receipts stay owner scoped.
- Media audit: uploaded sounds are user-owned; both upload IDs and strict legacy
  serve paths generate current-token URLs. Alert object keys/grants are token
  independent. Local actual-router tests use a mocked signer and synthetic audio.
- Snapshot restore preserves current credential/lifecycle rows so a pre-rotation
  archive cannot revive the source or delete the replacement.
- Help `overlay-url-leaked`, schema notes and ADR document safe continuation,
  manual custom/Dock updates and existing OBS opt-in boundaries.

## Verification in progress

Initial integration:90 API tests passed, including each ambiguous write stage,
restart, held Studio/XP writers, fixed row budget, owner isolation, socket notice
privacy, sound/media and snapshot restore. API types pass. Expanded chain, bot
restart and clip race regressions plus final UI/native/browser/build gates are
still being completed. Do not treat this checkpoint as final gate evidence.
