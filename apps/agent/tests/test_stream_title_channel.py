"""Channel tags and category guard: tag rules, settings, cloud receipts, game-start flow."""
from types import SimpleNamespace
import copy

import pytest

from sc2tools_agent.streaming.cloud_client import CloudStreamError, CloudStreamingClient
from sc2tools_agent.streaming.service import StreamService
from sc2tools_agent.streaming.title_channel import channel_tags, valid_tag
from sc2tools_agent.streaming.title_settings import configure_title_settings, load_title_settings
from tests.test_stream_title_controller import deny_network, live_event  # noqa: F401

PLATFORMS = {"twitch": True, "kick": True, "youtube": False}
MATCH = {"gameKey": "game-one", "opponent": "Barcode", "alias": "", "race": "Protoss", "opponentRace": "Zerg",
         "map": "Alcyone LE"}


def test_tags_follow_mode_matchup_race_and_league_in_that_order():
    stats = {"league": "Diamond", "currentMatch": MATCH, "tagContext": {"custom": True, "series": True}}
    assert channel_tags(stats) == ["ViewerGames", "Tournament", "PvZ", "Protoss", "Diamond"]
    assert channel_tags({**stats, "tagContext": {"custom": False, "series": False}}) == ["PvZ", "Protoss", "Diamond"]


def test_missing_facts_are_left_out_never_guessed():
    assert channel_tags({}) == [] and channel_tags(None) == []
    assert channel_tags({"league": "Platinum"}) == ["Platinum"]
    assert channel_tags({"currentMatch": {**MATCH, "opponentRace": "Random"}}) == ["Protoss"]
    assert channel_tags({"league": "Wood", "currentMatch": {**MATCH, "race": "Elf"}}) == []


@pytest.mark.parametrize("tag", ["has space", "Pv-Z", "x" * 26, "", "Z\u00fcrich", None, 5])
def test_a_tag_that_breaks_a_platform_rule_is_invalid(tag):
    assert not valid_tag(tag)


def test_valid_tag_accepts_the_limits():
    assert valid_tag("x" * 25) and valid_tag("PvZ2")


def test_switches_start_off_strict_booleans_need_twitch_or_kick_and_keep_titles_optional():
    assert load_title_settings({}, "owner")["channel_tags"] is False
    base = {"enabled": False, "template": "", "platforms": PLATFORMS}
    saved = configure_title_settings(load_title_settings({}, "owner"), {**base, "channel_tags": True}, "owner")
    assert saved["channel_tags"] is True and saved["category_guard"] is False and saved["template"] == ""
    with pytest.raises(ValueError):
        configure_title_settings(saved, {**base, "channel_tags": "yes"}, "owner")
    youtube_only = {**PLATFORMS, "twitch": False, "kick": False, "youtube": True}
    with pytest.raises(ValueError):
        configure_title_settings(saved, {**base, "category_guard": True, "platforms": youtube_only}, "owner")
    with pytest.raises(ValueError):
        configure_title_settings(saved, {**base, "channel_tags": True}, "")


def test_saved_tag_receipts_survive_a_reload_and_drop_invalid_entries():
    loaded = load_title_settings({"owner": "owner", "last_tags": {"twitch": ["PvZ", "bad tag", 3], "youtube": ["X"]},
                                  "last_channel_game": "game-one"}, "owner")
    assert loaded["last_tags"] == {"twitch": ["PvZ"]} and loaded["last_channel_game"] == "game-one"


def client_with(answer):
    calls = []

    def transport(method, url, **kwargs):
        calls.append((method, url, kwargs.get("json")))
        return answer(url, kwargs.get("json"))
    return CloudStreamingClient(lambda: ("https://api.sc2tools.com", "token"), transport=transport), calls


def test_cloud_receipts_are_validated_and_filtered():
    client, calls = client_with(lambda url, body: SimpleNamespace(status_code=200, json=lambda: {
        "platform": body["platform"], "ok": True, "status": "updated", "added": ["PvZ", "bad tag"], "tags": ["secret"]}))
    assert client.set_tags("twitch", ["PvZ"], ["Old"]) == {"status": "updated", "reason": "", "added": ["PvZ"]}
    assert calls[0][1].endswith("/v1/agent/streaming/tags")
    assert calls[0][2] == {"platform": "twitch", "tags": ["PvZ"], "previous": ["Old"]}
    assert client.ensure_category("kick")["status"] == "updated"
    assert calls[1][2] == {"platform": "kick"}


@pytest.mark.parametrize("payload", [[], {"platform": "kick", "status": "updated"}, {"platform": "twitch", "status": "done"}])
def test_an_incomplete_receipt_is_an_error(payload):
    client, _ = client_with(lambda url, body: SimpleNamespace(status_code=200, json=lambda: payload))
    with pytest.raises(CloudStreamError):
        client.set_tags("twitch", ["PvZ"], [])


@pytest.fixture
def service(tmp_path):
    calls, fail, on_get = [], [], []
    stats = {"schema": 1, "league": "Diamond", "session": {"wins": 1, "losses": 0},
             "currentMatch": dict(MATCH), "tagContext": {"custom": False, "series": True}}

    def transport(method, url, **kwargs):
        calls.append((method, url, kwargs.get("json")))
        if method == "GET":
            for hook in on_get:
                hook()
            return SimpleNamespace(status_code=200, json=lambda: copy.deepcopy(stats))
        body = kwargs["json"]
        if url.endswith("/title"):
            platform = body["platforms"][0]
            return SimpleNamespace(status_code=200, json=lambda: {"platforms": [{"platform": platform, "connected": True,
                "streamingReady": True, "title": body["title"], "requestedTitle": body["title"], "accepted": True,
                "titleVerified": True, "titleStatus": "verified"}]})
        if fail:
            return SimpleNamespace(status_code=500, json=lambda: {})
        return SimpleNamespace(status_code=200, json=lambda: {"platform": body["platform"], "ok": True,
            "status": "updated", "added": body.get("tags", [])})
    client = CloudStreamingClient(lambda: ("https://api.sc2tools.com", "token"), transport=transport)
    instance = StreamService(tmp_path, lambda: {}, no_obs=True, cloud_client=client)
    instance.served_stats, instance.on_get = stats, on_get
    yield instance, calls, fail
    instance.close()


def start_game(instance, key="game-one", at=1200, **switches):
    payload = {"action": "configure_title_automation", "enabled": False, "template": "SC2 | {mmr} | {record}",
               "platforms": PLATFORMS, **switches}
    instance.action(payload)
    now = [at]
    instance.titles.worker.clock = lambda: now[0]
    instance.titles.worker.preview_pending = False
    instance.on_game_event(live_event(now[0], key=key))
    now[0] += 3
    return now


def writes(calls, suffix):
    return [call for call in calls if call[0] == "POST" and call[1].endswith(suffix)]


def test_saving_the_switches_sends_nothing(service):
    instance, calls, _ = service
    instance.action({"action": "configure_title_automation", "enabled": False, "template": "SC2", "platforms": PLATFORMS,
                     "channel_tags": True, "category_guard": True})
    assert not [call for call in calls if call[0] == "POST"]
    assert instance.titles.snapshot()["channel_tags"] is True


def test_tags_and_category_go_out_once_at_game_start_without_a_title(service):
    instance, calls, _ = service
    start_game(instance, channel_tags=True, category_guard=True)
    assert instance.titles.worker.run_once() is True
    tags = writes(calls, "/tags")
    assert [call[2]["platform"] for call in tags] == ["twitch", "kick"]
    assert tags[0][2]["tags"] == ["Tournament", "PvZ", "Protoss", "Diamond"]
    assert [call[2]["platform"] for call in writes(calls, "/category")] == ["twitch", "kick"]
    assert not writes(calls, "/title")
    assert instance.titles.settings["last_tags"]["twitch"] == ["Tournament", "PvZ", "Protoss", "Diamond"]
    assert "Twitch tags: Tournament" in instance.titles.snapshot()["channel_message"]
    instance.on_game_event(live_event(1203, phase="match_started", display_time=1))
    assert instance.titles.worker.run_once() is False
    assert len(writes(calls, "/tags")) == 2


def test_the_next_game_replaces_only_the_tags_we_wrote_for_the_last_one(service):
    instance, calls, _ = service
    start_game(instance, channel_tags=True)
    instance.titles.worker.run_once()
    instance.on_game_event(live_event(1204, key="game-two", phase="menu"))
    instance.on_game_event(live_event(1205, key="game-three"))
    instance.titles.worker.clock = lambda: 1210
    instance.served_stats["currentMatch"]["gameKey"] = "game-three"
    instance.titles.worker.run_once()
    assert len(writes(calls, "/tags")) == 4
    assert writes(calls, "/tags")[2][2]["previous"] == ["Tournament", "PvZ", "Protoss", "Diamond"]


def test_a_failed_channel_update_never_blocks_the_title_and_is_not_retried(service):
    instance, calls, fail = service
    fail.append(True)
    start_game(instance, channel_tags=True, category_guard=True, on_game_start=True, template="SC2 | v {opp}")
    assert instance.titles.worker.run_once() is True
    assert [call[2]["platforms"] for call in writes(calls, "/title")] == [["twitch"], ["kick"]]
    assert "could not be confirmed" in instance.titles.snapshot()["channel_message"]
    assert instance.titles.settings["last_tags"]["twitch"] == ["Tournament", "PvZ", "Protoss", "Diamond"]
    count = len(calls)
    instance.titles.worker.run_once()
    assert len(calls) == count


def test_the_title_is_sent_before_tags_and_category(service):
    instance, calls, _ = service
    start_game(instance, channel_tags=True, category_guard=True, on_game_start=True, template="SC2 | v {opp}")
    instance.titles.worker.run_once()
    order = [call[1].rsplit("/", 1)[-1] for call in calls if call[0] == "POST"]
    assert order.index("title") < order.index("tags") < order.index("category")


def test_channel_switches_do_not_hold_back_post_sync_titles(service):
    instance, _, _ = service
    start_game(instance, channel_tags=True)
    match = instance.titles.worker.match
    assert match.enabled is True and match.titles is False
    assert instance.titles.worker._sync_is_current(instance.titles.worker._sync_generation)


def test_nothing_is_sent_with_the_switches_off(service):
    instance, calls, _ = service
    start_game(instance)
    instance.titles.worker.run_once()
    assert not [call for call in calls if call[0] == "POST"]


def test_unticking_game_start_titles_during_the_fetch_stops_the_title_but_not_the_channel_work(service):
    instance, calls, _ = service
    start_game(instance, channel_tags=True, on_game_start=True, template="SC2 | v {opp}")
    titles = instance.titles
    instance.on_get.append(lambda: titles.settings.update(on_game_start=False))
    titles.worker.run_once()
    assert not writes(calls, "/title")
    assert writes(calls, "/tags")


def test_the_tag_preview_is_empty_when_no_game_is_loading():
    from sc2tools_agent.streaming.title_channel_controller import ChannelUpdateMixin

    class Idle(ChannelUpdateMixin):
        def _title_stats(self):
            return {"league": "Diamond", "tagContext": {"series": True}}

    assert Idle().tag_preview() == []


def test_a_cached_snapshot_stops_naming_the_ended_games_tags(service):
    instance, _, _ = service
    cached = {"match_game_key": "game-one", "values": {"race": "Protoss"}, "tag_preview": ["PvZ"]}
    scoped = instance.titles.scope_snapshot(cached)
    assert scoped["tag_preview"] == [] and "race" not in scoped["values"]


@pytest.mark.parametrize("answer", [RuntimeError("timeout"), {"status": "failed", "reason": "Twitch is unavailable."}])
def test_tags_whose_receipt_was_lost_still_count_as_ours(service, answer):
    instance, _, _ = service
    titles = instance.titles
    titles.settings["last_tags"]["twitch"] = ["PvZ"]

    class Lost:
        def set_tags(self, *_):
            if isinstance(answer, Exception):
                raise answer
            return answer

    titles._send_tags("twitch", ["PvT"], Lost())
    assert titles.settings["last_tags"]["twitch"] == ["PvT", "PvZ"]
