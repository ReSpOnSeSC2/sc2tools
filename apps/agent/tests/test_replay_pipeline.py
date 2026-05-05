"""Tests for replay_pipeline._resolve_pulse_character_id.

The full ``parse_replay_for_cloud`` happy path needs sc2reader and a
real .SC2Replay fixture; that integration coverage lives in the agent's
end-to-end harness. Here we lock down the small deterministic helpers
that decide what the cloud receives in the opponent block:

  - ``_resolve_pulse_character_id`` — returns ``None`` for unresolvable
    inputs (no handle, malformed handle, resolver returning None) and
    forwards the resolved id when the resolver returns one.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


# Make the agent package importable without an installed wheel.
HERE = Path(__file__).resolve().parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


@pytest.fixture(autouse=True)
def _stub_pulse_resolver(monkeypatch):
    """Inject a fake ``core.pulse_resolver`` so we never hit the network.

    The real resolver lives in ``reveal-sc2-opponent-main/core/`` and is
    added to sys.path by ``replay_pipeline._ensure_analyzer_on_path``.
    Replacing it with a stub keeps these tests hermetic and fast.
    """
    calls: list[tuple[str | None, str]] = []

    class _StubModule:
        @staticmethod
        def resolve_pulse_id_by_toon(handle, name):
            calls.append((handle, name))
            if handle == "1-S2-1-267727":
                return "994428"
            if handle == "1-S2-1-RAISES":
                raise RuntimeError("simulated network blip")
            return None

    monkeypatch.setitem(sys.modules, "core.pulse_resolver", _StubModule)
    yield calls


def _make_opp(handle: str | None, name: str = "ReSpOnSe") -> SimpleNamespace:
    return SimpleNamespace(handle=handle, name=name)


def test_resolves_real_toon_handle_to_sc2pulse_character_id(_stub_pulse_resolver):
    from sc2tools_agent.replay_pipeline import _resolve_pulse_character_id

    out = _resolve_pulse_character_id(_make_opp("1-S2-1-267727"))
    assert out == "994428"


def test_strips_clan_tag_prefix_before_lookup(_stub_pulse_resolver):
    from sc2tools_agent.replay_pipeline import _resolve_pulse_character_id

    _resolve_pulse_character_id(_make_opp("1-S2-1-267727", name="[CLAN]ReSpOnSe"))
    # The stub records the cleaned name, not the prefixed one.
    assert _stub_pulse_resolver[-1][1] == "ReSpOnSe"


def test_returns_none_when_handle_is_missing(_stub_pulse_resolver):
    from sc2tools_agent.replay_pipeline import _resolve_pulse_character_id

    assert _resolve_pulse_character_id(_make_opp(None)) is None
    assert _resolve_pulse_character_id(_make_opp("")) is None
    # No resolver call should have been made for an empty handle.
    assert _stub_pulse_resolver == []


def test_returns_none_when_resolver_misses(_stub_pulse_resolver):
    from sc2tools_agent.replay_pipeline import _resolve_pulse_character_id

    out = _resolve_pulse_character_id(_make_opp("2-S2-1-9999999", name="Anon"))
    assert out is None


def test_swallows_resolver_exceptions(_stub_pulse_resolver):
    from sc2tools_agent.replay_pipeline import _resolve_pulse_character_id

    # The resolver stub raises for this handle. The pipeline must
    # log and return None — never propagate, since a transient outage
    # cannot be allowed to break the upload path.
    assert _resolve_pulse_character_id(_make_opp("1-S2-1-RAISES")) is None
