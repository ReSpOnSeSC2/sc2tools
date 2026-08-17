"""Standalone Blender preview for :mod:`m3_effect_realizer`.

This intentionally bypasses alert choreography helpers so an Archon preview
contains only the genuine imported M3 meshes plus source-derived effects. Run
through Blender, for example::

    blender --background --factory-startup --python m3_effect_preview.py -- \
      --unit archon --models-root ... --addon-path ... --output-root ...
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import bpy
from mathutils import Vector

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import blender_render as pipeline
from m3_effect_realizer import EffectBakeConfig, realize_armature_effects


UNITS = {
    "archon": {
        "model": "Assets/Units/Protoss/Archon/Archon.m3",
        "action": "Stand Work Start full",
        "frames": 96,
        "poster": 43,
        "target": (0.0, 0.0, 2.0),
        "ortho": 8.0,
        "fallback": "#6675B8",
    },
    "battlecruiser": {
        "model": "Assets/Units/Terran/BattlecruiserEX2/BattlecruiserEX2.m3",
        "action": "GLbirth 01 full",
        "frames": 112,
        "poster": 77,
        "target": (0.0, 0.0, 1.6),
        "ortho": 10.0,
        "fallback": "#566A7D",
    },
}


def parse_args() -> argparse.Namespace:
    raw = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unit", choices=sorted(UNITS), default="archon")
    parser.add_argument("--models-root", type=Path, required=True)
    parser.add_argument("--textures-root", type=Path)
    parser.add_argument("--addon-path", type=Path, required=True)
    parser.add_argument("--addon-module", default="m3studio")
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--max-particles", type=int, default=80)
    parser.add_argument("--max-total", type=int, default=600)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--poster-frame", type=int)
    parser.add_argument("--save-blend", action="store_true")
    return parser.parse_args(raw)


def bind_action(armature: bpy.types.Object, wanted: str, frame_start: int, frame_end: int) -> str:
    candidates = pipeline.native_action_candidates(
        pipeline.ModelRole("preview", None, None, armature, [], [], (0, 0, 0), (0, 0, 0))
    )
    candidate = next((row for row in candidates if row.label.casefold() == wanted.casefold()), None)
    if candidate is None:
        candidate = next((row for row in candidates if wanted.casefold() in row.label.casefold()), None)
    if candidate is None:
        labels = ", ".join(row.label for row in candidates)
        raise RuntimeError(f"Action {wanted!r} was not found. Available: {labels}")
    armature.animation_data_create()
    armature.animation_data.action = None
    track = armature.animation_data.nla_tracks.new()
    track.name = "M3_EFFECT_PREVIEW_NATIVE"
    action_start, action_end = (float(value) for value in candidate.action.frame_range)
    strip = track.strips.new(candidate.label, frame_start, candidate.action)
    strip.action_frame_start = action_start
    strip.action_frame_end = action_end
    strip.extrapolation = "NOTHING"
    strip.blend_type = "REPLACE"
    strip.scale = max(1.0, frame_end - frame_start) / max(1.0, action_end - action_start)
    strip.frame_end = frame_end
    return candidate.label


def camera_and_lights(scene: bpy.types.Scene, target: tuple[float, float, float], ortho: float) -> bpy.types.Object:
    camera_data = bpy.data.cameras.new("M3 Effect Preview Camera")
    camera = bpy.data.objects.new("M3 Effect Preview Camera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (7.5, -10.0, 6.5)
    camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = ortho
    scene.camera = camera
    center = Vector(target)
    pipeline.add_area_light("Preview Key", center + Vector((4.8, -4.5, 6.5)), center, (0.35, 0.8, 1.0, 1.0), 1200, 5)
    pipeline.add_area_light("Preview Fill", center + Vector((-5, -2, 3)), center, (0.55, 0.35, 1.0, 1.0), 800, 4)
    pipeline.add_area_light("Preview Rim", center + Vector((1, 5, 6)), center, (1, 0.82, 0.35, 1.0), 1400, 3.5)
    return camera


def main() -> int:
    args = parse_args()
    unit = UNITS[args.unit]
    models_root = args.models_root.resolve()
    textures_root = (args.textures_root or args.models_root).resolve()
    output = args.output_root.resolve() / args.unit
    output.mkdir(parents=True, exist_ok=True)

    pipeline.reset_blender()
    pipeline.enable_m3_addon(args.addon_path.resolve(), args.addon_module)
    spec = {
        "id": f"{args.unit}-effect-preview",
        "frameStart": 1,
        "frameEnd": unit["frames"],
        "resolution": {"width": 768, "height": 768, "percentage": 100},
        "render": {"samples": args.samples, "transparent": True},
        "import": {"mesh": True, "effects": True, "rig": True, "animations": True},
        "materials": {
            "teamColor": "#258DFF",
            "fallbackColor": unit["fallback"],
            "emissionStrength": 2.5,
        },
    }
    scene = pipeline.configure_scene(spec)
    relative = unit["model"]
    model = {
        "role": "hero",
        "path": relative,
        "absolutePath": models_root / Path(relative),
        "absoluteAnimationPaths": [],
        "scale": 1.0,
        "position": (0.0, 0.0, 0.0),
        "rotationDeg": (0.0, 0.0, 0.0),
    }
    role = pipeline.import_model(model, spec)
    selected_action = bind_action(role.armature, unit["action"], 1, unit["frames"])
    resolver = pipeline.TextureResolver(textures_root)
    pipeline.reconstruct_role_materials(role, resolver, spec)
    camera = camera_and_lights(scene, unit["target"], unit["ortho"])
    report = realize_armature_effects(
        role.armature,
        textures_root,
        scene=scene,
        camera=camera,
        source_objects=role.imported_objects,
        config=EffectBakeConfig(
            frame_start=1,
            frame_end=unit["frames"],
            max_particles_per_system=args.max_particles,
            max_particles_total=args.max_total,
        ),
    )
    payload = report.as_dict()
    payload["unit"] = args.unit
    payload["model"] = relative
    payload["selectedAction"] = selected_action
    poster_frame = args.poster_frame if args.poster_frame is not None else unit["poster"]
    if poster_frame < 1 or poster_frame > unit["frames"]:
        raise RuntimeError(f"poster frame must be within 1-{unit['frames']}; received {poster_frame}")
    payload["posterFrame"] = poster_frame
    (output / "effect-report.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    scene.frame_set(poster_frame)
    scene.render.filepath = str(output / "poster.png")
    bpy.ops.render.render(write_still=True)
    if args.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=str(output / "preview.blend"))
    print(f"[m3-effect-preview] Poster: {output / 'poster.png'}", flush=True)
    print(f"[m3-effect-preview] Report: {output / 'effect-report.json'}", flush=True)
    return 0 if report.usable else 2


if __name__ == "__main__":
    raise SystemExit(main())
