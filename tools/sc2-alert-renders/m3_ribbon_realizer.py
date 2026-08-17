#!/usr/bin/env python3
"""Realize M3Studio ribbon metadata as animated Eevee mesh geometry.

M3Studio imports ``m3_ribbons`` and ``m3_ribbonsplines`` as metadata on the
armature object; it does not create renderable Blender objects for them.  This
module converts that imported data into deterministic, camera-aware meshes for
the offline SC2 alert renderer.  It uses only the imported M3 bones, authored
ribbon parameters, and exact M3 material-layer bitmap references.  It does not
create replacement units or synthetic unit effects.

The intended call site is after native NLA actions and root choreography have
been installed and after the alert camera exists::

    ribbons = realize_m3_ribbons(
        context.roles,
        scene=context.scene,
        textures_root=textures_root,
        frame_start=context.frame_start,
        frame_end=context.frame_end,
        strict_textures=True,
        log=log,
    )

Keep the returned ``RibbonRealization`` alive through ``bpy.ops.render``.  Its
frame-change handler swaps the cached ribbon geometry before every rendered
frame.  Call ``dispose()`` when a long-lived Blender process is finished with
the scene.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

try:
    import bpy  # type: ignore[import-not-found]
    from mathutils import Euler, Matrix, Quaternion, Vector  # type: ignore[import-not-found]
except ModuleNotFoundError:  # Allows ordinary Python to syntax-check the file.
    bpy = None
    Euler = None
    Matrix = None
    Quaternion = None
    Vector = None


RIBBON_COLOR_ATTRIBUTE = "M3RibbonColor"
RIBBON_UV_LAYER = "uv0"
_DRIVE_EPSILON = 1.0e-6
_SAFE_TEXTURE_SUFFIXES = frozenset({".dds", ".png", ".tga", ".tif", ".tiff", ".jpg", ".jpeg", ".exr"})


class RibbonRealizationError(RuntimeError):
    """A ribbon cannot be realized without silently losing authored data."""


@dataclass(frozen=True)
class RibbonDiagnostic:
    status: str
    role: str
    ribbon: str
    bone: str
    ribbon_type: str
    cull_method: str
    material: str
    material_type: str
    textures: tuple[str, ...]
    missing_textures: tuple[str, ...]
    active_frames: int
    maximum_points: int
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class _EmissionSample:
    birth_frame: float
    generation: int
    world_space: bool
    position: Any
    direction: Any
    side_hint: Any
    up_hint: Any
    position_local: Any
    direction_local: Any
    side_local: Any
    up_local: Any
    speed: float
    gravity: float
    drag: float
    lifespan: float
    length: float
    cull_method: str
    widths: tuple[float, float, float]
    width_midpoint: float
    width_smoothing: str
    twists: tuple[float, float, float]
    twist_midpoint: float
    colors: tuple[tuple[float, float, float, float], ...]
    color_midpoint: float
    alpha_midpoint: float
    color_smoothing: str
    noise_amplitude: float
    noise_frequency: float
    noise_cohesion: float
    emitter_scale: float


@dataclass(frozen=True)
class _ForceBinding:
    """One source M3 force selected by an authored ribbon channel mask."""

    key: str
    name: str
    force: Any
    pose_bone: Any
    scope: str
    channels: tuple[int, ...]


@dataclass(frozen=True)
class _ForceState:
    """Evaluated radial-sphere force state at one deterministic bake time."""

    frame: float
    key: str
    name: str
    center: Any
    radius: float
    strength: float
    falloff: bool
    unbounded: bool


@dataclass(frozen=True)
class _ForceTimeline:
    states: Mapping[str, tuple[_ForceState, ...]]


@dataclass(frozen=True)
class _TrailPoint:
    position: Any
    side_hint: Any
    up_hint: Any
    width: float
    twist: float
    color: tuple[float, float, float, float]
    progress: float


@dataclass
class _FrameGeometry:
    vertices: list[tuple[float, float, float]] = field(default_factory=list)
    faces: list[tuple[int, ...]] = field(default_factory=list)
    face_uvs: list[tuple[tuple[float, float], ...]] = field(default_factory=list)
    vertex_colors: list[tuple[float, float, float, float]] = field(default_factory=list)


@dataclass
class _TextureBinding:
    layer: Any
    mapping: Any
    texture: Any


@dataclass
class _RibbonRuntime:
    role_name: str
    armature: Any
    ribbon: Any
    emitter_bone: Any
    ribbon_type: str
    cull_method: str
    render_object: Any
    material_bindings: list[_TextureBinding]
    frame_trails: dict[int, list[list[_TrailPoint]]]
    frame_geometries: dict[int, _FrameGeometry]
    diagnostic: RibbonDiagnostic


@dataclass
class RibbonRealization:
    """Own the realized objects, diagnostics, and the live frame handler."""

    objects: list[Any]
    diagnostics: list[RibbonDiagnostic]
    _handler: Callable[..., None]
    _runtimes: list[_RibbonRuntime]
    _disposed: bool = False

    @property
    def realized_count(self) -> int:
        return len(self.objects)

    @property
    def active_count(self) -> int:
        return sum(
            diagnostic.status == "REALIZED" and diagnostic.active_frames > 0
            for diagnostic in self.diagnostics
        )

    @property
    def missing_texture_paths(self) -> tuple[str, ...]:
        return tuple(
            sorted(
                {
                    path
                    for diagnostic in self.diagnostics
                    for path in diagnostic.missing_textures
                },
                key=str.casefold,
            )
        )

    def update(self, scene: Any | None = None) -> None:
        """Force geometry for the current frame (useful before a still render)."""

        if self._disposed:
            raise RibbonRealizationError("This ribbon realization has already been disposed.")
        target_scene = scene or bpy.context.scene
        self._handler(target_scene, None)

    def dispose(self, *, remove_objects: bool = False) -> None:
        """Detach the handler and optionally remove generated objects and meshes."""

        if self._disposed:
            return
        if self._handler in bpy.app.handlers.frame_change_post:
            bpy.app.handlers.frame_change_post.remove(self._handler)
        if remove_objects:
            for obj in self.objects:
                mesh = getattr(obj, "data", None)
                if obj.name in bpy.data.objects:
                    bpy.data.objects.remove(obj, do_unlink=True)
                if mesh is not None and mesh.name in bpy.data.meshes and mesh.users == 0:
                    bpy.data.meshes.remove(mesh)
        self._disposed = True


class _ExactTextureIndex:
    """Case-insensitive exact archive-path resolver; basename guessing is forbidden."""

    def __init__(self, root: Path):
        self.root = root.resolve()
        if not self.root.is_dir():
            raise RibbonRealizationError(f"Ribbon texture root does not exist: {self.root}")
        self._paths: dict[str, Path] = {}
        for candidate in self.root.rglob("*"):
            if not candidate.is_file() or candidate.suffix.casefold() not in _SAFE_TEXTURE_SUFFIXES:
                continue
            relative = candidate.relative_to(self.root).as_posix()
            key = relative.casefold()
            previous = self._paths.get(key)
            if previous is not None and previous != candidate:
                raise RibbonRealizationError(
                    "Ribbon texture root contains case-colliding archive paths: "
                    f"{previous} and {candidate}."
                )
            self._paths[key] = candidate

    def resolve(self, raw_path: str) -> Path | None:
        normalized = _normalize_texture_reference(raw_path)
        return self._paths.get(normalized.casefold()) if normalized else None


def _normalize_texture_reference(raw_path: str) -> str | None:
    normalized = str(raw_path).strip().replace("\\", "/")
    if not normalized or normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        return None
    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return None
    suffix = Path(normalized).suffix.casefold()
    if suffix not in _SAFE_TEXTURE_SUFFIXES:
        return None
    return "/".join(parts)


def _m3_item_by_handle(collection: Iterable[Any], handle: str) -> Any | None:
    if not handle:
        return None
    for item in collection:
        if str(getattr(item, "bl_handle", "")) == handle:
            return item
    return None


def _pointer_handle(pointer: Any) -> str:
    return str(getattr(pointer, "handle", ""))


def _resolve_pose_bone(armature: Any, pointer: Any) -> Any | None:
    return _m3_item_by_handle(getattr(armature.pose, "bones", ()), _pointer_handle(pointer))


def _resolve_material(armature: Any, ribbon: Any) -> tuple[Any | None, Any | None, str]:
    matref = _m3_item_by_handle(
        getattr(armature, "m3_materialrefs", ()), _pointer_handle(getattr(ribbon, "material", None))
    )
    if matref is None:
        return None, None, ""
    mat_type = str(getattr(matref, "mat_type", ""))
    material = _m3_item_by_handle(
        getattr(armature, mat_type, ()), str(getattr(matref, "mat_handle", ""))
    )
    return matref, material, mat_type


def _material_layer(armature: Any, material: Any, slot: str) -> Any | None:
    handle = str(getattr(material, f"layer_{slot}", ""))
    return _m3_item_by_handle(getattr(armature, "m3_materiallayers", ()), handle)


def _inspect_material_textures(
    armature: Any,
    ribbon: Any,
    texture_index: _ExactTextureIndex,
) -> tuple[str, str, tuple[str, ...], tuple[str, ...]]:
    """Resolve and Blender-decode every bitmap referenced by a ribbon material."""

    matref, source, mat_type = _resolve_material(armature, ribbon)
    if matref is None or source is None:
        return "(unresolved)", mat_type, (), ("(unresolved M3 material handle)",)
    material_name = str(getattr(matref, "name", "M3 Ribbon Material"))
    slots_by_type = {
        "m3_materials_standard": (
            "diff",
            "decal",
            "spec",
            "gloss",
            "emis1",
            "emis2",
            "alpha1",
            "alpha2",
            "norm",
            "height",
            "light",
            "ao",
        ),
        "m3_materials_displacement": ("norm", "strength"),
    }
    requested: list[str] = []
    missing: list[str] = []
    for slot in slots_by_type.get(mat_type, ()):
        layer = _material_layer(armature, source, slot)
        if layer is None or str(getattr(layer, "color_type", "")) != "BITMAP":
            continue
        raw_path = str(getattr(layer, "color_bitmap", "")).strip()
        normalized = _normalize_texture_reference(raw_path)
        if normalized is None:
            missing.append(raw_path or "(empty/unsafe M3 texture reference)")
            continue
        requested.append(normalized)
        resolved = texture_index.resolve(normalized)
        if resolved is None:
            missing.append(normalized)
            continue
        try:
            bpy.data.images.load(str(resolved), check_existing=True)
        except Exception as exc:
            missing.append(f"{normalized} ({exc})")
    return (
        material_name,
        mat_type,
        tuple(dict.fromkeys(requested)),
        tuple(dict.fromkeys(missing)),
    )


def _active_output_frame_count(ribbon: Any, scene: Any, frame_start: int, frame_end: int) -> int:
    active = 0
    for frame in range(frame_start, frame_end + 1):
        _scene_set_frame(scene, float(frame))
        active += bool(getattr(ribbon, "active", True))
    return active


def _force_bindings(armature: Any, ribbon: Any) -> list[_ForceBinding]:
    """Resolve the source forces whose masks overlap this ribbon's masks.

    Local force channels only address forces in the same M3 model.  World
    channels can address forces owned by other model instances and therefore
    remain outside this per-armature baker.
    """

    local_channels = {
        index for index, enabled in enumerate(getattr(ribbon, "local_forces", ())) if bool(enabled)
    }
    world_channels = {
        index for index, enabled in enumerate(getattr(ribbon, "world_forces", ())) if bool(enabled)
    }
    bindings: list[_ForceBinding] = []
    for force_index, force in enumerate(getattr(armature, "m3_forces", ())):
        force_channels = {
            index for index, enabled in enumerate(getattr(force, "channels", ())) if bool(enabled)
        }
        matched_local = tuple(sorted(local_channels & force_channels))
        matched_world = tuple(sorted(world_channels & force_channels))
        pose_bone = _resolve_pose_bone(armature, getattr(force, "bone", None))
        raw_handle = str(getattr(force, "bl_handle", ""))
        name = str(getattr(force, "name", "") or f"Force_{force_index + 1}")
        key = raw_handle or f"{force_index}:{name}"
        if matched_local:
            bindings.append(_ForceBinding(key, name, force, pose_bone, "LOCAL", matched_local))
        if matched_world:
            bindings.append(_ForceBinding(key, name, force, pose_bone, "WORLD", matched_world))
    return bindings


def _supported_force_reasons(binding: _ForceBinding) -> list[str]:
    """Return reasons an authored force cannot be represented exactly enough."""

    force = binding.force
    reasons: list[str] = []
    if binding.scope != "LOCAL":
        reasons.append(
            f"M3 force {binding.name!r} uses world channel(s) {list(binding.channels)}; "
            "cross-model world-force discovery is unavailable in this per-model bake"
        )
        return reasons
    if binding.pose_bone is None:
        reasons.append(f"M3 force {binding.name!r} references a missing M3 pose-bone handle")
    force_type = str(getattr(force, "force_type", ""))
    shape = str(getattr(force, "shape", ""))
    if force_type != "RADIAL" or shape != "SPHERE":
        reasons.append(
            f"M3 force {binding.name!r} ({force_type}/{shape}) is outside the validated "
            "local RADIAL/SPHERE solver"
        )
    if bool(getattr(force, "height_gradient", False)):
        reasons.append(f"M3 force {binding.name!r} authors an unvalidated height gradient")
    for field_name in ("strength", "width"):
        try:
            field_value = float(getattr(force, field_name, 0.0))
        except (TypeError, ValueError):
            reasons.append(f"M3 force {binding.name!r} has a non-numeric {field_name}")
            continue
        if not math.isfinite(field_value):
            reasons.append(f"M3 force {binding.name!r} has a non-finite {field_name}")
    if float(getattr(force, "width", 0.0)) <= _DRIVE_EPSILON and not bool(
        getattr(force, "unbounded", False)
    ):
        reasons.append(f"M3 force {binding.name!r} has no positive SPHERE radius")
    return reasons


def _unsupported_capability_reasons(armature: Any, ribbon: Any, spline: Any | None, active_frames: int) -> list[str]:
    if active_frames == 0:
        return []
    _matref, source, mat_type = _resolve_material(armature, ribbon)
    reasons: list[str] = []
    if mat_type not in {"m3_materials_standard", "m3_materials_displacement"}:
        reasons.append(f"unvalidated M3 material class {mat_type!r}")
    if source is not None:
        for slot in (
            "diff",
            "decal",
            "spec",
            "gloss",
            "emis1",
            "emis2",
            "alpha1",
            "alpha2",
            "norm",
            "height",
            "light",
            "ao",
            "strength",
        ):
            layer = _material_layer(armature, source, slot)
            if layer is None or str(getattr(layer, "color_type", "")) != "BITMAP":
                continue
            uv_source = str(getattr(layer, "uv_source", "UV0"))
            if uv_source not in {"UV0", "PLANARWZ"}:
                reasons.append(f"material slot {slot} uses unvalidated UV source {uv_source!r}")
    if spline is not None and len(getattr(spline, "points", ())) > 0:
        reasons.append("active SRIB spline simulation has not been validated against the SC2 runtime")
    if str(getattr(ribbon, "ribbon_type", "PLANAR_BILLBOARD")) == "STAR":
        reasons.append("active STAR cross-sections have not been validated on a local Blizzard ribbon")
    for property_name in ("speed_randomize", "lifespan_randomize", "mass_randomize"):
        if bool(getattr(ribbon, property_name, False)):
            reasons.append(f"{property_name} is authored but M3Studio does not expose both random endpoints")
    if bool(getattr(ribbon, "collide_terrain", False)) or bool(getattr(ribbon, "collide_objects", False)):
        reasons.append("ribbon collision is authored but unavailable in this deterministic offline bake")
    for binding in _force_bindings(armature, ribbon):
        reasons.extend(_supported_force_reasons(binding))
    supported_variations = {"NONE", "SIN", "COS", "SAW", "SQUARE", "NOISE_RANDOM", "NOISE_CONTINUOUS"}
    for prefix in ("yaw", "pitch", "length", "scale", "alpha"):
        shape = str(getattr(ribbon, f"{prefix}_var_shape", "NONE"))
        amplitude = abs(float(getattr(ribbon, f"{prefix}_var_amplitude", 0.0)))
        if amplitude <= _DRIVE_EPSILON:
            continue
        if prefix == "alpha":
            reasons.append("active alpha overlay is authored but its SC2 0..255 normalization is unresolved")
        elif shape not in supported_variations:
            reasons.append(f"active {prefix} variation shape {shape!r} is outside the locally validated subset")
    if abs(float(getattr(ribbon, "spread_x", 0.0))) > _DRIVE_EPSILON or abs(
        float(getattr(ribbon, "spread_y", 0.0))
    ) > _DRIVE_EPSILON:
        reasons.append("authored ribbon emission spread is outside the deterministic source subset")
    if bool(getattr(ribbon, "inherit_parent_velocity", False)):
        reasons.append("authored parent-velocity inheritance is outside the deterministic source subset")
    if abs(float(getattr(ribbon, "noise_amplitude", 0.0))) > _DRIVE_EPSILON:
        reasons.append(
            "post-simulation ribbon noise is authored, but its proprietary SC2 noise field is not reproduced"
        )
    return reasons


def _iter_roles(roles: Mapping[str, Any] | Iterable[Any]) -> list[tuple[str, Any, Any]]:
    entries = list(roles.items()) if isinstance(roles, Mapping) else [("", role) for role in roles]
    result: list[tuple[str, Any, Any]] = []
    for key, role in entries:
        armature = getattr(role, "armature", None)
        if armature is None and getattr(role, "type", None) == "ARMATURE":
            armature = role
        if armature is None:
            continue
        role_name = str(key or getattr(role, "name", "") or armature.name)
        result.append((role_name, armature, role))
    return result


def _as_color(value: Sequence[float]) -> tuple[float, float, float, float]:
    values = tuple(float(component) for component in value)
    return (
        max(0.0, min(1.0, values[0] if len(values) > 0 else 1.0)),
        max(0.0, min(1.0, values[1] if len(values) > 1 else 1.0)),
        max(0.0, min(1.0, values[2] if len(values) > 2 else 1.0)),
        max(0.0, min(1.0, values[3] if len(values) > 3 else 1.0)),
    )


def _three_values(value: Sequence[float], default: float = 0.0) -> tuple[float, float, float]:
    values = tuple(float(component) for component in value)
    return (
        values[0] if len(values) > 0 else default,
        values[1] if len(values) > 1 else default,
        values[2] if len(values) > 2 else default,
    )


def _normalized(vector: Any, fallback: tuple[float, float, float]) -> Any:
    candidate = Vector(vector)
    if candidate.length_squared <= _DRIVE_EPSILON:
        return Vector(fallback)
    candidate.normalize()
    return candidate


def _bone_world_matrix(armature: Any, pose_bone: Any) -> Any:
    return armature.matrix_world @ pose_bone.matrix


def _scene_set_frame(scene: Any, frame: float) -> None:
    whole = math.floor(frame)
    subframe = max(0.0, min(0.999999, frame - whole))
    scene.frame_set(int(whole), subframe=subframe)
    bpy.context.view_layer.update()


def _variation(shape: str, amplitude: float, frequency: float, time_seconds: float, seed: float) -> float:
    if abs(amplitude) <= _DRIVE_EPSILON or shape == "NONE":
        return 0.0
    phase = time_seconds * max(0.0, frequency) + seed
    fraction = phase - math.floor(phase)
    if shape == "SIN":
        value = math.sin(phase * math.tau)
    elif shape == "COS":
        value = math.cos(phase * math.tau)
    elif shape == "SAW":
        value = fraction * 2.0 - 1.0
    elif shape == "SQUARE":
        value = 1.0 if fraction < 0.5 else -1.0
    elif shape == "NOISE_CONTINUOUS":
        # Smooth deterministic value noise; no random state enters production renders.
        cell = math.floor(phase)
        blend = fraction * fraction * (3.0 - 2.0 * fraction)
        left = math.sin((cell + seed * 17.0) * 12.9898) * 43758.5453
        right = math.sin((cell + 1.0 + seed * 17.0) * 12.9898) * 43758.5453
        left = (left - math.floor(left)) * 2.0 - 1.0
        right = (right - math.floor(right)) * 2.0 - 1.0
        value = left + (right - left) * blend
    else:  # NOISE_RANDOM and unknown future enum values use stable stepped noise.
        noise = math.sin((math.floor(phase) + seed * 19.0) * 12.9898) * 43758.5453
        value = (noise - math.floor(noise)) * 2.0 - 1.0
    return value * amplitude


def _sample_emission(
    armature: Any,
    ribbon: Any,
    emitter_bone: Any,
    birth_frame: float,
    generation: int,
    fps: float,
    stable_seed: float,
) -> _EmissionSample:
    matrix = _bone_world_matrix(armature, emitter_bone)
    basis = matrix.to_3x3()
    root_inverse = armature.matrix_world.inverted_safe()
    root_basis_inverse = armature.matrix_world.to_3x3().inverted_safe()
    time_seconds = birth_frame / fps
    phase_shift = float(getattr(ribbon, "phase_shift", 0.0))
    # M3Studio exposes base yaw/pitch as Blender rotation values (radians),
    # while SC2 ribbon overlay amplitudes remain authored in degrees.  The
    # overlay is evaluated once at segment creation and stays fixed for that
    # segment, matching the StarCraft II Art Tools contract.
    yaw = float(getattr(ribbon, "yaw", 0.0)) + math.radians(_variation(
        str(getattr(ribbon, "yaw_var_shape", "NONE")),
        float(getattr(ribbon, "yaw_var_amplitude", 0.0)),
        float(getattr(ribbon, "yaw_var_frequency", 0.0)),
        time_seconds,
        phase_shift + stable_seed * 0.137,
    ))
    pitch = float(getattr(ribbon, "pitch", 0.0)) + math.radians(_variation(
        str(getattr(ribbon, "pitch_var_shape", "NONE")),
        float(getattr(ribbon, "pitch_var_amplitude", 0.0)),
        float(getattr(ribbon, "pitch_var_frequency", 0.0)),
        time_seconds,
        phase_shift + stable_seed * 0.173 + 11.0,
    ))
    direction_local = Euler((pitch, yaw, 0.0), "XYZ").to_matrix() @ Vector((0.0, 0.0, 1.0))
    direction = _normalized(basis @ direction_local, (0.0, 0.0, 1.0))
    side_hint = _normalized(basis.col[0], (1.0, 0.0, 0.0))
    up_hint = _normalized(basis.col[1], (0.0, 1.0, 0.0))
    scale_variation = 1.0 + _variation(
        str(getattr(ribbon, "scale_var_shape", "NONE")),
        float(getattr(ribbon, "scale_var_amplitude", 0.0)),
        float(getattr(ribbon, "scale_var_frequency", 0.0)),
        time_seconds,
        phase_shift + stable_seed * 0.211 + 23.0,
    )
    length = max(0.0, float(getattr(ribbon, "length", 0.0)))
    length += _variation(
        str(getattr(ribbon, "length_var_shape", "NONE")),
        float(getattr(ribbon, "length_var_amplitude", 0.0)),
        float(getattr(ribbon, "length_var_frequency", 0.0)),
        time_seconds,
        phase_shift + stable_seed * 0.257 + 37.0,
    )
    emitter_scale = sum(abs(value) for value in matrix.to_scale()) / 3.0
    widths = tuple(max(0.0, value * scale_variation) for value in _three_values(getattr(ribbon, "scale", (1, 1, 1)), 1.0))
    return _EmissionSample(
        birth_frame=birth_frame,
        generation=generation,
        world_space=bool(getattr(ribbon, "world_space", True)),
        position=matrix.translation.copy(),
        direction=direction,
        side_hint=side_hint,
        up_hint=up_hint,
        position_local=root_inverse @ matrix.translation,
        direction_local=_normalized(root_basis_inverse @ direction, (0.0, 0.0, 1.0)),
        side_local=_normalized(root_basis_inverse @ side_hint, (1.0, 0.0, 0.0)),
        up_local=_normalized(root_basis_inverse @ up_hint, (0.0, 1.0, 0.0)),
        speed=max(0.0, float(getattr(ribbon, "speed", 0.0))),
        gravity=float(getattr(ribbon, "gravity", 0.0)),
        drag=max(0.0, float(getattr(ribbon, "drag", 0.0))),
        lifespan=max(1.0 / fps, float(getattr(ribbon, "lifespan", 1.0))),
        length=max(0.0, length),
        cull_method=str(getattr(ribbon, "cull_method", "TIME")),
        widths=widths,
        width_midpoint=float(getattr(ribbon, "scale_anim_mid", 0.5)),
        width_smoothing=str(getattr(ribbon, "scale_smoothing", "LINEAR")),
        twists=_three_values(getattr(ribbon, "twist", (0, 0, 0))),
        twist_midpoint=float(getattr(ribbon, "twist_anim_mid", 0.5)),
        colors=(
            _as_color(getattr(ribbon, "color_base", (1, 1, 1, 1))),
            _as_color(getattr(ribbon, "color_mid", (1, 1, 1, 1))),
            _as_color(getattr(ribbon, "color_tip", (1, 1, 1, 0))),
        ),
        color_midpoint=float(getattr(ribbon, "color_anim_mid", 0.5)),
        alpha_midpoint=float(getattr(ribbon, "alpha_anim_mid", 0.5)),
        color_smoothing=str(getattr(ribbon, "color_smoothing", "LINEAR")),
        noise_amplitude=max(0.0, float(getattr(ribbon, "noise_amplitude", 0.0))),
        noise_frequency=max(0.0, float(getattr(ribbon, "noise_frequency", 0.0))),
        noise_cohesion=max(0.0, float(getattr(ribbon, "noise_cohesion", 0.0))),
        emitter_scale=max(_DRIVE_EPSILON, emitter_scale),
    )


def _smoothing(value: float, mode: str) -> float:
    clamped = max(0.0, min(1.0, value))
    if mode.startswith("BEZIER"):
        return clamped * clamped * (3.0 - 2.0 * clamped)
    if mode.endswith("HOLD"):
        return 0.0 if clamped < 1.0 else 1.0
    return clamped


def _three_point_scalar(values: tuple[float, float, float], progress: float, midpoint: float, mode: str) -> float:
    middle = max(0.001, min(0.999, midpoint))
    if progress <= middle:
        factor = _smoothing(progress / middle, mode)
        return values[0] + (values[1] - values[0]) * factor
    factor = _smoothing((progress - middle) / (1.0 - middle), mode)
    return values[1] + (values[2] - values[1]) * factor


def _three_point_color(sample: _EmissionSample, progress: float) -> tuple[float, float, float, float]:
    rgb: list[float] = []
    for component in range(3):
        values = tuple(color[component] for color in sample.colors)
        rgb.append(_three_point_scalar(values, progress, sample.color_midpoint, sample.color_smoothing))
    alpha_values = tuple(color[3] for color in sample.colors)
    alpha = _three_point_scalar(alpha_values, progress, sample.alpha_midpoint, sample.color_smoothing)
    return _as_color((*rgb, alpha))


def _force_state_at(timeline: _ForceTimeline, key: str, frame: float) -> _ForceState | None:
    states = timeline.states.get(key, ())
    if not states:
        return None
    if frame <= states[0].frame:
        return states[0]
    if frame >= states[-1].frame:
        return states[-1]
    left = states[0]
    for right in states[1:]:
        if frame <= right.frame + _DRIVE_EPSILON:
            span = max(_DRIVE_EPSILON, right.frame - left.frame)
            factor = max(0.0, min(1.0, (frame - left.frame) / span))
            return _ForceState(
                frame=frame,
                key=key,
                name=left.name,
                center=left.center.lerp(right.center, factor),
                radius=left.radius + (right.radius - left.radius) * factor,
                strength=left.strength + (right.strength - left.strength) * factor,
                falloff=left.falloff,
                unbounded=left.unbounded,
            )
        left = right
    return states[-1]


def _radial_sphere_acceleration(
    position: Any,
    fallback_direction: Any,
    state: _ForceState,
) -> Any:
    radial = position - state.center
    distance = radial.length
    if not state.unbounded and distance > state.radius:
        return Vector((0.0, 0.0, 0.0))
    direction = _normalized(radial, tuple(float(value) for value in fallback_direction))
    magnitude = state.strength
    if state.falloff and state.radius > _DRIVE_EPSILON:
        magnitude *= max(0.0, 1.0 - distance / state.radius)
    return direction * magnitude


def _integrated_force_position(
    sample: _EmissionSample,
    render_frame: int,
    fps: float,
    root_matrix: Any,
    force_timeline: _ForceTimeline,
) -> tuple[Any, Any, Any]:
    """Integrate source gravity/drag plus supported M3 forces at fixed 120 Hz."""

    age_seconds = max(0.0, (render_frame - sample.birth_frame) / fps)
    if sample.world_space:
        position = sample.position.copy()
        direction = sample.direction.copy()
        side_hint = sample.side_hint.copy()
        up_hint = sample.up_hint.copy()
    else:
        root_basis = root_matrix.to_3x3()
        position = root_matrix @ sample.position_local
        direction = _normalized(root_basis @ sample.direction_local, (0.0, 0.0, 1.0))
        side_hint = _normalized(root_basis @ sample.side_local, (1.0, 0.0, 0.0))
        up_hint = _normalized(root_basis @ sample.up_local, (0.0, 1.0, 0.0))
    velocity = direction * sample.speed
    elapsed = 0.0
    fixed_step = 1.0 / 120.0
    force_keys = tuple(force_timeline.states)
    while elapsed < age_seconds - _DRIVE_EPSILON:
        dt = min(fixed_step, age_seconds - elapsed)
        evaluation_frame = sample.birth_frame + (elapsed + dt * 0.5) * fps
        acceleration = Vector((0.0, 0.0, sample.gravity))
        for key in force_keys:
            state = _force_state_at(force_timeline, key, evaluation_frame)
            if state is not None:
                acceleration += _radial_sphere_acceleration(position, direction, state)
        velocity += acceleration * dt
        if sample.drag > _DRIVE_EPSILON:
            velocity *= math.exp(-sample.drag * dt)
        position += velocity * dt
        elapsed += dt
    return position, side_hint, up_hint


def _sample_position(
    sample: _EmissionSample,
    render_frame: int,
    fps: float,
    root_matrix: Any,
    force_timeline: _ForceTimeline,
) -> tuple[Any, Any, Any]:
    age_seconds = max(0.0, (render_frame - sample.birth_frame) / fps)
    if force_timeline.states:
        position, side_hint, up_hint = _integrated_force_position(
            sample, render_frame, fps, root_matrix, force_timeline
        )
    else:
        if sample.world_space:
            position = sample.position.copy()
            direction = sample.direction.copy()
            side_hint = sample.side_hint.copy()
            up_hint = sample.up_hint.copy()
        else:
            root_basis = root_matrix.to_3x3()
            position = root_matrix @ sample.position_local
            direction = _normalized(root_basis @ sample.direction_local, (0.0, 0.0, 1.0))
            side_hint = _normalized(root_basis @ sample.side_local, (1.0, 0.0, 0.0))
            up_hint = _normalized(root_basis @ sample.up_local, (0.0, 1.0, 0.0))
        if sample.drag > _DRIVE_EPSILON:
            travel_time = (1.0 - math.exp(-sample.drag * age_seconds)) / sample.drag
        else:
            travel_time = age_seconds
        position += direction * sample.speed * travel_time
        position.z += 0.5 * sample.gravity * age_seconds * age_seconds
    if sample.noise_amplitude > _DRIVE_EPSILON and sample.noise_frequency > _DRIVE_EPSILON:
        phase = age_seconds * sample.noise_frequency * math.tau + sample.birth_frame * 0.173
        amplitude = sample.noise_amplitude * sample.emitter_scale
        cohesion = 1.0 / (1.0 + sample.noise_cohesion * age_seconds)
        position += side_hint * math.sin(phase) * amplitude * cohesion
        position += up_hint * math.cos(phase * 0.731 + 1.17) * amplitude * cohesion
    return position, side_hint, up_hint


def _trail_groups_for_frame(
    samples: Sequence[_EmissionSample],
    render_frame: int,
    fps: float,
    root_matrix: Any,
    maximum_segments: int,
    force_timeline: _ForceTimeline,
) -> list[list[_TrailPoint]]:
    by_generation: dict[int, list[tuple[_EmissionSample, Any, Any, Any]]] = {}
    for sample in reversed(samples):  # Newest element begins the ribbon at the emitter.
        if sample.birth_frame > render_frame + _DRIVE_EPSILON:
            continue
        age_seconds = max(0.0, (render_frame - sample.birth_frame) / fps)
        if sample.cull_method == "TIME" and age_seconds > sample.lifespan:
            continue
        if sample.cull_method == "LENGTH" and sample.length <= _DRIVE_EPSILON:
            continue
        position, side_hint, up_hint = _sample_position(
            sample, render_frame, fps, root_matrix, force_timeline
        )
        by_generation.setdefault(sample.generation, []).append((sample, position, side_hint, up_hint))

    trails: list[list[_TrailPoint]] = []
    for generation in sorted(by_generation, reverse=True):
        entries = by_generation[generation]
        trail: list[_TrailPoint] = []
        accumulated = 0.0
        previous_position: Any | None = None
        for sample, position, side_hint, up_hint in entries[:maximum_segments]:
            if previous_position is not None:
                segment_length = (position - previous_position).length
                if sample.cull_method == "LENGTH" and accumulated + segment_length > sample.length:
                    remaining = max(0.0, sample.length - accumulated)
                    if segment_length > _DRIVE_EPSILON and remaining > _DRIVE_EPSILON:
                        factor = remaining / segment_length
                        clipped = previous_position.lerp(position, factor)
                        progress = 1.0
                        trail.append(
                            _TrailPoint(
                                clipped,
                                side_hint,
                                up_hint,
                                max(0.0, _three_point_scalar(sample.widths, progress, sample.width_midpoint, sample.width_smoothing))
                                * sample.emitter_scale,
                                _three_point_scalar(sample.twists, progress, sample.twist_midpoint, "LINEAR"),
                                _three_point_color(sample, progress),
                                progress,
                            )
                        )
                    break
                accumulated += segment_length
            age_seconds = max(0.0, (render_frame - sample.birth_frame) / fps)
            progress = (
                min(1.0, accumulated / max(sample.length, _DRIVE_EPSILON))
                if sample.cull_method == "LENGTH"
                else min(1.0, age_seconds / max(sample.lifespan, 1.0 / fps))
            )
            trail.append(
                _TrailPoint(
                    position,
                    side_hint,
                    up_hint,
                    max(0.0, _three_point_scalar(sample.widths, progress, sample.width_midpoint, sample.width_smoothing))
                    * sample.emitter_scale,
                    _three_point_scalar(sample.twists, progress, sample.twist_midpoint, "LINEAR"),
                    _three_point_color(sample, progress),
                    progress,
                )
            )
            previous_position = position
        if len(trail) >= 2:
            trails.append(trail)
    return trails


def _safe_side(tangent: Any, candidate: Any, fallback: Any) -> Any:
    side = Vector(candidate) - tangent * Vector(candidate).dot(tangent)
    if side.length_squared <= _DRIVE_EPSILON:
        side = Vector(fallback) - tangent * Vector(fallback).dot(tangent)
    if side.length_squared <= _DRIVE_EPSILON:
        axis = Vector((0.0, 0.0, 1.0)) if abs(tangent.z) < 0.9 else Vector((1.0, 0.0, 0.0))
        side = tangent.cross(axis)
    side.normalize()
    return side


def _trail_tangent(trail: Sequence[_TrailPoint], index: int) -> Any:
    if index == 0:
        tangent = trail[0].position - trail[1].position
    elif index == len(trail) - 1:
        tangent = trail[-2].position - trail[-1].position
    else:
        tangent = trail[index - 1].position - trail[index + 1].position
    return _normalized(tangent, (0.0, 0.0, 1.0))


def _append_planar_geometry(
    geometry: _FrameGeometry,
    trail: Sequence[_TrailPoint],
    billboard: bool,
    camera_position: Any | None,
    camera_view_direction: Any | None,
) -> None:
    offset = len(geometry.vertices)
    for index, point in enumerate(trail):
        tangent = _trail_tangent(trail, index)
        if billboard and camera_view_direction is not None:
            # Orthographic rays are parallel.  Using point-to-camera vectors
            # here would incorrectly fan wide ribbons as if the ortho camera
            # were perspective-projected.
            view = camera_view_direction
            side_candidate = tangent.cross(view)
        elif billboard and camera_position is not None:
            view = _normalized(camera_position - point.position, (0.0, -1.0, 0.0))
            side_candidate = tangent.cross(view)
        else:
            side_candidate = point.side_hint
        side = _safe_side(tangent, side_candidate, point.up_hint)
        if abs(point.twist) > _DRIVE_EPSILON:
            side = Quaternion(tangent, point.twist) @ side
        half_width = max(0.00005, point.width * 0.5)
        geometry.vertices.extend((tuple(point.position - side * half_width), tuple(point.position + side * half_width)))
        geometry.vertex_colors.extend((point.color, point.color))
    for index in range(len(trail) - 1):
        base = offset + index * 2
        following = base + 2
        geometry.faces.append((base, base + 1, following + 1, following))
        v0 = trail[index].progress
        v1 = trail[index + 1].progress
        geometry.face_uvs.append(((0.0, v0), (1.0, v0), (1.0, v1), (0.0, v1)))


def _append_tube_geometry(geometry: _FrameGeometry, trail: Sequence[_TrailPoint], sides: int, star_ratio: float) -> None:
    authored_sides = max(3, min(32, int(sides)))
    is_star = star_ratio < 0.999
    ring_size = authored_sides * 2 if is_star else authored_sides
    offset = len(geometry.vertices)
    for index, point in enumerate(trail):
        tangent = _trail_tangent(trail, index)
        normal = _safe_side(tangent, point.side_hint, point.up_hint)
        binormal = _normalized(tangent.cross(normal), (0.0, 1.0, 0.0))
        radius = max(0.00005, point.width * 0.5)
        for side_index in range(ring_size):
            angle = point.twist + math.tau * side_index / ring_size
            radial_scale = star_ratio if is_star and side_index % 2 else 1.0
            radial = normal * math.cos(angle) + binormal * math.sin(angle)
            geometry.vertices.append(tuple(point.position + radial * radius * radial_scale))
            geometry.vertex_colors.append(point.color)
    for ring_index in range(len(trail) - 1):
        for side_index in range(ring_size):
            next_side = (side_index + 1) % ring_size
            current = offset + ring_index * ring_size
            following = current + ring_size
            geometry.faces.append(
                (current + side_index, current + next_side, following + next_side, following + side_index)
            )
            u0 = side_index / ring_size
            u1 = (side_index + 1) / ring_size
            v0 = trail[ring_index].progress
            v1 = trail[ring_index + 1].progress
            geometry.face_uvs.append(((u0, v0), (u1, v0), (u1, v1), (u0, v1)))


def _geometry_for_trails(
    trails: Sequence[Sequence[_TrailPoint]],
    ribbon_type: str,
    sides: int,
    star_ratio: float,
    camera_position: Any | None,
    camera_view_direction: Any | None,
) -> _FrameGeometry:
    geometry = _FrameGeometry()
    for trail in trails:
        if len(trail) < 2:
            continue
        if ribbon_type in {"CYLINDER", "STAR"}:
            ratio = max(0.01, min(1.0, star_ratio)) if ribbon_type == "STAR" else 1.0
            _append_tube_geometry(geometry, trail, sides, ratio)
        else:
            _append_planar_geometry(
                geometry,
                trail,
                ribbon_type == "PLANAR_BILLBOARD",
                camera_position,
                camera_view_direction,
            )
    return geometry


def _apply_geometry(mesh: Any, geometry: _FrameGeometry) -> None:
    mesh.clear_geometry()
    if not geometry.vertices or not geometry.faces:
        mesh.update()
        return
    mesh.from_pydata(geometry.vertices, [], geometry.faces)
    mesh.update(calc_edges=True)
    uv_layer = mesh.uv_layers.get(RIBBON_UV_LAYER) or mesh.uv_layers.new(name=RIBBON_UV_LAYER)
    color_layer = mesh.color_attributes.get(RIBBON_COLOR_ATTRIBUTE)
    if color_layer is None:
        color_layer = mesh.color_attributes.new(name=RIBBON_COLOR_ATTRIBUTE, type="FLOAT_COLOR", domain="CORNER")
    for polygon in mesh.polygons:
        face_uvs = geometry.face_uvs[polygon.index]
        for corner_index, loop_index in enumerate(polygon.loop_indices):
            vertex_index = mesh.loops[loop_index].vertex_index
            uv_layer.data[loop_index].uv = face_uvs[corner_index]
            color_layer.data[loop_index].color = geometry.vertex_colors[vertex_index]


def _principled_input(node: Any, *names: str) -> Any | None:
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            return socket
    return None


def _multiply(nodes: Any, links: Any, left: Any, right: Any) -> Any:
    node = nodes.new("ShaderNodeMixRGB")
    node.blend_type = "MULTIPLY"
    node.inputs[0].default_value = 1.0
    links.new(left, node.inputs[1])
    links.new(right, node.inputs[2])
    return node.outputs["Color"]


def _multiply_scalar(nodes: Any, links: Any, left: Any, right: Any) -> Any:
    node = nodes.new("ShaderNodeMath")
    node.operation = "MULTIPLY"
    links.new(left, node.inputs[0])
    links.new(right, node.inputs[1])
    return node.outputs["Value"]


def _separate_channel(nodes: Any, links: Any, color: Any, alpha: Any, channel: str) -> Any:
    if channel == "A":
        return alpha
    if channel not in {"R", "G", "B"}:
        return color
    try:
        separate = nodes.new("ShaderNodeSeparateColor")
        output_name = {"R": "Red", "G": "Green", "B": "Blue"}[channel]
        links.new(color, separate.inputs["Color"])
    except RuntimeError:
        separate = nodes.new("ShaderNodeSeparateRGB")
        output_name = channel
        links.new(color, separate.inputs["Image"])
    return separate.outputs[output_name]


def _texture_layer_nodes(
    nodes: Any,
    links: Any,
    layer: Any | None,
    texture_index: _ExactTextureIndex,
    bindings: list[_TextureBinding],
    requested: list[str],
    missing: list[str],
    *,
    non_color: bool = False,
) -> tuple[Any | None, Any | None, Any | None]:
    if layer is None:
        return None, None, None
    color_type = str(getattr(layer, "color_type", ""))
    if color_type != "BITMAP":
        rgb = nodes.new("ShaderNodeRGB")
        value = _as_color(getattr(layer, "color_value", (1, 1, 1, 1)))
        rgb.outputs["Color"].default_value = value
        alpha = nodes.new("ShaderNodeValue")
        alpha.outputs["Value"].default_value = value[3]
        return rgb.outputs["Color"], alpha.outputs["Value"], _separate_channel(
            nodes, links, rgb.outputs["Color"], alpha.outputs["Value"], str(getattr(layer, "color_channels", "RGB"))
        )

    raw_path = str(getattr(layer, "color_bitmap", "")).strip()
    normalized = _normalize_texture_reference(raw_path)
    if normalized is None:
        missing.append(raw_path or "(empty/unsafe M3 texture reference)")
        return None, None, None
    requested.append(normalized)
    resolved = texture_index.resolve(normalized)
    if resolved is None:
        missing.append(normalized)
        return None, None, None
    try:
        image = bpy.data.images.load(str(resolved), check_existing=True)
        image.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    except Exception as exc:
        missing.append(f"{normalized} ({exc})")
        return None, None, None
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.label = normalized
    texture.extension = "REPEAT" if bool(getattr(layer, "uv_wrap_x", True)) or bool(getattr(layer, "uv_wrap_y", True)) else "EXTEND"
    mapping = nodes.new("ShaderNodeMapping")
    uv_source = str(getattr(layer, "uv_source", "UV0"))
    if uv_source == "PLANARWZ":
        geometry = nodes.new("ShaderNodeNewGeometry")
        links.new(geometry.outputs["Position"], mapping.inputs["Vector"])
    else:
        uv = nodes.new("ShaderNodeUVMap")
        uv.uv_map = RIBBON_UV_LAYER
        links.new(uv.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
    _update_texture_binding(_TextureBinding(layer, mapping, texture))
    bindings.append(_TextureBinding(layer, mapping, texture))
    color = texture.outputs["Color"]
    alpha = texture.outputs["Alpha"]
    if bool(getattr(layer, "color_invert", False)):
        invert = nodes.new("ShaderNodeInvert")
        links.new(color, invert.inputs["Color"])
        color = invert.outputs["Color"]
        invert_alpha = nodes.new("ShaderNodeMath")
        invert_alpha.operation = "SUBTRACT"
        invert_alpha.inputs[0].default_value = 1.0
        links.new(alpha, invert_alpha.inputs[1])
        alpha = invert_alpha.outputs["Value"]
    multiplier = float(getattr(layer, "color_multiply", 1.0)) * float(getattr(layer, "color_brightness", 1.0))
    if abs(multiplier - 1.0) > 0.0001:
        scale = nodes.new("ShaderNodeVectorMath")
        scale.operation = "SCALE"
        links.new(color, scale.inputs[0])
        scale.inputs[3].default_value = multiplier
        color = scale.outputs["Vector"]
        alpha_scale = nodes.new("ShaderNodeMath")
        alpha_scale.operation = "MULTIPLY"
        links.new(alpha, alpha_scale.inputs[0])
        alpha_scale.inputs[1].default_value = multiplier
        alpha = alpha_scale.outputs["Value"]
    addition = float(getattr(layer, "color_add", 0.0))
    if abs(addition) > 0.0001:
        add = nodes.new("ShaderNodeVectorMath")
        add.operation = "ADD"
        links.new(color, add.inputs[0])
        add.inputs[1].default_value = (addition, addition, addition)
        color = add.outputs["Vector"]
        alpha_add = nodes.new("ShaderNodeMath")
        alpha_add.operation = "ADD"
        links.new(alpha, alpha_add.inputs[0])
        alpha_add.inputs[1].default_value = addition
        alpha = alpha_add.outputs["Value"]
    scalar = _separate_channel(nodes, links, color, alpha, str(getattr(layer, "color_channels", "RGB")))
    return color, alpha, scalar


def _update_texture_binding(binding: _TextureBinding) -> None:
    layer = binding.layer
    offset = tuple(float(value) for value in getattr(layer, "uv_offset", (0.0, 0.0)))
    tiling = tuple(float(value) for value in getattr(layer, "uv_tiling", (1.0, 1.0)))
    angle = tuple(float(value) for value in getattr(layer, "uv_angle", (0.0, 0.0, 0.0)))
    rows = max(1, int(getattr(layer, "uv_flipbook_rows", 0) or 1))
    columns = max(1, int(getattr(layer, "uv_flipbook_cols", 0) or 1))
    flipbook_frame = max(0, int(getattr(layer, "uv_flipbook_frame", 0)))
    column = flipbook_frame % columns
    row = (flipbook_frame // columns) % rows
    binding.mapping.inputs["Location"].default_value[0] = offset[0] + column / columns
    binding.mapping.inputs["Location"].default_value[1] = offset[1] + row / rows
    binding.mapping.inputs["Scale"].default_value[0] = tiling[0] / columns
    binding.mapping.inputs["Scale"].default_value[1] = tiling[1] / rows
    binding.mapping.inputs["Rotation"].default_value[2] = angle[2]


def _build_material(
    role_name: str,
    armature: Any,
    ribbon: Any,
    texture_index: _ExactTextureIndex,
    team_color: tuple[float, float, float, float],
) -> tuple[Any, list[_TextureBinding], tuple[str, ...], tuple[str, ...], str, str, list[str]]:
    matref, source, mat_type = _resolve_material(armature, ribbon)
    if matref is None or source is None:
        raise RibbonRealizationError(
            f"{role_name}/{getattr(ribbon, 'name', 'ribbon')} references an unresolved M3 material handle."
        )
    material_name = str(getattr(matref, "name", "M3 Ribbon Material"))
    blender_name = f"M3_RIBBON_{role_name}_{getattr(ribbon, 'name', 'Ribbon')}_{material_name}"
    material = bpy.data.materials.new(blender_name)
    material.use_nodes = True
    material.use_backface_culling = False
    try:
        material.surface_render_method = "DITHERED"
    except (AttributeError, TypeError, ValueError):
        if hasattr(material, "blend_method"):
            material.blend_method = "BLEND"
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Roughness"].default_value = 0.42
    links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    vertex = nodes.new("ShaderNodeVertexColor")
    vertex.layer_name = RIBBON_COLOR_ATTRIBUTE
    bindings: list[_TextureBinding] = []
    requested: list[str] = []
    missing: list[str] = []
    warnings: list[str] = []

    base_color: Any = vertex.outputs["Color"]
    alpha: Any = vertex.outputs["Alpha"]
    emission_color: Any | None = None
    emission_strength = 1.0

    if mat_type == "m3_materials_standard":
        diffuse_color, diffuse_alpha, _ = _texture_layer_nodes(
            nodes, links, _material_layer(armature, source, "diff"), texture_index, bindings, requested, missing
        )
        if diffuse_color is not None:
            if str(getattr(source, "blend_mode_layer", "ADD")) == "TEAMDIFF" and diffuse_alpha is not None:
                team_mix = nodes.new("ShaderNodeMixRGB")
                team_mix.blend_type = "MIX"
                links.new(diffuse_alpha, team_mix.inputs[0])
                links.new(diffuse_color, team_mix.inputs[1])
                team_mix.inputs[2].default_value = team_color
                diffuse_color = team_mix.outputs["Color"]
            base_color = _multiply(nodes, links, diffuse_color, vertex.outputs["Color"])
        blend_mode = str(getattr(source, "blend_mode", "OPAQUE"))
        alpha_threshold = int(getattr(source, "alpha_test_threshold", 0))
        diffuse_layer = _material_layer(armature, source, "diff")
        diffuse_channels = str(getattr(diffuse_layer, "color_channels", "RGB")) if diffuse_layer else "RGB"
        if diffuse_alpha is not None and (
            blend_mode != "OPAQUE" or alpha_threshold > 0 or "A" in diffuse_channels
        ):
            alpha = _multiply_scalar(nodes, links, alpha, diffuse_alpha)
        if hasattr(material, "alpha_threshold"):
            material.alpha_threshold = max(0.0, min(1.0, alpha_threshold / 255.0))
        for slot in ("alpha1", "alpha2"):
            _, _, alpha_mask = _texture_layer_nodes(
                nodes,
                links,
                _material_layer(armature, source, slot),
                texture_index,
                bindings,
                requested,
                missing,
                non_color=True,
            )
            if alpha_mask is not None:
                alpha = _multiply_scalar(nodes, links, alpha, alpha_mask)
        for slot, blend_property in (("emis1", "blend_mode_emis1"), ("emis2", "blend_mode_emis2")):
            emission, emission_alpha, emission_scalar = _texture_layer_nodes(
                nodes, links, _material_layer(armature, source, slot), texture_index, bindings, requested, missing
            )
            current = emission_scalar or emission
            if current is None:
                continue
            emission_blend_mode = str(getattr(source, blend_property, "ADD"))
            if emission_blend_mode == "TEAMEMIS":
                team_mix = nodes.new("ShaderNodeMixRGB")
                team_mix.blend_type = "MIX"
                team_mix.inputs[0].default_value = 1.0
                if emission_alpha is not None:
                    links.new(emission_alpha, team_mix.inputs[0])
                links.new(current, team_mix.inputs[1])
                team_mix.inputs[2].default_value = team_color
                current = team_mix.outputs["Color"]
            current = _multiply(nodes, links, current, vertex.outputs["Color"])
            if emission_color is None:
                emission_color = current
            else:
                add = nodes.new("ShaderNodeMixRGB")
                add.blend_type = "ADD"
                add.inputs[0].default_value = 1.0
                links.new(emission_color, add.inputs[1])
                links.new(current, add.inputs[2])
                emission_color = add.outputs["Color"]
            if emission_blend_mode == "TEAMEMIS":
                warnings.append(f"{slot} uses TEAMEMIS; the caller-supplied alert team color is applied.")
        emission_strength = max(0.0, float(getattr(source, "hdr_emis", 1.0)))
        normal_color, _, _ = _texture_layer_nodes(
            nodes,
            links,
            _material_layer(armature, source, "norm"),
            texture_index,
            bindings,
            requested,
            missing,
            non_color=True,
        )
        if normal_color is not None:
            normal = nodes.new("ShaderNodeNormalMap")
            normal.uv_map = RIBBON_UV_LAYER
            links.new(normal_color, normal.inputs["Color"])
            links.new(normal.outputs["Normal"], principled.inputs["Normal"])
        _, _, specular = _texture_layer_nodes(
            nodes,
            links,
            _material_layer(armature, source, "spec"),
            texture_index,
            bindings,
            requested,
            missing,
            non_color=True,
        )
        specular_input = _principled_input(principled, "Specular IOR Level", "Specular")
        if specular is not None and specular_input is not None:
            links.new(specular, specular_input)
        _, _, gloss = _texture_layer_nodes(
            nodes,
            links,
            _material_layer(armature, source, "gloss"),
            texture_index,
            bindings,
            requested,
            missing,
            non_color=True,
        )
        if gloss is not None:
            invert_gloss = nodes.new("ShaderNodeMath")
            invert_gloss.operation = "SUBTRACT"
            invert_gloss.inputs[0].default_value = 1.0
            links.new(gloss, invert_gloss.inputs[1])
            links.new(invert_gloss.outputs["Value"], principled.inputs["Roughness"])
        if blend_mode == "ADD":
            warnings.append(
                "M3 ADD is emitted with source-over alpha because transparent WebM cannot encode destination-additive blending."
            )
    elif mat_type == "m3_materials_displacement":
        displacement_strength = max(0.0, float(getattr(source, "strength_factor", 1.0)))
        normal_layer = _material_layer(armature, source, "norm")
        strength_layer = _material_layer(armature, source, "strength")
        normal_color, _, normal_scalar = _texture_layer_nodes(
            nodes,
            links,
            normal_layer,
            texture_index,
            bindings,
            requested,
            missing,
            non_color=True,
        )
        _, _, strength_scalar = _texture_layer_nodes(
            nodes,
            links,
            strength_layer,
            texture_index,
            bindings,
            requested,
            missing,
            non_color=True,
        )
        strength_signal: Any | None = None
        if strength_scalar is not None:
            strength_scale = nodes.new("ShaderNodeMath")
            strength_scale.operation = "MULTIPLY"
            strength_scale.label = "M3 displacement strength texture × factor"
            links.new(strength_scalar, strength_scale.inputs[0])
            strength_scale.inputs[1].default_value = displacement_strength
            strength_signal = strength_scale.outputs["Value"]
        if normal_color is not None:
            normal = nodes.new("ShaderNodeNormalMap")
            normal.uv_map = RIBBON_UV_LAYER
            normal.label = "M3 displacement normal"
            if strength_signal is not None:
                links.new(strength_signal, normal.inputs["Strength"])
            else:
                normal.inputs["Strength"].default_value = displacement_strength
            links.new(normal_color, normal.inputs["Color"])
            # Eevee cannot sample and offset the already-rendered destination
            # framebuffer as SC2 does.  Preserve the authored source texture on
            # the generated ribbon geometry and feed it into both the refractive
            # normal and a shallow bump proxy, so the exported transparent pass
            # still carries the source heat-wave field instead of a fabricated
            # glow or replacement mesh.
            bump = nodes.new("ShaderNodeBump")
            bump.label = "Eevee framebuffer-distortion proxy"
            if strength_scalar is not None:
                links.new(strength_scalar, bump.inputs["Strength"])
            else:
                bump.inputs["Strength"].default_value = min(1.0, displacement_strength / 2.1)
            bump.inputs["Distance"].default_value = min(0.12, displacement_strength * 0.025)
            if normal_scalar is not None:
                links.new(normal_scalar, bump.inputs["Height"])
            links.new(normal.outputs["Normal"], bump.inputs["Normal"])
            links.new(bump.outputs["Normal"], principled.inputs["Normal"])
        transmission = _principled_input(principled, "Transmission Weight", "Transmission")
        if transmission is not None:
            transmission.default_value = 1.0
        principled.inputs["Roughness"].default_value = 0.0
        if strength_signal is not None:
            ior_scale = nodes.new("ShaderNodeMath")
            ior_scale.operation = "MULTIPLY_ADD"
            ior_scale.inputs[1].default_value = 0.025
            ior_scale.inputs[2].default_value = 1.0
            links.new(strength_signal, ior_scale.inputs[0])
            links.new(ior_scale.outputs["Value"], principled.inputs["IOR"])
        else:
            principled.inputs["IOR"].default_value = 1.0 + min(0.12, displacement_strength * 0.025)
        alpha_value = nodes.new("ShaderNodeMath")
        alpha_value.operation = "MULTIPLY"
        alpha_value.inputs[1].default_value = min(0.30, max(0.08, displacement_strength / 12.0))
        if strength_scalar is not None:
            masked_alpha = _multiply_scalar(nodes, links, alpha, strength_scalar)
            links.new(masked_alpha, alpha_value.inputs[0])
        else:
            links.new(alpha, alpha_value.inputs[0])
        alpha = alpha_value.outputs["Value"]
        material["m3_displacement_proxy"] = "SOURCE_NORMAL_EEVEE_REFRACTION"
        material["m3_displacement_strength"] = displacement_strength
        material["m3_displacement_texture"] = str(
            _normalize_texture_reference(str(getattr(normal_layer, "color_bitmap", ""))) or ""
        )
        material["m3_displacement_strength_texture"] = str(
            _normalize_texture_reference(str(getattr(strength_layer, "color_bitmap", ""))) or ""
        )
        warnings.append(
            "M3 destination-framebuffer displacement is represented by source-textured ribbon geometry "
            "with authored normal strength and an Eevee transmission/refraction+bump proxy; pixel-identical "
            "SC2 framebuffer sampling is unavailable in Eevee/transparent WebM."
        )
    else:
        warnings.append(
            f"M3 material class {mat_type!r} has no dedicated ribbon shader; authored vertex color remains visible."
        )

    links.new(base_color, principled.inputs["Base Color"])
    alpha_input = _principled_input(principled, "Alpha")
    if alpha_input is not None:
        links.new(alpha, alpha_input)
    if emission_color is not None:
        emission_input = _principled_input(principled, "Emission Color", "Emission")
        if emission_input is not None:
            links.new(emission_color, emission_input)
        emission_strength_input = _principled_input(principled, "Emission Strength")
        if emission_strength_input is not None:
            emission_strength_input.default_value = max(1.0, emission_strength)
    elif bool(getattr(source, "unshaded", False)):
        emission_input = _principled_input(principled, "Emission Color", "Emission")
        if emission_input is not None:
            links.new(base_color, emission_input)
        emission_strength_input = _principled_input(principled, "Emission Strength")
        if emission_strength_input is not None:
            emission_strength_input.default_value = 1.0
    return (
        material,
        bindings,
        tuple(dict.fromkeys(requested)),
        tuple(dict.fromkeys(missing)),
        material_name,
        mat_type,
        warnings,
    )


def _source_behavior_warnings(armature: Any, ribbon: Any) -> list[str]:
    warnings: list[str] = []
    for binding in _force_bindings(armature, ribbon):
        if _supported_force_reasons(binding):
            continue
        force = binding.force
        warnings.append(
            f"Applied source M3 {binding.scope.lower()} force {binding.name!r} on channel(s) "
            f"{list(binding.channels)} with deterministic RADIAL/SPHERE integration: animated strength, "
            f"radius, bone center, falloff={bool(getattr(force, 'falloff', False))}, and "
            f"unbounded={bool(getattr(force, 'unbounded', False))}."
        )
    for prefix in ("yaw", "pitch", "length", "scale"):
        shape = str(getattr(ribbon, f"{prefix}_var_shape", "NONE"))
        amplitude = float(getattr(ribbon, f"{prefix}_var_amplitude", 0.0))
        frequency = float(getattr(ribbon, f"{prefix}_var_frequency", 0.0))
        if abs(amplitude) <= _DRIVE_EPSILON or shape == "NONE":
            continue
        unit = "degrees" if prefix in {"yaw", "pitch"} else "source units"
        detail = (
            "smooth deterministic value noise (the proprietary SC2 noise permutation is unavailable)"
            if shape == "NOISE_CONTINUOUS"
            else f"the authored {shape} curve"
        )
        warnings.append(
            f"Applied authored {prefix} overlay {shape}: amplitude={amplitude:g} {unit}, "
            f"frequency={frequency:g}, sampled once per emitted segment using {detail}."
        )
    return warnings


def _root_matrices(armature: Any, scene: Any, frame_start: int, frame_end: int) -> dict[int, Any]:
    result: dict[int, Any] = {}
    for frame in range(frame_start, frame_end + 1):
        _scene_set_frame(scene, float(frame))
        result[frame] = armature.matrix_world.copy()
    return result


def _warmup_seconds(ribbon: Any) -> float:
    if not bool(getattr(ribbon, "simulate_init", False)):
        return 0.0
    cull_method = str(getattr(ribbon, "cull_method", "TIME"))
    if cull_method == "TIME":
        return min(8.0, max(0.0, float(getattr(ribbon, "lifespan", 0.0))))
    length = max(0.0, float(getattr(ribbon, "length", 0.0)))
    speed = max(0.0, float(getattr(ribbon, "speed", 0.0)))
    if speed > 0.001:
        return min(8.0, length / speed + 0.25)
    return min(4.0, max(0.5, float(getattr(ribbon, "lifespan", 1.0))))


def _sample_force_state(armature: Any, binding: _ForceBinding, frame: float) -> _ForceState:
    matrix = _bone_world_matrix(armature, binding.pose_bone)
    scale_values = tuple(abs(float(value)) for value in matrix.to_scale())
    uniform_scale = sum(scale_values) / max(1, len(scale_values))
    source_radius = max(0.0, float(getattr(binding.force, "width", 0.0)))
    source_strength = float(getattr(binding.force, "strength", 0.0))
    return _ForceState(
        frame=frame,
        key=binding.key,
        name=binding.name,
        center=matrix.translation.copy(),
        radius=source_radius * max(_DRIVE_EPSILON, uniform_scale),
        strength=source_strength * max(_DRIVE_EPSILON, uniform_scale),
        falloff=bool(getattr(binding.force, "falloff", False)),
        unbounded=bool(getattr(binding.force, "unbounded", False)),
    )


def _sample_emissions(
    armature: Any,
    ribbon: Any,
    emitter_bone: Any,
    scene: Any,
    frame_start: int,
    frame_end: int,
    fps: float,
    maximum_segments: int,
    seed: float,
) -> tuple[list[_EmissionSample], _ForceTimeline]:
    divisions = max(1.0, min(float(maximum_segments), float(getattr(ribbon, "divisions", fps) or fps)))
    interval = fps / divisions
    first = frame_start - _warmup_seconds(ribbon) * fps
    samples: list[_EmissionSample] = []
    bindings = _force_bindings(armature, ribbon)
    timeline_rows: dict[str, list[_ForceState]] = {binding.key: [] for binding in bindings}
    generation = 0
    was_active = False
    birth = first
    while birth <= frame_end + _DRIVE_EPSILON:
        evaluation_frame = max(float(frame_start), birth)
        _scene_set_frame(scene, evaluation_frame)
        for binding in bindings:
            timeline_rows[binding.key].append(_sample_force_state(armature, binding, birth))
        active = bool(getattr(ribbon, "active", True))
        if active and not was_active:
            generation += 1
        if active:
            samples.append(_sample_emission(armature, ribbon, emitter_bone, birth, generation, fps, seed))
        was_active = active
        birth += interval
    return samples, _ForceTimeline(
        {key: tuple(states) for key, states in timeline_rows.items() if states}
    )


def _spline_for_ribbon(armature: Any, ribbon: Any) -> Any | None:
    return _m3_item_by_handle(
        getattr(armature, "m3_ribbonsplines", ()), _pointer_handle(getattr(ribbon, "spline", None))
    )


def _spline_trails(
    armature: Any,
    ribbon: Any,
    emitter_bone: Any,
    spline: Any,
    scene: Any,
    frame_start: int,
    frame_end: int,
    fps: float,
) -> dict[int, list[list[_TrailPoint]]]:
    result: dict[int, list[list[_TrailPoint]]] = {}
    point_bindings: list[tuple[Any, Any]] = []
    for point in getattr(spline, "points", ()):
        point_bone = _resolve_pose_bone(armature, getattr(point, "bone", None))
        if point_bone is not None:
            point_bindings.append((point, point_bone))
    if not point_bindings:
        return result
    for frame in range(frame_start, frame_end + 1):
        _scene_set_frame(scene, float(frame))
        if not bool(getattr(ribbon, "active", True)):
            result[frame] = []
            continue
        sample = _sample_emission(armature, ribbon, emitter_bone, float(frame), 1, fps, 0.5)
        start_matrix = _bone_world_matrix(armature, emitter_bone)
        start = start_matrix.translation.copy()
        chains: list[list[_TrailPoint]] = []
        for point_index, (point, point_bone) in enumerate(point_bindings):
            end_matrix = _bone_world_matrix(armature, point_bone)
            end = end_matrix @ Vector(getattr(point, "emission_offset", (0.0, 0.0, 0.0)))
            distance = max((end - start).length, 0.001)
            subdivisions = max(3, min(96, int(math.ceil(float(getattr(ribbon, "divisions", 10.0)) * distance))))
            start_tangent = _normalized(start_matrix.to_3x3() @ Vector((0.0, 0.0, 1.0)), (0, 0, 1))
            end_vector = Vector(getattr(point, "emission_vector", (0.0, 0.0, 1.0)))
            if end_vector.length_squared <= _DRIVE_EPSILON:
                end_vector = Vector((0.0, 0.0, 1.0))
            end_tangent = _normalized(end_matrix.to_3x3() @ end_vector, (0, 0, 1))
            start_velocity = max(0.0, float(getattr(ribbon, "speed", 0.0)))
            end_velocity = max(0.0, float(getattr(point, "velocity", 0.0)))
            tangent_scale = max(distance * 0.35, (start_velocity + end_velocity) * 0.25)
            chain: list[_TrailPoint] = []
            for division in range(subdivisions + 1):
                progress = division / subdivisions
                p2 = progress * progress
                p3 = p2 * progress
                h00 = 2.0 * p3 - 3.0 * p2 + 1.0
                h10 = p3 - 2.0 * p2 + progress
                h01 = -2.0 * p3 + 3.0 * p2
                h11 = p3 - p2
                position = start * h00 + start_tangent * tangent_scale * h10 + end * h01 + end_tangent * tangent_scale * h11
                amplitude = sample.noise_amplitude * sample.emitter_scale
                if amplitude > _DRIVE_EPSILON:
                    envelope = math.sin(math.pi * progress)
                    phase = progress * max(1.0, sample.noise_frequency) * math.tau + frame * 0.113 + point_index
                    position += sample.side_hint * math.sin(phase) * amplitude * envelope
                    position += sample.up_hint * math.cos(phase * 0.79) * amplitude * envelope
                chain.append(
                    _TrailPoint(
                        position,
                        sample.side_hint,
                        sample.up_hint,
                        _three_point_scalar(sample.widths, progress, sample.width_midpoint, sample.width_smoothing)
                        * sample.emitter_scale,
                        _three_point_scalar(sample.twists, progress, sample.twist_midpoint, "LINEAR"),
                        _three_point_color(sample, progress),
                        progress,
                    )
                )
            chains.append(chain)
        result[frame] = chains
    return result


def _remove_existing_handlers() -> None:
    for handler in list(bpy.app.handlers.frame_change_post):
        if bool(getattr(handler, "_m3_ribbon_realizer", False)):
            bpy.app.handlers.frame_change_post.remove(handler)


def realize_m3_ribbons(
    roles: Mapping[str, Any] | Iterable[Any],
    *,
    scene: Any | None = None,
    textures_root: str | Path,
    frame_start: int | None = None,
    frame_end: int | None = None,
    collection: Any | None = None,
    strict_textures: bool = True,
    unsupported_policy: str = "skip",
    team_color: Sequence[float] = (0.153, 0.545, 1.0, 1.0),
    maximum_segments: int = 192,
    replace_existing_handler: bool = True,
    log: Callable[[str], None] | None = None,
) -> RibbonRealization:
    """Create animated Eevee meshes for every imported M3 ribbon.

    ``roles`` accepts the renderer's mapping of ``ModelRole`` objects or an
    iterable of armature objects.  Source actions and role motion must already
    be configured because this function bakes their evaluated bone transforms.
    Texture paths are resolved exactly beneath ``textures_root``; no basename
    or relocation search is performed.  ``unsupported_policy='skip'`` records
    unsupported active ribbons without fabricating them; ``'error'`` fails the
    call instead.  ``team_color`` supplies the alert palette color used by
    authored TEAMEMIS layers.  Never silently approximate destination-dependent
    effects.

    The returned session installs one ``frame_change_post`` handler.  Geometry
    is precomputed from the current animation, so change actions/choreography
    first and call this function afterward.
    """

    if bpy is None or Vector is None or Matrix is None or Quaternion is None or Euler is None:
        raise RibbonRealizationError("bpy is unavailable; run ribbon realization inside Blender.")
    target_scene = scene or bpy.context.scene
    start = int(target_scene.frame_start if frame_start is None else frame_start)
    end = int(target_scene.frame_end if frame_end is None else frame_end)
    if end < start:
        raise RibbonRealizationError(f"Ribbon frame range is invalid: {start}..{end}.")
    if maximum_segments < 8 or maximum_segments > 1024:
        raise RibbonRealizationError("maximum_segments must be between 8 and 1024.")
    if unsupported_policy not in {"skip", "error"}:
        raise RibbonRealizationError("unsupported_policy must be 'skip' or 'error'.")
    resolved_team_color = _as_color(team_color)
    fps = float(target_scene.render.fps) / max(float(target_scene.render.fps_base), _DRIVE_EPSILON)
    if fps <= 0:
        raise RibbonRealizationError("Scene FPS must be positive before realizing ribbons.")
    emit = log or (lambda _message: None)
    texture_index = _ExactTextureIndex(Path(textures_root))
    target_collection = collection or target_scene.collection
    original_frame = float(target_scene.frame_current) + float(target_scene.frame_subframe)
    runtimes: list[_RibbonRuntime] = []
    diagnostics: list[RibbonDiagnostic] = []

    try:
        for role_index, (role_name, armature, role_owner) in enumerate(_iter_roles(roles)):
            root_by_frame = _root_matrices(armature, target_scene, start, end)
            ribbons = list(getattr(armature, "m3_ribbons", ()))
            for ribbon_index, ribbon in enumerate(ribbons):
                ribbon_name = str(getattr(ribbon, "name", "") or f"Ribbon_{ribbon_index + 1}")
                emitter_bone = _resolve_pose_bone(armature, getattr(ribbon, "bone", None))
                if emitter_bone is None:
                    raise RibbonRealizationError(
                        f"{role_name}/{ribbon_name} references a missing M3 pose-bone handle."
                    )
                material_name, material_type, texture_paths, missing_textures = _inspect_material_textures(
                    armature, ribbon, texture_index
                )
                if strict_textures and missing_textures:
                    raise RibbonRealizationError(
                        f"{role_name}/{ribbon_name} is missing exact M3 ribbon texture(s): "
                        + ", ".join(missing_textures)
                    )
                spline = _spline_for_ribbon(armature, ribbon)
                authored_active_frames = _active_output_frame_count(ribbon, target_scene, start, end)
                capability_reasons = _unsupported_capability_reasons(
                    armature, ribbon, spline, authored_active_frames
                )
                status = "DORMANT" if authored_active_frames == 0 else "UNSUPPORTED" if capability_reasons else "REALIZED"
                if status != "REALIZED":
                    warnings = (
                        ("Authored active animation remains disabled throughout this output range.",)
                        if status == "DORMANT"
                        else tuple(capability_reasons)
                    )
                    diagnostic = RibbonDiagnostic(
                        status=status,
                        role=role_name,
                        ribbon=ribbon_name,
                        bone=emitter_bone.name,
                        ribbon_type=str(getattr(ribbon, "ribbon_type", "PLANAR_BILLBOARD")),
                        cull_method=str(getattr(ribbon, "cull_method", "TIME")),
                        material=material_name,
                        material_type=material_type,
                        textures=texture_paths,
                        missing_textures=missing_textures,
                        active_frames=authored_active_frames,
                        maximum_points=0,
                        warnings=warnings,
                    )
                    diagnostics.append(diagnostic)
                    emit(
                        f"Classified M3 ribbon {role_name}/{ribbon_name} as {status}: "
                        + "; ".join(warnings)
                    )
                    if status == "UNSUPPORTED" and unsupported_policy == "error":
                        raise RibbonRealizationError(
                            f"{role_name}/{ribbon_name} is outside the validated ribbon subset: "
                            + "; ".join(capability_reasons)
                        )
                    continue

                (
                    material,
                    bindings,
                    built_texture_paths,
                    built_missing_textures,
                    built_material_name,
                    built_material_type,
                    material_warnings,
                ) = _build_material(role_name, armature, ribbon, texture_index, resolved_team_color)
                if set(built_texture_paths) != set(texture_paths) or set(built_missing_textures) != set(
                    missing_textures
                ):
                    raise RibbonRealizationError(
                        f"{role_name}/{ribbon_name} material realization did not consume every exactly "
                        "resolved source texture."
                    )
                if built_material_name != material_name or built_material_type != material_type:
                    raise RibbonRealizationError(
                        f"{role_name}/{ribbon_name} material identity changed during ribbon bake."
                    )
                mesh = bpy.data.meshes.new(f"M3_RIBBON_MESH_{role_name}_{ribbon_name}")
                render_object = bpy.data.objects.new(f"M3_RIBBON_{role_name}_{ribbon_name}", mesh)
                target_collection.objects.link(render_object)
                render_object["m3_ribbon_role"] = role_name
                render_object["m3_ribbon_name"] = ribbon_name
                render_object["m3_ribbon_bone"] = emitter_bone.name
                render_object["m3_ribbon_material"] = material_name
                render_object["m3_ribbon_type"] = str(getattr(ribbon, "ribbon_type", "PLANAR_BILLBOARD"))
                render_object["m3_ribbon_material_type"] = material_type
                force_bindings = _force_bindings(armature, ribbon)
                if force_bindings:
                    render_object["m3_ribbon_force_sources"] = ";".join(
                        f"{binding.scope}:{binding.name}:{','.join(map(str, binding.channels))}"
                        for binding in force_bindings
                    )
                active_overlays = []
                for prefix in ("yaw", "pitch", "length", "scale"):
                    shape = str(getattr(ribbon, f"{prefix}_var_shape", "NONE"))
                    amplitude = float(getattr(ribbon, f"{prefix}_var_amplitude", 0.0))
                    if shape != "NONE" and abs(amplitude) > _DRIVE_EPSILON:
                        active_overlays.append(f"{prefix}:{shape}:{amplitude:g}")
                if active_overlays:
                    render_object["m3_ribbon_overlays"] = ";".join(active_overlays)
                if material_type == "m3_materials_displacement":
                    render_object["m3_displacement_proxy"] = "SOURCE_TEXTURE_GEOMETRY_EEVEE"
                mesh.materials.append(material)
                role_render_meshes = getattr(role_owner, "render_meshes", None)
                if isinstance(role_render_meshes, list):
                    role_render_meshes.append(render_object)

                samples, force_timeline = _sample_emissions(
                    armature,
                    ribbon,
                    emitter_bone,
                    target_scene,
                    start,
                    end,
                    fps,
                    maximum_segments,
                    role_index * 17.0 + ribbon_index * 0.917,
                )
                frame_trails = {
                    frame: (
                        _trail_groups_for_frame(
                            samples,
                            frame,
                            fps,
                            root_by_frame[frame],
                            maximum_segments,
                            force_timeline,
                        )
                        if max(abs(value) for value in root_by_frame[frame].to_scale()) >= 0.01
                        else []
                    )
                    for frame in range(start, end + 1)
                }
                active_frames = sum(bool(trails) for trails in frame_trails.values())
                maximum_points = max(
                    (sum(len(trail) for trail in trails) for trails in frame_trails.values()),
                    default=0,
                )
                warnings = list(material_warnings)
                warnings.extend(_source_behavior_warnings(armature, ribbon))
                if active_frames == 0 and authored_active_frames > 0:
                    warnings.append(
                        "Ribbon is authored active, but its cull/length settings create no two-point mesh in this range."
                    )
                diagnostic = RibbonDiagnostic(
                    status="REALIZED",
                    role=role_name,
                    ribbon=ribbon_name,
                    bone=emitter_bone.name,
                    ribbon_type=str(getattr(ribbon, "ribbon_type", "PLANAR_BILLBOARD")),
                    cull_method=str(getattr(ribbon, "cull_method", "TIME")),
                    material=material_name,
                    material_type=material_type,
                    textures=texture_paths,
                    missing_textures=missing_textures,
                    active_frames=active_frames,
                    maximum_points=maximum_points,
                    warnings=tuple(warnings),
                )
                diagnostics.append(diagnostic)
                runtime = _RibbonRuntime(
                    role_name=role_name,
                    armature=armature,
                    ribbon=ribbon,
                    emitter_bone=emitter_bone,
                    ribbon_type=diagnostic.ribbon_type,
                    cull_method=diagnostic.cull_method,
                    render_object=render_object,
                    material_bindings=bindings,
                    frame_trails=frame_trails,
                    frame_geometries={},
                    diagnostic=diagnostic,
                )
                runtimes.append(runtime)
                emit(
                    f"Realized M3 ribbon {role_name}/{ribbon_name}: {diagnostic.ribbon_type}, "
                    f"bone={diagnostic.bone}, material={material_name}, textures={len(texture_paths)}, "
                    f"activeFrames={active_frames}, maxPoints={maximum_points}."
                )
    finally:
        _scene_set_frame(target_scene, original_frame)

    if replace_existing_handler:
        _remove_existing_handlers()

    def update_ribbons(current_scene: Any, _depsgraph: Any = None) -> None:
        frame = max(start, min(end, int(round(current_scene.frame_current + current_scene.frame_subframe))))
        current_camera = getattr(current_scene, "camera", None)
        camera_position = current_camera.matrix_world.translation.copy() if current_camera is not None else None
        camera_view_direction = None
        if current_camera is not None and str(getattr(current_camera.data, "type", "")) == "ORTHO":
            camera_view_direction = _normalized(
                current_camera.matrix_world.to_3x3() @ Vector((0.0, 0.0, 1.0)),
                (0.0, -1.0, 0.0),
            )
        for runtime in runtimes:
            geometry = _geometry_for_trails(
                runtime.frame_trails.get(frame, ()),
                runtime.ribbon_type,
                int(getattr(runtime.ribbon, "sides", 5)),
                float(getattr(runtime.ribbon, "star_ratio", 0.5)),
                camera_position,
                camera_view_direction,
            )
            _apply_geometry(runtime.render_object.data, geometry)
            runtime.render_object.hide_render = not bool(geometry.faces)
            for binding in runtime.material_bindings:
                _update_texture_binding(binding)

    update_ribbons._m3_ribbon_realizer = True  # type: ignore[attr-defined]
    bpy.app.handlers.frame_change_post.append(update_ribbons)
    result = RibbonRealization(
        objects=[runtime.render_object for runtime in runtimes],
        diagnostics=diagnostics,
        _handler=update_ribbons,
        _runtimes=runtimes,
    )
    result.update(target_scene)
    return result


__all__ = [
    "RIBBON_COLOR_ATTRIBUTE",
    "RIBBON_UV_LAYER",
    "RibbonDiagnostic",
    "RibbonRealization",
    "RibbonRealizationError",
    "realize_m3_ribbons",
]
