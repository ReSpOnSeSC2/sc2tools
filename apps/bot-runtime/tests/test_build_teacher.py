from types import SimpleNamespace

import numpy as np
import pytest

from pluto_sc2.adversary_schema import get_spec
from pluto_sc2.build_teacher import ReplayBuildTeacher, sample_builds


def build(result="Defeat", identifier="a"):
    return {"race": "Terran", "user_result": result, "replay_id": identifier,
            "orders": [{"action": "build_supplydepot", "game_seconds": 20}]}


def test_sampling_prioritizes_losses_without_changing_build_content():
    lost, won = build(), build("Victory", "b")
    selected = sample_builds([lost, won], 12000, seed=3)
    assert 1.9 < sum(item is lost for item in selected) / sum(item is won for item in selected) < 2.1
    assert selected == sample_builds([lost, won], 12000, seed=3)
    assert lost["orders"] == build()["orders"]
    with pytest.raises(ValueError, match="Duplicate"):
        sample_builds([lost, lost], 1)
    with pytest.raises(ValueError, match="Held-out"):
        sample_builds([{**lost, "partition": "validation"}], 1)


def test_build_order_advances_only_after_actual_acceptance():
    teacher = ReplayBuildTeacher(build())
    spec = get_spec("Terran")
    index = spec.action_names.index("build_supplydepot")
    mask = np.zeros(spec.action_dim, dtype=bool)
    mask[[0, index]] = True
    bot = SimpleNamespace(spec=spec, time=19, workers=[])
    assert teacher(bot, None, mask) == 0
    bot.time = 20
    assert teacher(bot, None, mask) == index
    teacher.on_action_result(index, False)
    assert teacher(bot, None, mask) == index
    teacher.on_action_result(index, True)
    assert teacher(bot, None, mask) == 0
    assert teacher.report()["status_counts"] == {"accepted": 1}


def test_unavailable_intentions_are_reported_and_never_forced_into_illegal_actions():
    teacher = ReplayBuildTeacher(build(), patience_seconds=10)
    spec = get_spec("Terran")
    mask = np.zeros(spec.action_dim, dtype=bool)
    mask[0] = True
    bot = SimpleNamespace(spec=spec, time=31, workers=[])
    assert teacher(bot, None, mask) == 0
    assert teacher.report()["status_counts"] == {"omitted": 1}
    assert teacher.report()["omissions"][0]["reason"] == "unavailable beyond patience"
