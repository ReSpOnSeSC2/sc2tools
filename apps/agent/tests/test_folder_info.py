from pathlib import Path
import os
from sc2tools_agent import replay_finder
from sc2tools_agent.folder_info import describe_folder, folder_label
ORIGINAL_CANDIDATES = replay_finder.candidate_documents_dirs


def test_redirected_known_documents_precedes_fallback(tmp_path,monkeypatch):
    monkeypatch.setattr(replay_finder,"candidate_documents_dirs",ORIGINAL_CANDIDATES)
    docs=tmp_path/"moved"
    docs.mkdir()
    monkeypatch.setattr(replay_finder,"_known_documents_dir",lambda:docs)
    monkeypatch.setattr(replay_finder,"_registry_documents_dir",lambda:None)
    monkeypatch.setattr(Path,"home",lambda:tmp_path)
    assert next(replay_finder.candidate_documents_dirs())==docs


def test_localized_onedrive_documents_are_discovered(tmp_path,monkeypatch):
    monkeypatch.setattr(replay_finder,"candidate_documents_dirs",ORIGINAL_CANDIDATES)
    docs=tmp_path/"OneDrive - Travail"/"Mes documents"
    replay=docs/"StarCraft II"/"Accounts"/"123"/"2-S2-1-42"/"Replays"/"Multiplayer"
    replay.mkdir(parents=True)
    monkeypatch.setattr(replay_finder,"_known_documents_dir",lambda:None)
    monkeypatch.setattr(replay_finder,"_registry_documents_dir",lambda:None)
    monkeypatch.setattr(Path,"home",lambda:tmp_path)
    monkeypatch.delenv("SC2TOOLS_REPLAY_FOLDER",raising=False)
    assert replay in replay_finder.all_multiplayer_dirs_anywhere()


def test_folder_identity_counts_newest_and_missing(tmp_path):
    root=tmp_path/"2-S2-1-42"/"Replays"/"Multiplayer"
    root.mkdir(parents=True)
    (root/"one.SC2Replay").write_bytes(b"replay")
    (root/"nested").mkdir()
    (root/"nested"/"two.sc2replay").write_bytes(b"replay")
    os.utime(root/"one.SC2Replay",(900,900))
    os.utime(root/"nested"/"two.sc2replay",(1000,1000))
    info=describe_folder(root)
    assert (info.region,info.toon,info.replay_count,info.newest_mtime,info.exists)==("EU","2-S2-1-42",2,1000,True)
    assert folder_label(info,now=8200)=="EU · 2-S2-1-42 · 2 replays · newest 2 h ago"
    missing=describe_folder(root/"gone")
    assert not missing.exists and "Not found" in folder_label(missing)
