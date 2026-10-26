# Accessible themes and shared UI integration

2026-10-25. Branch `codex/wave5-contrast-accessibility`, worktree
`wave4-agent-dashboard`. Merge `84193ecde95c16c29263f974f850c542d77a990e`
combines original A11y `99806e8d`, Nav `9849c107` and shared UI/gallery
`f1808a33`. The final integration repairs below are ready for root's commit and
PR752 remote gates. This is not completion of the overall roadmap.

## Preserved contracts and integration repairs

Full Light/Dark/System choice, pre-paint/browser metadata, shared Modal defaults,
typed UNPAIR and controlled destructive dialogs remain intact. Registered
nonmodal portals stay in their parent Modal's Tab domain; Escape dismisses one
layer, native radios/details retain their semantics, and nested layers stay
below Toast. Copy/confirmation callbacks retire with owner/resource scope.
Gallery access remains server-gated with a five-second whole-request deadline.

Fixture HTML now sets the requested theme mode as well as palette, and the
gallery fixture has a title. Its new actual axe scan exposed Light success and
warning Badge contrast failures. Composite-pair tests also exposed signal and
danger on the page ground. Those four Badge fills use 5% tint; text/border tokens
stay the same. All seven variants now pass all three parent surfaces/themes.
Stream Studio's small action labels use the existing 13px caption token and its
preview background uses the dark replay-scope token.

The ratchet allows only the canonical top-level exported `THEME_COLORS`
declaration's two literal members in `lib/theme.ts`; other literals, bindings,
members and paths remain checked. Four audited old signatures were migrated:
standalone crash CSS drops from 20 to 16 hex occurrences, and three existing
Clerk mirror colors follow the corrected Light palette. Four retired allowances
were pruned. No new primitive/gallery debt was grandfathered: final baseline is
570 signatures and 755 occurrences across 1,645 scanned source files.

The combined build initially exceeded `/try` at 240.5/240 kB. Seven existing
Try consumer imports now use the same controls' leaf modules, removing unused
barrel code from first load. No async loading, focus, clear-data confirmation,
analysis or upload behavior changed; final `/try` is 213.7/240 kB.

## Final local verification

- Focused packs cover 762 applicable checks in 62 unit files, plus 16 AST rule
  checks. This is cumulative affected coverage, not a new full-web-suite claim.
  It includes 272 contrast assertions, gallery authorization/deadline cases,
  shared focus/copy/confirmation, ThemeChoice, notification and Macro consumers,
  and 65 Try/intake/player-choice/save/clear-data assertions after leaf imports.
- Full web/API types pass. All 95 owned JS/TS files pass strict lint in the
  combined and subsequent seven-file import packs. The ratchet has no new or
  stale allowances. The two narrow no-autofocus test/consumer comments explain
  custom controlled focus props; they do not disable native autofocus checks.
- Eighteen actual-source gallery/shared-focus Chromium cases pass at
  360/768/1280, one worker, actual fonts/Tailwind and a denied clipboard fixture.
  Six gallery axe scans have no serious/critical findings or exceptions.
- Built production appearance/public-page/SEO checks pass 190 cases, with 23
  intentional viewport/Clerk-fixture skips, no unexpected or flaky cases. All
  126 route/theme/viewport axe scans report zero serious/critical nodes; the
  allowlist is empty. Collection-only mode was disabled. Eight real 13px label
  text-range/cell measurements pass at 360px in both themes.
- Final production Next build and every unchanged budget pass: landing
  191.5/215, Today 233.7/240, game 314.3/440, dossier 454.2/500, overlay 233.8/240,
  widget 317.9/325 and Try 213.7/240 kB. Local Windows engine smoke remains
  version 1.6.12/hash `fc21ebe5bf52a53c`; Linux production's independently built
  artifact is `0256093d6981b497`, verified by root and its 11 CI engine checks.

Root inspected four new synthetic captures, copied without modifying the older
17 A11y captures:

- `screenshots/ui-accessibility-gallery-light-360.png`
- `screenshots/ui-accessibility-gallery-dark-1280.png`
- `screenshots/ui-accessibility-appearance-dark-1280.png`
- `screenshots/ui-accessibility-menu-light-360.png`

They are legible and contained; the Appearance modal and three theme choices
remain visible. The separate full Stream preview capture had a cookie banner,
so it is not claimed as visual proof; its scalar geometry evidence is retained.
Logs, complete audit JSON, browser result JSON and geometry are ignored under
`apps/web/.cache`. Both owned test servers stopped and ports 8080/3210 were
verified released. Original owner temporary files and all caches are preserved.

PR756 is live as main `b97fb80c1dec3aec7e53ece7bfe26852b6d40d9d`; Nav731 is
merged as `cfcf5abdebc33c74de24435cfa3729548b5ac9e1`. Root verified both squash
merge trees equal their tested source. This branch contains their source;
root owns ancestry reconciliation and final PR752 commit/push/remote gates.
No private Admin screenshot/data, production record write, reanalysis,
migration, installer, release, tag or version change is included. Broad consumer
migrations and the final owner setup guide remain separate unfinished work.

## CI line-ending repair and rollout state

CI at `301c1b20` passed full web types/lint, then found one Dock CSS allowance
whose raw template token differed across CRLF/LF checkouts. The checker now
canonicalizes physical CRLF/CR to LF before AST parsing. Escaped literal CRLF
and LF remain distinct. All 18 rule regressions, strict script lint and the
1,645-file source scan pass. The sole baseline change is that existing Dock
signature's hash; its file, rule, example and one occurrence are identical.
Baseline totals stay 570 signatures/755 occurrences. No app runtime, budget or
browser behavior changed, so those proofs were not repeated for this repair.

Nav is merged but not yet production-deployed. A missing automatic deployment
was followed by one normal manual request, rejected by Vercel's daily free
deployment quota with a 24-hour retry instruction. No retry/upgrade followed;
production remains PR756/b97. Root holds PR752's merge until required remote
CI/deployment gates succeed. Private Admin evidence remains excluded.

## Linux command focus and agent release reconciliation

CI at 06910887 found one real narrow Linux download failure: source-install
commands could overflow horizontally without accepting keyboard focus. The
four source/verification command blocks now have distinct accessible names,
native tab focus and visible accent focus rings. Two deterministic 360px
browser cases force the Linux branch, check Tab and ArrowRight in both themes,
and retain strict axe. Existing default-platform cases are unchanged.

The five-file repair at a98575ee passes 12 focused component checks, full web
types, strict changed-file lint, all 18 ratchet regressions and the unchanged
1,645-file/755-occurrence UI scan. No accessibility allowance was added.
Production-browser verification uses the integrated public-player build.

PR757 is merged as ae21f7a2 after all exact-head checks passed. Agent version
and both changelogs are 0.24.7; the owner-authorized agent-v0.24.7 tag is pushed
and remotely verified. Its installer workflow stopped at the existing missing
SignPath configuration gate, before producing any executable. This branch now
reconciles that actual main ancestry and records delivery in the release
checkpoint. No signing configuration or installer execution was performed.
