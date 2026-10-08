"""Separate OBS connection for lifecycle reads and explicit virtual-camera actions."""
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

    @staticmethod
    def _camera_status(raw):
        active = raw.get_virtual_cam_status().output_active
        video = raw.get_video_settings()
        width, height = video.base_width, video.base_height
        if not isinstance(active, bool) or any(type(value) is not int or value <= 0 for value in (width, height)):
            raise ValueError()
        return {"virtual_camera_active": active, "main_width": width, "main_height": height,
                "reason": "Main canvas is horizontal. Verify Main Output in OBS virtual-camera settings." if width > height
                else "Set OBS's main canvas to a horizontal resolution before using this TikTok setup."}

    def virtual_camera_status(self):
        with self.lock:
            try:
                return self._camera_status(self._connection())
            except Exception:
                self.close()
                return {"virtual_camera_active": None, "main_width": None, "main_height": None,
                        "reason": "OBS controls are disabled." if self.disabled else "Open OBS and check the agent's OBS connection settings."}

    def set_virtual_camera(self, active):
        if not isinstance(active, bool):
            raise ValueError("Choose start or stop virtual camera.")
        with self.lock:
            try:
                raw = self._connection()
                before = self._camera_status(raw)
            except Exception:
                self.close()
                raise ValueError("OBS controls are disabled." if self.disabled else "OBS could not be checked. Open OBS and check the agent's connection settings.") from None
            if active and before["main_width"] <= before["main_height"]:
                raise ValueError("TikTok uses your horizontal feed. Set OBS's main canvas to landscape first.")
            try:
                if before["virtual_camera_active"] != active:
                    if active:
                        raw.start_virtual_cam()
                    else:
                        raw.stop_virtual_cam()
                after = self._camera_status(raw)
                if after["virtual_camera_active"] != active:
                    raise RuntimeError()
                return after
            except Exception:
                self.close()
                raise ValueError("Virtual-camera state could not be verified. Check OBS before trying again.") from None

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
