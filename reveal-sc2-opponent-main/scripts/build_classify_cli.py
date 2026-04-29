"""Build-classify CLI (Stage 7.4) used by the SPA reclassify endpoint.

Implements the v2 scoring algorithm from the master roadmap:

  for a game's event list E and a build B with signature S:
    matched = 0
    for each (sig_t, sig_what, sig_weight) in S:
      candidates = [e in E where e.what == sig_what
                                 and |e.t - sig_t| <= B.tolerance_sec]
      if candidates: matched += sig_weight
    total_weight = sum(s.weight for s in S)
    match_score = matched / total_weight
    if match_score >= B.min_match_score: B is a candidate
  return argmax(match_score)

The CLI reads a single game's events from JSON on stdin or
``--events-file`` and emits one JSON line on stdout describing the
best candidate plus the full ranked list for diagnostics.

Subcommands
-----------

    classify [--events-file PATH] [--race STR] [--vs-race STR]
        Score the supplied event list against the merged build
        table (built-ins + custom_builds.json + community cache)
        and emit::

          {
            "ok": true,
            "best": {"id": "...", "name": "...", "score": 0.83,
                      "tier": "A", "source": "custom"} | null,
            "candidates": [...],
            "scanned": <int>
          }

Input shape (JSON)::

    {"events": [{"t": 18, "what": "BuildPylon"},
                {"t": 95, "what": "BuildStargate"}]}

Race / vs-race filters are optional; when provided we only score
builds whose ``race`` and ``vs_race`` match (with ``Any`` matching
anything). When omitted the entire merged table is scored.

Run::

    python reveal-sc2-opponent-main/scripts/build_classify_cli.py classify \\
        --events-file events.json --race Protoss --vs-race Zerg
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

# Add reveal-sc2-opponent-main/ to sys.path so `core.build_definitions`
# imports cleanly. Mirrors the pattern in buildorder_cli.py.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# We load core.build_definitions DIRECTLY via importlib to avoid
# triggering core/__init__.py, which eagerly imports modules that
# require the optional `sc2reader` dependency. The classifier only
# needs build_definitions + its lazy import of custom_builds.
import importlib.util  # noqa: E402


def _load_module_direct(mod_name: str, file_name: str):
    """Load a single core module without firing core/__init__.py."""
    file_path = os.path.join(_ROOT, 'core', file_name)
    spec = importlib.util.spec_from_file_location(mod_name, file_path)
    if spec is None or spec.loader is None:
        raise ImportError('cannot load ' + file_name)
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return module


# Order matters: build_definitions imports core.custom_builds lazily,
# but its `from .custom_builds import ...` syntax requires the
# `core` package to be importable. We register a minimal `core`
# placeholder + the two real modules under their dotted names.
if 'core' not in sys.modules:
    import types as _types
    _core_stub = _types.ModuleType('core')
    _core_stub.__path__ = [os.path.join(_ROOT, 'core')]
    sys.modules['core'] = _core_stub
_load_module_direct('core.atomic_io', 'atomic_io.py')
_load_module_direct('core.paths', 'paths.py')
_load_module_direct('core.custom_builds', 'custom_builds.py')
_bd = _load_module_direct('core.build_definitions', 'build_definitions.py')
get_active_build_definitions = _bd.get_active_build_definitions

DEFAULT_TOLERANCE_SEC = 15
DEFAULT_MIN_MATCH_SCORE = 0.6


def _emit(obj: Dict[str, Any]) -> None:
    """Write one JSON line to stdout and flush.

    Example:
        >>> _emit({"ok": True})  # doctest: +SKIP
    """
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _eprint(msg: str) -> None:
    """Print to stderr."""
    print(msg, file=sys.stderr, flush=True)


def _read_events(events_file: Optional[str]) -> List[Dict[str, Any]]:
    """Read ``{t, what}`` events from a file path or stdin.

    Args:
        events_file: Path to a JSON file containing ``{"events": [...]}``,
            or ``None`` to read from stdin.

    Returns:
        List of ``{t, what}`` dicts. Empty when the input is missing
        or malformed (the CLI emits a typed error in that case and
        the caller treats it as "no match").
    """
    src = sys.stdin.read() if events_file is None else _read_text(events_file)
    if not src or not src.strip():
        return []
    try:
        payload = json.loads(src)
    except json.JSONDecodeError:
        return []
    events = payload.get("events") if isinstance(payload, dict) else payload
    if not isinstance(events, list):
        return []
    out: List[Dict[str, Any]] = []
    for entry in events:
        if not isinstance(entry, dict):
            continue
        if not isinstance(entry.get("t"), (int, float)):
            continue
        if not isinstance(entry.get("what"), str):
            continue
        out.append({"t": int(entry["t"]), "what": entry["what"]})
    return out


def _read_text(path: str) -> str:
    """Read a UTF-8 file; empty string on error.

    Example:
        >>> _read_text('/nope')
        ''
    """
    if not os.path.exists(path):
        return ""
    try:
        with open(path, "r", encoding="utf-8-sig") as src:
            return src.read()
    except OSError:
        return ""


def _filter_by_matchup(
    defs: Dict[str, Dict[str, Any]],
    race: Optional[str],
    vs_race: Optional[str],
) -> Dict[str, Dict[str, Any]]:
    """Restrict the merged definitions to a matchup.

    A build's ``race`` / ``vs_race`` of ``"Any"`` matches anything.
    Empty filters leave the table untouched.

    Example:
        >>> _filter_by_matchup({}, None, None)
        {}
    """
    if race is None and vs_race is None:
        return defs
    out: Dict[str, Dict[str, Any]] = {}
    for key, meta in defs.items():
        if not _matchup_ok(meta, race, vs_race):
            continue
        out[key] = meta
    return out


def _matchup_ok(
    meta: Dict[str, Any], race: Optional[str], vs_race: Optional[str]
) -> bool:
    """Test a single build entry against the matchup filter.

    Example:
        >>> _matchup_ok({"race": "Protoss", "vs_race": "Zerg"},
        ...             "Protoss", "Zerg")
        True
        >>> _matchup_ok({"race": "Protoss", "vs_race": "Any"},
        ...             "Protoss", "Zerg")
        True
    """
    if race is not None:
        meta_race = meta.get("race")
        if meta_race not in ("Any", race):
            return False
    if vs_race is not None:
        meta_vs = meta.get("vs_race")
        if meta_vs not in ("Any", vs_race):
            return False
    return True


def _score_build(
    events: List[Dict[str, Any]], meta: Dict[str, Any]
) -> float:
    """Compute the normalised score (0..1) for one build.

    Returns 0.0 when the build has an empty signature or zero
    total weight -- those are valid stub entries that should
    never be the best candidate.
    """
    signature = meta.get("signature") or []
    if not signature:
        return 0.0
    tol = int(meta.get("tolerance_sec") or DEFAULT_TOLERANCE_SEC)
    total = 0.0
    matched = 0.0
    for sig in signature:
        weight = float(sig.get("weight") or 0.0)
        total += weight
        if _signature_event_matches(events, sig, tol):
            matched += weight
    if total <= 0:
        return 0.0
    return matched / total


def _signature_event_matches(
    events: List[Dict[str, Any]], sig: Dict[str, Any], tol: int
) -> bool:
    """Return True iff at least one event matches the signature item.

    Example:
        >>> _signature_event_matches(
        ...     [{"t": 90, "what": "BuildStargate"}],
        ...     {"t": 95, "what": "BuildStargate", "weight": 1}, 15)
        True
    """
    sig_what = sig.get("what")
    sig_t = sig.get("t")
    if not isinstance(sig_what, str) or not isinstance(sig_t, int):
        return False
    for ev in events:
        if ev.get("what") != sig_what:
            continue
        if abs(int(ev.get("t", 0)) - sig_t) <= tol:
            return True
    return False


def _classify(
    events: List[Dict[str, Any]],
    race: Optional[str],
    vs_race: Optional[str],
) -> Dict[str, Any]:
    """Classify a single game; return the structured result payload.

    Example:
        >>> out = _classify([], None, None)
        >>> out["ok"]
        True
    """
    defs = _filter_by_matchup(get_active_build_definitions(), race, vs_race)
    candidates = []
    for key, meta in defs.items():
        score = _score_build(events, meta)
        threshold = float(meta.get("min_match_score") or DEFAULT_MIN_MATCH_SCORE)
        if score < threshold:
            continue
        candidates.append({
            "id": meta.get("id", key),
            "name": key,
            "score": round(score, 4),
            "tier": meta.get("tier"),
            "source": meta.get("source", "builtin"),
        })
    candidates.sort(key=lambda c: c["score"], reverse=True)
    best = candidates[0] if candidates else None
    return {
        "ok": True,
        "best": best,
        "candidates": candidates,
        "scanned": len(defs),
    }


def _build_parser() -> argparse.ArgumentParser:
    """Build the argparse CLI."""
    parser = argparse.ArgumentParser(
        description="Classify a game's events against the merged build table.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_classify = sub.add_parser("classify", help="Score events vs builds.")
    p_classify.add_argument("--events-file", default=None)
    p_classify.add_argument("--race", default=None)
    p_classify.add_argument("--vs-race", default=None)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    """CLI entry point. Returns the process exit code."""
    args = _build_parser().parse_args(argv)
    if args.cmd != "classify":
        _emit({"ok": False, "error": "unknown_command"})
        return 2
    try:
        events = _read_events(args.events_file)
        result = _classify(events, args.race, args.vs_race)
        _emit(result)
        return 0
    except (OSError, ValueError, TypeError) as exc:
        _emit({"ok": False, "error": "classify_failed", "detail": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
