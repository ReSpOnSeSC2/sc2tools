"""One exact JSON wire representation and the API's fixed ingest ceiling."""
import json
import math

GAME_BODY_MAX_BYTES = 5 * 1024 * 1024


def _canonical_numbers(value):
    # JavaScript has one numeric type. Removing '.0' is lossless for JSON
    # consumers and is material for million-element replay arrays.
    if isinstance(value, float) and math.isfinite(value) and value == int(value):
        return int(value)
    if isinstance(value, list):
        return [_canonical_numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: _canonical_numbers(item) for key, item in value.items()}
    return value


def compact_json_bytes(value):
    return json.dumps(_canonical_numbers(value), separators=(',', ':'), allow_nan=False).encode('utf-8')


def playback_byte_budget(payload):
    """Exact available playback bytes in a singleton batch, including key."""
    placeholder = dict(payload, mapPlayback=None)
    return GAME_BODY_MAX_BYTES - len(compact_json_bytes({'games': [placeholder]})) + 4
