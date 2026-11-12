"""Builds the WAPK forecast map data from ECMWF IFS open data (CC-BY-4.0): surface at 0.1° (9 km), levels at 0.25°.

Downloads the latest IFS run for the next 7 days (3-hourly, 6-hourly after 144 h), crops the WAPK region, and writes
one small binary file per field and step plus `latest.json` describing them. The output folder is
published as a static Cloudflare Pages site that the Maps view reads directly.

Each value is stored as one byte (0–254, 255 = missing). Linear fields decode as offset + code × scale;
"sqrt" fields (rain, CAPE) decode as (code × scale)², which keeps detail at the low end.

Usage: python build_forecast.py --out <folder> [--steps 0,3,6] [--published-url <latest.json URL>]

With --published-url, the build is skipped when that site already has the newest ECMWF run. In GitHub
Actions the result is written to $GITHUB_OUTPUT as `changed=true|false` so the deploy step can be skipped.
"""

import argparse
import datetime as dt
import json
import math
import os
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request

import eccodes
import numpy as np
from ecmwf.opendata import Client

REGION = {"north": 55.0, "south": 0.0, "west": 25.0, "east": 110.0}
# Seven days: ECMWF open data is 3-hourly to 144 h, then 6-hourly. Only the 00Z and 12Z runs reach
# beyond 90 h, so the forecast updates twice a day.
STEPS = list(range(0, 145, 3)) + list(range(150, 169, 6))
# Pressure levels offered for wind and temperature (925 hPa is the nearest ECMWF level to 900 hPa).
LEVELS = [925, 850, 700, 500, 250]
# Temperature and height at these levels give the freezing level (ECMWF's own field is not open data).
FREEZING_LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300]
SURFACE_PARAMS = ["2t", "2d", "tp", "sf", "sd", "rsn", "10u", "10v", "msl", "tcc", "lcc", "mcc", "hcc", "10fg", "mucape", "ssrd", "tcwv", "ptype", "tprate", "sp"]
MISSING = 255
# Bump whenever the fields or their encoding change. It is part of the run id and the file paths, so
# browsers never mix files cached under the old format (run files are cached as immutable for a year),
# and the scheduled build republishes even when ECMWF's run itself has not changed.
FORMAT_VERSION = 10
# ECMWF runs four times a day, but only the 00Z and 12Z runs reach 168 h in open data; 06Z and 18Z stop at
# FRESH_HOURS. Each build takes the first FRESH_HOURS from the newest run of any kind and the rest of the week
# from the newest full run, so the near days always come from the latest model run.
FRESH_HOURS = 90
# Surface fields come from ECMWF's 0.1° (about 9 km) open data; the ones where detail matters (temperature,
# rain, snow, cloud, storms …) are stored on that FINE grid, the smooth ones (pressure, solar, 10 m wind for
# the particles …) are sampled down to the 0.25° grid with the pressure levels, keeping downloads small.
FINE_RESOL = "0p1"
FINE_FIELDS = {"temp", "dew", "rh", "precip", "rainacc", "snowacc", "snowdepth", "ptype", "storm", "cloud", "gust", "freezing", "orog"}
# Air quality (US AQI) is not in ECMWF's open data. It comes from Open-Meteo's air-quality API (CAMS global
# forecast, the same source as the site's Health section), sampled every AQI_STEP degrees and interpolated
# onto the forecast grid. CAMS reaches about 4–5 days ahead; later steps are missing.
AQI_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"
AQI_STEP = 1.5
AQI_BATCH = 100
AQI_PAUSE_SECONDS = 12

WIND = {"encoding": "linear", "offset": -100.0, "scale": 200 / 254, "unit": "m/s"}
TEMPERATURE = {"encoding": "linear", "offset": -80.0, "scale": 130 / 254, "unit": "°C"}
PERCENT = {"encoding": "linear", "offset": 0.0, "scale": 100 / 254, "unit": "%"}
FIELDS = {
    "temp": TEMPERATURE,
    "freezing": {"encoding": "linear", "offset": 0.0, "scale": 7000 / 254, "unit": "m"},
    "precip": {"encoding": "sqrt", "scale": math.sqrt(100) / 254, "unit": "mm/h"},
    "gust": {"encoding": "linear", "offset": 0.0, "scale": 80 / 254, "unit": "m/s"},
    "dew": TEMPERATURE,
    "rh": PERCENT,
    "rainacc": {"encoding": "sqrt", "scale": math.sqrt(500) / 254, "unit": "mm"},
    "snowacc": {"encoding": "sqrt", "scale": math.sqrt(300) / 254, "unit": "cm"},
    "snowdepth": {"encoding": "sqrt", "scale": math.sqrt(1000) / 254, "unit": "cm"},
    "tcwv": {"encoding": "linear", "offset": 0.0, "scale": 80 / 254, "unit": "mm"},
    # Precipitation type as an ordered category: see PRECIP_TYPES.
    "ptype": {"encoding": "linear", "offset": 0.0, "scale": 1.0, "unit": "category"},
    "solar": {"encoding": "linear", "offset": 0.0, "scale": 1200 / 254, "unit": "W/m²"},
    "cloud": PERCENT,
    "lowcloud": PERCENT,
    "midcloud": PERCENT,
    "highcloud": PERCENT,
    "pressure": {"encoding": "linear", "offset": 940.0, "scale": 120 / 254, "unit": "hPa"},
    "cape": {"encoding": "sqrt", "scale": math.sqrt(8000) / 254, "unit": "J/kg"},
    # Thunderstorm forecast as an ordered category: see storm_category.
    "storm": {"encoding": "linear", "offset": 0.0, "scale": 1.0, "unit": "category"},
    "aqi": {"encoding": "linear", "offset": 0.0, "scale": 500 / 254, "unit": "US AQI"},
    # The model's own ground height (m) on the fine grid, written once per run: the map corrects temperature
    # for the difference between it and the real terrain.
    "orog": {"encoding": "linear", "offset": -500.0, "scale": 9000 / 254, "unit": "m", "static": True},
    "u10": WIND,
    "v10": WIND,
    **{f"{component}{level}": WIND for level in LEVELS for component in ("u", "v")},
    **{f"t{level}": TEMPERATURE for level in LEVELS},
    **{f"r{level}": PERCENT for level in LEVELS},
}


def encode(values, spec):
    """Packs a float array into bytes using the field's scale; NaN becomes MISSING."""
    if spec["encoding"] == "sqrt":
        codes = np.sqrt(np.clip(values, 0, None)) / spec["scale"]
    else:
        codes = (values - spec["offset"]) / spec["scale"]
    packed = np.clip(np.rint(codes), 0, 254)
    packed[np.isnan(values)] = MISSING
    return packed.astype(np.uint8)


def freezing_level(temperatures, heights, surface_temperature):
    """Height in metres of the 0 °C level, from temperatures (K) and geopotential heights (m) at
    FREEZING_LEVELS, ordered from the lowest level up, plus the 2 m temperature (K).

    Where temperature crosses 0 °C more than once (e.g. a cold valley under warmer air), the highest
    crossing is used, as on Windy. Wherever it is already freezing at 2 m the result is 0, meaning
    "at the ground": over high terrain such as Tibet the lowest pressure levels are below the surface,
    and their model-extrapolated values would otherwise put the freezing level underground.
    """
    result = np.full(temperatures[0].shape, np.nan, dtype=np.float32)
    for lower in reversed(range(len(temperatures) - 1)):
        warm = temperatures[lower] - 273.15
        cold = temperatures[lower + 1] - 273.15
        crosses = (warm > 0) & (cold <= 0) & np.isnan(result)
        with np.errstate(divide="ignore", invalid="ignore"):
            fraction = warm / (warm - cold)
        height = heights[lower] + fraction * (heights[lower + 1] - heights[lower])
        result = np.where(crosses, height, result)
    result = np.where(np.isnan(result) & (temperatures[0] - 273.15 <= 0), 0, result)
    result = np.where(surface_temperature - 273.15 <= 0, 0, result)
    return np.clip(result, 0, None)


# ECMWF ptype codes → the map's categories: 1 rain, 2 rain and snow mixed (incl. wet snow), 3 snow,
# 4 freezing rain, freezing drizzle or ice pellets. 0 means no precipitation.
PRECIP_TYPES = {1: 1, 6: 2, 7: 2, 5: 3, 3: 4, 8: 4, 12: 4}


def precip_category(ptype):
    result = np.zeros(ptype.shape, dtype=np.float32)
    for code, category in PRECIP_TYPES.items():
        result[np.rint(ptype) == code] = category
    result[np.isnan(ptype)] = np.nan
    return result


def ground_height(surface_pressure, sea_level_pressure, temperature):
    """Ground height in metres from surface and sea-level pressure (hypsometric equation, mean layer
    temperature taken as the 2 m temperature plus half a standard lapse over the layer)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.log(sea_level_pressure / surface_pressure)
    height = 287.05 * (temperature + 3.0) / 9.80665 * ratio
    return np.clip(np.nan_to_num(height, nan=0.0), 0, None)


def storm_category(rain, cape, freezing, ground, t500, wind500):
    """Thunderstorms by the WAPK app's rules (Weather Alert PK, weather_controller.dart; weather-logic.js),
    so CAPE alone never paints a storm: there must be rain too.

    rain is mm/h, cape J/kg (most-unstable CAPE), freezing and ground metres above sea level, t500 °C and
    wind500 m/s. The app's "doors" need rain over 1 mm/h, or at least 0.1 mm/h with strong instability;
    then a storm needs CAPE of at least 500 J/kg with real rain (over 0.5 mm/h), or CAPE of at least
    2000 J/kg. ECMWF open data has no lifted index or precipitation probability, so the app's lifted-index
    tests use CAPE alone and the model's rain stands in for the probability.

    Categories: 0 none, 1 isolated (rain up to 1 mm/h), 2 scattered (1–3), 3 thunderstorms (3–4),
    4 heavy thunderstorms (over 4), 5 thunderstorm with hail. Hail reaches the ground where the warm layer
    below the freezing level is at most 4200 m, it is -4 °C or colder at 500 hPa and the 500 hPa wind
    (a shear proxy) is at least 17 kt.
    """
    rain = np.nan_to_num(rain, nan=0.0)
    cape = np.nan_to_num(cape, nan=0.0)
    door = (rain > 1) | ((rain >= 0.1) & (cape >= 2000))
    storm = door & (((rain > 0.5) & (cape >= 500)) | (cape >= 2000))
    tier = np.select([rain <= 1, rain <= 3, rain <= 4], [1, 2, 3], 4)
    hail = storm & (freezing - ground <= 4200) & (t500 <= -4) & (wind500 * 3.6 / 1.852 >= 17)
    result = np.where(storm, np.where(hail, 5, tier), 0).astype(np.float32)
    return result


def relative_humidity(temperature, dew_point):
    """Relative humidity in % from 2 m temperature and dew point in kelvin (Magnus formula, over water)."""
    t = temperature - 273.15
    d = dew_point - 273.15
    return np.clip(100 * np.exp(17.625 * d / (243.04 + d) - 17.625 * t / (243.04 + t)), 0, 100)


def snow_depth(water_equivalent, density):
    """Snow depth in cm from snow water equivalent (m) and snow density (kg/m³)."""
    density = np.where(np.isnan(density) | (density < 50), 300, density)
    return water_equivalent * 1000 / density * 100


def crop_window(gid):
    """Row and column slices of the global grid that cover REGION, plus the grid shape."""
    ni = eccodes.codes_get(gid, "Ni")
    nj = eccodes.codes_get(gid, "Nj")
    lat0 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
    lon0 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
    di = eccodes.codes_get(gid, "iDirectionIncrementInDegrees")
    dj = eccodes.codes_get(gid, "jDirectionIncrementInDegrees")
    if eccodes.codes_get(gid, "jScansPositively") or eccodes.codes_get(gid, "iScansNegatively"):
        raise ValueError("Unexpected grid scanning order")
    row0 = round((lat0 - REGION["north"]) / dj)
    row1 = round((lat0 - REGION["south"]) / dj)
    col0 = round(((REGION["west"] - lon0) % 360) / di)
    col1 = round(((REGION["east"] - lon0) % 360) / di)
    if col1 < col0 or row0 < 0 or row1 >= nj:
        raise ValueError("Region crosses the grid edge")
    return (slice(row0, row1 + 1), slice(col0, col1 + 1)), (nj, ni), di


def read_messages(path):
    """Yields (shortName, level, step, cropped values) for every GRIB message in a file."""
    with open(path, "rb") as handle:
        while True:
            gid = eccodes.codes_grib_new_from_file(handle)
            if gid is None:
                break
            try:
                window, shape, resolution = crop_window(gid)
                # 32-bit floats halve memory; a full build holds about 2,800 cropped grids (about 850 MB).
                values = eccodes.codes_get_values(gid).reshape(shape)[window].astype(np.float32)
                missing = eccodes.codes_get(gid, "missingValue")
                values[values == missing] = np.nan
                yield (
                    eccodes.codes_get(gid, "shortName"),
                    eccodes.codes_get(gid, "level"),
                    int(eccodes.codes_get(gid, "endStep")),
                    values,
                    resolution,
                )
            finally:
                eccodes.codes_release(gid)


def retrieve(client, run, steps, target, **request):
    """Downloads with a few retries; the ECMWF portal limits concurrent connections."""
    for attempt in range(4):
        try:
            client.retrieve(date=run, type="fc", step=steps, target=target, **request)
            return
        except Exception as error:  # noqa: BLE001 - retried, then re-raised
            if attempt == 3:
                raise
            print(f"retrying after: {error}", file=sys.stderr)
            time.sleep(20 * (attempt + 1))


def regrid(values, source, target):
    """Bilinear resampling between two grids of the same REGION (north-west origin, regular steps)."""
    rows = np.clip(np.arange(target["ny"]) * target["step"] / source["step"], 0, source["ny"] - 1)
    cols = np.clip(np.arange(target["nx"]) * target["step"] / source["step"], 0, source["nx"] - 1)
    r0 = np.minimum(np.floor(rows).astype(int), source["ny"] - 2)
    c0 = np.minimum(np.floor(cols).astype(int), source["nx"] - 2)
    ty = (rows - r0)[:, None]
    tx = (cols - c0)[None, :]
    a = values[r0][:, c0]
    b = values[r0][:, c0 + 1]
    c = values[r0 + 1][:, c0]
    d = values[r0 + 1][:, c0 + 1]
    return ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty).astype(np.float32)


def fetch_aqi(run, steps, grid):
    """US AQI at every step on the forecast grid (NaN where CAMS has no value), or None if Open-Meteo fails.

    The coarse AQI_STEP grid is fetched AQI_BATCH points per request, paced to stay well inside Open-Meteo's
    free limits (about 2,100 points per run), then interpolated bilinearly onto the 0.25° grid.
    """
    north, west, step, nx, ny = grid["north"], grid["west"], grid["step"], grid["nx"], grid["ny"]
    lats = np.arange(REGION["north"], REGION["south"] - 1e-6, -AQI_STEP)
    lons = np.arange(REGION["west"], REGION["east"] + 1e-6, AQI_STEP)
    points = [(lat, lon) for lat in lats for lon in lons]
    coarse = {}
    for start in range(0, len(points), AQI_BATCH):
        batch = points[start:start + AQI_BATCH]
        query = urllib.parse.urlencode({
            "latitude": ",".join(f"{lat:.2f}" for lat, _ in batch),
            "longitude": ",".join(f"{lon:.2f}" for _, lon in batch),
            "hourly": "us_aqi", "past_days": 1, "forecast_days": 7, "timezone": "GMT", "timeformat": "unixtime",
        })
        for attempt in range(4):
            try:
                request = urllib.request.Request(f"{AQI_URL}?{query}", headers={"User-Agent": "WAPK-forecast-builder/1.0"})
                with urllib.request.urlopen(request, timeout=120) as response:
                    answers = json.load(response)
                break
            except Exception as error:  # noqa: BLE001 - any failure is retried, then AQI is skipped
                print(f"AQI batch {start // AQI_BATCH + 1} failed ({error}); retrying", flush=True)
                time.sleep(30 * (attempt + 1))
        else:
            print("AQI unavailable; publishing without it.", flush=True)
            return None
        for (lat, lon), answer in zip(batch, answers if isinstance(answers, list) else [answers]):
            hourly = answer.get("hourly", {})
            coarse[(lat, lon)] = dict(zip(hourly.get("time", []), hourly.get("us_aqi", [])))
        time.sleep(AQI_PAUSE_SECONDS)

    run_seconds = int(run.replace(tzinfo=dt.timezone.utc).timestamp())
    fine_lat = north - np.arange(ny) * step
    fine_lon = west + np.arange(nx) * step
    # Positions of the fine grid in coarse-grid units, for bilinear interpolation.
    row = np.clip((REGION["north"] - fine_lat) / AQI_STEP, 0, len(lats) - 1)
    col = np.clip((fine_lon - REGION["west"]) / AQI_STEP, 0, len(lons) - 1)
    r0 = np.minimum(np.floor(row).astype(int), len(lats) - 2)
    c0 = np.minimum(np.floor(col).astype(int), len(lons) - 2)
    ty = (row - r0)[:, None]
    tx = (col - c0)[None, :]
    result = {}
    for step_hours in steps:
        valid = run_seconds + step_hours * 3600
        values = np.array([[coarse[(lat, lon)].get(valid) for lon in lons] for lat in lats], dtype=float)
        if np.isnan(values).all():
            result[step_hours] = None
            continue
        a = values[r0][:, c0]
        b = values[r0][:, c0 + 1]
        c = values[r0 + 1][:, c0]
        d = values[r0 + 1][:, c0 + 1]
        result[step_hours] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
    return result


def published_run(url):
    """The runId currently published at `url`, or None when it cannot be read."""
    # Cloudflare refuses Python's default "Python-urllib" User-Agent, so name the pipeline instead.
    request = urllib.request.Request(url, headers={"User-Agent": "WAPK-forecast-pipeline/1.0", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response).get("runId")
    except Exception as error:  # noqa: BLE001 - an unreadable site just means "build anyway"
        print(f"Could not read the published forecast ({error}); building anyway.", flush=True)
        return None


def set_output(name, value):
    """Passes a value to later GitHub Actions steps; does nothing elsewhere."""
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def build(out, steps, published_url=None):
    client = Client(source="ecmwf", model="ifs", resol="0p25")
    fine_client = Client(source="ecmwf", model="ifs", resol=FINE_RESOL)
    # The newest run complete to FRESH_HOURS and the newest run complete to the end of the week, at both
    # resolutions (the 0.1° files come out a little after the 0.25° ones).
    newest = min(c.latest(type="fc", step=FRESH_HOURS, param="2t") for c in (client, fine_client))
    full = min(c.latest(type="fc", step=max(steps), param="2t") for c in (client, fine_client))
    newest = max(newest, full)
    fresh_end = max(steps) if newest == full else max(step for step in steps if step <= FRESH_HOURS)
    lag = round((newest - full).total_seconds() / 3600)
    fresh_steps = [step for step in steps if step <= fresh_end]
    # The full run's steps after the newest run's last one; its step at the join is needed for rates and totals.
    tail_steps = [step for step in steps if step - lag > fresh_end] if newest != full else []
    join_step = fresh_end + lag
    if tail_steps and join_step not in steps:
        raise SystemExit(f"No full-run step at the join ({join_step} h)")
    run_id = f"{newest:%Y%m%d%H}" + (f"-{full:%d%H}" if tail_steps else "") + f"-v{FORMAT_VERSION}"
    print(f"ECMWF IFS run {newest:%Y-%m-%d %H}Z to {fresh_end} h" + (f", then {full:%Y-%m-%d %H}Z to {max(steps)} h" if tail_steps else ""), flush=True)
    if published_url and published_run(published_url) == run_id:
        print("That run is already published; nothing to do.", flush=True)
        set_output("changed", "false")
        return None

    # Timeline: (source, step, valid time). "new" is the newest run, "full" the full run for the tail.
    timeline = [("new", step, newest + dt.timedelta(hours=step)) for step in fresh_steps]
    timeline += [("full", step, full + dt.timedelta(hours=step)) for step in tail_steps]
    downloads = {"new": (newest, fresh_steps)}
    if tail_steps:
        downloads["full"] = (full, [join_step] + tail_steps)

    grids = {}
    fine = {}
    resolution = None
    fine_resolution = None
    with tempfile.TemporaryDirectory() as work:
        for source, (run, run_steps) in downloads.items():
            surface = os.path.join(work, f"{source}-surface.grib2")
            levels = os.path.join(work, f"{source}-levels.grib2")
            profile = os.path.join(work, f"{source}-profile.grib2")
            retrieve(fine_client, run, run_steps, surface, param=SURFACE_PARAMS)
            for name, _, step, values, fine_resolution in read_messages(surface):
                fine[(name, source, step)] = values
            os.remove(surface)
            retrieve(client, run, run_steps, levels, param=["u", "v", "t", "r"], levelist=LEVELS)
            retrieve(client, run, run_steps, profile, param=["t", "gh"], levelist=FREEZING_LEVELS)
            for path in (levels, profile):
                for name, level, step, values, resolution in read_messages(path):
                    grids[(name, level, source, step)] = values
                os.remove(path)

    sample = next(iter(grids.values()))
    ny, nx = sample.shape
    fine_sample = next(iter(fine.values()))
    fine_grid = {"north": REGION["north"], "west": REGION["west"], "step": fine_resolution, "nx": fine_sample.shape[1], "ny": fine_sample.shape[0]}
    out_run = os.path.join(out, "runs", run_id)
    if os.path.exists(out):
        # Only ever replace a folder this script produced, never an arbitrary directory passed by mistake.
        if os.listdir(out) and not os.path.exists(os.path.join(out, "latest.json")):
            raise SystemExit(f"Refusing to replace {out}: it is not empty and has no latest.json")
        shutil.rmtree(out)

    def write(field, index, values):
        folder = os.path.join(out_run, field)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, f"{index}.bin"), "wb") as handle:
            handle.write(encode(values, FIELDS[field]).tobytes())

    empty = np.full((ny, nx), np.nan)
    fine_empty = np.full((fine_grid["ny"], fine_grid["nx"]), np.nan)
    grid = {"north": REGION["north"], "west": REGION["west"], "step": resolution, "nx": nx, "ny": ny}
    # Hours after the newest run of every timeline entry (AQI is matched by valid time).
    hours = [round((valid - newest).total_seconds() / 3600) for _, _, valid in timeline]
    aqi = fetch_aqi(newest, hours, grid)
    up = lambda values: regrid(values, grid, fine_grid)  # noqa: E731 - 0.25° level data onto the 0.1° grid
    down = lambda values: regrid(values, fine_grid, grid)  # noqa: E731 - smooth surface fields onto 0.25°

    def total(name, source, step):
        """A field accumulated since its run started (rain, snow, radiation), continued across the join: the
        tail adds what the full run accumulates after the join to the newest run's total at its last step."""
        if source == "new":
            return fine.get((name, "new", step), fine_empty)
        return fine.get((name, "new", fresh_end), fine_empty) + fine.get((name, "full", step), fine_empty) - fine.get((name, "full", join_step), fine_empty)

    def first_available(name):
        """Fields that cover the period before each step (gusts, radiation) have nothing at step 0."""
        return next((fine[(name, "new", later)] for later in fresh_steps if (name, "new", later) in fine and later), fine_empty)

    def write_field(field, index, values):
        """Writes a fine-grid value array on the grid its field is stored on."""
        write(field, index, values if field in FINE_FIELDS else down(values))

    # The model's ground height, from the surface and sea-level pressure at the first step.
    first = fresh_steps[0]
    write("orog", 0, ground_height(fine[("sp", "new", first)], fine[("msl", "new", first)], fine[("2t", "new", first)]))

    for index, (source, step, valid) in enumerate(timeline):
        get = lambda name: fine.get((name, source, step), fine_empty)  # noqa: E731 - surface fields, 0.1°
        level_at = lambda name, level: grids.get((name, level, source, step), empty)  # noqa: E731 - levels, 0.25°
        # The entry before this one, for values over the last interval (the join's previous one is the full run's).
        previous = timeline[index - 1] if index else None
        if previous and previous[0] != source:
            previous = ("full", join_step, previous[2])
        interval = (valid - previous[2]).total_seconds() / 3600 if previous else None
        write_field("temp", index, get("2t") - 273.15)
        # Precipitation is accumulated since the run started; the map shows the rate over the last interval.
        if previous is None:
            rate = np.zeros(fine_empty.shape)
        else:
            rate = (total("tp", source, step) - total("tp", previous[0], previous[1])) * 1000 / interval
        write_field("precip", index, np.clip(rate, 0, None))
        # Gusts are a maximum over the preceding period, so the run's first step has none; use the next one.
        gust = get("10fg")
        if np.isnan(gust).all():
            gust = first_available("10fg")
        write_field("gust", index, gust)
        # Rain and snowfall totals since the newest run started (snow as fresh snow, about 1 cm per mm of water).
        write_field("rainacc", index, np.clip(total("tp", source, step) * 1000, 0, None) if index else np.zeros(fine_empty.shape))
        write_field("snowacc", index, np.clip(total("sf", source, step) * 1000, 0, None) if index else np.zeros(fine_empty.shape))
        write_field("snowdepth", index, np.clip(snow_depth(get("sd"), get("rsn")), 0, None))
        # Downward solar radiation is accumulated too: the mean over the last interval, in W/m².
        if previous is None:
            later = next((later for later in fresh_steps if later), None)
            solar = first_available("ssrd") / (later * 3600) if later else fine_empty
        else:
            solar = (total("ssrd", source, step) - total("ssrd", previous[0], previous[1])) / (interval * 3600)
        write_field("solar", index, np.clip(solar, 0, None))
        write_field("dew", index, get("2d") - 273.15)
        write_field("tcwv", index, get("tcwv"))
        # ECMWF gives a type even for trace amounts; show it only where at least 0.1 mm/h is falling.
        write_field("ptype", index, np.where(get("tprate") * 3600 >= 0.1, precip_category(get("ptype")), 0))
        write_field("rh", index, relative_humidity(get("2t"), get("2d")))
        write_field("cloud", index, get("tcc") * 100)
        write_field("lowcloud", index, get("lcc") * 100)
        write_field("midcloud", index, get("mcc") * 100)
        write_field("highcloud", index, get("hcc") * 100)
        write_field("pressure", index, get("msl") / 100)
        write_field("cape", index, get("mucape"))
        # The rain over the interval can hide a short downpour, so the instantaneous rate counts too.
        storm_rain = np.fmax(np.clip(rate, 0, None), np.nan_to_num(get("tprate") * 3600, nan=0.0))
        freezing = freezing_level([up(level_at("t", level)) for level in FREEZING_LEVELS], [up(level_at("gh", level)) for level in FREEZING_LEVELS], get("2t"))
        write_field("storm", index, storm_category(
            storm_rain, get("mucape"), freezing, ground_height(get("sp"), get("msl"), get("2t")),
            up(level_at("t", 500)) - 273.15, np.hypot(up(level_at("u", 500)), up(level_at("v", 500))),
        ))
        write_field("u10", index, get("10u"))
        write_field("v10", index, get("10v"))
        for level in LEVELS:
            write(f"u{level}", index, level_at("u", level))
            write(f"v{level}", index, level_at("v", level))
            write(f"t{level}", index, level_at("t", level) - 273.15)
            write(f"r{level}", index, np.clip(level_at("r", level), 0, 100))
        write_field("freezing", index, freezing)
        if aqi is not None:
            write("aqi", index, aqi[hours[index]] if aqi[hours[index]] is not None else empty)

    fields = {name: ({**spec, "grid": "fine"} if name in FINE_FIELDS else spec) for name, spec in FIELDS.items() if name != "aqi"}
    if aqi is not None:
        covered = [index for index, hour in enumerate(hours) if aqi[hour] is not None]
        if covered:
            fields["aqi"] = {**FIELDS["aqi"], "lastStep": covered[-1]}

    meta = {
        "source": "ECMWF IFS open data",
        "model": "IFS 0.1° surface, 0.25° levels",
        "license": "CC-BY-4.0",
        "attribution": "Contains modified Copernicus/ECMWF open data. © ECMWF, CC-BY-4.0.",
        "run": newest.replace(tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        # After FRESH_HOURS the steps come from this (older) full run, when the newest run is a 06Z/18Z one.
        "tailRun": full.replace(tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z") if tail_steps else None,
        "runId": run_id,
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "grid": grid,
        # Fields marked "grid": "fine" use this 0.1° grid; the rest use "grid".
        "grids": {"fine": fine_grid},
        "times": [int(valid.replace(tzinfo=dt.timezone.utc).timestamp()) for _, _, valid in timeline],
        "missing": MISSING,
        # Without AQI (Open-Meteo down) the field is left out, so the map hides the layer. With it, lastStep is
        # the last step CAMS covers, so the map's time slider stops there for Air quality.
        "fields": fields,
        "path": f"runs/{run_id}/{{field}}/{{step}}.bin",
    }
    with open(os.path.join(out, "latest.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, ensure_ascii=False, separators=(",", ":"))
    # Cloudflare Pages headers: any site may read the data; run files never change, latest.json often does.
    # Run files are labelled text/plain only because Cloudflare compresses that type (75 KB → about 40 KB);
    # the bytes are unchanged and the map reads them as raw binary.
    with open(os.path.join(out, "_headers"), "w", encoding="utf-8") as handle:
        handle.write(
            "/*\n  Access-Control-Allow-Origin: *\n"
            "/latest.json\n  Cache-Control: public, max-age=300\n"
            "/outlook.json\n  Cache-Control: public, max-age=300\n"
            "/runs/*\n  Cache-Control: public, max-age=31536000, immutable\n"
            "  Content-Type: text/plain; charset=x-user-defined\n"
        )
    with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as handle:
        handle.write(
            "<!doctype html><meta charset=utf-8><title>WAPK forecast data</title>"
            f"<p>Forecast map data for WAPK — Weather Alert PK. Run {newest:%Y-%m-%d %H}Z.</p>"
            f"<p>{meta['attribution']}</p>"
        )
    # Without a 404 page, Cloudflare Pages answers unknown paths with index.html and status 200. The map
    # needs a real 404 for files of a replaced run, so it knows to reload latest.json.
    with open(os.path.join(out, "404.html"), "w", encoding="utf-8") as handle:
        handle.write("<!doctype html><meta charset=utf-8><title>Not found</title><p>Not found.</p>")
    files = sum(len(names) for _, _, names in os.walk(out_run))
    print(f"Wrote {files} files, grid {nx}x{ny} at {resolution} deg to {out}", flush=True)
    set_output("changed", "true")
    set_output("run", run_id)
    return meta


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, help="Output folder (replaced)")
    parser.add_argument("--steps", help="Comma-separated forecast hours, default 0–168 (see STEPS)")
    parser.add_argument("--published-url", help="latest.json of the live site; skip the build if it already has this run")
    args = parser.parse_args()
    steps = [int(step) for step in args.steps.split(",")] if args.steps else STEPS
    build(os.path.abspath(args.out), steps, args.published_url)


if __name__ == "__main__":
    main()
