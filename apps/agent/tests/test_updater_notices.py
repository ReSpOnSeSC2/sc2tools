from datetime import datetime, timedelta, timezone

import pytest

from sc2tools_agent.updater import _coerce_release, notice_is_current


def notice(**patch):
    return {"severity": "warning", "message": "Uploads are delayed. Replays stay on this PC.", "href": "/help/desktop-app-overview", "endsAt": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(), **patch}


def release(raw):
    return _coerce_release({"update_available": False, "notice": raw}, fallback_current="0.19.0")


def test_notice_is_available_without_an_update_or_installer():
    info = release(notice())
    assert info.artifact is None
    assert not info.update_available
    assert info.notice.message == "Uploads are delayed. Replays stay on this PC."
    assert info.notice.severity == "warning"
    assert notice_is_current(info.notice)
    assert len(info.notice.hash) == 24


@pytest.mark.parametrize("patch", [{"endsAt": "bad"}, {"endsAt": "2000-01-01T00:00:00Z"}, {"endsAt": "2100-01-01"}, {"message": "x" * 241}, {"message": "hello\nworld"}, {"severity": "unsupported"}])
def test_expired_or_malformed_notices_are_ignored(patch):
    assert release(notice(**patch)).notice is None


@pytest.mark.parametrize("href", ["https://evil.example", "//evil.example", "/\\evil", "/help/a\nlink", "javascript:alert(1)"])
def test_notice_text_survives_but_unsafe_links_are_removed(href):
    info = release(notice(href=href))
    assert info.notice is not None
    assert info.notice.href is None


def test_repeated_notice_has_the_same_identity_and_changes_get_a_new_identity():
    raw = notice()
    assert release(raw).notice.hash == release(raw).notice.hash
    assert release(raw).notice.hash != release({**raw, "message": "Maintenance has started."}).notice.hash
