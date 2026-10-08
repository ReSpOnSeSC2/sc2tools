import sys

import pytest

from sc2tools_agent.streaming import secret_store


@pytest.mark.skipif(sys.platform != "win32", reason="Windows DPAPI integration")
def test_dpapi_round_trip_does_not_write_plaintext(tmp_path):
    path = tmp_path / "credentials.private"
    value = {"access_token": "fixture-secret-value", "client": "own-app"}
    secret_store.write_json(path, value)
    assert b"fixture-secret-value" not in path.read_bytes()
    assert secret_store.read_json(path) == value


def test_plaintext_credentials_rejected(tmp_path):
    path = tmp_path / "credentials.private"
    path.write_text('{"access_token":"not-encrypted"}')
    with pytest.raises(secret_store.SecretStoreError):
        secret_store.read_json(path)


def test_encrypt_failure_preserves_previous_file(tmp_path, monkeypatch):
    path = tmp_path / "credentials.private"
    path.write_bytes(b"previous")
    def fail(*args, **kwargs):
        raise secret_store.SecretStoreError("failed")
    monkeypatch.setattr(secret_store, "_protect", fail)
    with pytest.raises(secret_store.SecretStoreError):
        secret_store.write_json(path, {"token": "fixture"})
    assert path.read_bytes() == b"previous"
