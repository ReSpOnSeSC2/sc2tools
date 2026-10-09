"""Separate OBS connection for output lifecycle reads."""
from __future__ import annotations

import threading

DEFAULT_OUTPUTS = {
    "horizontal": "aitum_multi_output_YouTube Output",
    "portrait": "vertical_canvas_stream_YouTube Output",
}


class OutputReader:
    def __init__(self, settings_provider, *, disabled=False, factory=None):
        self.settings_provider = settings_provider
        self.disabled = disabled
        self.factory = factory
        self.raw = None
        self.settings = None
        self.lock = threading.RLock()

    def close(self):
        with self.lock:
            if self.raw is not None:
                try:
                    self.raw.disconnect()
                except Exception:
                    pass
            self.raw = None

    def _connection(self):
        if self.disabled:
            raise ValueError("OBS controls are disabled for this agent.")
        settings = self.settings_provider()
        if self.raw is not None and self.settings != settings:
            self.close()
        if self.raw is None:
            factory = self.factory
            if factory is None:
                from obsws_python import ReqClient
                factory = ReqClient
            self.raw = factory(**settings, timeout=3)
            self.settings = settings
        return self.raw

    def __call__(self, output_names=None):
        names = output_names or DEFAULT_OUTPUTS
        unknown = {"horizontal": None, "portrait": None}
        if self.disabled:
            return unknown
        with self.lock:
            try:
                self._connection()
                inventory = self.raw.get_output_list().outputs
                if not isinstance(inventory, list):
                    raise ValueError()
                if any(not isinstance(row, dict) or not isinstance(row.get("outputName"), str) or not row["outputName"].strip() for row in inventory):
                    raise ValueError()
                listed = {row["outputName"] for row in inventory}
                if len(listed) != len(inventory):
                    raise ValueError()
                result = {}
                for scope in ("horizontal", "portrait"):
                    name = names.get(scope)
                    if not isinstance(name, str) or not name:
                        return unknown
                    # A complete successful OBS inventory proves an absent
                    # named output is inactive. A failed inventory is unknown.
                    if name not in listed:
                        result[scope] = False
                    else:
                        active = self.raw.get_output_status(name).output_active
                        result[scope] = active if isinstance(active, bool) else None
                return result
            except Exception:
                self.close()
                return unknown
