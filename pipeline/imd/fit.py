"""Fits each IMD radar image to geography: finds the pixel centre (cx, cy) and scale s (px per km) that line the
image's drawn borders/coasts up with Natural Earth state boundaries and coastlines around the station.

Model: px = cx + s * east_km, py = cy - s * north_km, with east/north from an azimuthal-equidistant projection
about the station coordinates. Scored by mean (capped) distance from projected boundary points to image edges.
"""
import json, math, sys
import numpy as np
from PIL import Image
from scipy import ndimage

HERE = sys.argv[1]
BORDERS = sys.argv[2]

# Rough main-panel rectangles per layout (image size) — the map plot, excluding side panels and legends.
PANELS = {
    (880, 720): (0, 152, 566, 720), (1278, 1048): (0, 250, 800, 1048), (940, 940): (0, 235, 631, 940),
    (1078, 770): (0, 183, 600, 770), (919, 700): (0, 200, 500, 700), (906, 700): (0, 200, 500, 700),
    (704, 594): (0, 148, 390, 594), (1119, 900): (0, 249, 652, 900), (1250, 1020): (0, 228, 800, 1020),
    (1200, 1020): (0, 228, 800, 1020), (880, 523): (18, 132, 417, 523), (1082, 720): (0, 205, 567, 720),
    (1006, 800): (0, 232, 600, 800), (3065, 2513): (53, 628, 1854, 2513), (1017, 787): (0, 186, 600, 787),
    (1272, 1042): (0, 233, 800, 1042), (1637, 1407): (0, 278, 1203, 1407), (1310, 1080): (0, 199, 880, 1080),
    (3038, 2490): (33, 622, 1802, 2490), (720, 720): (0, 237, 436, 720),
}
# IMD's own map puts these three at another station's coordinates.
FIXED = {"delhi": (28.589, 77.222), "jmu": (32.69, 74.84), "tez": (26.62, 92.78)}


def boundary_points():
    pts = []
    for name in ("ne_10m_admin_1_states_provinces.geojson", "ne_10m_admin_0_countries_pak.geojson"):
        data = json.load(open(f"{BORDERS}/{name}", encoding="utf-8"))
        for feature in data["features"]:
            props = feature["properties"]
            if name.startswith("ne_10m_admin_1") and props.get("adm0_a3") not in ("IND", "PAK", "NPL", "BGD", "BTN", "LKA", "MMR", "CHN"):
                continue
            geom = feature["geometry"]
            polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
            for poly in polys:
                for ring in poly:
                    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
                        if not (60 < x1 < 100 and 5 < y1 < 40):
                            continue
                        n = max(1, int(math.hypot(x2 - x1, y2 - y1) / 0.012))
                        for k in range(n):
                            t = k / n
                            pts.append((y1 + (y2 - y1) * t, x1 + (x2 - x1) * t))
    return np.array(pts)


def project(points, lat0, lon0):
    lat = np.radians(points[:, 0]); lon = np.radians(points[:, 1])
    p0 = math.radians(lat0); l0 = math.radians(lon0)
    cosc = math.sin(p0) * np.sin(lat) + math.cos(p0) * np.cos(lat) * np.cos(lon - l0)
    c = np.arccos(np.clip(cosc, -1, 1))
    k = np.where(c > 1e-9, c / np.sin(np.maximum(c, 1e-9)), 1.0)
    east = 6371 * k * np.cos(lat) * np.sin(lon - l0)
    north = 6371 * k * (math.cos(p0) * np.sin(lat) - math.sin(p0) * np.cos(lat) * np.cos(lon - l0))
    return east, north


def edge_distance(image, panel):
    grey = np.asarray(image.convert("L"), dtype=np.float32)
    gx = ndimage.sobel(grey, 1); gy = ndimage.sobel(grey, 0)
    mag = np.hypot(gx, gy)
    x0, y0, x1, y1 = panel
    mask = np.zeros(mag.shape, bool)
    mask[y0:y1, x0:x1] = True
    sub = mag[mask]
    edges = (mag > np.percentile(sub, 88)) & mask
    dist = ndimage.distance_transform_edt(~edges)
    return np.minimum(dist, 12.0)


def fit(code, lat0, lon0, image, panel, points):
    dist = edge_distance(image, panel)
    x0, y0, x1, y1 = panel
    east, north = project(points, lat0, lon0)
    keep = np.hypot(east, north) < 420
    east_all, north_all = east[keep], north[keep]
    stride = max(1, len(east_all) // 2500)
    best = (1e9, None)

    def score(cx, cy, s, full=False):
        e, n = (east_all, north_all) if full else (east_all[::stride], north_all[::stride])
        px = cx + s * e; py = cy - s * n
        inside = (px >= x0) & (px < x1 - 1) & (py >= y0) & (py < y1 - 1)
        need = 300 if not full else 300 * stride
        if inside.sum() < need / (1 if full else 1):
            return 1e9
        return dist[py[inside].astype(int), px[inside].astype(int)].mean() - 0.4 * min(1.0, inside.sum() / (3000 / (1 if not full else 1 / stride)))

    w = x1 - x0; h = y1 - y0
    for s in np.exp(np.linspace(math.log(0.4), math.log(9), 46)):
        for cx in np.arange(x0 + w * 0.1, x1 - w * 0.1, max(4, w / 40)):
            for cy in np.arange(y0 + h * 0.1, y1 - h * 0.1, max(4, h / 40)):
                v = score(cx, cy, s)
                if v < best[0]:
                    best = (v, (cx, cy, s))
    v, (cx, cy, s) = best
    v = score(cx, cy, s, True)
    for step in (6, 3, 1.5, 0.7, 0.3):
        improved = True
        while improved:
            improved = False
            for dcx, dcy, ds in ((step, 0, 0), (-step, 0, 0), (0, step, 0), (0, -step, 0), (0, 0, step / 200), (0, 0, -step / 200)):
                cand = (cx + dcx, cy + dcy, s * (1 + ds))
                cv = score(*cand, True)
                if cv < v:
                    v, (cx, cy, s), improved = cv, cand, True
    return {"cx": round(cx, 1), "cy": round(cy, 1), "s": round(s, 4), "score": round(v, 3)}


def main():
    stations = json.load(open(f"{HERE}/stations.json"))
    only = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else None
    points = boundary_points()
    results = {}
    for station in stations:
        code = station["code"]
        if only and code not in only:
            continue
        size = tuple(station["size"]) if isinstance(station["size"], list) else None
        if size not in PANELS:
            continue
        lat0, lon0 = FIXED.get(code, (station["lat"], station["lon"]))
        image = Image.open(f"{HERE}/all/{code}.gif").convert("RGB")
        result = fit(code, lat0, lon0, image, PANELS[size], points)
        result.update({"lat": lat0, "lon": lon0, "panel": PANELS[size], "size": list(size)})
        results[code] = result
        print(code, result, flush=True)
    json.dump(results, open(f"{HERE}/fits{'-' + sys.argv[3] if only else ''}.json", "w"), indent=0)


if __name__ == "__main__":
    main()
