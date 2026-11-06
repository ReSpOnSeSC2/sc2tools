"""Same-game identity corrections while title work is already in flight."""
from dataclasses import replace
import threading

from tests.test_stream_title_controller import (
    configure_start,
    deny_network,
    live_event,
    service,
)


OLD_KEY = "Barcode|Me|1790000000000"
NEW_KEY = "Barcode#123|Me|1790000000000"


def corrected_event(now):
    event = live_event(now, key=NEW_KEY)
    players = [event.game_state.players[0], replace(event.game_state.players[1], name="Barcode#123")]
    return replace(event, game_state=replace(event.game_state, players=players))


def test_same_game_rekey_during_slow_read_replaces_the_claim_without_extending_its_window(service):
    instance, calls, stats, _ = service
    now = configure_start(instance, stats)
    stats["currentMatch"]["gameKey"] = OLD_KEY
    instance.on_game_event(live_event(now[0], key=OLD_KEY))
    deadline = instance.titles.worker.match.pending["deadline"]
    now[0] += 3
    entered, release = threading.Event(), threading.Event()
    original = instance.cloud_client.transport

    def held(method, url, **kwargs):
        if method == "GET":
            entered.set()
            assert release.wait(3)
        return original(method, url, **kwargs)

    instance.cloud_client.transport = held
    worker = threading.Thread(target=instance.titles.worker.run_once)
    worker.start()
    try:
        assert entered.wait(3)
        stats["currentMatch"].update(gameKey=NEW_KEY, opponent="Barcode#123")
        completed = threading.Event()
        listener = threading.Thread(target=lambda: (instance.on_game_event(corrected_event(now[0])), completed.set()))
        listener.start()
        assert completed.wait(1), "The slow title read blocked identity correction"
        listener.join(1)
        pending = instance.titles.worker.match.pending
        assert pending["key"] == NEW_KEY and pending["deadline"] == deadline
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive()
    assert not any(method == "POST" for method, *_ in calls)
    now[0] += 1
    instance.titles.worker.run_once()
    writes = [call for call in calls if call[0] == "POST"]
    assert [call[2]["json"]["platforms"] for call in writes] == [["twitch"], ["kick"]]
    assert all("v Barcode#123 (aka Maru)" in call[2]["json"]["title"] for call in writes)
    assert instance.titles.settings["last_start_game"] == NEW_KEY
    instance.on_game_event(corrected_event(now[0]))
    assert not instance.titles.worker.run_once()


def test_same_game_rekey_after_an_ambiguous_provider_attempt_does_not_repeat_the_write(service):
    instance, calls, stats, _ = service
    now = configure_start(instance, stats)
    stats["currentMatch"]["gameKey"] = OLD_KEY
    original = instance.cloud_client.transport

    def ambiguous(method, url, **kwargs):
        result = original(method, url, **kwargs)
        if method == "POST":
            stats["currentMatch"].update(gameKey=NEW_KEY, opponent="Barcode#123")
            instance.on_game_event(corrected_event(now[0]))
            raise RuntimeError("private provider response was lost")
        return result

    instance.cloud_client.transport = ambiguous
    instance.on_game_event(live_event(now[0], key=OLD_KEY))
    now[0] += 3
    instance.titles.worker.run_once()
    assert len([call for call in calls if call[0] == "POST"]) == 1
    assert instance.titles.settings["last_start_game"] == OLD_KEY
    assert set(instance.titles.settings["last_titles"]) == {"twitch"}
    now[0] += 5
    instance.titles.worker.run_once()
    assert len([call for call in calls if call[0] == "POST"]) == 1
    assert not instance.titles.worker.match.pending
    assert "private provider" not in str(instance.status())
