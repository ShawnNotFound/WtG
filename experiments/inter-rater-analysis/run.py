#!/usr/bin/env python3
"""
inter-rater analysis for the playtest-1 plausibility-rating exercise.

joins three rater sources by (player, story_direction):
  - my-plausibility-ratings LDG.csv  (lewis griffin)
  - my-plausibility-ratings-ayman.csv (ayman khan)
  - playtest1-all-headlines.csv      (ai game master plausibility level)

computes pairwise exact agreement (with wilson 95% ci), pearson r (with
fisher-z 95% ci), cohen's kappa (unweighted), linear-weighted kappa,
and the per-rater rating distribution. writes joined-ratings.csv,
stats.json, stats.md, and overwrites the section 5.3 figure
juror-rating-distributions.png in the report figures directory.

usage: python3 run.py
"""

import csv
import json
import math
from pathlib import Path

import numpy as np
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import stats as scipy_stats

ROOT = Path(__file__).resolve().parents[2]
LDG_CSV = ROOT / "my-plausibility-ratings LDG.csv"
AYMAN_CSV = ROOT / "my-plausibility-ratings-ayman.csv"
AI_CSV = ROOT / "playtest1-all-headlines.csv"
FIG_OUT = ROOT / "Report" / "69e3b0538226915fab40bb16" / "figures" / "Playtest 1" / "juror-rating-distributions.png"

OUT_DIR = Path(__file__).resolve().parent
JOINED_OUT = OUT_DIR / "joined-ratings.csv"
STATS_JSON = OUT_DIR / "stats.json"
STATS_MD = OUT_DIR / "stats.md"


def load_human(path: Path):
    """read a human-rater csv. returns list of dicts keyed by idx."""
    rows = []
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rating_raw = (r.get("Your Rating") or r.get("Your Rating (1-5)") or "").strip()
            if not rating_raw:
                continue
            rows.append({
                "idx": int(r["#"]),
                "player": r["Player"].strip(),
                "story_direction": r["Story Direction"].strip(),
                "selected_headline": r["Selected Headline"].strip(),
                "rating": int(rating_raw),
            })
    return rows


def load_ai(path: Path):
    """read playtest1-all-headlines.csv into {(player, story_direction) -> ai_band}."""
    lookup = {}
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            if r.get("Type", "").strip() != "player":
                continue
            key = (r["Player"].strip(), r["Story Direction"].strip())
            lookup[key] = int(r["Plausibility Level (1-5)"])
    return lookup


def join_38(ldg_rows, ayman_rows, ai_lookup):
    """build unified 38-row table. asserts every key resolves."""
    assert len(ldg_rows) == 38, f"expected 38 LDG rows, got {len(ldg_rows)}"
    assert len(ayman_rows) == 38, f"expected 38 Ayman rows, got {len(ayman_rows)}"

    by_idx_ldg = {r["idx"]: r for r in ldg_rows}
    by_idx_ay = {r["idx"]: r for r in ayman_rows}

    joined = []
    for idx in sorted(by_idx_ldg.keys()):
        ldg = by_idx_ldg[idx]
        ay = by_idx_ay[idx]
        # sanity: same item in both human files at this index
        assert ldg["story_direction"] == ay["story_direction"], \
            f"row {idx} story-direction mismatch between LDG and Ayman files"
        key = (ldg["player"], ldg["story_direction"])
        if key not in ai_lookup:
            raise KeyError(f"row {idx} key not found in playtest1-all-headlines: {key!r}")
        joined.append({
            "idx": idx,
            "player": ldg["player"],
            "story_direction": ldg["story_direction"],
            "selected_headline": ldg["selected_headline"],
            "ldg": ldg["rating"],
            "ayman": ay["rating"],
            "ai": ai_lookup[key],
        })
    return joined


def wilson_ci(k, n, z=1.96):
    """wilson score interval for a binomial proportion."""
    if n == 0:
        return (0.0, 0.0, 0.0)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = (z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom
    return (p, max(0.0, centre - half), min(1.0, centre + half))


def exact_agreement(a, b):
    """returns (pct, ci_lo, ci_hi) with wilson 95% ci."""
    a = np.asarray(a)
    b = np.asarray(b)
    n = len(a)
    k = int((a == b).sum())
    p, lo, hi = wilson_ci(k, n)
    return (p * 100.0, lo * 100.0, hi * 100.0)


def fisher_z_ci(r, n, alpha=0.05):
    """fisher z-transform 95% ci for pearson r."""
    if n < 4 or abs(r) >= 1.0:
        return (float("nan"), float("nan"))
    z = math.atanh(r)
    se = 1.0 / math.sqrt(n - 3)
    zcrit = scipy_stats.norm.ppf(1 - alpha / 2)
    lo = math.tanh(z - zcrit * se)
    hi = math.tanh(z + zcrit * se)
    return (lo, hi)


def pearson_with_ci(a, b):
    """pearson r with 95% ci via fisher z."""
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    if a.std() == 0 or b.std() == 0:
        return (float("nan"), float("nan"), float("nan"))
    r, _ = scipy_stats.pearsonr(a, b)
    lo, hi = fisher_z_ci(r, len(a))
    return (r, lo, hi)


def cohen_kappa(a, b, weighted=False, n_categories=5):
    """unweighted or linear-weighted cohen's kappa over categories 1..n_categories."""
    a = np.asarray(a)
    b = np.asarray(b)
    n = len(a)
    cats = list(range(1, n_categories + 1))
    obs = np.zeros((n_categories, n_categories))
    for x, y in zip(a, b):
        obs[x - 1, y - 1] += 1
    obs /= n
    pa = obs.sum(axis=1)
    pb = obs.sum(axis=0)
    expected = np.outer(pa, pb)

    if not weighted:
        po = float(np.trace(obs))
        pe = float(np.trace(expected))
    else:
        # linear weights: w_ij = 1 - |i-j|/(k-1)
        w = np.zeros_like(obs)
        for i, ci in enumerate(cats):
            for j, cj in enumerate(cats):
                w[i, j] = 1.0 - abs(ci - cj) / (n_categories - 1)
        po = float((w * obs).sum())
        pe = float((w * expected).sum())

    if pe >= 1.0:
        return float("nan")
    return (po - pe) / (1 - pe)


def distribution_counts(ratings, n_categories=5):
    """returns dict {1: count, 2: count, ...}."""
    return {c: int(sum(1 for r in ratings if r == c)) for c in range(1, n_categories + 1)}


def plot_distributions(joined, out_path: Path):
    """three-panel bar chart of rating distributions, mirroring fig 5.3."""
    cats = [1, 2, 3, 4, 5]
    ldg_counts = [sum(1 for r in joined if r["ldg"] == c) for c in cats]
    ay_counts = [sum(1 for r in joined if r["ayman"] == c) for c in cats]
    ai_counts = [sum(1 for r in joined if r["ai"] == c) for c in cats]

    fig, axes = plt.subplots(1, 3, figsize=(11, 3.6), sharey=True)
    panels = [
        ("Lewis", ldg_counts, "#4477aa"),
        ("Ayman", ay_counts, "#ee6677"),
        ("AI game master", ai_counts, "#228833"),
    ]
    for ax, (title, counts, colour) in zip(axes, panels):
        ax.bar(cats, counts, color=colour, edgecolor="black", linewidth=0.6)
        ax.set_title(title, fontsize=11)
        ax.set_xlabel("Plausibility band")
        ax.set_xticks(cats)
        ax.set_xticklabels([f"P{c}" for c in cats])
        ax.set_ylim(0, max(max(ldg_counts), max(ay_counts), max(ai_counts)) + 2)
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
    axes[0].set_ylabel("Number of headlines (out of 38)")
    fig.tight_layout()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out_path, dpi=200, bbox_inches="tight")
    plt.close(fig)


def fmt_pct_ci(p, lo, hi):
    return f"{p:.1f}\\% [{lo:.1f}, {hi:.1f}]"


def fmt_signed(x, decimals=2):
    if math.isnan(x):
        return "nan"
    sign = "+" if x >= 0 else ""
    return f"{sign}{x:.{decimals}f}"


def main():
    ldg_rows = load_human(LDG_CSV)
    ayman_rows = load_human(AYMAN_CSV)
    ai_lookup = load_ai(AI_CSV)
    joined = join_38(ldg_rows, ayman_rows, ai_lookup)

    # sanity: AI stratification 6/8/8/8/8
    ai_dist = distribution_counts([r["ai"] for r in joined])
    expected = {1: 6, 2: 8, 3: 8, 4: 8, 5: 8}
    if ai_dist != expected:
        print(f"WARNING: AI distribution {ai_dist} != expected {expected}")
    else:
        print(f"AI stratification check: OK ({ai_dist})")

    # write joined-ratings.csv
    with JOINED_OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["idx", "player", "story_direction", "selected_headline", "ldg", "ayman", "ai"])
        for r in joined:
            w.writerow([r["idx"], r["player"], r["story_direction"], r["selected_headline"], r["ldg"], r["ayman"], r["ai"]])

    # build pairwise stats
    pairs = [
        ("Lewis vs Ayman", [r["ldg"] for r in joined], [r["ayman"] for r in joined]),
        ("Ayman vs AI", [r["ayman"] for r in joined], [r["ai"] for r in joined]),
        ("Lewis vs AI", [r["ldg"] for r in joined], [r["ai"] for r in joined]),
    ]
    stats_out = {"n": len(joined), "ai_distribution": ai_dist, "pairs": []}
    for label, a, b in pairs:
        ag, lo, hi = exact_agreement(a, b)
        r, r_lo, r_hi = pearson_with_ci(a, b)
        k_un = cohen_kappa(a, b, weighted=False)
        k_w = cohen_kappa(a, b, weighted=True)
        block = {
            "pair": label,
            "exact_agreement_pct": ag,
            "exact_agreement_ci": [lo, hi],
            "pearson_r": r,
            "pearson_ci": [r_lo, r_hi],
            "cohen_kappa": k_un,
            "weighted_kappa_linear": k_w,
        }
        stats_out["pairs"].append(block)

    # rating distributions per rater
    stats_out["distributions"] = {
        "ldg": distribution_counts([r["ldg"] for r in joined]),
        "ayman": distribution_counts([r["ayman"] for r in joined]),
        "ai": ai_dist,
    }

    # write stats.json
    with STATS_JSON.open("w", encoding="utf-8") as f:
        json.dump(stats_out, f, indent=2)

    # write stats.md (formatted for direct copy into 5.3)
    md = []
    md.append("# Inter-rater analysis output\n")
    md.append(f"n = {len(joined)} headlines, three raters: Lewis, Ayman, AI game master\n")
    md.append(f"AI plausibility-band stratification: {ai_dist}\n")
    md.append("## Pairwise statistics\n")
    md.append("| Pair | Exact agreement (95\\% CI) | Pearson r | Cohen's kappa | Linear-weighted kappa |")
    md.append("|---|---|---|---|---|")
    for block in stats_out["pairs"]:
        md.append("| {pair} | {ag:.1f}% [{lo:.1f}, {hi:.1f}] | {r} | {k_un} | {k_w} |".format(
            pair=block["pair"],
            ag=block["exact_agreement_pct"],
            lo=block["exact_agreement_ci"][0],
            hi=block["exact_agreement_ci"][1],
            r=fmt_signed(block["pearson_r"]),
            k_un=fmt_signed(block["cohen_kappa"]),
            k_w=fmt_signed(block["weighted_kappa_linear"]),
        ))
    md.append("")
    md.append("## Pearson r 95\\% CIs (Fisher-z)\n")
    for block in stats_out["pairs"]:
        md.append(f"- {block['pair']}: r = {fmt_signed(block['pearson_r'])}, 95% CI [{fmt_signed(block['pearson_ci'][0])}, {fmt_signed(block['pearson_ci'][1])}]")
    md.append("")
    md.append("## Per-rater rating distribution\n")
    md.append("| Rater | P1 | P2 | P3 | P4 | P5 | P2-P4 |")
    md.append("|---|---|---|---|---|---|---|")
    for label, key in [("Lewis", "ldg"), ("Ayman", "ayman"), ("AI", "ai")]:
        d = stats_out["distributions"][key]
        p2_p4 = d[2] + d[3] + d[4]
        md.append(f"| {label} | {d[1]} | {d[2]} | {d[3]} | {d[4]} | {d[5]} | {p2_p4} |")
    md.append("")
    md.append("## LaTeX-ready table cell values for tab:pt1-juror-agreement\n")
    for block in stats_out["pairs"]:
        md.append(f"- {block['pair']}: {fmt_pct_ci(block['exact_agreement_pct'], *block['exact_agreement_ci'])} & {fmt_signed(block['pearson_r'])} & {fmt_signed(block['cohen_kappa'])} & {fmt_signed(block['weighted_kappa_linear'])}")

    STATS_MD.write_text("\n".join(md) + "\n", encoding="utf-8")

    # plot
    plot_distributions(joined, FIG_OUT)

    # echo the stats to stdout in the same order as the report's table
    print()
    print(f"n = {len(joined)} headlines")
    print()
    for block in stats_out["pairs"]:
        print(f"{block['pair']}:")
        print(f"  exact agreement: {block['exact_agreement_pct']:.1f}% [{block['exact_agreement_ci'][0]:.1f}, {block['exact_agreement_ci'][1]:.1f}]")
        print(f"  pearson r:       {fmt_signed(block['pearson_r'])} (95% CI [{fmt_signed(block['pearson_ci'][0])}, {fmt_signed(block['pearson_ci'][1])}])")
        print(f"  cohen kappa:     {fmt_signed(block['cohen_kappa'])}")
        print(f"  weighted kappa:  {fmt_signed(block['weighted_kappa_linear'])}")
        print()
    print("rating distributions (P1..P5, P2-P4 sum):")
    for label, key in [("Lewis", "ldg"), ("Ayman", "ayman"), ("AI   ", "ai")]:
        d = stats_out["distributions"][key]
        print(f"  {label}: {d[1]}/{d[2]}/{d[3]}/{d[4]}/{d[5]} (P2-P4 = {d[2]+d[3]+d[4]})")
    print()
    print(f"wrote: {JOINED_OUT}")
    print(f"wrote: {STATS_JSON}")
    print(f"wrote: {STATS_MD}")
    print(f"wrote: {FIG_OUT}")


if __name__ == "__main__":
    main()
