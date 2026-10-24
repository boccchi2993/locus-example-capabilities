# Charts

Use this skill when the user wants a chart or any visual of numbers — trends over time,
comparisons, shares of a whole, two-quantity relationships — or a figure for a report.
Charts are SVG files drawn with Python's standard library only (no matplotlib, no network).

## How to run Python here

The `bash` tool runs a restricted shell. Run every Python block below as its own single
bash call, wrapped in a quoted heredoc: `python <<'PY'` … code … `PY` — no heredocs for
other commands, no backslash line continuations.

- Python has the standard library plus pandas (with numpy). No matplotlib, no Pillow, no network.
- Writable paths: `/mnt/download` (user output), `/mnt/workspace`, `/tmp`; `/mnt/upload` (uploads)
  is read-only. Helpers write to `OUT_DIR = "/mnt/download"`; `save_chart(..., out_dir=...)` overrides it.

## Helper library

Run this block once, then reuse the helpers in later blocks; it ends by drawing one demo of each chart type into `/mnt/download`.

```python
import math
import os

OUT_DIR = "/mnt/download"
FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
PALETTE = ["#0072B2", "#D55E00", "#009E73", "#E69F00", "#CC79A7", "#56B4E9", "#000000"]
INK, MUTED, GRID = "#111827", "#6b7280", "#e5e7eb"

def esc(s):
    """XML-escape any text that goes into the SVG (titles, labels, units)."""
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&#39;"))
def _nice_ticks(lo, hi, n=5):
    if hi <= lo:
        lo, hi = lo - 0.5, hi + 0.5
    step = 10.0 ** math.floor(math.log10((hi - lo) / n))
    for m in (1, 2, 2.5, 5, 10):
        if m * step >= (hi - lo) / n:
            step *= m
            break
    out, t = [], math.floor(lo / step) * step
    while t <= hi + step * 1e-9:
        out.append(round(t, 10)); t += step
    return out
def _text(x, y, s, size=13, fill=INK, anchor="start"):
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill}"'
            f' text-anchor="{anchor}">{esc(s)}</text>')
def _legend(items, w, y0):
    out, x = [], max(32.0, (w - sum(22 + len(l) * 6.8 for _, l in items)) / 2)
    for c, label in items:
        out.append(f'<rect x="{x:.1f}" y="{y0 - 9:.1f}" width="12" height="12" rx="2"'
                   f' fill="{c}"/>' + _text(x + 17, y0, label))
        x += 22 + len(label) * 6.8
    return "".join(out), y0 + 20
def _frame(title, items, w, h):
    head, top = _legend(items, w, 58)
    t = (f'<text x="{w / 2:.1f}" y="34" font-size="20" font-weight="600" fill="{INK}"'
         f' text-anchor="middle">{esc(title)}</text>')
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="100%"'
           f' style="max-width:{w}px;height:auto" font-family="{esc(FONT)}">',
           f'<rect width="{w}" height="{h}" fill="#ffffff"/>', t, head]
    left, bottom = 64, h - 52
    return out, left, w - 24 - left, top, bottom - top, bottom
def _y_axis(ticks, lo, hi, left, top, pw, ph, bottom):
    out = [f'<line x1="{left}" y1="{top:.1f}" x2="{left}" y2="{bottom:.1f}" stroke="{MUTED}"/>']
    for t in ticks:
        y = top + ph * (1 - (t - lo) / (hi - lo))
        out.append(f'<line x1="{left:.1f}" y1="{y:.1f}" x2="{left + pw:.1f}" y2="{y:.1f}" stroke="{GRID}"/>'
                   + _text(left - 8, y + 4, f"{t:,}", 12, MUTED, "end"))
    return out

def line_chart(title, series, xlabels=None, w=720, h=480):
    n = max(len(v) for _, v in series)
    items = [(PALETTE[i % len(PALETTE)], name) for i, (name, _) in enumerate(series)]
    out, left, pw, top, ph, bottom = _frame(title, items, w, h)
    vals = [v for _, vs in series for v in vs]
    ticks = _nice_ticks(min(vals), max(vals))
    lo, hi = min(min(vals), ticks[0]), max(max(vals), ticks[-1])
    lo, hi = lo - 0.05 * (hi - lo), hi + 0.05 * (hi - lo)
    Y = lambda v: top + ph * (1 - (v - lo) / (hi - lo))
    out += _y_axis(ticks, lo, hi, left, top, pw, ph, bottom)
    labels = (list(xlabels) + [str(i + 1) for i in range(n)])[:n]
    for i in range(0, n, max(1, math.ceil(n / 12))):
        out.append(_text(left + (i + 0.5) * pw / n, bottom + 20, labels[i], 12, MUTED, "middle"))
    for k, (_, vs) in enumerate(series):
        pts = " ".join(f"{left + (i + 0.5) * pw / n:.1f},{Y(v):.1f}" for i, v in enumerate(vs))
        out.append(f'<polyline points="{pts}" fill="none" stroke="{PALETTE[k % len(PALETTE)]}"'
                   f' stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>')
    out.append("</svg>")
    return "\n".join(out)
def bar_chart(title, categories, series, w=720, h=480):
    m, s = len(categories), len(series)
    items = [(PALETTE[i % len(PALETTE)], name) for i, (name, _) in enumerate(series)]
    out, left, pw, top, ph, bottom = _frame(title, items, w, h)
    vals = [v for _, vs in series for v in vs]
    ticks = _nice_ticks(min(0.0, min(vals)), max(0.0, max(vals)))
    lo, hi = min(0.0, ticks[0]), max(0.0, max(vals), ticks[-1])
    hi += 0.05 * (hi - lo)
    Y = lambda v: top + ph * (1 - (v - lo) / (hi - lo))
    out += _y_axis(ticks, lo, hi, left, top, pw, ph, bottom)
    y0, slot, bw = Y(0), pw / m, 0.72 * pw / m / s
    out.append(f'<line x1="{left}" y1="{y0:.1f}" x2="{left + pw}" y2="{y0:.1f}" stroke="{MUTED}"/>')
    for i, cat in enumerate(categories):
        x0 = left + i * slot + (slot - 0.72 * slot) / 2
        for j, (_, vs) in enumerate(series):
            yv = Y(vs[i])
            out.append(f'<rect x="{x0 + j * bw:.1f}" y="{min(yv, y0):.1f}" width="{bw * 0.88:.1f}"'
                       f' height="{abs(yv - y0):.1f}" rx="2" fill="{PALETTE[j % len(PALETTE)]}"/>')
        if i % max(1, math.ceil(m / 16)) == 0:
            out.append(_text(left + i * slot + slot / 2, bottom + 20, cat, 12, MUTED, "middle"))
    out.append("</svg>")
    return "\n".join(out)
def pie_chart(title, items, w=720, h=480):
    total = float(sum(v for _, v in items))
    if len(items) < 2 or total <= 0 or any(float(v) < 0 for _, v in items):
        raise ValueError("pie_chart needs >= 2 non-negative values with a positive sum")
    out, *_ = _frame(title, [], w, h)
    cx, cy, r = w * 0.28, h / 2 + 14, min(h / 2 - 58, w * 0.28 - 28)
    a = -math.pi / 2
    for i, (_, v) in enumerate(items):
        a2 = a + v / total * 2 * math.pi
        x1, y1 = cx + r * math.cos(a), cy + r * math.sin(a)
        x2, y2 = cx + r * math.cos(a2), cy + r * math.sin(a2)
        out.append(f'<path d="M {cx:.1f} {cy:.1f} L {x1:.1f} {y1:.1f} A {r:.1f} {r:.1f} 0'
                   f' {1 if v > total / 2 else 0} 1 {x2:.1f} {y2:.1f} Z"'
                   f' fill="{PALETTE[i % len(PALETTE)]}" stroke="#ffffff" stroke-width="2"/>')
        a = a2
    ly = cy - (len(items) * 24 - 12) / 2 + 4
    for i, (label, v) in enumerate(items):
        lab = label if len(label) <= 30 else label[:29] + "…"
        out.append(f'<rect x="{w * 0.54:.1f}" y="{ly + i * 24 - 9:.1f}" width="12" height="12"'
                   f' rx="2" fill="{PALETTE[i % len(PALETTE)]}"/>')
        out.append(_text(w * 0.54 + 17, ly + i * 24, f"{lab} — {v:g} ({v / total * 100:.1f}%)"))
    out.append("</svg>")
    return "\n".join(out)

def scatter_chart(title, series, w=720, h=480):
    items = [(PALETTE[i % len(PALETTE)], name) for i, (name, _, _) in enumerate(series)]
    out, left, pw, top, ph, bottom = _frame(title, items, w, h)
    xs = [x for _, xr, _ in series for x in xr]
    ys = [y for _, _, yr in series for y in yr]
    xt, yt = _nice_ticks(min(xs), max(xs)), _nice_ticks(min(ys), max(ys))
    xlo, xhi = min(min(xs), xt[0]), max(max(xs), xt[-1])
    ylo, yhi = min(min(ys), yt[0]), max(max(ys), yt[-1])
    xlo, xhi = xlo - 0.05 * (xhi - xlo), xhi + 0.05 * (xhi - xlo)
    ylo, yhi = ylo - 0.05 * (yhi - ylo), yhi + 0.05 * (yhi - ylo)
    X = lambda x: left + pw * (x - xlo) / (xhi - xlo)
    Y = lambda y: top + ph * (1 - (y - ylo) / (yhi - ylo))
    out += _y_axis(yt, ylo, yhi, left, top, pw, ph, bottom)
    for t in xt:
        out.append(f'<line x1="{X(t):.1f}" y1="{top:.1f}" x2="{X(t):.1f}" y2="{bottom:.1f}" stroke="{GRID}"/>'
                   + _text(X(t), bottom + 20, f"{t:,}", 12, MUTED, "middle"))
    out.append(f'<line x1="{left}" y1="{bottom:.1f}" x2="{left + pw}" y2="{bottom:.1f}" stroke="{MUTED}"/>')
    for k, (_, xr, yr) in enumerate(series):
        for x, y in zip(xr, yr):
            out.append(f'<circle cx="{X(x):.1f}" cy="{Y(y):.1f}" r="4"'
                       f' fill="{PALETTE[k % len(PALETTE)]}" fill-opacity="0.85"/>')
    out.append("</svg>")
    return "\n".join(out)
def top_n_other(labels, values, n=12):
    pairs = sorted(zip(labels, values), key=lambda p: p[1], reverse=True)
    head, tail = pairs[:n], pairs[n:]
    head = head + ([("Other", sum(v for _, v in tail))] if tail else [])
    return [l for l, _ in head], [v for _, v in head]
def save_chart(svg, name, out_dir=None):
    p = os.path.join(out_dir or OUT_DIR, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(svg)
    print("saved " + p)
    return p
save_chart(line_chart("Monthly revenue by region — H1 2026",
            [("North", [120, 135, 148, 141, 163, 178]), ("South", [98, 104, 111, 129, 122, 140])],
            xlabels=["Jan", "Feb", "Mar", "Apr", "May", "Jun"]), "demo-line.svg")
save_chart(bar_chart("Quarterly spend by team", ["Q1", "Q2", "Q3", "Q4"],
            [("Platform", [42, 51, 47, 63]), ("Growth", [28, 34, 41, 39]), ("Support", [19, 22, 20, 26])]),
           "demo-bar.svg")
save_chart(pie_chart("Where the time went",
            [("Build", 9.5), ("Review", 4.0), ("Docs", 2.5), ("Meetings", 1.5), ("Other", 0.5)]),
           "demo-pie.svg")
save_chart(scatter_chart("Height vs weight",
            [("A", [1.5, 1.7, 1.6, 1.8, 1.9], [52, 68, 60, 75, 84]),
             ("B", [1.4, 1.6, 1.75, 1.85], [45, 62, 70, 78])]), "demo-scatter.svg")
```

Every chart has a title, axes with round ticks, a legend and the fixed colorblind-safe
palette above; all text goes through `esc()`; the root carries `viewBox` + `width="100%"`
so the chart scales on a phone; the font stack includes PingFang SC / Microsoft YaHei, so
Chinese labels render. `line_chart` takes multiple series on a category x-axis, `bar_chart`
draws grouped bars, `pie_chart` lists every slice in the legend with value and percent, and
`scatter_chart` needs numeric x. Keep pie slices to ~8 and series names short (one-row legend).

## Titles and labels with special characters

`esc()` handles `<`, `&`, quotes and any language — pass raw strings, never pre-escape:

```python
save_chart(line_chart('营收 <草稿> & 修正 · 2026',
                      [("系列 A", [3, 4, 2.5, 5]), ("系列 B", [2, 2.8, 3.5, 3.2])],
                      xlabels=["一月", "二月", "三月", "四月"]), "demo-escaping.svg")
```

## From a CSV, and when there are too many categories

Read CSVs with the `csv` module (a user-provided file usually sits in `/mnt/upload`). When a
categorical axis would carry more categories than fit — a common case is > 50 — aggregate first
with `top_n_other` (top N plus one "Other" bucket) instead of drawing them all:

```python
import csv
import os

csv_path = os.path.join(OUT_DIR, "demo-sample.csv")  # use a /mnt/upload path for real data
with open(csv_path, "w", newline="", encoding="utf-8") as f:
    wr = csv.writer(f); wr.writerow(["category", "minutes"])
    for i in range(60):
        wr.writerow([f"app-{i:02d}", round(120 / (i + 1) + (i * 7) % 13, 1)])
with open(csv_path, encoding="utf-8") as f:
    rows = list(csv.DictReader(f))
labels, values = top_n_other([r["category"] for r in rows], [float(r["minutes"]) for r in rows], n=12)
svg = bar_chart("Screen time by app (top 12 + Other)", labels, [("minutes", values)])
save_chart(svg, "demo-csv-topn.svg")
save_chart('<!doctype html><meta charset="utf-8"><title>Screen time</title>'
           '<body style="font-family:sans-serif;margin:24px">' + svg + '</body>',
           "demo-report.html")  # wrap the SVG in HTML when it sits next to text
```

## From a pandas DataFrame

```python
import pandas as pd

df = pd.DataFrame({"month": ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
                   "revenue": [120, 135, 148, 141, 163, 178],
                   "cost": [80, 84, 92, 90, 97, 101]})
save_chart(line_chart("Revenue vs cost (pandas DataFrame)",
                      [("Revenue", df["revenue"].tolist()), ("Cost", df["cost"].tolist())],
                      xlabels=df["month"].tolist()), "demo-pandas.svg")
```

## Delivering a chart

- Pick the type the question asks for — trend over time → line, compare categories → bar,
  parts of a whole → pie, correlation → scatter — and save with a meaningful name to
  `/mnt/download` (`save_chart` prints the exact path); add an `.html` wrapper for prose.
- Say in one or two sentences what the chart shows, and point out any aggregation you applied
  (e.g. "top 12 apps shown; the rest merged into Other").
- Never invent numbers. Chart only data the user gave you or that you read from a file;
  if data is missing or ambiguous, ask first.
