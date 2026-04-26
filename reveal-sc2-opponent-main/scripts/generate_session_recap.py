"""
Render a session recap card to data/recap.png.

Called by the Node backend when the session resets (4h idle or
manual /api/session/reset). The card combines:
  * session start time, end time, total duration
  * win/loss + final MMR + delta
  * race breakdown (icons + counts) of opponents faced
  * top 4 builds played this session
  * longest win streak

Stylized like the in-overlay session widget for visual consistency.

Usage:
    python scripts/generate_session_recap.py            (writes data/recap.png)
    python scripts/generate_session_recap.py --print    (also prints summary)

Inputs (auto-discovered relative to project root):
    stream-overlay-backend/session.state.json
    data/MyOpponentHistory.json   (for opponent races / strategies)
    data/meta_database.json       (for top builds)

The script depends only on Pillow, which is already pulled in via
customtkinter. Race / league / unit / building icons come from
SC2-Overlay/icons/ (already on disk thanks to the icon pack).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

THIS_FILE   = Path(__file__).resolve()
PROJECT_ROOT = THIS_FILE.parent.parent
DATA_DIR    = PROJECT_ROOT / "data"
ICONS_ROOT  = PROJECT_ROOT / "SC2-Overlay" / "icons"

SESSION_PATH = PROJECT_ROOT / "stream-overlay-backend" / "session.state.json"
HISTORY_PATH = DATA_DIR / "MyOpponentHistory.json"
META_DB_PATH = DATA_DIR / "meta_database.json"
OUT_PATH     = DATA_DIR / "recap.png"

# Theme matches the overlay
BG     = (17, 20, 28)
CARD   = (26, 30, 41)
ACCENT = (229, 193, 0)     # gold
WIN    = (0, 255, 136)
LOSS   = (255, 51, 102)
DIM    = (123, 134, 158)
TEXT   = (231, 234, 242)

W, H = 1200, 700


def import_pillow():
    try:
        from PIL import Image, ImageDraw, ImageFont
        return Image, ImageDraw, ImageFont
    except ImportError:
        print("[ERROR] Pillow is missing. Install with: pip install Pillow",
              file=sys.stderr)
        sys.exit(2)


def load_json(path: Path, default):
    try:
        with path.open("r", encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return default


def fmt_duration(start_ms: float, end_ms: float) -> str:
    delta_min = max(0, int((end_ms - start_ms) / 60000))
    h, m = delta_min // 60, delta_min % 60
    return f"{h}h {m:02d}m" if h > 0 else f"{m}m"


def mmr_to_league(mmr) -> Optional[str]:
    if not isinstance(mmr, (int, float)):
        return None
    if mmr >= 5000: return "grandmaster"
    if mmr >= 4400: return "master"
    if mmr >= 3500: return "diamond"
    if mmr >= 2800: return "platinum"
    if mmr >= 2200: return "gold"
    if mmr >= 1700: return "silver"
    return "bronze"


# --- Race counts from history (which games the streamer played this session)
def session_race_counts(session: Dict, history: Dict) -> Dict[str, int]:
    """
    Approximate the per-race opponent count this session by walking
    the Black Book and counting games whose Date falls inside the
    session window. The Date strings the watcher emits look like
    "YYYY-MM-DDTHH:MM:SS" -- we lexicographically compare against the
    ISO of session.startedAt.
    """
    start_ms = float(session.get("startedAt") or 0)
    if start_ms <= 0:
        return {}
    start_iso = datetime.fromtimestamp(start_ms / 1000).isoformat()
    counts: Dict[str, int] = {"Z": 0, "P": 0, "T": 0}
    for opp in history.values():
        race = (opp or {}).get("Race", "?").upper()[:1]
        if race not in counts:
            counts[race] = 0
        for mu_data in (opp.get("Matchups") or {}).values():
            for g in mu_data.get("Games", []) or []:
                d = g.get("Date") or ""
                if d >= start_iso:
                    counts[race] = counts.get(race, 0) + 1
    return counts


# --- Top builds played this session (best-effort, by date filter)
def top_builds_this_session(session: Dict, db: Dict, n: int = 4) -> List[Tuple[str, int, int]]:
    start_ms = float(session.get("startedAt") or 0)
    if start_ms <= 0 or not db:
        return []
    start_iso = datetime.fromtimestamp(start_ms / 1000).isoformat()
    rows: List[Tuple[str, int, int]] = []
    for name, bd in db.items():
        wins = 0
        losses = 0
        for g in (bd.get("games") or []):
            d = g.get("date") or ""
            if d < start_iso:
                continue
            if g.get("result") == "Win":
                wins += 1
            elif g.get("result") == "Loss":
                losses += 1
        if wins or losses:
            rows.append((name, wins, losses))
    rows.sort(key=lambda r: -(r[1] + r[2]))
    return rows[:n]


# --- Drawing helpers
def load_font(ImageFont, size: int):
    """Try a few system fonts; fall back to PIL default if all fail."""
    candidates = [
        "C:\\Windows\\Fonts\\segoeui.ttf",
        "C:\\Windows\\Fonts\\arial.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for p in candidates:
        try:
            return ImageFont.truetype(p, size=size)
        except Exception:
            continue
    return ImageFont.load_default()


def paste_icon(Image, bg, icon_path: Path, x: int, y: int, size: int):
    """Composite an icon (PNG or SVG) onto bg at (x,y) sized to `size`."""
    if not icon_path.exists():
        return
    try:
        if icon_path.suffix.lower() == ".svg":
            # Pillow doesn't read SVGs natively; the recap is best-effort
            # for SVG cases. The PNGs (units/buildings) cover the rest.
            return
        ic = Image.open(icon_path).convert("RGBA")
        ic.thumbnail((size, size), Image.LANCZOS)
        bg.alpha_composite(ic, (x, y))
    except Exception:
        pass


def render(out_path: Path, summary_only: bool = False) -> Dict[str, Any]:
    Image, ImageDraw, ImageFont = import_pillow()

    session = load_json(SESSION_PATH, {})
    history = load_json(HISTORY_PATH, {})
    db      = load_json(META_DB_PATH, {})

    start_ms = float(session.get("startedAt") or 0)
    end_ms   = float(session.get("lastResultTime") or 0) or float(start_ms)

    wins   = int(session.get("wins") or 0)
    losses = int(session.get("losses") or 0)
    mmr_start   = session.get("mmrStart")
    mmr_current = session.get("mmrCurrent")
    mmr_delta = (
        int(round(mmr_current - mmr_start))
        if isinstance(mmr_start, (int, float)) and isinstance(mmr_current, (int, float))
        else 0
    )
    league = mmr_to_league(mmr_current)
    duration_text = fmt_duration(start_ms, end_ms)

    streak_obj = session.get("currentStreak") or {}
    longest_streak_count = int(streak_obj.get("count") or 0)
    longest_streak_type  = streak_obj.get("type") or ""

    races = session_race_counts(session, history)
    top   = top_builds_this_session(session, db, n=4)

    summary = {
        "wins": wins, "losses": losses,
        "mmr_delta": mmr_delta, "mmr_current": mmr_current,
        "league": league,
        "duration": duration_text,
        "races": races, "top_builds": top,
        "longest_streak": (longest_streak_type, longest_streak_count),
    }
    if summary_only:
        return summary

    out_path.parent.mkdir(parents=True, exist_ok=True)

    img = Image.new("RGBA", (W, H), BG + (255,))
    draw = ImageDraw.Draw(img)

    f_title = load_font(ImageFont, 56)
    f_h2    = load_font(ImageFont, 22)
    f_h3    = load_font(ImageFont, 18)
    f_big   = load_font(ImageFont, 84)
    f_med   = load_font(ImageFont, 28)
    f_label = load_font(ImageFont, 14)

    # Card background
    card_pad = 24
    draw.rounded_rectangle(
        (card_pad, card_pad, W - card_pad, H - card_pad),
        radius=18, fill=CARD + (255,),
    )

    # Title
    draw.text((card_pad + 30, card_pad + 24), "SESSION RECAP", font=f_title, fill=TEXT)
    when_label = (
        datetime.fromtimestamp(start_ms / 1000).strftime("%b %d  %H:%M")
        if start_ms else ""
    )
    draw.text((card_pad + 30, card_pad + 90), when_label,
              font=f_h2, fill=DIM)

    # Big W-L line
    wl_color = WIN if wins >= losses else LOSS
    wl_text = f"{wins}W - {losses}L"
    draw.text((card_pad + 30, card_pad + 140), wl_text, font=f_big, fill=wl_color)

    # MMR delta + league
    sign = "+" if mmr_delta > 0 else ""
    mmr_color = WIN if mmr_delta > 0 else LOSS if mmr_delta < 0 else DIM
    draw.text((card_pad + 30, card_pad + 240),
              f"{sign}{mmr_delta} MMR" + (f"  -  {mmr_current}" if isinstance(mmr_current, (int, float)) else ""),
              font=f_med, fill=mmr_color)

    if league:
        # Try to overlay the league badge
        badge = ICONS_ROOT / "leagues" / f"{league}.svg"
        # Even if the SVG can't render via Pillow, label the league.
        draw.text((card_pad + 30, card_pad + 285), league.upper(),
                  font=f_h2, fill=ACCENT)
        # If the user has dropped a PNG version in, paste it.
        png_badge = ICONS_ROOT / "leagues" / f"{league}.png"
        if png_badge.exists():
            paste_icon(Image, img, png_badge, card_pad + 200, card_pad + 280, 40)

    # Duration
    draw.text((card_pad + 30, card_pad + 330), f"{duration_text} of play",
              font=f_h3, fill=DIM)

    # Longest streak
    if longest_streak_count >= 2:
        st = ("WIN STREAK" if longest_streak_type == "win" else "LOSS STREAK")
        st_color = WIN if longest_streak_type == "win" else LOSS
        draw.text((card_pad + 30, card_pad + 360),
                  f"Longest run:  {longest_streak_count}  {st}",
                  font=f_h3, fill=st_color)

    # ---- Right column: race breakdown + top builds
    rx = W // 2 + 30
    ry = card_pad + 24

    draw.text((rx, ry), "OPPONENTS BY RACE", font=f_label, fill=DIM)
    ry += 24
    for r in ("Z", "P", "T"):
        cnt = races.get(r, 0)
        race_word = {"Z": "Zerg", "P": "Protoss", "T": "Terran"}[r]
        draw.text((rx + 28, ry), f"{race_word}", font=f_h3, fill=TEXT)
        draw.text((rx + 200, ry), f"x{cnt}", font=f_h3, fill=ACCENT)
        ry += 28

    ry += 20
    draw.text((rx, ry), "TOP BUILDS THIS SESSION", font=f_label, fill=DIM)
    ry += 24
    if not top:
        draw.text((rx + 28, ry), "(none played yet)", font=f_h3, fill=DIM)
    else:
        for name, w, l in top:
            label = name if len(name) <= 32 else name[:30] + ".."
            tot = w + l
            wr = (w * 100 // tot) if tot else 0
            wr_color = WIN if wr >= 50 else LOSS
            draw.text((rx + 28, ry), label, font=f_h3, fill=TEXT)
            draw.text((rx + 350, ry), f"{wr}%", font=f_h3, fill=wr_color)
            draw.text((rx + 410, ry), f"{w}-{l}", font=f_h3, fill=DIM)
            ry += 26

    # Footer
    draw.text((card_pad + 30, H - card_pad - 28),
              "auto-generated by sc2-tools | drag into Twitter/Discord",
              font=f_label, fill=DIM)

    img.convert("RGB").save(out_path, "PNG")
    return summary


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=str(OUT_PATH),
                   help="Output PNG path (default: data/recap.png).")
    p.add_argument("--print", action="store_true", dest="print_only",
                   help="Print the summary dict and exit (no PNG).")
    args = p.parse_args()

    out_path = Path(args.out)
    summary = render(out_path, summary_only=args.print_only)
    if args.print_only:
        print(json.dumps(summary, indent=2, default=str))
    else:
        print(f"[Recap] Wrote {out_path} ({wins_losses_str(summary)})")
    return 0


def wins_losses_str(s: Dict[str, Any]) -> str:
    return f"{s['wins']}W-{s['losses']}L  {s['duration']}  {s.get('mmr_delta', 0):+d} MMR"


if __name__ == "__main__":
    sys.exit(main())
