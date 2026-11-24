"""Keep installer launches behind the match, stream, capture and snooze gates.

Automatic installs also wait until no game has run for two minutes (the agent's
own start counts as one), so a player who queues again keeps the agent. Install
now skips only that quiet period. A running match, a live OBS output or a
replay capture still holds it, and the click is remembered so the update
installs as soon as that ends. Later cancels a remembered click.
"""
import math
import threading
import time
from .state import save_state
from .updater import update_is_mandatory

QUIET_SEC = 120  # how long no game must have run before an automatic install


class UpdateScheduler:
    def __init__(self, *, gate, state, state_dir, install, streaming=lambda:False,
                 capturing=lambda:False, notify=lambda *_:None, now=time.time,
                 automatic_allowed=lambda:True):
        self.gate, self.state, self.state_dir = gate, state, state_dir
        self.install, self.streaming, self.capturing = install, streaming, capturing
        self.notify, self.now = notify, now
        self.automatic_allowed = automatic_allowed
        self.release = None
        self.received_at = 0
        self.error = ""
        self._lock = threading.RLock()
        self._installed = False
        self._installing = False
        self._requested = False  # an Install now waiting for a match, stream or capture to end
        self._stop = threading.Event()

    def offer(self, release):
        with self._lock:
            if self.release is None or self.release.latest != release.latest:
                self.received_at = (self.state.update_first_seen_at if self.state.update_pending_version==release.latest else None) or self.now()
                self.state.update_pending_version = release.latest
                self.state.update_first_seen_at = self.received_at
                save_state(self.state_dir,self.state)
                self.error = ""
                self._installed = False
            self.release = release
            busy = self._installing or self._installed
        if not busy:  # a repeat offer must not reset the card while the installer downloads
            self.notify(release, "ready", "")
        self.tick()

    def _hold(self, requested):
        """What must end before any install starts, worded for the card; "" when nothing holds it."""
        if self.gate.busy:
            return "Installs as soon as this match ends" if requested else "Will install after this match"
        if self.streaming():
            return ("Installs as soon as OBS stops streaming and recording" if requested
                    else "Will install when OBS stops streaming and recording")
        if self.capturing():
            return ("Installs as soon as the replay capture finishes" if requested
                    else "Will install when the replay capture finishes")
        return ""

    def eligible(self, *, explicit=False):
        if self.release is None or self._installing or self._installed:
            return False, ""
        explicit = explicit or self._requested
        hold = self._hold(explicit)
        if hold:
            return False, hold
        if not explicit and not self.automatic_allowed():
            return False, "Download the installer to update this source install."
        mandatory = update_is_mandatory(self.release)
        deadline = self.received_at + 86400
        snoozed = (self.state.update_snoozed_until or 0) > self.now()
        if not explicit and snoozed and not (mandatory and self.now() >= deadline):
            return False, "Remind me tomorrow"
        if not explicit and not self.state.auto_update_enabled and not mandatory:
            return False, "Ready when you are"
        remaining = QUIET_SEC - self.gate.free_for
        if not explicit and remaining > 0:
            wait = "a minute" if remaining <= 60 else f"{math.ceil(remaining / 60)} minutes"
            return False, f"Will install in about {wait} if no game starts"
        return True, ""

    def tick(self, *, explicit=False):
        with self._lock:
            allowed, reason = self.eligible(explicit=explicit)
            if not allowed:
                # A download in progress, or one already handed to the installer, keeps its card.
                if self.release is not None and not (self._installing or self._installed):
                    if explicit:
                        self._requested = True
                    self.notify(self.release, "queued" if self._requested else "deferred", reason)
                return False
            self._installing = True
            self._requested = False
        try:
            self.notify(self.release, "installing", "Downloading the verified installer…")
            self.install(self.release)
            self._installed = True
            return True
        except Exception as exc:
            self.error = (str(exc).strip().splitlines() or ["The installer could not start. Open Activity log for details."])[0][:300]
            self.notify(self.release, "failed", self.error)
            return False
        finally:
            with self._lock:
                self._installing = False

    def later(self):
        self._requested = False  # Later also cancels a queued Install now
        mandatory = self.release is not None and update_is_mandatory(self.release)
        if mandatory and self.now() >= self.received_at + 86400:
            self.notify(self.release,"deferred","This required update will install at the next safe time.")
            return False
        self.state.update_snoozed_until = self.now() + 86400
        save_state(self.state_dir, self.state)
        if self.release:
            self.notify(self.release, "deferred", "Required updates defer at most 24 hours after discovery." if mandatory else "Remind me tomorrow")

    def poll(self):
        """One background pass. A failed install waits for Retry, unless a Retry is already queued."""
        if not self.error or self._requested:
            self.tick()

    def start(self, stop_event):
        def loop():
            while not stop_event.wait(5):
                self.poll()
        threading.Thread(target=loop,name="sc2tools-update-scheduler",daemon=True).start()
