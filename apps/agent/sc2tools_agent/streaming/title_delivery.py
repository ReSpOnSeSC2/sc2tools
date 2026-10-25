"""One title delivery path for manual saves and opted-in cloud automation."""
from __future__ import annotations


def apply_title(service, title, description, platforms, *, client=None):
    from .cloud_client import CloudTitleAdapter
    if service.stop_event.is_set():
        return
    if "youtube" in platforms:
        previous_api = service.backend.api
        if client:
            from .cloud_client import CloudGoogleAPI
            service.backend.api = CloudGoogleAPI(client, lambda: service.backend.config.get("expected_channel_id"))
        try:
            result = service.backend.dispatch({"action": "set_metadata", "title": title, "description": description})
        finally:
            service.backend.api = previous_api
        if result.get("code") == "metadata_invalid":
            raise ValueError("Use a description within 4,808 UTF-8 bytes without angle brackets; space is reserved for the horizontal stream link.")
        if result.get("future_template_saved") is False:
            raise ValueError("The title could not be saved locally. Check free disk space, then try again. Platform titles were not changed.")
        service.metadata_saved = True
        service.platform_results["youtube"] = {"ok": result.get("ok", False), "message": " ".join(result.get("messages", []))}
    for name in ("twitch", "kick"):
        if name not in platforms:
            continue
        if service.stop_event.is_set():
            return
        adapter = CloudTitleAdapter(client, name) if client else service.adapters.get(name)
        if adapter is None:
            service.platform_results[name] = {"ok": False, "message": "Account connection required."}
            continue
        try:
            status = adapter.update_title(title)
            service.platform_status[name] = status
            verified = status.get("title") == title and status.get("titleVerified") is not False
            offline = (name == "kick" and status.get("titleStatus") == "accepted_offline"
                and status.get("accepted") is True and status.get("titleVerified") is False
                and status.get("title") == title and status.get("connected") is True)
            messages = {"pending": "Title accepted; confirmation is pending.",
                "rejected": "Title was rejected. Your account remains connected.",
                "unverified": "Title request could not be verified. Check the platform before trying again."}
            message = ("Title verified." if verified else
                "Title accepted by Kick. Its API hides the title while offline." if offline else
                messages.get(status.get("titleStatus"), "Title has not been verified."))
            service.platform_results[name] = {"ok": verified or offline, "message": message,
                "title_verified": verified, "title_status": status.get("titleStatus", "verified" if verified else "unverified")}
        except Exception as error:
            if getattr(error, "connection_invalid", False) is True:
                service.platform_status[name] = {"platform": name, "connected": False, "reason": "Stream-control permission must be reconnected."}
            service.platform_results[name] = {"ok": False, "message": "Title request could not be verified. Check the platform before trying again."}
