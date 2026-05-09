"""
Negative-cache TTL tests for ``core.pulse_resolver``.

The May-2026 "stuck on TOON id" fix replaced the resolver's
unbounded negative cache with a TTL'd entry: a confirmed-absent
toon stays cached for ``DEFAULT_NEG_CACHE_SEC`` (env override
``SC2TOOLS_PULSE_NEG_CACHE_SEC``) but expires after that, so a
later replay against the same toon — once the player has appeared
on SC2Pulse — gets re-probed instead of being permanently
blackholed by an outage that happened to coincide with their
first replay.

These tests pin:
  * a miss inside the TTL window short-circuits as before,
  * a miss whose entry has expired triggers a fresh lookup that
    can succeed,
  * ``force_refresh=True`` bypasses both caches.

Time is monkey-patched via the ``now=`` test seam on the cache
helpers — no ``time.sleep`` in CI.
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional

_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT))

from core import pulse_resolver  # noqa: E402


class _Stub:
    def __init__(self, responses: Dict[str, Any]) -> None:
        self.responses = responses
        self.calls: List[str] = []

    def __call__(self, url: str) -> Optional[Any]:
        self.calls.append(url)
        for key, value in self.responses.items():
            if key in url:
                return value
        return None


def _seasons() -> List[Dict[str, Any]]:
    return [{"region": "US", "battlenetId": 60}]


def _team(bnid: int) -> List[Dict[str, Any]]:
    return [{"members": [{"character": {"region": "US", "battlenetId": bnid}}]}]


class NegativeCacheTtlTest(unittest.TestCase):

    def setUp(self) -> None:
        pulse_resolver.clear_cache()

    def test_miss_inside_window_short_circuits(self) -> None:
        # Initial probe -> empty candidate list -> negative-cached.
        fetcher = _Stub({
            "/season/list/all": _seasons(),
            "/character/search/advanced": [],
        })
        first = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "Ghost", fetch_json=fetcher,
        )
        self.assertIsNone(first)
        before = len(fetcher.calls)
        # Second call inside the TTL window must NOT re-probe.
        second = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "Ghost", fetch_json=fetcher,
        )
        self.assertIsNone(second)
        self.assertEqual(len(fetcher.calls), before)

    def test_miss_after_ttl_re_probes_and_can_succeed(self) -> None:
        miss_fetch = _Stub({
            "/season/list/all": _seasons(),
            "/character/search/advanced": [],
        })
        out = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "Ghost", fetch_json=miss_fetch,
        )
        self.assertIsNone(out)
        # The negative entry should be present right now — but if we
        # ask the cache helper "are we still in the window?" with a
        # ``now`` value past the TTL, it must report False AND drop
        # the entry. That's the fix for the stuck-on-TOON-id bug.
        far_future = (
            pulse_resolver._NEG_CACHE.get("1-S2-1-267727", 0.0) + 1.0
        )
        self.assertFalse(
            pulse_resolver._negative_cache_get(
                "1-S2-1-267727", now=far_future,
            )
        )
        # Now SC2Pulse has caught up — a real candidate appears.
        hit_fetch = _Stub({
            "/season/list/all": _seasons(),
            "/character/search/advanced": [452727],
            "/character/452727/teams": _team(267727),
        })
        out2 = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "Ghost", fetch_json=hit_fetch,
        )
        self.assertEqual(out2, "452727")

    def test_force_refresh_bypasses_negative_cache(self) -> None:
        miss_fetch = _Stub({
            "/season/list/all": _seasons(),
            "/character/search/advanced": [],
        })
        pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "Ghost", fetch_json=miss_fetch,
        )
        hit_fetch = _Stub({
            "/season/list/all": _seasons(),
            "/character/search/advanced": [452727],
            "/character/452727/teams": _team(267727),
        })
        out = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "Ghost",
            fetch_json=hit_fetch,
            force_refresh=True,
        )
        self.assertEqual(out, "452727")

    def test_force_refresh_bypasses_positive_cache_too(self) -> None:
        # Seed a positive entry, then force-refresh against a fetcher
        # that resolves to a different id; the new id wins.
        seed = _Stub({
            "/season/list/all": _seasons(),
            "/character/search/advanced": [111111],
            "/character/111111/teams": _team(267727),
        })
        first = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "X", fetch_json=seed,
        )
        self.assertEqual(first, "111111")
        rotate = _Stub({
            "/season/list/all": _seasons(),
            "/character/search/advanced": [222222],
            "/character/222222/teams": _team(267727),
        })
        out = pulse_resolver.resolve_pulse_id_by_toon(
            "1-S2-1-267727", "X",
            fetch_json=rotate,
            force_refresh=True,
        )
        self.assertEqual(out, "222222")


if __name__ == "__main__":
    unittest.main()
