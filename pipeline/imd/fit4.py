"""Fits single stations with their own layouts: pixel centre searched over the panel, scale within a narrow band
(from the printed resolution or range), station coordinates fixed (Bhuj prints them) or shifted a little."""
import json, math, sys
import numpy as np
from PIL import Image
import importlib.util

HERE, BORDERS = sys.argv[1], sys.argv[2]
saved = sys.argv
sys.argv = [saved[0], HERE, BORDERS]
spec = importlib.util.spec_from_file_location("fit", f"{HERE}/fit.py")
fit = importlib.util.module_from_spec(spec); spec.loader.exec_module(fit)
sys.argv = saved

# code: (lat, lon, panel, s_min, s_max, range_km)
CASES = {
    "bhj": (23.2418, 69.6458, [0, 183, 600, 770], 1 / 0.95, 1 / 0.85, 240),
    "srn": (34.0517, 74.805, [18, 132, 417, 523], 1.6, 2.4, 100.5),
}


def main():
    out = {}
    points = fit.boundary_points()
    for code in sys.argv[3].split(","):
        lat0, lon0, panel, smin, smax, rng = CASES[code]
        image = Image.open(f"{HERE}/all/{code}.gif").convert("RGB")
        dist = fit.edge_distance(image, panel)
        east, north = fit.project(points, lat0, lon0)
        keep = np.hypot(east, north) < rng * 1.5
        east, north = east[keep], north[keep]
        x0, y0, x1, y1 = panel

        def score(cx, cy, s):
            px = cx + s * east; py = cy - s * north
            inside = (px >= x0) & (px < x1 - 1) & (py >= y0) & (py < y1 - 1)
            if inside.sum() < 150:
                return 1e9
            return dist[py[inside].astype(int), px[inside].astype(int)].mean()

        w, h = x1 - x0, y1 - y0
        best = (1e9, None)
        for s in np.linspace(smin, smax, 17):
            for cx in np.arange(x0 + w * 0.2, x1 - w * 0.2, 3):
                for cy in np.arange(y0 + h * 0.2, y1 - h * 0.2, 3):
                    v = score(cx, cy, s)
                    if v < best[0]:
                        best = (v, (cx, cy, s))
        v, (cx, cy, s) = best
        for step in (1.5, 0.7, 0.3):
            improved = True
            while improved:
                improved = False
                for d in ((step, 0, 0), (-step, 0, 0), (0, step, 0), (0, -step, 0), (0, 0, step / 300), (0, 0, -step / 300)):
                    cand = (cx + d[0], cy + d[1], s * (1 + d[2]))
                    cv = score(*cand)
                    if cv < v:
                        v, (cx, cy, s), improved = cv, cand, True
        out[code] = {"family": code, "panel": panel, "cx": round(float(cx), 1), "cy": round(float(cy), 1), "s": round(float(s), 4),
                     "range": rng, "lat": lat0, "lon": lon0, "score": round(float(v), 3), "size": list(image.size)}
        print(code, out[code], flush=True)
    json.dump(out, open(f"{HERE}/fits4.json", "w"), indent=0)


if __name__ == "__main__":
    main()
