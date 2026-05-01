"""
Tests for ``core.pulse_resolver`` -- toon-handle to SC2Pulse character ID.

The resolver is the post-game reconciliation primitive: when sc2reader
gives us an opponent's authoritative ``toon_handle`` (e.g. ``"1-S2-1-
267727"``), we want to cross-walk it to the SC2Pulse ``character_id`` so
the Black Book uses the right key even when the live phase saw an
ambiguous barcode display name.

These tests pin:
  * ``parse_toon_handle`` correctness on canonical, malformed, and
    legacy-region inputs.
  * The end-to-end resolve flow with a stub fetch so no network is
    touched in CI -- mirrors the real SC2Pulse JSON shapes pulled from
    the existing ``scripts/resolve_pulse_ids.py``.
  * Negative caching so a confirmed-absent toon doesn't hammer the API.

Real JSON shapes -- no mocks.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from core import pulse_resolver  # noqa: E402


class StubFetcher:
    """Maps URLs (substring match) to canned JSON responses.

    Keeps a call log so tests can assert on cache behaviour without
    touching the network. Substring matching keeps tests robust to
    changes in URL parameter ordering (``?season=...&region=...`` vs
    ``?region=...&season=...``).
    """

    def __init__(self, responses: Dict[str, Any]) -> None:
        self.responses = responses
        self.calls: List[str] = []

    def __call__(self, url: str) -> Optional[Any]:
        self.calls.append(url)
        for key, value in self.responses.items():
            if key in url:
                return value
        return None


class ParseToonHandleTest(unittest.TestCase):

    def test_canonical_us_handle(self) -> None:
        self.assertEqual(
            pulse_resolver.parse_toon_handle("1-S2-1-267727"),
            (1, 1, 267727),
        )

    def test_canonical_eu_handle(self) -> None:
        self.assertEqual(
            pulse_resolver.parse_toon_handle("2-S2-1-9876543"),
            (2, 1, 9876543),
        )

    def test_blank_returns_none(self) -> None:
        self.assertIsNone(pulse_resolver.parse_toon_handle(""))
        self.assertIsNone(pulse_resolver.parse_toon_handle(None))

    def test_legacy_s1_handle_rejected(self) -> None:
        # Only S2 (Heart of the Swarm onward) handles are valid.
        self.assertIsNone(pulse_resolver.parse_toon_handle("1-S1-1-267727"))

    def test_unknown_region_rejected(self) -> None:
        self.assertIsNone(pulse_resolver.parse_toon_handle("9-S2-1-267727"))

    def test_non_numeric_segment_rejected(self) -> None:
        self.assertIsNone(pulse_resolver.parse_toon_handle("1-S2-x-267727"))


def _make_seasons(region_code: str, bnid: int) -> List[Dict[str, Any]]:
    return [{"region": region_code, "battlenetId": bnid}]


def _make_team(region_code: str, bnid: int) -> List[Dict[str, Any]]:
    return [
        {
            "members": [
                {"character": {"region": region_code, "battlenetId": bnid}}
            ]
        }
    ]


class ResolvePulseIdByToonTest(unittest.TestCase):

    def setUp(self) -> None:
        # Module-level cache leaks across tests; clear before each.
        pulse_resolver.clear_cache()

    def test_missing_toon_returns_none(self) -> None:
        fetcher = StubFetcher({})
        out = pulse_resolver.resolve_pulse_id_by_toon(
            None, "Anyone", fetch_json=fetcher
        )
        self.assertIsNone(out)
        # parse-failure short-circuits before any HTTP call.
        self.assertEqual(fetcher.calls, [])

    def test_resolve_finds_candidate_matching_bnid(self) -> None:
        fetcher = StubFetcher({
            "/season/list/all": _make_seasons("US", 60),
            "/character/search/advanced": [452727],
            "/character/452727/teams": _make_team("US", 267727),
        })
        out = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "ReSpOnSe", fetch_json=fetcher
        )
        self.assertEqual(out, "452727")

    def test_resolve_skips_candidate_with_wrong_bnid(self) -> None:
        # Two candidates; only the second has the matching bnid. The
        # resolver must walk both and return the matching one.
        fetcher = StubFetcher({
            "/season/list/all": _make_seasons("US", 60),
            "/character/search/advanced": [111111, 452727],
            "/character/111111/teams": _make_team("US", 999999),
            "/character/452727/teams": _make_team("US", 267727),
        })
        out = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "barcode", fetch_json=fetcher
        )
        self.assertEqual(out, "452727")

    def test_no_candidates_returns_none(self) -> None:
        fetcher = StubFetcher({
            "/season/list/all": _make_seasons("US", 60),
            "/character/search/advanced": [],
        })
        out = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "Ghost", fetch_json=fetcher
        )
        self.assertIsNone(out)

    def test_seasons_unreachable_returns_none_no_cache(self) -> None:
        # API offline: the resolver must NOT poison the cache so the
        # next replay can retry.
        fetcher = StubFetcher({})
        out = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "Anyone", fetch_json=fetcher
        )
        self.assertIsNone(out)
        # Re-calling does another lookup (no negative cache hit).
        fetcher2 = StubFetcher({
            "/season/list/all": _make_seasons("US", 60),
            "/character/search/advanced": [452727],
            "/character/452727/teams": _make_team("US", 267727),
        })
        out2 = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "Anyone", fetch_json=fetcher2
        )
        self.assertEqual(out2, "452727")

    def test_negative_cache_blocks_repeat_lookup(self) -> None:
        # No candidate confirmed -> remember that and don't re-search.
        fetcher = StubFetcher({
            "/season/list/all": _make_seasons("US", 60),
            "/character/search/advanced": [111111],
            "/character/111111/teams": _make_team("US", 999999),
        })
        out = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "Ghost", fetch_json=fetcher
        )
        self.assertIsNone(out)
        # Second call must NOT trigger a fresh search; cache short-circuits.
        before_calls = len(fetcher.calls)
        out2 = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "Ghost", fetch_json=fetcher
        )
        self.assertIsNone(out2)
        self.assertEqual(len(fetcher.calls), before_calls)

    def test_positive_cache_short_circuits_subsequent_calls(self) -> None:
        fetcher = StubFetcher({
            "/season/list/all": _make_seasons("US", 60),
            "/character/search/advanced": [452727],
            "/character/452727/teams": _make_team("US", 267727),
        })
        first = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "ReSpOnSe", fetch_json=fetcher
        )
        before_calls = len(fetcher.calls)
        second = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "ReSpOnSe", fetch_json=fetcher
        )
        self.assertEqual(first, second, "cached value should match")
        self.assertEqual(len(fetcher.calls), before_calls,
                         "cache must short-circuit network calls")


class HashNameTest(unittest.TestCase):
    """Display names are PII; the watcher logs only their hash."""

    def test_hash_is_deterministic(self) -> None:
        a = pulse_resolver._hash_name("Mirtillo")
        b = pulse_resolver._hash_name("Mirtillo")
        self.assertEqual(a, b)

    def test_hash_is_different_for_different_inputs(self) -> None:
        self.assertNotEqual(
            pulse_resolver._hash_name("Mirtillo"),
            pulse_resolver._hash_name("Yamada"),
        )

    def test_hash_handles_empty(self) -> None:
        self.assertEqual(pulse_resolver._hash_name(""), "empty")


if __name__ == "__main__":
    unittest.main()
