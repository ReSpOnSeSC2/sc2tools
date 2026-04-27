import pytest
import sys
import unittest.mock
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Mock sc2reader
sys.modules['sc2reader'] = unittest.mock.MagicMock()
sys.modules['sc2reader.events'] = unittest.mock.MagicMock()
sys.modules['sc2reader.events.tracker'] = unittest.mock.MagicMock()

from core.map_playback_data import centroid

def test_centroid_window_zero_exact_match():
    """Test exact time match with 0.0 window size."""
    events = [
        {"time": 5, "x": 10, "y": 10},
        {"time": 10, "x": 20, "y": 20},
        {"time": 10, "x": 30, "y": 10},
        {"time": 15, "x": 40, "y": 40},
    ]
    # t=10, window=0. Only items with time=10 should match.
    result = centroid(events, 10, window=0)
    assert result == (25.0, 15.0)

def test_centroid_window_zero_no_match():
    """Test when window=0.0 and no exact timestamp matches."""
    events = [
        {"time": 5, "x": 10, "y": 10},
        {"time": 15, "x": 40, "y": 40},
    ]
    result = centroid(events, 10, window=0)
    assert result is None
