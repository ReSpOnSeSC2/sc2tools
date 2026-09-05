"""Exercise observed tracks against a real replay in a clean sc2reader process."""
from pathlib import Path
import subprocess
import sys


def test_replay_waypoints_are_only_tracker_observations():
    root = Path(__file__).resolve().parents[1]
    fixture = root / "tests/fixtures/replays/warpgate_adept_tracking.SC2Replay"
    script = r'''
import collections
import sc2reader
from core.event_extractor import extract_unit_tracks
from core.timebase import event_seconds_precise
from sc2reader.events.tracker import UnitBornEvent, UnitInitEvent, UnitDiedEvent, UnitPositionsEvent
r = sc2reader.load_replay(__import__('sys').argv[1], load_level=4, load_map=False)
out = extract_unit_tracks(r, 1)
assert out['complete']
observed, active = collections.defaultdict(set), {}
for e in r.tracker_events:
    t = round(event_seconds_precise(e, r), 3)
    if isinstance(e, (UnitBornEvent, UnitInitEvent)):
        active[e.unit_id_index] = e.unit_id
        observed[e.unit_id].add((t, float(e.x), float(e.y)))
    elif isinstance(e, UnitDiedEvent):
        observed[e.unit_id].add((t, float(e.x), float(e.y)))
        active.pop(e.unit_id_index, None)
    elif isinstance(e, UnitPositionsEvent):
        for index, xy in e.positions:
            observed[active.get(index)].add((t, float(xy[0]), float(xy[1])))
units = out['my_units'] + out['opp_units']
assert len({u['id'] for u in units}) == len(units)
assert sum(u['name'] == 'Adept' for u in units) == 49
assert not any(u['name'].startswith('Beacon') for u in units)
assert not any(u['name'] == 'AdeptPhaseShift' for u in units)
for u in units:
    wp = u['waypoints']
    assert all(tuple(wp[i:i+3]) in observed[u['id']] for i in range(0, len(wp), 3)), u
    assert all(a < b for a, b in zip(wp[0::3], wp[3::3])), u
    assert u['died'] is None or wp[-3] <= u['died']
    if any(f['name'] == 'Baneling' for f in u.get('forms', [])):
        assert u['name'] == 'Zergling'
print('verified', len(units), 'unit lifetimes and', sum(len(u['waypoints'])//3 for u in units), 'observations')
'''
    result = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, " + repr(str(root)) + ");" + script,
                             str(fixture)], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
