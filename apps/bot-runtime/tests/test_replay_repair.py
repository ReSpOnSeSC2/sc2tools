from copy import deepcopy
import hashlib
from io import BytesIO
import struct
from types import SimpleNamespace
import zlib

import mpyq
import pytest

from pluto_sc2.replay_repair import _encrypt, label_changes, pack_mpq, repair_replay


def crypt():
    return mpyq.MPQArchive.__new__(mpyq.MPQArchive)


def initialization(name=b"Long API player name", *, battlenet=False):
    return {"m_syncLobbyState": {
        "m_gameDescription": {"m_gameOptions": {"m_battleNet": battlenet}, "m_randomValue": 7},
        "m_userInitialData": [{"m_name": name, "m_clanTag": None}],
        "m_lobbyState": {"m_slots": [{"m_toonHandle": name}]}}}


def test_table_encryption_round_trips_through_independent_reader():
    data = struct.pack("<IIII", 0, 0xFFFFFFFF, 12345, 987654)
    archive = crypt()
    key = archive._hash("(hash table)", "TABLE")
    assert archive._decrypt(_encrypt(data, key, archive.encryption_table), key) == data


def test_mpq_members_and_crc_md5_attributes_round_trip():
    members = [(b"replay.game.events", b"game events\0\xff"), (b"empty", b""),
               (b"(listfile)", b"replay.game.events\r\nempty\r\n"), (b"(attributes)", b"")]
    result = pack_mpq(b"", members, crypt())
    archive = mpyq.MPQArchive(BytesIO(result))
    assert archive.header["format_version"] == 0
    for name, data in members[:-1]:
        assert (archive.read_file(name) or b"") == data
    attributes = archive.read_file("(attributes)")
    assert struct.unpack_from("<II", attributes) == (100, 5)
    assert struct.unpack_from("<I", attributes, 8)[0] == zlib.crc32(members[0][1])
    assert attributes[8 + 4 * len(members):8 + 4 * len(members) + 16] == hashlib.md5(members[0][1]).digest()


def test_only_empty_engine_backup_player_labels_can_be_restored():
    old, backup = initialization(), initialization(b"")
    assert {item["field"].split("/")[-1] for item in label_changes(old, backup)} == {"m_name", "m_toonHandle"}
    changed_seed = deepcopy(backup)
    changed_seed["m_syncLobbyState"]["m_gameDescription"]["m_randomValue"] = 8
    with pytest.raises(ValueError, match="beyond player labels"):
        label_changes(old, changed_seed)
    with pytest.raises(ValueError, match="beyond player labels"):
        label_changes(old, initialization(b"Someone else"))


@pytest.fixture
def local_replay(tmp_path, monkeypatch):
    from pluto_sc2 import replays
    original, backup = initialization(), initialization(b"")
    monkeypatch.setattr(replays, "_metadata_protocol", lambda: SimpleNamespace(
        decode_replay_initdata=lambda data: deepcopy(original if data == b"original init" else backup)))
    data = {b"replay.initData": b"original init", b"replay.initData.backup": b"backup init",
            b"replay.game.events": b"all original gameplay commands\0\xff",
            b"replay.details": b"original labels retained here"}
    members = list(data.items()) + [(b"(listfile)", b"\r\n".join(data) + b"\r\n"), (b"(attributes)", b"")]
    userdata = b"original SC2 user metadata"
    prefix = (struct.pack("<4sIII", b"MPQ\x1b", len(userdata), 512, len(userdata)) + userdata).ljust(512, b"\0")
    path = tmp_path / "original.SC2Replay"
    path.write_bytes(pack_mpq(prefix, members, crypt()))
    return path, original, backup, prefix


def test_derived_copy_preserves_source_prefix_and_gameplay(local_replay, tmp_path):
    source, _, _, prefix = local_replay
    before = source.read_bytes()
    target = tmp_path / "viewing-copy.SC2Replay"
    report = repair_replay(source, target)
    assert source.read_bytes() == before
    assert target.read_bytes()[:len(prefix)] == prefix
    result = mpyq.MPQArchive(str(target))
    assert result.read_file("replay.initData") == b"backup init"
    assert result.read_file("replay.game.events") == b"all original gameplay commands\0\xff"
    assert result.read_file("replay.details") == b"original labels retained here"
    assert report["source_sha256"] == hashlib.sha256(before).hexdigest()
    assert report["user_data_prefix_preserved"] is True
    assert report["engine_playback_verified"] is False


def test_original_or_existing_target_cannot_be_overwritten(local_replay, tmp_path):
    source = local_replay[0]
    with pytest.raises(ValueError, match="new file"):
        repair_replay(source, source)
    target = tmp_path / "existing.SC2Replay"
    target.write_bytes(b"do not replace")
    with pytest.raises(ValueError, match="new file"):
        repair_replay(source, target)
    assert target.read_bytes() == b"do not replace"


def test_nonlabel_backup_changes_are_rejected_without_output(local_replay, tmp_path):
    source, _, backup, _ = local_replay
    backup["m_syncLobbyState"]["m_gameDescription"]["m_randomValue"] = 1000
    target = tmp_path / "not-created.SC2Replay"
    with pytest.raises(ValueError, match="beyond player labels"):
        repair_replay(source, target)
    assert not target.exists()


def test_battlenet_replay_is_ineligible(local_replay, tmp_path):
    source, original, _, _ = local_replay
    original["m_syncLobbyState"]["m_gameDescription"]["m_gameOptions"]["m_battleNet"] = True
    with pytest.raises(ValueError, match="Only local API"):
        repair_replay(source, tmp_path / "not-created.SC2Replay")


def test_signed_archive_is_not_repacked():
    with pytest.raises(ValueError, match="Signed archives"):
        pack_mpq(b"", [(b"(signature)", b"signature")], crypt())
