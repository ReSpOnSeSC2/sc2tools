"""Bake imported StarCraft II M3 effects into Eevee-renderable Blender objects.

M3Studio imports particle, force, ribbon, and displacement *metadata*, but it
does not create renderable Blender particle systems for those collections.
This module realizes the subset needed by the alert pipeline without inventing
replacement characters:

* sprite, tail, and emitter particles are baked from the imported M3 emitter
  bones and evaluated action/NLA properties;
* particle flipbooks, lifecycle tint/alpha/size, bursts, rates, gravity, drag,
  and matching M3 radial/directional/damping/vortex force channels are sampled;
* imported displacement meshes are retained and receive a source-texture-driven
  Eevee proxy plus a real Displace modifier driven by the declared strength
  channel.

The displacement proxy is intentionally reported as an approximation. SC2's
displacement material distorts the already-rendered framebuffer, a semantic
that Eevee/WebM and glTF do not preserve. The proxy uses the genuine imported
mesh, UVs, animated M3 strength, normal map, and strength map; it never creates
a procedural humanoid or substitute unit silhouette.

Call :func:`realize_armature_effects` after the desired native action/NLA strips
and camera are configured. The function is isolated from ``blender_render.py``
so callers can opt in and validate the report before replacing the current
fail-closed effect gate.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import math
from pathlib import Path
import random
from typing import Any, Iterable, Mapping, Sequence

try:  # Keep py_compile and documentation tooling usable outside Blender.
    import bpy  # type: ignore
    from mathutils import Matrix, Vector  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - exercised only outside Blender
    bpy = None
    Matrix = Any  # type: ignore[misc,assignment]
    Vector = Any  # type: ignore[misc,assignment]


MODULE_PREFIX = "[m3-effect-realizer]"


class M3EffectRealizationError(RuntimeError):
    """Raised when source data cannot be realized without silently guessing."""


@dataclass(frozen=True)
class EffectBakeConfig:
    """Controls deterministic M3 effect baking.

    ``particle_opacity`` is a global alert-compositing multiplier in ``[0, 1]``.
    It is applied after each source texture and authored lifecycle alpha, so it
    can reveal the unit silhouette without changing source color, timing,
    geometry, or relative opacity between particles.  The default ``1.0`` is
    source-neutral.

    ``displacement_unit_scale`` converts M3's screen-distortion magnitude to a
    deliberately small geometry offset. ``displacement_opacity`` is the
    independent alert-compositing opacity for those source shells. Both remain
    explicit in the returned report because Eevee cannot reproduce SC2's native
    framebuffer-distortion pass.
    """

    frame_start: int | None = None
    frame_end: int | None = None
    fps: float | None = None
    seed: int = 0x5C2A17
    bake_step: int = 1
    max_particles_per_system: int = 160
    max_particles_total: int = 1400
    prewarm_simulate_init: bool = True
    strict_textures: bool = True
    realize_particles: bool = True
    realize_displacement: bool = True
    displacement_subdivision: int = 2
    displacement_unit_scale: float = 0.035
    displacement_opacity: float = 0.18
    particle_emission_strength: float = 4.0
    particle_opacity: float = 1.0
    collection_name: str = "SC2_M3_REALIZED_EFFECTS"
    replace_existing: bool = True


@dataclass(frozen=True)
class RealizationIssue:
    severity: str
    code: str
    source: str
    message: str


@dataclass(frozen=True)
class ParticleSystemResult:
    name: str
    material: str | None
    particle_type: str
    emitted: int
    created_objects: tuple[str, ...]
    skipped_reason: str | None = None


@dataclass(frozen=True)
class DisplacementResult:
    material: str
    mesh: str
    normal_texture: str | None
    strength_texture: str | None
    modifier: str | None
    realized: bool


@dataclass
class EffectRealizationReport:
    armature: str
    frame_start: int
    frame_end: int
    particle_opacity: float = 1.0
    displacement_opacity: float = 0.18
    particle_systems: list[ParticleSystemResult] = field(default_factory=list)
    displacement_materials: list[DisplacementResult] = field(default_factory=list)
    issues: list[RealizationIssue] = field(default_factory=list)
    created_objects: list[str] = field(default_factory=list)

    @property
    def error_count(self) -> int:
        return sum(issue.severity == "ERROR" for issue in self.issues)

    @property
    def warning_count(self) -> int:
        return sum(issue.severity == "WARNING" for issue in self.issues)

    @property
    def usable(self) -> bool:
        """True when no source dependency had to be silently substituted."""

        return self.error_count == 0

    @property
    def exact(self) -> bool:
        """True only when no approximation, cap, or unsupported class remains."""

        return self.error_count == 0 and self.warning_count == 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "armature": self.armature,
            "frameStart": self.frame_start,
            "frameEnd": self.frame_end,
            "particleOpacity": self.particle_opacity,
            "displacementOpacity": self.displacement_opacity,
            "usable": self.usable,
            "exact": self.exact,
            "errorCount": self.error_count,
            "warningCount": self.warning_count,
            "createdObjects": list(self.created_objects),
            "particleSystems": [
                {
                    "name": row.name,
                    "material": row.material,
                    "particleType": row.particle_type,
                    "emitted": row.emitted,
                    "createdObjects": list(row.created_objects),
                    "skippedReason": row.skipped_reason,
                }
                for row in self.particle_systems
            ],
            "displacementMaterials": [
                {
                    "material": row.material,
                    "mesh": row.mesh,
                    "normalTexture": row.normal_texture,
                    "strengthTexture": row.strength_texture,
                    "modifier": row.modifier,
                    "realized": row.realized,
                }
                for row in self.displacement_materials
            ],
            "issues": [
                {
                    "severity": issue.severity,
                    "code": issue.code,
                    "source": issue.source,
                    "message": issue.message,
                }
                for issue in self.issues
            ],
        }


@dataclass(frozen=True)
class _LayerSource:
    slot: str
    layer: Any
    bitmap: str
    path: Path
    channels: str


@dataclass(frozen=True)
class _ParticleMaterialSource:
    name: str
    standard: Any
    colors: tuple[_LayerSource, ...]
    alphas: tuple[_LayerSource, ...]


@dataclass
class _ParticleMaterialRuntime:
    material: Any
    mapping: Any
    tint: Any
    alpha: Any


@dataclass(frozen=True)
class _ForceSample:
    index: int
    force_type: str
    shape: str
    matrix_local: Any
    matrix_world: Any
    width: float
    height: float
    length: float
    strength: float
    falloff: bool
    unbounded: bool
    channels: frozenset[int]


@dataclass(frozen=True)
class _SystemSample:
    frame: int
    bone_local: Any
    bone_world: Any
    armature_world: Any
    camera_world: Any | None
    values: Mapping[str, Any]
    forces: tuple[_ForceSample, ...]


@dataclass(frozen=True)
class _Spawn:
    system_name: str
    serial: int
    birth_frame: int
    death_frame: int
    sample: _SystemSample
    offset: Any
    direction: Any
    speed: float
    size_curve: tuple[float, float, float]
    color_curve: tuple[tuple[float, float, float, float], ...]
    rotation_curve: tuple[float, float, float]
    flipbook_offset: int
    noise_seed: int


class ExactTextureResolver:
    """Resolve archive-relative texture paths without basename substitution."""

    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        if not self.root.is_dir():
            raise M3EffectRealizationError(f"Texture root does not exist: {self.root}")
        supported = {".dds", ".png", ".tga", ".tif", ".tiff", ".jpg", ".jpeg", ".exr"}
        self._paths: dict[str, Path] = {}
        for candidate in self.root.rglob("*"):
            if not candidate.is_file() or candidate.suffix.lower() not in supported:
                continue
            key = candidate.relative_to(self.root).as_posix().casefold()
            previous = self._paths.get(key)
            if previous is not None and previous != candidate:
                raise M3EffectRealizationError(
                    f"Case-colliding texture paths are ambiguous: {previous} and {candidate}"
                )
            self._paths[key] = candidate

    def resolve(self, raw_path: str) -> Path | None:
        normalized = raw_path.strip().replace("\\", "/")
        if not normalized or normalized.startswith("/") or ":" in normalized.split("/", 1)[0]:
            return None
        parts = normalized.split("/")
        if any(part in {"", ".", ".."} for part in parts):
            return None
        direct = self._paths.get(normalized.casefold())
        if direct is not None:
            return direct
        # A caller may deliberately point at the exact Assets/Textures folder.
        prefix = "assets/textures/"
        if self.root.as_posix().casefold().endswith("/assets/textures") and normalized.casefold().startswith(prefix):
            return self._paths.get(normalized[len(prefix) :].casefold())
        return None


def _require_blender() -> None:
    if bpy is None:
        raise M3EffectRealizationError("m3_effect_realizer.py must run inside Blender's Python runtime.")


def _log(message: str) -> None:
    print(f"{MODULE_PREFIX} {message}", flush=True)


def _issue(
    report: EffectRealizationReport,
    severity: str,
    code: str,
    source: str,
    message: str,
) -> None:
    report.issues.append(RealizationIssue(severity, code, source, message))
    _log(f"{severity} {code} {source}: {message}")


def _by_handle(collection: Iterable[Any], pointer_or_handle: Any) -> Any | None:
    handle = str(getattr(pointer_or_handle, "handle", pointer_or_handle) or "")
    if not handle:
        return None
    return next((item for item in collection if str(getattr(item, "bl_handle", "")) == handle), None)


def _pose_bone(armature: Any, pointer: Any) -> Any | None:
    return _by_handle(getattr(armature.pose, "bones", ()), pointer)


def _safe_name(value: str) -> str:
    cleaned = "".join(character if character.isalnum() or character in "_-" else "_" for character in value)
    return cleaned.strip("_") or "effect"


def _stable_seed(base: int, *values: Any) -> int:
    digest = hashlib.sha256("\0".join(str(value) for value in (base, *values)).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "little", signed=False)


def _plain_vector(value: Any, size: int, default: float = 0.0) -> tuple[float, ...]:
    try:
        result = tuple(float(item) for item in value)
    except (TypeError, ValueError):
        result = ()
    if len(result) != size:
        return tuple(default for _ in range(size))
    return result


def _collection(scene: Any, name: str) -> Any:
    existing = bpy.data.collections.get(name)
    if existing is not None:
        if existing.name not in {child.name for child in scene.collection.children}:
            scene.collection.children.link(existing)
        return existing
    created = bpy.data.collections.new(name)
    scene.collection.children.link(created)
    return created


def _clear_generated(collection: Any, armature_name: str) -> None:
    for obj in list(collection.objects):
        if str(obj.get("m3_effect_source_armature", "")) != armature_name:
            continue
        bpy.data.objects.remove(obj, do_unlink=True)


def _load_image(path: Path, *, non_color: bool) -> Any:
    image = bpy.data.images.load(str(path), check_existing=True)
    try:
        image.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
    except (TypeError, ValueError):
        pass
    image.alpha_mode = "STRAIGHT"
    return image


def _channel_socket(nodes: Any, links: Any, texture: Any, channel: str) -> Any:
    channel = channel.upper()
    if channel == "A":
        return texture.outputs["Alpha"]
    if channel in {"R", "G", "B"}:
        try:
            separate = nodes.new("ShaderNodeSeparateColor")
            output = {"R": "Red", "G": "Green", "B": "Blue"}[channel]
            links.new(texture.outputs["Color"], separate.inputs["Color"])
        except RuntimeError:
            separate = nodes.new("ShaderNodeSeparateRGB")
            output = channel
            links.new(texture.outputs["Color"], separate.inputs["Image"])
        return separate.outputs[output]
    return texture.outputs["Color"]


def _particle_material_source(
    armature: Any,
    system: Any,
    resolver: ExactTextureResolver,
    report: EffectRealizationReport,
    strict: bool,
) -> _ParticleMaterialSource | None:
    matref = _by_handle(getattr(armature, "m3_materialrefs", ()), getattr(system, "material", None))
    source_name = str(getattr(system, "name", "particle"))
    if matref is None:
        _issue(report, "ERROR", "MISSING_PARTICLE_MATERIAL", source_name, "Emitter material handle is unresolved.")
        return None
    if str(getattr(matref, "mat_type", "")) != "m3_materials_standard":
        _issue(
            report,
            "ERROR",
            "UNSUPPORTED_PARTICLE_MATERIAL",
            source_name,
            f"Material {getattr(matref, 'name', '')!r} is {getattr(matref, 'mat_type', '')!r}, not standard.",
        )
        return None
    standard = _by_handle(getattr(armature, "m3_materials_standard", ()), getattr(matref, "mat_handle", ""))
    if standard is None:
        _issue(report, "ERROR", "MISSING_STANDARD_MATERIAL", source_name, "Standard material body is unresolved.")
        return None

    colors: list[_LayerSource] = []
    alphas: list[_LayerSource] = []
    missing: list[str] = []
    for slot in ("diff", "emis1", "emis2", "alpha1", "alpha2"):
        layer = _by_handle(
            getattr(armature, "m3_materiallayers", ()),
            str(getattr(standard, f"layer_{slot}", "")),
        )
        if layer is None:
            continue
        bitmap = str(getattr(layer, "color_bitmap", "")).strip()
        if str(getattr(layer, "color_type", "")) != "BITMAP" or not bitmap:
            continue
        path = resolver.resolve(bitmap)
        if path is None:
            missing.append(bitmap)
            continue
        row = _LayerSource(slot, layer, bitmap, path, str(getattr(layer, "color_channels", "RGB")))
        if slot.startswith("alpha"):
            alphas.append(row)
        else:
            colors.append(row)
    if missing:
        severity = "ERROR" if strict else "WARNING"
        _issue(
            report,
            severity,
            "MISSING_PARTICLE_TEXTURE",
            source_name,
            "Exact texture export(s) unavailable: " + ", ".join(sorted(set(missing))),
        )
        if strict:
            return None
    if not colors:
        _issue(report, "ERROR", "NO_PARTICLE_COLOR_LAYER", source_name, "No loadable diffuse/emissive bitmap exists.")
        return None
    return _ParticleMaterialSource(str(getattr(matref, "name", "material")), standard, tuple(colors), tuple(alphas))


def _build_particle_material(
    source: _ParticleMaterialSource,
    name: str,
    config: EffectBakeConfig,
) -> _ParticleMaterialRuntime:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.use_backface_culling = False
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    emission = nodes.new("ShaderNodeEmission")
    mix_shader = nodes.new("ShaderNodeMixShader")
    links.new(transparent.outputs["BSDF"], mix_shader.inputs[1])
    links.new(emission.outputs["Emission"], mix_shader.inputs[2])
    links.new(mix_shader.outputs["Shader"], output.inputs["Surface"])

    uv_map = nodes.new("ShaderNodeUVMap")
    uv_map.uv_map = "UVMap"
    mapping = nodes.new("ShaderNodeMapping")
    mapping.name = "M3_FlipbookMapping"
    links.new(uv_map.outputs["UV"], mapping.inputs["Vector"])

    color_socket = None
    diffuse_alpha = None
    for index, layer in enumerate(source.colors):
        texture = nodes.new("ShaderNodeTexImage")
        texture.name = f"M3_Color_{index}_{layer.slot}"
        texture.label = layer.bitmap
        texture.image = _load_image(layer.path, non_color=False)
        texture.extension = "REPEAT"
        links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
        current = _channel_socket(nodes, links, texture, layer.channels)
        if layer.slot == "diff":
            diffuse_alpha = texture.outputs["Alpha"]
        if color_socket is None:
            color_socket = current
        else:
            add = nodes.new("ShaderNodeMixRGB")
            add.blend_type = "ADD"
            add.inputs[0].default_value = 1.0
            links.new(color_socket, add.inputs[1])
            links.new(current, add.inputs[2])
            color_socket = add.outputs["Color"]

    tint = nodes.new("ShaderNodeRGB")
    tint.name = "M3_ParticleTint"
    tint.outputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    tint_mix = nodes.new("ShaderNodeMixRGB")
    tint_mix.blend_type = "MULTIPLY"
    tint_mix.inputs[0].default_value = 1.0
    links.new(color_socket, tint_mix.inputs[1])
    links.new(tint.outputs["Color"], tint_mix.inputs[2])
    links.new(tint_mix.outputs["Color"], emission.inputs["Color"])
    emission.inputs["Strength"].default_value = max(
        0.0,
        float(getattr(source.standard, "hdr_emis", 1.0)) * config.particle_emission_strength,
    )

    alpha_socket = None
    for index, layer in enumerate(source.alphas):
        texture = nodes.new("ShaderNodeTexImage")
        texture.name = f"M3_Alpha_{index}_{layer.slot}"
        texture.label = layer.bitmap
        texture.image = _load_image(layer.path, non_color=True)
        texture.extension = "REPEAT"
        links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
        current = _channel_socket(nodes, links, texture, layer.channels)
        if alpha_socket is None:
            alpha_socket = current
        else:
            multiply = nodes.new("ShaderNodeMath")
            multiply.operation = "MULTIPLY"
            links.new(alpha_socket, multiply.inputs[0])
            links.new(current, multiply.inputs[1])
            alpha_socket = multiply.outputs["Value"]
    if alpha_socket is None:
        alpha_socket = diffuse_alpha
    if alpha_socket is None:
        constant_alpha = nodes.new("ShaderNodeValue")
        constant_alpha.outputs["Value"].default_value = 1.0
        alpha_socket = constant_alpha.outputs["Value"]
    alpha = nodes.new("ShaderNodeValue")
    alpha.name = "M3_ParticleAlpha"
    alpha.outputs["Value"].default_value = 1.0
    alpha_multiply = nodes.new("ShaderNodeMath")
    alpha_multiply.operation = "MULTIPLY"
    links.new(alpha_socket, alpha_multiply.inputs[0])
    links.new(alpha.outputs["Value"], alpha_multiply.inputs[1])
    global_opacity = nodes.new("ShaderNodeValue")
    global_opacity.name = "M3_GlobalParticleOpacity"
    global_opacity.label = "Source alpha × alert opacity"
    global_opacity.outputs["Value"].default_value = float(config.particle_opacity)
    composited_alpha = nodes.new("ShaderNodeMath")
    composited_alpha.name = "M3_CompositedParticleAlpha"
    composited_alpha.operation = "MULTIPLY"
    links.new(alpha_multiply.outputs["Value"], composited_alpha.inputs[0])
    links.new(global_opacity.outputs["Value"], composited_alpha.inputs[1])
    links.new(composited_alpha.outputs["Value"], mix_shader.inputs[0])

    if hasattr(material, "surface_render_method"):
        material.surface_render_method = "DITHERED"
    elif hasattr(material, "blend_method"):
        material.blend_method = "BLEND"
    if hasattr(material, "use_transparency_overlap"):
        material.use_transparency_overlap = False
    return _ParticleMaterialRuntime(material, mapping, tint, alpha)


def _quad_mesh(name: str) -> Any:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(
        [(-0.5, -0.5, 0.0), (0.5, -0.5, 0.0), (0.5, 0.5, 0.0), (-0.5, 0.5, 0.0)],
        [],
        [(0, 1, 2, 3)],
    )
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="UVMap")
    coordinates = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
    for loop in mesh.loops:
        uv_layer.data[loop.index].uv = coordinates[loop.vertex_index]
    return mesh


def _system_values(system: Any) -> dict[str, Any]:
    scalar_names = (
        "particle_type",
        "emit_type",
        "emit_shape",
        "emit_shape_cutout",
        "emit_shape_radius",
        "emit_shape_radius_cutout",
        "emit_max",
        "emit_rate",
        "emit_count",
        "emit_speed",
        "emit_speed_random",
        "emit_speed_randomize",
        "emit_angle_x",
        "emit_angle_y",
        "emit_spread_x",
        "emit_spread_y",
        "lifespan",
        "lifespan_random",
        "lifespan_randomize",
        "gravity",
        "drag",
        "friction",
        "size_randomize",
        "color_randomize",
        "alpha_randomize",
        "rotation_randomize",
        "size_anim_mid",
        "color_anim_mid",
        "alpha_anim_mid",
        "rotation_anim_mid",
        "size_smoothing",
        "color_smoothing",
        "rotation_smoothing",
        "noise_amplitude",
        "noise_frequency",
        "noise_cohesion",
        "noise_edge",
        "instance_tail",
        "tail_type",
        "world_space",
        "relative",
        "always_set",
        "simulate_init",
        "parent_velocity",
        "uv_flipbook_cols",
        "uv_flipbook_rows",
        "uv_flipbook_start_init_index",
        "uv_flipbook_start_stop_index",
        "uv_flipbook_end_init_index",
        "uv_flipbook_end_stop_index",
        "uv_flipbook_start_lifespan_factor",
        "random_uv_flipbook_start",
    )
    values = {name: getattr(system, name) for name in scalar_names}
    for name, size, default in (
        ("emit_shape_size", 3, 1.0),
        ("emit_shape_size_cutout", 3, 0.0),
        ("instance_direction", 3, 0.0),
        ("size", 3, 1.0),
        ("size2", 3, 1.0),
        ("rotation", 3, 0.0),
        ("rotation2", 3, 0.0),
        ("color_init", 4, 1.0),
        ("color_mid", 4, 1.0),
        ("color_end", 4, 0.0),
        ("color2_init", 4, 1.0),
        ("color2_mid", 4, 1.0),
        ("color2_end", 4, 0.0),
    ):
        values[name] = _plain_vector(getattr(system, name), size, default)
    values["local_forces"] = frozenset(
        index for index, enabled in enumerate(getattr(system, "local_forces", ())) if enabled
    )
    values["world_forces"] = frozenset(
        index for index, enabled in enumerate(getattr(system, "world_forces", ())) if enabled
    )
    return values


def _force_samples(armature: Any) -> tuple[_ForceSample, ...]:
    result: list[_ForceSample] = []
    for index, force in enumerate(getattr(armature, "m3_forces", ())):
        bone = _pose_bone(armature, getattr(force, "bone", None))
        if bone is None:
            continue
        local = bone.matrix.copy()
        result.append(
            _ForceSample(
                index=index,
                force_type=str(getattr(force, "force_type", "DIRECTIONAL")),
                shape=str(getattr(force, "shape", "SPHERE")),
                matrix_local=local,
                matrix_world=(armature.matrix_world @ local).copy(),
                width=float(getattr(force, "width", 1.0)),
                height=float(getattr(force, "height", 1.0)),
                length=float(getattr(force, "length", 1.0)),
                strength=float(getattr(force, "strength", 0.0)),
                falloff=bool(getattr(force, "falloff", False)),
                unbounded=bool(getattr(force, "unbounded", False)),
                channels=frozenset(index for index, enabled in enumerate(getattr(force, "channels", ())) if enabled),
            )
        )
    return tuple(result)


def _capture_samples(
    armature: Any,
    systems: Sequence[Any],
    scene: Any,
    camera: Any | None,
    frame_start: int,
    frame_end: int,
    step: int,
    report: EffectRealizationReport,
) -> list[dict[int, _SystemSample]]:
    samples: list[dict[int, _SystemSample]] = [dict() for _ in systems]
    missing_bones: set[str] = set()
    frames = list(range(frame_start, frame_end + 1, step))
    if frames[-1] != frame_end:
        frames.append(frame_end)
    for frame in frames:
        scene.frame_set(frame)
        forces = _force_samples(armature)
        camera_world = camera.matrix_world.copy() if camera is not None else None
        for index, system in enumerate(systems):
            bone = _pose_bone(armature, getattr(system, "bone", None))
            if bone is None:
                name = str(getattr(system, "name", index))
                if name not in missing_bones:
                    _issue(report, "ERROR", "MISSING_EMITTER_BONE", name, "Emitter bone handle is unresolved.")
                    missing_bones.add(name)
                continue
            local = bone.matrix.copy()
            samples[index][frame] = _SystemSample(
                frame=frame,
                bone_local=local,
                bone_world=(armature.matrix_world @ local).copy(),
                armature_world=armature.matrix_world.copy(),
                camera_world=camera_world,
                values=_system_values(system),
                forces=forces,
            )
    return samples


def _random_unit_vector(rng: random.Random) -> Any:
    z = rng.uniform(-1.0, 1.0)
    angle = rng.uniform(0.0, math.tau)
    radius = math.sqrt(max(0.0, 1.0 - z * z))
    return Vector((radius * math.cos(angle), radius * math.sin(angle), z))


def _weighted_choice(weights: Sequence[float], rng: random.Random) -> int:
    """Return a deterministic index, ignoring empty geometric regions."""

    positive = tuple(max(0.0, float(weight)) for weight in weights)
    total = sum(positive)
    if total <= 1e-12:
        return 0
    target = rng.random() * total
    accumulated = 0.0
    for index, weight in enumerate(positive):
        accumulated += weight
        if target <= accumulated:
            return index
    return len(positive) - 1


def _outside_centered_interval(outer: float, inner: float, rng: random.Random) -> float:
    """Sample ``[-outer/2, outer/2]`` outside its centered inner interval."""

    outer = max(0.0, float(outer))
    inner = max(0.0, min(outer, float(inner)))
    if outer - inner <= 1e-12:
        return outer * (0.5 if rng.random() < 0.5 else -0.5)
    magnitude = rng.uniform(inner * 0.5, outer * 0.5)
    return magnitude if rng.random() < 0.5 else -magnitude


def _plane_perimeter(size: Sequence[float], rng: random.Random) -> Any:
    width, depth = (max(0.0, float(size[index])) for index in range(2))
    side = _weighted_choice((depth, width), rng)
    if side == 0:
        return Vector((width * (0.5 if rng.random() < 0.5 else -0.5), rng.uniform(-0.5, 0.5) * depth, 0.0))
    return Vector((rng.uniform(-0.5, 0.5) * width, depth * (0.5 if rng.random() < 0.5 else -0.5), 0.0))


def _box_surface(size: Sequence[float], rng: random.Random) -> Any:
    width, depth, height = (max(0.0, float(component)) for component in size)
    axis = _weighted_choice((depth * height, width * height, width * depth), rng)
    coordinates = [
        rng.uniform(-0.5, 0.5) * width,
        rng.uniform(-0.5, 0.5) * depth,
        rng.uniform(-0.5, 0.5) * height,
    ]
    coordinates[axis] = (width, depth, height)[axis] * (0.5 if rng.random() < 0.5 else -0.5)
    return Vector(coordinates)


def _cylinder_surface(radius: float, height: float, rng: random.Random) -> Any:
    radius = max(0.0, float(radius))
    height = max(0.0, float(height))
    # One lateral surface and two end caps, selected by true surface area.
    surface = _weighted_choice((2.0 * math.pi * radius * height, 2.0 * math.pi * radius * radius), rng)
    angle = rng.uniform(0.0, math.tau)
    if surface == 0:
        radial = radius
        z = rng.uniform(-0.5, 0.5) * height
    else:
        radial = radius * math.sqrt(rng.random())
        z = height * (0.5 if rng.random() < 0.5 else -0.5)
    return Vector((radial * math.cos(angle), radial * math.sin(angle), z))


def _shape_offset(values: Mapping[str, Any], rng: random.Random) -> Any:
    shape = str(values["emit_shape"])
    size = tuple(max(0.0, float(component)) for component in values["emit_shape_size"])
    cutout_size = tuple(
        min(size[index], max(0.0, float(component)))
        for index, component in enumerate(values["emit_shape_size_cutout"])
    )
    radius = max(0.0, float(values["emit_shape_radius"]))
    cutout_radius = min(radius, max(0.0, float(values["emit_shape_radius_cutout"])))
    cutout = bool(values["emit_shape_cutout"])
    offset = Vector((0.0, 0.0, 0.0))
    if shape == "POINT":
        return offset
    if shape == "PLANE":
        outer_area = size[0] * size[1]
        inner_area = cutout_size[0] * cutout_size[1] if cutout else 0.0
        if cutout and outer_area - inner_area <= 1e-12:
            return _plane_perimeter(size, rng)
        region = _weighted_choice(
            (
                (size[0] - cutout_size[0]) * size[1],
                cutout_size[0] * (size[1] - cutout_size[1]),
            ),
            rng,
        ) if cutout else 0
        if cutout and region == 0:
            offset = Vector(
                (
                    _outside_centered_interval(size[0], cutout_size[0], rng),
                    rng.uniform(-0.5, 0.5) * size[1],
                    0.0,
                )
            )
        elif cutout:
            offset = Vector(
                (
                    rng.uniform(-0.5, 0.5) * cutout_size[0],
                    _outside_centered_interval(size[1], cutout_size[1], rng),
                    0.0,
                )
            )
        else:
            offset = Vector((rng.uniform(-0.5, 0.5) * size[0], rng.uniform(-0.5, 0.5) * size[1], 0.0))
    elif shape == "CUBE":
        outer_volume = size[0] * size[1] * size[2]
        inner_volume = cutout_size[0] * cutout_size[1] * cutout_size[2] if cutout else 0.0
        if cutout and outer_volume - inner_volume <= 1e-12:
            return _box_surface(size, rng)
        region = _weighted_choice(
            (
                (size[0] - cutout_size[0]) * size[1] * size[2],
                cutout_size[0] * (size[1] - cutout_size[1]) * size[2],
                cutout_size[0] * cutout_size[1] * (size[2] - cutout_size[2]),
            ),
            rng,
        ) if cutout else 0
        if cutout and region == 0:
            offset = Vector(
                (
                    _outside_centered_interval(size[0], cutout_size[0], rng),
                    rng.uniform(-0.5, 0.5) * size[1],
                    rng.uniform(-0.5, 0.5) * size[2],
                )
            )
        elif cutout and region == 1:
            offset = Vector(
                (
                    rng.uniform(-0.5, 0.5) * cutout_size[0],
                    _outside_centered_interval(size[1], cutout_size[1], rng),
                    rng.uniform(-0.5, 0.5) * size[2],
                )
            )
        elif cutout:
            offset = Vector(
                (
                    rng.uniform(-0.5, 0.5) * cutout_size[0],
                    rng.uniform(-0.5, 0.5) * cutout_size[1],
                    _outside_centered_interval(size[2], cutout_size[2], rng),
                )
            )
        else:
            offset = Vector(tuple(rng.uniform(-0.5, 0.5) * component for component in size))
    elif shape == "SPHERE":
        if cutout and radius - cutout_radius <= 1e-12:
            radial = radius
        else:
            inner_cubed = cutout_radius**3 if cutout else 0.0
            radial = (inner_cubed + rng.random() * (radius**3 - inner_cubed)) ** (1.0 / 3.0)
        offset = _random_unit_vector(rng) * radial
    elif shape == "DISC":
        if cutout and radius - cutout_radius <= 1e-12:
            radial = radius
        else:
            inner_squared = cutout_radius**2 if cutout else 0.0
            radial = math.sqrt(inner_squared + rng.random() * (radius**2 - inner_squared))
        angle = rng.uniform(0.0, math.tau)
        offset = Vector((radial * math.cos(angle), radial * math.sin(angle), 0.0))
    elif shape == "CYLINDER":
        height = size[2]
        cutout_height = cutout_size[2]
        outer_volume = math.pi * radius**2 * height
        inner_volume = math.pi * cutout_radius**2 * cutout_height if cutout else 0.0
        if cutout and outer_volume - inner_volume <= 1e-12:
            return _cylinder_surface(radius, height, rng)
        region = _weighted_choice(
            (
                math.pi * (radius**2 - cutout_radius**2) * height,
                math.pi * cutout_radius**2 * (height - cutout_height),
            ),
            rng,
        ) if cutout else 0
        angle = rng.uniform(0.0, math.tau)
        if cutout and region == 0:
            radial = math.sqrt(cutout_radius**2 + rng.random() * (radius**2 - cutout_radius**2))
            z = rng.uniform(-0.5, 0.5) * height
        elif cutout:
            radial = cutout_radius * math.sqrt(rng.random())
            z = _outside_centered_interval(height, cutout_height, rng)
        else:
            radial = radius * math.sqrt(rng.random())
            z = rng.uniform(-0.5, 0.5) * height
        offset = Vector((radial * math.cos(angle), radial * math.sin(angle), z))
    return offset


def _emission_direction(values: Mapping[str, Any], offset: Any, rng: random.Random) -> Any:
    emit_type = str(values["emit_type"])
    if emit_type == "RADIAL":
        direction = offset.normalized() if offset.length > 1e-6 else _random_unit_vector(rng)
    elif emit_type == "RANDOM":
        direction = _random_unit_vector(rng)
    elif emit_type == "ZAXIS":
        direction = Vector((rng.uniform(-1.0, 1.0), rng.uniform(-1.0, 1.0), rng.choice((-1.0, 1.0))))
        direction.normalize()
    else:
        direction = Vector(values["instance_direction"])
        if direction.length < 1e-6:
            direction = Vector((0.0, 0.0, 1.0))
        direction.normalize()
    angle_x = float(values["emit_angle_x"]) + rng.uniform(-0.5, 0.5) * float(values["emit_spread_x"])
    angle_y = float(values["emit_angle_y"]) + rng.uniform(-0.5, 0.5) * float(values["emit_spread_y"])
    rotation = Matrix.Rotation(angle_x, 4, "X") @ Matrix.Rotation(angle_y, 4, "Y")
    return (rotation.to_3x3() @ direction).normalized()


def _lerp_tuple(first: Sequence[float], second: Sequence[float], amount: float) -> tuple[float, ...]:
    return tuple(float(a) + (float(b) - float(a)) * amount for a, b in zip(first, second))


def _randomized_curve(
    first: Sequence[float],
    second: Sequence[float],
    enabled: bool,
    rng: random.Random,
) -> tuple[float, ...]:
    return _lerp_tuple(first, second, rng.random()) if enabled else tuple(float(value) for value in first)


def _spawn(
    system_name: str,
    serial: int,
    frame: int,
    sample: _SystemSample,
    fps: float,
    config: EffectBakeConfig,
) -> _Spawn:
    rng = random.Random(_stable_seed(config.seed, system_name, serial, frame))
    values = sample.values
    life = max(1.0 / fps, float(values["lifespan"]))
    if bool(values["lifespan_randomize"]):
        life = max(1.0 / fps, rng.uniform(min(life, float(values["lifespan_random"])), max(life, float(values["lifespan_random"]))))
    speed = float(values["emit_speed"])
    if bool(values["emit_speed_randomize"]):
        other = float(values["emit_speed_random"])
        speed = rng.uniform(min(speed, other), max(speed, other))
    offset = _shape_offset(values, rng)
    direction = _emission_direction(values, offset, rng)
    size_curve = _randomized_curve(values["size"], values["size2"], bool(values["size_randomize"]), rng)
    rotation_curve = _randomized_curve(
        values["rotation"], values["rotation2"], bool(values["rotation_randomize"]), rng
    )
    base_colors = (values["color_init"], values["color_mid"], values["color_end"])
    random_colors = (values["color2_init"], values["color2_mid"], values["color2_end"])
    random_amount = rng.random() if bool(values["color_randomize"] or values["alpha_randomize"]) else 0.0
    colors = tuple(_lerp_tuple(base, alternate, random_amount) for base, alternate in zip(base_colors, random_colors))
    total_cells = max(1, int(values["uv_flipbook_cols"]) or 1) * max(1, int(values["uv_flipbook_rows"]) or 1)
    flipbook_offset = rng.randrange(total_cells) if bool(values["random_uv_flipbook_start"]) else 0
    return _Spawn(
        system_name=system_name,
        serial=serial,
        birth_frame=frame,
        death_frame=min(frame + max(1, int(round(life * fps))), 2**31 - 1),
        sample=sample,
        offset=offset,
        direction=direction,
        speed=speed,
        size_curve=(float(size_curve[0]), float(size_curve[1]), float(size_curve[2])),
        color_curve=tuple(tuple(float(channel) for channel in color) for color in colors),
        rotation_curve=(float(rotation_curve[0]), float(rotation_curve[1]), float(rotation_curve[2])),
        flipbook_offset=flipbook_offset,
        noise_seed=_stable_seed(config.seed, system_name, "coherent-noise"),
    )


def _schedule_spawns(
    system: Any,
    samples: Mapping[int, _SystemSample],
    fps: float,
    config: EffectBakeConfig,
    frame_start: int,
    frame_end: int,
    remaining_total: int,
) -> list[_Spawn]:
    name = str(getattr(system, "name", "particle"))
    result: list[_Spawn] = []
    accumulator = 0.0
    previous_count = 0
    serial = 0
    live_deaths: list[int] = []

    first_sample = samples.get(frame_start)
    if first_sample and config.prewarm_simulate_init and bool(first_sample.values["simulate_init"]):
        life = max(0.0, float(first_sample.values["lifespan"]))
        rate = max(0.0, float(first_sample.values["emit_rate"]))
        prewarm = min(int(math.ceil(rate * life)), config.max_particles_per_system, remaining_total)
        for index in range(prewarm):
            fraction = (index + 1) / (prewarm + 1)
            birth = frame_start - max(1, int(round(life * fps * fraction)))
            result.append(_spawn(name, serial, birth, first_sample, fps, config))
            serial += 1

    for frame in range(frame_start, frame_end + 1, config.bake_step):
        sample = samples.get(frame)
        if sample is None:
            continue
        values = sample.values
        live_deaths = [death for death in live_deaths if death >= frame]
        emit_max = max(0, int(values["emit_max"]))
        live_capacity = max(0, emit_max - len(live_deaths)) if emit_max else config.max_particles_per_system
        accumulator += max(0.0, float(values["emit_rate"])) * config.bake_step / fps
        rate_births = int(math.floor(accumulator + 1e-9))
        accumulator -= rate_births
        count = max(0, int(round(float(values["emit_count"]))))
        burst_births = max(0, count - previous_count)
        previous_count = count
        requested = rate_births + burst_births
        capacity = min(
            live_capacity,
            config.max_particles_per_system - len(result),
            remaining_total - len(result),
        )
        for _ in range(max(0, min(requested, capacity))):
            spawned = _spawn(name, serial, frame, sample, fps, config)
            result.append(spawned)
            live_deaths.append(spawned.death_frame)
            serial += 1
        if len(result) >= config.max_particles_per_system or len(result) >= remaining_total:
            break
    return result


def _smooth_amount(amount: float, smoothing: str) -> float:
    amount = max(0.0, min(1.0, amount))
    if "BEZIER" in smoothing or "SMOOTH" in smoothing:
        return amount * amount * (3.0 - 2.0 * amount)
    return amount


def _life_value(values: Sequence[float], age: float, midpoint: float, smoothing: str) -> float:
    midpoint = max(1e-5, min(1.0 - 1e-5, midpoint))
    if age <= midpoint:
        amount = _smooth_amount(age / midpoint, smoothing)
        return float(values[0]) + (float(values[1]) - float(values[0])) * amount
    amount = _smooth_amount((age - midpoint) / (1.0 - midpoint), smoothing)
    return float(values[1]) + (float(values[2]) - float(values[1])) * amount


def _life_color(spawn: _Spawn, age: float, values: Mapping[str, Any]) -> tuple[float, float, float, float]:
    rgb_mid = float(values["color_anim_mid"])
    alpha_mid = float(values["alpha_anim_mid"])
    smoothing = str(values["color_smoothing"])
    rgb = tuple(
        _life_value(tuple(color[channel] for color in spawn.color_curve), age, rgb_mid, smoothing)
        for channel in range(3)
    )
    alpha = _life_value(tuple(color[3] for color in spawn.color_curve), age, alpha_mid, smoothing)
    return (*rgb, alpha)


def _particle_spin(spawn: _Spawn, age: float, values: Mapping[str, Any]) -> float:
    """Evaluate SC2's absolute or relative three-point rotation track.

    Absolute tracks store the three target angles directly.  With the PAR_
    relative-rotation flag, the middle and final controls are offsets from the
    preceding control.  Converting the offsets to cumulative controls before
    applying the declared M3 smoothing preserves the source curve semantics.
    """

    controls = spawn.rotation_curve
    if bool(values["relative"]):
        controls = (
            controls[0],
            controls[0] + controls[1],
            controls[0] + controls[1] + controls[2],
        )
    return _life_value(
        controls,
        age,
        float(values["rotation_anim_mid"]),
        str(values["rotation_smoothing"]),
    )


_UINT64_MASK = (1 << 64) - 1


def _mix_uint64(value: int) -> int:
    """SplitMix64 finalizer used as a platform-stable lattice hash."""

    value &= _UINT64_MASK
    value ^= value >> 30
    value = (value * 0xBF58476D1CE4E5B9) & _UINT64_MASK
    value ^= value >> 27
    value = (value * 0x94D049BB133111EB) & _UINT64_MASK
    value ^= value >> 31
    return value & _UINT64_MASK


def _lattice_value(seed: int, x: int, y: int, z: int, channel: int) -> float:
    value = int(seed) & _UINT64_MASK
    value ^= (int(x) * 0x9E3779B185EBCA87) & _UINT64_MASK
    value ^= (int(y) * 0xC2B2AE3D27D4EB4F) & _UINT64_MASK
    value ^= (int(z) * 0x165667B19E3779F9) & _UINT64_MASK
    value ^= (int(channel) * 0xD6E8FEB86659FD93) & _UINT64_MASK
    # The upper 53 bits map exactly into a Python float mantissa.
    return ((_mix_uint64(value) >> 11) / float(1 << 53)) * 2.0 - 1.0


def _noise_fade(value: float) -> float:
    # Quintic interpolation gives continuous first and second derivatives at
    # lattice boundaries, avoiding visible pops in baked particle paths.
    return value * value * value * (value * (value * 6.0 - 15.0) + 10.0)


def _value_noise_3d(coordinate: Any, seed: int, channel: int) -> float:
    x0 = math.floor(float(coordinate.x))
    y0 = math.floor(float(coordinate.y))
    z0 = math.floor(float(coordinate.z))
    tx = _noise_fade(float(coordinate.x) - x0)
    ty = _noise_fade(float(coordinate.y) - y0)
    tz = _noise_fade(float(coordinate.z) - z0)
    corners: list[float] = []
    for z_offset in (0, 1):
        for y_offset in (0, 1):
            for x_offset in (0, 1):
                corners.append(
                    _lattice_value(seed, x0 + x_offset, y0 + y_offset, z0 + z_offset, channel)
                )
    x00 = corners[0] + (corners[1] - corners[0]) * tx
    x10 = corners[2] + (corners[3] - corners[2]) * tx
    x01 = corners[4] + (corners[5] - corners[4]) * tx
    x11 = corners[6] + (corners[7] - corners[6]) * tx
    y0_value = x00 + (x10 - x00) * ty
    y1_value = x01 + (x11 - x01) * ty
    return y0_value + (y1_value - y0_value) * tz


def _noise_advection(seed: int) -> Any:
    direction = Vector(
        (
            _lattice_value(seed, 17, -31, 47, 3),
            _lattice_value(seed, -59, 71, 89, 4),
            _lattice_value(seed, 97, 101, -103, 5),
        )
    )
    if direction.length <= 1e-9:
        return Vector((0.0, 0.0, 1.0))
    return direction.normalized()


def _coherent_noise_offset(
    position: Any,
    spawn: _Spawn,
    values: Mapping[str, Any],
    frame: int,
    fps: float,
) -> Any:
    """Evaluate documented post-simulation SC2 particle noise.

    Frequency scales the shared spatial field, cohesion is the source field's
    advection speed, amplitude bounds displacement, and edge ramps the effect
    from the emitter by normalized particle age.  The field seed is shared by
    all particles in one source system so neighboring particles remain
    coherent; it never uses per-frame randomness.
    """

    amplitude = float(values["noise_amplitude"])
    if abs(amplitude) <= 1e-9:
        return Vector((0.0, 0.0, 0.0))
    frequency = float(values["noise_frequency"])
    speed = float(values["noise_cohesion"])
    elapsed = frame / max(fps, 1e-9)
    coordinate = position * frequency + _noise_advection(spawn.noise_seed) * (elapsed * speed)
    noise = Vector(
        tuple(_value_noise_3d(coordinate, spawn.noise_seed, channel) for channel in range(3))
    )
    # Amplitude is documented as the maximum spatial push, so prevent the
    # independent channels from producing a sqrt(3)-larger displacement.
    if noise.length > 1.0:
        noise.normalize()
    life = max(1, spawn.death_frame - spawn.birth_frame)
    age = max(0.0, min(1.0, (frame - spawn.birth_frame) / life))
    edge = max(0.0, min(1.0, float(values["noise_edge"])))
    edge_amount = 1.0 if edge <= 1e-9 else _noise_fade(min(1.0, age / edge))
    return noise * (amplitude * edge_amount)


def _force_acceleration(
    position: Any,
    velocity: Any,
    sample: _SystemSample,
    channels: frozenset[int],
    world_space: bool,
) -> Any:
    acceleration = Vector((0.0, 0.0, 0.0))
    if not channels:
        return acceleration
    for force in sample.forces:
        if not channels.intersection(force.channels):
            continue
        matrix = force.matrix_world if world_space else force.matrix_local
        origin = matrix.translation
        delta = position - origin
        distance = delta.length
        radius = max(force.width, 1e-6)
        if not force.unbounded:
            if force.shape in {"SPHERE", "HEMISPHERE", "CONEDOME"} and distance > radius:
                continue
            local = matrix.inverted_safe() @ position
            if force.shape == "CYLINDER" and (
                math.hypot(local.x, local.y) > radius or abs(local.z) > max(force.height, 1e-6) * 0.5
            ):
                continue
            if force.shape == "CUBE" and (
                abs(local.x) > force.width * 0.5
                or abs(local.y) > force.length * 0.5
                or abs(local.z) > force.height * 0.5
            ):
                continue
        falloff = max(0.0, 1.0 - distance / radius) if force.falloff and not force.unbounded else 1.0
        amount = force.strength * falloff
        if force.force_type == "RADIAL":
            direction = delta.normalized() if distance > 1e-6 else Vector((0.0, 0.0, 0.0))
            acceleration += direction * amount
        elif force.force_type == "DAMPENING":
            acceleration -= velocity * abs(amount)
        elif force.force_type == "VORTEX":
            axis = matrix.to_3x3() @ Vector((0.0, 0.0, 1.0))
            tangent = axis.cross(delta)
            if tangent.length > 1e-6:
                acceleration += tangent.normalized() * amount
        else:
            direction = matrix.to_3x3() @ Vector((0.0, 0.0, 1.0))
            acceleration += direction.normalized() * amount
    return acceleration


def _basis_quaternion(normal: Any, up_hint: Any, spin: float = 0.0) -> Any:
    normal = normal.normalized() if normal.length > 1e-6 else Vector((0.0, 0.0, 1.0))
    right = up_hint.cross(normal)
    if right.length < 1e-6:
        right = Vector((1.0, 0.0, 0.0))
    right.normalize()
    up = normal.cross(right).normalized()
    if abs(spin) > 1e-8:
        rotation = Matrix.Rotation(spin, 3, normal)
        right = rotation @ right
        up = rotation @ up
    return Matrix((right, up, normal)).transposed().to_quaternion()


def _orientation(
    particle_type: str,
    position: Any,
    velocity_world: Any,
    sample: _SystemSample,
    spin: float,
) -> Any:
    camera_world = sample.camera_world
    if camera_world is not None:
        to_camera = camera_world.translation - position
        camera_up = camera_world.to_3x3() @ Vector((0.0, 1.0, 0.0))
    else:
        to_camera = Vector((0.0, -1.0, 0.0))
        camera_up = Vector((0.0, 0.0, 1.0))
    if particle_type in {"TAIL", "TAIL_ALT", "GROUND_TAIL", "RAY"}:
        normal = to_camera.normalized()
        tail = velocity_world - normal * velocity_world.dot(normal)
        if tail.length < 1e-6:
            tail = camera_up
        tail.normalize()
        right = tail.cross(normal)
        if right.length < 1e-6:
            right = Vector((1.0, 0.0, 0.0))
        right.normalize()
        # SC2's Start/Mid/End rotation applies about the final particle
        # normal for every particle type, including tails.  Keep the authored
        # travel-aligned basis, then apply its lifecycle roll in the camera
        # plane.  Relative Mid/End semantics have already been converted to a
        # cumulative angle by _particle_spin.
        if abs(spin) > 1e-8:
            rotation = Matrix.Rotation(spin, 3, normal)
            right = rotation @ right
            tail = rotation @ tail
        return Matrix((right, tail, normal)).transposed().to_quaternion()
    if particle_type in {"EMITTER", "EMISSION"}:
        normal = sample.bone_world.to_3x3() @ Vector((0.0, 0.0, 1.0))
        up = sample.bone_world.to_3x3() @ Vector((0.0, 1.0, 0.0))
        return _basis_quaternion(normal, up, spin)
    if particle_type in {"GROUND", "COLLISION"}:
        return _basis_quaternion(Vector((0.0, 0.0, 1.0)), Vector((0.0, 1.0, 0.0)), spin)
    return _basis_quaternion(to_camera, camera_up, spin)


def _flipbook_cell(values: Mapping[str, Any], spawn: _Spawn, age: float) -> tuple[int, int, int, int]:
    cols = max(1, int(values["uv_flipbook_cols"]) or 1)
    rows = max(1, int(values["uv_flipbook_rows"]) or 1)
    total = cols * rows
    start_a = max(0, min(total - 1, int(values["uv_flipbook_start_init_index"])))
    stop_a = max(0, min(total - 1, int(values["uv_flipbook_start_stop_index"])))
    start_b = max(0, min(total - 1, int(values["uv_flipbook_end_init_index"])))
    stop_b = max(0, min(total - 1, int(values["uv_flipbook_end_stop_index"])))
    factor_raw = values.get("uv_flipbook_start_lifespan_factor", 1.0)
    try:
        factor = float(factor_raw)
    except (TypeError, ValueError):
        factor = 1.0
    if not math.isfinite(factor) or factor <= 0.0:
        factor = 1.0
    factor = min(1.0, factor)
    if stop_a != start_a and age <= factor:
        amount = age / factor
        index = int(round(start_a + (stop_a - start_a) * amount))
    elif stop_b != start_b and age > factor and factor < 1.0:
        amount = (age - factor) / (1.0 - factor)
        index = int(round(start_b + (stop_b - start_b) * amount))
    else:
        index = start_a
    index = (index + spawn.flipbook_offset) % total
    return index % cols, index // cols, cols, rows


def _set_hidden(obj: Any, hidden: bool, frame: int) -> None:
    obj.hide_render = hidden
    obj.hide_viewport = hidden
    obj.keyframe_insert(data_path="hide_render", frame=frame)
    obj.keyframe_insert(data_path="hide_viewport", frame=frame)


def _animate_particle(
    obj: Any,
    material: _ParticleMaterialRuntime,
    spawn: _Spawn,
    samples: Mapping[int, _SystemSample],
    fps: float,
    config: EffectBakeConfig,
    frame_start: int,
    frame_end: int,
) -> None:
    values = spawn.sample.values
    world_space = bool(values["world_space"])
    if world_space:
        position = spawn.sample.bone_world @ spawn.offset
        velocity = spawn.sample.bone_world.to_3x3() @ spawn.direction * spawn.speed
        channels = values["local_forces"].union(values["world_forces"])
    else:
        position = spawn.sample.bone_local @ spawn.offset
        velocity = spawn.sample.bone_local.to_3x3() @ spawn.direction * spawn.speed
        channels = values["local_forces"].union(values["world_forces"])

    visible_start = max(frame_start, spawn.birth_frame)
    visible_end = min(frame_end, spawn.death_frame)
    if visible_end < visible_start:
        return
    _set_hidden(obj, True, visible_start - 1)
    _set_hidden(obj, False, visible_start)

    previous_frame = spawn.birth_frame
    previous_origin = spawn.sample.bone_world.translation.copy()
    for frame in range(spawn.birth_frame, visible_end + 1, config.bake_step):
        sample = samples.get(max(frame_start, frame), spawn.sample)
        if frame > spawn.birth_frame:
            dt = (frame - previous_frame) / fps
            gravity = Vector((0.0, 0.0, -float(values["gravity"])))
            acceleration = gravity + _force_acceleration(position, velocity, sample, channels, world_space)
            velocity += acceleration * dt
            drag = max(0.0, float(values["drag"]))
            if drag:
                velocity *= math.exp(-drag * dt)
            position += velocity * dt
            previous_frame = frame
        if frame < visible_start:
            continue
        display_position = position + _coherent_noise_offset(position, spawn, values, frame, fps)
        if world_space:
            world_position = display_position
            velocity_world = velocity
        else:
            world_position = sample.armature_world @ display_position
            velocity_world = sample.armature_world.to_3x3() @ velocity
        if frame == visible_start and float(values["parent_velocity"]) != 0.0:
            current_origin = sample.bone_world.translation
            velocity_world += (current_origin - previous_origin) * fps * float(values["parent_velocity"])
        age = max(0.0, min(1.0, (frame - spawn.birth_frame) / max(1, spawn.death_frame - spawn.birth_frame)))
        size = max(0.0, _life_value(spawn.size_curve, age, float(values["size_anim_mid"]), str(values["size_smoothing"])))
        spin = _particle_spin(spawn, age, values)
        particle_type = str(values["particle_type"])
        tail_length = size
        if particle_type in {"TAIL", "TAIL_ALT", "GROUND_TAIL", "RAY"}:
            computed = velocity_world.length * max(0.0, float(values["instance_tail"]))
            tail_type = str(values["tail_type"])
            if tail_type == "FIX":
                tail_length = max(size, float(values["instance_tail"]))
            elif tail_type == "CLAMP":
                tail_length = max(size, min(computed, float(values["instance_tail"])))
            else:
                tail_length = max(size, computed)
        obj.location = world_position
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = _orientation(particle_type, world_position, velocity_world, sample, spin)
        obj.scale = (size, tail_length, 1.0)
        obj.keyframe_insert(data_path="location", frame=frame)
        obj.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        obj.keyframe_insert(data_path="scale", frame=frame)

        color = _life_color(spawn, age, values)
        material.tint.outputs["Color"].default_value = color
        material.tint.outputs["Color"].keyframe_insert(data_path="default_value", frame=frame)
        material.alpha.outputs["Value"].default_value = max(0.0, min(1.0, color[3]))
        material.alpha.outputs["Value"].keyframe_insert(data_path="default_value", frame=frame)
        col, row, cols, rows = _flipbook_cell(values, spawn, age)
        material.mapping.inputs["Scale"].default_value = (1.0 / cols, 1.0 / rows, 1.0)
        material.mapping.inputs["Location"].default_value = (
            col / cols,
            (rows - 1 - row) / rows,
            0.0,
        )
        material.mapping.inputs["Location"].keyframe_insert(data_path="default_value", frame=frame)

    _set_hidden(obj, True, visible_end + 1)
    tree_animation = getattr(material.material.node_tree, "animation_data", None)
    action = getattr(tree_animation, "action", None)
    for curve in getattr(action, "fcurves", ()):
        if "M3_FlipbookMapping" in curve.data_path:
            for point in curve.keyframe_points:
                point.interpolation = "CONSTANT"


def _realize_particles(
    armature: Any,
    scene: Any,
    camera: Any | None,
    resolver: ExactTextureResolver,
    collection: Any,
    config: EffectBakeConfig,
    report: EffectRealizationReport,
    fps: float,
) -> None:
    systems = list(getattr(armature, "m3_particlesystems", ()))
    if not systems:
        return
    if camera is None:
        _issue(
            report,
            "WARNING",
            "NO_PARTICLE_CAMERA",
            armature.name,
            "Camera-facing particles use a fixed fallback orientation because no camera was supplied.",
        )
    samples_by_system = _capture_samples(
        armature,
        systems,
        scene,
        camera,
        report.frame_start,
        report.frame_end,
        config.bake_step,
        report,
    )
    created_total = 0
    for index, system in enumerate(systems):
        name = str(getattr(system, "name", f"particle_{index}"))
        particle_type = str(getattr(system, "particle_type", "BILLBOARD"))
        unsupported: list[str] = []
        trail_pointer = getattr(system, "trail_system", None)
        if str(getattr(trail_pointer, "handle", "")) or float(getattr(system, "trail_rate", 0.0)) != 0.0:
            unsupported.append("child particle trails")
        if any(
            bool(getattr(system, name, False))
            for name in ("collide_terrain", "collide_objects", "collide_emit")
        ) or str(getattr(getattr(system, "collide_system", None), "handle", "")):
            unsupported.append("collision events")
        if any(
            abs(float(getattr(system, name, 0.0))) > 1e-6
            for name in (
                "pitch_var_amplitude",
                "yaw_var_amplitude",
                "speed_var_amplitude",
                "size_var_amplitude",
                "alpha_var_amplitude",
                "color_var_amplitude",
                "rotation_var_amplitude",
                "spread_x_var_amplitude",
                "spread_y_var_amplitude",
            )
        ):
            unsupported.append("continuous sinusoidal variation")
        if unsupported:
            _issue(
                report,
                "WARNING",
                "PARTICLE_FEATURE_APPROXIMATION",
                name,
                "Not reproduced exactly: " + ", ".join(unsupported) + ".",
            )
        if str(getattr(system, "emit_shape", "POINT")) in {"MESH", "SPLINE"}:
            _issue(
                report,
                "WARNING",
                "EMITTER_SHAPE_FALLBACK",
                name,
                f"{getattr(system, 'emit_shape', '')} emission falls back to the emitter origin.",
            )
        if str(getattr(system, "model_path", "")).strip():
            _issue(
                report,
                "ERROR",
                "MODEL_PARTICLE_UNSUPPORTED",
                name,
                f"External model particle {getattr(system, 'model_path', '')!r} is not a sprite.",
            )
            report.particle_systems.append(
                ParticleSystemResult(name, None, particle_type, 0, (), "external model particle")
            )
            continue
        source = _particle_material_source(armature, system, resolver, report, config.strict_textures)
        if source is None:
            report.particle_systems.append(ParticleSystemResult(name, None, particle_type, 0, (), "material unavailable"))
            continue
        remaining = max(0, config.max_particles_total - created_total)
        spawns = _schedule_spawns(
            system,
            samples_by_system[index],
            fps,
            config,
            report.frame_start,
            report.frame_end,
            remaining,
        )
        if not spawns:
            report.particle_systems.append(
                ParticleSystemResult(name, source.name, particle_type, 0, (), "inactive in sampled frame range")
            )
            continue
        mesh = _quad_mesh(f"M3FX_{_safe_name(name)}_QUAD")
        created: list[str] = []
        for spawn in spawns:
            object_name = f"M3FX_{_safe_name(name)}_{spawn.serial:04d}"
            runtime = _build_particle_material(source, f"{object_name}_MAT", config)
            if not mesh.materials:
                mesh.materials.append(runtime.material)
            obj = bpy.data.objects.new(object_name, mesh)
            collection.objects.link(obj)
            obj["m3_effect_source_armature"] = armature.name
            obj.material_slots[0].link = "OBJECT"
            obj.material_slots[0].material = runtime.material
            _animate_particle(
                obj,
                runtime,
                spawn,
                samples_by_system[index],
                fps,
                config,
                report.frame_start,
                report.frame_end,
            )
            created.append(obj.name)
            report.created_objects.append(obj.name)
        created_total += len(created)
        report.particle_systems.append(
            ParticleSystemResult(name, source.name, particle_type, len(created), tuple(created))
        )
        if len(spawns) >= config.max_particles_per_system:
            _issue(
                report,
                "WARNING",
                "PARTICLE_SYSTEM_CAP",
                name,
                f"Bake reached max_particles_per_system={config.max_particles_per_system}.",
            )
        if created_total >= config.max_particles_total:
            _issue(
                report,
                "WARNING",
                "PARTICLE_TOTAL_CAP",
                armature.name,
                f"Bake reached max_particles_total={config.max_particles_total}.",
            )
            break


_CHANNEL_IMAGE_CACHE: dict[tuple[int, str], Any] = {}


def _channel_image(image: Any, channel: str, name: str) -> Any:
    channel = channel.upper()
    if channel == "RGB":
        return image
    cache_key = (int(image.as_pointer()), channel)
    cached = _CHANNEL_IMAGE_CACHE.get(cache_key)
    if cached is not None:
        return cached
    index = {"R": 0, "G": 1, "B": 2, "A": 3}.get(channel, 3)
    pixels = list(image.pixels[:])
    output = bpy.data.images.new(name, width=image.size[0], height=image.size[1], alpha=True, float_buffer=False)
    grayscale: list[float] = []
    for offset in range(0, len(pixels), 4):
        value = float(pixels[offset + index])
        grayscale.extend((value, value, value, 1.0))
    output.pixels.foreach_set(grayscale)
    output.pack()
    try:
        output.colorspace_settings.name = "Non-Color"
    except (TypeError, ValueError):
        pass
    _CHANNEL_IMAGE_CACHE[cache_key] = output
    return output


def _source_objects_for_armature(armature: Any, source_objects: Sequence[Any] | None, scene: Any) -> list[Any]:
    if source_objects is not None:
        return list(source_objects)
    result = []
    for obj in scene.objects:
        if obj.type != "MESH":
            continue
        try:
            if obj.find_armature() == armature:
                result.append(obj)
                continue
        except AttributeError:
            pass
        parent = obj.parent
        while parent is not None:
            if parent == armature:
                result.append(obj)
                break
            parent = parent.parent
    return result


def _source_energy_tint(armature: Any) -> tuple[float, float, float, float]:
    """Derive an effect tint from the imported particle lifecycle colors.

    Displacement materials contain vectors/strength, not a display color. SC2
    colors the surrounding effect through particles and team color. Weighting
    the non-neutral M3 particle colors keeps the Eevee proxy source-derived and
    gives Archon blue/cyan while Battlecruiser remains warm/red.
    """

    weighted = Vector((0.0, 0.0, 0.0))
    total = 0.0
    for system in getattr(armature, "m3_particlesystems", ()):
        for color_name in ("color_mid", "color_end", "color_init"):
            color = _plain_vector(getattr(system, color_name, (1.0, 1.0, 1.0, 1.0)), 4, 1.0)
            saturation = max(color[:3]) - min(color[:3])
            weight = max(0.0, color[3]) * saturation
            if weight <= 1e-4:
                continue
            weighted += Vector(color[:3]) * weight
            total += weight
    if total <= 1e-6:
        return (0.55, 0.72, 1.0, 1.0)
    color = weighted / total
    peak = max(color)
    if peak > 1e-6:
        color /= peak
    return (max(0.0, color.x), max(0.0, color.y), max(0.0, color.z), 1.0)


def _displacement_material(
    armature: Any,
    displacement: Any,
    resolver: ExactTextureResolver,
    mesh: Any,
    config: EffectBakeConfig,
    report: EffectRealizationReport,
) -> tuple[Any, Any, Any, Any, Any] | None:
    source = str(getattr(displacement, "name", "displacement"))
    layers = {}
    for slot in ("norm", "strength"):
        layer = _by_handle(
            getattr(armature, "m3_materiallayers", ()),
            str(getattr(displacement, f"layer_{slot}", "")),
        )
        bitmap = str(getattr(layer, "color_bitmap", "")).strip() if layer is not None else ""
        path = resolver.resolve(bitmap) if bitmap else None
        if layer is None or not bitmap or path is None:
            _issue(
                report,
                "ERROR" if config.strict_textures else "WARNING",
                "MISSING_DISPLACEMENT_TEXTURE",
                source,
                f"{slot} layer is unavailable: {bitmap or '(unset)' }.",
            )
            if config.strict_textures:
                return None
        layers[slot] = (layer, bitmap, path)
    norm_layer, norm_bitmap, norm_path = layers["norm"]
    strength_layer, strength_bitmap, strength_path = layers["strength"]
    if norm_path is None or strength_path is None:
        return None
    norm_image = _load_image(norm_path, non_color=True)
    strength_image = _load_image(strength_path, non_color=True)

    material = bpy.data.materials.new(f"M3FX_{_safe_name(source)}_{_safe_name(mesh.name)}_MAT")
    material.use_nodes = True
    material.use_backface_culling = False
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    mix = nodes.new("ShaderNodeMixShader")
    links.new(transparent.outputs["BSDF"], mix.inputs[1])
    links.new(principled.outputs["BSDF"], mix.inputs[2])
    links.new(mix.outputs["Shader"], output.inputs["Surface"])
    uv = nodes.new("ShaderNodeUVMap")
    desired_uv = {"UV0": "uv0", "UV1": "uv1", "UV2": "uv2", "UV3": "uv3"}.get(
        str(getattr(strength_layer, "uv_source", "UV0")), "uv0"
    )
    available_uv = {layer.name for layer in mesh.data.uv_layers}
    uv.uv_map = desired_uv if desired_uv in available_uv else (mesh.data.uv_layers.active.name if mesh.data.uv_layers.active else "")
    if desired_uv not in available_uv:
        _issue(
            report,
            "WARNING",
            "DISPLACEMENT_UV_FALLBACK",
            source,
            f"Requested {desired_uv!r}; using {uv.uv_map!r} on {mesh.name!r}.",
        )
    mapping = nodes.new("ShaderNodeMapping")
    mapping.name = "M3_DisplacementMapping"
    links.new(uv.outputs["UV"], mapping.inputs["Vector"])
    norm_tex = nodes.new("ShaderNodeTexImage")
    norm_tex.image = norm_image
    norm_tex.extension = "REPEAT"
    links.new(mapping.outputs["Vector"], norm_tex.inputs["Vector"])
    strength_tex = nodes.new("ShaderNodeTexImage")
    strength_tex.image = strength_image
    strength_tex.extension = "REPEAT"
    links.new(mapping.outputs["Vector"], strength_tex.inputs["Vector"])
    tint = _source_energy_tint(armature)
    principled.inputs["Base Color"].default_value = tint
    principled.inputs["Roughness"].default_value = 0.28
    emission_input = principled.inputs.get("Emission Color") or principled.inputs.get("Emission")
    if emission_input is not None:
        emission_input.default_value = tint
    emission_strength = principled.inputs.get("Emission Strength")
    if emission_strength is not None:
        emission_strength.default_value = 2.2
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.uv_map = uv.uv_map
    links.new(norm_tex.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])
    strength_socket = _channel_socket(nodes, links, strength_tex, str(getattr(strength_layer, "color_channels", "A")))
    centered = nodes.new("ShaderNodeMath")
    centered.operation = "SUBTRACT"
    centered.inputs[1].default_value = 0.5
    links.new(strength_socket, centered.inputs[0])
    absolute = nodes.new("ShaderNodeMath")
    absolute.operation = "ABSOLUTE"
    links.new(centered.outputs["Value"], absolute.inputs[0])
    contrast = nodes.new("ShaderNodeMath")
    contrast.operation = "MULTIPLY"
    contrast.inputs[1].default_value = 2.0
    links.new(absolute.outputs["Value"], contrast.inputs[0])
    layer_weight = nodes.new("ShaderNodeLayerWeight")
    rim = nodes.new("ShaderNodeMath")
    rim.operation = "SUBTRACT"
    rim.inputs[0].default_value = 1.0
    links.new(layer_weight.outputs["Facing"], rim.inputs[1])
    textured_rim = nodes.new("ShaderNodeMath")
    textured_rim.operation = "MULTIPLY"
    links.new(contrast.outputs["Value"], textured_rim.inputs[0])
    links.new(rim.outputs["Value"], textured_rim.inputs[1])
    factor = nodes.new("ShaderNodeValue")
    factor.name = "M3_DisplacementFactor"
    opacity = nodes.new("ShaderNodeMath")
    opacity.operation = "MULTIPLY"
    opacity.inputs[1].default_value = config.displacement_opacity
    links.new(textured_rim.outputs["Value"], opacity.inputs[0])
    factor_mix = nodes.new("ShaderNodeMath")
    factor_mix.operation = "MULTIPLY"
    links.new(opacity.outputs["Value"], factor_mix.inputs[0])
    links.new(factor.outputs["Value"], factor_mix.inputs[1])
    links.new(factor_mix.outputs["Value"], mix.inputs[0])
    if hasattr(material, "surface_render_method"):
        material.surface_render_method = "DITHERED"
    elif hasattr(material, "blend_method"):
        material.blend_method = "BLEND"

    channel_image = _channel_image(
        strength_image,
        str(getattr(strength_layer, "color_channels", "A")),
        f"M3FX_{_safe_name(strength_image.name)}_CHANNEL",
    )
    texture = bpy.data.textures.new(f"M3FX_{_safe_name(source)}_DISPLACE_TEX", type="IMAGE")
    texture.image = channel_image
    texture.extension = "REPEAT"
    return material, mapping, factor, texture, (norm_bitmap, strength_bitmap, strength_layer, uv.uv_map)


def _realize_displacements(
    armature: Any,
    scene: Any,
    resolver: ExactTextureResolver,
    source_objects: Sequence[Any] | None,
    config: EffectBakeConfig,
    report: EffectRealizationReport,
) -> None:
    matrefs = {str(getattr(ref, "bl_handle", "")): ref for ref in getattr(armature, "m3_materialrefs", ())}
    objects = _source_objects_for_armature(armature, source_objects, scene)
    found = 0
    for mesh in objects:
        if mesh.type != "MESH":
            continue
        handles = [str(getattr(getattr(batch, "material", None), "handle", "")) for batch in getattr(mesh, "m3_mesh_batches", ())]
        for handle in dict.fromkeys(handle for handle in handles if handle):
            ref = matrefs.get(handle)
            if ref is None or str(getattr(ref, "mat_type", "")) != "m3_materials_displacement":
                continue
            found += 1
            displacement = _by_handle(
                getattr(armature, "m3_materials_displacement", ()),
                str(getattr(ref, "mat_handle", "")),
            )
            if displacement is None:
                _issue(report, "ERROR", "MISSING_DISPLACEMENT_MATERIAL", mesh.name, "Material body is unresolved.")
                continue
            built = _displacement_material(armature, displacement, resolver, mesh, config, report)
            if built is None:
                report.displacement_materials.append(
                    DisplacementResult(str(getattr(ref, "name", "")), mesh.name, None, None, None, False)
                )
                continue
            material, mapping, factor, texture, metadata = built
            norm_bitmap, strength_bitmap, strength_layer, uv_layer = metadata
            mesh.data.materials.clear()
            mesh.data.materials.append(material)
            mesh.hide_render = False
            mesh.hide_viewport = False
            subdivision = mesh.modifiers.get("SC2_M3_SUBSURF") or mesh.modifiers.new("SC2_M3_SUBSURF", "SUBSURF")
            subdivision.levels = max(0, config.displacement_subdivision)
            subdivision.render_levels = max(0, config.displacement_subdivision)
            modifier = mesh.modifiers.get("SC2_M3_DISPLACE") or mesh.modifiers.new("SC2_M3_DISPLACE", "DISPLACE")
            modifier.texture = texture
            modifier.texture_coords = "UV"
            if hasattr(modifier, "uv_layer"):
                modifier.uv_layer = uv_layer
            modifier.mid_level = 0.5
            for frame in range(report.frame_start, report.frame_end + 1, config.bake_step):
                scene.frame_set(frame)
                strength = max(0.0, float(getattr(displacement, "strength_factor", 0.0)))
                modifier.strength = strength * config.displacement_unit_scale
                modifier.keyframe_insert(data_path="strength", frame=frame)
                factor.outputs["Value"].default_value = min(1.0, strength / 5.0)
                factor.outputs["Value"].keyframe_insert(data_path="default_value", frame=frame)
                offset = _plain_vector(getattr(strength_layer, "uv_offset", (0.0, 0.0)), 2, 0.0)
                tiling = _plain_vector(getattr(strength_layer, "uv_tiling", (1.0, 1.0)), 2, 1.0)
                angle = _plain_vector(getattr(strength_layer, "uv_angle", (0.0, 0.0, 0.0)), 3, 0.0)
                mapping.inputs["Location"].default_value = (offset[0], offset[1], 0.0)
                mapping.inputs["Scale"].default_value = (tiling[0], tiling[1], 1.0)
                mapping.inputs["Rotation"].default_value = (0.0, 0.0, angle[2])
                for socket_name in ("Location", "Scale", "Rotation"):
                    mapping.inputs[socket_name].keyframe_insert(data_path="default_value", frame=frame)
            report.created_objects.append(mesh.name)
            report.displacement_materials.append(
                DisplacementResult(
                    str(getattr(ref, "name", "")),
                    mesh.name,
                    norm_bitmap,
                    strength_bitmap,
                    modifier.name,
                    True,
                )
            )
            _issue(
                report,
                "WARNING",
                "SCREENSPACE_DISPLACEMENT_PROXY",
                str(getattr(ref, "name", mesh.name)),
                "SC2 framebuffer distortion is represented by source-textured translucent geometry and a "
                "model-space Displace modifier; WebM preserves the proxy, but glTF cannot reproduce the native effect.",
            )
    if getattr(armature, "m3_materials_displacement", ()) and found == 0:
        _issue(
            report,
            "ERROR",
            "DISPLACEMENT_MESH_NOT_FOUND",
            armature.name,
            "Imported displacement metadata exists, but no matching source mesh was supplied/found.",
        )


def realize_armature_effects(
    armature: Any,
    textures_root: str | Path,
    *,
    scene: Any | None = None,
    camera: Any | None = None,
    source_objects: Sequence[Any] | None = None,
    collection: Any | None = None,
    config: EffectBakeConfig | None = None,
) -> EffectRealizationReport:
    """Realize particles and displacement for one imported M3 armature.

    Parameters
    ----------
    armature:
        M3Studio-imported Blender armature object.
    textures_root:
        Root preserving the archive path, normally the exported models root
        containing ``Assets/Textures``.
    scene / camera:
        The configured Eevee scene and its final camera. Camera-facing particle
        transforms are baked against this camera.
    source_objects:
        Imported objects belonging to this role. Passing ``role.imported_objects``
        is preferred because an earlier fail-closed material pass may have removed
        displacement shells from ``role.render_meshes``.
    collection:
        Optional destination collection for generated particle meshes.
    config:
        Deterministic bake bounds and safety caps.
    """

    _require_blender()
    if armature is None or getattr(armature, "type", None) != "ARMATURE":
        raise M3EffectRealizationError("armature must be an imported Blender ARMATURE object.")
    scene = scene or bpy.context.scene
    config = config or EffectBakeConfig()
    frame_start = int(config.frame_start if config.frame_start is not None else scene.frame_start)
    frame_end = int(config.frame_end if config.frame_end is not None else scene.frame_end)
    if frame_end < frame_start:
        raise M3EffectRealizationError(f"Invalid frame range {frame_start}-{frame_end}.")
    if config.bake_step < 1:
        raise M3EffectRealizationError("bake_step must be at least 1.")
    if config.max_particles_per_system < 1 or config.max_particles_total < 1:
        raise M3EffectRealizationError("Particle limits must be positive.")
    if not math.isfinite(config.particle_opacity) or not 0.0 <= config.particle_opacity <= 1.0:
        raise M3EffectRealizationError(
            f"particle_opacity must be finite and in [0, 1]; received {config.particle_opacity}."
        )
    if not math.isfinite(config.displacement_opacity) or not 0.0 <= config.displacement_opacity <= 1.0:
        raise M3EffectRealizationError(
            "displacement_opacity must be finite and in [0, 1]; "
            f"received {config.displacement_opacity}."
        )
    fps = float(config.fps if config.fps is not None else scene.render.fps / scene.render.fps_base)
    if fps <= 0.0:
        raise M3EffectRealizationError(f"FPS must be positive; received {fps}.")
    camera = camera or scene.camera
    destination = collection or _collection(scene, config.collection_name)
    if config.replace_existing:
        _clear_generated(destination, armature.name)
    resolver = ExactTextureResolver(textures_root)
    report = EffectRealizationReport(
        armature.name,
        frame_start,
        frame_end,
        particle_opacity=float(config.particle_opacity),
        displacement_opacity=float(config.displacement_opacity),
    )
    original_frame = scene.frame_current
    try:
        if config.realize_displacement:
            _realize_displacements(armature, scene, resolver, source_objects, config, report)
        if config.realize_particles:
            _realize_particles(armature, scene, camera, resolver, destination, config, report, fps)
        copy_count = len(getattr(armature, "m3_particlecopies", ()))
        if copy_count:
            _issue(
                report,
                "WARNING",
                "PARTICLE_COPIES_NOT_REALIZED",
                armature.name,
                f"{copy_count} M3 particle-copy definition(s) require a separate instance pass.",
            )
        ribbon_count = len(getattr(armature, "m3_ribbons", ()))
        if ribbon_count:
            _issue(
                report,
                "WARNING",
                "RIBBONS_NOT_REALIZED",
                armature.name,
                f"This particle/displacement module intentionally leaves {ribbon_count} ribbon(s) for a separate baker.",
            )
    finally:
        scene.frame_set(original_frame)
    _log(
        f"Realized {len(report.created_objects)} object(s) for {armature.name}; "
        f"errors={report.error_count}, warnings={report.warning_count}."
    )
    return report


__all__ = [
    "EffectBakeConfig",
    "EffectRealizationReport",
    "ExactTextureResolver",
    "M3EffectRealizationError",
    "realize_armature_effects",
]
