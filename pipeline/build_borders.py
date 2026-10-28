"""Builds borders.json for the WAPK map from Natural Earth 1:10m data.

Countries come from the Pakistan point-of-view file (ne_10m_admin_0_countries_pak), so Kashmir is drawn as Pakistan
shows it. Provinces are Pakistan's only. Lines are cropped to the map area (+2° margin) and simplified to about 1 km.

Output: {"countries": [[lat, lon, lat, lon, ...], ...], "provinces": [...]} with coordinates rounded to 3 decimals.
"""
import json
import sys

REGION = {"south": 0 - 2, "north": 55 + 2, "west": 25 - 2, "east": 110 + 2}
TOLERANCE = {"countries": 0.01, "provinces": 0.006}


def inside(point):
    lon, lat = point
    return REGION["west"] <= lon <= REGION["east"] and REGION["south"] <= lat <= REGION["north"]


def simplify(points, tolerance):
    """Douglas–Peucker, iterative."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        (x1, y1), (x2, y2) = points[start], points[end]
        dx, dy = x2 - x1, y2 - y1
        length = (dx * dx + dy * dy) ** 0.5
        best, index = 0.0, None
        for i in range(start + 1, end):
            x, y = points[i]
            distance = abs(dy * x - dx * y + x2 * y1 - y2 * x1) / length if length else ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5
            if distance > best:
                best, index = distance, i
        if index is not None and best > tolerance:
            keep[index] = True
            stack += [(start, index), (index, end)]
    return [point for point, kept in zip(points, keep) if kept]


def rings(geometry):
    if geometry["type"] == "Polygon":
        yield from geometry["coordinates"]
    elif geometry["type"] == "MultiPolygon":
        for polygon in geometry["coordinates"]:
            yield from polygon


def pieces(ring):
    """Splits a ring into runs of consecutive points inside the region."""
    run = []
    for point in ring:
        if inside(point):
            run.append(point)
        elif run:
            yield run
            run = []
    if run:
        yield run


def edge_key(a, b):
    a, b = (round(a[0], 5), round(a[1], 5)), (round(b[0], 5), round(b[1], 5))
    return (a, b) if a <= b else (b, a)


def without_edges(ring, removed):
    """Splits a ring wherever it runs along one of the removed edges."""
    run = [ring[0]]
    for previous, point in zip(ring, ring[1:]):
        if edge_key(previous, point) in removed:
            if len(run) > 1:
                yield run
            run = [point]
        else:
            run.append(point)
    if len(run) > 1:
        yield run


def lines(features, tolerance, removed=frozenset()):
    out = []
    for feature in features:
        for ring in rings(feature["geometry"]):
            for part in without_edges(ring, removed):
              for run in pieces(part):
                simple = simplify(run, tolerance)
                if len(simple) < 2:
                    continue
                flat = []
                for lon, lat in simple:
                    flat += [round(lat, 3), round(lon, 3)]
                out.append(flat)
    return out


def main(countries_path, provinces_path, out_path):
    countries = json.load(open(countries_path, encoding="utf-8"))["features"]
    provinces = [f for f in json.load(open(provinces_path, encoding="utf-8"))["features"] if f["properties"].get("adm0_a3") == "PAK"]
    print("Pakistan provinces:", sorted(f["properties"].get("name") for f in provinces))
    # FATA merged into Khyber Pakhtunkhwa in 2018; Natural Earth still has it separate. Drop the edges KP and FATA share
    # so KP is drawn as one province (FATA's other edges are the Afghan border, already drawn as a country line).
    def edges(name):
        found = set()
        for feature in provinces:
            if feature["properties"].get("name") == name:
                for ring in rings(feature["geometry"]):
                    found |= {edge_key(a, b) for a, b in zip(ring, ring[1:])}
        return found
    shared = edges("K.P.") & edges("F.A.T.A.")
    print("KP-FATA shared edges removed:", len(shared))
    provinces = [f for f in provinces if f["properties"].get("name") != "F.A.T.A."]
    result = {
        "source": "Natural Earth 1:10m (public domain); countries from Pakistan's point of view",
        "countries": lines(countries, TOLERANCE["countries"]),
        "provinces": lines(provinces, TOLERANCE["provinces"], frozenset(shared)),
    }
    json.dump(result, open(out_path, "w", encoding="utf-8"), separators=(",", ":"))
    points = sum(len(line) // 2 for key in ("countries", "provinces") for line in result[key])
    print(f"{len(result['countries'])} country lines, {len(result['provinces'])} province lines, {points} points")


if __name__ == "__main__":
    main(*sys.argv[1:4])
