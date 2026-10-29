"""Geometry by layout family. IMD-B ("Max with panels") and MAXDISPLAY layouts: the map is a square in the bottom-left
corner, centred on the radar, half-width = the printed range. Only the radar's position is fitted (shift of the
station coordinates by up to 30 km so the drawn borders line up), the scale is not.
"""
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

STRIP = {"imdb": (212, 155, 95), "maxd": (210, 180, 140)}
# Printed range (km) per station, read from each image's text box.
RANGE = {
    "bhp": 250, "agt": 250, "delhi": 250, "dmu": 150, "goa": 250, "hyd": 250, "jpr": 250, "kkl": 250, "lkn": 250,
    "bln": 150, "ngp": 250, "ptl": 300, "ptn": 250, "tez": 150, "mbr": 250, "pdp": 250, "dlh": 250, "jrh": 150, "sil": 250,
    "aya": 100, "bnh": 100, "sbp": 250, "leh": 100, "jmu": 100, "jot": 100, "mur": 100, "mks": 100, "kuf": 100,
    "sur": 100, "ldn": 100, "rpr": 250, "mlr": 250,
}
FAMILY = {code: ("imdb" if code in ("bhp", "agt", "delhi", "dmu", "goa", "hyd", "jpr", "kkl", "lkn", "bln", "ngp", "ptl",
                                     "ptn", "tez", "mbr", "pdp", "dlh", "jrh", "sil") else "maxd") for code in RANGE}


def square_panel(arr, family):
    h, w, _ = arr.shape
    colour = np.array(STRIP[family])
    strip = (np.abs(arr.astype(int) - colour).max(2) <= 8)
    rows = slice(int(h * 0.55), int(h * 0.97))
    frac = strip[rows].mean(0)
    smooth = np.convolve(frac, np.ones(9) / 9, mode="same")
    for x in range(int(w * 0.3), w - 10):
        if smooth[x + 4] > 0.35:
            # Step back to the first strip column.
            while x > 0 and frac[x - 1] > 0.1:
                x -= 1
            return x
    return None


def border_panel(arr):
    """The map square in the bottom-left corner is framed by a vertical line at x = side and a horizontal line at
    y = h - side: pick the side with the strongest pair of long dark lines."""
    h, w, _ = arr.shape
    dark = arr.max(2) < 90
    best = (0, None)
    for side in range(int(min(w, h) * 0.45), min(w - 2, h - 2)):
        top = h - side
        col = dark[top:h, side - 1:side + 2].max(1).mean()
        row = dark[top - 1:top + 2, 0:side].max(0).mean()
        value = col + row
        if value > best[0]:
            best = (value, side)
    if best[1] is None or best[0] < 1.2:
        return None, None
    return best[1], h - best[1]


def main():
    stations = {s["code"]: s for s in json.load(open(f"{HERE}/stations.json"))}
    only = sys.argv[3].split(",") if len(sys.argv) > 3 else list(RANGE)
    points = fit.boundary_points()
    out = {}
    for code in only:
        station = stations[code]
        arr = np.asarray(Image.open(f"{HERE}/all/{code}.gif").convert("RGB"))
        h, w, _ = arr.shape
        family = FAMILY[code]
        side, top = border_panel(arr)
        if side is None and family == "maxd":
            # MAXDISPLAY maps have no dark frame: the square ends where the brown strip starts.
            side = square_panel(arr, family)
            top = h - side if side else None
        if side is None:
            print(code, "no panel"); continue
        panel = [0, top, side, h]
        cx, cy = side / 2, (top + h) / 2
        s = (side / 2) / RANGE[code]
        lat0, lon0 = fit.FIXED.get(code, (station["lat"], station["lon"]))
        image = Image.fromarray(arr)
        dist = fit.edge_distance(image, panel)
        east, north = fit.project(points, lat0, lon0)
        keep = np.hypot(east, north) < RANGE[code] * 1.6
        east, north = east[keep], north[keep]

        def score(ex, ny):
            px = cx + s * (east - ex); py = cy - s * (north - ny)
            inside = (px >= 0) & (px < side - 1) & (py >= top) & (py < h - 1)
            if inside.sum() < 100:
                return 1e9
            return dist[py[inside].astype(int), px[inside].astype(int)].mean()

        limit = min(35, RANGE[code] * 0.3)
        best = min((score(ex, ny), ex, ny) for ex in np.arange(-limit, limit + 0.1, 1.5) for ny in np.arange(-limit, limit + 0.1, 1.5))
        v, ex, ny = best
        for step in (0.75, 0.35, 0.15):
            improved = True
            while improved:
                improved = False
                for dx, dy in ((step, 0), (-step, 0), (0, step), (0, -step)):
                    cv = score(ex + dx, ny + dy)
                    if cv < v:
                        v, ex, ny, improved = cv, ex + dx, ny + dy, True
        lat = lat0 + ny / 110.57
        lon = lon0 + ex / (111.32 * math.cos(math.radians(lat0)))
        base = score(0, 0)
        out[code] = {"family": family, "panel": panel, "cx": cx, "cy": cy, "s": round(s, 5), "range": RANGE[code],
                     "lat": round(lat, 4), "lon": round(lon, 4), "score": round(float(v), 3), "score_unshifted": round(float(base), 3),
                     "shift_km": [round(float(ex), 1), round(float(ny), 1)], "size": [w, h]}
        print(code, out[code], flush=True)
    name = f"{HERE}/fits3{'-' + sys.argv[3] if len(sys.argv) > 3 else ''}.json"
    json.dump(out, open(name, "w"), indent=0)


if __name__ == "__main__":
    main()
