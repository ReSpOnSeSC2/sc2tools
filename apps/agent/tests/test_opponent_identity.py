from types import SimpleNamespace

import pytest

from sc2tools_agent.opponent_identity import is_barcode_like_name, unambiguous_toon_handle


@pytest.mark.parametrize(("name", "expected"), [
    ("IIIIIIIIIIII", True), ("llllllllllll", True), ("lIIlIlIl", True), (" Il1i| ", True),
    ("ＩＩＩＩ", True), ("Forescene", False), ("Illidan", False),
    ("", False), ("   ", False), (None, False), (7, False),
])
def test_barcode_names_follow_the_cloud_rule(name, expected):
    assert is_barcode_like_name(name) is expected


def _profile(**overrides):
    values = {"toon_handle": "2-S2-1-2594743", "confidence": 1.0, "name": "Forescene"}
    values.update(overrides)
    return SimpleNamespace(**values)


def test_only_an_unambiguous_named_match_yields_a_toon_handle():
    assert unambiguous_toon_handle(_profile(), "Forescene") == "2-S2-1-2594743"
    for confidence in (0.99, 0.5, None, True, "1.0"):
        assert unambiguous_toon_handle(_profile(confidence=confidence), "Forescene") is None
    assert unambiguous_toon_handle(_profile(), "IIIIIIIIIIII") is None
    assert unambiguous_toon_handle(_profile(name="llllllllllll"), "Forescene") is None
    for toon in (None, "", "2-S2-1", "0-S2-1-5", "2-S1-1-5", "2-S2-1-5 ", 25):
        assert unambiguous_toon_handle(_profile(toon_handle=toon), "Forescene") is None
    assert unambiguous_toon_handle(None, "Forescene") is None
