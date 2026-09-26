"""Render recorded own PvZ wall positions over engine pathing, without inferring a seal."""

import argparse
import html
import json
import math
from pathlib import Path


def esc(value):
    return html.escape(str(value))


def render(folder):
    phases = [json.loads((folder / f"phase-{t:04d}.json").read_text()) for t in (120, 180, 240, 300)]
    source = json.loads((folder / "source.json").read_text())
    public = json.loads((folder / "public-protoss-footprints.json").read_text())["units"]
    map_name = source["replay_info"]["map_name"]
    tags = {}
    counts = {}
    kinds = {
        "GATEWAY": "G",
        "WARPGATE": "G",
        "CYBERNETICSCORE": "C",
        "PYLON": "P",
        "NEXUS": "N",
        "SHIELDBATTERY": "B",
    }
    natural = phases[0]["natural_raw_position"]
    x0, y0 = math.floor(natural[0] - 19), math.floor(natural[1] - 15)
    for phase in phases:
        for unit in sorted(phase["own_near_natural"], key=lambda u: (-u["build_progress"], u["position"])):
            x, y = unit["position"]
            if unit["type"] not in kinds or not (x0 <= x < x0 + 30 and y0 <= y < y0 + 30):
                continue
            if unit["tag"] not in tags:
                prefix = kinds[unit["type"]]
                counts[prefix] = counts.get(prefix, 0) + 1
                tags[unit["tag"]] = f"{prefix}{counts[prefix]}"
    out = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1310" viewBox="0 0 1500 1310">',
        '<rect width="1500" height="1310" fill="#f8fafc"/>',
        "<style>text{font-family:Arial,sans-serif;fill:#172338}.small{font-size:12px}.label{font-size:13px;font-weight:700}.title{font-size:27px;font-weight:700}</style>",
        f'<text x="30" y="40" class="title">{esc(map_name)} — natural wall development</text>',
        f'<text x="30" y="69" font-size="18">{esc(phases[0]["label"])} | exact engine coordinates, recorded eight-worker game</text>',
        '<text x="30" y="94" font-size="14">Light: open · Dark: blocked · Pink: doorway cells · Orange: footprint estimates (Warp Gates use Gateway outline) · Blue: own units</text>',
    ]
    for index, phase in enumerate(phases):
        left, top = 35 + (index % 2) * 750, 140 + (index // 2) * 550
        scale = 15

        def point(x, y):
            return left + (x - x0) * scale, top + (y0 + 30 - y) * scale

        out.append(
            f'<text x="{left}" y="{top - 14}" font-size="21" font-weight="700">{int(phase["seconds"] // 60)}:00</text>'
        )
        grid = phase["map_grid_crops"]["pathing_grid"]
        gx, gy = grid["origin_xy"]
        doorway = set()
        if phase["seconds"] >= 240:
            if phase["replay_id"].startswith("86b7"):
                doorway = {(126, y) for y in (41, 42, 43)}
            elif phase["replay_id"].startswith("d001"):
                doorway = {(126, 100)}
            elif phase["replay_id"].startswith("fca4"):
                doorway = {(x, 113) for x in range(170, 174 if phase["seconds"] >= 300 else 172)}
        for y in range(y0, y0 + 30):
            for x in range(x0, x0 + 30):
                xx, yy = point(x, y + 1)
                value = grid["rows_y_ascending"][y - gy][x - gx]
                color = "#e6edf5" if value else "#425267"
                if (x, y) in doorway:
                    assert value, "Annotated doorway must be open in the recorded engine grid"
                    color = "#e4a3d7"
                out.append(
                    f'<rect x="{xx}" y="{yy}" width="15" height="15" fill="{color}" stroke="#94a3b8" stroke-width=".25"/>'
                )
        legend_y = top + 8
        for unit in phase["own_near_natural"]:
            x, y = unit["position"]
            if not (x0 <= x < x0 + 30 and y0 <= y < y0 + 30):
                continue
            xx, yy = point(x, y)
            if unit["tag"] in tags:
                label = tags[unit["tag"]]
                metadata = public.get(str(unit["unit_type_id"]), {})
                radius = metadata.get("public_footprint_radius_estimate")
                if unit["type"] == "WARPGATE":
                    radius = 1.5
                if radius:
                    dash = ' stroke-dasharray="4 3"' if unit["build_progress"] < 1 else ""
                    out.append(
                        f'<rect x="{xx - radius * scale}" y="{yy - radius * scale}" width="{radius * 2 * scale}" height="{radius * 2 * scale}" fill="#f6ae2d" fill-opacity=".13" stroke="#fcad16" stroke-width="2"{dash}/>'
                    )
                out.append(f'<circle cx="{xx}" cy="{yy}" r="2.5" fill="#ffcf60"/>')
                out.append(
                    f'<text x="{xx + 4}" y="{yy - 5}" class="label" style="fill:#e86800;stroke:#fff;stroke-width:2;paint-order:stroke">{label}</text>'
                )
                name = unit["type"].replace("CYBERNETICSCORE", "CORE").replace("SHIELDBATTERY", "BATTERY")
                suffix = " *" if unit["build_progress"] < 1 else ""
                out.append(
                    f'<text x="{left + 470}" y="{legend_y}" class="small">{label} {name}{suffix}</text>'
                )
                out.append(f'<text x="{left + 480}" y="{legend_y + 15}" class="small">({x:g}, {y:g})</text>')
                legend_y += 36
            elif not unit["is_structure"] and not unit["is_flying"] and not unit["is_hallucination"]:
                out.append(
                    f'<circle cx="{xx}" cy="{yy}" r="{max(2, unit["radius"] * scale)}" fill="#16b6ec" fill-opacity=".8" stroke="#075b89" stroke-width=".7"/>'
                )
                if unit["type"] != "PROBE":
                    out.append(
                        f'<text x="{xx + 5}" y="{yy - 5}" class="small" style="fill:#00668a;stroke:white;stroke-width:2;paint-order:stroke">{esc(unit["type"])}</text>'
                    )
        for n in range(0, 31, 5):
            xx, yy = point(x0 + n, y0)
            out.append(f'<text x="{xx}" y="{yy + 18}" text-anchor="middle" class="small">{x0 + n}</text>')
            xx, yy = point(x0, y0 + n)
            out.append(f'<text x="{xx - 6}" y="{yy + 4}" text-anchor="end" class="small">{y0 + n}</text>')
        out.append(
            f'<text x="{left}" y="{top + 489}" class="small">* under construction; units shown at this instant, not inferred permanent guards.</text>'
        )
    out += [
        '<text x="35" y="1255" font-size="15">Pathing cells show the engine grid at each phase. They do not prove clearance for every unit radius or account for moving blockers.</text>',
        '<text x="35" y="1280" font-size="15">G = Gateway / Warp Gate · C = Core · P = Pylon · N = Nexus · B = Battery. Source coordinates apply only to this map and spawn.</text>',
        "</svg>",
    ]
    target = folder / "wall-layout.svg"
    target.write_text("\n".join(out), encoding="utf-8")
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    args = parser.parse_args()
    print(render(args.folder))
