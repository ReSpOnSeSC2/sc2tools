import sys
import json
import argparse
from typing import Dict, Any

def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()

def analyze_tips(data: Dict[str, Any]) -> Dict[str, Any]:
    tips = []
    good = []
    bad = []

    my_stats = data.get('my_stats', [])
    opp_stats = data.get('opp_stats', [])
    my_events = data.get('my_events', [])

    my_max_army = max((s.get('army_val', 0) for s in my_stats), default=0)
    opp_max_army = max((s.get('army_val', 0) for s in opp_stats), default=0)

    if my_max_army > opp_max_army * 1.2:
        good.append("You built a significantly larger army peak than your opponent.")
    elif opp_max_army > my_max_army * 1.2:
        bad.append("Your opponent outproduced you significantly in army value.")

    bases = [e for e in my_events if e.get('type') == 'building' and e.get('name') in ['Nexus', 'Hatchery', 'CommandCenter']]
    if len(bases) > 1:
        second_base_time = bases[1].get('time', 9999)
        if second_base_time < 180:
            good.append(f"Solid early expansion timing ({int(second_base_time//60)}:{int(second_base_time%60):02d}).")
        elif second_base_time > 240:
            bad.append(f"Late expansion ({int(second_base_time//60)}:{int(second_base_time%60):02d}) delayed your economy.")

    if data.get('result') == 'Victory':
        tips.append("Your macro and engagements won you the game. Review the final battle on the timeline to see exactly how your composition traded.")
    else:
        tips.append("Look at the timeline to find the engagement where your army value dropped significantly. Analyze your unit composition vs theirs.")

    if not good:
        good.append("Solid effort playing the game out to the end.")
    if not bad:
        bad.append("Always room to improve macro cycle timings (workers, production, supply).")

    return {
        "tips": tips,
        "good": good,
        "bad": bad
    }

def main() -> int:
    try:
        input_data = sys.stdin.read()
        if not input_data:
            _emit({"ok": False, "error": "No data provided on stdin"})
            return 1

        data = json.loads(input_data)
        analysis = analyze_tips(data)
        _emit({"ok": True, "result": analysis})
        return 0
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})
        return 2

if __name__ == "__main__":
    sys.exit(main())
