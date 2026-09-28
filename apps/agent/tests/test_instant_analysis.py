"""Tests for ``sc2tools_agent.instant_analysis`` (Instant Analysis engine).

Parity is the point of this module: for every committed replay fixture and
every human perspective, the browser entry point must produce the same
upload payload as the desktop agent, differing only in the documented
``RUNTIME_ONLY_FIELDS``. Those comparisons run ``instant_golden.py`` in fresh
interpreters (one per engine data view, concurrently) because:

* the data view (custom builds file, map bounds table) must be pinned before
  the engine is imported, and
* other agent test modules stub ``sys.modules`` entries; a subprocess cannot
  inherit that pollution (same pattern as
  ``apps/replay-engine/tests/test_warpgate_adept_tracking.py``).

The remaining tests are cheap and run in-process against real fixtures.
Tests marked MOCK (docs/engineeringexplanation.md: mocks must be labelled)
replace the pipeline call only where no fixture exercises the branch
(resumed replays, A.I. games, budget overruns, crashes).
"""

from __future__ import annotations

import base64
import hashlib
import inspect
import io
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace
from typing import Any, Dict, Iterator, List, Tuple

import pytest

HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

pytest.importorskip("sc2reader")

from sc2tools_agent import instant_analysis as ia  # noqa: E402
from sc2tools_agent import instant_intake  # noqa: E402
from sc2tools_agent import replay_pipeline  # noqa: E402

FIXTURE_DIR = HERE.parent / "replay-engine" / "tests" / "fixtures" / "replays"
GOLDEN_SCRIPT = Path(__file__).with_name("instant_golden.py")
WARPGATE = FIXTURE_DIR / "warpgate_adept_tracking.SC2Replay"
TEAM_FIXTURE = FIXTURE_DIR / "ladder_2v2_crimson_research_lab.SC2Replay"
RESPONSE_TOON = "1-S2-1-267727"
SQUIRTUOZ_TOON = "1-S2-1-5079063"
DATA_VIEWS = ("installed", "source")
SUBPROCESS_TIMEOUT_SEC = 900
LOG_TAIL_CHARS = 4000
TRUNCATED_BYTES = 1024
MPQ_USER_DATA_MAGIC = b"MPQ\x1b"
SANDBOX_ENV_VARS = ("SC2TOOLS_OBSERVATION_DIR", "SC2TOOLS_PLAYER_HANDLE", "SC2TOOLS_PLAYER_CONFIG")
# Loggers that see the staged replay path during a sandbox parse.
ENGINE_LOGGERS = ("sc2tools_agent.replay_pipeline", "sc2tools_agent.instant_analysis", "sc2reader")
DOTTED_PATH_RE = re.compile(r"^[A-Za-z_]+(\.[A-Za-z_]+)*$")
# The ONLY paths the parity run may see differ. Its desktop call uses
# resolve_pulse=True against a stubbed resolver; no fixture has an engine
# observation artifact and no upload queue runs, so every other
# RUNTIME_ONLY_FIELDS entry must still be byte-equal here.
EXPECTED_DESKTOP_DIFF_PATHS = ["opponent.pulseCharacterId", "opponent.pulseLookupAttempted"]
# Section markers of the ErrorKind union in apps/web/lib/instant/types.ts.
TS_PYTHON_KINDS_START = "emitted by the Python engine"
TS_PYTHON_KINDS_END = "emitted by the client"
TS_STRING_LITERAL_RE = re.compile(r'"([a-z_]+)"')


def _fixtures() -> List[Path]:
    return sorted(p for p in FIXTURE_DIR.iterdir() if p.suffix.lower() == ".sc2replay")


def _sc2reader_human_toons(fixture: Path) -> List[str]:
    """Human perspectives read straight from sc2reader (not via parse_live).

    Independent of ``list_replay_players``, which the golden CLI itself uses
    to enumerate cases, so a player dropped there cannot go unnoticed.
    """
    import sc2reader  # type: ignore

    replay = sc2reader.load_replay(str(fixture), load_level=2)
    return sorted(str(player.toon_handle) for player in replay.players if player.is_human)


def _clean_env() -> Dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in SANDBOX_ENV_VARS
        and not key.startswith("SC2TOOLS_PULSE")
        and key != "SC2T_CUSTOM_BUILDS_FILE"
    }
    env.update({"PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8"})
    return env


def _golden_command(view: str, out: Path, report: Path) -> List[str]:
    command = [
        sys.executable, str(GOLDEN_SCRIPT), "--out", str(out),
        "--data-view", view, "--parity-report", str(report),
    ]
    if view == "installed":
        command.append("--path-variants")
    return command


@pytest.fixture(scope="module")
def parity_runs(tmp_path_factory: pytest.TempPathFactory) -> Dict[str, Dict[str, Any]]:
    """Run instant_golden.py for both data views concurrently (real parses).

    Output goes to log files, not pipes, so neither child can block on a
    full pipe buffer while the other is being waited on.
    """
    base = tmp_path_factory.mktemp("instant-parity")
    running: Dict[str, Tuple[subprocess.Popen, Path]] = {}
    try:
        for view in DATA_VIEWS:
            log_path = base / f"{view}.log"
            with open(log_path, "wb") as log_file:
                running[view] = (subprocess.Popen(
                    _golden_command(view, base / view, base / f"{view}-parity.json"),
                    env=_clean_env(), stdout=log_file, stderr=subprocess.STDOUT,
                ), log_path)
        runs: Dict[str, Dict[str, Any]] = {}
        for view, (proc, log_path) in running.items():
            returncode = proc.wait(timeout=SUBPROCESS_TIMEOUT_SEC)
            output = log_path.read_text(encoding="utf-8", errors="replace")
            assert returncode == 0, output[-LOG_TAIL_CHARS:]
            report = json.loads((base / f"{view}-parity.json").read_text(encoding="utf-8"))
            runs[view] = {"report": report, "goldenDir": base / view, "output": output}
        return runs
    finally:
        for proc, _log_path in running.values():
            if proc.poll() is None:
                proc.kill()


def _is_runtime_only(path: str) -> bool:
    return any(path == field or path.startswith(field + ".") for field in ia.RUNTIME_ONLY_FIELDS)


def _agent_parity_problems(case: Dict[str, Any], stub_pulse_id: str) -> List[str]:
    key = case["key"]
    if not case["browserOk"]:
        return [f"{key}: browser failed with {case['browserErrorKind']}"]
    problems: List[str] = []
    if case["agentReason"] is not None:
        problems.append(f"{key}: desktop agent skipped the replay ({case['agentReason']})")
    if case["browserGameId"] != case["agentGameId"]:
        problems.append(f"{key}: gameId {case['browserGameId']!r} != agent {case['agentGameId']!r}")
    # Exact, not "anything on the allowlist": the allowlist also names
    # fields only a local engine artifact or the upload queue can change,
    # and neither exists here, so a diff there would be a parity bug.
    if sorted(case["agentDiffPaths"]) != EXPECTED_DESKTOP_DIFF_PATHS:
        problems.append(f"{key}: desktop-only diffs {case['agentDiffPaths']} != {EXPECTED_DESKTOP_DIFF_PATHS}")
    # Non-vacuous: the desktop call really ran the (stubbed) Pulse lookup.
    if case["agentPulseCharacterId"] != stub_pulse_id:
        problems.append(f"{key}: desktop pulseCharacterId {case['agentPulseCharacterId']!r} is not the stub's")
    return problems


# ---------------------------------------------------------------------------
# 1) Desktop parity: every fixture x every human perspective x both views
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("view", DATA_VIEWS)
def test_parse_replay_bytes_every_fixture_perspective_matches_desktop_agent(
    parity_runs: Dict[str, Dict[str, Any]], view: str,
) -> None:
    report = parity_runs[view]["report"]
    cases = report["cases"]
    covered: Dict[str, List[str]] = {}
    for case in cases:
        covered.setdefault(case["fixture"], []).append(case["toon"])
    expected = {fixture.name: _sc2reader_human_toons(fixture) for fixture in _fixtures()}
    assert {name: sorted(toons) for name, toons in covered.items()} == expected
    stub_pulse_id = report["pulseStubCharacterId"]
    problems = [problem for case in cases for problem in _agent_parity_problems(case, stub_pulse_id)]
    assert not problems, "\n".join(problems)


@pytest.mark.parametrize("view", DATA_VIEWS)
def test_parse_replay_for_cloud_ex_sandbox_flags_is_byte_identical_to_browser(
    parity_runs: Dict[str, Dict[str, Any]], view: str,
) -> None:
    for case in parity_runs[view]["report"]["cases"]:
        assert case["agentPlainReason"] is None, case["key"]
        assert case["agentPlainDiffPaths"] == [], case["key"]
        assert case["agentPlainJsonSha256"] == case["browserJsonSha256"], case["key"]


def test_parse_replay_bytes_data_views_share_game_ids(
    parity_runs: Dict[str, Dict[str, Any]],
) -> None:
    ids = {
        view: {case["key"]: case["browserGameId"] for case in parity_runs[view]["report"]["cases"]}
        for view in DATA_VIEWS
    }
    assert ids["installed"] == ids["source"]
    # gameId embeds the opponent's name, so it depends on the perspective.
    assert ids["installed"][f"warpgate_adept_tracking__{RESPONSE_TOON}"] == (
        "2026-05-08T19:08:12|Squirtuoz|Tourmaline LE|470"
    )
    assert ids["installed"][f"warpgate_adept_tracking__{SQUIRTUOZ_TOON}"] == (
        "2026-05-08T19:08:12|ReSpOnSe|Tourmaline LE|470"
    )


def _golden_summary(golden_dir: Path, entry: Dict[str, Any]) -> Dict[str, Any]:
    """Reduce one golden file to the facts the index promises about it."""
    golden = json.loads((golden_dir / entry["file"]).read_text(encoding="utf-8"))
    envelope = golden["envelope"]
    return {
        "hasPayload": "payload" in envelope,
        "runtime": golden["runtime"],
        "names": (golden["fixture"], golden["filename"]),
        "jsonSha256": hashlib.sha256(envelope["json"].encode("ascii")).hexdigest(),
        "jsonGameId": json.loads(envelope["json"])["gameId"],
        "gameId": envelope["gameId"],
    }


@pytest.mark.parametrize("view", DATA_VIEWS)
def test_instant_golden_cli_writes_one_golden_per_case(
    parity_runs: Dict[str, Dict[str, Any]], view: str,
) -> None:
    golden_dir: Path = parity_runs[view]["goldenDir"]
    index = json.loads((golden_dir / "index.json").read_text(encoding="utf-8"))
    report_keys = [case["key"] for case in parity_runs[view]["report"]["cases"]]
    assert (index["dataView"], index["engineProtocol"]) == (view, ia.ENGINE_PROTOCOL)
    assert [entry["file"] for entry in index["cases"]] == [f"{key}.json" for key in report_keys]
    for entry in index["cases"]:
        assert _golden_summary(golden_dir, entry) == {
            "hasPayload": False,
            "runtime": {"player_toon": entry["toon"]},
            "names": (entry["fixture"], entry["fixture"]),
            "jsonSha256": entry["jsonSha256"],
            "jsonGameId": entry["gameId"],
            "gameId": entry["gameId"],
        }
    assert "median_ms=" in parity_runs[view]["output"]


# ---------------------------------------------------------------------------
# 2) gameId / payload independence from names, folders and mtimes
# ---------------------------------------------------------------------------
def test_parse_replay_bytes_filename_folder_and_mtime_variants_yield_identical_json(
    parity_runs: Dict[str, Dict[str, Any]],
) -> None:
    full_variant_fixtures = set()
    for case in parity_runs["installed"]["report"]["cases"]:
        variants = case["pathVariants"]
        if "renamedNested" in variants:
            full_variant_fixtures.add(case["fixture"])
        for label, digest in variants.items():
            assert digest == case["browserJsonSha256"], f"{case['key']} {label}"
    assert full_variant_fixtures == {fixture.name for fixture in _fixtures()}


def test_parse_replay_bytes_toon_folder_without_selector_matches_explicit_toon(
    parity_runs: Dict[str, Dict[str, Any]],
) -> None:
    for case in parity_runs["installed"]["report"]["cases"]:
        assert case["pathVariants"]["toonFolder"] == case["browserJsonSha256"], case["key"]


def test_parse_replay_bytes_flat_name_without_selector_returns_player_unresolved() -> None:
    result = ia.parse_replay_bytes(WARPGATE.read_bytes(), filename="x.SC2Replay")
    assert result["ok"] is False
    assert result["errorKind"] == result["reason"] == "player_unresolved"


# ---------------------------------------------------------------------------
# 3) Errors, players, digests, zip intake
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("blob", [b"", b"hello world, not a replay", b"PK\x03\x04zip"])
def test_parse_replay_bytes_non_mpq_bytes_returns_not_a_replay(blob: bytes) -> None:
    result = ia.parse_replay_bytes(blob, filename="x.SC2Replay")
    assert result == {
        "ok": False, "reason": "not_a_replay", "errorKind": "not_a_replay",
        "detail": result["detail"],
    }


@pytest.mark.parametrize(
    "blob",
    [
        WARPGATE.read_bytes()[:TRUNCATED_BYTES],
        MPQ_USER_DATA_MAGIC + b"not really a replay archive " * 64,
        MPQ_USER_DATA_MAGIC + bytes(100),
    ],
    ids=["first-1KiB", "mpq-header-garbage", "mpq-header-zeros"],
)
def test_parse_replay_bytes_damaged_mpq_returns_corrupt_file(blob: bytes) -> None:
    result = ia.parse_replay_bytes(blob, filename="C:\\Users\\secret\\x.SC2Replay")
    assert result["ok"] is False
    assert result["reason"] == "parse_failed"
    assert result["errorKind"] == "corrupt_file"
    assert "secret" not in result["detail"] and "\\" not in result["detail"]


def test_parse_replay_bytes_unknown_toon_returns_player_unresolved() -> None:
    result = ia.parse_replay_bytes(
        WARPGATE.read_bytes(), filename=WARPGATE.name,
        runtime=ia.RuntimeOptions(player_toon="9-S2-9-999999"),
    )
    assert result["errorKind"] == result["reason"] == "player_unresolved"
    assert "ReSpOnSe" not in result["detail"]


@pytest.mark.parametrize("flag", ["threads", "file_caches", "network_lookups", "engine_capture"])
def test_parse_replay_bytes_capability_flag_enabled_raises_value_error(flag: str) -> None:
    overrides: Dict[str, Any] = {flag: True}
    runtime = ia.RuntimeOptions(player_toon=RESPONSE_TOON, **overrides)
    with pytest.raises(ValueError, match="parse_replay_for_cloud_ex"):
        ia.parse_replay_bytes(WARPGATE.read_bytes(), filename=WARPGATE.name, runtime=runtime)


def test_list_replay_players_team_fixture_returns_four_players_team_format() -> None:
    listing = ia.list_replay_players(TEAM_FIXTURE.read_bytes(), filename=TEAM_FIXTURE.name)
    players = listing.pop("players")
    assert listing == {
        "ok": True, "date": "2025-10-21T16:23:07Z", "map": "Crimson Research Lab LE",
        "durationSec": 553, "matchFormat": "team", "playerCount": 4,
        "isAiGame": False, "toonFromPath": None,
    }
    assert [player["pid"] for player in players] == [1, 2, 3, 4]
    assert [player["result"] for player in players] == ["Loss", "Loss", "Win", "Win"]
    assert [player["toon"] for player in players] == [
        "5-S2-1-11793152", "5-S2-1-6424239", "5-S2-1-12157084", "5-S2-1-526043",
    ]


def test_list_replay_players_toon_folder_uses_relative_path_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    toonish_temp_root = tmp_path / "7-S2-7-777777"
    toonish_temp_root.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(toonish_temp_root))
    data = WARPGATE.read_bytes()
    flat = ia.list_replay_players(data, filename="x.SC2Replay")
    nested = ia.list_replay_players(
        data, filename=f"Accounts/1/{RESPONSE_TOON}/Replays/Multiplayer/x.SC2Replay",
    )
    assert flat["toonFromPath"] is None
    assert nested["toonFromPath"] == RESPONSE_TOON
    assert nested["players"][0] == {
        "name": "ReSpOnSe", "toon": RESPONSE_TOON, "race": "Protoss", "result": "Win", "pid": 1,
    }


@pytest.mark.parametrize(
    ("filename", "toon"),
    [
        (f"C:\\Users\\me\\Documents\\StarCraft II\\Accounts\\1\\{RESPONSE_TOON}\\Replays\\Multiplayer\\x.SC2Replay",
         RESPONSE_TOON),
        # Desktop semantics: the first toon-shaped part, root to leaf, wins.
        (f"Accounts/1/{RESPONSE_TOON}/Replays/{SQUIRTUOZ_TOON}/x.SC2Replay", RESPONSE_TOON),
        ("Downloads/1-S2-1-267727.SC2Replay", None),
    ],
    ids=["windows-account-tree", "two-toon-folders", "toon-in-file-name-only"],
)
def test_list_replay_players_toon_from_path_follows_desktop_rules(filename: str, toon: Any) -> None:
    listing = ia.list_replay_players(WARPGATE.read_bytes(), filename=filename)
    assert listing["toonFromPath"] == toon
    # The desktop helper on the same path (PureWindowsPath splits on both
    # separators on every OS; the helper only reads ``.parts``).
    desktop_path = PureWindowsPath(filename)
    assert replay_pipeline._toon_handle_from_path(desktop_path) == toon  # type: ignore[arg-type]


def test_list_replay_players_damaged_bytes_return_corrupt_file() -> None:
    listing = ia.list_replay_players(WARPGATE.read_bytes()[:TRUNCATED_BYTES], filename="x.SC2Replay")
    assert listing == {"ok": False, "errorKind": "corrupt_file", "detail": listing["detail"]}
    assert ia.list_replay_players(b"text", filename="x")["errorKind"] == "not_a_replay"


def _without_archive_tables(fixture: Path) -> bytes:
    """Fixture bytes with the MPQ hash and block tables (the tail) zeroed.

    sc2reader still "loads" such an archive: it just finds no
    ``replay.details``, so the replay has no players at all.
    """
    import mpyq  # type: ignore

    data = bytearray(fixture.read_bytes())
    header = mpyq.MPQArchive(io.BytesIO(bytes(data)), listfile=False).header
    start = header["offset"] + min(header["hash_table_offset"], header["block_table_offset"])
    data[start:] = bytes(len(data) - start)
    return bytes(data)


def test_parse_replay_bytes_archive_without_player_list_returns_corrupt_file() -> None:
    blob = _without_archive_tables(WARPGATE)
    by_toon = ia.parse_replay_bytes(
        blob, filename="x.SC2Replay", runtime=ia.RuntimeOptions(player_toon=RESPONSE_TOON),
    )
    by_folder = ia.parse_replay_bytes(
        blob, filename=f"Accounts/1/{RESPONSE_TOON}/Replays/Multiplayer/x.SC2Replay",
    )
    listing = ia.list_replay_players(blob, filename="x.SC2Replay")
    assert (by_toon["reason"], by_toon["errorKind"]) == ("parse_failed", "corrupt_file")
    # The desktop pipeline itself reports player_unresolved; only the kind changes.
    assert (by_folder["reason"], by_folder["errorKind"]) == ("player_unresolved", "corrupt_file")
    assert listing == {"ok": False, "errorKind": "corrupt_file", "detail": listing["detail"]}


def test_list_replay_players_memoryview_matches_bytes() -> None:
    data = WARPGATE.read_bytes()
    # Pyodide hands JS Uint8Array contents over as a memoryview.
    assert ia.list_replay_players(memoryview(data), filename=WARPGATE.name) == (
        ia.list_replay_players(data, filename=WARPGATE.name)
    )


@pytest.mark.parametrize("data", ["MPQ\x1b as text", None, 42])
def test_parse_replay_bytes_non_bytes_data_raises_type_error(data: Any) -> None:
    with pytest.raises(TypeError, match="bytes-like"):
        ia.parse_replay_bytes(data, filename="x.SC2Replay")


def test_replay_digests_fixture_matches_hashlib() -> None:
    data = WARPGATE.read_bytes()
    digests = ia.replay_digests(bytearray(data))
    assert digests == {
        "sha256": hashlib.sha256(data).hexdigest(),
        "md5": base64.b64encode(hashlib.md5(data).digest()).decode("ascii"),
        "sizeBytes": len(data),
    }
    assert len(digests["md5"]) == 24 and digests["md5"].endswith("==")


def _zip_bytes(entries: List[Tuple[str, bytes]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries:
            archive.writestr(name, payload)
    return buffer.getvalue()


def test_expand_replay_zip_nested_dirs_and_junk_returns_only_replays() -> None:
    data = WARPGATE.read_bytes()
    blob = _zip_bytes([
        ("Replays/", b""),
        ("Replays/Accounts/1/1-S2-1-267727/Multiplayer/a.SC2Replay", data),
        ("Replays\\windows\\b.sc2replay", b"MPQ\x1b-b"),
        ("../../escape/c.SC2REPLAY", b"MPQ\x1b-c"),
        ("__MACOSX/Replays/._a.SC2Replay", b"resource fork"),
        ("Replays/.hidden.SC2Replay", b"dotfile"),
        ("notes.txt", b"junk"),
    ])
    entries = ia.expand_replay_zip(blob)
    assert [entry["name"] for entry in entries] == [
        "Replays/Accounts/1/1-S2-1-267727/Multiplayer/a.SC2Replay",
        "Replays/windows/b.sc2replay",
        "escape/c.SC2REPLAY",
    ]
    assert entries[0]["data"] == data


def test_expand_replay_zip_too_many_entries_raises_value_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(instant_intake, "MAX_ZIP_REPLAY_ENTRIES", 2)
    blob = _zip_bytes([(f"{index}.SC2Replay", b"MPQ\x1b") for index in range(3)])
    with pytest.raises(ValueError, match="zip_too_many_entries"):
        ia.expand_replay_zip(blob)


def test_expand_replay_zip_oversized_entry_raises_value_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(instant_intake, "MAX_ZIP_ENTRY_BYTES", 64)
    blob = _zip_bytes([("big.SC2Replay", bytes(65))])
    with pytest.raises(ValueError, match="zip_entry_too_large"):
        ia.expand_replay_zip(blob)


def test_expand_replay_zip_total_over_limit_raises_value_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(instant_intake, "MAX_ZIP_TOTAL_BYTES", 100)
    blob = _zip_bytes([("a.SC2Replay", bytes(60)), ("b.SC2Replay", bytes(60))])
    with pytest.raises(ValueError, match="zip_too_large"):
        ia.expand_replay_zip(blob)


def test_expand_replay_zip_encrypted_entry_raises_value_error() -> None:
    blob = bytearray(_zip_bytes([("a.SC2Replay", b"MPQ\x1b")]))
    # Set the "encrypted" general-purpose flag bit in the local header (+6)
    # and the central-directory header (+8): the stdlib cannot write
    # encrypted archives, but this is exactly what it reads from one.
    for signature, offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        start = blob.index(signature) + offset
        blob[start] |= 0x1
    with pytest.raises(ValueError, match="zip_encrypted"):
        ia.expand_replay_zip(bytes(blob))


@pytest.mark.parametrize("blob", [b"", b"not a zip at all", b"PK\x05\x06" + bytes(10)])
def test_expand_replay_zip_invalid_bytes_raises_value_error(blob: bytes) -> None:
    with pytest.raises(ValueError, match="zip_invalid"):
        ia.expand_replay_zip(blob)


# ---------------------------------------------------------------------------
# 4) Outcome mapping for branches no fixture reaches (MOCK: pipeline call)
# ---------------------------------------------------------------------------
def _mock_pipeline(monkeypatch: pytest.MonkeyPatch, outcome: Any) -> List[Dict[str, Any]]:
    """MOCK: replace parse_replay_for_cloud_ex; record what it was called with."""
    calls: List[Dict[str, Any]] = []

    def fake(path: Path, **kwargs: Any) -> Any:
        calls.append({
            "path": path, "exists": path.is_file(), **kwargs,
            "env": {name: os.environ.get(name) for name in SANDBOX_ENV_VARS},
        })
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(replay_pipeline, "parse_replay_for_cloud_ex", fake)
    return calls


def _resumed_game(my_toon: str) -> Any:
    ctx = SimpleNamespace(
        game_id="2026-05-08T19:08:12|Opp|Map LE|470", date_iso="2026-05-08T19:08:12",
        map_name="Map LE", length_seconds=470, all_players=[None, None], raw=None,
        started_at_iso=None, game_version=None, game_build=None,
    )
    me = SimpleNamespace(result="Win", race="Protoss", selected_race=None, handle=my_toon)
    opp = SimpleNamespace(name="Opp", race="Zerg", handle=SQUIRTUOZ_TOON)
    return replay_pipeline._build_resumed_cloud_game(ctx, me, opp)


@pytest.mark.parametrize("reason", ["ai_game", "player_unresolved", "no_result", "playback_budget_exceeded"])
def test_parse_replay_bytes_pipeline_skip_reason_maps_to_same_error_kind_mock(
    monkeypatch: pytest.MonkeyPatch, reason: str,
) -> None:
    _mock_pipeline(monkeypatch, (None, reason))
    result = ia.parse_replay_bytes(WARPGATE.read_bytes(), filename=WARPGATE.name)
    assert (result["ok"], result["reason"], result["errorKind"]) == (False, reason, reason)


def test_parse_replay_bytes_resumed_marker_returns_ok_resumed_mock(monkeypatch: pytest.MonkeyPatch) -> None:
    _mock_pipeline(monkeypatch, (_resumed_game(RESPONSE_TOON), None))
    result = ia.parse_replay_bytes(
        WARPGATE.read_bytes(), filename=WARPGATE.name,
        runtime=ia.RuntimeOptions(player_toon=RESPONSE_TOON),
    )
    assert result["ok"] is True and result["isResumedFromReplay"] is True
    assert json.loads(result["json"]) == result["payload"]
    assert result["payload"]["isResumedFromReplay"] is True


def test_parse_replay_bytes_toon_resolves_to_other_player_returns_player_ambiguous_mock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _mock_pipeline(monkeypatch, (_resumed_game(SQUIRTUOZ_TOON), None))
    result = ia.parse_replay_bytes(
        WARPGATE.read_bytes(), filename=WARPGATE.name,
        runtime=ia.RuntimeOptions(player_toon=RESPONSE_TOON),
    )
    assert result["errorKind"] == result["reason"] == "player_ambiguous"
    assert calls[0]["player_handle"] == "ReSpOnSe"


def test_parse_replay_bytes_parse_failed_on_loadable_replay_returns_analysis_failed_mock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _mock_pipeline(monkeypatch, (None, "parse_failed"))
    result = ia.parse_replay_bytes(WARPGATE.read_bytes(), filename=WARPGATE.name)
    assert (result["reason"], result["errorKind"]) == ("parse_failed", "analysis_failed")


@pytest.mark.parametrize(
    ("raised", "kind"),
    [
        (RuntimeError("boom at /home/someone/Replays/secret.SC2Replay"), "analysis_failed"),
        (ValueError("Out of range float values are not JSON compliant"), "analysis_failed"),
        (replay_pipeline.AnalyzerImportError("C:\\engine\\missing"), "engine_unavailable"),
        (SystemExit(1), "engine_unavailable"),
    ],
)
def test_parse_replay_bytes_pipeline_raises_returns_scrubbed_failure_mock(
    monkeypatch: pytest.MonkeyPatch, raised: BaseException, kind: str,
) -> None:
    _mock_pipeline(monkeypatch, raised)
    result = ia.parse_replay_bytes(WARPGATE.read_bytes(), filename=WARPGATE.name)
    assert result["ok"] is False and result["errorKind"] == kind
    assert result["detail"].startswith(type(raised).__name__ + ":")
    assert "secret" not in result["detail"] and "engine\\" not in result["detail"]


def test_parse_replay_bytes_runs_pipeline_sandboxed_and_cleans_up_mock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in SANDBOX_ENV_VARS:
        monkeypatch.setenv(name, "leak")
    calls = _mock_pipeline(monkeypatch, (None, "no_result"))
    ia.parse_replay_bytes(
        WARPGATE.read_bytes(),
        filename="C:\\Users\\me\\..\\Accounts\\1\\1-S2-1-267727\\Replays\\a:b?.txt",
        runtime=ia.RuntimeOptions(player_handle="ReSp"),
    )
    call = calls[0]
    assert (call["state_dir"], call["resolve_pulse"], call["player_handle"]) == (None, False, "ReSp")
    assert call["env"] == {name: None for name in SANDBOX_ENV_VARS}
    assert call["exists"] is True
    # Only the toon folder survives; the user's folder and file names
    # ("Users", "me", "a:b?.txt") never reach the sandbox filesystem.
    assert call["path"].parts[-2:] == ("1-S2-1-267727", "replay.SC2Replay")
    assert call["path"].parent.parent.name.startswith("sc2ia-")
    assert not call["path"].exists()
    assert all(os.environ[name] == "leak" for name in SANDBOX_ENV_VARS)


# ---------------------------------------------------------------------------
# Privacy: user file and folder names never reach a log line (real fixture)
# ---------------------------------------------------------------------------
class _RecordingHandler(logging.Handler):
    """Collects every formatted message it is handed."""

    def __init__(self) -> None:
        super().__init__(logging.INFO)
        self.messages: List[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


@pytest.fixture()
def engine_log_messages() -> Iterator[List[str]]:
    """INFO+ messages of the pipeline, this module and sc2reader.

    Attached to the loggers themselves (not root) and forced on, so what
    other test modules did to logging configuration cannot hide records.
    """
    handler = _RecordingHandler()
    loggers = [logging.getLogger(name) for name in ENGINE_LOGGERS]
    saved = [(logger.level, logger.disabled) for logger in loggers]
    for logger in loggers:
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.disabled = False
    try:
        yield handler.messages
    finally:
        for logger, (level, disabled) in zip(loggers, saved, strict=True):
            logger.removeHandler(handler)
            logger.setLevel(level)
            logger.disabled = disabled


def test_parse_replay_bytes_logs_never_contain_user_file_or_folder_names(
    engine_log_messages: List[str],
) -> None:
    data = WARPGATE.read_bytes()
    secret = "Secret Folder Name"
    ok = ia.parse_replay_bytes(
        data, filename=f"Users/{secret}/Downloads/{secret}.SC2Replay",
        runtime=ia.RuntimeOptions(player_toon=RESPONSE_TOON),
    )
    failed = ia.parse_replay_bytes(
        data[:TRUNCATED_BYTES],
        filename=f"{secret}/Accounts/1/{RESPONSE_TOON}/Replays/Multiplayer/{secret}.SC2Replay",
    )
    assert ok["ok"] is True and failed["errorKind"] == "corrupt_file"
    # Non-vacuous: the pipeline's INFO and WARNING lines naming the file were captured.
    assert any("replay_payload_ready file=replay.SC2Replay" in line for line in engine_log_messages)
    assert any("parse_deep_failed for replay.SC2Replay" in line for line in engine_log_messages)
    assert [line for line in engine_log_messages if secret in line] == []


# ---------------------------------------------------------------------------
# Load-failure classifier (pure; real sc2reader exception classes)
# ---------------------------------------------------------------------------
def test_classify_load_failure_known_errors_map_to_kinds() -> None:
    from core import replay_errors  # type: ignore
    from sc2reader.exceptions import MPQError, ReadError

    unknown_build = ValueError("Valid replay.game.events reader could not found for build 99999")
    newer_protocol = ReadError("bad", "ReplayGameEvents", 1)
    assert replay_errors.classify_load_failure(MPQError("Unable to construct")) == "corrupt_file"
    assert replay_errors.classify_load_failure(unknown_build) == "unsupported_version"
    assert replay_errors.classify_load_failure(newer_protocol) == "unsupported_version"
    assert replay_errors.classify_load_failure(KeyError("unit")) == "parse_failed"
    assert replay_errors.classify_load_failure(newer_protocol, header_readable=False) == "corrupt_file"


def test_error_kind_constants_python_and_typescript_contract_match() -> None:
    from core import replay_errors  # type: ignore

    assert replay_errors.KIND_CORRUPT_FILE == ia.ERROR_CORRUPT_FILE
    assert replay_errors.KIND_UNSUPPORTED_VERSION == ia.ERROR_UNSUPPORTED_VERSION
    assert replay_errors.KIND_PARSE_FAILED == ia.ERROR_PARSE_FAILED
    web_types = HERE.parent / "web" / "lib" / "instant" / "types.ts"
    if not web_types.is_file():
        pytest.skip("apps/web is not part of this checkout")
    source = web_types.read_text(encoding="utf-8")
    assert TS_PYTHON_KINDS_START in source and TS_PYTHON_KINDS_END in source
    python_block = source.split(TS_PYTHON_KINDS_START, 1)[1].split(TS_PYTHON_KINDS_END, 1)[0]
    kinds = [value for name, value in vars(ia).items() if name.startswith("ERROR_")]
    # Exactly the "emitted by the Python engine" block of the union: no
    # kind missing on either side, none misfiled under the client block.
    assert sorted(kinds) == sorted(TS_STRING_LITERAL_RE.findall(python_block))


# ---------------------------------------------------------------------------
# 5) Runtime-only allowlist
# ---------------------------------------------------------------------------
def test_runtime_only_fields_are_documented_dotted_paths() -> None:
    assert ia.RUNTIME_ONLY_FIELDS
    assert len(set(ia.RUNTIME_ONLY_FIELDS)) == len(ia.RUNTIME_ONLY_FIELDS)
    # Every difference the parity run actually observes is on the allowlist.
    assert all(_is_runtime_only(path) for path in EXPECTED_DESKTOP_DIFF_PATHS)
    source_lines = inspect.getsource(ia).splitlines()
    for field in ia.RUNTIME_ONLY_FIELDS:
        assert isinstance(field, str) and DOTTED_PATH_RE.match(field), field
        line_no = next(i for i, line in enumerate(source_lines) if line.strip() == f'"{field}",')
        assert source_lines[line_no - 1].strip().startswith("#"), f"{field} lacks a comment"
