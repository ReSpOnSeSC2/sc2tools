# SC2 alert render pipeline

This directory is the offline build path for the real 3D StarCraft II alert
presets. It imports locally exported M3 units, selects native animation actions,
adds deterministic choreography, rebuilds Blender materials from M3Studio
metadata, frames the performance, and renders transparent 24-fps PNG sequences
plus posters. A separate packaging step produces the WebM/WebP names consumed by
the alert catalog.

No game models, animation exports, textures, Blender scenes, or generated
renders are bundled here. Supply them from a local export you are authorized to
use; the scripts never download or invent a replacement.

## Toolchain

- **Blender 4.5 LTS** is the validated staging version. As of 2026-08-17, the production
  smoke used portable Blender 4.5.12. M3Studio's Blender 5.x compatibility is
  still a concern tracked in [upstream issue #11](https://github.com/Solstice245/m3studio/issues/11),
  so pin the working 4.5/addon pair for a production batch.
- **M3Studio** must be unpacked with its package files intact and expose
  `bpy.ops.m3.import`. The renderer accepts either the package directory or its
  parent through `-M3AddonPath`.
- **Local M3/M3A and DDS exports** should preserve the `Assets/...` paths below.
  M3A files are optional: the main-model actions and code choreography remain a
  graceful fallback.
- **Python 3** and **FFmpeg with `libvpx-vp9` and `libwebp`** are required only
  for delivery packaging. Download FFmpeg from the
  [official FFmpeg download page](https://ffmpeg.org/download.html#build-windows),
  which links Windows users to [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)
  and [BtbN builds](https://github.com/BtbN/FFmpeg-Builds/releases). Verify the
  selected distributor's checksum before use; this repo does not download an
  executable.

Blender is configured for Eevee, transparent film, RGBA PNG, 768×768, and 24
fps. Transparent-film behavior is described in the
[Blender Film manual](https://docs.blender.org/manual/en/latest/render/cycles/render_settings/film.html).

## Expected local export layout

`render-manifest.json` contains the authoritative, extraction-verified paths.
Paths are relative to `-ModelsRoot`; absolute paths and `..` traversal are
rejected.

| Unit | Main M3 | Optional native-animation M3A |
| --- | --- | --- |
| Zealot | `Assets/Units/Protoss/Zealot_Ex2/Zealot_Ex2.m3` | `Assets/Units/Protoss/Zealot_SwarmAnims/Zealot_SwarmAnims.m3a` |
| Marine | `Assets/Units/Terran/Marine/Marine.m3` | `Assets/Units/Terran/Marine_SwarmAnims/Marine_SwarmAnims.m3a` |
| High Templar | `Assets/Units/Protoss/HighTemplar/HighTemplar.m3` | `Assets/Units/Protoss/HighTemplar_SwarmAnims/HighTemplar_SwarmAnims.m3a` |
| Archon | `Assets/Units/Protoss/Archon/Archon.m3` | `Assets/Units/Protoss/Archon_SwarmAnims/Archon_SwarmAnims.m3a` |
| Stalker | `Assets/Units/Protoss/Stalker/Stalker.m3` | `Assets/Units/Protoss/Stalker_SwarmAnims/Stalker_SwarmAnims.m3a` |
| Carrier | `Assets/Units/Protoss/Carrier/Carrier.m3` | — |
| Interceptor | `Assets/Units/Protoss/Interceptor/Interceptor.m3` | — |
| Zergling | `Assets/Units/Zerg/Zergling/Zergling.m3` | `Assets/Units/Zerg/Zergling_SwarmAnims/Zergling_SwarmAnims.m3a` |
| Baneling | `Assets/Units/Zerg/BanelingEx1/BanelingEx1.m3` | — |
| Overlord | `Assets/Units/Zerg/Overlord/Overlord.m3` | `Assets/Units/Zerg/Overlord_SwarmAnims/Overlord_SwarmAnims.m3a` |
| Battlecruiser | `Assets/Units/Terran/BattlecruiserEX2/BattlecruiserEX2.m3` | — |
| MULE | `Assets/Units/Terran/MULE/MULE.m3` | `Assets/Units/Terran/MULE_SwarmAnims/MULE_SwarmAnims.m3a` |

Referenced textures normally live beneath `Assets/Textures`. They may share the
model root or use a separate `-TexturesRoot`. In either case, the configured root
must contain the `Assets/Textures/...` path (do not point it at the `Textures`
directory itself). Preserve the paths reported by `-Inspect`; do not rename or
guess texture files.

### Auditable local CASC extraction

The requested [SC2 extraction tutorial](https://www.youtube.com/watch?v=DZqxPugJHcU)
opens the installed game storage in Ladik's CascView, wildcard-searches the
unit `.m3`, then wildcard-searches and batch-extracts its `.dds` dependencies.
This pipeline uses that same source boundary—the operator's installed SC2 CASC
and the real M3/DDS records—but replaces the unsigned GUI/wildcard step with a
pinned CascLib build and a reviewed exact-path manifest. That makes every
selected archive record reproducible, rejects ambiguous suffix matches, and
prevents a similarly named skin/variant from silently replacing the intended
unit. It is not a remodel, screenshot trace, or procedural substitute.

`extract_sc2_assets.cpp` is a source-only Windows helper for operators who own a
local StarCraft II install. Build it as C++17 against a pinned local
[Ladik CascLib](https://github.com/ladislav-zezula/CascLib) checkout and its
normal Windows dependencies; no CascLib binary or game data is bundled here.
It accepts the install root, output root, and one or more exact archive paths:

```powershell
sc2-casc-extract.exe `
  "C:\Program Files (x86)\StarCraft II" `
  ".\tools\sc2-alert-renders\models" `
  "Assets/Textures/Zealot_Diffuse.dds" `
  "Assets/Textures/Zealot_Normal.dds"
```

The helper attempts an exact CASC name first, then an auditable suffix lookup.
When the archive contains a base-game and Nova/Teen variant, it prefers the
single base-game candidate; every other ambiguity fails with all candidates
listed. It uses CascLib strict-data checking, rejects unsafe output paths,
writes through a temporary file, and returns nonzero when any requested asset
fails. The validated local run used CascLib 3.0 commit
`4971d363e665551ac4142f541e5f2d71f1cda653` and extracted 98/98 requested DDS
files (53,661,392 bytes; none empty). Those DDS files remain ignored local
inputs and were not committed.

## Windows workflow

Every environment variable below has a matching PowerShell parameter:

```powershell
$env:BLENDER_EXE = "D:\tools\blender-4.5.12\blender.exe"
$env:SC2_M3_ADDON = "D:\art-tools\m3studio"
$env:SC2_RENDER_MODELS = "D:\sc2-export"
$env:SC2_RENDER_TEXTURES = "D:\sc2-export"
$env:FFMPEG_EXE = "D:\tools\ffmpeg\bin\ffmpeg.exe"
$env:PYTHON_EXE = "C:\Python313\python.exe"
```

The explicit render parameters are `-BlenderPath`, `-M3AddonPath`,
`-ModelsRoot`, and `-TexturesRoot`. Packaging accepts `-FfmpegPath` and
`-PythonPath`; when the latter is omitted it discovers `python` on `PATH`.

List the 11 choreographies without Blender or source assets:

```powershell
.\tools\sc2-alert-renders\render-sc2-alerts.ps1 -List
```

Validate Blender, addon, all selected model paths, optional M3As, frame ranges,
and the manifest without launching Blender:

```powershell
.\tools\sc2-alert-renders\render-sc2-alerts.ps1 `
  -BlenderPath $env:BLENDER_EXE `
  -M3AddonPath $env:SC2_M3_ADDON `
  -ModelsRoot $env:SC2_RENDER_MODELS `
  -TexturesRoot $env:SC2_RENDER_TEXTURES `
  -ValidateOnly
```

Before extracting a large texture set, inspect the real M3 metadata:

```powershell
.\tools\sc2-alert-renders\render-sc2-alerts.ps1 `
  -Inspect `
  -OutputRoot "D:\sc2-alert-work\inspection"
```

Each `<spec>/inspection.json` contains, per role:

- the configured M3 and present M3A paths;
- render-mesh names;
- every native action candidate and source action/frame range;
- every M3 bitmap path, UV source, channel selection, and resolved local path.
- an exact-path `productionTextureGate` result for every manifest-declared
  primary surface/anatomy map, including its expected and imported M3 slots,
  Blender load error (if any), and readiness state.

The same details are logged to the console. Missing textures are reported
exactly; the inspector never guesses a bitmap name. Inspection is allowed to
construct neutral diagnostic materials because it writes no rendered media.

Render the three key visual-calibration posters:

```powershell
.\tools\sc2-alert-renders\render-sc2-alerts.ps1 `
  -Spec zealot-dance,marine-skyfire,carrier-interceptors `
  -PosterOnly `
  -AllowUnsupportedEffects `
  -OutputRoot "D:\sc2-alert-work\preview-01"
```

Poster and sequence renders enforce the primary DDS gate by default. They stop
before rendering when a required exact path is absent, does not match the
authored M3 slot, or cannot be loaded by Blender. While extracting textures, an
operator can make an explicitly non-production diagnostic poster with
`-AllowUntexturedPreview`. That switch prints a warning and its output must not
be packaged or published. `-AllowUnsupportedEffects` is a separate calibration
bypass for effect-heavy models; it never bypasses primary DDS validation, but
its output is likewise ineligible for packaging.

Render full sequences into a fresh versioned directory:

```powershell
.\tools\sc2-alert-renders\render-sc2-alerts.ps1 `
  -OutputRoot "D:\sc2-alert-work\production-01" `
  -KeepBlend
```

With no `-Spec`, all 11 entries are selected. Existing PNGs cause a hard stop.
`-Force` overwrites matching names but deliberately does not delete stale
frames; a new output root is safer for production. A completed default render
certifies the manifest-declared primary maps and writes an
`effect-realization.json` ledger. That ledger compares every imported effect
class with the source-effect realization pass and fails closed when any active
particle, ribbon, projection, or displacement material remains unresolved.
`-AllowUnsupportedEffects` is a diagnostic-only bypass and makes the result
ineligible for packaging.

Package complete PNG sequences and posters for the web client:

```powershell
.\tools\sc2-alert-renders\package-sc2-alerts.ps1 `
  -InputRoot "D:\sc2-alert-work\production-01" `
  -DeliveryRoot ".\apps\web\public\alerts\sc2-3d"
```

The packager requires a green per-spec `effect-realization.json` ledger plus a
contiguous `frame_0001.png`…`frame_NNNN.png` sequence. It refuses bypassed or
pre-ledger renders, encodes VP9 alpha WebM (`yuva420p`, `alpha_mode=1`) and a
WebP poster, then decodes every WebM with libvpx to prove the full frame count
and an aggregate alpha range of 0–255. It uses each manifest
`deliveryBaseName`: source folder `zealot-dance` becomes
`zealot-dance-3d.webm` and `zealot-dance-3d.webp`. Existing delivery files fail
closed unless `-Force` is passed.

## What the renderer does

### Native actions

M3Studio imports the main M3 with mesh, rig, effects, and animations. Each
present M3A is then imported into the created armature. Per-role
`nativeActions` entries select actions deterministically: ordered normalized
`prefer` matches first, then ordered `contains` matches. Selected actions are
placed in NLA segments and may loop or stretch to a configured fraction of the
alert.

The production choices include Zealot `Stand Dance`, Marine `Attack` followed
by `Stand Victory`, Carrier `Cover`, Zergling `Walk`, Baneling `Superior`, and
MULE `Stand Work`. If none match, the renderer logs the miss and continues with
root choreography rather than failing the whole batch.

### Materials and textures

M3Studio exposes `m3_materialrefs`, standard materials, mesh batch handles, and
`m3_materiallayers`, but it does not reliably build visible Blender shaders
([upstream issue #4](https://github.com/Solstice245/m3studio/issues/4), status
checked 2026-08-17). The
renderer reconstructs Principled materials for diffuse/team color, AO, normal,
gloss/specular, emissive, and alpha layers. It applies UV source, offset,
tiling, rotation, channel selection, inversion, multiply, and brightness where
metadata supplies them.

Texture resolution accepts only the exact archive-relative path beneath the
configured texture root (case-insensitive on the local filesystem). Basename
search and guessed relocation are forbidden. The manifest records, per source
M3, the inspection-verified primary diffuse/base-color, decal, normal,
specular/gloss, emissive, and alpha-bearing DDS paths plus their authored M3
slots. Before any ordinary render, Blender verifies that every required path is
still present in imported metadata, resolves exactly, and can be decoded.

The Principled reconstruction uses diffuse/team color, decal alpha, AO, normal,
inverse gloss/roughness, specular, emissive, and material alpha. Unsupported
material classes and missing optional FX maps may still receive diagnostic
handling, but a missing primary map can never silently become a pastel
production render. Channel-packed emissive layers use their authored A/R/G/B
selection rather than incorrectly lighting from the texture's RGB plane.

### Source particles, ribbons, and displacement

`m3_effect_realizer.py` samples the imported M3 particle metadata against the
selected native actions and pose bones. It reconstructs source emitters,
lifetimes, sizes, colors, alpha, rotation, flipbooks, gravity/drag, local/world
space, coherent noise, and the applicable radial/directional/damping/vortex
force channels as deterministic Eevee geometry. It retains and animates the
actual imported displacement-shell meshes with their authored normal and
strength DDS maps; it never creates a replacement unit silhouette.

`m3_ribbon_realizer.py` reconstructs imported ribbon strips/tubes from their
authored bones, subdivisions, lifetime/length culling, scale, twist, color,
UVs, materials, animation, and applicable force channels. This includes the
Zealot blade and charge trails, High Templar cape/dread trails, Carrier engine
trails, and four Interceptor smoke trails.

The per-spec ledger records imported, realized, dormant, and unresolved source
items. A dormant effect is accepted only when its authored active channel stays
disabled throughout the selected action. The one unavoidable transfer limit is
SC2's destination-framebuffer distortion: transparent Eevee/WebM cannot be
pixel-identical to the game renderer, so the genuine source shell/maps are
rendered as a translucent geometry proxy and the ledger emits an explicit
`SCREENSPACE_DISPLACEMENT_PROXY` warning.

### Camera and choreography

Automatic framing evaluates the actual animated render vertices—not just object
origins or oversized world bounding-box corners. Centered alerts target roughly
70% poster occupancy with only a 2% helper-FX expansion allowance. Long-travel,
blink, merge, jump, warp, and drop specs opt into sequence-wide framing.
Generic accent rings were removed from the final choreographies; only Stalker's
source/destination blink markers remain because they communicate the requested
teleport.

The Marine remains grounded while native attack/victory actions drive its body
and four bone-attached upward muzzle bursts supply the joke. Zealot body motion
comes from native `Stand Dance` plus its imported blade ribbons. Carrier uses
native `Cover`, its imported engine ribbons, and four separately imported real
Interceptor models with their smoke ribbons. The merge uses two imported High
Templars and the imported Archon; the backflip uses the imported Archon armor,
native action data, particles, and both genuine displacement shells. MULE money
uses coin-like beveled discs as the only intentionally synthetic prop. The
former procedural Archon humanoid and unrelated celebration rings are gone.

## Output layout

```text
output/
  zealot-dance/
    inspection.json             # with -Inspect
    effect-realization.json     # imported vs realized vs unresolved source effects
    frames/frame_0001.png ... frame_0096.png
    poster.png
    scene.blend                 # only with -KeepBlend
```

Keep PNG sequences as the lossless build source. Do not ask Blender to encode
the delivery video directly.

## Failure guide

- **Addon missing or no `m3.import`:** pass the package or its parent and pin
  the validated Blender/addon pair.
- **Optional M3A missing:** expected warning; main-model actions and root
  choreography continue.
- **Required M3 missing:** the error names the spec, role, resolved path, and
  relevant root.
- **Primary texture gate blocked:** run `-Inspect`, export the exact reported
  `Assets/Textures/...` paths, and pass the correct root. Check
  `productionTextureGate.requirements` for missing paths, slot mismatches, or
  Blender DDS decode errors. `-AllowUntexturedPreview` is diagnostic-only.
- **M3Studio logs `invalid operator call 'M3_OT_material_remove'`:** the current
  addon can emit this during background imports. Treat Blender's exit code,
  imported roles, inspection report, and visible poster as the actual gate.
- **Clipped or undersized subject:** adjust occupancy/framing mode before model
  scale. Use `-PosterOnly -KeepBlend` for visual calibration.
- **Packaging reports a frame gap:** render the complete sequence into a clean
  input root; the packager will not encode a partial animation.
- **Effect realization blocked:** inspect `effect-realization.json`. Production
  requires `ready: true` and zero unresolved imported effects; cap, texture,
  missing-bone, or unsupported-feature diagnostics fail closed.
- **Existing output:** use a new versioned root, or deliberately pass `-Force`.

## Contributor validation

These checks do not require proprietary inputs:

```powershell
python -m py_compile .\tools\sc2-alert-renders\blender_render.py .\tools\sc2-alert-renders\m3_effect_realizer.py .\tools\sc2-alert-renders\m3_ribbon_realizer.py .\tools\sc2-alert-renders\m3_effect_preview.py .\tools\sc2-alert-renders\package_media.py
python -m unittest discover .\tools\sc2-alert-renders -p test_package_media.py -v
Get-Content .\tools\sc2-alert-renders\render-manifest.json -Raw | ConvertFrom-Json | Out-Null
.\tools\sc2-alert-renders\render-sc2-alerts.ps1 -List
```

Production validation additionally requires `-ValidateOnly`, all-spec
`-Inspect`, visual checks across all 11 complete sequences, green source-effect
ledgers, packaging, an alpha decode check, and browser playback. See
[`docs/sc2-alert-render-pipeline.md`](../../docs/sc2-alert-render-pipeline.md)
for the release gate.

## Asset and rights boundary

Do not commit M3/M3A files, DDS textures, `.blend` files, inspection reports,
PNG sequences, or working renders from this directory. `.gitignore` blocks the
common local paths and extensions, but it is not a license check. The operator who exports and
publishes a render is responsible for permission to use the source assets and
for compliance with applicable Blizzard policies and platform rules.
