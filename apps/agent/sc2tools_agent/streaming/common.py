"""Shared streaming definitions; no runtime paths or import-time side effects."""


class HelperError(RuntimeError):
    """Safe operational message that never includes platform credentials."""


OCCUPIED = {"created", "ready", "testing", "testStarting", "live", "liveStarting"}
TERMINAL = {"complete", "revoked"}
OUTPUTS = {
    "horizontal": "aitum_multi_output_YouTube Output",
    "portrait": "vertical_canvas_stream_YouTube Output",
}
