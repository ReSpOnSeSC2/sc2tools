"""Synthetic metadata/envelope tests; no native parser, installer or private state."""
import ast
from dataclasses import FrozenInstanceError
import importlib
import importlib.util
from pathlib import Path
import pickle
from types import SimpleNamespace

import pytest

from sc2tools_agent import analysis_provenance as provenance


def parser_root(tmp_path, *, frozen=False):
    root = tmp_path / "_MEIPASS" / "apps" / "replay-engine" if frozen else tmp_path / "source" / "apps" / "replay-engine"
    (root / "core").mkdir(parents=True)
    origin = root / "core" / "sc2_replay_parser.py"
    origin.write_text("# synthetic parser origin, never imported\n", encoding="utf-8")
    return root, SimpleNamespace(__file__=str(origin))


def test_real_source_engine_origin_is_used_instead_of_agent_parser_wrapper():
    import sc2tools_agent
    from sc2tools_agent import replay_pipeline
    replay_pipeline.bootstrap_analyzer_path()
    engine = importlib.import_module("core.sc2_replay_parser")
    engine_root = Path(engine.__file__).resolve().parent.parent
    expected_root = Path(__file__).resolve().parents[2] / "replay-engine"
    assert engine_root == expected_root
    assert engine_root != Path(replay_pipeline.__file__).resolve().parent
    assert (engine_root / "VERSION").read_text(encoding="utf-8").strip() == "1.6.12"
    captured = provenance.capture_provenance()
    assert captured.engine_version == "1.6.12" and captured.agent_version == sc2tools_agent.__version__


@pytest.mark.parametrize("frozen", [False, True])
def test_versions_come_from_actual_parser_root_and_loaded_agent(tmp_path, monkeypatch, frozen):
    import sc2tools_agent
    root, module = parser_root(tmp_path, frozen=frozen)
    (root / "VERSION").write_bytes(b"1.6.12\r\n")
    monkeypatch.setattr(sc2tools_agent, "__version__", "0.24.10-test+fixture")
    captured = provenance.capture_provenance(parser_module=module)
    assert captured.payload_fields() == {"engineVersion": "1.6.12", "agentVersion": "0.24.10-test+fixture"}
    (root / "VERSION").write_text("9.9.9", encoding="utf-8")
    monkeypatch.setattr(sc2tools_agent, "__version__", "9.9.9")
    assert captured.engine_version == "1.6.12" and captured.agent_version == "0.24.10-test+fixture"
    with pytest.raises(FrozenInstanceError):
        captured.agent_version = "9.9.9"


@pytest.mark.parametrize("raw", [None, b"", b"0.0.0+unknown", b"latest", b"1.2.3\nextra", b"1.2.3\n\n", b"\xff", b"1.2.3-"+b"x"*35, b"x"*100_000], ids=["missing", "empty", "unknown", "nonversion", "multiline", "extra-newline", "invalid-utf8", "over40", "oversize-file"])
def test_missing_or_invalid_engine_metadata_is_unknown_not_current(tmp_path, raw):
    root, module = parser_root(tmp_path)
    if raw is not None:
        (root / "VERSION").write_bytes(raw)
    # An unrelated current/source VERSION must never rescue the missing origin.
    (tmp_path / "VERSION").write_text("9.9.9", encoding="utf-8")
    assert provenance.capture_provenance(parser_module=module).engine_version is None


@pytest.mark.parametrize("value", [None, 123, True, {}, [], "v1.2.3", "1.2.3 ", "1.2.3-", "0.0.0+unknown", "1.2.3-"+"x"*35])
def test_invalid_agent_or_direct_snapshot_values_cannot_escape(value, monkeypatch):
    import sc2tools_agent
    monkeypatch.setattr(sc2tools_agent, "__version__", value)
    assert provenance.capture_provenance(parser_module=SimpleNamespace()).agent_version is None
    assert provenance.AnalysisProvenance(value, value).payload_fields() == {}


def test_exact40_versions_and_pickled_envelope_remain_immutable(tmp_path):
    root, module = parser_root(tmp_path)
    version = "1.2.3-" + "x"*34
    assert len(version) == 40
    (root / "VERSION").write_text(version, encoding="utf-8")
    stamp = provenance.capture_provenance(parser_module=module)
    game = SimpleNamespace(game_id="synthetic")
    restored = pickle.loads(pickle.dumps(provenance.ParsedGame(game, stamp)))
    assert restored.game.game_id == "synthetic" and restored.provenance.engine_version == version
    with pytest.raises(FrozenInstanceError):
        restored.provenance = provenance.UNKNOWN_PROVENANCE
    assert provenance.as_parsed_game(game).provenance == provenance.UNKNOWN_PROVENANCE
    assert provenance.ParsedGame(SimpleNamespace(is_resumed_from_replay=True), stamp).provenance == provenance.UNKNOWN_PROVENANCE


def test_packaging_places_existing_version_beside_the_frozen_engine(tmp_path):
    spec = Path(__file__).resolve().parents[1] / "packaging" / "sc2tools_agent.spec"
    tree = ast.parse(spec.read_text(encoding="utf-8"))
    statements = [node for node in ast.walk(tree) if isinstance(node, ast.Expr)
                  and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute)
                  and isinstance(node.value.func.value, ast.Name) and node.value.func.value.id == "DATAS"
                  and node.value.func.attr == "append" and any(isinstance(child, ast.Constant) and child.value == "VERSION" for child in ast.walk(node))]
    assert len(statements) == 1
    root, module = parser_root(tmp_path, frozen=True)
    source_version = Path(__file__).resolve().parents[2] / "replay-engine" / "VERSION"
    (root / "VERSION").write_bytes(source_version.read_bytes())
    data = []
    # Execute only the selected pure DATAS append, never the PyInstaller spec.
    exec(compile(ast.Module(body=statements, type_ignores=[]), str(spec), "exec"), {"__builtins__": {}, "str": str, "ANALYZER_DIR": root, "DATAS": data})
    assert data == [(str(root / "VERSION"), "apps/replay-engine")]
    origin = root / "core" / "sc2_replay_parser.py"
    definition = importlib.util.spec_from_file_location("fixture_frozen_parser", origin)
    loaded = importlib.util.module_from_spec(definition)
    definition.loader.exec_module(loaded)  # Empty synthetic parser file only, never a native app.
    assert provenance.capture_provenance(parser_module=loaded).engine_version == Path(data[0][0]).read_text().strip() == "1.6.12"
