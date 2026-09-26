from copy import deepcopy

from pluto_sc2.intent_decoder import plan_next
from test_rich_intents import action, context, normalize


def receipt(intent, frame, **fields):
    return {"wire_sha256": intent["wire_sha256"], "confirmed_loop": frame["game_loop"], **fields}


def visible_build():
    frame = context()
    intent, _ = normalize(action(881, (140, 150), (71, 43)), frame)
    return intent, frame


def placement(intent, frame, valid=True):
    return {
        "wire_sha256": intent["wire_sha256"],
        "checked_loop": frame["game_loop"],
        "target": deepcopy(intent["target"]),
        "valid": valid,
    }


def test_core_requires_paid_reframe_then_fresh_placement_selection_and_command():
    frame = context()
    intent, _ = normalize(action(), frame)
    step = plan_next(intent, frame)
    assert step["stage"] == "camera" and step["paid_input"]
    assert step["operation"]["point"] != intent["target"]["point"]  # Frame both builder and site.
    frame["camera"] = step["operation"]["point"]
    frame["game_loop"] += 1
    assert plan_next(intent, frame)["stage"] == "placement_query"
    proofs = {"placement": placement(intent, frame)}
    assert plan_next(intent, frame, confirmations=proofs)["stage"] == "select"
    proofs["selection"] = receipt(intent, frame, source_tags=[101], paid=True)
    command = plan_next(intent, frame, confirmations=proofs)
    assert command["stage"] == "command" and command["paid_input"] and not command["raw_command"]
    assert command["operation"]["target"] == intent["target"]
    proofs["command"] = receipt(intent, frame, source_tags=[101], accepted=True)
    assert plan_next(intent, frame, confirmations=proofs)["stage"] == "complete"


def test_offscreen_source_reacquisition_uses_only_own_historical_position():
    frame = context()
    frame["entities"] = []
    frame["known_own"][0]["position"] = [130, 170]
    intent, _ = normalize(action(881, (140, 150), (71, 43)), frame)
    step = plan_next(intent, frame)
    assert step["stage"] == "camera" and step["operation"]["point"] == [130, 170]
    frame["camera"] = [130, 170]
    assert plan_next(intent, frame)["reason"] == "source_absent_at_last_seen_location"


def test_long_range_worker_route_selects_and_uses_paid_minimap_move():
    frame = context()
    intent, _ = normalize(action(881, (170, 180), (127, 0)), frame)
    assert intent["admitted"]
    assert plan_next(intent, frame)["stage"] == "select"
    proof = {"selection": receipt(intent, frame, source_tags=[101], paid=True)}
    assert plan_next(intent, frame, confirmations=proof)["reason"] == "selected_worker_move_not_available"
    frame["available_abilities"].append({"ability_id": 16})
    step = plan_next(intent, frame, confirmations=proof)
    assert step["stage"] == "route_move" and step["paid_input"] and not step["raw_command"]
    assert step["operation"]["minimap"] and step["operation"]["require_observed_point_order"]


def test_selection_ui_alone_does_not_substitute_for_paid_receipt():
    intent, frame = visible_build()
    assert (
        plan_next(intent, frame, confirmations={"placement": placement(intent, frame)})["stage"] == "select"
    )


def test_selection_changes_after_receipt_require_reselection():
    intent, frame = visible_build()
    proof = {
        "selection": receipt(intent, frame, source_tags=[101], paid=True),
        "placement": placement(intent, frame),
    }
    frame["selection"] = [999]
    assert plan_next(intent, frame, confirmations=proof)["stage"] == "select"


def test_public_available_button_rechecked_after_selection():
    intent, frame = visible_build()
    proof = {
        "selection": receipt(intent, frame, source_tags=[101], paid=True),
        "placement": placement(intent, frame),
    }
    frame["available_abilities"] = []
    assert (
        plan_next(intent, frame, confirmations=proof)["reason"] == "selected_ability_not_currently_available"
    )


def test_build_requires_fresh_and_matching_placement_query():
    intent, frame = visible_build()
    proof = {"placement": placement(intent, frame)}
    proof["placement"]["checked_loop"] -= 1
    assert plan_next(intent, frame, confirmations=proof)["stage"] == "placement_query"
    proof["placement"] = placement(intent, frame, False)
    assert plan_next(intent, frame, confirmations=proof)["reason"] == "placement_not_currently_legal"


def test_rejected_command_receipt_cannot_credit_completion():
    intent, frame = visible_build()
    proof = {"command": receipt(intent, frame, source_tags=[101], accepted=False)}
    assert plan_next(intent, frame, confirmations=proof)["stage"] != "complete"


def test_production_selects_then_commands_without_placement_query():
    frame = context()
    frame["entities"][0]["type_name"] = "Nexus"
    intent, _ = normalize(action(1006, None, None), frame)
    assert plan_next(intent, frame)["stage"] == "select"
    proof = {"selection": receipt(intent, frame, source_tags=[101], paid=True)}
    assert plan_next(intent, frame, confirmations=proof)["stage"] == "command"


def test_unknown_or_hidden_enemy_disappearance_never_requests_enemy_position():
    frame = context()
    frame["entities"].append(
        {
            "tag": 202,
            "owner": 4,
            "type_name": "Marine",
            "position": [140, 150],
            "is_visible": True,
            "is_on_screen": True,
            "cloak_state": 3,
        }
    )
    intent, _ = normalize(action(23, 202, (71, 43)), frame)
    assert intent["admitted"]
    frame["entities"].pop()
    assert plan_next(intent, frame)["reason"] == "unit_target_not_currently_visible"


def test_reobserved_neutral_required_before_gas_query():
    frame = context()
    frame["known_neutral"] = [
        {"tag": 201, "owner": 3, "type_name": "VespeneGeyser", "position": [140, 160], "last_seen_loop": 1200}
    ]
    intent, _ = normalize(action(882, 201, (71, 0)), frame)
    assert intent["admitted"]
    step = plan_next(intent, frame)
    assert step["stage"] == "camera"
    frame["camera"] = step["operation"]["point"]
    assert plan_next(intent, frame)["reason"] == "remembered_neutral_not_reobserved"


def test_decisions_do_not_mutate_intent_or_frame():
    intent, frame = visible_build()
    before = deepcopy((intent, frame))
    plan_next(intent, frame)
    assert (intent, frame) == before


def test_camera_cannot_clear_fog_and_does_not_loop_on_unseen_site():
    frame = context()
    for row in frame["spatial"]["screen_visibility"]:
        row[:] = [0] * 128
    # Keep the actually observed builder's pixel visible.
    frame["spatial"]["screen_visibility"][19][60] = 2
    intent, _ = normalize(action(881, (140, 150), (71, 43)), frame)
    assert intent["admitted"]
    step = plan_next(intent, frame)
    assert step["stage"] == "select" and step["operation"]["purpose"] == "construction_worker_route"


def test_changed_enemy_ownership_cannot_be_attacked_from_stale_intent():
    frame = context()
    frame["entities"].append(
        {
            "tag": 202,
            "owner": 4,
            "type_name": "Marine",
            "position": [140, 150],
            "is_visible": True,
            "is_on_screen": True,
            "cloak_state": 3,
        }
    )
    intent, _ = normalize(action(23, 202, (71, 43)), frame)
    frame["entities"][-1]["owner"] = 1
    assert plan_next(intent, frame)["reason"] == "target_ownership_changed"


def test_worker_route_visits_are_bounded_and_never_locate_hidden_worker():
    frame = context()
    intent, _ = normalize(action(880, (170, 180), (127, 0)), frame)
    proof = {"route": receipt(intent, frame, source_tags=[101], accepted=True,
                              point_order_confirmed=True, destination=[170, 180])}
    frame["entities"] = []
    frame["game_loop"] += 40
    assert plan_next(intent, frame, confirmations=proof)["stage"] == "wait"
    frame["game_loop"] += 224
    step = plan_next(intent, frame, confirmations=proof)
    assert step["stage"] == "camera" and step["operation"]["point"] == [170, 180]
    proof["route_visit"] = receipt(intent, frame, paid=True)
    assert plan_next(intent, frame, confirmations=proof)["stage"] == "wait"
    frame["game_loop"] += 1008
    assert plan_next(intent, frame, confirmations=proof)["reason"] == "worker_route_expired_without_visible_arrival"


def test_route_acceptance_without_point_order_proof_cannot_credit_arrival():
    frame = context()
    intent, _ = normalize(action(880, (170, 180), (127, 0)), frame)
    proof = {"route": receipt(intent, frame, source_tags=[101], accepted=True,
                              point_order_confirmed=False, destination=[170, 180])}
    frame["entities"] = []
    assert plan_next(intent, frame, confirmations=proof)["reason"] == "source_absent_at_last_seen_location"


def test_queued_label_is_not_silently_executed_unqueued():
    intent, _ = normalize(action(queued=True))
    assert plan_next(intent, context())["reason"] == "controller_queue_not_supported"
    assert plan_next(intent, context(), confirmations={"supports_queue": True})["stage"] == "camera"


def test_accepted_route_is_not_reissued_while_builder_still_visible():
    frame = context()
    intent, _ = normalize(action(880, (170, 180), (127, 0)), frame)
    proof = {"route": receipt(intent, frame, source_tags=[101], accepted=True,
                              point_order_confirmed=True, destination=[170, 180])}
    assert plan_next(intent, frame, confirmations=proof)["stage"] == "wait"
