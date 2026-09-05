#!/usr/bin/env python3
"""Bake genuine M3 Attack clips into the replay's eight-facing sprite atlas.

Run inside Blender with --background --python-exit-code 1 --python <this> --
--models <M3 directory> --textures <extracted Assets/Textures directory>
--sprites <public/sprites/units> --output <staging directory> [--units Marine,...]

Each source pose is evaluated once and instanced into a single atlas render.
No idle clip, procedural body motion or projectile is substituted for Attack.
The staging metadata records the exact authored sequence and sampled frames.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import blender_render as render
from replay_sprite_additive import correct_additive_materials
import bpy
from mathutils import Matrix, Vector

WORLD_LADDER = [1.3, 1.7, 2.2, 2.85, 3.7, 4.8, 6.25, 8.1, 10.5, 13.7]
COLORS = {"red": "#E64C51", "blue": "#35B9D1"}
UP = Vector((0, math.sin(math.radians(60)), math.cos(math.radians(60))))
RIGHT = Vector((1, 0, 0))
CAMERA = Vector((0, -0.5, math.sin(math.radians(60))))


def args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--textures", type=Path, required=True)
    parser.add_argument("--sprites", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--addon", type=Path, default=Path("tmp/m3studio"))
    parser.add_argument("--units", default="")
    parser.add_argument("--inspect", action="store_true")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])


def source_group(armature):
    groups = [g for g in armature.m3_animation_groups if "attack" in g.name.lower().split()]
    # Prefer the model's ordinary weapon sequence; directional variants are
    # alternatives, not clips to concatenate or replace with idle animation.
    groups.sort(key=lambda g: (g.name != "Attack", len(g.name), g.name))
    for group in groups:
        anims = [a for a in group.animations if a.action and len(a.action.fcurves)]
        anims.sort(key=lambda a: (not a.name.lower().endswith("full"), -len(a.action.fcurves)))
        if anims and group.frame_end > group.frame_start:
            return group, anims[0]
    return None


def resolver_for(root):
    resolver = render.TextureResolver(root)
    # The extraction manifest stores this one archive directory flat. Restore
    # its known Assets/Textures prefix; never search arbitrary basenames.
    for file in root.iterdir():
        if file.is_file() and file.suffix.lower() == ".dds":
            resolver._relative[f"assets/textures/{file.name}".casefold()] = file
    return resolver


def correct_sprite_materials(role, color):
    """Honor SC2 diffuse team mask and its DXT5nm alpha/green packing.

    Reference: mdx-m3-viewer src/viewer/handlers/m3/shaders/layers.glsl.ts,
    computeLayerColor and decodeNormal. The alert renderer's generic RGB
    normal path is unsuitable for these stock game textures.
    """
    materials = {m for mesh in role.render_meshes for m in mesh.data.materials if m}
    modes = {}
    for ref in role.armature.m3_materialrefs:
        if ref.mat_type == "m3_materials_standard":
            native = render.m3_item_by_handle(role.armature.m3_materials_standard, str(ref.mat_handle))
            if native:
                modes[f"SC2_{role.name}_{ref.name}"] = native.blend_mode
    for material in materials:
        if modes.get(material.name, "OPAQUE") != "OPAQUE":
            continue
        nodes, links = material.node_tree.nodes, material.node_tree.links
        principled = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not principled:
            continue
        diffuse = next((n for n in nodes if n.name.endswith("/diff_IMAGE")), None)
        if diffuse:
            destinations = [link.to_socket for link in list(diffuse.outputs["Color"].links)]
            mix = nodes.new("ShaderNodeMixRGB")
            rgba = render.hex_color(color, "team color")
            mix.inputs[1].default_value = tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in rgba[:3]) + (1.0,)
            links.new(diffuse.outputs["Alpha"], mix.inputs[0])
            links.new(diffuse.outputs["Color"], mix.inputs[2])
            for socket in destinations:
                links.new(mix.outputs["Color"], socket)
        normal = next((n for n in nodes if n.name.endswith("/norm_IMAGE")), None)
        normal_map = next((n for n in nodes if n.type == "NORMAL_MAP"), None)
        if normal and normal_map:
            separate = nodes.new("ShaderNodeSeparateXYZ")
            links.new(normal.outputs["Color"], separate.inputs[0])
            def operation(kind, a, b=None):
                node = nodes.new("ShaderNodeMath")
                node.operation = kind
                if isinstance(a, (int, float)):
                    node.inputs[0].default_value = a
                else:
                    links.new(a, node.inputs[0])
                if b is not None:
                    if isinstance(b, (int, float)):
                        node.inputs[1].default_value = b
                    else:
                        links.new(b, node.inputs[1])
                return node.outputs[0]
            x = operation("SUBTRACT", operation("MULTIPLY", normal.outputs["Alpha"], 2), 1)
            y = operation("SUBTRACT", operation("MULTIPLY", separate.outputs["Y"], 2), 1)
            square = operation("ADD", operation("MULTIPLY", x, x), operation("MULTIPLY", y, y))
            z = operation("SQRT", operation("MAXIMUM", operation("SUBTRACT", 1, square), 0))
            combine = nodes.new("ShaderNodeCombineXYZ")
            links.new(normal.outputs["Alpha"], combine.inputs["X"])
            links.new(separate.outputs["Y"], combine.inputs["Y"])
            links.new(operation("MULTIPLY_ADD", z, 0.5), combine.inputs["Z"])
            # MULTIPLY_ADD's third input defaults to zero; add the 0.5 bias.
            combine.inputs["Z"].links[0].from_node.inputs[2].default_value = 0.5
            links.new(combine.outputs[0], normal_map.inputs["Color"])
        if not principled.inputs["Emission Color"].is_linked and principled.inputs["Base Color"].is_linked:
            links.new(principled.inputs["Base Color"].links[0].from_socket, principled.inputs["Emission Color"])
            principled.inputs["Emission Strength"].default_value = 0.35


def bake(name, race, sidecar, options):
    render.reset_blender()
    render.enable_m3_addon(options.addon, "m3studio")
    scene = render.configure_scene({"frameEnd": 30, "resolution": {"width": 2048, "height": 2048}, "render": {"samples": 32}})
    scene.render.fps = 30
    spec = {"import": {"mesh": True, "rig": True, "animations": True, "effects": False},
            "materials": {"teamColor": COLORS["red"], "emissionStrength": 1.1}}
    role = render.import_model({"role": name, "absolutePath": options.models / f"{name.lower()}.m3",
                               "scale": 1, "position": [0, 0, 0], "rotationDeg": [0, 0, 0]}, spec)
    # Sprite coordinates refer to the source model's ground origin. The alert
    # importer normally recenters it for choreography; remove that translation.
    role.container.location = (0, 0, 0)
    selected = source_group(role.armature)
    if selected is None:
        return {"unit": name, "status": "no_attack_sequence"}
    group, animation = selected
    # Long authored clips include seconds of recovery. Sample the initial
    # weapon gesture at useful temporal resolution, never stretch an eight-
    # frame sheet over that idle tail. Real shot events trigger each cycle.
    clip_end = min(group.frame_end, group.frame_start + 30)
    frames = [group.frame_start + i * (clip_end - group.frame_start) / 8 for i in range(8)]
    metadata = {"unit": name, "race": race, "group": group.name, "action": animation.name,
                "srcRange": [group.frame_start, clip_end], "authoredRange": [group.frame_start, group.frame_end],
                "srcFrames": frames, "srcFps": 30}
    print("[replay-attack] SOURCE " + json.dumps(metadata), flush=True)
    if options.inspect:
        print("[replay-attack] MATERIALS " + json.dumps([
            {"name": m.name, "layer": m.blend_mode_layer, "blend": m.blend_mode,
             "properties": {p.identifier: str(getattr(m, p.identifier)) for p in m.bl_rna.properties if "team" in p.identifier}}
            for m in role.armature.m3_materials_standard]), flush=True)
        return {**metadata, "status": "available"}
    resolver = resolver_for(options.textures)
    render.reconstruct_role_materials(role, resolver, spec)
    correct_sprite_materials(role, COLORS["red"])
    correct_additive_materials(role)
    role.armature.animation_data_create()
    role.armature.animation_data.action = animation.action
    pose_meshes = []
    bounds = [float("inf"), -float("inf"), float("inf"), -float("inf")]
    for frame in frames:
        scene.frame_set(math.floor(frame), subframe=frame % 1)
        bpy.context.view_layer.update()
        depsgraph = bpy.context.evaluated_depsgraph_get()
        baked = []
        for mesh in role.render_meshes:
            if mesh.hide_render:
                continue
            evaluated = mesh.evaluated_get(depsgraph)
            data = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
            data.transform(evaluated.matrix_world)
            baked.append(data)
            for facing in range(8):
                rotation = Matrix.Rotation(facing * math.pi / 4, 4, "Z")
                for vertex in data.vertices:
                    position = rotation @ vertex.co
                    x, y = position.dot(RIGHT), position.dot(UP)
                    bounds[0] = min(bounds[0], x)
                    bounds[1] = max(bounds[1], x)
                    bounds[2] = min(bounds[2], y)
                    bounds[3] = max(bounds[3], y)
        pose_meshes.append(baked)
    width = max(abs(bounds[0]), abs(bounds[1])) * 2
    height = bounds[3] - bounds[2]
    need = max(width, height) * 1.12
    wupc = next((size for size in WORLD_LADDER if size >= need), None)
    if wupc is None:
        raise ValueError(f"{name}: attack silhouette exceeds supported world scale ({need})")
    center_y = (bounds[2] + bounds[3]) / 2
    anchor = [128, 128 + center_y / wupc * 256]
    for obj in role.imported_objects:
        obj.hide_render = True
    for facing in range(8):
        rotation = Matrix.Rotation(facing * math.pi / 4, 4, "Z")
        for frame, meshes in enumerate(pose_meshes):
            shift = RIGHT * ((frame - 3.5) * wupc) + UP * ((3.5 - facing) * wupc - center_y)
            for index, mesh in enumerate(meshes):
                obj = bpy.data.objects.new(f"Attack_{facing}_{frame}_{index}", mesh)
                scene.collection.objects.link(obj)
                obj.matrix_world = Matrix.Translation(shift) @ rotation
    camera_data = bpy.data.cameras.new("Replay atlas camera")
    camera = bpy.data.objects.new("Replay atlas camera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = CAMERA * (wupc * 20)
    camera.rotation_euler = (-camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = wupc * 8
    camera_data.clip_end = wupc * 100
    scene.camera = camera
    for label, energy, angle in [("Key", 2.5, (25, -25, -20)), ("Fill", 1.2, (60, 25, 145))]:
        light_data = bpy.data.lights.new(label, "SUN")
        light_data.energy = energy
        light_data.use_shadow = False
        light = bpy.data.objects.new(label, light_data)
        scene.collection.objects.link(light)
        light.rotation_euler = tuple(math.radians(v) for v in angle)
    output = options.output / race
    output.mkdir(parents=True, exist_ok=True)
    for color, hex_color in COLORS.items():
        # Rebuilding updates the same material datablocks used by baked meshes.
        spec["materials"]["teamColor"] = hex_color
        render.reconstruct_role_materials(role, resolver, spec)
        correct_sprite_materials(role, hex_color)
        correct_additive_materials(role)
        scene.render.filepath = str(output / f"{name}_{color}_Attack.png")
        bpy.ops.render.render(write_still=True)
    duration = (clip_end - group.frame_start) / 30
    result = {**metadata, "status": "baked", "frameSize": 256, "facings": 8,
              "anims": {"Attack": {"frames": 8, "fps": 8 / duration, "sheetSize": [2048, 2048],
                "worldUnitsPerCell": wupc, "anchor": anchor}}, "projection": "orthographic", "cameraPitchDeg": 60}
    (output / f"{name}_Attack.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print("[replay-attack] BAKED " + name, flush=True)
    return result


def main():
    options = args()
    for key in ("models", "textures", "sprites", "output", "addon"):
        setattr(options, key, getattr(options, key).resolve())
    allowed = set(options.units.split(",")) if options.units else None
    report = []
    for sidecar_path in sorted(options.sprites.glob("*/*_red.json")):
        name = sidecar_path.name[:-len("_red.json")]
        if allowed is not None and name not in allowed:
            continue
        if not (options.models / f"{name.lower()}.m3").is_file():
            continue
        try:
            report.append(bake(name, sidecar_path.parent.name, json.loads(sidecar_path.read_text()), options))
        except Exception as error:
            import traceback
            traceback.print_exc()
            report.append({"unit": name, "status": "failed", "error": str(error)})
        options.output.mkdir(parents=True, exist_ok=True)
        (options.output / "attack-bake-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if any(entry["status"] == "failed" for entry in report):
        raise RuntimeError("One or more attack bakes failed; see attack-bake-report.json")


if __name__ == "__main__":
    main()
