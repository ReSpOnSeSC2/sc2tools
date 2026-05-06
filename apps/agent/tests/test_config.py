"""Tests for agent.config — env handling + defaults."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

import pytest

from sc2tools_agent.config import load_config


@pytest.fixture(autouse=True)
def _isolate_env(tmp_path: Path) -> Iterator[None]:
    keys = [
        "SC2TOOLS_API_BASE",
        "SC2TOOLS_STATE_DIR",
        "SC2TOOLS_REPLAY_FOLDER",
        "SC2TOOLS_POLL_INTERVAL",
        "SC2TOOLS_PARSE_CONCURRENCY",
    ]
    saved = {k: os.environ.pop(k, None) for k in keys}
    os.environ["SC2TOOLS_STATE_DIR"] = str(tmp_path / "state")
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def test_defaults() -> None:
    cfg = load_config()
    assert cfg.api_base == "https://sc2tools-api.onrender.com"
    assert cfg.poll_interval_sec == 10
    assert cfg.parse_concurrency == 1
    assert cfg.replay_folder is None


def test_env_overrides() -> None:
    os.environ["SC2TOOLS_API_BASE"] = "https://api.sc2tools.com/"
    os.environ["SC2TOOLS_POLL_INTERVAL"] = "30"
    os.environ["SC2TOOLS_PARSE_CONCURRENCY"] = "4"
    cfg = load_config()
    assert cfg.api_base == "https://api.sc2tools.com"  # trailing slash stripped
    assert cfg.poll_interval_sec == 30
    assert cfg.parse_concurrency == 4


def test_invalid_int_falls_back_to_default() -> None:
    os.environ["SC2TOOLS_POLL_INTERVAL"] = "abc"
    cfg = load_config()
    assert cfg.poll_interval_sec == 10


def test_minimum_poll_interval_is_clamped() -> None:
    os.environ["SC2TOOLS_POLL_INTERVAL"] = "0"
    cfg = load_config()
    assert cfg.poll_interval_sec >= 2
