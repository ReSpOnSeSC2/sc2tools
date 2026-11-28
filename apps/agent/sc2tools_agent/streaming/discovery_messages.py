"""What the Streams page says when loading the YouTube channel and keys fails.

Each message names the next step and never a provider error code, for the
SC2Tools-hosted connection and for the streamer's own Google client alike.
"""
from __future__ import annotations


def discovery_failure_message(http_status, account_mode="sc2tools"):
    """Actionable, provider-free explanation for a failed channel/key discovery."""
    local = account_mode == "local"
    if http_status in {401, 403}:
        if local:
            return "YouTube authorization through your own Google client is missing or expired. Connect YouTube again, then refresh keys."
        return "YouTube stream-control permission is missing or expired. Connect YouTube again in your browser, then refresh connections."
    if http_status == 404 and not local:
        return "This SC2Tools server does not provide YouTube stream controls yet."
    if http_status == 409:
        return "Another YouTube request for this account is still running. Your channel and keys were not loaded yet."
    if http_status == 429:
        return "YouTube request limit reached. Your channel and keys were not loaded yet."
    if local:
        return "Your YouTube channel and reusable keys could not be loaded from YouTube. Existing selections are unchanged."
    return "Your YouTube channel and reusable keys could not be loaded through SC2Tools. Existing selections are unchanged."
