"""Compatibility shim over the canonical detector base in ``core``.

This module used to carry a hand-maintained copy of the base detector
class, the tech-prerequisite table, and the timing helpers — "fixed in
both the canonical detector and the detectors/ mirror" appears all over
the CHANGELOG because every rule change had to land twice, and the
copies drifted (the mirror was missing two PvZ labels and shipped a
dead 7-Gate guard). The mirror is now a re-export so there is exactly
one implementation; new imports should target ``core`` directly, and
this package survives only for the bulk importer + older tests.
"""

from core.strategy_detector_base import BaseStrategyDetector
from core.strategy_detector_helpers import (
    UNIT_TECH_PREREQUISITES,
    _is_start_event,
    _structures_present_by,
    base_count_at,
    count_real_units,
    count_started_before,
    nth_base_start,
    start_times,
    start_times_excluding_main,
    unit_prereq_met,
)

__all__ = [
    "BaseStrategyDetector",
    "UNIT_TECH_PREREQUISITES",
    "_is_start_event",
    "_structures_present_by",
    "base_count_at",
    "count_real_units",
    "count_started_before",
    "nth_base_start",
    "start_times",
    "start_times_excluding_main",
    "unit_prereq_met",
]
