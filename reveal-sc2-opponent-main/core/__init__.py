"""
SC2 Tools - Core Engine
=======================
Unified parsing, strategy detection, and storage for the merged
SC2 Stream Overlay + SC2 Meta Analyzer toolkit.

Public surface:
    build_definitions  -- BUILD_DEFINITIONS, KNOWN_BUILDS, KNOWN_BUILDINGS, etc.
    custom_builds      -- load_custom_builds, initialize_custom_builds
    strategy_detector  -- BaseStrategyDetector, OpponentStrategyDetector, UserBuildDetector
    event_extractor    -- extract_events, _clean_building_name, _get_owner_pid
    sc2_replay_parser  -- parse_replay (depth-aware), parse_live, parse_deep
    data_store         -- DataStore (unified atomic-write wrapper)
    error_logger       -- ErrorLogger
    paths              -- Centralized filesystem paths
"""

from . import paths
from . import build_definitions
from . import custom_builds
from . import strategy_detector
from . import event_extractor
from . import sc2_replay_parser
from . import data_store
from . import error_logger

__all__ = [
    "paths",
    "build_definitions",
    "custom_builds",
    "strategy_detector",
    "event_extractor",
    "sc2_replay_parser",
    "data_store",
    "error_logger",
]
