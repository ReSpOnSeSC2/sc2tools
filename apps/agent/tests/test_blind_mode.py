"""Contract tests for protection decisions; no game, Qt or Windows required."""

from dataclasses import FrozenInstanceError, replace
import math

import pytest

from sc2tools_agent.blind_mode import (
    BlindModeConfig,
    BlindModePolicy,
    GAMEPLAY_CONFIRM_SECONDS,
    NormalizedRect,
    normalized_ui_screens,
)


LOADING = {"activeScreens": ["ScreenLoading"]}
PLAYING = {"activeScreens": []}
MENU = {"activeScreens": ["ScreenMultiplayer"]}
SCORE = {"activeScreens": ["ScreenScore"]}


def game(*, time=0, race="Protoss", opponent="Opponent", replay=False):
    return {
        "isReplay": replay,
        "displayTime": time,
        "players": [
            {"name": "Local#123", "type": "user", "race": "Zerg", "result": "Undecided"},
            {"name": opponent, "type": "user", "race": race, "result": "Undecided"},
        ],
    }


def policy(**kwargs):
    return BlindModePolicy(BlindModeConfig(enabled=True, **kwargs), "Local#123")


def confirm_playing(subject, *, sample=None, now=2.0):
    subject.update(PLAYING, sample, now)
    return subject.update(PLAYING, sample, now + GAMEPLAY_CONFIRM_SECONDS + 0.01)


def test_default_disabled_and_immutable_snapshot():
    subject = BlindModePolicy()
    snapshot = subject.update(LOADING, game(), 0)
    assert (snapshot.mode, snapshot.curtain, snapshot.masks) == ("off", False, ())
    with pytest.raises(FrozenInstanceError):
        snapshot.mode = "loading"


def test_prequeue_panels_then_whole_loading_curtain_then_chat():
    subject = policy()
    armed = subject.update(MENU, game(time=300), 0)
    assert armed.mode == "armed"
    assert armed.masks == subject.config.loading_masks
    assert not armed.curtain
    loading = subject.update(LOADING, game(), 1)
    assert loading.mode == "loading" and loading.curtain
    assert loading.opponent_race == "Protoss"
    playing = confirm_playing(subject, sample=game(time=0))
    assert playing.mode == "playing" and not playing.curtain
    assert playing.masks == subject.config.chat_masks


@pytest.mark.parametrize("stale", [game(time=400), game(time=400, replay=True)])
def test_loading_overrides_old_timer_and_replay(stale):
    subject = policy()
    loading = subject.update(LOADING, stale, 0)
    assert loading.mode == "loading" and loading.curtain
    assert loading.opponent_race is None
    stale["players"][0]["result"] = "Victory"
    assert subject.update(LOADING, stale, 0.1).curtain


def test_loading_overrides_overlapping_score_state():
    snapshot = policy().update({"activeScreens": ["ScreenLoading", "ScreenScore"]}, game(time=500), 0)
    assert snapshot.mode == "loading" and snapshot.curtain


@pytest.mark.parametrize("raw", ["ScreenLoading/ScreenLoading", "/ScreenLoading/ScreenLoading/", "Root/ScreenLoading"])
def test_native_loading_paths_activate_curtain_without_game_data(raw):
    assert policy().update({"activeScreens": [raw]}, None, 0).curtain


@pytest.mark.parametrize("raw,mode", [
    ("ScreenScore/ScreenScore", "armed"),
    ("ScreenMultiplayer/ScreenMultiplayer", "armed"),
    ("ScreenLoading/UnknownChild", "unavailable"),
])
def test_terminal_screen_component_is_normalized_without_guessing_unknown_children(raw, mode):
    snapshot = policy().update({"activeScreens": [raw]}, None, 0)
    assert snapshot.mode == mode and not snapshot.curtain


def test_screen_normalizer_preserves_invalid_vs_empty_gameplay_distinction():
    assert normalized_ui_screens({}) is None
    assert normalized_ui_screens({"activeScreens": []}) == ()
    assert normalized_ui_screens({"activeScreens": ["ScreenLoading/ScreenLoading"]}) == ("ScreenLoading",)


def test_missing_or_delayed_game_data_cannot_prevent_loading_protection():
    subject = policy()
    first = subject.update(LOADING, None, 0)
    assert first.curtain and first.opponent_race is None
    delayed = subject.update(LOADING, game(), 1)
    assert delayed.curtain and delayed.opponent_race == "Protoss"


def test_one_empty_ui_sample_and_stale_timer_do_not_drop_loading_cover():
    subject = policy()
    subject.update(LOADING, game(), 0)
    brief = subject.update(PLAYING, game(time=999), 0.1)
    assert brief.curtain
    restored = subject.update(LOADING, game(), 0.2)
    assert restored.curtain
    assert subject.update(PLAYING, game(time=999), 0.3).curtain
    assert not subject.update(PLAYING, None, 0.3 + GAMEPLAY_CONFIRM_SECONDS + 0.01).curtain


def test_countdown_and_failed_game_fetch_release_on_confirmed_native_game_view():
    subject = policy()
    subject.update(LOADING, game(), 0)
    snapshot = confirm_playing(subject, sample=None)
    assert snapshot.mode == "playing"
    assert not snapshot.curtain
    assert snapshot.masks == subject.config.chat_masks


def test_fast_rematch_resets_race_before_new_game_api_response_arrives():
    subject = policy()
    subject.update(LOADING, game(race="Random"), 0)
    confirm_playing(subject, sample=game(time=200, race="Zerg"))
    stale = subject.update(LOADING, game(time=200, race="Zerg"), 3)
    assert stale.mode == "loading" and stale.curtain
    assert stale.opponent_race is None
    fresh = subject.update(LOADING, game(race="Terran", opponent="NextOpponent"), 3.1)
    assert fresh.opponent_race == "Terran"


def test_random_is_latched_even_if_api_resolves_race_during_loading_or_playing():
    subject = policy()
    assert subject.update(LOADING, game(race="random"), 0).opponent_race == "Random"
    assert subject.update(LOADING, game(race="Zerg"), 0.1).opponent_race == "Random"
    assert confirm_playing(subject, sample=game(time=1, race="Zerg")).opponent_race == "Random"


@pytest.mark.parametrize("raw,canonical", [(" Rand ", "Random"), ("P", "Protoss"), ("Terr", "Terran"), ("?", None)])
def test_only_known_native_race_aliases_are_canonicalized(raw, canonical):
    assert policy().update(LOADING, game(race=raw), 0).opponent_race == canonical


@pytest.mark.parametrize("hint", [None, "", "Nobody", "Unrelated#999"])
def test_unresolved_local_player_never_guesses_opponent_race(hint):
    subject = BlindModePolicy(BlindModeConfig(enabled=True), hint)
    assert subject.update(LOADING, game(), 0).opponent_race is None


@pytest.mark.parametrize("hint,raw_name", [
    ("Local#123", "Local"), ("Local", "Local#123"),
    (" LOCAL#123 ", "[Clan] Local"), ("local#123", "Local#123"),
])
def test_unique_battletag_stem_or_normalized_name_resolves_local_player(hint, raw_name):
    sample = game(race="Terran")
    sample["players"][0]["name"] = raw_name
    subject = BlindModePolicy(BlindModeConfig(enabled=True), hint)
    assert subject.update(LOADING, sample, 0).opponent_race == "Terran"


@pytest.mark.parametrize("hint,names", [
    ("Local", ["Local#123", "Local#456"]),
    ("Local#123", ["Local", "[OtherClan] Local"]),
    ("Local#123", ["Local#123", "local#123"]),
])
def test_ambiguous_normalized_names_or_battletag_stems_never_resolve(hint, names):
    sample = game()
    for player, name in zip(sample["players"], names):
        player["name"] = name
    subject = BlindModePolicy(BlindModeConfig(enabled=True), hint)
    assert subject.update(LOADING, sample, 0).opponent_race is None


def test_exact_unique_battletag_wins_when_stems_are_shared():
    sample = game(opponent="Local#456", race="Terran")
    assert policy().update(LOADING, sample, 0).opponent_race == "Terran"


def test_nonnumeric_name_suffix_is_not_fuzzily_removed():
    sample = game()
    sample["players"][0]["name"] = "Local#word"
    subject = BlindModePolicy(BlindModeConfig(enabled=True), "Local")
    assert subject.update(LOADING, sample, 0).opponent_race is None


def test_local_player_can_be_second_and_race_is_actually_opponents():
    sample = game(race="Terran")
    sample["players"].reverse()
    assert policy().update(LOADING, sample, 0).opponent_race == "Terran"


def test_duplicate_names_and_teams_never_choose_arbitrary_race():
    duplicate = game(opponent="Local#123")
    assert policy().update(LOADING, duplicate, 0).opponent_race is None
    team = game()
    team["players"].append({"name": "Third", "type": "user", "race": "Terran", "result": "Undecided"})
    assert policy().update(LOADING, team, 0).opponent_race is None


@pytest.mark.parametrize("field,value", [
    ("displayTime", -1), ("displayTime", True), ("displayTime", math.nan),
    ("displayTime", "0"), ("isReplay", True), ("isReplay", None),
])
def test_invalid_or_non_loading_game_never_supplies_race(field, value):
    sample = game()
    sample[field] = value
    assert policy().update(LOADING, sample, 0).opponent_race is None


def test_race_remains_unknown_if_loading_was_missed():
    subject = policy()
    result = confirm_playing(subject, sample=game(time=20, race="Zerg"))
    assert result.mode == "playing" and result.opponent_race is None


def test_replay_released_only_after_native_gameplay_confirmation():
    subject = policy()
    loading = subject.update(LOADING, game(replay=True), 0)
    assert loading.mode == "loading" and loading.curtain
    result = confirm_playing(subject, sample=game(replay=True))
    assert result.mode == "replay" and not result.curtain
    assert result.masks == () and result.opponent_race is None


def test_valid_loading_can_last_longer_than_failure_safety_deadline():
    subject = policy(max_curtain_seconds=2)
    subject.update(LOADING, game(), 0)
    assert subject.update(LOADING, game(), 30).curtain
    assert subject.update(None, None, 31).curtain
    downgraded = subject.update(None, None, 32)
    assert downgraded.mode == "unavailable" and not downgraded.curtain
    assert set(subject.config.loading_masks).issubset(downgraded.masks)
    assert set(subject.config.chat_masks).issubset(downgraded.masks)
    assert not set(subject.config.score_masks).intersection(downgraded.masks)
    assert downgraded.opponent_race is None
    assert subject.update(LOADING, None, 33).opponent_race is None


def test_api_recovery_into_gameplay_does_not_recreate_expired_curtain():
    subject = policy(max_curtain_seconds=2)
    subject.update(LOADING, game(), 0)
    assert not subject.update(None, None, 3).curtain
    assert not subject.update(PLAYING, None, 4).curtain
    assert subject.update(PLAYING, None, 4.2).mode == "playing"


def test_default_missing_ui_deadline_is_one_and_a_half_seconds():
    subject = policy()
    subject.update(LOADING, game(), 0)
    assert subject.update(None, None, 1.49).curtain
    expired = subject.update(None, None, 1.5)
    assert not expired.curtain
    assert expired.masks == subject.config.loading_masks + subject.config.chat_masks


def test_loading_recovery_after_long_gap_cannot_replace_random_with_resolved_race():
    subject = policy()
    subject.update(LOADING, game(race="Random"), 0)
    assert subject.update(None, None, 2).opponent_race is None
    assert subject.update(LOADING, game(race="Zerg"), 3).opponent_race is None
    confirm_playing(subject, sample=game(time=10, race="Zerg"), now=4)
    assert subject.update(LOADING, game(race="Terran", opponent="Next"), 5).opponent_race == "Terran"


def test_hint_change_after_random_was_seen_cannot_reveal_resolved_race():
    subject = policy()
    subject.update(LOADING, game(race="Random"), 0)
    subject.set_user_name_hint("Local")
    assert subject.update(LOADING, game(race="Zerg"), 0.1).opponent_race is None


def test_initial_hint_arriving_during_loading_can_resolve_race():
    subject = BlindModePolicy(BlindModeConfig(enabled=True))
    subject.update(LOADING, game(), 0)
    subject.set_user_name_hint("Local#123")
    assert subject.update(LOADING, game(), 0.1).opponent_race == "Protoss"


def test_api_failure_after_gameplay_keeps_only_chat_and_warns_loading_unavailable():
    subject = policy()
    confirm_playing(subject, sample=game(time=50))
    for now in (3, 4, 100):
        missing = subject.update(None, None, now)
        assert missing.mode == "unavailable" and not missing.curtain
        assert missing.masks == subject.config.chat_masks
        assert "loading protection unavailable" in missing.status
    recovered = subject.update(LOADING, None, 101)
    assert recovered.curtain and recovered.mode == "loading"


def test_unknown_overlay_screen_during_gameplay_never_adds_large_result_mask():
    subject = policy()
    confirm_playing(subject, sample=game(time=50))
    unknown = subject.update({"activeScreens": ["ScreenFutureOverlay"]}, None, 3)
    assert unknown.masks == subject.config.chat_masks and not unknown.curtain


def test_replay_api_failure_is_limited_to_chat_mask():
    subject = policy()
    confirm_playing(subject, sample=game(replay=True))
    assert subject.update(None, None, 5).masks == subject.config.chat_masks


@pytest.mark.parametrize("ui", [None, {}, {"activeScreens": None}, {"activeScreens": "ScreenLoading"}, {"activeScreens": [17]}, {"activeScreens": ["UnknownFutureScreen"]}])
def test_unknown_ui_arms_panels_without_covering_entire_desktop(ui):
    subject = policy()
    result = subject.update(ui, game(time=10), 0)
    assert result.mode == "unavailable" and not result.curtain
    assert set(subject.config.loading_masks).issubset(result.masks)


def test_score_adds_calibrated_score_masks_and_clears_race():
    subject = policy()
    subject.update(LOADING, game(), 0)
    score = subject.update(SCORE, game(time=300), 1)
    assert score.mode == "armed" and score.opponent_race is None
    assert set(subject.config.score_masks).issubset(score.masks)
    assert not score.curtain


def test_panels_style_never_creates_full_curtain():
    subject = policy(loading_style="panels")
    assert not subject.update(LOADING, game(), 0).curtain
    assert not subject.update(None, None, 1).curtain


def test_disable_removes_masks_and_reenable_does_not_reuse_match_race():
    subject = policy()
    subject.update(LOADING, game(), 0)
    subject.set_config(replace(subject.config, enabled=False))
    assert subject.snapshot.mode == "off" and subject.snapshot.masks == ()
    assert subject.update(LOADING, game(), 1).mode == "off"
    subject.set_config(replace(subject.config, enabled=True))
    assert subject.update(LOADING, None, 2).opponent_race is None


def test_config_roundtrip_preserves_calibration_and_optional_separate_toggle():
    config = BlindModeConfig(
        enabled=True,
        loading_style="panels",
        loading_masks=(NormalizedRect(0.1, 0.2, 0.3, 0.4),),
        chat_masks=(NormalizedRect(0, 0.1, 0.5, 0.2),),
        score_masks=(NormalizedRect(0.2, 0.3, 0.5, 0.6),),
        max_curtain_seconds=4.5,
        borderless_confirmed=True,
        calibrated_aspect_ratio=16 / 9,
        coverage_verified=True,
    )
    saved = config.to_dict()
    assert BlindModeConfig.from_dict(saved) == config
    saved.pop("enabled")
    assert BlindModeConfig.from_dict(saved) == replace(config, enabled=False)
    assert BlindModeConfig.from_dict(None) == BlindModeConfig()


@pytest.mark.parametrize("group", ["loading_masks", "chat_masks", "score_masks"])
def test_mask_groups_are_required_and_bounded(group):
    rect = NormalizedRect(0, 0, 0.2, 0.2).to_dict()
    with pytest.raises(ValueError):
        BlindModeConfig.from_dict({group: []})
    with pytest.raises(ValueError):
        BlindModeConfig.from_dict({group: [rect] * 9})
    assert len(getattr(BlindModeConfig.from_dict({group: [rect] * 8}), group)) == 8


@pytest.mark.parametrize("raw", [
    {"borderless_confirmed": 1}, {"coverage_verified": "true"},
    {"calibrated_aspect_ratio": 0.49}, {"calibrated_aspect_ratio": 4.01},
    {"calibrated_aspect_ratio": math.nan}, {"calibrated_aspect_ratio": True},
    {"calibrated_aspect_ratio": 10 ** 999},
])
def test_invalid_coverage_metadata_is_rejected(raw):
    with pytest.raises(ValueError):
        BlindModeConfig.from_dict(raw)


@pytest.mark.parametrize("aspect", [None, 0.5, 16 / 9, 4.0])
def test_valid_calibration_aspect_ratio_boundaries(aspect):
    config = BlindModeConfig.from_dict({"calibrated_aspect_ratio": aspect})
    assert config.calibrated_aspect_ratio == aspect


@pytest.mark.parametrize("rect", [
    (-0.01, 0, 0.5, 0.5), (0, -0.01, 0.5, 0.5), (0, 0, 0, 0.5),
    (0, 0, 0.5, -1), (0.8, 0, 0.3, 0.5), (0, 0.8, 0.5, 0.3),
    (math.nan, 0, 0.5, 0.5), (0, 0, math.inf, 0.5), (True, 0, 0.5, 0.5),
])
def test_invalid_rectangles_are_rejected_before_any_native_window_is_positioned(rect):
    with pytest.raises(ValueError):
        NormalizedRect(*rect)


@pytest.mark.parametrize("raw", [
    [], {"loading_style": "blur"}, {"enabled": "false"},
    {"loading_masks": []}, {"loading_masks": "bad"},
    {"loading_masks": [{}]}, {"chat_masks": [{"x": 0, "y": 0, "width": 2, "height": 1}]},
    {"max_curtain_seconds": math.inf}, {"max_curtain_seconds": 0},
])
def test_corrupt_configuration_is_rejected(raw):
    with pytest.raises(ValueError):
        BlindModeConfig.from_dict(raw)
