"""Strategy/build detectors and shared definitions.

`BaseStrategyDetector` exposes the geometric helpers (proxy distance, custom
rule evaluation) that the two concrete detectors share.
`OpponentStrategyDetector` classifies what the enemy did; `UserBuildDetector`
classifies what the user did. Definitions for the catalog of named builds
live in `definitions.py` so they can be reused by the UI's "Definitions" tab.
"""

from .base import BaseStrategyDetector
from .opponent import OpponentStrategyDetector
from .user import UserBuildDetector
from .definitions import (
    BUILD_DEFINITIONS,
    KNOWN_BUILDS,
    initialize_custom_builds,
    load_custom_builds,
)

__all__ = [
    "BaseStrategyDetector",
    "OpponentStrategyDetector",
    "UserBuildDetector",
    "BUILD_DEFINITIONS",
    "KNOWN_BUILDS",
    "initialize_custom_builds",
    "load_custom_builds",
]
