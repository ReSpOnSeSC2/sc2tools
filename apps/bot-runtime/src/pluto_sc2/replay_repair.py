"""Create a derived viewing copy for SC2's API player-label replay defect.

The original archive is never changed. Only replay.initData is restored from
its own engine-created backup, after proving every decoded difference is a
player label. Gameplay members and the SC2 user-data prefix remain identical.
"""
from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path
import struct
import zlib

import mpyq


def _differences(a, b, path=()):
    if type(a) is not type(b):
        return [(path, a, b)]
    if isinstance(a, dict):
        return [change for key in a.keys() | b.keys() for change in _differences(a.get(key), b.get(key), (*path, key))]
    if isinstance(a, list):
        if len(a) != len(b):
            return [(path, a, b)]
        return [change for index, (left, right) in enumerate(zip(a, b))
                for change in _differences(left, right, (*path, index))]
    return [] if a == b else [(path, a, b)]


def label_changes(original: dict, backup: dict) -> list[dict]:
    changes = _differences(original, backup)
    if not changes:
        raise ValueError("Replay backup has no player-label changes to restore")
    reports = []
    for path, old, new in changes:
        user = (len(path) == 4 and path[:2] == ("m_syncLobbyState", "m_userInitialData")
                and isinstance(path[2], int) and path[3] in ("m_name", "m_clanTag"))
        slot = (len(path) == 5 and path[:3] == ("m_syncLobbyState", "m_lobbyState", "m_slots")
                and isinstance(path[3], int) and path[4] == "m_toonHandle")
        if not (user or slot) or new not in (None, b"") or not isinstance(old, (bytes, type(None))):
            raise ValueError("Replay backup differs beyond player labels; automatic viewing-copy repair refused")
        reports.append({"field": "/".join(map(str, path)),
                        "original": old.decode("utf-8", "replace") if old is not None else None,
                        "restored": new.decode("utf-8", "replace") if new is not None else None})
    return reports


def _encrypt(data: bytes, key: int, crypt_table) -> bytes:
    seed1, seed2 = key, 0xEEEEEEEE
    result = bytearray()
    for (value,) in struct.iter_unpack("<I", data):
        seed2 = (seed2 + crypt_table[0x400 + (seed1 & 0xFF)]) & 0xFFFFFFFF
        result += struct.pack("<I", value ^ ((seed1 + seed2) & 0xFFFFFFFF))
        seed1 = (((~seed1 << 21) + 0x11111111) | (seed1 >> 11)) & 0xFFFFFFFF
        seed2 = (value + seed2 + (seed2 << 5) + 3) & 0xFFFFFFFF
    return bytes(result)


def pack_mpq(prefix: bytes, members: list[tuple[bytes, bytes]], crypt) -> bytes:
    """Pack ordinary named members as an uncompressed MPQ v0 archive.

    The caller supplies the original SC2 prefix and the original block order.
    Internal CRC/MD5 attributes are regenerated for the derived member bytes.
    """
    members = list(members)
    names = [name for name, _ in members]
    if len(set(names)) != len(names) or not members:
        raise ValueError("MPQ member names must be nonempty and unique")
    if b"(signature)" in names:
        raise ValueError("Signed archives cannot be rewritten as viewing copies")
    if b"(attributes)" in names:
        attributes = struct.pack("<II", 100, 5)
        attributes += b"".join(struct.pack("<I", 0 if name == b"(attributes)" else zlib.crc32(data))
                               for name, data in members)
        attributes += b"".join(b"\0" * 16 if name == b"(attributes)" else hashlib.md5(data).digest()
                               for name, data in members)
        members[names.index(b"(attributes)")] = (b"(attributes)", attributes)
    table_size = 1
    while table_size < len(members) * 2:
        table_size *= 2
    hashes = [b"\xff" * 16 for _ in range(table_size)]
    blocks, body = [], bytearray()
    for index, (name, contents) in enumerate(members):
        blocks.append(struct.pack("<IIII", 32 + len(body), len(contents), len(contents), 0x81000000))
        body += contents
        slot = crypt._hash(name, "TABLE_OFFSET") % table_size
        while hashes[slot] != b"\xff" * 16:
            slot = (slot + 1) % table_size
        hashes[slot] = struct.pack("<IIHHI", crypt._hash(name, "HASH_A"), crypt._hash(name, "HASH_B"), 0, 0, index)
    body += b"\0" * ((-len(body)) % 4)
    hash_offset = 32 + len(body)
    encrypted_hashes = _encrypt(b"".join(hashes), crypt._hash("(hash table)", "TABLE"), crypt.encryption_table)
    encrypted_blocks = _encrypt(b"".join(blocks), crypt._hash("(block table)", "TABLE"), crypt.encryption_table)
    block_offset = hash_offset + len(encrypted_hashes)
    archive_size = block_offset + len(encrypted_blocks)
    header = struct.pack("<4sIIHHIIII", b"MPQ\x1a", 32, archive_size, 0, 3,
                         hash_offset, block_offset, table_size, len(members))
    return prefix + header + body + encrypted_hashes + encrypted_blocks


def repair_replay(source: Path, target: Path) -> dict:
    """Write one verified derived copy; refuse other metadata/gameplay changes."""
    source, target = Path(source).resolve(), Path(target).resolve()
    if source == target or target.exists():
        raise ValueError("A viewing repair must use a new file and preserve the original")
    original = source.read_bytes()
    archive = mpyq.MPQArchive(BytesIO(original))
    from pluto_sc2.replays import _metadata_protocol
    protocol = _metadata_protocol()
    init = protocol.decode_replay_initdata(archive.read_file("replay.initData"))
    backup_data = archive.read_file("replay.initData.backup")
    if not backup_data:
        raise ValueError("Replay has no engine-created initData backup")
    backup = protocol.decode_replay_initdata(backup_data)
    options = init.get("m_syncLobbyState", {}).get("m_gameDescription", {}).get("m_gameOptions", {})
    if options.get("m_battleNet") is not False:
        raise ValueError("Only local API replays are eligible for this viewing-copy repair")
    changes = label_changes(init, backup)
    names = list(archive.files or [])
    for name in (b"(listfile)", b"(attributes)", b"(signature)"):
        if archive.get_hash_table_entry(name) is not None and name not in names:
            names.append(name)
    if b"(signature)" in names:
        raise ValueError("Signed replay archives are not eligible")
    names.sort(key=lambda name: archive.get_hash_table_entry(name).block_table_index)
    indexes = [archive.get_hash_table_entry(name).block_table_index for name in names]
    if indexes != list(range(len(archive.block_table))):
        raise ValueError("Replay contains unnamed or ambiguous archive members")
    members = [(name, backup_data if name == b"replay.initData" else archive.read_file(name) or b"") for name in names]
    prefix = original[:archive.header["offset"]]
    derived = pack_mpq(prefix, members, archive)
    check = mpyq.MPQArchive(BytesIO(derived))
    preserved = []
    for name in names:
        if name not in (b"replay.initData", b"(attributes)"):
            if (check.read_file(name) or b"") != (archive.read_file(name) or b""):
                raise ValueError(f"Derived copy changed preserved member {name!r}")
            preserved.append(name.decode("ascii"))
    if check.read_file("replay.initData") != backup_data or derived[:len(prefix)] != prefix:
        raise ValueError("Derived copy verification failed")
    if source.read_bytes() != original:
        raise ValueError("Original replay changed during viewing-copy creation")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as stream:
        stream.write(derived)
    return {"source": str(source), "derived_replay": str(target),
            "source_sha256": hashlib.sha256(original).hexdigest(), "derived_sha256": hashlib.sha256(derived).hexdigest(),
            "restored_member": "replay.initData", "source_member": "replay.initData.backup",
            "changes": changes, "preserved_members": preserved, "user_data_prefix_preserved": True,
            "archive_format": "MPQ v0, regenerated internal CRC/MD5 attributes", "engine_playback_verified": False}
