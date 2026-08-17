#!/usr/bin/env python3
"""Build transparent SC2 alert renders inside Blender.

This file intentionally contains no game assets. It expects locally exported M3
models and an operator-compatible M3 addon supplied on the command line.

Run through Blender, not the system Python:

    blender --background --factory-startup --python-exit-code 1 \
      --python blender_render.py -- --manifest render-manifest.json ...
"""

from __future__ import annotations

import argparse
import importlib
import json
import math
import re
import sys
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

# Blender's --python execution does not reliably prepend the script directory.
# Keep the two auditable sibling realizers importable without installing them as
# global Blender add-ons.
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from m3_effect_realizer import (
    EffectBakeConfig,
    EffectRealizationReport,
    M3EffectRealizationError,
    realize_armature_effects,
)
from m3_ribbon_realizer import (
    RibbonRealization,
    RibbonRealizationError,
    realize_m3_ribbons,
)

try:
    import bpy  # type: ignore[import-not-found]
    from mathutils import Euler, Vector  # type: ignore[import-not-found]
except ModuleNotFoundError:
    # Keeping import-time side effects out lets regular Python run py_compile.
    bpy = None
    Euler = None
    Vector = None


PIPELINE_PREFIX = "[sc2-alert-render]"
SAFE_SPEC_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
CHOREOGRAPHY_REQUIRED_ROLES: dict[str, tuple[str, ...]] = {
    "zealot_dance": ("hero",),
    "marine_skyfire": ("hero",),
    "archon_merge": ("templar_left", "templar_right", "hero"),
    "archon_backflip": ("hero",),
    "stalker_blink": ("hero",),
    "carrier_interceptors": ("hero",),
    "zergling_zoomies": ("hero",),
    "baneling_bowling": ("hero",),
    "overlord_party_balloon": ("hero",),
    "battlecruiser_warp_in": ("hero",),
    "mule_money_drop": ("hero",),
}
PRIMARY_TEXTURE_SLOTS = frozenset(
    {
        "diff",
        "decal",
        "spec",
        "gloss",
        "emis1",
        "emis2",
        "alpha1",
        "alpha2",
        "norm",
        "ao",
    }
)
UNSUPPORTED_EFFECT_COLLECTIONS: tuple[tuple[str, str], ...] = (
    ("particle systems", "m3_particlesystems"),
    ("particle copies", "m3_particlecopies"),
    ("ribbons", "m3_ribbons"),
    ("projections", "m3_projections"),
)


class PipelineError(RuntimeError):
    """An actionable input or render-pipeline failure."""


@dataclass
class ModelRole:
    name: str
    motion: Any
    container: Any
    armature: Any | None
    imported_objects: list[Any]
    render_meshes: list[Any]
    base_location: tuple[float, float, float]
    base_rotation_deg: tuple[float, float, float]


@dataclass(frozen=True)
class NativeActionCandidate:
    label: str
    group_name: str
    animation_name: str
    action: Any


@dataclass
class MaterialLayerNode:
    color: Any | None
    alpha: Any | None
    scalar: Any | None
    bitmap_path: str | None
    resolved_path: Path | None


@dataclass(frozen=True)
class PrimaryTextureCheck:
    role: str
    model_path: str
    bitmap_path: str
    expected_slots: tuple[str, ...]
    referenced_slots: tuple[str, ...]
    resolved_path: Path | None
    load_error: str | None

    @property
    def ready(self) -> bool:
        return (
            set(self.expected_slots).issubset(self.referenced_slots)
            and self.resolved_path is not None
            and self.load_error is None
        )


@dataclass(frozen=True)
class EffectClassCheck:
    role: str
    model_path: str
    effect_class: str
    count: int

    @property
    def ready(self) -> bool:
        return self.count == 0


def normalize_texture_reference(raw_path: str) -> str | None:
    """Return a safe archive-relative texture path without guessing its location."""

    normalized = raw_path.strip().replace("\\", "/")
    if not normalized or normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        return None
    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        return None
    return "/".join(parts)


def texture_reference_key(raw_path: str) -> str | None:
    normalized = normalize_texture_reference(raw_path)
    return normalized.casefold() if normalized else None


class TextureResolver:
    """Resolve exact M3 archive paths against an operator-owned texture tree.

    Basename search is intentionally forbidden. Two SC2 archive directories can
    contain files with the same leaf name, and silently selecting either one is
    incompatible with a fidelity gate.
    """

    def __init__(self, root: Path):
        self.root = root.resolve()
        self._relative: dict[str, Path] = {}
        self._missing: set[str] = set()
        supported = {".dds", ".png", ".tga", ".tif", ".tiff", ".jpg", ".jpeg", ".exr"}
        for candidate in self.root.rglob("*"):
            if not candidate.is_file() or candidate.suffix.lower() not in supported:
                continue
            relative_key = candidate.relative_to(self.root).as_posix().casefold()
            previous = self._relative.get(relative_key)
            if previous is not None and previous != candidate:
                fail(
                    "Texture root contains case-colliding archive paths, so exact resolution is ambiguous: "
                    f"{previous} and {candidate}."
                )
            self._relative[relative_key] = candidate
        log(f"Indexed {len(self._relative)} local texture file(s) under {self.root}.")

    def resolve(self, raw_path: str) -> Path | None:
        normalized = normalize_texture_reference(raw_path)
        if normalized is None:
            key = raw_path.strip().casefold()
            if key and key not in self._missing:
                log(f"Rejected unsafe/non-relative M3 texture reference: {raw_path!r}.")
                self._missing.add(key)
            return None
        exact = self._relative.get(normalized.casefold())
        if exact:
            return exact
        key = normalized.casefold()
        if key not in self._missing:
            log(
                f"Exact texture unavailable: {raw_path}. Expected {self.root / Path(normalized)}; "
                "basename substitution is disabled."
            )
            self._missing.add(key)
        return None


@dataclass
class RenderContext:
    scene: Any
    spec: Mapping[str, Any]
    roles: dict[str, ModelRole]
    frame_start: int
    frame_end: int
    palette: dict[str, tuple[float, float, float, float]]

    @property
    def options(self) -> Mapping[str, Any]:
        value = self.spec.get("options", {})
        return value if isinstance(value, Mapping) else {}

    def frame(self, fraction: float) -> int:
        fraction = max(0.0, min(1.0, fraction))
        return int(round(self.frame_start + (self.frame_end - self.frame_start) * fraction))


def log(message: str) -> None:
    print(f"{PIPELINE_PREFIX} {message}", flush=True)


def fail(message: str) -> None:
    raise PipelineError(message)


def as_float(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail(f"{label} must be a number; received {value!r}.")
    return float(value)


def as_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        fail(f"{label} must be an integer; received {value!r}.")
    return value


def vec3(value: Any, label: str) -> tuple[float, float, float]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) != 3:
        fail(f"{label} must be a three-number array; received {value!r}.")
    return (
        as_float(value[0], f"{label}[0]"),
        as_float(value[1], f"{label}[1]"),
        as_float(value[2], f"{label}[2]"),
    )


def deep_merge(base: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = dict(base)
    for key, value in override.items():
        if isinstance(value, Mapping) and isinstance(result.get(key), Mapping):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def hex_color(value: Any, label: str) -> tuple[float, float, float, float]:
    if not isinstance(value, str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
        fail(f"{label} must be a six-digit hex color such as #62D9FF; received {value!r}.")
    return tuple(int(value[index : index + 2], 16) / 255.0 for index in (1, 3, 5)) + (1.0,)


def blender_args() -> list[str]:
    if "--" not in sys.argv:
        return []
    return sys.argv[sys.argv.index("--") + 1 :]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--spec", required=True, help="Manifest spec id to render")
    parser.add_argument("--models-root", required=True, type=Path)
    parser.add_argument("--textures-root", type=Path, help="Local texture tree; defaults to --models-root")
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--addon-path", required=True, type=Path)
    parser.add_argument("--addon-module", default="m3studio")
    parser.add_argument("--poster-only", action="store_true")
    parser.add_argument("--inspect-only", action="store_true", help="Import and write M3 bitmap/action metadata; do not render")
    parser.add_argument(
        "--allow-untextured-preview",
        action="store_true",
        help="Diagnostic only: permit renders that fail the primary DDS fidelity gate",
    )
    parser.add_argument(
        "--allow-unsupported-effects",
        action="store_true",
        help="Calibration only: permit models whose M3 effects have no Eevee renderer",
    )
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--keep-blend", action="store_true")
    parser.add_argument("--debug", action="store_true")
    return parser.parse_args(blender_args())


def load_spec(manifest_path: Path, spec_id: str) -> dict[str, Any]:
    if not manifest_path.is_file():
        fail(f"Manifest not found: {manifest_path}. Pass --manifest with an existing JSON file.")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"Manifest JSON is invalid at line {exc.lineno}, column {exc.colno}: {exc.msg}")
    if not isinstance(manifest, Mapping):
        fail("Manifest root must be a JSON object.")
    if manifest.get("schemaVersion") != 1:
        fail(f"Unsupported manifest schemaVersion {manifest.get('schemaVersion')!r}; expected 1.")
    defaults = manifest.get("defaults", {})
    specs = manifest.get("specs")
    if not isinstance(defaults, Mapping) or not isinstance(specs, list):
        fail("Manifest requires an object named defaults and an array named specs.")
    matches = [candidate for candidate in specs if isinstance(candidate, Mapping) and candidate.get("id") == spec_id]
    if not matches:
        available = ", ".join(str(candidate.get("id")) for candidate in specs if isinstance(candidate, Mapping))
        fail(f"Unknown spec {spec_id!r}. Available specs: {available or '(none)' }.")
    if len(matches) > 1:
        fail(f"Manifest contains duplicate spec id {spec_id!r}.")
    return deep_merge(defaults, matches[0])


def primary_texture_requirements_for_model(
    spec: Mapping[str, Any], model_path: str
) -> list[tuple[str, tuple[str, ...]]]:
    materials = spec.get("materials", {})
    if not isinstance(materials, Mapping):
        fail("materials must be an object.")
    raw_requirements = materials.get("productionTextureRequirements")
    if not isinstance(raw_requirements, Mapping):
        fail(
            "materials.productionTextureRequirements must map each source M3 path to its "
            "inspection-verified primary DDS requirements."
        )
    model_key = model_path.replace("\\", "/").casefold()
    matches = [value for key, value in raw_requirements.items() if str(key).replace("\\", "/").casefold() == model_key]
    if len(matches) != 1:
        if not matches:
            fail(
                f"No primary texture gate is configured for model {model_path!r}. Add its exact imported "
                "M3 bitmap references to materials.productionTextureRequirements."
            )
        fail(f"Primary texture gate contains case-colliding model keys for {model_path!r}.")
    raw_entries = matches[0]
    if not isinstance(raw_entries, list) or not raw_entries:
        fail(f"Primary texture requirements for {model_path!r} must be a non-empty array.")
    parsed: list[tuple[str, tuple[str, ...]]] = []
    seen_paths: set[str] = set()
    for index, raw_entry in enumerate(raw_entries):
        label = f"productionTextureRequirements[{model_path!r}][{index}]"
        if not isinstance(raw_entry, Mapping):
            fail(f"{label} must be an object with path and slots fields.")
        raw_path = raw_entry.get("path")
        slots = raw_entry.get("slots")
        if not isinstance(raw_path, str):
            fail(f"{label}.path must be a string.")
        normalized = normalize_texture_reference(raw_path)
        if normalized is None or normalized != raw_path.replace("\\", "/"):
            fail(f"{label}.path must be a normalized archive-relative path; received {raw_path!r}.")
        if not normalized.casefold().startswith("assets/textures/") or Path(normalized).suffix.casefold() != ".dds":
            fail(f"{label}.path must be an exact Assets/Textures/... .dds reference; received {raw_path!r}.")
        path_key = normalized.casefold()
        if path_key in seen_paths:
            fail(f"{label}.path duplicates another requirement for {model_path!r}: {normalized}.")
        seen_paths.add(path_key)
        if not isinstance(slots, list) or not slots or any(not isinstance(slot, str) for slot in slots):
            fail(f"{label}.slots must be a non-empty array of M3 standard-material slot names.")
        normalized_slots = tuple(dict.fromkeys(str(slot) for slot in slots))
        unknown_slots = sorted(set(normalized_slots) - PRIMARY_TEXTURE_SLOTS)
        if unknown_slots:
            fail(f"{label}.slots contains unsupported slot(s): {', '.join(unknown_slots)}.")
        parsed.append((normalized, normalized_slots))
    declared_slots = {slot for _, slots in parsed for slot in slots}
    missing_families: list[str] = []
    if "diff" not in declared_slots:
        missing_families.append("diff/base color")
    if "norm" not in declared_slots:
        missing_families.append("norm/normal")
    if not declared_slots.intersection({"spec", "gloss"}):
        missing_families.append("spec or gloss")
    if missing_families:
        fail(
            f"Primary texture requirements for {model_path!r} omit core material families: "
            f"{', '.join(missing_families)}."
        )
    return parsed


def unsupported_effect_gate_models(spec: Mapping[str, Any]) -> set[str]:
    materials = spec.get("materials", {})
    if not isinstance(materials, Mapping):
        fail("materials must be an object.")
    raw_models = materials.get("productionUnsupportedEffectGateModels", [])
    if not isinstance(raw_models, list) or any(not isinstance(path, str) for path in raw_models):
        fail("materials.productionUnsupportedEffectGateModels must be an array of source M3 path strings.")
    parsed: set[str] = set()
    for index, raw_path in enumerate(raw_models):
        normalized = normalize_texture_reference(raw_path)
        label = f"materials.productionUnsupportedEffectGateModels[{index}]"
        if normalized is None or normalized != raw_path.replace("\\", "/") or Path(normalized).suffix.casefold() != ".m3":
            fail(f"{label} must be a normalized archive-relative .m3 path; received {raw_path!r}.")
        key = normalized.casefold()
        if key in parsed:
            fail(f"{label} duplicates another effect-gate model path: {raw_path!r}.")
        parsed.add(key)
    return parsed


def validate_spec(spec: Mapping[str, Any], models_root: Path) -> list[dict[str, Any]]:
    spec_id = spec.get("id")
    if not isinstance(spec_id, str) or not SAFE_SPEC_ID.fullmatch(spec_id):
        fail(f"Spec id must match {SAFE_SPEC_ID.pattern}; received {spec_id!r}.")
    choreography = spec.get("choreography")
    if not isinstance(choreography, str) or choreography not in CHOREOGRAPHIES:
        available = ", ".join(sorted(CHOREOGRAPHIES))
        fail(f"Spec {spec_id!r} has unknown choreography {choreography!r}. Available: {available}.")
    frame_start = as_int(spec.get("frameStart", 1), f"{spec_id}.frameStart")
    frame_end = as_int(spec.get("frameEnd"), f"{spec_id}.frameEnd")
    poster_frame = as_int(spec.get("posterFrame"), f"{spec_id}.posterFrame")
    if frame_start < 0 or frame_end <= frame_start:
        fail(f"{spec_id} requires frameEnd > frameStart >= 0.")
    if not frame_start <= poster_frame <= frame_end:
        fail(f"{spec_id}.posterFrame must be within {frame_start}..{frame_end}.")
    fps = as_int(spec.get("fps", 24), f"{spec_id}.fps")
    if fps != 24:
        fail(f"{spec_id}.fps is {fps}; alert assets must be authored at exactly 24 fps.")

    models = spec.get("models")
    if not isinstance(models, list) or not models:
        fail(f"Spec {spec_id!r} requires at least one models entry.")
    roles: set[str] = set()
    validated: list[dict[str, Any]] = []
    root = models_root.resolve()
    if not root.is_dir():
        fail(
            f"Models root does not exist: {root}. Export owned/local SC2 M3 files and textures, "
            "then pass the containing directory with --models-root."
        )
    for index, raw_model in enumerate(models):
        label = f"{spec_id}.models[{index}]"
        if not isinstance(raw_model, Mapping):
            fail(f"{label} must be an object.")
        role = raw_model.get("role")
        relative = raw_model.get("path")
        if not isinstance(role, str) or not role:
            fail(f"{label}.role must be a non-empty string.")
        if role in roles:
            fail(f"Spec {spec_id!r} repeats model role {role!r}.")
        roles.add(role)
        if not isinstance(relative, str) or not relative:
            fail(f"{label}.path must be a non-empty relative path.")
        relative_path = Path(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            fail(f"{label}.path must stay relative to --models-root; received {relative!r}.")
        absolute = (root / relative_path).resolve()
        try:
            absolute.relative_to(root)
        except ValueError:
            fail(f"{label}.path escapes --models-root: {relative!r}.")
        if absolute.suffix.lower() not in {".m3", ".m3a"}:
            fail(f"{label}.path must end in .m3 or .m3a; received {relative!r}.")
        if not absolute.is_file():
            fail(
                f"Model for spec {spec_id!r}, role {role!r} was not found: {absolute}. "
                "Export that model from your local SC2 installation or update its relative path in the manifest."
            )
        model = dict(raw_model)
        model["absolutePath"] = absolute
        model["position"] = vec3(model.get("position", [0, 0, 0]), f"{label}.position")
        model["rotationDeg"] = vec3(model.get("rotationDeg", [0, 0, 0]), f"{label}.rotationDeg")
        model["scale"] = as_float(model.get("scale", 1.0), f"{label}.scale")
        if model["scale"] <= 0:
            fail(f"{label}.scale must be greater than zero.")
        animation_paths = model.get("animationPaths", [])
        if not isinstance(animation_paths, list):
            fail(f"{label}.animationPaths must be an array when present.")
        resolved_animations: list[Path] = []
        for animation_index, raw_animation in enumerate(animation_paths):
            animation_label = f"{label}.animationPaths[{animation_index}]"
            if isinstance(raw_animation, str):
                animation_relative = raw_animation
                optional = False
            elif isinstance(raw_animation, Mapping):
                animation_relative = raw_animation.get("path")
                optional = raw_animation.get("optional") is True
            else:
                fail(f"{animation_label} must be a path string or object with path/optional fields.")
            if not isinstance(animation_relative, str) or not animation_relative:
                fail(f"{animation_label}.path must be a non-empty relative path.")
            animation_path = Path(animation_relative)
            if animation_path.is_absolute() or ".." in animation_path.parts:
                fail(f"{animation_label}.path must stay relative to --models-root.")
            animation_absolute = (root / animation_path).resolve()
            try:
                animation_absolute.relative_to(root)
            except ValueError:
                fail(f"{animation_label}.path escapes --models-root: {animation_relative!r}.")
            if animation_absolute.suffix.lower() != ".m3a":
                fail(f"{animation_label}.path must end in .m3a; received {animation_relative!r}.")
            if not animation_absolute.is_file():
                if optional:
                    log(
                        f"Optional native-animation export is absent for {spec_id}/{role}: "
                        f"{animation_absolute}; main-model actions/root choreography will be used."
                    )
                    continue
                fail(
                    f"Native-animation file for spec {spec_id!r}, role {role!r} was not found: "
                    f"{animation_absolute}. Export it locally or mark the manifest entry optional."
                )
            resolved_animations.append(animation_absolute)
        model["absoluteAnimationPaths"] = resolved_animations
        validated.append(model)
    required_roles = CHOREOGRAPHY_REQUIRED_ROLES[choreography]
    missing_roles = [role for role in required_roles if role not in roles]
    if missing_roles:
        fail(
            f"Spec {spec_id!r} choreography {choreography!r} is missing role(s): "
            f"{', '.join(missing_roles)}."
        )
    if choreography == "carrier_interceptors" and not any(role.startswith("interceptor_") for role in roles):
        fail(
            f"Spec {spec_id!r} choreography 'carrier_interceptors' requires at least one "
            "role named interceptor_1, interceptor_2, etc."
        )
    for model in validated:
        primary_texture_requirements_for_model(spec, str(model["path"]))
    return validated


def reset_blender() -> None:
    # Run before loading the addon; factory settings can unregister addons.
    bpy.ops.wm.read_factory_settings(use_empty=True)


def operator_exists() -> bool:
    try:
        operator = getattr(bpy.ops.m3, "import")
        operator.get_rna_type()
        return True
    except (AttributeError, KeyError, RuntimeError):
        return False


def enable_m3_addon(addon_path: Path, module_name: str) -> None:
    addon_path = addon_path.resolve()
    if not addon_path.exists():
        fail(
            f"M3 addon path does not exist: {addon_path}. Clone or unpack M3Studio locally and pass "
            "its package directory (or its parent) with --addon-path."
        )
    direct_init = addon_path / "__init__.py"
    nested_init = addon_path / module_name / "__init__.py"
    if direct_init.is_file():
        if addon_path.name != module_name:
            fail(
                f"Addon path points to package {addon_path.name!r}, but --addon-module is {module_name!r}. "
                f"Use --addon-module {addon_path.name} or pass the parent directory."
            )
        import_root = addon_path.parent
    elif nested_init.is_file():
        import_root = addon_path
    else:
        fail(
            f"Could not find an addon package at {direct_init} or {nested_init}. "
            "The addon must be an unpacked Python package containing __init__.py."
        )
    if str(import_root) not in sys.path:
        sys.path.insert(0, str(import_root))
    try:
        module = importlib.import_module(module_name)
    except Exception as exc:
        fail(
            f"Could not import M3 addon module {module_name!r} from {import_root}: {exc}. "
            "Use a Blender version supported by that addon and verify all addon files/submodules are present."
        )
    if not operator_exists():
        register = getattr(module, "register", None)
        if not callable(register):
            fail(f"Addon module {module_name!r} has no register() function and did not expose bpy.ops.m3.import.")
        try:
            register()
        except Exception as exc:
            if not operator_exists():
                fail(
                    f"M3 addon {module_name!r} failed to register in Blender {bpy.app.version_string}: {exc}. "
                    "Match the addon to a supported Blender release; the archived m3addon is limited to Blender 3.6 or older."
                )
    if not operator_exists():
        fail(
            f"Addon {module_name!r} loaded but did not expose bpy.ops.m3.import. "
            "Use M3Studio or an operator-compatible addon."
        )
    log(f"Loaded M3 addon {module_name!r} from {import_root}.")


def select_eevee(scene: Any) -> str:
    errors: list[str] = []
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = engine
            return engine
        except (TypeError, ValueError) as exc:
            errors.append(f"{engine}: {exc}")
    fail("This Blender build exposes neither Eevee Next nor legacy Eevee. " + " | ".join(errors))
    raise AssertionError("unreachable")


def configure_scene(spec: Mapping[str, Any]) -> Any:
    scene = bpy.context.scene
    engine = select_eevee(scene)
    scene.frame_start = as_int(spec.get("frameStart", 1), "frameStart")
    scene.frame_end = as_int(spec["frameEnd"], "frameEnd")
    scene.render.fps = 24
    scene.render.fps_base = 1.0
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.use_file_extension = True

    resolution = spec.get("resolution", {})
    if not isinstance(resolution, Mapping):
        fail("resolution must be an object.")
    scene.render.resolution_x = as_int(resolution.get("width", 768), "resolution.width")
    scene.render.resolution_y = as_int(resolution.get("height", 768), "resolution.height")
    scene.render.resolution_percentage = as_int(resolution.get("percentage", 100), "resolution.percentage")
    if scene.render.resolution_x < 64 or scene.render.resolution_y < 64:
        fail("Render resolution must be at least 64x64.")

    render_options = spec.get("render", {})
    samples = as_int(render_options.get("samples", 64), "render.samples") if isinstance(render_options, Mapping) else 64
    if hasattr(scene, "eevee") and hasattr(scene.eevee, "taa_render_samples"):
        scene.eevee.taa_render_samples = samples
    try:
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "Medium High Contrast"
    except (TypeError, ValueError):
        # Look names vary between Blender color-management versions.
        pass
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0

    world = bpy.data.worlds.new("SC2 Alert Transparent World") if scene.world is None else scene.world
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background:
        background.inputs["Color"].default_value = (0.015, 0.02, 0.04, 1.0)
        background.inputs["Strength"].default_value = 0.14
    log(
        f"Configured {engine}, transparent RGBA PNG, {scene.render.resolution_x}x"
        f"{scene.render.resolution_y} at 24 fps."
    )
    return scene


def import_operator_kwargs(model: Mapping[str, Any], spec: Mapping[str, Any]) -> dict[str, Any]:
    operator = getattr(bpy.ops.m3, "import")
    available = {prop.identifier for prop in operator.get_rna_type().properties}
    import_defaults = spec.get("import", {})
    import_model = model.get("import", {})
    config = deep_merge(
        import_defaults if isinstance(import_defaults, Mapping) else {},
        import_model if isinstance(import_model, Mapping) else {},
    )
    candidates = {
        "filepath": str(model["absolutePath"]),
        "id_name": "(New Object)",
        "get_mesh": bool(config.get("mesh", True)),
        "get_effects": bool(config.get("effects", True)),
        "get_rig": bool(config.get("rig", True)),
        "get_anims": bool(config.get("animations", False)),
    }
    kwargs = {key: value for key, value in candidates.items() if key in available}
    if "filepath" not in kwargs:
        fail(
            "The loaded bpy.ops.m3.import operator has no filepath property. "
            "This pipeline requires the M3Studio-compatible import operator contract."
        )
    return kwargs


def object_bounds(objects: Iterable[Any]) -> tuple[Any, Any]:
    points: list[Any] = []
    object_list = list(objects)
    batch_meshes = [
        obj for obj in object_list if obj.type == "MESH" and len(getattr(obj, "m3_mesh_batches", ())) > 0
    ]
    for obj in batch_meshes or object_list:
        if obj.type not in {"MESH", "CURVE", "SURFACE", "META", "FONT"}:
            continue
        try:
            points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
        except (AttributeError, TypeError):
            continue
    if not points:
        fail(
            "M3 import completed but created no renderable mesh bounds. Verify the model contains mesh data "
            "and that the addon's mesh import option is enabled."
        )
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return minimum, maximum


def import_model(model: Mapping[str, Any], spec: Mapping[str, Any]) -> ModelRole:
    before = {obj.name for obj in bpy.data.objects}
    operator = getattr(bpy.ops.m3, "import")
    kwargs = import_operator_kwargs(model, spec)
    log(f"Importing role {model['role']!r}: {model['absolutePath']}")
    try:
        result = operator(**kwargs)
    except Exception as exc:
        fail(
            f"M3 import failed for role {model['role']!r} at {model['absolutePath']}: {exc}. "
            "Check the Blender/addon version pairing and ensure referenced textures are beside the exported model."
        )
    if "FINISHED" not in result:
        fail(f"M3 import returned {sorted(result)} for role {model['role']!r}; expected FINISHED.")
    imported = [obj for obj in bpy.data.objects if obj.name not in before]
    if not imported:
        fail(f"M3 import reported success but created no objects for role {model['role']!r}.")
    bpy.context.view_layer.update()

    armatures = [obj for obj in imported if obj.type == "ARMATURE"]
    armature = armatures[0] if armatures else None
    if armature is None and model.get("absoluteAnimationPaths"):
        fail(
            f"Role {model['role']!r} has M3A inputs but the main M3 import created no armature. "
            "Keep rig import enabled for native actions."
        )
    if armature is not None:
        for animation_path in model.get("absoluteAnimationPaths", []):
            animation_before = len(bpy.data.actions)
            animation_model = dict(model)
            animation_model["absolutePath"] = animation_path
            animation_kwargs = import_operator_kwargs(animation_model, spec)
            if "id_name" in animation_kwargs:
                animation_kwargs["id_name"] = armature.name
            log(f"Importing native animations for role {model['role']!r}: {animation_path}")
            try:
                animation_result = operator(**animation_kwargs)
            except Exception as exc:
                log(
                    f"Native-animation import failed for {model['role']!r} ({animation_path}): {exc}; "
                    "continuing with main-model actions/root choreography."
                )
                continue
            if "FINISHED" not in animation_result:
                log(
                    f"Native-animation import returned {sorted(animation_result)} for {animation_path}; "
                    "continuing without it."
                )
            else:
                log(f"Imported {len(bpy.data.actions) - animation_before} additional action(s).")

    # Imported cameras/lights should not override the intentionally controlled alert stage.
    for obj in imported:
        if obj.type in {"CAMERA", "LIGHT"}:
            obj.hide_render = True
        elif obj.type == "MESH" and len(getattr(obj, "m3_mesh_batches", ())) == 0:
            # M3Studio also creates hit-test/physics helper meshes. They are useful
            # for editing but must never appear in a delivery render.
            obj.hide_render = True

    render_meshes = [
        obj for obj in imported if obj.type == "MESH" and len(getattr(obj, "m3_mesh_batches", ())) > 0
    ]

    minimum, maximum = object_bounds(imported)
    center = (minimum + maximum) * 0.5
    role_name = str(model["role"])
    motion = bpy.data.objects.new(f"SC2_ROLE_{role_name}", None)
    container = bpy.data.objects.new(f"SC2_MODEL_{role_name}", None)
    bpy.context.scene.collection.objects.link(motion)
    bpy.context.scene.collection.objects.link(container)
    container.parent = motion

    imported_names = {obj.name for obj in imported}
    top_level = [obj for obj in imported if obj.parent is None or obj.parent.name not in imported_names]
    for obj in top_level:
        world_matrix = obj.matrix_world.copy()
        obj.parent = container
        obj.matrix_world = world_matrix

    # Normalize the imported model around local X/Y zero and put its lowest bound on Z=0.
    container.location = (-center.x, -center.y, -minimum.z)
    model_scale = float(model["scale"])
    container.scale = (model_scale, model_scale, model_scale)

    position = tuple(model["position"])
    rotation_deg = tuple(model["rotationDeg"])
    motion.location = position
    motion.rotation_mode = "XYZ"
    motion.rotation_euler = tuple(math.radians(value) for value in rotation_deg)
    return ModelRole(
        name=role_name,
        motion=motion,
        container=container,
        armature=armature,
        imported_objects=imported,
        render_meshes=render_meshes,
        base_location=position,
        base_rotation_deg=rotation_deg,
    )


def set_interpolation(obj: Any, frame: int, interpolation: str) -> None:
    animation = getattr(obj, "animation_data", None)
    action = getattr(animation, "action", None)
    if action is None:
        return
    # Blender 4.4+ can expose layered/slotted actions without the legacy fcurves
    # collection. Default interpolation is still usable there; avoid crashing.
    for curve in getattr(action, "fcurves", ()):
        for point in curve.keyframe_points:
            if abs(point.co.x - frame) < 0.01:
                point.interpolation = interpolation


def pose(
    role: ModelRole,
    frame: int,
    *,
    offset: Sequence[float] = (0.0, 0.0, 0.0),
    rotation_deg: Sequence[float] = (0.0, 0.0, 0.0),
    scale: float | Sequence[float] = 1.0,
    interpolation: str = "BEZIER",
) -> None:
    role.motion.location = tuple(role.base_location[index] + float(offset[index]) for index in range(3))
    role.motion.rotation_euler = tuple(
        math.radians(role.base_rotation_deg[index] + float(rotation_deg[index])) for index in range(3)
    )
    if isinstance(scale, Sequence) and not isinstance(scale, (str, bytes)):
        if len(scale) != 3:
            fail(f"Internal choreography scale for {role.name!r} must have three values.")
        role.motion.scale = tuple(float(value) for value in scale)
    else:
        amount = float(scale)
        role.motion.scale = (amount, amount, amount)
    for data_path in ("location", "rotation_euler", "scale"):
        role.motion.keyframe_insert(data_path=data_path, frame=frame)
    set_interpolation(role.motion, frame, interpolation)


def require_role(ctx: RenderContext, name: str) -> ModelRole:
    role = ctx.roles.get(name)
    if role is None:
        fail(f"Choreography {ctx.spec['choreography']!r} requires model role {name!r}.")
    return role


def option(ctx: RenderContext, name: str, default: float) -> float:
    return as_float(ctx.options.get(name, default), f"{ctx.spec['id']}.options.{name}")


def normalize_action_name(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.lower()).split())


def native_action_candidates(role: ModelRole) -> list[NativeActionCandidate]:
    armature = role.armature
    if armature is None:
        return []
    candidates: list[NativeActionCandidate] = []
    seen: set[int] = set()
    groups = getattr(armature, "m3_animation_groups", ())
    for group in groups:
        group_name = str(getattr(group, "name", "")).strip()
        for animation in getattr(group, "animations", ()):
            action = getattr(animation, "action", None)
            if action is None:
                continue
            pointer = int(action.as_pointer())
            if pointer in seen:
                continue
            seen.add(pointer)
            animation_name = str(getattr(animation, "name", "")).strip()
            label = " ".join(part for part in (group_name, animation_name) if part).strip() or action.name
            candidates.append(NativeActionCandidate(label, group_name, animation_name, action))
    if not candidates:
        # Operator-compatible importers may create actions without M3Studio's
        # animation-group metadata. Restrict the fallback to this armature name.
        armature_prefix = normalize_action_name(armature.name)
        for action in bpy.data.actions:
            normalized = normalize_action_name(action.name)
            if armature_prefix and not normalized.startswith(armature_prefix):
                continue
            candidates.append(NativeActionCandidate(action.name, "", "", action))
    candidates.sort(key=lambda candidate: normalize_action_name(candidate.label))
    return candidates


def select_native_action(
    candidates: Sequence[NativeActionCandidate],
    config: Mapping[str, Any],
) -> NativeActionCandidate | None:
    excluded = [normalize_action_name(str(item)) for item in config.get("exclude", [])]

    def search_text(candidate: NativeActionCandidate) -> tuple[str, ...]:
        return (
            normalize_action_name(candidate.label),
            normalize_action_name(candidate.group_name),
            normalize_action_name(candidate.animation_name),
            normalize_action_name(candidate.action.name),
        )

    eligible = [
        candidate
        for candidate in candidates
        if not any(exclusion and any(exclusion in text for text in search_text(candidate)) for exclusion in excluded)
    ]
    preferences = config.get("prefer", [])
    if not isinstance(preferences, list):
        fail("native action prefer must be an array of names.")
    for preference in preferences:
        wanted = normalize_action_name(str(preference))
        exact = [
            candidate
            for candidate in eligible
            if any(text == wanted or text.endswith(f" {wanted}") for text in search_text(candidate) if text)
        ]
        if exact:
            return min(exact, key=lambda candidate: len(normalize_action_name(candidate.label)))
    contains = config.get("contains", [])
    if not isinstance(contains, list):
        fail("native action contains must be an array of substrings.")
    for pattern in contains:
        wanted = normalize_action_name(str(pattern))
        matches = [
            candidate
            for candidate in eligible
            if any(wanted in text for text in search_text(candidate) if wanted and text)
        ]
        if matches:
            return min(matches, key=lambda candidate: len(normalize_action_name(candidate.label)))
    return None


def apply_native_actions(ctx: RenderContext) -> None:
    raw_config = ctx.spec.get("nativeActions", {})
    if not isinstance(raw_config, Mapping):
        fail(f"{ctx.spec['id']}.nativeActions must be an object keyed by model role.")
    for role in ctx.roles.values():
        if role.armature is None:
            continue
        role.armature.animation_data_create()
        role.armature.animation_data.action = None
        for track in list(role.armature.animation_data.nla_tracks):
            if track.name.startswith("SC2_NATIVE_"):
                role.armature.animation_data.nla_tracks.remove(track)

    for role_name, raw_segments in raw_config.items():
        role = require_role(ctx, str(role_name))
        if role.armature is None:
            log(f"Role {role.name!r} has no armature; native-action selection skipped.")
            continue
        segments = raw_segments if isinstance(raw_segments, list) else [raw_segments]
        candidates = native_action_candidates(role)
        candidate_labels = ", ".join(candidate.label for candidate in candidates) or "(none)"
        log(f"Native action candidates for {ctx.spec['id']}/{role.name}: {candidate_labels}")
        if not candidates:
            continue
        track = role.armature.animation_data.nla_tracks.new()
        track.name = f"SC2_NATIVE_{ctx.spec['id']}_{role.name}"
        previous_end = ctx.frame_start - 1
        used = 0
        for segment_index, raw_segment in enumerate(segments):
            if not isinstance(raw_segment, Mapping):
                fail(f"nativeActions.{role.name}[{segment_index}] must be an object.")
            candidate = select_native_action(candidates, raw_segment)
            if candidate is None:
                log(
                    f"No native action matched segment {segment_index + 1} for {ctx.spec['id']}/{role.name}; "
                    "root choreography/bind pose remains active."
                )
                continue
            start_fraction = as_float(raw_segment.get("start", 0.0), "native action start")
            end_fraction = as_float(raw_segment.get("end", 1.0), "native action end")
            if not 0.0 <= start_fraction < end_fraction <= 1.0:
                fail("native action segment requires 0 <= start < end <= 1.")
            frame_start = max(previous_end + 1, ctx.frame(start_fraction))
            frame_end = max(frame_start + 1, ctx.frame(end_fraction))
            action_start, action_end = (float(value) for value in candidate.action.frame_range)
            action_length = max(1.0, action_end - action_start)
            delivery_length = max(1.0, frame_end - frame_start)
            strip = track.strips.new(f"{role.name}_{segment_index + 1}_{candidate.label}", frame_start, candidate.action)
            strip.action_frame_start = action_start
            strip.action_frame_end = action_end
            strip.extrapolation = "NOTHING"
            strip.blend_type = "REPLACE"
            strip.blend_in = 0.0
            strip.blend_out = 0.0
            if raw_segment.get("loop") is True and action_length <= delivery_length:
                strip.repeat = delivery_length / action_length
            else:
                strip.scale = delivery_length / action_length
            strip.frame_end = frame_end
            previous_end = frame_end
            used += 1
            log(
                f"Selected native action {candidate.label!r} for {ctx.spec['id']}/{role.name} "
                f"frames {frame_start}-{frame_end}."
            )
        if used == 0:
            role.armature.animation_data.nla_tracks.remove(track)


def create_emission_material(name: str, color: tuple[float, float, float, float], strength: float = 5.0) -> Any:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = color
    emission.inputs["Strength"].default_value = strength
    material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def create_coin_material(name: str) -> Any:
    """Make alert coins read as gold metal instead of clipped white emission."""
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    base_color = principled_input(principled, "Base Color")
    if base_color is not None:
        base_color.default_value = (0.95, 0.48, 0.055, 1.0)
    metallic = principled_input(principled, "Metallic")
    if metallic is not None:
        metallic.default_value = 0.88
    roughness = principled_input(principled, "Roughness")
    if roughness is not None:
        roughness.default_value = 0.24
    material.node_tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    return material


def m3_item_by_handle(collection: Iterable[Any], handle: str) -> Any | None:
    if not handle:
        return None
    for item in collection:
        if str(getattr(item, "bl_handle", "")) == handle:
            return item
    return None


def m3_layer(armature: Any, material: Any, slot: str) -> Any | None:
    handle = str(getattr(material, f"layer_{slot}", ""))
    return m3_item_by_handle(getattr(armature, "m3_materiallayers", ()), handle)


def standard_texture_slots(role: ModelRole) -> dict[str, set[str]]:
    """Index exact bitmap references and their authored standard-material slots."""

    if role.armature is None:
        return {}
    slots_by_path: dict[str, set[str]] = {}
    for matref in getattr(role.armature, "m3_materialrefs", ()):
        if str(getattr(matref, "mat_type", "")) != "m3_materials_standard":
            continue
        standard = m3_item_by_handle(
            getattr(role.armature, "m3_materials_standard", ()), str(getattr(matref, "mat_handle", ""))
        )
        if standard is None:
            continue
        for slot in sorted(PRIMARY_TEXTURE_SLOTS):
            layer = m3_layer(role.armature, standard, slot)
            if layer is None or str(getattr(layer, "color_type", "")) != "BITMAP":
                continue
            bitmap = str(getattr(layer, "color_bitmap", "")).strip()
            key = texture_reference_key(bitmap)
            if key is not None:
                slots_by_path.setdefault(key, set()).add(slot)
    return slots_by_path


def assess_primary_texture_gate(
    ctx: RenderContext,
    models: Sequence[Mapping[str, Any]],
    resolver: TextureResolver,
) -> list[PrimaryTextureCheck]:
    """Verify manifest-declared primary maps against imported metadata and Blender."""

    model_by_role = {str(model["role"]): model for model in models}
    load_errors: dict[Path, str | None] = {}
    checks: list[PrimaryTextureCheck] = []
    for role_name, role in ctx.roles.items():
        model = model_by_role[role_name]
        model_path = str(model["path"])
        referenced = standard_texture_slots(role)
        for bitmap_path, expected_slots in primary_texture_requirements_for_model(ctx.spec, model_path):
            key = texture_reference_key(bitmap_path)
            referenced_slots = tuple(sorted(referenced.get(key or "", set())))
            resolved = resolver.resolve(bitmap_path)
            load_error: str | None = None
            if resolved is not None:
                if resolved not in load_errors:
                    try:
                        bpy.data.images.load(str(resolved), check_existing=True)
                        load_errors[resolved] = None
                    except Exception as exc:
                        load_errors[resolved] = f"{type(exc).__name__}: {exc}"
                load_error = load_errors[resolved]
                if load_error:
                    log(f"Blender cannot load required DDS {resolved}: {load_error}")
            check = PrimaryTextureCheck(
                role=role_name,
                model_path=model_path,
                bitmap_path=bitmap_path,
                expected_slots=expected_slots,
                referenced_slots=referenced_slots,
                resolved_path=resolved,
                load_error=load_error,
            )
            checks.append(check)
            log(
                f"Primary texture gate {ctx.spec['id']}/{role_name}: {bitmap_path} "
                f"slots={','.join(expected_slots)} -> {'READY' if check.ready else 'BLOCKED'}"
            )
    return checks


def enforce_primary_texture_gate(ctx: RenderContext, resolver: TextureResolver, checks: Sequence[PrimaryTextureCheck]) -> None:
    failures = [check for check in checks if not check.ready]
    if not failures:
        log(f"Primary texture fidelity gate passed for {ctx.spec['id']} ({len(checks)} requirement(s)).")
        return
    details: list[str] = []
    for check in failures:
        missing_slots = sorted(set(check.expected_slots) - set(check.referenced_slots))
        reasons: list[str] = []
        if missing_slots:
            reasons.append(f"not referenced in imported M3 slot(s) {','.join(missing_slots)}")
        if check.resolved_path is None:
            reasons.append(f"missing exact local DDS under {resolver.root}")
        elif check.load_error:
            reasons.append(f"Blender load failed ({check.load_error})")
        details.append(f"  - {check.role}: {check.bitmap_path}: {'; '.join(reasons)}")
    fail(
        f"Production texture fidelity gate blocked {ctx.spec['id']!r}. Pastel/material fallbacks are diagnostic only.\n"
        + "\n".join(details)
        + "\nExport the exact Assets/Textures paths reported by -Inspect and keep that archive-relative layout. "
        "Use -AllowUntexturedPreview only for explicitly non-production diagnostics; do not package that output."
    )


def unsupported_mesh_material_counts(role: ModelRole) -> dict[str, int]:
    if role.armature is None:
        return {}
    matrefs = list(getattr(role.armature, "m3_materialrefs", ()))
    counts: dict[str, int] = {}
    for mesh in role.render_meshes:
        mesh_types: set[str] = set()
        for batch in getattr(mesh, "m3_mesh_batches", ()):
            matref = m3_item_by_handle(matrefs, str(getattr(batch.material, "handle", "")))
            mat_type = str(getattr(matref, "mat_type", "")) if matref is not None else ""
            if mat_type and mat_type != "m3_materials_standard":
                mesh_types.add(mat_type)
        for mat_type in mesh_types:
            counts[mat_type] = counts.get(mat_type, 0) + 1
    return counts


def assess_unsupported_effect_gate(
    ctx: RenderContext,
    models: Sequence[Mapping[str, Any]],
) -> list[EffectClassCheck]:
    """Expose M3 effect metadata that this offline Eevee path cannot realize."""

    gated_models = unsupported_effect_gate_models(ctx.spec)
    model_by_role = {str(model["role"]): model for model in models}
    checks: list[EffectClassCheck] = []
    for role_name, role in ctx.roles.items():
        model_path = str(model_by_role[role_name]["path"])
        if model_path.replace("\\", "/").casefold() not in gated_models:
            continue
        armature = role.armature
        for effect_class, collection_name in UNSUPPORTED_EFFECT_COLLECTIONS:
            count = len(getattr(armature, collection_name, ())) if armature is not None else 0
            checks.append(EffectClassCheck(role_name, model_path, effect_class, count))
        material_counts = unsupported_mesh_material_counts(role)
        displacement_count = material_counts.pop("m3_materials_displacement", 0)
        checks.append(EffectClassCheck(role_name, model_path, "displacement mesh materials", displacement_count))
        for mat_type, count in sorted(material_counts.items()):
            checks.append(EffectClassCheck(role_name, model_path, f"unsupported mesh material {mat_type}", count))
    return checks


def enforce_unsupported_effect_gate(ctx: RenderContext, checks: Sequence[EffectClassCheck]) -> None:
    failures = [check for check in checks if not check.ready]
    if not failures:
        if checks:
            log(f"Unsupported-effect fidelity gate passed for {ctx.spec['id']}.")
        return
    details = "\n".join(
        f"  - {check.role}: {check.effect_class}: {check.count} imported item(s)" for check in failures
    )
    fail(
        f"Unsupported-effect fidelity gate blocked {ctx.spec['id']!r}. M3Studio imports the metadata below, "
        "but this Eevee pipeline has no faithful renderer for it:\n"
        + details
        + "\nNo procedural substitute will be emitted. Use -AllowUnsupportedEffects only for material/framing "
        "calibration; do not package that output."
    )


def effect_bake_config(ctx: RenderContext, *, strict_textures: bool) -> EffectBakeConfig:
    raw = ctx.spec.get("effectRealization", {})
    if not isinstance(raw, Mapping):
        fail("effectRealization must be an object when provided.")
    return EffectBakeConfig(
        frame_start=ctx.frame_start,
        frame_end=ctx.frame_end,
        fps=float(ctx.scene.render.fps) / max(float(ctx.scene.render.fps_base), 1.0e-6),
        seed=as_int(raw.get("seed", 0x5C2A17), "effectRealization.seed"),
        bake_step=as_int(raw.get("bakeStep", 1), "effectRealization.bakeStep"),
        max_particles_per_system=as_int(
            raw.get("maxParticlesPerSystem", 256),
            "effectRealization.maxParticlesPerSystem",
        ),
        max_particles_total=as_int(
            raw.get("maxParticlesTotal", 1024),
            "effectRealization.maxParticlesTotal",
        ),
        strict_textures=strict_textures,
        displacement_subdivision=as_int(
            raw.get("displacementSubdivision", 2),
            "effectRealization.displacementSubdivision",
        ),
        displacement_unit_scale=as_float(
            raw.get("displacementUnitScale", 0.035),
            "effectRealization.displacementUnitScale",
        ),
        displacement_opacity=as_float(
            raw.get("displacementOpacity", 0.18),
            "effectRealization.displacementOpacity",
        ),
        particle_emission_strength=as_float(
            raw.get("particleEmissionStrength", 1.8),
            "effectRealization.particleEmissionStrength",
        ),
        particle_opacity=as_float(
            raw.get("particleOpacity", 1.0),
            "effectRealization.particleOpacity",
        ),
    )


def realize_source_effects(
    ctx: RenderContext,
    textures_root: Path,
    camera: Any,
    raw_checks: Sequence[EffectClassCheck],
    *,
    strict_textures: bool,
) -> dict[str, EffectRealizationReport]:
    """Bake only roles whose fail-closed snapshot found particles/displacement."""

    effect_roles = {
        check.role
        for check in raw_checks
        if check.count > 0 and check.effect_class in {"particle systems", "displacement mesh materials"}
    }
    if not effect_roles:
        return {}
    config = effect_bake_config(ctx, strict_textures=strict_textures)
    reports: dict[str, EffectRealizationReport] = {}
    for role_name in sorted(effect_roles):
        role = ctx.roles[role_name]
        if role.armature is None:
            fail(f"Effect realization requires an armature for role {role_name!r}.")
        try:
            report = realize_armature_effects(
                role.armature,
                textures_root,
                scene=ctx.scene,
                camera=camera,
                source_objects=role.imported_objects,
                config=config,
            )
        except M3EffectRealizationError as exc:
            fail(f"M3 effect realization failed for {ctx.spec['id']}/{role_name}: {exc}")
        for displacement in report.displacement_materials:
            source_mesh = bpy.data.objects.get(displacement.mesh)
            if displacement.realized and source_mesh is not None and source_mesh not in role.render_meshes:
                role.render_meshes.append(source_mesh)
        reports[role_name] = report
        log(
            f"M3 effect realization {ctx.spec['id']}/{role_name}: "
            f"particles={len(report.particle_systems)}, displacement={len(report.displacement_materials)}, "
            f"errors={report.error_count}, warnings={report.warning_count}."
        )
    return reports


def remap_realized_effect_checks(
    raw_checks: Sequence[EffectClassCheck],
    effect_reports: Mapping[str, EffectRealizationReport],
    ribbon_session: RibbonRealization | None,
) -> list[EffectClassCheck]:
    """Turn the imported-class snapshot into unresolved counts after realization."""

    allowed_issue_codes = {"SCREENSPACE_DISPLACEMENT_PROXY", "RIBBONS_NOT_REALIZED"}
    result: list[EffectClassCheck] = []
    for check in raw_checks:
        unresolved = check.count
        if check.effect_class == "ribbons" and ribbon_session is not None:
            unresolved = sum(
                diagnostic.status == "UNSUPPORTED"
                for diagnostic in ribbon_session.diagnostics
                if diagnostic.role == check.role
            )
        elif check.effect_class == "particle systems":
            report = effect_reports.get(check.role)
            if report is not None:
                blocking_sources = {
                    issue.source
                    for issue in report.issues
                    if issue.severity == "ERROR"
                    or (issue.severity == "WARNING" and issue.code not in allowed_issue_codes)
                }
                dormant = sum(
                    row.skipped_reason == "inactive in sampled frame range"
                    and row.name not in blocking_sources
                    for row in report.particle_systems
                )
                realized = sum(
                    row.skipped_reason is None and row.name not in blocking_sources
                    for row in report.particle_systems
                )
                unresolved = max(0, check.count - dormant - realized)
                if any(
                    issue.code in {"NO_PARTICLE_CAMERA", "PARTICLE_TOTAL_CAP"}
                    for issue in report.issues
                ):
                    unresolved = max(unresolved, min(1, check.count))
        elif check.effect_class == "displacement mesh materials":
            report = effect_reports.get(check.role)
            if report is not None:
                blocking_sources = {
                    issue.source
                    for issue in report.issues
                    if issue.severity == "ERROR"
                    or (issue.severity == "WARNING" and issue.code not in allowed_issue_codes)
                }
                realized = sum(
                    row.realized
                    and row.material not in blocking_sources
                    and row.mesh not in blocking_sources
                    for row in report.displacement_materials
                )
                unresolved = max(0, check.count - realized)
        result.append(
            EffectClassCheck(
                role=check.role,
                model_path=check.model_path,
                effect_class=check.effect_class,
                count=unresolved,
            )
        )
    return result


def principled_input(node: Any, *names: str) -> Any | None:
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            return socket
    return None


def separate_channel(nodes: Any, links: Any, color_socket: Any, channel: str) -> Any:
    if channel == "RGB":
        return color_socket
    try:
        separate = nodes.new("ShaderNodeSeparateColor")
        output_name = {"R": "Red", "G": "Green", "B": "Blue"}[channel]
    except RuntimeError:
        separate = nodes.new("ShaderNodeSeparateRGB")
        output_name = channel
    links.new(color_socket, separate.inputs["Color" if "Color" in separate.inputs else "Image"])
    return separate.outputs[output_name]


def build_layer_node(
    nodes: Any,
    links: Any,
    layer: Any | None,
    resolver: TextureResolver,
    *,
    label: str,
    non_color: bool = False,
) -> MaterialLayerNode:
    if layer is None:
        return MaterialLayerNode(None, None, None, None, None)
    bitmap = str(getattr(layer, "color_bitmap", "")).strip()
    bitmap_requested = str(getattr(layer, "color_type", "")) == "BITMAP" and bool(bitmap)
    resolved: Path | None = None
    color_socket: Any | None = None
    alpha_socket: Any | None = None
    if bitmap_requested:
        resolved = resolver.resolve(bitmap)
        log(f"M3 bitmap {label}: {bitmap} -> {resolved if resolved else '(missing local export)'}")
        if resolved:
            try:
                image = bpy.data.images.load(str(resolved), check_existing=True)
                image.colorspace_settings.name = "Non-Color" if non_color else "sRGB"
                texture = nodes.new("ShaderNodeTexImage")
                texture.name = f"M3_{label}_IMAGE"
                texture.label = bitmap
                texture.image = image
                texture.extension = "REPEAT" if bool(getattr(layer, "uv_wrap_x", True)) else "EXTEND"
                uv_map = nodes.new("ShaderNodeUVMap")
                uv_index = {"UV0": "uv0", "UV1": "uv1", "UV2": "uv2", "UV3": "uv3"}.get(
                    str(getattr(layer, "uv_source", "UV0")), "uv0"
                )
                uv_map.uv_map = uv_index
                mapping = nodes.new("ShaderNodeMapping")
                links.new(uv_map.outputs["UV"], mapping.inputs["Vector"])
                mapping.inputs["Location"].default_value[0:2] = tuple(getattr(layer, "uv_offset", (0.0, 0.0)))
                mapping.inputs["Scale"].default_value[0:2] = tuple(getattr(layer, "uv_tiling", (1.0, 1.0)))
                uv_angle = tuple(getattr(layer, "uv_angle", (0.0, 0.0, 0.0)))
                mapping.inputs["Rotation"].default_value[2] = float(uv_angle[2])
                links.new(mapping.outputs["Vector"], texture.inputs["Vector"])
                color_socket = texture.outputs["Color"]
                alpha_socket = texture.outputs["Alpha"]
            except Exception as exc:
                log(f"Blender could not load texture {resolved}: {exc}; diagnostic fallback remains untextured.")
                resolved = None
    if color_socket is None:
        # M3 bitmap layers commonly carry a black/zero placeholder color.  Using
        # that placeholder when the separately exported DDS is absent makes an
        # otherwise valid inspection render look invisible.  Leave the socket
        # unconnected so the caller's explicit neutral fallback remains active.
        if bitmap_requested:
            return MaterialLayerNode(None, None, None, bitmap, None)
        color_node = nodes.new("ShaderNodeRGB")
        color_value = tuple(float(value) for value in getattr(layer, "color_value", (1.0, 1.0, 1.0, 1.0)))
        color_node.outputs["Color"].default_value = color_value
        color_socket = color_node.outputs["Color"]
        value_node = nodes.new("ShaderNodeValue")
        value_node.outputs["Value"].default_value = color_value[3]
        alpha_socket = value_node.outputs["Value"]
    if bool(getattr(layer, "color_invert", False)):
        invert = nodes.new("ShaderNodeInvert")
        links.new(color_socket, invert.inputs["Color"])
        color_socket = invert.outputs["Color"]

    multiplier = float(getattr(layer, "color_multiply", 1.0)) * float(getattr(layer, "color_brightness", 1.0))
    addition = float(getattr(layer, "color_add", 0.0))
    if abs(multiplier - 1.0) > 0.0001:
        multiply = nodes.new("ShaderNodeVectorMath")
        multiply.operation = "SCALE"
        links.new(color_socket, multiply.inputs[0])
        multiply.inputs[3].default_value = multiplier
        color_socket = multiply.outputs["Vector"]
    if abs(addition) > 0.0001:
        add = nodes.new("ShaderNodeVectorMath")
        add.operation = "ADD"
        links.new(color_socket, add.inputs[0])
        add.inputs[1].default_value = (addition, addition, addition)
        color_socket = add.outputs["Vector"]

    channels = str(getattr(layer, "color_channels", "RGB"))
    if channels == "A":
        scalar = alpha_socket
    elif channels in {"R", "G", "B"}:
        scalar = separate_channel(nodes, links, color_socket, channels)
    else:
        scalar = color_socket
    return MaterialLayerNode(color_socket, alpha_socket, scalar, bitmap or None, resolved)


def material_config(spec: Mapping[str, Any]) -> dict[str, Any]:
    value = spec.get("materials", {})
    if not isinstance(value, Mapping):
        fail("materials must be an object.")
    return dict(value)


def build_standard_material(
    role: ModelRole,
    matref: Any,
    standard: Any,
    resolver: TextureResolver,
    spec: Mapping[str, Any],
) -> Any:
    config = material_config(spec)
    fallback = hex_color(config.get("fallbackColor", "#6C7893"), "materials.fallbackColor")
    team_color = hex_color(config.get("teamColor", "#278BFF"), "materials.teamColor")
    emission_strength = as_float(config.get("emissionStrength", 2.5), "materials.emissionStrength")
    name = f"SC2_{role.name}_{str(getattr(matref, 'name', 'material'))}"
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = fallback
    material.use_backface_culling = not bool(getattr(standard, "two_sided", False))
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    principled = nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Base Color"].default_value = fallback
    principled.inputs["Roughness"].default_value = 0.56
    links.new(principled.outputs["BSDF"], output.inputs["Surface"])

    prefix = f"{role.name}/{getattr(matref, 'name', 'material')}"
    diffuse = build_layer_node(nodes, links, m3_layer(role.armature, standard, "diff"), resolver, label=f"{prefix}/diff")
    decal = build_layer_node(nodes, links, m3_layer(role.armature, standard, "decal"), resolver, label=f"{prefix}/decal")
    ao = build_layer_node(nodes, links, m3_layer(role.armature, standard, "ao"), resolver, label=f"{prefix}/ao", non_color=True)
    base_socket = diffuse.color
    if base_socket is not None and str(getattr(standard, "blend_mode_layer", "")) == "TEAMDIFF" and diffuse.alpha:
        team_mix = nodes.new("ShaderNodeMixRGB")
        team_mix.blend_type = "MIX"
        links.new(diffuse.alpha, team_mix.inputs[0])
        links.new(base_socket, team_mix.inputs[1])
        team_mix.inputs[2].default_value = team_color
        base_socket = team_mix.outputs["Color"]
    if decal.color is not None:
        decal_mix = nodes.new("ShaderNodeMixRGB")
        decal_mix.blend_type = "MIX"
        decal_mix.inputs[0].default_value = 1.0
        if decal.alpha is not None:
            links.new(decal.alpha, decal_mix.inputs[0])
        if base_socket is not None:
            links.new(base_socket, decal_mix.inputs[1])
        else:
            decal_mix.inputs[1].default_value = fallback
        links.new(decal.color, decal_mix.inputs[2])
        base_socket = decal_mix.outputs["Color"]
    if base_socket is not None and ao.scalar is not None:
        ao_mix = nodes.new("ShaderNodeMixRGB")
        ao_mix.blend_type = "MULTIPLY"
        ao_mix.inputs[0].default_value = 1.0
        links.new(base_socket, ao_mix.inputs[1])
        links.new(ao.scalar, ao_mix.inputs[2])
        base_socket = ao_mix.outputs["Color"]
    if base_socket is not None:
        links.new(base_socket, principled.inputs["Base Color"])

    normal = build_layer_node(nodes, links, m3_layer(role.armature, standard, "norm"), resolver, label=f"{prefix}/norm", non_color=True)
    if normal.color is not None:
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.uv_map = "uv0"
        links.new(normal.color, normal_map.inputs["Color"])
        links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])

    gloss = build_layer_node(nodes, links, m3_layer(role.armature, standard, "gloss"), resolver, label=f"{prefix}/gloss", non_color=True)
    if gloss.scalar is not None:
        invert_gloss = nodes.new("ShaderNodeMath")
        invert_gloss.operation = "SUBTRACT"
        invert_gloss.inputs[0].default_value = 1.0
        links.new(gloss.scalar, invert_gloss.inputs[1])
        links.new(invert_gloss.outputs["Value"], principled.inputs["Roughness"])
    specular = build_layer_node(nodes, links, m3_layer(role.armature, standard, "spec"), resolver, label=f"{prefix}/spec", non_color=True)
    specular_input = principled_input(principled, "Specular IOR Level", "Specular")
    if specular.scalar is not None and specular_input is not None:
        links.new(specular.scalar, specular_input)

    emission_layers: list[tuple[MaterialLayerNode, str]] = []
    for slot, mode_property in (("emis1", "blend_mode_emis1"), ("emis2", "blend_mode_emis2")):
        layer_node = build_layer_node(
            nodes,
            links,
            m3_layer(role.armature, standard, slot),
            resolver,
            label=f"{prefix}/{slot}",
        )
        if layer_node.scalar is not None:
            emission_layers.append((layer_node, str(getattr(standard, mode_property, "ADD"))))
    emission_socket: Any | None = None
    for layer_node, blend_mode in emission_layers:
        # M3 emission often stores intensity in A/R/G/B rather than RGB. The
        # selected scalar preserves that authored packing; using texture RGB
        # here incorrectly lit alpha-only maps as their unrelated color plane.
        current_socket = layer_node.scalar
        if blend_mode == "TEAMEMIS" and layer_node.alpha is not None:
            team_emission = nodes.new("ShaderNodeMixRGB")
            links.new(layer_node.alpha, team_emission.inputs[0])
            links.new(current_socket, team_emission.inputs[1])
            team_emission.inputs[2].default_value = team_color
            current_socket = team_emission.outputs["Color"]
        if emission_socket is None:
            emission_socket = current_socket
        else:
            emission_add = nodes.new("ShaderNodeMixRGB")
            emission_add.blend_type = "ADD"
            emission_add.inputs[0].default_value = 1.0
            links.new(emission_socket, emission_add.inputs[1])
            links.new(current_socket, emission_add.inputs[2])
            emission_socket = emission_add.outputs["Color"]
    emission_input = principled_input(principled, "Emission Color", "Emission")
    emission_strength_input = principled_input(principled, "Emission Strength")
    if emission_socket is not None and emission_input is not None:
        links.new(emission_socket, emission_input)
        if emission_strength_input is not None:
            emission_strength_input.default_value = max(
                0.0, float(getattr(standard, "hdr_emis", 1.0)) * emission_strength
            )

    alpha_nodes = [
        build_layer_node(nodes, links, m3_layer(role.armature, standard, slot), resolver, label=f"{prefix}/{slot}", non_color=True)
        for slot in ("alpha1", "alpha2")
    ]
    alpha_sockets = [node.scalar for node in alpha_nodes if node.scalar is not None]
    if not alpha_sockets and str(getattr(standard, "blend_mode", "OPAQUE")) != "OPAQUE" and diffuse.alpha is not None:
        alpha_sockets.append(diffuse.alpha)
    alpha_socket: Any | None = alpha_sockets[0] if alpha_sockets else None
    for extra in alpha_sockets[1:]:
        multiply_alpha = nodes.new("ShaderNodeMath")
        multiply_alpha.operation = "MULTIPLY"
        links.new(alpha_socket, multiply_alpha.inputs[0])
        links.new(extra, multiply_alpha.inputs[1])
        alpha_socket = multiply_alpha.outputs["Value"]
    alpha_input = principled_input(principled, "Alpha")
    if alpha_socket is not None and alpha_input is not None:
        links.new(alpha_socket, alpha_input)
        if hasattr(material, "surface_render_method"):
            material.surface_render_method = "DITHERED"
        elif hasattr(material, "blend_method"):
            material.blend_method = "CLIP" if str(getattr(standard, "blend_mode", "")) == "OPAQUE" else "BLEND"
        if hasattr(material, "alpha_threshold"):
            material.alpha_threshold = float(getattr(standard, "alpha_test_threshold", 0)) / 255.0
    return material


def build_fallback_material(role: ModelRole, matref: Any, spec: Mapping[str, Any]) -> Any:
    config = material_config(spec)
    fallback = hex_color(config.get("fallbackColor", "#6C7893"), "materials.fallbackColor")
    name = f"SC2_{role.name}_{str(getattr(matref, 'name', 'fallback'))}_FALLBACK"
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = fallback
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled:
        principled.inputs["Base Color"].default_value = fallback
        principled.inputs["Roughness"].default_value = 0.58
    return material


def reconstruct_role_materials(role: ModelRole, resolver: TextureResolver, spec: Mapping[str, Any]) -> None:
    armature = role.armature
    if armature is None:
        log(f"Role {role.name!r} has no armature material metadata; fallback material skipped.")
        return
    matrefs = list(getattr(armature, "m3_materialrefs", ()))
    cache: dict[str, Any] = {}
    retained_meshes: list[Any] = []
    hidden_displacement_meshes = 0
    for mesh in role.render_meshes:
        handles = [str(getattr(batch.material, "handle", "")) for batch in getattr(mesh, "m3_mesh_batches", ())]
        unique_handles = [handle for index, handle in enumerate(handles) if handle and handle not in handles[:index]]
        if not unique_handles:
            # Code-native geometry already has its deliberately authored material.
            retained_meshes.append(mesh)
            continue
        if len(unique_handles) > 1:
            log(
                f"Mesh {mesh.name!r} has {len(unique_handles)} M3 batches but M3Studio exposes no face-to-batch "
                "mapping; assigning the first material deterministically."
            )
        handle = unique_handles[0]
        matref = m3_item_by_handle(matrefs, handle)
        if matref is None:
            log(f"Mesh {mesh.name!r} references unknown M3 material handle; leaving it unassigned.")
            retained_meshes.append(mesh)
            continue
        if str(getattr(matref, "mat_type", "")) == "m3_materials_displacement":
            # A neutral Principled fallback turns texture-driven displacement
            # volumes into opaque smooth geometry. Keep the genuine imported
            # object in-scene for inspection, but never counterfeit the shader
            # with a flat delivery material.
            mesh.hide_render = True
            hidden_displacement_meshes += 1
            log(
                f"Mesh {mesh.name!r} uses unsupported M3 displacement material "
                f"{getattr(matref, 'name', handle)!r}; retaining it in-scene but hiding it from delivery."
            )
            continue
        if handle not in cache:
            if str(getattr(matref, "mat_type", "")) == "m3_materials_standard":
                standard = m3_item_by_handle(
                    getattr(armature, "m3_materials_standard", ()), str(getattr(matref, "mat_handle", ""))
                )
                cache[handle] = (
                    build_standard_material(role, matref, standard, resolver, spec)
                    if standard is not None
                    else build_fallback_material(role, matref, spec)
                )
            else:
                cache[handle] = build_fallback_material(role, matref, spec)
                log(
                    f"M3 material {getattr(matref, 'name', handle)!r} is type "
                    f"{getattr(matref, 'mat_type', 'unknown')}; using a neutral Principled fallback."
                )
        mesh.data.materials.clear()
        mesh.data.materials.append(cache[handle])
        retained_meshes.append(mesh)
    role.render_meshes = retained_meshes
    log(
        f"Built {len(cache)} Blender material(s) for role {role.name!r} across "
        f"{len(retained_meshes)} delivery mesh(es); hid {hidden_displacement_meshes} unsupported displacement mesh(es)."
    )


def animate_helper(
    obj: Any,
    start: int,
    peak: int,
    end: int,
    *,
    start_scale: Sequence[float],
    peak_scale: Sequence[float],
    end_scale: Sequence[float],
) -> None:
    for frame, value in ((start, start_scale), (peak, peak_scale), (end, end_scale)):
        obj.scale = tuple(value)
        obj.keyframe_insert(data_path="scale", frame=frame)
        set_interpolation(obj, frame, "BEZIER")
    obj.hide_render = False


def add_pulse_ring(
    ctx: RenderContext,
    name: str,
    position: Sequence[float],
    start: int,
    end: int,
    radius: float = 2.0,
    color_key: str = "primary",
    vertical: bool = False,
) -> Any:
    visual_radius = radius * 0.62
    bpy.ops.mesh.primitive_torus_add(
        major_radius=1.0,
        minor_radius=0.027,
        major_segments=64,
        minor_segments=10,
        location=tuple(position),
    )
    ring = bpy.context.active_object
    ring.name = f"SC2_FX_{name}"
    if vertical:
        ring.rotation_euler = (math.radians(90.0), 0.0, 0.0)
    ring.data.materials.append(create_emission_material(f"{ring.name}_MAT", ctx.palette[color_key], 1.35))
    mid = start + max(1, (end - start) // 2)
    visible_end = max(mid + 1, end - 1)
    animate_helper(
        ring,
        start,
        mid,
        visible_end,
        # Zero before the first keyed pulse so future effects do not leak a
        # tiny ring into earlier poster frames through F-curve extrapolation.
        start_scale=(0.0, 0.0, 0.0),
        peak_scale=(visual_radius, visual_radius, visual_radius),
        end_scale=(visual_radius * 1.25, visual_radius * 1.25, visual_radius * 1.25),
    )
    ring.scale = (0.001, 0.001, 0.001)
    ring.keyframe_insert(data_path="scale", frame=end)
    set_interpolation(ring, end, "CONSTANT")
    return ring


def add_energy_orb(
    ctx: RenderContext,
    name: str,
    position: Sequence[float],
    start: int,
    peak: int,
    end: int,
    radius: float,
    color_key: str = "secondary",
) -> Any:
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1.0, location=tuple(position))
    orb = bpy.context.active_object
    orb.name = f"SC2_FX_{name}"
    orb.data.materials.append(create_emission_material(f"{orb.name}_MAT", ctx.palette[color_key], 2.0))
    animate_helper(
        orb,
        start,
        peak,
        end,
        start_scale=(0.01, 0.01, 0.01),
        peak_scale=(radius, radius, radius),
        end_scale=(0.01, 0.01, 0.01),
    )
    return orb


def parent_to_bone(
    obj: Any,
    armature: Any,
    bone_name: str,
    *,
    location: Sequence[float] = (0.0, 0.0, 0.0),
    rotation: Sequence[float] = (0.0, 0.0, 0.0),
) -> None:
    if armature is None or bone_name not in armature.pose.bones:
        fail(f"Cannot attach {obj.name!r}; imported armature has no pose bone {bone_name!r}.")
    obj.parent = armature
    obj.parent_type = "BONE"
    obj.parent_bone = bone_name
    obj.location = tuple(float(value) for value in location)
    obj.rotation_mode = "XYZ"
    obj.rotation_euler = tuple(float(value) for value in rotation)


def animate_render_visibility(obj: Any, frame_start: int, frame_end: int) -> None:
    """Hide a short-lived helper outside its authored render interval."""

    before = max(int(bpy.context.scene.frame_start), int(frame_start) - 1)
    after = min(int(bpy.context.scene.frame_end), int(frame_end) + 1)
    obj.hide_render = True
    obj.keyframe_insert(data_path="hide_render", frame=before)
    obj.hide_render = False
    obj.keyframe_insert(data_path="hide_render", frame=int(frame_start))
    if after > int(frame_end):
        obj.hide_render = True
        obj.keyframe_insert(data_path="hide_render", frame=after)
    set_interpolation(obj, before, "CONSTANT")
    set_interpolation(obj, int(frame_start), "CONSTANT")
    if after > int(frame_end):
        set_interpolation(obj, after, "CONSTANT")


def add_muzzle_bursts(ctx: RenderContext, count: int, start: int, end: int) -> None:
    hero = require_role(ctx, "hero")
    count = max(1, min(count, 12))
    available = max(1, end - start)
    for index in range(count):
        frame = start + int(round(available * index / max(1, count - 1)))
        height = 0.34 + 0.06 * (index % 2)
        bpy.ops.mesh.primitive_cone_add(
            vertices=24,
            radius1=0.065,
            radius2=0.012,
            depth=height,
            location=(0.0, 0.0, 0.0),
        )
        burst = bpy.context.active_object
        burst.name = f"SC2_FX_marine_muzzle_{index + 1:02d}"
        # Ref_Weapon's local +X axis follows the rifle barrel in both native
        # Attack and Stand Victory. Bone-parent the flash so the late salute
        # fires from the evaluated imported muzzle instead of a guessed world
        # coordinate. Blender cones point along +Z, hence the +90 degree Y turn.
        parent_to_bone(
            burst,
            hero.armature,
            "Ref_Weapon",
            location=(height * 0.48, 0.0, 0.0),
            rotation=(0.0, math.radians(90.0), 0.0),
        )
        burst.data.materials.append(
            create_emission_material(f"{burst.name}_MAT", ctx.palette["warm"], 3.0)
        )
        visible_start = max(ctx.frame_start, frame - 1)
        visible_end = min(ctx.frame_end, frame + 4)
        animate_helper(
            burst,
            visible_start,
            frame,
            visible_end,
            start_scale=(0.001, 0.001, 0.001),
            peak_scale=(1.0, 1.0, 1.0),
            end_scale=(0.001, 0.001, 0.001),
        )
        animate_render_visibility(burst, visible_start, visible_end)
        flash = add_energy_orb(
            ctx,
            f"marine_flash_{index + 1:02d}",
            (0.0, 0.0, 0.0),
            max(ctx.frame_start, frame - 1),
            frame,
            min(ctx.frame_end, frame + 4),
            0.075,
            "secondary",
        )
        parent_to_bone(flash, hero.armature, "Ref_Weapon")
        animate_render_visibility(flash, visible_start, visible_end)


def add_confetti(ctx: RenderContext, count: int, start: int, end: int) -> None:
    colors = ("primary", "secondary", "warm")
    for index in range(max(0, min(count, 40))):
        angle = (index / max(1, count)) * math.tau
        radius = 1.2 + 0.25 * (index % 4)
        x = math.cos(angle) * radius
        y = math.sin(angle) * radius * 0.45
        z = 4.6 + 0.18 * (index % 5)
        bpy.ops.mesh.primitive_cube_add(size=0.16, location=(x, y, z))
        piece = bpy.context.active_object
        piece.name = f"SC2_FX_confetti_{index + 1:02d}"
        piece.data.materials.append(
            create_emission_material(f"{piece.name}_MAT", ctx.palette[colors[index % len(colors)]], 1.0)
        )
        piece.rotation_mode = "XYZ"
        piece.keyframe_insert(data_path="location", frame=start)
        piece.rotation_euler = (angle * 2.0, angle * 3.0, angle)
        piece.keyframe_insert(data_path="rotation_euler", frame=start)
        piece.location = (x * 1.5, y * 1.5, 0.25 + 0.12 * (index % 3))
        piece.rotation_euler = (angle * 8.0, angle * 6.0, angle * 7.0)
        piece.keyframe_insert(data_path="location", frame=end)
        piece.keyframe_insert(data_path="rotation_euler", frame=end)
        set_interpolation(piece, start, "LINEAR")
        set_interpolation(piece, end, "LINEAR")


def zealot_dance(ctx: RenderContext) -> None:
    hero = require_role(ctx, "hero")
    height = option(ctx, "jumpHeight", 0.65)
    spin = option(ctx, "spinDegrees", 360.0)
    # Native Stand Dance supplies the body performance. Root motion stays subtle
    # so the authored feet remain believable and the silhouette stays framed.
    poses = (
        (0.00, (0, 0, 0), (0, 0, -spin * 0.35), (1.0, 1.0, 1.0)),
        (0.18, (-0.10, 0, height), (0, -2, -spin * 0.12), (1.02, 1.02, 0.98)),
        (0.36, (0.10, 0, 0), (0, 2, spin * 0.14), (1.0, 1.0, 1.0)),
        (0.55, (-0.08, 0, height * 0.8), (0, -2, spin * 0.3), (1.02, 1.02, 0.98)),
        (0.74, (0.08, 0, 0), (0, 2, spin * 0.5), (1.0, 1.0, 1.0)),
        (0.90, (0, 0, height * 0.5), (0, 0, spin * 0.35), (1.04, 1.04, 0.95)),
        (1.00, (0, 0, 0), (0, 0, -spin * 0.35), (1.0, 1.0, 1.0)),
    )
    for fraction, offset, rotation, scale in poses:
        pose(hero, ctx.frame(fraction), offset=offset, rotation_deg=rotation, scale=scale)


def marine_skyfire(ctx: RenderContext) -> None:
    hero = require_role(ctx, "hero")
    burst_count = int(option(ctx, "burstCount", 4))
    # Keep the Marine planted. Native Attack then Stand Victory drives the body;
    # root keys only add recoil/settle and never lift the feet off the ground.
    for fraction, offset, rotation, scale, interpolation in (
        (0.00, (0, 0, 0), (0, 0, 0), (1, 1, 1), "BEZIER"),
        (0.18, (-0.08, 0, 0), (0, -3, -2), (1.02, 1.02, 0.98), "BEZIER"),
        (0.36, (0.06, 0, 0), (0, 3, 2), (1.0, 1.0, 1.0), "BEZIER"),
        (0.56, (-0.04, 0, 0), (0, -2, -1), (1.02, 1.02, 0.98), "BEZIER"),
        (0.64, (0, 0, 0), (0, 0, 0), (1.04, 1.04, 0.96), "BEZIER"),
        (0.82, (0, 0, 0), (0, 0, 2), (1.0, 1.0, 1.0), "BEZIER"),
        (1.00, (0, 0, 0), (0, 0, 0), (1.0, 1.0, 1.0), "BEZIER"),
    ):
        pose(hero, ctx.frame(fraction), offset=offset, rotation_deg=rotation, scale=scale, interpolation=interpolation)
    add_muzzle_bursts(ctx, burst_count, ctx.frame(0.64), ctx.frame(0.88))


def archon_merge(ctx: RenderContext) -> None:
    left = require_role(ctx, "templar_left")
    right = require_role(ctx, "templar_right")
    hero = require_role(ctx, "hero")
    merge_height = option(ctx, "mergeHeight", 0.6)
    pose(hero, ctx.frame(0.0), scale=0.005, interpolation="CONSTANT")
    pose(hero, ctx.frame(0.55), scale=0.005, interpolation="CONSTANT")
    for role, direction in ((left, 1.0), (right, -1.0)):
        pose(role, ctx.frame(0.0))
        pose(role, ctx.frame(0.38), offset=(direction * 1.2, 0, merge_height * 0.25), rotation_deg=(0, 0, direction * 25))
        pose(role, ctx.frame(0.56), offset=(direction * 2.1, 0, merge_height), rotation_deg=(0, 0, direction * 95), scale=0.035)
        pose(role, ctx.frame(1.0), offset=(direction * 2.1, 0, merge_height), scale=0.001, interpolation="CONSTANT")
    pose(hero, ctx.frame(0.58), offset=(0, 0, merge_height), scale=0.035)
    pose(hero, ctx.frame(0.72), offset=(0, 0, merge_height * 0.35), scale=1.24)
    pose(hero, ctx.frame(0.88), offset=(0, 0, 0), scale=0.96)
    pose(hero, ctx.frame(1.0), offset=(0, 0, 0.12), scale=1.0)


def archon_backflip(ctx: RenderContext) -> None:
    hero = require_role(ctx, "hero")
    height = option(ctx, "jumpHeight", 2.4)
    flip = option(ctx, "flipDegrees", 360.0)
    for fraction, offset, rotation, scale in (
        (0.00, (0, 0, 0), (0, 0, 0), (1, 1, 1)),
        (0.18, (0, 0, 0), (0, 0, 0), (1.12, 1.12, 0.78)),
        (0.38, (0, 0, height * 0.78), (flip * 0.22, 0, 0), (0.96, 0.96, 1.06)),
        (0.55, (0, 0, height), (flip * 0.52, 0, 0), (0.94, 0.94, 1.08)),
        (0.74, (0, 0, height * 0.62), (flip * 0.82, 0, 0), (0.98, 0.98, 1.03)),
        (0.90, (0, 0, 0), (flip, 0, 0), (1.16, 1.16, 0.76)),
        (1.00, (0, 0, 0), (flip, 0, 0), (1, 1, 1)),
    ):
        pose(hero, ctx.frame(fraction), offset=offset, rotation_deg=rotation, scale=scale)


def stalker_blink(ctx: RenderContext) -> None:
    hero = require_role(ctx, "hero")
    distance = option(ctx, "blinkDistance", 3.8)
    squash = option(ctx, "squash", 0.06)
    pose(hero, ctx.frame(0.0))
    pose(hero, ctx.frame(0.28), scale=(1.16, 0.88, 1.02), rotation_deg=(0, 0, -7))
    pose(hero, ctx.frame(0.42), scale=(squash, squash, 1.35), rotation_deg=(0, 0, -14), interpolation="LINEAR")
    pose(hero, ctx.frame(0.44), offset=(distance, 0, 0.2), scale=(squash, squash, 1.35), rotation_deg=(0, 0, 14), interpolation="CONSTANT")
    pose(hero, ctx.frame(0.56), offset=(distance, 0, 0), scale=(1.18, 0.88, 1.02), rotation_deg=(0, 0, 7))
    pose(hero, ctx.frame(0.74), offset=(distance, 0, 0), scale=1.0)
    pose(hero, ctx.frame(1.0), offset=(distance, 0, 0.12), scale=1.0)
    source_x = hero.base_location[0]
    add_pulse_ring(ctx, "blink_source", (source_x, 0, 0.18), ctx.frame(0.29), ctx.frame(0.52), 1.7)
    add_pulse_ring(ctx, "blink_destination", (source_x + distance, 0, 0.18), ctx.frame(0.42), ctx.frame(0.70), 1.9, "secondary")


def carrier_interceptors(ctx: RenderContext) -> None:
    hero = require_role(ctx, "hero")
    interceptors = sorted((role for name, role in ctx.roles.items() if name.startswith("interceptor_")), key=lambda item: item.name)
    if not interceptors:
        fail("carrier_interceptors requires at least one role named interceptor_1, interceptor_2, etc.")
    radius = option(ctx, "orbitRadius", 4.0)
    orbit_height = option(ctx, "orbitHeight", 1.2)
    turns = option(ctx, "turns", 1.5)
    pose(hero, ctx.frame(0.0), offset=(0, 0, 0))
    pose(hero, ctx.frame(0.48), offset=(0, 0, 0.28), rotation_deg=(0, 0, 3))
    pose(hero, ctx.frame(1.0), offset=(0, 0, 0), rotation_deg=(0, 0, -3))
    samples = 13
    for index, interceptor in enumerate(interceptors):
        phase = math.tau * index / len(interceptors)
        for sample in range(samples):
            fraction = sample / (samples - 1)
            angle = phase + fraction * math.tau * turns
            offset = (
                math.cos(angle) * radius,
                math.sin(angle) * radius * 0.48,
                orbit_height + math.sin(angle * 2.0) * 0.45,
            )
            pose(
                interceptor,
                ctx.frame(fraction),
                offset=offset,
                rotation_deg=(0, 0, math.degrees(angle) + 90),
                scale=0.88 + 0.08 * math.sin(angle),
                interpolation="LINEAR",
            )


def zergling_zoomies(ctx: RenderContext) -> None:
    hero = require_role(ctx, "hero")
    distance = option(ctx, "runDistance", 6.8)
    depth = option(ctx, "zigzagDepth", 1.0)
    for fraction, x, y, z, heading in (
        (0.00, 0.0, 0.0, 0.0, 0),
        (0.16, distance * 0.27, depth, 0.18, 18),
        (0.32, distance * 0.55, -depth, 0.0, -20),
        (0.48, distance * 0.82, depth * 0.75, 0.24, 22),
        (0.62, distance, 0.0, 0.0, 175),
        (0.78, distance * 0.48, -depth * 0.7, 0.18, 200),
        (1.00, 0.1, 0.0, 0.0, 360),
    ):
        pose(hero, ctx.frame(fraction), offset=(x, y, z), rotation_deg=(0, 0, heading), interpolation="LINEAR")


def baneling_bowling(ctx: RenderContext) -> None:
    hero = require_role(ctx, "hero")
    distance = option(ctx, "rollDistance", 7.0)
    roll = option(ctx, "rollDegrees", 1080.0)
    for fraction, x, z, rotation, scale in (
        (0.00, 0.0, 0.0, 0.0, (1, 1, 1)),
        (0.18, distance * 0.18, 0.14, roll * 0.18, (1.02, 1.02, 0.96)),
        (0.42, distance * 0.46, 0.0, roll * 0.46, (1, 1, 1)),
        (0.68, distance * 0.75, 0.22, roll * 0.75, (1.03, 1.03, 0.94)),
        (0.88, distance, 0.0, roll, (1.2, 1.2, 0.72)),
        (1.00, distance, 0.0, roll, (1, 1, 1)),
    ):
        pose(hero, ctx.frame(fraction), offset=(x, 0, z), rotation_deg=(0, rotation, 0), scale=scale, interpolation="LINEAR")


def overlord_party_balloon(ctx: RenderContext) -> None:
    hero = require_role(ctx, "hero")
    height = option(ctx, "bobHeight", 0.7)
    count = int(option(ctx, "confettiCount", 12))
    for fraction, x, z, yaw, scale in (
        (0.00, 0.0, 0.0, -4, (1.0, 1.0, 1.0)),
        (0.20, -0.25, height, 5, (1.04, 1.04, 0.96)),
        (0.42, 0.25, 0.1, -5, (0.98, 0.98, 1.04)),
        (0.64, -0.18, height * 0.85, 7, (1.04, 1.04, 0.96)),
        (0.82, 0.2, 0.2, -4, (0.98, 0.98, 1.03)),
        (1.00, 0.0, height * 0.55, 0, (1, 1, 1)),
    ):
        pose(hero, ctx.frame(fraction), offset=(x, 0, z), rotation_deg=(0, 0, yaw), scale=scale)
    add_confetti(ctx, count, ctx.frame(0.34), ctx.frame(0.96))


def battlecruiser_warp_in(ctx: RenderContext) -> None:
    hero = require_role(ctx, "hero")
    arrival = option(ctx, "arrivalScale", 0.025)
    bank = option(ctx, "bankDegrees", 18.0)
    pose(hero, ctx.frame(0.0), offset=(0, 0, 0.8), rotation_deg=(0, 0, -bank), scale=arrival, interpolation="CONSTANT")
    pose(hero, ctx.frame(0.08), offset=(0, 0, 0.8), rotation_deg=(0, 0, -bank), scale=arrival)
    pose(hero, ctx.frame(0.36), offset=(0, 0, 0.25), rotation_deg=(0, 0, bank * 0.25), scale=1.18)
    pose(hero, ctx.frame(0.58), offset=(0, 0, 0), rotation_deg=(0, 0, 0), scale=0.96)
    pose(hero, ctx.frame(1.0), offset=(0.35, 0, 0.18), rotation_deg=(0, 0, bank * 0.12), scale=1.0)


def mule_money_drop(ctx: RenderContext) -> None:
    hero = require_role(ctx, "hero")
    height = option(ctx, "dropHeight", 5.5)
    coin_start_height = option(ctx, "coinStartHeight", max(3.2, height + 0.1))
    count = int(option(ctx, "coinCount", 9))
    pose(hero, ctx.frame(0.0), offset=(0, 0, height), rotation_deg=(0, 0, -12), scale=0.86, interpolation="CONSTANT")
    pose(hero, ctx.frame(0.38), offset=(0, 0, height), rotation_deg=(0, 0, -12), scale=0.86, interpolation="CONSTANT")
    pose(hero, ctx.frame(0.60), offset=(0, 0, 0), rotation_deg=(0, 0, 8), scale=(1.16, 1.16, 0.70), interpolation="LINEAR")
    pose(hero, ctx.frame(0.72), offset=(0, 0, 0.6), rotation_deg=(0, 0, -4), scale=(0.94, 0.94, 1.08))
    pose(hero, ctx.frame(0.84), offset=(0, 0, 0), scale=(1.06, 1.06, 0.88))
    pose(hero, ctx.frame(1.0), offset=(0, 0, 0), scale=1.0)
    coin_material = create_coin_material("SC2_FX_credit_gold_MAT")
    for index in range(max(0, min(count, 30))):
        angle = math.tau * index / max(1, count)
        x = math.cos(angle) * (0.8 + 0.18 * (index % 3))
        y = math.sin(angle) * 0.55
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=32,
            radius=0.22,
            depth=0.055,
            location=(x, y, coin_start_height + 0.2 * (index % 4)),
            rotation=(math.radians(90.0), 0.0, angle),
        )
        coin = bpy.context.active_object
        coin.name = f"SC2_FX_credit_{index + 1:02d}"
        coin.data.materials.append(coin_material)
        bevel = coin.modifiers.new(name="SC2_Credit_Rim", type="BEVEL")
        bevel.width = 0.018
        bevel.segments = 2
        start = ctx.frame(0.34 + 0.025 * (index % 4))
        end = ctx.frame(0.78 + 0.018 * (index % 5))
        coin.keyframe_insert(data_path="location", frame=start)
        coin.keyframe_insert(data_path="rotation_euler", frame=start)
        coin.location = (x * 2.1, y * 2.1, 0.22)
        coin.rotation_euler = (math.radians(90.0) + angle * 3.0, angle * 5.0, angle * 4.0)
        coin.keyframe_insert(data_path="location", frame=end)
        coin.keyframe_insert(data_path="rotation_euler", frame=end)
        set_interpolation(coin, start, "LINEAR")
        set_interpolation(coin, end, "LINEAR")


CHOREOGRAPHIES: dict[str, Callable[[RenderContext], None]] = {
    "zealot_dance": zealot_dance,
    "marine_skyfire": marine_skyfire,
    "archon_merge": archon_merge,
    "archon_backflip": archon_backflip,
    "stalker_blink": stalker_blink,
    "carrier_interceptors": carrier_interceptors,
    "zergling_zoomies": zergling_zoomies,
    "baneling_bowling": baneling_bowling,
    "overlord_party_balloon": overlord_party_balloon,
    "battlecruiser_warp_in": battlecruiser_warp_in,
    "mule_money_drop": mule_money_drop,
}


def add_area_light(
    name: str,
    location: Sequence[float],
    target: Sequence[float],
    color: Sequence[float],
    energy: float,
    size: float,
) -> Any:
    data = bpy.data.lights.new(name=name, type="AREA")
    data.energy = energy
    data.color = tuple(color[:3])
    data.shape = "DISK"
    data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = tuple(location)
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


def render_objects_for_sampling(ctx: RenderContext, include_effects: bool) -> list[Any]:
    objects = [mesh for role in ctx.roles.values() for mesh in role.render_meshes]
    if include_effects:
        objects.extend(
            obj
            for obj in bpy.context.scene.objects
            if obj.type == "MESH" and obj.name.startswith(("SC2_FX_", "M3FX_"))
        )
    # A displacement shell can already be present in a role list while a
    # generated effect was appended through the scene.  Preserve order while
    # preventing duplicate evaluated-mesh work during multi-frame auto-framing.
    return list(dict.fromkeys(objects))


def frame_numbers_for_sampling(
    ctx: RenderContext,
    sample_count: int,
    frames: Iterable[int] | None,
) -> set[int]:
    sample_count = max(3, min(sample_count, 49))
    sampled_frames = (
        {int(frame) for frame in frames}
        if frames is not None
        else {
            int(round(ctx.frame_start + (ctx.frame_end - ctx.frame_start) * index / (sample_count - 1)))
            for index in range(sample_count)
        }
    )
    sampled_frames.add(int(ctx.spec["posterFrame"]))
    return sampled_frames


def sampled_render_bounds(
    ctx: RenderContext,
    sample_count: int,
    *,
    include_effects: bool = False,
    frames: Iterable[int] | None = None,
) -> tuple[Any, Any] | None:
    render_objects = render_objects_for_sampling(ctx, include_effects)
    if not render_objects:
        return None
    sampled_frames = frame_numbers_for_sampling(ctx, sample_count, frames)
    minimum = Vector((math.inf, math.inf, math.inf))
    maximum = Vector((-math.inf, -math.inf, -math.inf))
    original_frame = ctx.scene.frame_current
    try:
        for frame in sorted(sampled_frames):
            ctx.scene.frame_set(frame)
            depsgraph = bpy.context.evaluated_depsgraph_get()
            for source in render_objects:
                if bool(source.hide_render):
                    continue
                evaluated = source.evaluated_get(depsgraph)
                try:
                    mesh = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=depsgraph)
                except (RuntimeError, TypeError):
                    mesh = None
                if mesh is None:
                    continue
                world = evaluated.matrix_world
                for vertex in mesh.vertices:
                    point = world @ vertex.co
                    minimum.x = min(minimum.x, point.x)
                    minimum.y = min(minimum.y, point.y)
                    minimum.z = min(minimum.z, point.z)
                    maximum.x = max(maximum.x, point.x)
                    maximum.y = max(maximum.y, point.y)
                    maximum.z = max(maximum.z, point.z)
                evaluated.to_mesh_clear()
    finally:
        ctx.scene.frame_set(original_frame)
    if not all(math.isfinite(value) for value in (*minimum, *maximum)):
        return None
    return minimum, maximum


def sampled_camera_extents(
    ctx: RenderContext,
    camera: Any,
    sample_count: int,
    *,
    include_effects: bool = False,
    frames: Iterable[int] | None = None,
) -> tuple[float, float] | None:
    """Return precise centered X/Y extents from evaluated mesh vertices.

    Projecting the eight corners of a world-space AABB is substantially too
    conservative for diagonal camera views (especially long ships).  Sampling
    actual evaluated vertices keeps the requested on-screen occupancy honest.
    """

    render_objects = render_objects_for_sampling(ctx, include_effects)
    if not render_objects:
        return None
    sampled_frames = frame_numbers_for_sampling(ctx, sample_count, frames)
    maximum_x = 0.0
    maximum_y = 0.0
    found_vertex = False
    original_frame = ctx.scene.frame_current
    try:
        for frame in sorted(sampled_frames):
            ctx.scene.frame_set(frame)
            depsgraph = bpy.context.evaluated_depsgraph_get()
            inverse = camera.matrix_world.inverted()
            for source in render_objects:
                if bool(source.hide_render):
                    continue
                evaluated = source.evaluated_get(depsgraph)
                try:
                    mesh = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=depsgraph)
                except (RuntimeError, TypeError):
                    mesh = None
                if mesh is None:
                    continue
                world = evaluated.matrix_world
                for vertex in mesh.vertices:
                    camera_point = inverse @ (world @ vertex.co)
                    maximum_x = max(maximum_x, abs(float(camera_point.x)))
                    maximum_y = max(maximum_y, abs(float(camera_point.y)))
                    found_vertex = True
                evaluated.to_mesh_clear()
    finally:
        ctx.scene.frame_set(original_frame)
    if not found_vertex:
        return None
    return 2.0 * maximum_x, 2.0 * maximum_y


def auto_frame_camera(ctx: RenderContext, camera: Any, camera_config: Mapping[str, Any]) -> tuple[float, float, float]:
    configured_target = vec3(camera_config.get("target", [0, 0, 1.6]), "camera.target")
    if camera.data.type != "ORTHO" or camera_config.get("autoFrame", True) is not True:
        return configured_target
    sample_count = as_int(camera_config.get("sampleCount", 13), "camera.sampleCount")
    sequence_bounds = sampled_render_bounds(ctx, sample_count)
    poster_bounds = sampled_render_bounds(
        ctx,
        sample_count,
        frames=(int(ctx.spec["posterFrame"]),),
    )
    if sequence_bounds is None or poster_bounds is None:
        log("Automatic camera framing found no evaluated render meshes; retaining configured framing.")
        return configured_target
    framing_mode = str(camera_config.get("framingMode", "poster")).lower()
    if framing_mode not in {"poster", "sequence"}:
        fail("camera.framingMode must be 'poster' or 'sequence'.")
    focus_bounds = poster_bounds if framing_mode == "poster" else sequence_bounds
    minimum, maximum = focus_bounds
    bias = Vector(vec3(camera_config.get("targetBias", [0, 0, 0]), "camera.targetBias"))
    target = (minimum + maximum) * 0.5 + bias
    configured_location = Vector(vec3(camera_config.get("location", [7.5, -10.0, 6.5]), "camera.location"))
    view_offset = configured_location - Vector(configured_target)
    camera.location = target + view_offset
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.view_layer.update()
    aspect = max(0.01, ctx.scene.render.resolution_x / ctx.scene.render.resolution_y)
    margin = as_float(camera_config.get("margin", 1.02), "camera.margin")

    def required_scale_for(
        *,
        include_effects: bool,
        frames: Iterable[int] | None,
    ) -> float:
        extents = sampled_camera_extents(
            ctx,
            camera,
            sample_count,
            include_effects=include_effects,
            frames=frames,
        )
        if extents is None:
            return 0.0
        x_extent, y_extent = extents
        return max(y_extent, x_extent / aspect)

    poster_occupancy = as_float(camera_config.get("posterOccupancy", 0.70), "camera.posterOccupancy")
    sequence_occupancy = as_float(camera_config.get("sequenceOccupancy", 0.82), "camera.sequenceOccupancy")
    if not 0.1 <= poster_occupancy <= 1.0 or not 0.1 <= sequence_occupancy <= 1.0:
        fail("camera poster/sequence occupancy values must be between 0.1 and 1.0.")
    focus_occupancy = poster_occupancy if framing_mode == "poster" else sequence_occupancy
    poster_frames = (int(ctx.spec["posterFrame"]),)
    focus_frames = poster_frames if framing_mode == "poster" else None
    focus_required_scale = required_scale_for(
        include_effects=False,
        frames=focus_frames,
    ) * margin / focus_occupancy
    required_scale = focus_required_scale
    if framing_mode == "poster":
        sequence_guard = required_scale_for(include_effects=False, frames=None) * margin / 0.95
        sequence_expansion_limit = as_float(
            camera_config.get("maxSequenceExpansion", 1.08), "camera.maxSequenceExpansion"
        )
        if sequence_expansion_limit < 1.0:
            fail("camera.maxSequenceExpansion must be at least 1.0.")
        required_scale = max(
            focus_required_scale,
            min(sequence_guard, focus_required_scale * sequence_expansion_limit),
        )
    effect_bounds: tuple[Any, Any] | None = None
    if camera_config.get("includeEffects", True) is True:
        effect_frames = poster_frames if framing_mode == "poster" else None
        effect_bounds = sampled_render_bounds(
            ctx,
            sample_count,
            include_effects=True,
            frames=effect_frames,
        )
        if effect_bounds is not None:
            effect_required_scale = required_scale_for(
                include_effects=True,
                frames=effect_frames,
            ) * margin / focus_occupancy
            expansion_limit = as_float(
                camera_config.get("maxEffectExpansion", 1.02), "camera.maxEffectExpansion"
            )
            if expansion_limit < 1.0:
                fail("camera.maxEffectExpansion must be at least 1.0.")
            required_scale = max(
                required_scale,
                min(effect_required_scale, required_scale * expansion_limit),
            )
    minimum_scale = as_float(camera_config.get("minOrthoScale", 4.5), "camera.minOrthoScale")
    maximum_scale = as_float(camera_config.get("maxOrthoScale", 18.0), "camera.maxOrthoScale")
    camera.data.ortho_scale = max(minimum_scale, min(maximum_scale, required_scale))
    if required_scale > maximum_scale:
        log(
            f"Automatic camera framing required ortho scale {required_scale:.2f}, clamped to "
            f"camera.maxOrthoScale {maximum_scale:.2f}; inspect for clipping."
        )
    log(
        f"Automatic camera framing sampled {sample_count} frames: world bounds "
        f"({minimum.x:.2f}, {minimum.y:.2f}, {minimum.z:.2f}).."
        f"({maximum.x:.2f}, {maximum.y:.2f}, {maximum.z:.2f}), {framing_mode} target "
        f"{focus_occupancy:.0%}, final ortho scale {camera.data.ortho_scale:.2f}."
    )
    return tuple(target)


def build_camera_follow_offsets(
    ctx: RenderContext, camera_config: Mapping[str, Any]
) -> dict[int, Any] | None:
    """Sample authored root motion for a stable world-space camera follow."""
    role_name = str(camera_config.get("followRole", "")).strip()
    if not role_name:
        return None
    role = ctx.roles.get(role_name)
    if role is None:
        fail(f"camera.followRole references unknown model role {role_name!r}.")
    raw_axes = camera_config.get("followAxes", ["x", "y"])
    if not isinstance(raw_axes, list) or not raw_axes:
        fail("camera.followAxes must be a non-empty array containing x, y, and/or z.")
    axes = {str(axis).lower() for axis in raw_axes}
    if not axes.issubset({"x", "y", "z"}):
        fail("camera.followAxes may contain only x, y, and z.")
    factor = as_float(camera_config.get("followFactor", 1.0), "camera.followFactor")
    if not 0.0 <= factor <= 1.0:
        fail("camera.followFactor must be between 0 and 1.")

    poster_frame = int(ctx.spec["posterFrame"])
    offsets: dict[int, Any] = {}
    try:
        ctx.scene.frame_set(poster_frame)
        reference = role.motion.location.copy()
        for frame in range(ctx.frame_start, ctx.frame_end + 1):
            ctx.scene.frame_set(frame)
            delta = (role.motion.location - reference) * factor
            offsets[frame] = Vector(
                (
                    delta.x if "x" in axes else 0.0,
                    delta.y if "y" in axes else 0.0,
                    delta.z if "z" in axes else 0.0,
                )
            )
    finally:
        ctx.scene.frame_set(poster_frame)
    log(
        f"Camera follows role {role_name!r} on {','.join(sorted(axes))} at {factor:.0%} "
        f"of authored root motion."
    )
    return offsets


def apply_camera_follow_offsets(obj: Any, offsets: Mapping[int, Any]) -> None:
    """Key world-space translations directly; parenting animated lights is unstable."""
    base_location = obj.location.copy()
    for frame, delta in offsets.items():
        obj.location = base_location + delta
        obj.keyframe_insert(data_path="location", frame=frame)
        set_interpolation(obj, frame, "LINEAR")


def create_render_camera(ctx: RenderContext) -> tuple[Any, Mapping[str, Any]]:
    """Create the final-view camera before source effects need billboard direction."""
    camera_config = ctx.spec.get("camera", {})
    if not isinstance(camera_config, Mapping):
        fail("camera must be an object.")
    location = vec3(camera_config.get("location", [7.5, -10.0, 6.5]), "camera.location")
    target = vec3(camera_config.get("target", [0, 0, 1.6]), "camera.target")
    camera_data = bpy.data.cameras.new("SC2 Alert Camera")
    camera = bpy.data.objects.new("SC2 Alert Camera", camera_data)
    ctx.scene.collection.objects.link(camera)
    camera.location = location
    camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_type = str(camera_config.get("type", "ORTHO")).upper()
    if camera_type not in {"ORTHO", "PERSP"}:
        fail(f"camera.type must be ORTHO or PERSP; received {camera_type!r}.")
    camera_data.type = camera_type
    camera_data.ortho_scale = as_float(camera_config.get("orthoScale", 7.0), "camera.orthoScale")
    camera_data.lens = as_float(camera_config.get("focalLength", 52.0), "camera.focalLength")
    camera_data.dof.use_dof = False
    ctx.scene.camera = camera
    return camera, camera_config


def setup_camera_and_lights(
    ctx: RenderContext,
    camera: Any | None = None,
    camera_config: Mapping[str, Any] | None = None,
) -> None:
    if camera is None or camera_config is None:
        camera, camera_config = create_render_camera(ctx)
    target = auto_frame_camera(ctx, camera, camera_config)

    original_frame = ctx.scene.frame_current
    follow_offsets = build_camera_follow_offsets(ctx, camera_config)

    primary = ctx.palette["primary"]
    secondary = ctx.palette["secondary"]
    warm = ctx.palette["warm"]
    center = Vector(target)
    lights = (
        add_area_light("SC2 Key", center + Vector((4.8, -4.5, 6.5)), center, primary, 1150.0, 5.0),
        add_area_light("SC2 Fill", center + Vector((-5.0, -2.0, 3.0)), center, secondary, 780.0, 4.0),
        add_area_light("SC2 Rim", center + Vector((1.0, 5.0, 6.0)), center, warm, 1450.0, 3.5),
    )
    if follow_offsets is not None:
        apply_camera_follow_offsets(camera, follow_offsets)
        for light in lights:
            apply_camera_follow_offsets(light, follow_offsets)
    ctx.scene.frame_set(original_frame)


def expand_camera_for_realized_effects(
    ctx: RenderContext,
    camera: Any,
    camera_config: Mapping[str, Any],
) -> None:
    """Grow only the orthographic field after effect bake; never rotate/retrack it."""

    if camera.data.type != "ORTHO":
        return
    sample_count = as_int(camera_config.get("sampleCount", 13), "camera.sampleCount")
    extents = sampled_camera_extents(
        ctx,
        camera,
        sample_count,
        include_effects=True,
        frames=None,
    )
    if extents is None:
        return
    aspect = max(0.01, ctx.scene.render.resolution_x / ctx.scene.render.resolution_y)
    x_extent, y_extent = extents
    occupancy = as_float(
        camera_config.get("realizedEffectOccupancy", 0.94),
        "camera.realizedEffectOccupancy",
    )
    if not 0.1 <= occupancy <= 1.0:
        fail("camera.realizedEffectOccupancy must be between 0.1 and 1.0.")
    margin = as_float(camera_config.get("margin", 1.02), "camera.margin")
    required = max(y_extent, x_extent / aspect) * margin / occupancy
    maximum_scale = as_float(camera_config.get("maxOrthoScale", 18.0), "camera.maxOrthoScale")
    old_scale = float(camera.data.ortho_scale)
    maximum_expansion = as_float(
        camera_config.get("maxRealizedEffectExpansion", 1.40),
        "camera.maxRealizedEffectExpansion",
    )
    if maximum_expansion < 1.0:
        fail("camera.maxRealizedEffectExpansion must be at least 1.0.")
    expansion_cap = min(maximum_scale, old_scale * maximum_expansion)
    camera.data.ortho_scale = max(old_scale, min(expansion_cap, required))
    if required > expansion_cap:
        log(
            f"Realized effects require ortho scale {required:.2f}; capped at "
            f"{camera.data.ortho_scale:.2f} ({maximum_expansion:.0%} of the unit/ribbon frame) so the "
            "unit remains alert-readable. Outer particles may intentionally exit the transparent canvas."
        )
    elif camera.data.ortho_scale > old_scale + 1.0e-4:
        log(
            f"Expanded orthographic scale {old_scale:.2f} -> {camera.data.ortho_scale:.2f} "
            "to contain source-realized effects without changing billboard camera direction."
        )


def write_inspection_report(
    ctx: RenderContext,
    models: Sequence[Mapping[str, Any]],
    resolver: TextureResolver,
    primary_texture_checks: Sequence[PrimaryTextureCheck],
    effect_class_checks: Sequence[EffectClassCheck],
    output_root: Path,
) -> Path:
    model_by_role = {str(model["role"]): model for model in models}
    report_models: list[dict[str, Any]] = []
    for role_name, role in ctx.roles.items():
        model = model_by_role[role_name]
        bitmap_rows: list[dict[str, Any]] = []
        if role.armature is not None:
            for layer in getattr(role.armature, "m3_materiallayers", ()):
                bitmap = str(getattr(layer, "color_bitmap", "")).strip()
                if not bitmap:
                    continue
                resolved = resolver.resolve(bitmap)
                log(
                    f"Inspection bitmap {ctx.spec['id']}/{role_name}/{getattr(layer, 'name', 'layer')}: "
                    f"{bitmap} -> {resolved if resolved else '(missing local export)'}"
                )
                bitmap_rows.append(
                    {
                        "layer": str(getattr(layer, "name", "")),
                        "bitmapPath": bitmap,
                        "resolvedPath": str(resolved) if resolved else None,
                        "channels": str(getattr(layer, "color_channels", "RGB")),
                        "uvSource": str(getattr(layer, "uv_source", "UV0")),
                    }
                )
        action_rows = [
            {
                "label": candidate.label,
                "group": candidate.group_name,
                "animation": candidate.animation_name,
                "action": str(candidate.action.name),
                "frameRange": [float(candidate.action.frame_range[0]), float(candidate.action.frame_range[1])],
            }
            for candidate in native_action_candidates(role)
        ]
        report_models.append(
            {
                "role": role_name,
                "modelPath": str(model["path"]),
                "animationPathsPresent": [str(path) for path in model.get("absoluteAnimationPaths", [])],
                "renderMeshes": [mesh.name for mesh in role.render_meshes],
                "nativeActions": action_rows,
                "bitmaps": bitmap_rows,
            }
        )
    report = {
        "schemaVersion": 1,
        "specId": str(ctx.spec["id"]),
        "deliveryBaseName": str(ctx.spec.get("deliveryBaseName", ctx.spec["id"])),
        "blenderVersion": str(bpy.app.version_string),
        "textureResolutionMode": "exact archive-relative path only (case-insensitive; no basename fallback)",
        "productionTextureGate": {
            "ready": all(check.ready for check in primary_texture_checks),
            "requirements": [
                {
                    "role": check.role,
                    "modelPath": check.model_path,
                    "bitmapPath": check.bitmap_path,
                    "expectedSlots": list(check.expected_slots),
                    "referencedSlots": list(check.referenced_slots),
                    "resolvedPath": str(check.resolved_path) if check.resolved_path else None,
                    "loadError": check.load_error,
                    "ready": check.ready,
                }
                for check in primary_texture_checks
            ],
        },
        "unsupportedEffectGate": {
            "ready": all(check.ready for check in effect_class_checks),
            "realizationRun": False,
            "note": (
                "Inspect mode records the raw imported M3 effect-class snapshot and deliberately does not run "
                "the particle/ribbon/displacement bakers. Render mode writes effect-realization.json with the "
                "post-realization unresolved counts. No procedural replacement unit is used."
            ),
            "classes": [
                {
                    "role": check.role,
                    "modelPath": check.model_path,
                    "effectClass": check.effect_class,
                    "count": check.count,
                    "ready": check.ready,
                }
                for check in effect_class_checks
            ],
        },
        "models": report_models,
    }
    report_dir = output_root.resolve() / str(ctx.spec["id"])
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "inspection.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    log(f"Wrote inspection report: {report_path}")
    return report_path


def write_effect_realization_report(
    ctx: RenderContext,
    output_root: Path,
    raw_checks: Sequence[EffectClassCheck],
    resolved_checks: Sequence[EffectClassCheck],
    effect_reports: Mapping[str, EffectRealizationReport],
    ribbon_session: RibbonRealization | None,
) -> Path:
    """Persist the source-to-Eevee fidelity ledger beside each local render."""

    raw_by_key = {
        (check.role, check.model_path, check.effect_class): check.count for check in raw_checks
    }
    ribbon_payload: dict[str, Any] | None = None
    if ribbon_session is not None:
        ribbon_payload = {
            "ready": all(row.status != "UNSUPPORTED" for row in ribbon_session.diagnostics),
            "realizedCount": ribbon_session.realized_count,
            "activeCount": ribbon_session.active_count,
            "missingTexturePaths": list(ribbon_session.missing_texture_paths),
            "diagnostics": [
                {
                    "status": row.status,
                    "role": row.role,
                    "ribbon": row.ribbon,
                    "bone": row.bone,
                    "ribbonType": row.ribbon_type,
                    "cullMethod": row.cull_method,
                    "material": row.material,
                    "materialType": row.material_type,
                    "textures": list(row.textures),
                    "missingTextures": list(row.missing_textures),
                    "activeFrames": row.active_frames,
                    "maximumPoints": row.maximum_points,
                    "warnings": list(row.warnings),
                }
                for row in ribbon_session.diagnostics
            ],
        }
    report = {
        "schemaVersion": 1,
        "specId": str(ctx.spec["id"]),
        "blenderVersion": str(bpy.app.version_string),
        "ready": all(check.ready for check in resolved_checks),
        "note": (
            "Counts are imported source items still unresolved after the exact-path particle, ribbon, and "
            "displacement passes. SCREENSPACE_DISPLACEMENT_PROXY is an explicit Eevee/WebM limitation, "
            "not a procedural replacement model."
        ),
        "effectGate": [
            {
                "role": check.role,
                "modelPath": check.model_path,
                "effectClass": check.effect_class,
                "importedCount": raw_by_key.get(
                    (check.role, check.model_path, check.effect_class), check.count
                ),
                "unresolvedCount": check.count,
                "ready": check.ready,
            }
            for check in resolved_checks
        ],
        "armatureEffects": {
            role: realization.as_dict() for role, realization in sorted(effect_reports.items())
        },
        "ribbonRealization": ribbon_payload,
    }
    report_dir = output_root.resolve() / str(ctx.spec["id"])
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / "effect-realization.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    log(f"Wrote effect realization report: {report_path}")
    return report_path


def render_outputs(ctx: RenderContext, output_root: Path, poster_only: bool, force: bool, keep_blend: bool) -> None:
    output_dir = output_root.resolve() / str(ctx.spec["id"])
    frames_dir = output_dir / "frames"
    poster_path = output_dir / "poster.png"
    blend_path = output_dir / "scene.blend"
    existing = poster_path.exists() or (frames_dir.exists() and any(frames_dir.glob("*.png")))
    if existing and not force:
        fail(
            f"Render output already exists under {output_dir}. Choose a new --output-root or pass --force "
            "to overwrite matching frame/poster names; the pipeline never deletes stale files."
        )
    frames_dir.mkdir(parents=True, exist_ok=True)
    ctx.scene.render.use_overwrite = bool(force)
    ctx.scene.render.filepath = str(frames_dir / "frame_")
    if not poster_only:
        log(f"Rendering PNG sequence {ctx.frame_start}..{ctx.frame_end} to {frames_dir}.")
        bpy.ops.render.render(animation=True)
    poster_frame = int(ctx.spec["posterFrame"])
    ctx.scene.frame_set(poster_frame)
    ctx.scene.render.filepath = str(poster_path)
    log(f"Rendering poster frame {poster_frame} to {poster_path}.")
    bpy.ops.render.render(write_still=True)
    if keep_blend:
        log(f"Saving inspection scene to {blend_path}.")
        bpy.ops.wm.save_as_mainfile(filepath=str(blend_path), check_existing=False)
    log(f"Completed {ctx.spec['id']!r}.")


def run(args: argparse.Namespace) -> None:
    if bpy is None or Vector is None or Euler is None:
        fail(
            "bpy is unavailable. Run this entrypoint through Blender's --python option; "
            "the system Python can only syntax-check it."
        )
    models_root = args.models_root.resolve()
    textures_root = (args.textures_root or args.models_root).resolve()
    if not textures_root.is_dir():
        fail(
            f"Textures root does not exist: {textures_root}. Pass --textures-root with the local Assets/Textures "
            "export tree, or omit it when textures live beneath --models-root."
        )
    spec = load_spec(args.manifest.resolve(), args.spec)
    models = validate_spec(spec, models_root)
    reset_blender()
    enable_m3_addon(args.addon_path, args.addon_module)
    scene = configure_scene(spec)
    roles = {str(model["role"]): import_model(model, spec) for model in models}
    # Some importers adopt source animation timing even when animation import is
    # disabled. Reassert the delivery contract after every model is present.
    scene.frame_start = int(spec["frameStart"])
    scene.frame_end = int(spec["frameEnd"])
    scene.render.fps = 24
    scene.render.fps_base = 1.0
    raw_palette = spec.get("palette", {})
    if not isinstance(raw_palette, Mapping):
        fail("palette must be an object.")
    palette = {
        "primary": hex_color(raw_palette.get("primary", "#62D9FF"), "palette.primary"),
        "secondary": hex_color(raw_palette.get("secondary", "#B084FF"), "palette.secondary"),
        "warm": hex_color(raw_palette.get("warm", "#FFD166"), "palette.warm"),
    }
    context = RenderContext(
        scene=scene,
        spec=spec,
        roles=roles,
        frame_start=int(spec["frameStart"]),
        frame_end=int(spec["frameEnd"]),
        palette=palette,
    )
    CHOREOGRAPHIES[str(spec["choreography"])](context)
    apply_native_actions(context)
    resolver = TextureResolver(textures_root)
    primary_texture_checks = assess_primary_texture_gate(context, models, resolver)
    raw_effect_class_checks = assess_unsupported_effect_gate(context, models)
    if not args.inspect_only:
        if args.allow_untextured_preview:
            blocked = sum(not check.ready for check in primary_texture_checks)
            log(
                f"WARNING: diagnostic preview bypass enabled for {spec['id']}; {blocked} primary texture "
                "requirement(s) are blocked. This output is not production/package eligible."
            )
        else:
            enforce_primary_texture_gate(context, resolver, primary_texture_checks)
    for role in roles.values():
        reconstruct_role_materials(role, resolver, spec)
    if args.inspect_only:
        write_inspection_report(
            context,
            models,
            resolver,
            primary_texture_checks,
            raw_effect_class_checks,
            args.output_root,
        )
        return

    camera, camera_config = create_render_camera(context)
    ribbon_session: RibbonRealization | None = None
    effect_reports: dict[str, EffectRealizationReport] = {}
    try:
        if any(
            check.effect_class == "ribbons" and check.count > 0
            for check in raw_effect_class_checks
        ):
            materials = spec.get("materials", {})
            if not isinstance(materials, Mapping):
                fail("materials must be an object.")
            team_color = hex_color(materials.get("teamColor", "#278BFF"), "materials.teamColor")
            try:
                ribbon_session = realize_m3_ribbons(
                    context.roles,
                    scene=context.scene,
                    textures_root=textures_root,
                    frame_start=context.frame_start,
                    frame_end=context.frame_end,
                    strict_textures=not args.allow_untextured_preview,
                    unsupported_policy="skip",
                    team_color=team_color,
                    log=log,
                )
            except RibbonRealizationError as exc:
                fail(f"M3 ribbon realization failed for {spec['id']}: {exc}")

        # Particle billboard/tail quaternions are baked from the evaluated final
        # camera matrix.  Finish auto-frame and follow keys before realizing
        # them; afterward we may only widen ortho_scale, never retrack/rotate.
        setup_camera_and_lights(context, camera, camera_config)
        effect_reports = realize_source_effects(
            context,
            textures_root,
            camera,
            raw_effect_class_checks,
            strict_textures=not args.allow_untextured_preview,
        )
        effect_class_checks = remap_realized_effect_checks(
            raw_effect_class_checks,
            effect_reports,
            ribbon_session,
        )
        write_effect_realization_report(
            context,
            args.output_root,
            raw_effect_class_checks,
            effect_class_checks,
            effect_reports,
            ribbon_session,
        )
        if args.allow_unsupported_effects:
            blocked_effects = sum(not check.ready for check in effect_class_checks)
            log(
                f"WARNING: unsupported-effect bypass enabled for {spec['id']}; {blocked_effects} effect "
                "class(es) remain blocked after source realization. This output is calibration-only and "
                "not package eligible."
            )
        else:
            enforce_unsupported_effect_gate(context, effect_class_checks)

        if effect_reports:
            expand_camera_for_realized_effects(context, camera, camera_config)
        if ribbon_session is not None:
            ribbon_session.update(context.scene)
        render_outputs(context, args.output_root, args.poster_only, args.force, args.keep_blend)
    finally:
        if ribbon_session is not None:
            ribbon_session.dispose()


def main() -> int:
    args: argparse.Namespace | None = None
    try:
        args = parse_args()
        run(args)
        return 0
    except PipelineError as exc:
        print(f"{PIPELINE_PREFIX} ERROR: {exc}", file=sys.stderr, flush=True)
        return 2
    except Exception as exc:  # pragma: no cover - Blender runtime diagnostics
        print(f"{PIPELINE_PREFIX} UNEXPECTED ERROR: {exc}", file=sys.stderr, flush=True)
        if args is not None and args.debug:
            traceback.print_exc()
        else:
            print(f"{PIPELINE_PREFIX} Re-run with --debug for a Python traceback.", file=sys.stderr, flush=True)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
