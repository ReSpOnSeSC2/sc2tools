import json

import pytest

from pluto_sc2.cli import audit_file, main, parser, replay_files


def test_only_fixed_observation_cadence():
    with pytest.raises(SystemExit):
        parser().parse_args(["train", "--map", "Example", "--output", "runs/x", "--step-mul", "4"])


def test_research_defaults_preserve_stochastic_policy_and_undiscounted_outcome():
    args = parser().parse_args(["train", "--map", "Example", "--output", "runs/x"])
    assert args.gamma == 1.0 and args.reference_kl_coef == .01
    for command in ("play", "evaluate"):
        base = [command, "--map", "Example", "--checkpoint", "model.pt"]
        assert not parser().parse_args(base).deterministic
        assert parser().parse_args([*base, "--deterministic"]).deterministic


def test_remote_public_handle_does_not_require_token():
    args = parser().parse_args(["sync-replays", "--public-handle", "response-b80b2b9cf3", "--limit", "3"])
    assert args.public_handle == "response-b80b2b9cf3"
    assert args.api_url == "https://sc2tools-api.onrender.com"


def test_replay_paths_are_deduplicated_case_insensitive_extensions(tmp_path):
    path = tmp_path / "one.sc2replay"
    path.write_bytes(b"fixture")
    assert replay_files([str(tmp_path), str(path)]) == [path.resolve()]


def test_empty_replay_folder_fails(tmp_path):
    with pytest.raises(ValueError, match="No .SC2Replay"):
        replay_files([str(tmp_path)])


def test_cli_audit_rejects_malformed_before_success(tmp_path):
    path = tmp_path / "audit.json"
    path.write_text(json.dumps({"actions": [{"time": 0, "kind": "selection", "camera": [float('nan'), 1]}]}))
    with pytest.raises((ValueError, RuntimeError)):
        audit_file(str(path))


def test_user_errors_exit_nonzero(tmp_path, capsys):
    assert main(["inspect-replays", str(tmp_path)]) == 1
    assert "No .SC2Replay" in capsys.readouterr().err
