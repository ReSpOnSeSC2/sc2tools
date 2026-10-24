from unittest.mock import Mock

import pytest

from sc2tools_agent.api_client import ApiClient


def test_legacy_ownership_lookup_is_owned_read_only_interactive_and_quoted(monkeypatch):
    request = Mock(return_value={"gameId": "player/name|map"})
    monkeypatch.setattr(ApiClient, "_interactive", request)
    client = ApiClient("https://example.test", "fixture")
    assert client.get_game_summary("player/name|map") == {"gameId": "player/name|map"}
    request.assert_called_once_with("GET", "/v1/games/player%2Fname%7Cmap")


@pytest.mark.parametrize("identifier", [None, "", "..", ".", " path", "path\n", "a" * 201, "\ud800"])
def test_legacy_ownership_lookup_rejects_invalid_identifiers(identifier):
    with pytest.raises(ValueError):
        ApiClient("https://example.test", "fixture").get_game_summary(identifier)
