"""Lazy native system speech for explicit Companion scouting reports."""
from __future__ import annotations

import math
import re
import sys


MAX_SPEECH_CHARACTERS = 1600


def _speech_text(value, limit=MAX_SPEECH_CHARACTERS):
    if not isinstance(value, str):
        return ""
    text = re.sub(r"\s+", " ", "".join(character for character in value if character.isprintable() or character.isspace())).strip()
    if len(text) <= limit:
        return text
    clipped = text[:limit - 1]
    if " " in clipped and clipped.rfind(" ") > limit * 0.8:
        clipped = clipped.rsplit(" ", 1)[0]
    return clipped.rstrip() + "…"


def build_scouting_report(context):
    """Read only supplied current identity, head-to-head, and opted-in notes."""
    if not isinstance(context, dict):
        return ""
    parts = []
    name = _speech_text(context.get("revealedName") or context.get("name"), 120)
    if name:
        parts.append("Opponent: " + name + ".")
    race = {
        "p": "Protoss", "protoss": "Protoss", "t": "Terran", "terran": "Terran",
        "z": "Zerg", "zerg": "Zerg", "r": "Random", "random": "Random",
    }.get(str(context.get("race") or "").strip().casefold())
    if race:
        parts.append("Race: " + race + ".")
    mmr = context.get("mmr")
    if type(mmr) in {int, float} and math.isfinite(mmr) and 0 < mmr <= 100000:
        parts.append(f"MMR: {round(mmr)}.")
    verified = context.get("opponentIdentityMatched") is not False
    record = context.get("headToHead") if verified else None
    if isinstance(record, dict):
        wins, losses = record.get("wins"), record.get("losses")
        if all(type(value) is int and 0 <= value <= 100000 for value in (wins, losses)):
            parts.append(f"Your record: {wins} {'win' if wins == 1 else 'wins'} and {losses} {'loss' if losses == 1 else 'losses'}.")
    notes = context.get("opponentNotes") if verified else None
    if isinstance(notes, dict) and notes.get("readAloud") is True:
        text = _speech_text(notes.get("text"), 1100)
        if text:
            parts.append("Your scouting notes: " + text)
    return _speech_text(" ".join(parts))


def _system_engine(parent):
    from PySide6 import QtTextToSpeech

    engines = QtTextToSpeech.QTextToSpeech.availableEngines()
    if not engines:
        raise RuntimeError("No system text-to-speech engine is installed")
    engine = QtTextToSpeech.QTextToSpeech("sapi", parent) if sys.platform == "win32" and "sapi" in engines else QtTextToSpeech.QTextToSpeech(parent)
    try:
        if not _speech_text(engine.voice().name(), 120):
            voices = engine.availableVoices()
            if voices:
                locale = engine.locale().name()
                selected = next((voice for voice in voices if voice.locale().name() == locale), voices[0])
                engine.setVoice(selected)
    except Exception:
        pass
    return engine


def build_scouting_speech(parent, *, QtCore, engine_factory=None):
    """Create an idle QObject; the first explicit speak initializes system audio.

    ``available()`` is None before initialization, True for a healthy initialized
    engine, and False after an error or shutdown. Tests can inject a factory that
    accepts the owning QObject and returns a signal-compatible speech engine.
    """

    class NativeScoutingSpeech(QtCore.QObject):
        statusChanged = QtCore.Signal(str)

        def __init__(self):
            super().__init__(parent)
            self._engine = None
            self._closed = False
            self._availability = None
            self._error = ""
            self._status = "Native scouting voice is ready on request."

        def status(self):
            return self._status

        def available(self):
            return False if self._closed else self._availability

        def last_error(self):
            return self._error

        def voice_label(self):
            if self._engine is not None:
                try:
                    name = _speech_text(self._engine.voice().name(), 120)
                    if name:
                        return "System voice · " + name
                except Exception:
                    pass
            return "System default voice"

        def _set_status(self, text):
            if text != self._status:
                self._status = text
                self.statusChanged.emit(text)

        def _fail(self, error):
            self._availability = False
            self._error = _speech_text(str(error), 240) or "The system speech engine did not become available"
            self._set_status("Native scouting voice unavailable: " + self._error)
            return False

        def _state_name(self, state):
            return str(getattr(state, "name", state)).rsplit(".", 1)[-1].casefold()

        def _engine_error_text(self):
            try:
                return self._engine.errorString()
            except Exception:
                return "The system speech engine reported an error"

        def _state_changed(self, state):
            if self._closed:
                return
            name = self._state_name(state)
            if name == "error":
                self._fail(self._engine_error_text())
            elif name == "ready":
                self._availability = True
                self._error = ""
                self._set_status("Ready · " + self.voice_label())
            elif name == "speaking":
                self._availability = True
                self._error = ""
                self._set_status("Speaking · " + self.voice_label())
            elif name == "paused":
                self._set_status("Native scouting voice paused.")

        def _engine_error(self, _reason, message):
            if not self._closed:
                self._fail(message or self._engine_error_text())

        def _ensure_engine(self):
            if self._engine is None:
                try:
                    self._engine = (engine_factory or _system_engine)(self)
                    if not all(callable(getattr(self._engine, method, None)) for method in ("say", "stop", "state")):
                        raise RuntimeError("The system speech engine is incomplete")
                    self._engine.stateChanged.connect(self._state_changed)
                    self._engine.errorOccurred.connect(self._engine_error)
                except Exception as error:
                    self._engine = None
                    self._fail(error)
                    return False
            try:
                state = self._engine.state()
                if self._state_name(state) == "error":
                    return self._fail(self._engine_error_text())
                self._state_changed(state)
                return True
            except Exception as error:
                return self._fail(error)

        def _stop_engine(self):
            if self._engine is None:
                return True
            try:
                immediate = getattr(getattr(self._engine, "BoundaryHint", None), "Immediate", None)
                if immediate is None:
                    self._engine.stop()
                else:
                    self._engine.stop(immediate)
                return True
            except Exception as error:
                return self._fail(error)

        def speak(self, text):
            if self._closed:
                return False
            text = _speech_text(text)
            if not text:
                self._set_status("No scouting text to read.")
                return False
            if QtCore.QThread.currentThread() != self.thread():
                return self._fail("Request scouting speech from the Companion window")
            if not self._ensure_engine() or not self._stop_engine():
                return False
            try:
                self._set_status("Starting native scouting report…")
                self._engine.say(text)
                if self._state_name(self._engine.state()) == "error":
                    return self._fail(self._engine_error_text())
                return True
            except Exception as error:
                return self._fail(error)

        def stop(self):
            if not self._closed and self._stop_engine():
                self._set_status("Native scouting voice stopped.")

        def shutdown(self):
            if self._closed:
                return
            self._closed = True
            self._stop_engine()
            engine, self._engine = self._engine, None
            if engine is not None:
                try:
                    engine.deleteLater()
                except Exception:
                    pass
            self._set_status("Native scouting voice closed.")

    return NativeScoutingSpeech()
