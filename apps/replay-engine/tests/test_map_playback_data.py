import sys
import os
from unittest.mock import MagicMock

sys.modules['sc2reader'] = MagicMock()
sys.modules['sc2reader.events'] = MagicMock()
sys.modules['sc2reader.events.tracker'] = MagicMock()

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import pytest
from core.map_playback_data import bounds_for, DEFAULT_BOUNDS

def test_bounds_for_empty_map_name():
    """Test bounds_for when map_name is None and events is empty."""
    bounds = bounds_for(None, [])

    # Assert it returns a fallback bounds dictionary
    assert bounds["x_min"] == float(DEFAULT_BOUNDS.get("x_min", 0))
    assert bounds["x_max"] == float(DEFAULT_BOUNDS.get("x_max", 200))
    assert bounds["y_min"] == float(DEFAULT_BOUNDS.get("y_min", 0))
    assert bounds["y_max"] == float(DEFAULT_BOUNDS.get("y_max", 200))
    assert bounds["starting_locations"] == DEFAULT_BOUNDS.get("starting_locations", [])
