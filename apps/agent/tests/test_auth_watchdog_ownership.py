"""Request-origin revocation checks with held synthetic profile requests."""
import threading
from unittest.mock import Mock

import pytest

from sc2tools_agent.api_client import DeviceUnauthorized
from sc2tools_agent.auth_watchdog import AuthWatchdog


def denied():
    return DeviceUnauthorized(401, "synthetic revoked device")


@pytest.mark.parametrize("same_api", [False, True])
def test_old_held_confirmation_cannot_unlink_or_poison_new_epoch(same_api):
    entered, release = threading.Event(), threading.Event()
    old = Mock()
    current_api, current_epoch = [old], [object()]
    old_epoch = current_epoch[0]
    callbacks = []

    def profile():
        entered.set()
        assert release.wait(3)
        raise denied()

    old.get_profile.side_effect = profile
    watchdog = AuthWatchdog(get_api=lambda: current_api[0], get_epoch=lambda: current_epoch[0],
        on_unlinked=lambda: pytest.fail("scoped production callback was bypassed"),
        on_unlinked_current=lambda api, epoch: callbacks.append((api, epoch)) or True)
    watchdog.failure(denied(), api=old, epoch=old_epoch)
    worker = threading.Thread(target=lambda: watchdog.failure(denied(), api=old, epoch=old_epoch))
    worker.start()
    try:
        assert entered.wait(2)
        newer = old if same_api else Mock()
        current_api[0], current_epoch[0] = newer, object()
        watchdog.reset()
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and callbacks == []
    newer.get_profile.side_effect = denied()
    before = newer.get_profile.call_count
    watchdog.failure(denied(), api=newer, epoch=current_epoch[0])
    assert newer.get_profile.call_count == before and not callbacks
    watchdog.failure(denied(), api=newer, epoch=current_epoch[0])
    assert newer.get_profile.call_count == before + 1
    assert callbacks == [(newer, current_epoch[0])]


def test_stale_request_failure_and_success_neither_count_nor_reset_current_threshold():
    old, current = Mock(), Mock()
    old_epoch, epoch = object(), object()
    current.get_profile.side_effect = denied()
    unlinked = Mock()
    watchdog = AuthWatchdog(get_api=lambda: current, get_epoch=lambda: epoch, on_unlinked=unlinked)
    watchdog.failure(denied(), api=old, epoch=old_epoch)
    assert not current.get_profile.called and not unlinked.called
    watchdog.failure(denied(), api=current, epoch=epoch)
    watchdog.success(api=old, epoch=old_epoch)
    watchdog.failure(denied(), api=old, epoch=old_epoch)
    assert not current.get_profile.called
    watchdog.failure(denied(), api=current, epoch=epoch)
    assert current.get_profile.call_count == 1
    unlinked.assert_called_once_with()


def test_old_counter_admission_cannot_overwrite_first_current_failure(monkeypatch):
    old, current = Mock(), Mock()
    current.get_profile.side_effect = denied()
    active_api, active_epoch = [old], [object()]
    old_epoch = active_epoch[0]
    unlinked = Mock()
    watchdog = AuthWatchdog(get_api=lambda: active_api[0], get_epoch=lambda: active_epoch[0], on_unlinked=unlinked)
    entered, release = threading.Event(), threading.Event()
    check = watchdog._current
    checks = []

    def held_after_validation(api, epoch):
        result = check(api, epoch)
        if threading.current_thread().name == "owned-old-counter-admission":
            checks.append(result)
            if len(checks) == 2:
                assert result is True
                entered.set()
                assert release.wait(3)
        return result

    monkeypatch.setattr(watchdog, "_current", held_after_validation)
    worker = threading.Thread(name="owned-old-counter-admission",
        target=lambda: watchdog.failure(denied(), api=old, epoch=old_epoch))
    worker.start()
    try:
        assert entered.wait(2)
        active_api[0], active_epoch[0] = current, object()
        watchdog.reset()
        watchdog.failure(denied(), api=current, epoch=active_epoch[0])
        assert not current.get_profile.called
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and not old.get_profile.called
    watchdog.failure(denied(), api=current, epoch=active_epoch[0])
    assert current.get_profile.call_count == 1
    unlinked.assert_called_once_with()


def test_first_failure_from_new_epoch_does_not_inherit_old_failure_count():
    api, epoch = Mock(), [object()]
    api.get_profile.side_effect = denied()
    unlinked = Mock()
    watchdog = AuthWatchdog(get_api=lambda: api, get_epoch=lambda: epoch[0], on_unlinked=unlinked)
    watchdog.failure(denied(), api=api, epoch=epoch[0])
    epoch[0] = object()
    watchdog.failure(denied(), api=api, epoch=epoch[0])
    assert not api.get_profile.called and not unlinked.called
    watchdog.failure(denied(), api=api, epoch=epoch[0])
    assert api.get_profile.call_count == 1
    unlinked.assert_called_once_with()


def test_refused_scoped_retirement_does_not_mark_new_context_unlinked():
    first, second = Mock(), Mock()
    current_api, epoch = [first], [object()]
    first.get_profile.side_effect = second.get_profile.side_effect = denied()
    applied = []

    def retirement(api, captured_epoch):
        assert api is first and captured_epoch is not None
        current_api[0], epoch[0] = second, object()
        return False

    watchdog = AuthWatchdog(get_api=lambda: current_api[0], get_epoch=lambda: epoch[0],
        on_unlinked=lambda: pytest.fail("unscoped retirement"), on_unlinked_current=retirement)
    captured = epoch[0]
    watchdog.failure(denied(), api=first, epoch=captured)
    watchdog.failure(denied(), api=first, epoch=captured)
    watchdog._on_unlinked_current = lambda api, captured_epoch: applied.append((api, captured_epoch)) or True
    watchdog.failure(denied(), api=second, epoch=epoch[0])
    assert not applied
    watchdog.failure(denied(), api=second, epoch=epoch[0])
    assert applied == [(second, epoch[0])]


def test_reset_does_not_release_actual_held_confirmation_reservation():
    entered, release = threading.Event(), threading.Event()
    first, second = Mock(), Mock()
    current_api, epoch = [first], [object()]
    unlinked = Mock()

    def held():
        entered.set()
        assert release.wait(3)
        return {}

    first.get_profile.side_effect = held
    second.get_profile.side_effect = denied()
    watchdog = AuthWatchdog(get_api=lambda: current_api[0], get_epoch=lambda: epoch[0], on_unlinked=unlinked)
    original_epoch = epoch[0]
    watchdog.failure(denied(), api=first, epoch=original_epoch)
    worker = threading.Thread(target=lambda: watchdog.failure(denied(), api=first, epoch=original_epoch))
    worker.start()
    try:
        assert entered.wait(2)
        current_api[0], epoch[0] = second, object()
        watchdog.reset()
        watchdog.failure(denied(), api=second, epoch=epoch[0])
        watchdog.failure(denied(), api=second, epoch=epoch[0])
        assert not second.get_profile.called and not unlinked.called
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and not unlinked.called
    watchdog.failure(denied(), api=second, epoch=epoch[0])
    assert second.get_profile.call_count == 1
    unlinked.assert_called_once_with()
