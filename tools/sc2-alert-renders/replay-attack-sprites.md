# Native replay attack sprites

The replay's Attack sheets are baked from the installed game's authored M3
animation groups. Eight poses and eight facings use the existing 256px cell,
60-degree orthographic camera and world-unit scale contract. Each clip retains
its own ground anchor, so switching from Stand does not move the unit.

Only the initial 30 source frames are sampled for long clips; authored recovery
tails do not lock a unit in an attack pose. The source is 30 FPS. Recorded shot
events in the replay control when the clip plays and which direction it faces.
Models without an authored Attack sequence keep their existing pose.

The shipped set contains 37 clips in both player colors: 74 sheets and 4,736
populated, unclipped frame cells, totaling 28,050,994 bytes. All WebP alpha
channels were compared pixel-for-pixel with the Blender source renders. The
other 17 extracted models have no authored Attack sequence in their M3 file.

`replay-attack-clips.json` records source groups, original and sampled frame
ranges, dimensions, world scale, anchors, file hashes and validation results.
The generator merges this ledger with the original Stand/Walk sidecars.

## Reproduce

Use Blender 4.5 with M3Studio, the locally extracted M3 models and their
`Assets/Textures` DDS files. The baker reuses the existing alert model importer;
its sprite material pass handles SC2 diffuse team masks and packed normals.
Native additive mesh effects use unlit color with transparent black in the
RGBA atlas, avoiding opaque effect cards. This is an atlas approximation of
destination-additive blending; separate scene particle systems are not baked.

```powershell
blender --background --factory-startup --python-exit-code 1 --python tools/sc2-alert-renders/bake_replay_attacks.py -- --models tmp/sc2-unit-extract/m3 --textures tmp/sc2-unit-extract/textures --sprites apps/web/public/sprites/units --output output/replay-attacks
python tools/sc2-alert-renders/package_replay_attacks.py
node scripts/gen-sprite-manifest.mjs
```

Packaging requires Pillow. It rejects empty or clipped cells and static sheets,
then encodes quality-90 WebP color with lossless alpha. PNG source atlases remain
in staging. `output/replay-attack-sprites` contains a separate release bundle
with the same WebP files and ledger.

## Ship and verify

Commit the generated ledger and sprite manifest together with
`apps/web/public/replay-attacks`. These new assets ship with the web app;
`spriteUrl` uses `/replay-attacks` for Attack sheets even when the older
Stand/Walk assets use a CDN. No CDN publication is required. If releasing the
bundle separately, copy its `units` directory under the web server's
`/replay-attacks` path before releasing the matching manifest.

Run the `attackSpriteAssets.test.ts` web test to verify that every declared
attack resolves to both packaged colors with matching hashes and geometry.
Visually compare a replay paused just before and after an observed shot to
check the pose, facing and ground anchor. Particle projectiles are drawn from
observed replay weapon events, not baked into these body-pose sheets.
