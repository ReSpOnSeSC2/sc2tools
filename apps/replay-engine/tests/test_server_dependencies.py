"""The API image guard checks installed distributions, including transitives."""
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace

import pytest

spec = spec_from_file_location("server_dependency_guard", Path(__file__).parents[1] / "scripts" / "check_server_dependencies.py")
guard = module_from_spec(spec)
spec.loader.exec_module(guard)


@pytest.mark.parametrize("name", ["scikit-learn", "sklearn", "torch", "transformers", "SCIKIT_LEARN"])
def test_blocks_model_runtimes(monkeypatch, name):
    monkeypatch.setattr(guard.metadata, "distributions", lambda: [SimpleNamespace(metadata={"Name": name})])
    with pytest.raises(SystemExit, match="Forbidden API image dependencies"):
        guard.check_server_dependencies()


def test_accepts_replay_and_spatial_statistics(monkeypatch):
    monkeypatch.setattr(guard.metadata, "distributions", lambda: [SimpleNamespace(metadata={"Name": name}) for name in ["sc2reader", "numpy", "scipy", "mpyq"]])
    guard.check_server_dependencies()
