import sys

import pytest

from sc2tools_agent.ui import system_motion


@pytest.mark.parametrize("answer,expected", [(0, False), (1, True), (None, True)])
def test_windows_animation_switch_decides_and_an_unknown_answer_keeps_motion(monkeypatch, answer, expected):
    monkeypatch.setattr(system_motion.sys, "platform", "win32")
    monkeypatch.setattr(system_motion, "_client_area_animation", lambda: answer)
    assert system_motion.animations_enabled() is expected


def test_other_systems_keep_motion_without_asking_windows(monkeypatch):
    monkeypatch.setattr(system_motion.sys, "platform", "linux")
    monkeypatch.setattr(system_motion, "_client_area_animation", lambda: pytest.fail("asked Windows"))
    assert system_motion.animations_enabled() is True


def test_the_real_switch_answers_on_windows_and_stays_unknown_elsewhere():
    assert system_motion._client_area_animation() in ((0, 1) if sys.platform == "win32" else (None,))
