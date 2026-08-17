# Real SC2 alert-render production gate

The source-faithful M3/DDS import-and-render toolchain in
[`tools/sc2-alert-renders`](../tools/sc2-alert-renders/README.md) is the build and
inspection boundary for the 11 real 3D SC2 alert presets. The checked-in client
expects paired files at `/alerts/sc2-3d/<deliveryBaseName>.webm` and `.webp`;
only operator-supplied Blender/M3Studio/FFmpeg tools and locally authorized
source exports enter this workflow. Record tool versions and SHA-256 values
(`Get-FileHash <download> -Algorithm SHA256`) against the selected distributor's
published checksum when available.

## Release workflow

1. Pin Blender 4.5 LTS and a known M3Studio revision. Record both versions.
2. Export the 12 exact main M3 files listed in the tool README. Export the 8
   unique optional M3A files when available; they are referenced by 10 role
   imports across the 11 specs. Their absence is a supported fallback. For DDS
   extraction, the source-only `extract_sc2_assets.cpp` helper can be built
   against a pinned local CascLib checkout; it reads only the operator's own
   installed SC2 CASC, preserves `Assets/...` paths, and fails ambiguities.
3. Run `render-sc2-alerts.ps1 -ValidateOnly` with explicit Blender, addon,
   model, and texture roots.
4. Run all-spec `-Inspect`. Use the exact reported paths to export DDS files,
   then require every `productionTextureGate.requirements[]` row to report
   `ready: true`. The gate verifies the manifest path against imported M3 slots,
   resolves only the full archive-relative path, and asks Blender to decode the
   DDS. It covers inspection-verified diffuse/base-color, decal, normal,
   specular/gloss, emissive, alpha, and anatomy-critical maps.
5. Review the imported `unsupportedEffectGate` inventory, then run the source
   particle/ribbon/displacement realization pass. Production requires every
   active imported row to reach zero unresolved items in
   `effect-realization.json`. Dormant rows are accepted only when their authored
   active channels remain disabled throughout the selected action.
   `-AllowUnsupportedEffects` exists only for calibration and its output is not
   package-eligible. No procedural Archon replacement is used.
6. Render Zealot, Marine, Archon, and Carrier calibration posters first. Confirm
   native pose, source blade/ribbon alignment, bone-attached Marine muzzle
   bursts, readable Archon armor through its source effects, four real
   Interceptors, 65–75% subject/ensemble occupancy, material response, and
   alpha.
7. After both fidelity gates pass without bypasses, render every complete
   24-fps PNG sequence into a new versioned output root.
   Inspect first, poster, last, and action-transition frames; also inspect fast
   travel, blink, backflip, merge, warp, and drop extremes for clipping.
8. Package with `package-sc2-alerts.ps1`. The packager requires every contiguous
   frame and emits `deliveryBaseName.webm` plus `deliveryBaseName.webp` using
   FFmpeg VP9 alpha and WebP.
9. Decode each packaged WebM and confirm its alpha plane contains both
   transparent and opaque values across the full sequence. One FFmpeg check is
   `ffmpeg -c:v libvpx-vp9 -i <file.webm> -vf "alphaextract,signalstats,metadata=print" -f null -`;
   verify the aggregate luma range reaches 0–255. Do not check only frame one:
   some entrances intentionally begin transparent. Test current Chromium and
   Firefox playback plus poster/video fallback behavior.
10. Confirm asset-use rights and project approval before publishing any
   derivative game render. Source M3/M3A/DDS, `.blend`, inspection, and PNG
   build products remain outside git.

## Corrective validation baseline (2026-08-17)

The corrected production batch used portable Blender 4.5.12, M3Studio commit
`52e9b927bca820465459935b95b8adc5b6a483c7`, all 12 main M3 exports, and the
source-effect realizers in `tools/sc2-alert-renders`:

- manifest/PowerShell/Python validation passed for all 11 specs;
- all-spec Blender `-Inspect` completed for 17 role imports and wrote native
  action, exact bitmap, primary texture gate, and imported-effect reports;
- 98/98 requested DDS files (53,661,392 bytes, none empty) were extracted from
  the installed SC2 CASC with the source-only helper and Ladik CascLib 3.0
  commit `4971d363e665551ac4142f541e5f2d71f1cda653`;
- all 75 role-level primary texture requirements resolved by exact path,
  matched the expected imported M3 slots, loaded in Blender, and reported
  `ready: true`;
- the 8 unique optional M3As (10 role references) were absent and produced
  actionable warnings while every main model supplied usable native actions;
- source particles, ribbons, forces, flipbooks, and actual imported
  displacement shells were realized after native actions and material rebuild;
  all 11 final `effect-realization.json` ledgers report `ready: true` with zero
  unresolved imported items;
- Archon opacity was calibrated per spec to keep the real armor readable while
  retaining its source particle field and both source shells. The ledger calls
  out the unavoidable screen-space-distortion proxy rather than claiming
  pixel-identical framebuffer behavior;
- the final 11 sequences contain 1,060 contiguous RGBA PNG frames: 96 Zealot,
  84 Marine, 108 merge, 90 backflip, 78 Stalker, 120 Carrier, 82 Zergling, 86
  Baneling, 108 Overlord, 112 Battlecruiser, and 96 MULE;
- action-transition QC removed the old generic rings and fixed Marine muzzle
  attachment/visibility, Archon merge continuity, Battlecruiser arrival
  continuity, Zealot/Carrier ribbon presentation, and poster framing;
- packaging produced the exact 11 WebM/11 WebP delivery pairs. Every WebM
  decoded through libvpx to the manifest frame count and every paired output
  preserved an aggregate alpha range of 0–255;
- the rejected fallback/procedural batch is quarantined under the ignored
  `output/rejected-packaged-media-20260816` path and is not eligible for use.

The corrected media is staged under the ignored
`output/production-authentic-approved-packaged` build directory. Publication
to the web public directory remains a separate rights-reviewed operation; the
source M3/DDS files and generated derivatives are deliberately not committed.

## Delivery names

`render-manifest.json` is the single mapping authority. Its 11 unique
`deliveryBaseName` values exactly match the client contract:

- `zealot-dance-3d`
- `marine-skyfire-3d`
- `archon-merge-3d`
- `archon-backflip-3d`
- `stalker-blink-3d`
- `carrier-interceptors-3d`
- `zergling-zoomies-3d`
- `baneling-bowling-3d`
- `overlord-party-balloon-3d`
- `battlecruiser-warp-in-3d`
- `mule-money-drop-3d`

Do not rename source spec folders to these delivery names; rendering uses the
spec id, and packaging performs the explicit mapping.

## Approval checklist

- [ ] Tool and source versions recorded
- [ ] All required M3s and intended optional M3As validated
- [ ] Every primary texture requirement is `ready: true`
- [ ] Source-effect ledger is ready with zero unresolved items and no bypass
- [ ] 11 complete, contiguous 24-fps PNG sequences rendered
- [ ] Posters and animation extremes visually approved
- [ ] WebM alpha decode and browser playback passed
- [ ] All 11 WebM/WebP pairs use manifest delivery names
- [ ] Rights/project approval recorded
- [ ] No proprietary sources or intermediate build products staged in git

The alert catalog/widget integration can be reviewed independently from the
rights-controlled media. Rendered-media publication remains a separate,
explicitly approved operation.
