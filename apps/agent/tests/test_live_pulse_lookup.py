"""Unit tests for ``sc2tools_agent.live.pulse_lookup.PulseClient``.

We stub ``requests.Session.get`` so no test ever hits sc2pulse.nephest.
The stub queues per-URL responses (``character/search``, ``group/team``,
``season/list/all``) so each test asserts on a deterministic flow.
"""

from __future__ import annotations

import json
from typing import Any, List, Optional
from unittest.mock import MagicMock

from sc2tools_agent.live.pulse_lookup import (
    DEFAULT_API_ROOT,
    DEFAULT_QUEUE,
    PulseClient,
)
from sc2tools_agent.live.types import OpponentProfile


def _ok(body: Any) -> MagicMock:
    m = MagicMock()
    m.status_code = 200
    m.text = json.dumps(body)
    m.json.return_value = body
    return m


def _bad(status: int) -> MagicMock:
    m = MagicMock()
    m.status_code = status
    m.text = ""
    m.json.side_effect = ValueError("no body")
    return m


class _StubSession:
    """Per-URL queue-based stub for ``requests.Session``.

    Path-only matching — the real client appends query strings, but the
    stub's ``get`` ignores ``params`` so tests can register one response
    per endpoint regardless of which characterId / season is queried.
    """

    def __init__(self) -> None:
        self._responses: dict[str, list[Any]] = {}
        self.calls: list[tuple[str, dict[str, str] | None]] = []

    def queue(self, url_suffix: str, response_or_exc: Any) -> None:
        self._responses.setdefault(url_suffix, []).append(response_or_exc)

    def get(
        self,
        url: str,
        *,
        params: Optional[dict[str, str]] = None,
        timeout: float,
        headers: Optional[dict[str, str]] = None,
    ) -> Any:
        self.calls.append((url, params))
        # Match by path suffix so tests don't have to write the full
        # base URL each time.
        for suffix, queue in list(self._responses.items()):
            if url.endswith(suffix):
                if not queue:
                    continue
                item = queue.pop(0)
                if isinstance(item, Exception):
                    raise item
                return item
        raise AssertionError(f"no stubbed response for {url}")


def _make_client(
    session: _StubSession,
    *,
    retry_attempts: int = 2,
    sleep: Any = lambda _: None,
) -> PulseClient:
    return PulseClient(
        session=session,  # type: ignore[arg-type]
        cache_ttl_sec=60.0,
        cache_max_entries=8,
        retry_attempts=retry_attempts,
        retry_base_sec=0.001,
        sleep=sleep,
    )


# ---------------------------------------------------------------- happy path


def test_resolve_returns_full_profile_for_unique_match() -> None:
    """The clean case: name search → one candidate → team fetch
    succeeds → fully-populated profile."""
    session = _StubSession()
    session.queue(
        "/season/list/all",
        _ok([{"battlenetId": 56}, {"battlenetId": 55}]),
    )
    session.queue(
        "/character/search",
        _ok([
            {
                "character": {
                    "id": 9001,
                    "name": "PlayerOne#1234",
                    "region": 2,  # EU
                },
                "zergGamesPlayed": 50,
                "protossGamesPlayed": 1,
                "terranGamesPlayed": 0,
                "randomGamesPlayed": 0,
            }
        ]),
    )
    session.queue(
        "/group/team",
        _ok([
            {
                "rating": 4321,
                "league": 4,  # Diamond
                "tier": 1,
                "wins": 12,
                "losses": 8,
                "ties": 0,
                "members": [{
                    "zergGamesPlayed": 19,
                    "protossGamesPlayed": 1,
                    "terranGamesPlayed": 0,
                    "randomGamesPlayed": 0,
                }],
            }
        ]),
    )

    client = _make_client(session)
    profile = client.resolve(name="PlayerOne", region="EU", race="Zerg")
    assert profile is not None
    assert profile.name == "PlayerOne"
    assert profile.pulse_character_id == 9001
    assert profile.region == "EU"
    assert profile.battle_tag == "PlayerOne#1234"
    assert profile.mmr == 4321
    assert profile.league == "Diamond"
    assert profile.league_tier == 1
    assert profile.top_race == "Zerg"
    assert profile.confidence > 0.85  # exact name + region + race agreement
    assert profile.alternatives == []


def test_resolve_caches_warm_lookups() -> None:
    """Second call for the same (name, region, race) is served from
    cache without hitting Pulse."""
    session = _StubSession()
    session.queue(
        "/season/list/all",
        _ok([{"battlenetId": 56}]),
    )
    session.queue(
        "/character/search",
        _ok([{
            "character": {"id": 1, "name": "Cached#1", "region": 1},
            "zergGamesPlayed": 10,
        }]),
    )
    session.queue(
        "/group/team",
        _ok([{"rating": 3000, "league": 3}]),
    )

    client = _make_client(session)
    p1 = client.resolve(name="Cached", region="US", race="Zerg")
    assert p1 is not None
    p2 = client.resolve(name="Cached", region="US", race="Zerg")
    assert p2 is not None
    assert p2 is p1 or p2 == p1
    # Only the first lookup hit Pulse — three calls total (season,
    # search, team). The second resolve hit zero endpoints.
    endpoints_hit = [c[0].rsplit("/", 1)[-1] for c in session.calls]
    assert endpoints_hit.count("search") == 1
    assert endpoints_hit.count("team") == 1
    assert client.cache_size() == 1


def test_resolve_picks_best_of_ambiguous_candidates() -> None:
    """Two candidates share a name. We pick the one matching the
    caller's race + region hints and report the alternative on
    ``alternatives``."""
    session = _StubSession()
    session.queue(
        "/season/list/all",
        _ok([{"battlenetId": 56}]),
    )
    session.queue(
        "/character/search",
        _ok([
            {  # KR Protoss — wrong region/race
                "character": {"id": 1, "name": "Twins#0001", "region": 3},
                "protossGamesPlayed": 200,
            },
            {  # EU Zerg — match
                "character": {"id": 2, "name": "Twins#0002", "region": 2},
                "zergGamesPlayed": 500,
            },
        ]),
    )
    session.queue(
        "/group/team",
        _ok([{"rating": 3500, "league": 3}]),
    )

    client = _make_client(session)
    profile = client.resolve(name="Twins", region="EU", race="Zerg")
    assert profile is not None
    assert profile.pulse_character_id == 2
    assert profile.region == "EU"
    assert profile.confidence > 0
    # Alternatives includes the rival KR account so the widget can
    # render the disambiguation hint if it wants to.
    assert any("KR" in a for a in profile.alternatives)


def test_resolve_falls_back_when_search_returns_nothing() -> None:
    """No candidates → low-confidence stub so the widget still shows
    'vs <name>'."""
    session = _StubSession()
    session.queue("/season/list/all", _ok([{"battlenetId": 56}]))
    session.queue("/character/search", _ok([]))

    client = _make_client(session)
    profile = client.resolve(name="GhostPlayer", region="EU", race="Protoss")
    assert profile is not None
    assert profile.name == "GhostPlayer"
    assert profile.region == "EU"
    assert profile.top_race == "Protoss"
    assert profile.mmr is None
    assert profile.confidence == 0.0


def test_resolve_retries_5xx_then_succeeds() -> None:
    """Pulse occasionally 502s under load. The client retries with
    back-off and the second attempt succeeds."""
    sleeps: List[float] = []
    session = _StubSession()
    session.queue("/season/list/all", _bad(502))
    session.queue("/season/list/all", _ok([{"battlenetId": 56}]))
    session.queue(
        "/character/search",
        _ok([{
            "character": {"id": 7, "name": "Flaky#0007", "region": 2},
            "zergGamesPlayed": 5,
        }]),
    )
    session.queue("/group/team", _ok([{"rating": 2900, "league": 2}]))

    client = _make_client(session, sleep=sleeps.append)
    profile = client.resolve(name="Flaky", region="EU", race="Zerg")
    assert profile is not None
    assert profile.mmr == 2900
    # First-attempt back-off counted.
    assert len(sleeps) >= 1


def test_resolve_does_not_retry_4xx() -> None:
    """4xx is non-retryable. The client returns a stub immediately
    rather than burning the retry budget — and the search endpoint
    runs before season resolution, so a 4xx on search short-circuits
    the whole flow."""
    session = _StubSession()
    session.queue("/character/search", _bad(404))

    client = _make_client(session, retry_attempts=3)
    profile = client.resolve(name="NoSuch", region="US", race="Terran")
    assert profile is not None
    assert profile.mmr is None
    assert profile.confidence == 0.0
    # ``search`` was hit exactly once (no retry); season resolution
    # was never attempted because search short-circuited.
    paths = [c[0].rsplit("/", 1)[-1] for c in session.calls]
    assert paths.count("search") == 1
    assert paths.count("all") == 0


def test_resolve_handles_network_exception_with_partial_profile() -> None:
    """Connection error during search → fallback profile carrying just
    the name + caller's hints, never raises into the bridge."""
    import requests
    session = _StubSession()
    session.queue(
        "/season/list/all",
        requests.ConnectionError("dns_failed"),
    )
    session.queue(
        "/season/list/all",
        requests.ConnectionError("dns_failed"),
    )
    session.queue(
        "/character/search",
        requests.ConnectionError("dns_failed"),
    )
    session.queue(
        "/character/search",
        requests.ConnectionError("dns_failed"),
    )
    client = _make_client(session, retry_attempts=2)
    profile = client.resolve(name="Offline", region="EU", race="Zerg")
    assert profile is not None
    assert profile.name == "Offline"
    assert profile.region == "EU"
    assert profile.top_race == "Zerg"
    assert profile.mmr is None
    assert profile.confidence == 0.0


def test_resolve_returns_profile_when_team_fetch_fails() -> None:
    """Search succeeds, /group/team 502s through the retry budget. We
    surface the candidate's name + region but mark MMR unknown."""
    session = _StubSession()
    session.queue("/season/list/all", _ok([{"battlenetId": 56}]))
    session.queue(
        "/character/search",
        _ok([{
            "character": {"id": 42, "name": "PartialP#42", "region": 1},
            "protossGamesPlayed": 100,
        }]),
    )
    session.queue("/group/team", _bad(502))
    session.queue("/group/team", _bad(502))
    client = _make_client(session, retry_attempts=2)
    profile = client.resolve(name="PartialP", region="US", race="Protoss")
    assert profile is not None
    assert profile.pulse_character_id == 42
    assert profile.region == "US"
    assert profile.mmr is None
    assert profile.league is None
    # Top race comes from the candidate-level counts when no team data
    # is available.
    assert profile.top_race == "Protoss"


def test_empty_name_returns_none() -> None:
    """Defensive: the bridge can call resolve with an empty name if
    the in-game opponent is a computer / unknown. We return None
    quickly without touching the network."""
    session = _StubSession()
    client = _make_client(session)
    assert client.resolve(name="", region="US", race="Zerg") is None
    assert client.resolve(name="   ", region="US", race="Zerg") is None
    assert session.calls == []


def test_cache_clear_drops_entries() -> None:
    session = _StubSession()
    session.queue("/season/list/all", _ok([{"battlenetId": 56}]))
    session.queue("/character/search", _ok([]))
    client = _make_client(session)
    client.resolve(name="Foo", region="US", race="Zerg")
    assert client.cache_size() == 1
    client.clear_cache()
    assert client.cache_size() == 0


def test_defaults_match_expected_values() -> None:
    """Smoke check that the public defaults match what the prompt and
    legacy overlay expect."""
    assert DEFAULT_API_ROOT == "https://sc2pulse.nephest.com/sc2/api"
    assert DEFAULT_QUEUE == "LOTV_1V1"
