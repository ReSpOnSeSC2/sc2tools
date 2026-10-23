from dataclasses import replace
from pathlib import Path
import pytest
from sc2tools_agent.status_model import AgentStatus, ConnectionFacts, StatusFacts, derive_status


def facts(**changes):
    return replace(StatusFacts(phase="ready", paired=True, folders=[Path("2-S2-1-42/Replays/Multiplayer")]), **changes)


@pytest.mark.parametrize("changes,expected", [
    ({"boot_error":"boom", "phase":"watching"}, AgentStatus.ERROR),
    ({"phase":"boot_error"}, AgentStatus.ERROR),
    ({"phase":"connecting..."}, AgentStatus.CONNECTING),
    ({"analyzer_ok":False,"analyzer_diag":"broken"}, AgentStatus.ERROR),
    ({"unlinked":True,"paused":True}, AgentStatus.UNLINKED),
    ({"paired":False}, AgentStatus.NEEDS_PAIRING),
    ({"paused":True,"connection":ConnectionFacts("offline",12,1200)}, AgentStatus.PAUSED),
    ({"connection":ConnectionFacts("server_busy",12,1200)}, AgentStatus.NEEDS_ATTENTION),
    ({"terminal_failure_times":[900,950]}, AgentStatus.WATCHING),
    ({"terminal_failure_times":[900,950,999]}, AgentStatus.NEEDS_ATTENTION),
    ({"terminal_failure_times":[1,2,3]}, AgentStatus.WATCHING),
    ({"folders":[]}, AgentStatus.NEEDS_ATTENTION),
    ({"pending_count":12}, AgentStatus.SYNCING),
    ({"phase":"starting"}, AgentStatus.STARTING),
])
def test_priority_table(changes, expected):
    assert derive_status(facts(**changes), 1000).status == expected


def test_status_copy_filter_region_and_error_length():
    view = derive_status(facts(folders=[Path("1-S2-1-1/Replays"),Path("2-S2-1-2/Replays")], filter_label="Season 67 only", last_upload_at=820),1000)
    assert view.headline == "Watching 2 folders (EU, NA) · Season 67 only"
    assert view.cause == "Last upload 3 min ago" and view.action=="open_settings"
    error = derive_status(facts(boot_error="X"*300+"\nsecret next line"),1000)
    assert error.cause == "X"*140 and error.secondary_action=="copy_details"
