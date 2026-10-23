from __future__ import annotations

import builtins
from enum import Enum
import math
import os
from types import SimpleNamespace

import pytest

from sc2tools_agent.ui.companion_speech import MAX_SPEECH_CHARACTERS, build_scouting_report, build_scouting_speech
from sc2tools_agent.ui import companion_speech


os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


def test_report_uses_only_supplied_identity_record_and_opted_in_notes():
    report = build_scouting_report({
        "name": "Current opponent", "race": "T", "mmr": 4123.4,
        "headToHead": {"wins": 2, "losses": 1},
        "opponentNotes": {"text": "Scout the second gas", "readAloud": True},
        "last5GamesScouting": [{"oppStrategy": "Hidden historical opening", "timeSec": 80}],
        "predictedStrategies": [{"name": "Uncertain current tech"}],
        "notes": "Unapproved note", "notesReadAloud": True,
    })
    assert report == "Opponent: Current opponent. Race: Terran. MMR: 4123. Your record: 2 wins and 1 loss. Your scouting notes: Scout the second gas"
    assert "Hidden" not in report and "Uncertain" not in report and "Unapproved" not in report


@pytest.mark.parametrize("permission", [False, None, "true", 1])
def test_notes_require_explicit_read_aloud_opt_in(permission):
    assert "private" not in build_scouting_report({"name": "Opponent", "opponentNotes": {"text": "private", "readAloud": permission}})


def test_report_does_not_infer_missing_or_invalid_profile_values():
    assert build_scouting_report(None) == ""
    assert build_scouting_report({}) == ""
    for mmr in (True, -1, 0, "4000", math.nan, math.inf):
        report = build_scouting_report({"name": "Known name", "race": "Unknown", "mmr": mmr,
                                        "headToHead": {"wins": True, "losses": 1},
                                        "totals": {"wins": 5, "losses": 6}, "oppRaceModal": "Zerg"})
        assert report == "Opponent: Known name."


def test_explicit_unmatched_identity_never_reads_candidate_history_or_private_notes():
    report = build_scouting_report({
        "name": "Current opponent", "race": "Terran", "mmr": 4000,
        "opponentIdentityMatched": False,
        "headToHead": {"wins": 5, "losses": 2},
        "opponentNotes": {"text": "Private notes for an unverified candidate", "readAloud": True},
    })
    assert report == "Opponent: Current opponent. Race: Terran. MMR: 4000."


def test_report_and_text_are_bounded_and_control_characters_are_removed():
    report = build_scouting_report({"name": "A" * 10000, "race": "Zerg", "mmr": 4200,
                                    "opponentNotes": {"readAloud": True, "text": "private\x00\n" * 10000}})
    assert len(report) <= MAX_SPEECH_CHARACTERS
    assert "\x00" not in report and "\n" not in report


@pytest.fixture
def fake_speech():
    pytest.importorskip("PySide6")
    from PySide6 import QtCore, QtWidgets

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])

    class State(Enum):
        Ready = 0
        Speaking = 1
        Paused = 2
        Error = 3

    class Engine(QtCore.QObject):
        stateChanged = QtCore.Signal(object)
        errorOccurred = QtCore.Signal(object, str)

        def __init__(self, parent):
            super().__init__(parent)
            self.calls = []
            self.current_state = State.Ready
            self.message = ""

        def state(self):
            return self.current_state

        def voice(self):
            return SimpleNamespace(name=lambda: "Test system voice")

        def errorString(self):
            return self.message

        def stop(self):
            self.calls.append(("stop",))
            self.current_state = State.Ready
            self.stateChanged.emit(State.Ready)

        def say(self, text):
            self.calls.append(("say", text))
            self.current_state = State.Speaking
            self.stateChanged.emit(State.Speaking)

        def fail(self, message):
            self.message = message
            self.current_state = State.Error
            self.stateChanged.emit(State.Error)
            self.errorOccurred.emit("Playback", message)

    engines = []

    def factory(parent):
        engine = Engine(parent)
        engines.append(engine)
        return engine

    speech = build_scouting_speech(None, QtCore=QtCore, engine_factory=factory)
    yield speech, engines, app, QtCore, State
    speech.shutdown()
    speech.deleteLater()
    app.processEvents()


def test_factory_initialization_stop_and_shutdown_never_create_an_engine(fake_speech):
    speech, engines, app, QtCore, State = fake_speech
    assert engines == []
    assert speech.available() is None
    assert speech.voice_label() == "System default voice"
    assert not speech.speak("  \n\x00  ")
    speech.stop()
    speech.shutdown()
    speech.shutdown()
    assert engines == []
    assert not speech.speak("Report after shutdown")
    assert speech.available() is False


def test_explicit_speech_uses_actual_voice_and_cancels_previous_report(fake_speech):
    speech, engines, app, QtCore, State = fake_speech
    statuses = []
    speech.statusChanged.connect(statuses.append)
    assert speech.speak("First report")
    assert speech.available() is True
    assert speech.voice_label() == "System voice · Test system voice"
    assert len(engines) == 1
    assert speech.speak("Second report")
    assert engines[0].calls == [("stop",), ("say", "First report"), ("stop",), ("say", "Second report")]
    assert statuses[-1] == "Speaking · System voice · Test system voice"
    speech.stop()
    assert engines[0].calls[-1] == ("stop",)
    assert "stopped" in statuses[-1]


def test_speech_bounds_direct_text_and_reports_engine_errors(fake_speech):
    speech, engines, app, QtCore, State = fake_speech
    assert speech.speak("Words " * 1000 + "\x00")
    assert len(engines[0].calls[-1][1]) <= MAX_SPEECH_CHARACTERS
    engines[0].fail("Audio output is unavailable")
    assert speech.available() is False
    assert speech.last_error() == "Audio output is unavailable"
    assert "unavailable" in speech.status()
    assert not speech.speak("Retry while engine remains in error")
    speech.shutdown()
    previous_status = speech.status()
    engines[0].stateChanged.emit(State.Speaking)
    assert speech.status() == previous_status


def test_stop_requests_immediate_boundary_when_native_engine_supports_it(fake_speech):
    speech, engines, app, QtCore, State = fake_speech
    assert speech.speak("Initial report")
    engine = engines[0]
    engine.BoundaryHint = SimpleNamespace(Immediate="immediate")
    engine.stop = lambda boundary: engine.calls.append(("stop", boundary))
    speech.stop()
    assert engine.calls[-1] == ("stop", "immediate")


def test_factory_failure_is_safe_and_retried_only_on_explicit_speak(fake_speech):
    original, engines, app, QtCore, State = fake_speech
    calls = []

    def unavailable(parent):
        calls.append(parent)
        raise RuntimeError("No installed system voice")

    speech = build_scouting_speech(None, QtCore=QtCore, engine_factory=unavailable)
    assert calls == []
    try:
        assert not speech.speak("Scouting report")
        assert len(calls) == 1
        assert speech.available() is False
        assert "No installed system voice" in speech.status()
        speech.stop()
        assert len(calls) == 1
        assert not speech.speak("Explicit retry")
        assert len(calls) == 2
    finally:
        speech.shutdown()
        speech.deleteLater()


def test_default_backend_import_is_lazy_and_missing_module_is_safe(fake_speech, monkeypatch):
    original, engines, app, QtCore, State = fake_speech
    imports = []
    importer = builtins.__import__

    def reject_speech_module(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "PySide6" and "QtTextToSpeech" in fromlist:
            imports.append(name)
            raise ImportError("QtTextToSpeech is not installed")
        return importer(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", reject_speech_module)
    idle = build_scouting_speech(None, QtCore=QtCore)
    idle.stop()
    idle.shutdown()
    assert imports == []
    speech = build_scouting_speech(None, QtCore=QtCore)
    try:
        assert not speech.speak("Native scouting report")
        assert imports == ["PySide6"]
        assert speech.available() is False
        assert "QtTextToSpeech is not installed" in speech.last_error()
    finally:
        speech.shutdown()
        speech.deleteLater()
        idle.deleteLater()


@pytest.mark.parametrize("platform,engines,expected", [
    ("win32", ["winrt", "sapi", "mock"], ("sapi", None)),
    ("win32", ["winrt"], (None,)),
    ("linux", ["sapi", "speechd"], (None,)),
])
def test_system_backend_prefers_windows_sapi_only_when_available(fake_speech, monkeypatch, platform, engines, expected):
    import PySide6

    calls = []
    engine = SimpleNamespace(voice=lambda: SimpleNamespace(name=lambda: "Installed voice"))

    class Backend:
        @staticmethod
        def availableEngines():
            return engines

        def __new__(cls, *args):
            calls.append(args)
            return engine

    monkeypatch.setattr(PySide6, "QtTextToSpeech", SimpleNamespace(QTextToSpeech=Backend), raising=False)
    monkeypatch.setattr(companion_speech.sys, "platform", platform)
    assert companion_speech._system_engine(None) is engine
    assert calls == [expected]


@pytest.mark.parametrize("locale,expected", [("en_US", "Microsoft Zira Desktop"), ("fr_FR", "Installed German voice")])
def test_empty_default_voice_selects_installed_current_locale_or_first_voice(fake_speech, monkeypatch, locale, expected):
    import PySide6

    def voice(name, locale_name):
        return SimpleNamespace(name=lambda: name, locale=lambda: SimpleNamespace(name=lambda: locale_name))

    voices = [voice("Installed German voice", "de_DE"), voice("Microsoft Zira Desktop", "en_US")]
    current = [voice("", "en_US")]
    selected = []

    def set_voice(chosen):
        current[0] = chosen
        selected.append(chosen.name())

    engine = SimpleNamespace(voice=lambda: current[0], availableVoices=lambda: voices,
                             locale=lambda: SimpleNamespace(name=lambda: locale), setVoice=set_voice)

    class Backend:
        @staticmethod
        def availableEngines():
            return ["sapi"]

        def __new__(cls, *args):
            return engine

    monkeypatch.setattr(PySide6, "QtTextToSpeech", SimpleNamespace(QTextToSpeech=Backend), raising=False)
    monkeypatch.setattr(companion_speech.sys, "platform", "win32")
    assert companion_speech._system_engine(None).voice().name() == expected
    assert selected == [expected]


def test_no_installed_backend_fails_without_creating_audio_engine(fake_speech, monkeypatch):
    import PySide6

    class Backend:
        @staticmethod
        def availableEngines():
            return []

        def __new__(cls, *args):
            raise AssertionError("No engine should be constructed")

    monkeypatch.setattr(PySide6, "QtTextToSpeech", SimpleNamespace(QTextToSpeech=Backend), raising=False)
    with pytest.raises(RuntimeError, match="No system text-to-speech engine"):
        companion_speech._system_engine(None)
