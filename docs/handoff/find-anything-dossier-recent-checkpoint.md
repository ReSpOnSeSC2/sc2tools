# Find anything: opponent dossiers in Recent (November 1 UTC)

This is the last private quick-search part of item 72, following the
[ADR 0069 amendment](../adr/0069-global-search.md) dated 2026-11-01. It
builds on the recent-games and personal-maps palette checkpoint
(`find-anything-private-palette-checkpoint.md`). Paths are under `apps/web`.

## What changes

| Area | Now |
| --- | --- |
| Storage (`lib/commandSearchRecent.ts`) | The key stays `sc2tools:palette-recent:v1`. A write now stores version 2: `{version: 2, viewer, entries}`. Each entry is `{kind: "page", id}` or `{kind: "opponent", pulseId}`, at most eight in all, newest first, and a repeat moves to the front. Version 1 still decodes, and the next visit upgrades it. Any bad, repeated or extra part rejects the whole envelope. A pulse ID must have the toon-handle form, digits `-S2-` digits `-` digits, at most 64 characters, so a crafted dossier link stores nothing. Dossier entries show and record only where the navigation lists Opponents; elsewhere they stay stored but hidden. Sign-out clears either version. No name, label, query, URL or time is stored. |
| Recording (`components/chrome/CommandSearchProvider.tsx`) | The provider's existing visit observer records a dossier when `/app/opponents/<id>` opens. It runs after the app chrome registers, needs no read, and leaves the dossier view untouched. The Recent module is now a dynamic import with one shared promise, so it leaves every route's first load. Writes run in the order they were queued, so a sign-out's clear follows earlier visits, and a failed load is tried again on the next visit. |
| Palette rows (`components/chrome/CommandSearchRuntime.tsx`, `lib/commandSearch.ts`) | A dossier entry reads "Opponent dossier" with "Pulse ID …" as detail. It opens through the same guarded handoff as private results, and its draft stays current only while the entry is still stored. Recent now lists entries in visit order, newest first. The scorer previously sorted Recent alphabetically; it now keeps stored order for that group and sorts the others as before. |
| Help (`lib/help/articles/getting-started/keyboard-shortcuts.ts`) | Recent describes pages and dossiers, and explains that a dossier is kept by its Pulse ID only. |

## Verification

- Whole-web types pass. The lint delta against the palette branch adds no message, and the UI lint ratchet passes.
- The Recent storage, provider, real lazy-consumer integration, palette, scorer, guide-search and Help suites pass with one worker. New cases cover:
  - the version-2 format, the version-1 upgrade, and rejection of bad envelopes;
  - toon-handle-only dossier IDs, Opponents admission, and the cap across both kinds;
  - an async visit then sign-out clearing in order;
  - a Recent dossier navigating once, and refusing after it left storage.

## Rollback

Revert this pull request. A reverted reader treats a version-2 envelope as invalid, so it shows no Recent and its sign-out clear does not remove the envelope. Per the amendment, the safer rollback reverts only the dossier recording first and keeps the version-2 decoder and clear for one release.
