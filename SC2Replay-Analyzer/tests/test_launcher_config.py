"""Tests for ``launcher_config`` -- the pure-function config shaper.

Stage 3.x: covers the helpers that read ``data/config.json`` and build
the PowerShell argv. The spawn side of ``SC2ReplayAnalyzer.py`` is
exercised by the smoke entry point under ``__main__`` (manual run,
documented in PR), not here -- subprocess.Popen calls aren''t worth
mocking when the argv shape is tested independently.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict

import pytest  # type: ignore[import-not-found]

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import launcher_config as lc  # noqa: E402


# ---------------------------------------------------------------------
# load_config
# ---------------------------------------------------------------------

def test_load_config_returns_empty_for_missing_file(tmp_path: Path) -> None:
    assert lc.load_config(tmp_path / "no.json") == {}


def test_load_config_returns_empty_for_invalid_json(tmp_path: Path) -> None:
    bad = tmp_path / "bad.json"
    bad.write_text("{not valid")
    assert lc.load_config(bad) == {}


def test_load_config_returns_empty_for_non_object_root(tmp_path: Path) -> None:
    arr = tmp_path / "arr.json"
    arr.write_text("[1, 2, 3]")
    assert lc.load_config(arr) == {}


def test_load_config_parses_valid_object(tmp_path: Path) -> None:
    p = tmp_path / "ok.json"
    p.write_text(json.dumps({"version": 1, "identities": []}))
    assert lc.load_config(p) == {"version": 1, "identities": []}


# ---------------------------------------------------------------------
# read_pulse_args
# ---------------------------------------------------------------------

def _ident(**kw: Any) -> Dict[str, Any]:
    base = {"name": "Foo", "pulse_id": "1", "region": "us"}
    base.update(kw)
    return base


def test_read_pulse_args_empty_config_yields_defaults() -> None:
    out = lc.read_pulse_args({})
    assert out["character_ids"] == []
    assert out["player_name"] is None
    assert out["regions"] == lc.DEFAULT_REGIONS


def test_read_pulse_args_dedupes_and_orders_pulse_ids() -> None:
    cfg = {"identities": [
        _ident(pulse_id="1", region="us"),
        _ident(pulse_id="2", region="eu"),
        _ident(pulse_id="1", region="kr"),  # duplicate
    ]}
    assert lc.read_pulse_args(cfg)["character_ids"] == ["1", "2"]


def test_read_pulse_args_unions_stream_overlay_ids() -> None:
    cfg = {
        "identities": [_ident(pulse_id="1")],
        "stream_overlay": {"pulse_character_ids": ["2", "1", "3"]},
    }
    # identities first, stream-overlay extras appended in order, deduped.
    assert lc.read_pulse_args(cfg)["character_ids"] == ["1", "2", "3"]


def test_read_pulse_args_drops_invalid_regions_keeps_default() -> None:
    cfg = {"identities": [
        _ident(region="us"),
        _ident(region="bogus"),  # not in VALID_REGIONS
        _ident(region="EU"),     # uppercase; lowercased + accepted
    ]}
    assert lc.read_pulse_args(cfg)["regions"] == ["us", "eu"]


def test_read_pulse_args_falls_back_to_default_regions_when_all_invalid() -> None:
    cfg = {"identities": [_ident(region="bogus")]}
    assert lc.read_pulse_args(cfg)["regions"] == lc.DEFAULT_REGIONS


def test_read_pulse_args_picks_first_nonempty_player_name() -> None:
    cfg = {"identities": [
        _ident(name="", pulse_id="1"),
        _ident(name="  ", pulse_id="2"),
        _ident(name="ReSpOnSe", pulse_id="3"),
    ]}
    assert lc.read_pulse_args(cfg)["player_name"] == "ReSpOnSe"


def test_read_pulse_args_tolerates_non_dict_identity_entries() -> None:
    cfg = {"identities": [None, "string", 42, _ident(pulse_id="9")]}
    assert lc.read_pulse_args(cfg)["character_ids"] == ["9"]


# ---------------------------------------------------------------------
# read_runtime_flags
# ---------------------------------------------------------------------

def test_runtime_flags_default_when_no_runtime_section() -> None:
    cfg = {"identities": [_ident()]}  # has identity -> poller enabled
    flags = lc.read_runtime_flags(cfg)
    assert flags == {"spawn_watcher": True, "spawn_poller": True}


def test_runtime_flags_poller_disabled_when_no_identity() -> None:
    flags = lc.read_runtime_flags({})
    assert flags["spawn_watcher"] is True
    assert flags["spawn_poller"] is False  # auto-False without identity


def test_runtime_flags_respect_explicit_false() -> None:
    cfg = {
        "identities": [_ident()],
        "runtime": {"spawn_watcher": False, "spawn_poller": False},
    }
    assert lc.read_runtime_flags(cfg) == {
        "spawn_watcher": False, "spawn_poller": False,
    }


def test_runtime_flags_player_name_alone_enables_poller() -> None:
    cfg = {"identities": [_ident(pulse_id="", name="ReSpOnSe")]}
    flags = lc.read_runtime_flags(cfg)
    assert flags["spawn_poller"] is True


# ---------------------------------------------------------------------
# build_poller_argv
# ---------------------------------------------------------------------

_PS = "/usr/bin/powershell"
_SCRIPT = Path("/tmp/Reveal-Sc2Opponent.ps1")


def test_build_poller_argv_returns_none_when_no_identity() -> None:
    pulse = {"character_ids": [], "player_name": None, "regions": ["us"]}
    assert lc.build_poller_argv(_PS, pulse, _SCRIPT) is None


def test_build_poller_argv_uses_character_id_when_present() -> None:
    pulse = {"character_ids": ["1", "2"], "player_name": "Foo",
             "regions": ["us", "eu"]}
    argv = lc.build_poller_argv(_PS, pulse, _SCRIPT)
    assert argv is not None
    assert "-CharacterId" in argv
    assert argv[argv.index("-CharacterId") + 1] == "1,2"
    # PlayerName is now passed alongside -CharacterId so the PS1 can
    # build its "who's me?" identity regex from the configured handle
    # (previously the regex was hardcoded to "ReSpOnSe").
    assert "-PlayerName" in argv
    assert argv[argv.index("-PlayerName") + 1] == "Foo"


def test_build_poller_argv_skips_player_name_when_absent() -> None:
    pulse = {"character_ids": ["1", "2"], "player_name": None,
             "regions": ["us"]}
    argv = lc.build_poller_argv(_PS, pulse, _SCRIPT)
    assert argv is not None
    assert "-CharacterId" in argv
    assert "-PlayerName" not in argv


def test_build_poller_argv_falls_back_to_player_name() -> None:
    pulse = {"character_ids": [], "player_name": "Foo", "regions": ["us"]}
    argv = lc.build_poller_argv(_PS, pulse, _SCRIPT)
    assert argv is not None
    assert "-PlayerName" in argv
    assert argv[argv.index("-PlayerName") + 1] == "Foo"
    assert "-CharacterId" not in argv


def test_build_poller_argv_includes_active_region_csv() -> None:
    pulse = {"character_ids": ["1"], "player_name": None,
             "regions": ["us", "eu", "kr"]}
    argv = lc.build_poller_argv(_PS, pulse, _SCRIPT)
    assert argv is not None
    assert "-ActiveRegion" in argv
    assert argv[argv.index("-ActiveRegion") + 1] == "us,eu,kr"


def test_build_poller_argv_uses_custom_opponent_filename() -> None:
    pulse = {"character_ids": ["1"], "player_name": None, "regions": ["us"]}
    argv = lc.build_poller_argv(_PS, pulse, _SCRIPT,
                                opponent_file="opp.txt")
    assert argv is not None
    assert argv[argv.index("-FilePath") + 1] == "opp.txt"


def test_build_poller_argv_starts_with_ps_exe_and_static_flags() -> None:
    pulse = {"character_ids": ["1"], "player_name": None, "regions": ["us"]}
    argv = lc.build_poller_argv(_PS, pulse, _SCRIPT)
    assert argv is not None
    assert argv[0] == _PS
    assert argv[1:5] == ["-NoExit", "-ExecutionPolicy", "Bypass", "-File"]
    assert "-DisableQuickEdit" in argv
    assert "-Limit" in argv and argv[argv.index("-Limit") + 1] == "1"
