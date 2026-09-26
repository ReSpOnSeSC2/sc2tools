"""Request a persistent graceful stop for this workspace's training workers."""
from pathlib import Path


def request_stop(root):
    root = Path(root).resolve()
    targets = [root / "runs" / name for name in
               ("training-pipeline", "response-league", "response-league-monitor")]
    targets.extend(root / "runs" / f"response90-{race}-teachers" / partition
                   for race in ("terran", "zerg") for partition in ("train", "validation"))
    for target in targets:
        if not target.resolve().is_relative_to(root):
            raise ValueError("Stop marker must stay within the training workspace")
        target.mkdir(parents=True, exist_ok=True)
        (target / "STOP").write_text("User requested a graceful stop after the current game.\n")
    return targets


if __name__ == "__main__":
    for path in request_stop(Path(__file__).resolve().parents[1]):
        print(path / "STOP")
