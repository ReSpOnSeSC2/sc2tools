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

## Local verification

- 254 API tests across15 suites pass: each ambiguous rotation write stage,
 restart/hidden destination, admitted Studio/XP drain,500×8 request budget,
 owner isolation, A→B→C terminal receipts, old-created/recent-rotated ordering,
 revoked/cyclic targets, bot configure/restart/held-list receipts, independent
 prediction/clip fanout, public terminal notices, actual sound/media routing,
 snapshot restore, existing multichat/cache/Studio/socket behavior.
- 968 web/Help consumers across108 suites pass with at most2 Vitest workers.
 Includes the combined Dock723 extraction, bounded/malformed/stalled401 reasons,
 terminal socket retries/heartbeat, owner/auth deadlines and unsaved-draft guard.
 API/web types pass; scoped web lint is clean; scoped API lint has0 errors and
 17 existing/size warnings.
- 342 native tests across11 affected suites pass against disposable doubles.
 Exact owned chains, non-default sources, unavailable OBS, partial URL writes,
 stale target revocation/new rotation before cached repair, current device/API/
 connection fences, existing opt-in/no-obs/env overrides, lock deadlines and
 boolean-only hot-relink events are covered. No real OBS/provider traffic.
- Required browser engine prebuild604e9d4618a6414b passed. Final combined Next
 production build and every existing budget pass without increases: landing
 214.5/215, Today228.4/240, dossier475.9/500, Dock223.3/225, overlay234.4/240,
 widget315/325 and Settings179.6/260 kB gzip.
- 64 actual SettingsOverlay/URL-consumer Chromium assertions at375/1440 in both
 themes, using final production CSS/fonts/public assets. Selection changes real
 widget and Dock URLs; rename, checklist,202 continuation and held-token auth
 cancellation are exercised.12 mutations hit only loopback synthetic fixtures;
 all nonlocal traffic is blocked. All8 final captures were individually inspected:
 `screenshots/token-rotation-{checklist,selector}-{light,dark}-{375,1440}.png`.

## Source and integration

- Initial API/web/docs source1d8be759; reviewed native/final lifecycle source
 cc5064aa; combined frozen Dock723 a203ae7e source7b858304.
- Main723 squash5a2026a4 integration98b3fb02 retains exactly the tested apps tree
 `03a51224baaf219892c967946950c07ef3fb9f7f`; only squash ancestry was reconciled.
 Merge-tree against that fresh main is clean.
- OBS724 ecda8ec8 foundation is integrated; its PR must merge before this pack.
 Root and independent API/gate reviews cleared claim/drain, privacy, media,
 chain, restore, pending bot startup and internal fanout. Native cached-authority
 and shared-lock follow-ups were independently re-read and cleared.
- Remote exact-head CI, Vercel and authorized expected-head squash remain pending
 until the token PR is created and checked. No release, tag, installer signing,
 production migration, new infrastructure, provider publication or budget change.
