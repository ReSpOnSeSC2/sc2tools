# Wave 2 combined integration

This branch combines the scoped, tested draft PRs below while preserving their complete head ancestry. The final merge must preserve that ancestry (use a merge commit), so the original review trail and dependency commits remain available. This is an integration checkpoint, not a claim that all Wave 2 items or later waves are complete.

| Source PR | Scope | Integrated head |
| --- | --- | --- |
| [#665](https://github.com/ReSpOnSeSC2/sc2tools/pull/665) | Notifications and report replies | `09d93549474fabe0ee3a9fd70c95e2bb98234970` |
| [#667](https://github.com/ReSpOnSeSC2/sc2tools/pull/667) | Build library, dossier and definitions | `d7da00054b5a79f14d8f224d627f439b7e7d0f8d` |
| [#668](https://github.com/ReSpOnSeSC2/sc2tools/pull/668) | Desktop runtime, match-aware scheduling and responsive Save | `c7f2c71a8af180fb26a8f62f8ad032ea794eeee0` |
| [#670](https://github.com/ReSpOnSeSC2/sc2tools/pull/670) | Coaching workspace | `c42c612b12d9c1f46d119711cb90f37ac4dd7d79` |
| [#671](https://github.com/ReSpOnSeSC2/sc2tools/pull/671) | What is new, incident status and notification focus | `3a03620a7439437ae98b8eb6e769600c946942d4` |
| [#672](https://github.com/ReSpOnSeSC2/sc2tools/pull/672) | Installer, autostart and signing gates | `ecb3035e80699455346a9516339f49ff14a8a6fe` |
| [#673](https://github.com/ReSpOnSeSC2/sc2tools/pull/673) | Review board filters and game picker | `43a64ab9a6b0b85d81a417f83b701c8fde58d455` |
| [#674](https://github.com/ReSpOnSeSC2/sc2tools/pull/674) | Dock scenes and Stream Studio | `1d91f343ed664e61d326c8d1526575f2749e2ce6` |
| [#675](https://github.com/ReSpOnSeSC2/sc2tools/pull/675) | Streaming snapshots, restore preview and repair | `10e000dc56a0e7106056843de7fdc9373ba78580` |
| [#676](https://github.com/ReSpOnSeSC2/sc2tools/pull/676) | Review drafts, edit mode and page controls | `106a79721072b80dbded8bd54245939a1001d974` |
| [#677](https://github.com/ReSpOnSeSC2/sc2tools/pull/677) | Community browsing and filters | `8a79013aaa1dc2862b4e5be24514d147036b062f` |
| [#678](https://github.com/ReSpOnSeSC2/sc2tools/pull/678) | Downloads and donations | `f89ed9852a3a26fe8c97edca9a55f57821b92bbf` |
| [#679](https://github.com/ReSpOnSeSC2/sc2tools/pull/679) | Visitor/auth next steps and browser intake | `880644d9000293b839da0dd69ddf81bcc0cf28b6` |
| [#680](https://github.com/ReSpOnSeSC2/sc2tools/pull/680) | Complete account erasure and durable identity retries | `f2d62c3517281d361b6c0bec84ff072c936eafc4` |
| [#681](https://github.com/ReSpOnSeSC2/sc2tools/pull/681) | Community cards, detail and author pages | `9bae7a47e5b289199ced3af6cf8f774a1571c068` |
| [#682](https://github.com/ReSpOnSeSC2/sc2tools/pull/682) | Isolated widget previews and deliberate on-air tests | `14907313820f8cf9d949c7430054630a002c0aed` |
| [#683](https://github.com/ReSpOnSeSC2/sc2tools/pull/683) | Creator publishing loop and private owner records | `f8dbe1f5e939e00fba03971d184279b62221f5e8` |
| [#684](https://github.com/ReSpOnSeSC2/sc2tools/pull/684) | Sidebar, activity strip and PWA/offline | `11028908d38d6e93f2bb67f2efaa421e9d496ec8` |
| [#685](https://github.com/ReSpOnSeSC2/sc2tools/pull/685) | Opponent list state and private note drafts | `ab3325e5297fb99bb54767d7a121490484584a98` |
| [#686](https://github.com/ReSpOnSeSC2/sc2tools/pull/686) | Public replay archive filters and responsive rows | `ef61227c980295722cadc8a56e2e41ba3fb85782` |

## Integration decisions

- Keep both the global site_config registration and temporary backup restore staging and durable identity-deletion registrations. Account erasure classifies global site configuration explicitly; ops must also classify job_runs and scrub admin_audit actor/target IDs under the shared lease when it is integrated later.
- Keep both announcements and durable identity deletion services in app construction. Keep all browser mock datasets and all date formatting helpers. Button style exports retain both compatible names.
- Preserve the compact Community cards and the replay-review finding-requests Help anchor while adding writing controls and creator actions.
- Focus new dialogs synchronously in the layout commit and give only the top registered scope Escape/Tab ownership. React may detach a closing dialog before cleanup, so focus return uses registration order. A deferred build-menu focus restoration now respects a newly opened dialog. A deterministic browser replay verified rapid Escape closes Install while More stays open.
- Load the interactive opponent table behind the lightweight page header. Authenticated data starts after that boundary loads; subsequent updates keep the mounted table and its rows. This keeps the combined route within its unchanged budget without adding a second presentation waterfall.
- Opponent replay history stays immediately above notes near the top. Global filter URL work in Wave 3 must preserve q/sort/dir/impact/notes and unknown parameters.

## Validation status

The complete combined desktop suite passed 2,087 tests, one platform skip and 78 subtests. Both complete typechecks and strict root integration-source lint passed. The full API run passed 5,004 tests; one five-test suite could not start temporary MongoDB under concurrent load and passed all five on an isolated rerun without any API source change. The full web run passed 6,642 tests with one focus failure; its actual build-menu race was fixed and all 49 affected card/dialog/opponent regressions pass afterward. Combined production build/budgets and browser checks are being completed before remote CI. Individual draft PRs contain their broader test and screenshot evidence.

Vercel has reported daily deployment rate limits for several source previews. This is an external deployment quota; do not buy a plan, repeatedly redeploy or claim a deployment succeeded because tests passed. Record the final integration deployment result separately.

## Operations and remaining work

No production database restore, migration, deletion, account modification, installer execution, signing, version bump or release tag was performed. Snapshot migration remains manual; follow docs/runbooks/user-snapshots.md and its rollback warning. Signed release builds require actual approved SignPath configuration, and INSTALLER_SIGNED remains false until genuine signed artifacts exist.

Wave 2 still needs the game header/check-in summary, shared-analysis expansion, ops console and admin packs 4–7. They are isolated follow-ons. Waves 3–6 and the final complete docs/SETUP_GUIDE.md remain required. No AI features or AI API calls are allowed.
