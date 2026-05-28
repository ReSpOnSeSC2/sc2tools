"""Synthetic-data tests for win_probability + clustering."""

from __future__ import annotations

import os
import sys
import tempfile
from collections import Counter
from typing import Dict, List

import numpy as np
import pandas as pd

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from analytics.win_probability import (
    FEATURE_COLUMNS,
    WinProbabilityModel,
)
from analytics.clustering import (
    KEY_BUILDINGS,
    NEVER_BUILT_SENTINEL,
    ClusterEngine,
)


def synthetic_snapshot_df(label: int, rng: np.random.Generator) -> pd.DataFrame:
    minutes = list(range(2, 18))
    rows = []
    base_supply = rng.normal(0, 2)
    base_income_min = rng.normal(0, 50)
    base_income_gas = rng.normal(0, 25)
    base_army = rng.normal(0, 100)
    matchup_pvz = int(rng.choice([0, 1], p=[0.6, 0.4]))
    matchup_pvt = 1 - matchup_pvz
    sign = 1 if label == 1 else -1
    for m in minutes:
        rows.append({
            "minute": m,
            "supply_diff": base_supply + sign * (m * 1.6) + rng.normal(0, 1.0),
            "income_min_diff": base_income_min + sign * (m * 12) + rng.normal(0, 60),
            "income_gas_diff": base_income_gas + sign * (m * 6) + rng.normal(0, 30),
            "army_value_diff": base_army + sign * (m * 80) + rng.normal(0, 200),
            "nexus_count_diff": int(max(-2, min(2, sign * (m // 5)))),
            "tech_score_self": m * (1.2 if label == 1 else 0.9),
            "tech_score_opp": m * (0.9 if label == 1 else 1.2),
            "matchup_PvT": matchup_pvt,
            "matchup_PvZ": matchup_pvz,
            "matchup_PvP": 0,
        })
    return pd.DataFrame(rows)


def build_synthetic_dataset(n_games: int, seed: int = 0):
    rng = np.random.default_rng(seed)
    X_rows: List[List[float]] = []
    y_rows: List[int] = []
    per_game: List[pd.DataFrame] = []
    for i in range(n_games):
        label = int(rng.integers(0, 2))
        df = synthetic_snapshot_df(label, rng)
        per_game.append(df)
        for _, r in df.iterrows():
            X_rows.append([r[c] for c in FEATURE_COLUMNS])
            y_rows.append(label)
    return X_rows, y_rows, per_game


def test_wp_model_converges() -> bool:
    print("\n[TEST] WinProbabilityModel - convergence on synthetic supply signal")
    X_rows, y_rows, per_game = build_synthetic_dataset(n_games=100, seed=42)
    print(f"   built {len(per_game)} synthetic games, {len(X_rows)} snapshots")

    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import train_test_split
    from sklearn.preprocessing import StandardScaler

    X = np.asarray(X_rows, dtype=float)
    y = np.asarray(y_rows, dtype=int)
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
    sc = StandardScaler()
    Xtr_s = sc.fit_transform(Xtr)
    Xte_s = sc.transform(Xte)
    model = LogisticRegression(class_weight="balanced", max_iter=2000, random_state=42)
    model.fit(Xtr_s, ytr)
    probs = model.predict_proba(Xte_s)[:, 1]
    auc = float(roc_auc_score(yte, probs))
    print(f"   AUC on holdout: {auc:.3f}")

    wp = WinProbabilityModel()
    wp.model = model
    wp.scaler = sc
    wp.last_trained = "synthetic"
    wp.auc = auc
    wp.games_used = 100
    wp.snapshots = len(X_rows)

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "wp.pkl")
        wp.save(path)
        loaded = WinProbabilityModel.load_or_new(path)
        assert loaded.model is not None
        assert loaded.scaler is not None
        assert loaded.last_trained == "synthetic"
        print("   model pickle round-trip: OK")

    rng = np.random.default_rng(7)
    win_df = synthetic_snapshot_df(label=1, rng=rng)
    loss_df = synthetic_snapshot_df(label=0, rng=rng)
    win_curve = wp.predict_curve(win_df)
    loss_curve = wp.predict_curve(loss_df)
    win_avg = float(np.mean([p for _, p in win_curve]))
    loss_avg = float(np.mean([p for _, p in loss_curve]))
    print(f"   avg p(win) for winning game: {win_avg:.3f}")
    print(f"   avg p(win) for losing game:  {loss_avg:.3f}")

    late_win = float(np.mean([p for m, p in win_curve if m >= 12]))
    early_win = float(np.mean([p for m, p in win_curve if m <= 4]))
    print(f"   winning curve early avg: {early_win:.3f}, late avg: {late_win:.3f}")

    ok = (auc >= 0.85 and win_avg > loss_avg and late_win >= early_win - 0.05)
    print(f"   {'PASS' if ok else 'FAIL'}")
    return ok


def synthetic_clustering_dataset(n_per_style: int, seed: int = 0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    rows: List[Dict] = []

    def add_row(game_id: str, style: str):
        if style == "A":
            third = rng.normal(4 * 60 + 10, 8)
            inc4 = rng.normal(900, 50)
            inc6 = rng.normal(1500, 80)
            inc8 = rng.normal(2100, 120)
            army = rng.normal(400, 80)
            blocked = max(0, rng.normal(8, 5))
            apm = rng.normal(180, 15)
            key_twi = rng.normal(330, 20)
            key_robo = rng.normal(380, 30)
            result = "Win" if rng.random() < 0.75 else "Loss"
        else:
            third = rng.normal(7 * 60 + 30, 25)
            inc4 = rng.normal(700, 60)
            inc6 = rng.normal(1000, 80)
            inc8 = rng.normal(1300, 120)
            army = rng.normal(900, 120)
            blocked = max(0, rng.normal(40, 10))
            apm = rng.normal(150, 15)
            key_twi = rng.normal(220, 20)
            key_robo = rng.normal(260, 30)
            result = "Loss" if rng.random() < 0.65 else "Win"

        row = {
            "game_id": game_id,
            "income_4min": inc4,
            "income_6min": inc6,
            "income_8min": inc8,
            "third_base_sec": third,
            "army_peak_pre8": army,
            "supply_blocked_sec": blocked,
            "apm_total": apm,
            "matchup_PvT": int(rng.random() < 0.4),
            "matchup_PvZ": int(rng.random() < 0.4),
            "matchup_PvP": int(rng.random() < 0.2),
            "_result": result,
            "_matchup_label": "PvZ",
            "_opening": "Gateway > Cyber > Twilight" if style == "A" else "Gateway > Stargate > Adept",
            "_style": style,
        }
        for b in KEY_BUILDINGS:
            if b == "TwilightCouncil":
                row[f"key_{b}"] = key_twi
            elif b == "RoboticsFacility":
                row[f"key_{b}"] = key_robo if style == "A" else NEVER_BUILT_SENTINEL
            elif b == "Stargate":
                row[f"key_{b}"] = NEVER_BUILT_SENTINEL if style == "A" else rng.normal(360, 30)
            else:
                row[f"key_{b}"] = NEVER_BUILT_SENTINEL
        rows.append(row)

    for i in range(n_per_style):
        add_row(f"A-{i}", "A")
    for i in range(n_per_style):
        add_row(f"B-{i}", "B")
    return pd.DataFrame(rows)


def test_clustering_separates_styles() -> bool:
    print("\n[TEST] ClusterEngine - separates two synthetic play-styles")
    df = synthetic_clustering_dataset(n_per_style=35, seed=11)
    print(f"   built {len(df)} synthetic games (35 per style)")

    engine = ClusterEngine()
    result = engine._cluster(df)
    print(f"   chose method={result.method}, k={result.k}, silhouette={result.silhouette:.3f}")
    print(f"   surfaced {len(result.summaries)} cluster summaries:")
    for s in result.summaries:
        print(f"     - id={s.cluster_id:>2}  count={s.count:>3}  WR={s.win_rate*100:5.1f}%  -> {s.name}")

    monochrome_ok = True
    for cid in sorted(set(result.labels)):
        cluster_styles = [df.iloc[i]["_style"] for i, l in enumerate(result.labels) if l == cid]
        if not cluster_styles:
            continue
        counts = Counter(cluster_styles)
        dominant_style, dom_count = counts.most_common(1)[0]
        purity = dom_count / len(cluster_styles)
        print(f"   cluster {cid}: dominant style {dominant_style} ({purity*100:.0f}% purity, n={len(cluster_styles)})")
        if purity < 0.85:
            monochrome_ok = False

    style_a_labels = [l for l, s in zip(result.labels, df["_style"].tolist()) if s == "A"]
    style_b_labels = [l for l, s in zip(result.labels, df["_style"].tolist()) if s == "B"]
    a_dom = Counter(style_a_labels).most_common(1)[0][0]
    b_dom = Counter(style_b_labels).most_common(1)[0][0]

    print("   insights:")
    for ins in result.insights:
        print(f"     * {ins}")

    fake_db: Dict = {
        "Synthetic": {
            "games": [{"id": gid, "result": "Win"} for gid in df["game_id"].tolist()],
            "wins": 0, "losses": 0,
        }
    }
    written = result.persist_to_db(fake_db)
    print(f"   wrote cluster_id/name to {written} games")

    ok = (
        result.silhouette >= 0.30
        and monochrome_ok
        and a_dom != b_dom
        and written == len(df)
    )
    print(f"   {'PASS' if ok else 'FAIL'}")
    return ok


def test_cold_start_guard() -> bool:
    print("\n[TEST] Cold-start guard - refuses to train below 50 games")
    from analytics.win_probability import COLD_START_GAMES_REQUIRED
    wp = WinProbabilityModel()
    out = wp.train({})
    assert out is None, f"Expected None on empty DB, got {out}"
    fake_db = {
        "PvZ Stub": {
            "games": [{"id": f"fake-{i}", "result": "Win"} for i in range(49)],
            "wins": 49, "losses": 0,
        }
    }
    out = wp.train(fake_db)
    assert out is None, f"Expected None on 49-stub DB, got {out}"
    print(f"   cold-start guard fires correctly for <{COLD_START_GAMES_REQUIRED}-game DBs")
    print("   PASS")
    return True


def main() -> int:
    results = []
    results.append(("WP model converges", test_wp_model_converges()))
    results.append(("Clustering separates styles", test_clustering_separates_styles()))
    results.append(("Cold-start guard", test_cold_start_guard()))

    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)
    for name, ok in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    print("=" * 60)
    return 0 if all(r for _, r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
