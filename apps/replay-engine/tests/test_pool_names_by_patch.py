"""Pool-first openers are "8 Pool" on the 8-worker patch 5.0.16 and
"12 Pool" before it and from 5.0.17 on (12 starting workers)."""

import pytest

from core.build_definitions import (
    BUILD_DEFINITIONS,
    EIGHT_WORKER_BUILD_NAMES,
    name_for_game_version,
)


@pytest.mark.parametrize("twelve, eight", sorted(EIGHT_WORKER_BUILD_NAMES.items()))
def test_8_worker_patch_names_the_pool_openers_8_pool(twelve, eight):
    assert twelve in BUILD_DEFINITIONS
    assert eight not in BUILD_DEFINITIONS
    assert name_for_game_version(twelve, "5.0.16.97425") == eight
    assert name_for_game_version(twelve, "5.0.16.97364") == eight


@pytest.mark.parametrize("version", ["5.0.17.98000", "5.0.15.96883", "5.0.160.1", "", None])
def test_every_other_patch_keeps_12_pool(version):
    assert name_for_game_version("Zerg - 12 Pool", version) == "Zerg - 12 Pool"


def test_other_names_and_missing_names_pass_through():
    assert name_for_game_version("ZvP - Ling Bane Bust", "5.0.16.97425") == "ZvP - Ling Bane Bust"
    assert name_for_game_version(None, "5.0.16.97425") is None
