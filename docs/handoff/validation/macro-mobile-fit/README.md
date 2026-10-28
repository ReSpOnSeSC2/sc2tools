# Macro mobile fit: local validation

The current local release gate passed at `cd25ed68f222c48cc80c0a8bcb6d174fe1064cfc`
and build `EE76oB0LZMFMkqAEyZDxe`. CI, deployed revision checks and actual
signed-in Macro acceptance remain pending. No roadmap item is closed here.

[current-cd25ed68.json](current-cd25ed68.json) binds these compact results to
the raw artifacts retained under `.cache/macro-mobile-fit-20261028/`.
The production build passed all 83 unchanged route caps, 6,965 source-input
pre/post checks and the 40 canonical / 7 active / 4 strict sample asset guards.
It used one static worker and a 4 GiB heap without asset generation or downloads.

The original four browser cases passed at 320 light, 390 dark and 1280 in both
themes, with touch/coarse input on the phones. All 16 full default Axe scans had
zero violations; 233 physical target observations passed. The original exact
phone page-position restoration and repeat-open assertions both passed.
The fixture compiled 311 actual product inputs against fresh production CSS
and three admitted fonts. Owned browser cleanup recorded 21 identities and
zero remaining owned/unknown processes or listeners, with no kills.

The two PNGs are byte-exact LOCAL synthetic-fixture attachments, independently
viewed at 320 light and 390 dark. They show the timeline and both armies inside
the panel with unscaled controls. They are not production or device photos.

Product checks retain their chronology: 277/19 initial, 59/8 refinement,
27/7 semantic repair, then 31/6 close repair followed by a separate 10/1 rerun
of the changed synthetic Link seam. The other 21 unchanged consumer cases
carry from that earlier run; there is no new combined 31-case claim. Current
whole-web types and strict lint on 16 owned TypeScript files pass.

Earlier nested-dialog Axe failure, new-oracle failure, phone scroll failure,
test-seam lint warnings and process observations stay in cache with hashes.
No assertion expectations, thresholds, Axe rules, caps or assets were relaxed.
The local fixture uses synthetic Clerk/GET data and Next primitives. It does
not prove actual Next routing, SSR/auth, real account data or mobile hardware.

The 6,965-source guards ran before later documentation/capture adoption; those
later metadata-only files must be qualified separately. The canonical ledger
is unchanged: 197 original items, 124 completed, 53 partial, 20 open and 73
unfinished. Costs, providers and cache activation remain unchanged.

The initial PR812 responsive run failed three Community footer-locator cases
(588 passed/92 existing skips). A test-only native-footer selector correction
preserves every original assertion and adds semantic guards. All 12 existing
Community cases now pass across three projects; new exact-head CI is pending.
See `ciIntegrationCorrection` in the compact summary for hashes and boundaries.
