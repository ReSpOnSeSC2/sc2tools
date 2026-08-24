#!/usr/bin/env python3
"""Unpack a replay batch exported from the SC2 Tools Locker.

Usage:  python unpack_batch.py replays-Alex-2026-08-24.json [outdir]

Writes each .SC2Replay into outdir (default: ./inbox/<student>/<date>/) and
prints ready-to-run grade_replay.py commands for the batch.
"""
import base64, json, os, re, sys

def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    bundle = json.load(open(sys.argv[1], encoding="utf-8"))
    if bundle.get("locker") != "sc2tools-coaching":
        sys.exit("Not a Locker replay bundle.")
    student = re.sub(r"\W+", "_", bundle.get("student", "student"))
    date = (bundle.get("exported") or "")[:10] or "batch"
    outdir = sys.argv[2] if len(sys.argv) > 2 else os.path.join("inbox", student, date)
    os.makedirs(outdir, exist_ok=True)
    cmds = []
    for it in bundle.get("items", []):
        name = os.path.basename(it["name"])
        path = os.path.join(outdir, name)
        with open(path, "wb") as f:
            f.write(base64.b64decode(it["b64"]))
        tag = f"  # build: {it['build']}" if it.get("build") else ""
        cmds.append(f'python grade_replay.py "{path}" --refs coaching_builds.json --player {bundle.get("student","")}{tag}')
    print(f"{len(cmds)} replays -> {outdir}\n")
    print("Grade them (add --build <id> per the tag):")
    for c in cmds:
        print(" ", c)
    print("\nThen import the .grade.json files back into the Locker's Inbox tab.")

if __name__ == "__main__":
    main()
