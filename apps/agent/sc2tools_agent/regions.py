"""Shared Blizzard toon-handle region labels."""
TOON_REGIONS = {"1": "NA", "2": "EU", "3": "KR", "5": "CN", "6": "SEA", "98": "PTR"}


def region_from_toon_handle(handle):
    return TOON_REGIONS.get(handle.split("-", 1)[0]) if isinstance(handle, str) else None
