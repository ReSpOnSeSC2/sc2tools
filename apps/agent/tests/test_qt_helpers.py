import socket
from urllib.error import HTTPError, URLError

import pytest

from sc2tools_agent.ui import qt_helpers


@pytest.mark.parametrize("address,valid", [
    ("", True), ("https://example.test", True), ("http://localhost:8080", True),
    ("http://127.0.0.1:8080", True), ("http://[::1]:8080", True),
    ("http://remote.example", False), ("sc2tools.com", False), ("ftp://example.test", False),
    ("https://", False), ("https://example.test:bad", False),
    ("https://bad host.example", False),
])
def test_validate_api_base(address, valid):
    assert (qt_helpers.validate_api_base(address) is None) == valid


@pytest.mark.parametrize("failure,reason", [
    (TimeoutError(), "timeout"),
    (HTTPError("https://example.test", 503, "busy", {}, None), "HTTP 503"),
    (URLError(socket.gaierror("missing")), "name not found"),
])
def test_health_failure_copy(monkeypatch, failure, reason):
    def fail(*args, **kwargs):
        raise failure
    monkeypatch.setattr(qt_helpers, "urlopen", fail)
    assert qt_helpers.probe_api_health("https://example.test") == f"Couldn't reach that address ({reason})"
