from sc2tools_agent.practice_hud import (PracticeVoice, catch_up_index, next_speak_index,
                                        normalize_practice_preferences, read_display_mode)


STEPS = [{"t": 18, "name": "SupplyDepot"}, {"t": 46, "name": "Barracks"},
         {"t": 60, "name": "OrbitalCommand"}]


def test_web_ghost_voice_timing_parity_and_clock_jumps():
    assert next_speak_index(STEPS, 12.99, -1) is None
    assert next_speak_index(STEPS, 13, -1) == 0
    assert next_speak_index(STEPS, 40.99, 0) is None
    assert next_speak_index(STEPS, 41, 0) == 1
    assert catch_up_index(STEPS, 55, -1) == 2
    assert catch_up_index(STEPS, 1000, 2) == 2
    voice = PracticeVoice()
    target = {"steps": STEPS, "sourceGameId": "target"}
    assert voice.next_line("game", target, 55) == "Next: Orbital Command"
    assert voice.next_line("game", target, 10) is None
    assert voice.next_line("game", target, 60) is None
    assert voice.next_line("other", target, 9, lead=9) == "Next: Supply Depot"


def test_native_preferences_default_to_silent_and_capture_hidden():
    assert normalize_practice_preferences(None) == {"voice": False, "lead": 5, "hideCapture": True,
                                                       "opacity": 100, "scale": 100}
    assert normalize_practice_preferences({"lead": True, "voice": 1, "opacity": 200, "scale": 80}) == {
        "voice": False, "lead": 5, "hideCapture": True, "opacity": 100, "scale": 80,
    }


def test_display_mode_uses_a_valid_exact_setting(tmp_path):
    missing = tmp_path / "missing.txt"
    config = tmp_path / "Variables.txt"
    config.write_text("\ufeffFirstSetting=0\nDisplayMode = 2\n", encoding="utf-8")
    assert read_display_mode([missing, config]) == 2
    config.write_text("OtherDisplayMode=2\ndisplaymode=22\n", encoding="utf-8")
    assert read_display_mode([missing, config]) is None
    config.write_text("displaymode=1\n", encoding="utf-8")
    assert read_display_mode([config]) == 1
