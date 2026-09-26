import json

import pytest

from pluto_sc2.coach_orders import CoachMailbox, MAX_ORDER_BYTES, StrategyOrder, write_strategy


def payload(**updates):
    data = {"schema": 1, "game_id": "game-one", "revision": 1, "based_on_report": 2,
            "issued_game_seconds": 10, "valid_until_game_seconds": 100,
            "stance": "pressure", "scout": True, "worker_target": 32, "base_target": 2,
            "gas_workers_per_base": 3, "production_targets": {"GATEWAY": 3, "ROBOTICSFACILITY": 1},
            "composition": {"STALKER": 10, "ZEALOT": 4, "OBSERVER": 1},
            "research": ["WARPGATERESEARCH", "BLINKTECH"], "rationale": "Scout and build a balanced army."}
    data.update(updates)
    return data


def audits(directory):
    return sorted((directory / "coach-order-audit").glob("*.json"))


def test_order_round_trip_copies_mutable_inputs_and_uses_immutable_collections():
    data = payload()
    order = StrategyOrder.from_dict(data)
    assert order.to_dict() == data
    assert StrategyOrder.from_dict(order.to_dict()) == order
    data["composition"]["STALKER"] = 99
    data["research"].clear()
    assert order.composition["STALKER"] == 10
    assert order.research == ("WARPGATERESEARCH", "BLINKTECH")
    with pytest.raises(TypeError):
        order.production_targets["GATEWAY"] = 12


@pytest.mark.parametrize("updates", [
    {"schema": True}, {"schema": 2}, {"game_id": ""}, {"game_id": 1},
    {"revision": True}, {"revision": 0}, {"revision": 1.0}, {"based_on_report": -1},
    {"issued_game_seconds": float("nan")}, {"issued_game_seconds": float("inf")},
    {"issued_game_seconds": True}, {"issued_game_seconds": -1},
    {"valid_until_game_seconds": 10}, {"valid_until_game_seconds": 611},
    {"stance": "execute_code"}, {"scout": 1}, {"worker_target": 7}, {"worker_target": 81},
    {"worker_target": True}, {"base_target": 0}, {"base_target": 9},
    {"gas_workers_per_base": 7}, {"gas_workers_per_base": -1},
    {"production_targets": {"NEXUS": 1}}, {"production_targets": {"PYLON": 1}},
    {"production_targets": {"ASSIMILATOR": 1}}, {"production_targets": {"GATEWAY": 13}},
    {"production_targets": {"GATEWAY": True}}, {"production_targets": []},
    {"composition": {"PROBE": 3}}, {"composition": {"STALKER": 101}},
    {"composition": {"STALKER": 0}}, {"composition": {}}, {"composition": {"STALKER": 2.5}},
    {"research": ["UNSAFE"]}, {"research": ["BLINKTECH", "BLINKTECH"]},
    {"research": "BLINKTECH"}, {"research": [True]}, {"rationale": "x" * 2001}, {"rationale": None},
])
def test_strict_schema_rejects_invalid_types_ranges_names_and_horizons(updates):
    with pytest.raises(ValueError):
        StrategyOrder.from_dict(payload(**updates))


def test_missing_and_unknown_fields_are_rejected_and_boundaries_are_valid():
    data = payload()
    del data["scout"]
    with pytest.raises(ValueError, match="missing"):
        StrategyOrder.from_dict(data)
    with pytest.raises(ValueError, match="unknown"):
        StrategyOrder.from_dict(payload(python="arbitrary code"))
    order = StrategyOrder.from_dict(payload(issued_game_seconds=0, valid_until_game_seconds=600,
                                            worker_target=80, base_target=8, gas_workers_per_base=6,
                                            production_targets={"GATEWAY": 12},
                                            composition={"STALKER": 100, "ZEALOT": 0}, research=[]))
    assert order.valid_until_game_seconds == 600


def test_atomic_write_and_mailbox_accept_new_revisions_and_deduplicate_polling(tmp_path):
    box = CoachMailbox(tmp_path, "game-one")
    assert box.poll(10, 2) is None
    assert box.status["last_status"] == "missing"
    write_strategy(tmp_path / "strategy.json", payload())
    first = box.poll(10, 2)
    assert first.revision == 1
    original_audit = audits(tmp_path)[0].read_bytes()
    assert box.poll(11, 3) is first
    assert len(audits(tmp_path)) == 1
    assert audits(tmp_path)[0].read_bytes() == original_audit
    write_strategy(tmp_path / "strategy.json", payload(revision=2, based_on_report=3, stance="defend"))
    assert box.poll(12, 3).stance == "defend"
    assert box.status["accepted_revision"] == 2
    assert box.status["accepted_orders"] == 2
    assert len(audits(tmp_path)) == 2
    assert not list(tmp_path.glob(".strategy-*.tmp"))


@pytest.mark.parametrize("updates,diagnostic", [
    ({"game_id": "another-game", "revision": 2}, "different game"),
    ({"revision": 1, "stance": "attack"}, "revision is stale"),
    ({"revision": 2, "based_on_report": 4}, "future report"),
    ({"revision": 2, "issued_game_seconds": 30}, "future issue time"),
    ({"revision": 2, "issued_game_seconds": 0, "valid_until_game_seconds": 15}, "expired"),
])
def test_invalid_replacement_keeps_current_valid_order_and_audits_digest_once(tmp_path, updates, diagnostic):
    box = CoachMailbox(tmp_path, "game-one")
    write_strategy(tmp_path / "strategy.json", payload())
    current = box.poll(10, 2)
    write_strategy(tmp_path / "strategy.json", payload(**updates))
    assert box.poll(20, 3) is current
    assert diagnostic in box.status["diagnostic"]
    assert box.status["last_status"] == "rejected"
    assert box.status["active_revision"] == 1
    count = len(audits(tmp_path))
    assert box.poll(21, 3) is current
    assert len(audits(tmp_path)) == count == 2
    assert box.status["rejected_contents"] == 1


def test_expiry_removes_active_order_without_rewriting_history(tmp_path):
    box = CoachMailbox(tmp_path, "game-one")
    write_strategy(tmp_path / "strategy.json", payload())
    assert box.poll(10, 2) is not None
    evidence = audits(tmp_path)[0].read_bytes()
    assert box.poll(100, 2) is None
    assert box.status["last_status"] == "expired"
    assert box.status["accepted_revision"] == 1
    assert box.status["active_revision"] is None
    assert len(audits(tmp_path)) == 1
    assert audits(tmp_path)[0].read_bytes() == evidence


@pytest.mark.parametrize("broken", [b'{"schema":', b'\xffinvalid utf8',
                                     b'{"schema":1,"schema":1}', b'{"x":NaN}',
                                     b'[]', b'null', b'[' * 1100 + b']' * 1100])
def test_partial_malformed_or_duplicate_json_is_diagnostic_and_keeps_current(tmp_path, broken):
    box = CoachMailbox(tmp_path, "game-one")
    write_strategy(tmp_path / "strategy.json", payload())
    current = box.poll(10, 2)
    (tmp_path / "strategy.json").write_bytes(broken)
    assert box.poll(20, 2) is current
    assert box.status["last_status"] == "rejected"
    assert box.poll(100, 2) is None  # Malformed replacement cannot extend the old order.


def test_oversized_order_is_rejected_before_json_decode_and_audited_once(tmp_path, monkeypatch):
    box = CoachMailbox(tmp_path, "game-one")
    (tmp_path / "strategy.json").write_bytes(b" " * (MAX_ORDER_BYTES + 1000))
    monkeypatch.setattr("pluto_sc2.coach_orders.json.loads", lambda *_args, **_kwargs: pytest.fail("must not decode"))
    assert box.poll(0, 0) is None
    assert "exceeds 64 KB" in box.status["diagnostic"]
    box.poll(1, 0)
    assert len(audits(tmp_path)) == 1
    # Read with a separate parser after restoring the mock.
    monkeypatch.undo()
    evidence = json.loads(audits(tmp_path)[0].read_text())
    assert evidence["digest_kind"] == "sha256_first_64KB_and_file_size"


def test_future_order_can_become_valid_without_duplicate_rejection_records(tmp_path):
    box = CoachMailbox(tmp_path, "game-one")
    write_strategy(tmp_path / "strategy.json", payload(issued_game_seconds=20, based_on_report=3))
    assert box.poll(10, 2) is None
    assert box.poll(15, 2) is None
    assert len(audits(tmp_path)) == 1
    assert box.poll(20, 3).revision == 1
    assert len(audits(tmp_path)) == 2
    assert {json.loads(path.read_text())["outcome"] for path in audits(tmp_path)} == {"accepted", "rejected"}


def test_removing_file_preserves_unexpired_order_and_status_is_a_copy(tmp_path):
    box = CoachMailbox(tmp_path, "game-one")
    write_strategy(tmp_path / "strategy.json", payload())
    current = box.poll(10, 2)
    (tmp_path / "strategy.json").unlink()
    assert box.poll(20, 2) is current
    assert box.status["last_status"] == "missing"
    status = box.status
    status["accepted_revision"] = 999
    assert box.status["accepted_revision"] == 1
    assert box.poll(100, 2) is None


@pytest.mark.parametrize("now,sequence", [(True, 0), (float("nan"), 0), (-1, 0), (0, True), (0, -1)])
def test_invalid_caller_times_and_sequences_are_rejected(tmp_path, now, sequence):
    with pytest.raises(ValueError):
        CoachMailbox(tmp_path, "game-one").poll(now, sequence)


def test_atomic_strategy_update_retries_reader_lock_without_losing_prior_order(tmp_path, monkeypatch):
    from pluto_sc2 import coach_orders
    path = tmp_path / "strategy.json"
    write_strategy(path, payload())
    original = coach_orders.os.replace
    attempts = []

    def replace(source, target):
        attempts.append(source)
        assert json.loads(path.read_text())["revision"] == 1
        if len(attempts) < 3:
            raise PermissionError("Concurrent Windows reader")
        return original(source, target)

    monkeypatch.setattr(coach_orders.os, "replace", replace)
    monkeypatch.setattr(coach_orders.time, "sleep", lambda _: None)
    write_strategy(path, payload(revision=2))
    assert len(attempts) == 3
    assert json.loads(path.read_text())["revision"] == 2
    assert list(tmp_path.iterdir()) == [path]
