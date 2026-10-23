"""Keep installer launches behind the match, stream, capture and snooze gates."""
import threading
import time
from .state import save_state
from .updater import update_is_mandatory


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
        self.notify(release, "ready", "")
        self.tick()

    def eligible(self, *, explicit=False):
        if self.release is None or self._installing or self._installed:
            return False, ""
        if self.gate.busy or self.gate.free_for < 120 or self.streaming() or self.capturing():
            return False, "Will install after this match"
        if not explicit and not self.automatic_allowed():
            return False, "Download the installer to update this source install."
        mandatory = update_is_mandatory(self.release)
        deadline = self.received_at + 86400
        snoozed = (self.state.update_snoozed_until or 0) > self.now()
        if not explicit and snoozed and not (mandatory and self.now() >= deadline):
            return False, "Remind me tomorrow"
        if not explicit and not self.state.auto_update_enabled and not mandatory:
            return False, "Ready when you are"
        return True, ""

    def tick(self, *, explicit=False):
        with self._lock:
            allowed, reason = self.eligible(explicit=explicit)
            if not allowed:
                if self.release:
                    self.notify(self.release, "deferred", reason)
                return False
            self._installing = True
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
        mandatory = self.release is not None and update_is_mandatory(self.release)
        if mandatory and self.now() >= self.received_at + 86400:
            self.notify(self.release,"deferred","This required update will install at the next safe time.")
            return False
        self.state.update_snoozed_until = self.now() + 86400
        save_state(self.state_dir, self.state)
        if self.release:
            self.notify(self.release, "deferred", "Required updates defer at most 24 hours after discovery." if mandatory else "Remind me tomorrow")

    def start(self, stop_event):
        def loop():
            while not stop_event.wait(5):
                if not self.error:
                    self.tick()
        threading.Thread(target=loop,name="sc2tools-update-scheduler",daemon=True).start()
