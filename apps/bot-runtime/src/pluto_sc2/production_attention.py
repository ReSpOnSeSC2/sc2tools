"""Bounded neural camera guidance from current screens and remembered screens.

This changes runtime control, not the policy weights or observation schema. It
does not choose a build, infer offscreen unit state, or issue any input itself.
The adapter pays for camera returns through its ordinary fair-play controller.
"""
from __future__ import annotations

from collections import Counter, deque
from typing import Any

from sc2.position import Point2

from .schema import ACTION_NAMES


PROFILE = "neural-production-attention-v1"
PRODUCTION_TYPES = frozenset({"NEXUS", "GATEWAY", "WARPGATE", "ROBOTICSFACILITY", "STARGATE"})


class ProductionAttention:
    """Observe only caller-filtered current own/enemy entities once per frame."""

    def __init__(self) -> None:
        self.remote_limit = 15.0
        self.empty_fog_limit = 8.0
        self.upkeep_seconds = 4.0
        self.remote_since: float | None = None
        self.empty_since: float | None = None
        self.upkeep_until = 0.0
        self.production_visible = False
        self.anchors: dict[int, dict] = {}
        self.unverified: set[int] = set()
        self.pending: dict | None = None
        self.events: deque[dict] = deque(maxlen=256)
        self.counts: Counter[str] = Counter()
        self._last_observed = -1.0
        self._last_attempt = -100.0

    def observe(self, bot: Any, own: list[Any], enemies: list[Any]) -> None:
        now = float(bot.time)
        if now < self._last_observed:
            raise ValueError("Production attention observation time moved backwards")
        self._last_observed = now
        producers = [unit for unit in own if unit.is_structure and unit.is_ready
                     and unit.type_id.name in PRODUCTION_TYPES]
        self.production_visible = bool(producers)
        current_tags = {int(unit.tag) for unit in own}
        for tag, anchor in list(self.anchors.items()):
            point = Point2(anchor["position"])
            if tag not in current_tags and bot.fairplay.on_screen(point) and bot.is_visible(point):
                del self.anchors[tag]
                self.unverified.discard(tag)
                self.counts["observed_absent_anchor"] += 1
        for unit in producers:
            tag = int(unit.tag)
            self.anchors[tag] = {"tag": tag, "type": unit.type_id.name,
                                 "position": tuple(float(v) for v in unit.position), "last_seen": now}
            self.unverified.discard(tag)
        if self.production_visible:
            self.remote_since = None
        elif self.remote_since is None:
            self.remote_since = now
        # The visibility query is confined to the current camera center. No
        # minimap enemy/unit collections or offscreen visibility are consulted.
        blank_fog = not own and not enemies and not bot.is_visible(bot.fairplay.camera_center)
        if not blank_fog:
            self.empty_since = None
        elif self.empty_since is None:
            self.empty_since = now
        if self.pending is not None and now > self.pending["time"]:
            tag = self.pending["anchor_tag"]
            if any(int(unit.tag) == tag for unit in producers):
                self.upkeep_until = now + self.upkeep_seconds
                self.pending["arrival"] = "production_observed"
                self.pending["arrival_time"] = now
                self.counts["observed_production_returns"] += 1
                self.pending = None
            elif (bot.fairplay.on_screen(Point2(self.pending["target"]))
                  or now - self.pending["time"] >= 5):
                # A fogged old base is not evidence of death. It is also not a
                # useful forced destination: stop revisiting until seen again.
                self.unverified.add(tag)
                self.pending["arrival"] = "production_unverified"
                self.pending["arrival_time"] = now
                self.counts["unverified_return_visits"] += 1
                self.pending = None

    def request(self, now: float) -> dict | None:
        if self.production_visible or self.pending is not None or now - self._last_attempt < 3:
            return None
        empty_elapsed = now - self.empty_since if self.empty_since is not None else 0.0
        remote_elapsed = now - self.remote_since if self.remote_since is not None else 0.0
        reason = ("empty_fog_timeout" if empty_elapsed >= self.empty_fog_limit else
                  "production_away_timeout" if remote_elapsed >= self.remote_limit else None)
        candidates = [anchor for tag, anchor in self.anchors.items() if tag not in self.unverified]
        if reason is None or not candidates:
            return None
        anchor = min(candidates, key=lambda row: (row["type"] != "NEXUS", -row["last_seen"], row["tag"]))
        return {"reason": reason, "target": list(anchor["position"]), "anchor_tag": anchor["tag"],
                "anchor_type": anchor["type"], "anchor_last_seen": anchor["last_seen"],
                "remote_seconds": remote_elapsed, "empty_fog_seconds": empty_elapsed}

    def attempted(self, request: dict, now: float, accepted: bool, audit_index: int | None) -> None:
        self._last_attempt = now
        event = {**request, "time": now, "accepted": bool(accepted), "camera_audit_index": audit_index,
                 "policy_sample": False, "arrival": "pending" if accepted else "command_rejected"}
        self.events.append(event)
        self.counts["accepted_returns" if accepted else "rejected_returns"] += 1
        if accepted:
            self.pending = event

    def restrict_mask(self, mask, now: float):
        """The caller records this same mask with the genuine policy decision."""
        if not self.production_visible or now >= self.upkeep_until:
            return mask
        constrained = mask.copy()
        for index, name in enumerate(ACTION_NAMES):
            if name.startswith("camera_") or name == "scout":
                constrained[index] = False
        self.counts["upkeep_masked_decisions"] += 1
        return constrained

    def summary(self) -> dict:
        return {"profile": PROFILE, "runtime_guidance": True, "learned_improvement_claim": False,
                "remote_limit_seconds": self.remote_limit, "empty_fog_limit_seconds": self.empty_fog_limit,
                "upkeep_seconds": self.upkeep_seconds, "upkeep_until": self.upkeep_until,
                "production_visible": self.production_visible, "remote_since": self.remote_since,
                "empty_fog_since": self.empty_since, "remembered_anchor_count": len(self.anchors),
                "unverified_anchor_tags": sorted(self.unverified), "counts": dict(self.counts),
                "recent_returns": list(self.events), "recent_returns_limit": self.events.maxlen}
