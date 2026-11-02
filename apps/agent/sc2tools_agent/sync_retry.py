"""Private reason-scoped repair. No paths, identities or exception text in ACKs."""
from __future__ import annotations

from dataclasses import dataclass
import re
import threading
import time

from .state import _STATE_SAVE_LOCK

RETRY_REASONS = frozenset({"player_unresolved", "parse_failed", "analysis_failed", "file_unstable",
                           "playback_budget_exceeded", "unsupported_replay"})
TOON = re.compile(r"[0-9]+-S2-[0-9]+-[0-9]+")


class RetryStopped(Exception):
    def __init__(self, code="owner_changed"):
        self.code = code


@dataclass(frozen=True)
class ReplayTicket:
    owner: object
    token: object
    epoch: object
    toons: tuple | None
    hint: str | None = None

    def current(self, state):
        """No I/O/locks/queue calls. Mutation callers hold _STATE_SAVE_LOCK."""
        return (self.owner == getattr(state, "user_id", None) and self.token == getattr(state, "device_token", None)
                and self.epoch is getattr(state, "_owner_epoch", None))


def replay_ticket(state):
    with _STATE_SAVE_LOCK:
        if not hasattr(state, "_owner_epoch"):
            state._owner_epoch = object()
        scope = (getattr(state, "user_id", None), getattr(state, "device_token", None), state._owner_epoch)
        cached = getattr(state, "_owned_toons", None)
        valid = bool(cached and cached[0] == scope)
        return ReplayTicket(*scope, cached[1] if valid else (), cached[2] if valid else None)


def publish_owned_toons(state, profile, ticket):
    """Caller holds the state lock and has checked its fetch/connection ticket."""
    if not ticket.current(state) or not isinstance(profile, dict):
        return False
    raw = profile.get("pulseIds") if isinstance(profile, dict) else None
    if not isinstance(raw, list):
        raw = [profile.get("pulseId")] if isinstance(profile, dict) else []
    toons = []
    for value in raw:
        if isinstance(value, str) and len(value) <= 32 and TOON.fullmatch(value) and value not in toons:
            toons.append(value)
            if len(toons) == 20:
                break
    from .player_handle import _pick_handle_from_profile
    hint = _pick_handle_from_profile(profile)
    hint = hint[:64] if hint else None
    # Known-empty uses only this freshly fetched hint, never an old disk/path
    # fallback. Unknown/retired owners get an empty exact-toon scope instead.
    state._owned_toons = ((ticket.owner, ticket.token, ticket.epoch), tuple(toons) or None, hint)
    return True


def publish_local_hint(state, hint):
    """An explicit current-owner Settings action can supply its own fresh hint."""
    with _STATE_SAVE_LOCK:
        ticket = replay_ticket(state)
        hint = hint.strip()[:64] if isinstance(hint, str) else None
        state._owned_toons = ((ticket.owner, ticket.token, ticket.epoch), ticket.toons or (None if hint else ()), hint or None)


def settings_identity_origin(state):
    ticket = replay_ticket(state)
    return ticket.owner, ticket.epoch  # Deliberately contains no credential.


def current_identity_source(state, state_dir):
    ticket = replay_ticket(state)
    if not ticket.toons and not ticket.hint:
        return "none"
    from .player_handle import read_settings_hint
    explicit = read_settings_hint(state_dir, ticket.owner)
    if not ticket.current(state):
        return "none"
    return "settings" if explicit and explicit == ticket.hint else "cloud"


class SyncRetryController:
    def __init__(self, *, cfg, state, cell, stop_event, clock=time.time):
        self.cfg, self.state, self.cell = cfg, state, cell
        self.stop_event, self.clock = stop_event, clock
        self._pending = threading.Lock()

    def handle(self, raw, authenticated_token, current):
        if not self._pending.acquire(blocking=False):
            return "busy", 0
        try:
            ticket = replay_ticket(self.state)

            def checkpoint():
                # Lock order: queue -> state. Never call a queue method here.
                if (self.stop_event.is_set() or not current() or not ticket.current(self.state)
                        or ticket.token != authenticated_token):
                    raise RetryStopped()
                if self.clock() * 1000 >= raw["expiresAt"]:
                    raise RetryStopped("expired")

            checkpoint()
            queue = self.cell.upload
            if queue is None:
                return "busy", 0
            if raw["reason"] == "player_unresolved":
                from .api_client import ApiClient
                profile = ApiClient(self.cfg.api_base, authenticated_token).get_profile(interactive=True)
                with _STATE_SAVE_LOCK:
                    from .player_handle import read_settings_hint
                    explicit = read_settings_hint(self.cfg.state_dir, ticket.owner)
                    checkpoint()
                    if not publish_owned_toons(self.state, {**profile, "displayName": explicit} if explicit and isinstance(profile, dict) else profile, ticket):
                        return "local_error", 0
            health = getattr(getattr(self.cell, "ui", None), "health", None)
            if health:
                try:
                    health.set_identity(current_identity_source(self.state, self.cfg.state_dir))
                except Exception:
                    pass
            paths = queue.retry_sync_reason(raw["reason"], current_guard=checkpoint)
            checkpoint()
            for service, method in ((self.cell.watcher, "request_immediate_sweep"), (self.cell.recent_history, "refresh")):
                if service:
                    try:
                        getattr(service, method)()
                    except Exception:
                        pass  # Observational hooks cannot undo a durable repair.
            return ("accepted", min(999999, len(paths))) if paths else ("no_matches", 0)
        except RetryStopped as exc:
            return exc.code, 0
        except Exception:
            return "local_error", 0
        finally:
            self._pending.release()
