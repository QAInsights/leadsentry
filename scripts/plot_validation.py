"""
Generates a scatter plot of LeadSentry land-weighted mean risk score vs.
NYSDOH observed elevated-blood-lead-level (EBLL) rate per 1,000 tested,
for the Erie County validation study (data/erie-zips.json -> validation-report.md).

Run: python scripts/plot_validation.py
Output: assets/validation-scatter.png
"""

import matplotlib.pyplot as plt
import numpy as np

# zip, land-weighted mean score, NYSDOH rate per 1,000
DATA = [
    ("14218", 65, 24.0),
    ("14221", 43, 0.0),
    ("14206", 72, 26.0),
    ("14210", 67, 33.0),
    ("14212", 70, 89.0),
    ("14220", 69, 27.0),
    ("14211", 67, 69.0),
    ("14208", 68, 58.0),
    ("14214", 67, 25.0),
    ("14215", 69, 23.0),
    ("14213", 66, 87.0),
    ("14201", 65, 0.0),
    ("14209", 65, 76.0),
    ("14216", 66, 42.0),
    ("14222", 60, 0.0),
    ("14227", 58, 0.0),
    ("14203", 67, 0.0),
    ("14207", 65, 28.0),
    ("14225", 63, 14.0),
    ("14224", 49, 0.0),
    ("14202", 60, 0.0),
    ("14204", 57, 57.0),
    ("14217", 63, 23.0),
    ("14226", 60, 43.0),
    ("14223", 61, 0.0),
    ("14228", 35, 0.0),
]

zips = [d[0] for d in DATA]
scores = np.array([d[1] for d in DATA], dtype=float)
rates = np.array([d[2] for d in DATA], dtype=float)

PURPLE = "#a83fd6"
AMBER = "#d97706"
BG = "#161616"
FG = "#eaeaea"
GRID = "#3a3a3a"

fig, ax = plt.subplots(figsize=(9, 6), dpi=200)
fig.patch.set_facecolor(BG)
ax.set_facecolor(BG)

ax.scatter(rates, scores, s=90, color=PURPLE, edgecolor="white", linewidth=0.6, zorder=3)

# Trend line (least squares fit)
m, b = np.polyfit(rates, scores, 1)
x_line = np.linspace(rates.min(), rates.max(), 100)
ax.plot(x_line, m * x_line + b, color=AMBER, linewidth=2, linestyle="--", zorder=2,
        label="Trend")

# Label a few notable ZIPs: highest score, highest rate, lowest score
highlight = {"14206", "14212", "14213", "14228"}
for z, s, r in DATA:
    if z in highlight:
        ax.annotate(z, (r, s), textcoords="offset points", xytext=(6, 6),
                    fontsize=9, color=FG)

ax.set_xlabel("NYSDOH elevated blood-lead rate per 1,000 tested", color=FG, fontsize=11)
ax.set_ylabel("LeadSentry land-weighted mean risk score", color=FG, fontsize=11)
ax.set_title("LeadSentry risk score vs. real childhood blood-lead outcomes\nErie County, NY \u2014 26 ZIP codes",
             color=FG, fontsize=13, pad=14)

ax.tick_params(colors=FG)
for spine in ax.spines.values():
    spine.set_color(GRID)
ax.grid(True, color=GRID, linewidth=0.6, alpha=0.6)

ax.text(
    0.98, 0.04,
    "Pearson r = 0.44   Spearman \u03c1 = 0.55   n = 26",
    transform=ax.transAxes, ha="right", va="bottom",
    fontsize=10.5, color=AMBER,
    bbox=dict(boxstyle="round,pad=0.4", facecolor="#2a2a2a", edgecolor=AMBER, linewidth=1),
)

plt.tight_layout()
plt.savefig("assets/validation-scatter.png", facecolor=BG)
print("wrote assets/validation-scatter.png")
