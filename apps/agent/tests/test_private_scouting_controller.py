from tests.build_checkin_fakes import Harness, ManualExecutor, OPP, cloud_game, envelope, game_state


def brief(key, *, note="Private note", opponent=OPP):
    return {"gameKey": key, "oppName": opponent, "pulseId": "1-S2-1-42",
            "h2h": {"w": 3, "l": 2}, "note": note}


def model(h):
    return h.view.last("show_loading", "update_loading")


def drain(h):
    for _ in range(10):
        h.executor.run_all(); h.pump()
        if not h.executor.jobs:
            return
    raise AssertionError("scouting actor did not settle")


def upload(h, key, pulse_id=None):
    game = cloud_game("game-1", started=int(key.rsplit("|", 1)[1]) / 1000 + 8)
    if pulse_id is not None:
        game.opponent["toonHandle"] = pulse_id
    h.api.games[game.game_id] = game_state(game.game_id)
    h.accept(game)


def test_socket_brief_updates_only_the_current_game_and_opponent():
    h = Harness().boot(); key = h.new_key()
    h.send(envelope("match_loading", key))
    h.ctl.on_scouting_brief(brief("old")); h.pump()
    h.ctl.on_scouting_brief(brief(key, opponent="Someone else")); h.pump()
    assert model(h).scouting is None
    h.ctl.on_scouting_brief(brief(key)); h.pump()
    assert model(h).scouting.record_line == "You 3–2"
    h.send(envelope("match_in_progress", key, display_time=45))
    assert h.view.of("hide_loading")[-1] == (key, "in_game")


def test_dont_ask_uses_slim_card_only_after_real_brief_and_closes_locally():
    h = Harness(); h.api.prefs["askAtLoading"] = False; h.boot()
    key = h.new_key(); h.send(envelope("match_loading", key))
    assert not h.view.of("show_loading")
    h.ctl.on_scouting_brief(brief(key)); h.pump()
    assert model(h).scouting_only and model(h).heading == "Private scouting"
    assert not h.api.live_actions()
    h.ctl.dismiss_scouting(key); h.pump()
    h.ctl.on_scouting_brief(brief(key, note="Updated")); h.pump()
    assert len(h.view.of("show_loading")) == 1
    assert h.view.of("hide_loading")[-1] == (key, "dismissed")
    assert not h.api.live_actions()


def test_global_off_and_local_scouting_off_do_not_show_slim_card():
    for disabled in ("enabled", "local"):
        h = Harness(); h.api.prefs["askAtLoading"] = False
        if disabled == "enabled": h.api.prefs["enabled"] = False
        h.boot()
        if disabled == "local": h.ctl.set_scouting_enabled(False); h.pump()
        key = h.new_key(); h.send(envelope("match_loading", key))
        h.ctl.on_scouting_brief(brief(key)); h.pump()
        assert not h.view.of("show_loading")


def test_fallback_is_single_flight_with_bounded_retry_and_no_blocking_actor():
    h = Harness(); calls = []
    def read(key):
        calls.append(key)
        raise ConnectionError("offline")
    h.api.get_scouting_brief = read
    h.boot(); key = h.new_key(); h.send(envelope("match_loading", key))
    for _ in range(4):
        h.advance(1); h.send(envelope("match_loading", key))
    assert calls == [key]
    h.advance(1); h.send(envelope("match_loading", key))
    assert calls == [key, key]
    assert model(h).scouting is None


def test_late_fallback_from_previous_game_cannot_overwrite_new_brief():
    h = Harness(executor=ManualExecutor()).boot(); drain(h)
    h.api.get_scouting_brief = lambda key: brief(key, note=key)
    old = h.new_key(); h.send(envelope("match_loading", old))
    new = h.new_key(); h.send(envelope("match_loading", new))
    drain(h)
    assert model(h).game_key == new and model(h).scouting.note == new
    for name, value in h.view.calls:
        if name in ("show_loading", "update_loading") and value.game_key == new and value.scouting:
            assert value.scouting.note != old


def test_dossier_uses_safe_local_origin_and_visibility_setting_has_own_persistence():
    h = Harness().boot(); saved = []
    h.ctl._on_scouting_changed = saved.append
    key = h.new_key(); h.send(envelope("match_loading", key))
    h.ctl.on_scouting_brief({**brief(key), "dossierUrl": "https://bad.invalid"}); h.pump()
    h.ctl.open_scouting_dossier(key); h.pump()
    assert h.opened == ["https://sc2tools.test/app/opponents/1-S2-1-42"]
    cloud_writes = list(h.api.calls_to("put_checkin_prefs"))
    h.ctl.set_scouting_enabled(False); h.pump()
    assert saved == [False] and model(h).scouting is None
    assert h.api.calls_to("put_checkin_prefs") == cloud_writes


def test_postgame_private_note_uses_opponent_endpoint_and_preserves_game_notes():
    h = Harness().boot(); writes = []
    h.api.put_opponent_note = lambda identity, note: writes.append((identity, note)) or {"notes": note}
    key = h.new_key(); h.send(envelope("match_loading", key))
    h.ctl.on_scouting_brief(brief(key)); h.pump()
    h.play(key)
    upload(h, key)
    card = h.view.last("show_postgame", "update_postgame")
    assert card.opponent_note == "Private note" and card.opponent_pulse_id == "1-S2-1-42"
    h.ctl.update_opponent_note(card.card_id, "Next time: watch the ramp "); h.pump()
    h.ctl.save_opponent_note(card.card_id, "Next time: watch the ramp "); h.pump()
    assert writes == [("1-S2-1-42", "Next time: watch the ramp ")]
    saved = h.view.last("update_postgame")
    assert saved.opponent_note_status == "Saved for next time."
    assert saved.notes == ""  # game check-in notes are a separate field


def test_private_note_failure_stays_retryable_and_does_not_hide_the_card():
    h = Harness().boot(); key = h.new_key(); h.send(envelope("match_loading", key))
    h.ctl.on_scouting_brief(brief(key)); h.pump(); h.play(key)
    upload(h, key)
    card = h.view.last("show_postgame", "update_postgame")
    def fail(*_): raise ConnectionError("offline")
    h.api.put_opponent_note = fail
    h.ctl.save_opponent_note(card.card_id, "Keep this draft"); h.pump()
    value = h.view.last("update_postgame")
    assert value.opponent_note == "Keep this draft" and not value.opponent_note_busy
    assert value.opponent_note_status == "Couldn't save note. Try again."
    assert not h.view.of("hide_postgame")


def test_private_note_waits_for_replay_upload_before_writing_a_new_opponent():
    h = Harness().boot(); key = h.new_key(); h.send(envelope("match_loading", key))
    h.ctl.on_scouting_brief(brief(key)); h.pump(); h.play(key)
    card = h.view.last("show_postgame", "update_postgame"); writes = []
    h.api.put_opponent_note = lambda *args: writes.append(args)
    h.ctl.save_opponent_note(card.card_id, "Next time"); h.pump()
    assert not writes


def test_replay_identity_enables_first_meeting_note_without_a_live_pulse_lookup():
    h = Harness().boot(); key = h.new_key(); h.play(key)
    assert h.view.last("show_postgame", "update_postgame").opponent_pulse_id is None
    upload(h, key, "1-S2-1-99")
    assert h.view.last("show_postgame", "update_postgame").opponent_pulse_id == "1-S2-1-99"


def test_replay_identity_drops_an_untouched_note_from_a_different_toon():
    h = Harness().boot(); key = h.new_key(); h.send(envelope("match_loading", key))
    h.ctl.on_scouting_brief(brief(key)); h.pump(); h.play(key)
    upload(h, key, "1-S2-1-99")
    value = h.view.last("show_postgame", "update_postgame")
    assert value.opponent_pulse_id == "1-S2-1-99" and value.opponent_note == ""


def test_explicit_reenable_restores_cached_scouting_but_not_a_dismissed_card():
    h = Harness(); h.api.prefs["askAtLoading"] = False; h.boot()
    key = h.new_key(); h.send(envelope("match_loading", key))
    h.ctl.on_scouting_brief(brief(key)); h.pump()
    h.ctl.set_scouting_enabled(False); h.pump()
    h.ctl.set_scouting_enabled(True); h.pump()
    assert len(h.view.of("show_loading")) == 2
    h.ctl.dismiss_scouting(key); h.pump()
    h.ctl.set_scouting_enabled(True); h.pump()
    assert len(h.view.of("show_loading")) == 2


def test_new_postgame_card_does_not_copy_another_resolved_accounts_note():
    h = Harness().boot(); key = h.new_key(); h.send(envelope("match_loading", key))
    h.ctl.on_scouting_brief(brief(key)); h.pump()
    game = h.ctl._games[key]
    # A replay may bind the authoritative account before the first end card.
    game.opponent_pulse_id = "1-S2-1-99"
    card = h.ctl._new_card(game)
    assert card.opponent_pulse_id == "1-S2-1-99" and card.opponent_note == ""
