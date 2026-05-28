import sys
import os
import pytest
from unittest.mock import MagicMock

# Mock sc2reader before any db imports to prevent ModuleNotFoundError
if 'sc2reader' not in sys.modules:
    sys.modules['sc2reader'] = MagicMock()

# Add parent directory to path to allow importing 'db'
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(os.path.dirname(_HERE))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from db.migrations import (
    ensure_schema_version,
    migrate,
    stamp_schema_version,
    CURRENT_SCHEMA_VERSION,
)

def test_ensure_schema_version_empty():
    data, version = ensure_schema_version({})
    assert data == {}
    assert version == 1

def test_ensure_schema_version_valid():
    data, version = ensure_schema_version({"_schema_version": 2, "build1": {"games": []}})
    assert data == {"build1": {"games": []}}
    assert version == 2

def test_ensure_schema_version_invalid():
    data, version = ensure_schema_version({"_schema_version": "invalid", "build1": {}})
    assert data == {"build1": {}}
    assert version == 1

def test_ensure_schema_version_not_dict():
    data, version = ensure_schema_version("not a dict")
    assert data == {}
    assert version == 1

def test_migrate_v1_to_current():
    data = {"build1": {"games": []}}
    migrated, version = migrate(data, 1)
    assert version == CURRENT_SCHEMA_VERSION
    assert migrated == data

def test_migrate_idempotent():
    data = {"build1": {"games": []}}
    migrated, version = migrate(data, CURRENT_SCHEMA_VERSION)
    assert version == CURRENT_SCHEMA_VERSION
    assert migrated == data

def test_stamp_schema_version_basic():
    payload = {"build1": {"games": []}}
    stamped = stamp_schema_version(payload)
    assert "_schema_version" in stamped
    assert stamped["_schema_version"] == CURRENT_SCHEMA_VERSION
    assert "build1" in stamped

def test_stamp_schema_version_custom():
    stamped = stamp_schema_version({}, version=99)
    assert "_schema_version" in stamped
    assert stamped["_schema_version"] == 99

def test_stamp_schema_version_overwrite():
    payload = {"_schema_version": 1, "other_meta": "test"}
    stamped = stamp_schema_version(payload, version=2)
    assert stamped["_schema_version"] == 2
    assert stamped["other_meta"] == "test"
