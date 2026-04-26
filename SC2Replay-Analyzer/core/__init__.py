"""Core layer: replay loading, event extraction, low-level utilities.

This package wraps `sc2reader` and centralizes the constants/helpers used to
parse a single replay into a stream of structured events. It deliberately has
no dependency on the UI, the database, or the strategy detectors so that
replay-parsing concerns live in one place.
"""
