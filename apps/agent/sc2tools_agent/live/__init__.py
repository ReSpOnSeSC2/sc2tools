"""Live Game Bridge — fuses Blizzard's localhost SC2 client API and
SC2Pulse into a single ``LiveGameState`` stream pushed outbound to the
overlay backend (Socket.io) and the cloud (HTTPS POST).

The bridge is the agent's single source of truth for "what's happening
in the SC2 client right now." It exists because the website cannot
reach into the user's PC (NAT/firewall/dynamic IP), so the same agent
that ships replays must also pump pre-game / in-game state outward
through the same outbound channels.

Module layout:

* ``types`` — typed data classes for UI state, game state, lifecycle
  events, and opponent profiles.
* ``event_bus`` — tiny in-process pub/sub. Keeps the poller and the
  bridge decoupled so unit tests can drive each side independently.
* ``client_api`` — ``LiveClientPoller`` that talks to
  ``http://localhost:6119`` and emits typed lifecycle events.
* ``pulse_lookup`` — ``PulseClient`` that resolves opponent names to
  full ladder profiles (Phase 2).
* ``bridge`` — fuses both sources into a coherent ``LiveGameState``.
* ``transport`` — pushes the fused state to the overlay backend
  Socket.io ``/live`` namespace AND the cloud ``POST /v1/agent/live``.
* ``metrics`` — per-source latency / error counters for the diagnostics
  endpoint.

Public re-exports keep ``from sc2tools_agent.live import …`` short for
callers in ``runner.py``.
"""

from __future__ import annotations

from .bridge import LiveBridge
from .event_bus import EventBus
from .pulse_lookup import PulseClient
from .types import (
    LiveGameState,
    LiveLifecycleEvent,
    LiveLifecyclePhase,
    LivePlayer,
    LiveUIState,
    OpponentProfile,
)

__all__ = [
    "EventBus",
    "LiveBridge",
    "LiveGameState",
    "LiveLifecycleEvent",
    "LiveLifecyclePhase",
    "LivePlayer",
    "LiveUIState",
    "OpponentProfile",
    "PulseClient",
]
