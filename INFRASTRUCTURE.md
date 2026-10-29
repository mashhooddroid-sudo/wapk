# WAPK — Weather Alert PK: Complete Infrastructure Guide

> Everything about how WAPK works: what runs where, where every piece of data comes from, how to deploy, how to fix things.
> Written 25 October 2026, updated 28 October 2026 (Health section, Lahore pollen, seasonal diseases, fire layer). If something changes, update this file.

---

## Table of contents

1. [The big picture](#1-the-big-picture)
2. [Accounts and logins](#2-accounts-and-logins)
3. [Folders on your PC](#3-folders-on-your-pc)
4. [The website (wapk.pages.dev)](#4-the-website-wapkpagesdev)
5. [Where every piece of data comes from](#5-where-every-piece-of-data-comes-from)
6. [The forecast map pipeline (ECMWF → your map)](#6-the-forecast-map-pipeline-ecmwf--your-map)
7. [The map data file format](#7-the-map-data-file-format)
8. [The backend worker (lightning-weatherx-pk-api)](#8-the-backend-worker-lightning-weatherx-pk-api)
9. [Satellite images](#9-satellite-images)
9b. [Active fires (NASA FIRMS)](#9b-active-fires-nasa-firms)
10. [PMD radar](#10-pmd-radar)
11. [Lightning strikes](#11-lightning-strikes)
12. [METAR (live airport weather)](#12-metar-live-airport-weather)
13. [Thunderstorm, hail and fog rules](#13-thunderstorm-hail-and-fog-rules)
13b. [Health section](#13b-health-section)
14. [The Maps screen: how it behaves](#14-the-maps-screen-how-it-behaves)
15. [Schedules: what runs when](#15-schedules-what-runs-when)
16. [Costs and free-tier limits](#16-costs-and-free-tier-limits)
17. [How to deploy each part](#17-how-to-deploy-each-part)
18. [Common tasks (how do I…?)](#18-common-tasks-how-do-i)
19. [Troubleshooting](#19-troubleshooting)
20. [Rules and gotchas to never forget](#20-rules-and-gotchas-to-never-forget)
21. [Open items](#21-open-items)
22. [Glossary](#22-glossary)

---

## 1. The big picture

WAPK is a **static website** (just HTML, CSS and JavaScript files, no server of its own). Everything "live" comes from
other places: some are free public services, some are **your own** Cloudflare services.

```
                         ┌──────────────────────────────────────────────┐
                         │        Visitor's browser (wapk.pages.dev)    │
                         │  Overview · Hourly · This week · Maps · Health│
                         └──────────────┬───────────────────────────────┘
                                        │ reads from
      ┌───────────────┬─────────────────┼──────────────────┬──────────────────────┬──────────────────┐
      ▼               ▼                 ▼                  ▼                      ▼                  ▼
 Open-Meteo     Your METAR API    wapk-forecast       Your PK worker          PMD radar images    Map tiles
 (forecast,     travel-weather-   .pages.dev          lightning-weatherx-     ffd.pmd.gov.pk      Esri / OSM
 air quality,   api…workers.dev   (ECMWF map data)    pk-api…workers.dev      (loaded directly)
 city search)                          ▲              (strikes, satellite,
                                       │               PMD radar list)
                                       │                    ▲   ▲   ▲
                              GitHub Actions             cron every 5 min
                              every 3 hours              │   │   ├── PMD radar manifest (ffd.pmd.gov.pk)
                                                         │   │   ├── PMD pollen pages (weather.gov.pk, ffd.pmd.gov.pk), every 3 h
                                                         │   │   └── NASA FIRMS active fires, every 30 min
                              (Python pipeline)          │   └────── EUMETSAT satellite (view.eumetsat.int)
                                       ▲                 └────────── Lightning feed (lightning-alerts worker)
                                       │
                              ECMWF open data
                              (data.ecmwf.int, GRIB2)
```

**In one sentence each:**

| Part | What it is | Where it lives |
|---|---|---|
| Website | The pages people see | Cloudflare Pages project `wapk` → https://wapk.pages.dev |
| Forecast map data | ECMWF model turned into small files | Cloudflare Pages project `wapk-forecast` → https://wapk-forecast.pages.dev |
| Map data builder | Python script that makes the files above | GitHub repo `mashhooddroid-sudo/wapk`, runs on GitHub Actions |
| Backend worker | Lightning, satellite, radar list, PMD pollen, fires | Cloudflare Worker `lightning-weatherx-pk-api` |
| Database | Strikes, satellite images, pollen reports, fire snapshot | Cloudflare D1 `lightning-pk-strikes` |
| METAR API | Live airport weather | Your separate worker `travel-weather-api.mashhood2717.workers.dev` |

---

## 2. Accounts and logins

| Service | Account | Used for |
|---|---|---|
| **Cloudflare** | **Mashhood.droid@gmail.com** (Account ID `e35f62e834050b6f12e9103657ebcb53`) | Website, map data site, worker, D1 database. **Everything WAPK runs here.** |
| Cloudflare (other) | pakisweather@gmail.com | **Not used by WAPK.** Wrangler was once logged into it — deploying from it fails with "Authentication error 10000". |
| **GitHub** | **mashhooddroid-sudo** | Private repo `wapk` and the scheduled map-data builds |
| Git commit name | mashhood2717-ai | Name on commits (set in your git config). Different from the GitHub account — that is fine. |
| METAR API | Lives on the `mashhood2717` Workers subdomain | Your Travel Weather API (source is not in this project) |

**Check which Cloudflare account Wrangler uses before any deploy:**

```bash
npx wrangler whoami
```

It must show **Mashhood.droid@gmail.com's Account**.

**Secrets stored in GitHub** (repo → Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A Cloudflare API token named "WAPK forecast GitHub", permission **Account → Cloudflare Pages → Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | `e35f62e834050b6f12e9103657ebcb53` |

If the token is ever deleted or expires, the map data stops updating (the GitHub run fails at "Publish to Cloudflare Pages").
Make a new one the same way and paste it into the secret.

---

## 3. Folders on your PC

| Folder | What is in it |
|---|---|
| `D:\Test Weather webapp` | **The WAPK website + map pipeline.** Git repo, pushed to GitHub `mashhooddroid-sudo/wapk`. |
| `D:\Test Weather webapp\worker` | **The backend worker** WAPK uses (`index.js`, `wrangler.jsonc`, `migrations\`). In git and on GitHub since 28 Oct 2026. |
| `D:\Lightning Weather x` | Lightning Weather X sites. Its `worker-pk\` folder is the **old copy** of the worker — no longer edited; use `worker\` in the WAPK repo. Not a git repo. |
| `D:\Last stable build codes\weather_app` | Your Flutter app "Weather & Prayer Alert PK" (v1.8.4+108). Source of the thunderstorm/hail rules. |

### Inside `D:\Test Weather webapp`

| File | What it does |
|---|---|
| `index.html` | The page structure: sidebar, Overview, Hourly, This week, Maps. Loads all scripts with `?v=` version tags. |
| `styles.css` | Look of the whole site (glass cards, colours, phone layout). |
| `radar.css` | Look of the Maps screen (layer rail, timeline, satellite bar, legend). |
| `app.js` | Overview / Hourly / Week: fetches the forecast, METAR, air quality, city search; draws everything. |
| `weather-logic.js` | Thunderstorm, hail and fog rules ported from your Flutter app. |
| `health.js` | Health section: alerts, air quality, PMD pollen, seasonal disease risks, heat/cold/UV. |
| `pointforecast.js` | Map picker's point forecast panel (7 days, 3-hour columns) and the map's location search. |
| `wapk-logo.png` | Weather Alert PK logo icon for the map's top bar (cut from the Flutter app's `assets/images/logo.png`). |
| `borders.json` | Country borders, coastlines and Pakistan's provinces for the map (≈ 465 KB, ≈ 167 KB compressed). Built by `pipeline/build_borders.py`. |
| `pipeline/build_borders.py` | Makes `borders.json` from Natural Earth 1:10m data (Pakistan point of view), cropped and simplified. |
| `icons.js` | All the drawn icons (weather icons and small UI icons). |
| `views.js` | Switching between screens (Overview, Maps, Health), settings panel open/close. |
| `effects.js` | Visual effects (cursor trail, glass). |
| `radar.js` | Maps screen: Leaflet map, lightning, PMD radar, satellite, zoom limits; starts the forecast map. |
| `forecast.js` | Forecast map layers: colours, wind particles, timeline, layer rail with dropdowns, popups. |
| `pipeline/build_forecast.py` | The Python script that turns ECMWF files into map data. |
| `pipeline/requirements.txt` | Exact Python package versions for the pipeline. |
| `.github/workflows/forecast-data.yml` | The GitHub schedule that runs the pipeline every 3 hours. |
| `.gitignore` | Keeps private/local stuff out of git (`.openai/`, `atmos-weather/`, `test.txt`, `forecast-out/`, `.wrangler/`, Python caches). |
| `.openai/`, `atmos-weather/`, `test.txt` | **Private / old.** Never deploy or commit these. |

---

## 4. The website (wapk.pages.dev)

- **Name:** WAPK — Weather Alert PK (renamed from "Atmos" on 21 Oct 2026; some internal names like `window.Atmos` and the
  `atmos.preferences.v1` storage key were kept on purpose so saved settings keep working).
- **Hosting:** Cloudflare Pages project **`wapk`**, account mashhood.droid.
- **Address:** https://wapk.pages.dev
- **Type:** static files only. No build step, no framework. Leaflet 1.9.4 for the map.
- **The fourteen files that get deployed:** `index.html, app.js, effects.js, icons.js, forecast.js, radar.js, views.js,
  styles.css, radar.css, weather-logic.js, health.js, borders.json, pointforecast.js, wapk-logo.png`. **Nothing else.**

### Screens

| Screen | Shows | Data from |
|---|---|---|
| Overview | Current weather, next 24 h chart, week list, highlights (wind, humidity, UV, visibility, sunrise/sunset, air quality) | Open-Meteo + METAR |
| Hourly forecast | Hour by hour | Open-Meteo |
| This week | 7 days, tap a day for details (rain, wind, UV, day/night, storm strength, hail) | Open-Meteo |
| Maps | Forecast layers, satellite, PMD radar, lightning | Your map data, your worker, PMD |
| Health (`#healthView`) | Health alerts, air quality, pollen, dengue mosquito risk, heat/cold/UV | Open-Meteo, PMD pollen via your worker |

### Things the browser remembers (localStorage, per visitor)

| Key | Remembers |
|---|---|
| `atmos.preferences.v1` | Chosen place, saved cities, °C/°F, theme |
| `wapk.forecastMap` | Forecast on/off, chosen layer, last type per category, height, particles on/off |
| `wapk.lightningVisible` | Lightning on/off |

---

## 5. Where every piece of data comes from

| What you see | Source | How it reaches the browser | How fresh |
|---|---|---|---|
| **Forecast numbers** (Overview/Hourly/Week) | **Open-Meteo**, model **ECMWF IFS** (`models=ecmwf_ifs`) | Browser calls `api.open-meteo.com` directly | Open-Meteo updates as ECMWF runs arrive |
| Rain chance, visibility, UV, freezing level, 500 hPa temp & wind, lifted index | **Open-Meteo default model** (`best_match`) — ECMWF does not provide these | Second request, merged by time | Same |
| **Current conditions** near an airport | **Your METAR API** | Browser calls it directly | Used only if report < 90 min old and you are inside the airport's radius |
| Air quality | Open-Meteo Air Quality API | Direct | Hourly |
| City search | Open-Meteo Geocoding | Direct | — |
| "Current location" name | BigDataCloud reverse geocoding (free client endpoint) | Direct | — |
| **Forecast map layers** | **ECMWF IFS open data, raw GRIB2 files** — *not* Open-Meteo | Your pipeline → `wapk-forecast.pages.dev` | New run twice a day (00Z, 12Z) |
| Satellite | EUMETSAT Meteosat (Indian Ocean service, satellite at 45.5°E) | Your worker stores images in D1 | New image every 15 min, usually 30–50 min old |
| **Fires** | **NASA FIRMS** active fires — VIIRS (Suomi-NPP, NOAA-20, NOAA-21) and MODIS, public "South Asia 7d" CSV files (no key), last 72 h kept | Worker merges them every 30 min, serves `/api/fires` | Satellites pass ~1–2 AM and ~1–2 PM PKT; NASA publishes within ~3 h |
| PMD radar | PMD Flood Forecasting Division (ffd.pmd.gov.pk) | Worker proxies the list; images load straight from PMD | 10 min (sri, cappi01), hourly (rain12) |
| Lightning | Your lightning-alerts worker `/buffer` | Your PK worker stores in D1 | Every 5 min |
| **Pollen** (Health) | **PMD** — Islamabad: https://weather.gov.pk/rnd/pollen-data · Lahore: https://ffd.pmd.gov.pk/pollen | Worker reads both pages every 3 h, stores one report per station and PMD date, serves `/api/pollen` | Islamabad daily; Lahore daily during the pollen season |
| Health air quality | Open-Meteo Air Quality (CAMS) — AQI + pollutants, 4 days | Direct | Hourly |
| Health weather risks | Open-Meteo forecast with `past_days=14` | Direct | Hourly |
| Base map | Esri (dark grey canvas) / OpenStreetMap | Direct tiles | — |

**Key point:** both the forecast pages and the map use the **same ECMWF model**, but:
- Forecast pages → through **Open-Meteo's API** (interpolated to your exact point).
- Map → **raw ECMWF files you process yourself** (0.25° grid, about 25 km).

---

## 6. The forecast map pipeline (ECMWF → your map)

### Step by step

```
ECMWF open data (data.ecmwf.int)
   │  GRIB2 files, global, IFS 0.25°
   ▼
GitHub Actions (every 3 hours, ubuntu, Python 3.12)
   │  pipeline/build_forecast.py
   │   1. find newest 00Z/12Z run that reaches 168 h
   │   2. skip everything if that run is already published
   │   3. download 3 batches of GRIB2
   │   4. crop to 0–55°N, 25–110°E
   │   5. calculate extra fields (freezing level, humidity, totals…)
   │   6. pack every field+hour into a 1-byte-per-point .bin file
   │   7. write latest.json, _headers, 404.html, index.html
   ▼
npx wrangler pages deploy forecast-out --project-name wapk-forecast
   ▼
https://wapk-forecast.pages.dev  (latest.json + runs/<runId>/<field>/<step>.bin)
   ▼
Visitor's browser (forecast.js) downloads only what is on screen
```

### Model and coverage

| Setting | Value |
|---|---|
| Model | ECMWF IFS, open data, **0.25°** (CC-BY-4.0 licence) |
| Runs used | **00Z and 12Z only** (06Z/18Z stop at 90 h, too short for 7 days) |
| Length | **7 days (168 h)** |
| Steps | Every **3 h** from 0 to 144 h, then every **6 h** to 168 h → **53 steps** |
| Area | **0°N–55°N, 25°E–110°E** (Pakistan plus surroundings) |
| Grid | **341 × 221** points |
| New data appears | About **1 PM** and **1 AM** Pakistan time |

### What is downloaded (three batches)

| Batch | ECMWF parameters |
|---|---|
| Surface | `2t` temperature, `2d` dew point, `tp` total rain, `sf` snowfall, `sd` snow depth (water), `rsn` snow density, `10u/10v` wind, `msl` pressure, `tcc/lcc/mcc/hcc` clouds, `10fg` gusts, `mucape` CAPE, `ssrd` solar radiation, `tcwv` water vapour, `ptype` precipitation type, `tprate` precipitation rate |
| Pressure levels | `u`, `v` wind, `t` temperature, `r` humidity at **925, 850, 700, 500, 250 hPa** |
| Freezing level inputs | `t` temperature, `gh` height at **1000, 925, 850, 700, 600, 500, 400, 300 hPa** |

### The 40 fields that are published

| Field name | Meaning | Unit | How it is made |
|---|---|---|---|
| `temp` | Temperature at 2 m | °C | `2t` − 273.15 |
| `dew` | Dew point at 2 m | °C | `2d` − 273.15 |
| `rh` | Humidity at the surface | % | Calculated from temperature and dew point (Magnus formula) |
| `t925 … t250` | Temperature at each pressure level | °C | `t` − 273.15 |
| `r925 … r250` | Humidity at each pressure level | % | `r` |
| `u10, v10` | Wind at 10 m (east and north parts) | m/s | `10u`, `10v` |
| `u925 … v250` | Wind at each pressure level | m/s | `u`, `v` |
| `gust` | Wind gusts | m/s | `10fg` (step 0 has none, so step 3's is used) |
| `precip` | Rain rate | mm/h | Change in `tp` between steps ÷ hours |
| `rainacc` | Rain total since the run started | mm | `tp` × 1000 |
| `snowacc` | New snow since the run started | cm | `sf` × 1000 (≈ 1 cm snow per mm water) |
| `snowdepth` | Snow depth | cm | `sd` ÷ density (`rsn`, default 300) — glaciers cap at 1000 cm |
| `ptype` | Precipitation type: 1 rain, 2 mix, 3 snow, 4 freezing | category | `ptype`, only where `tprate` ≥ 0.1 mm/h |
| `cloud, lowcloud, midcloud, highcloud` | Cloud cover | % | `tcc`, `lcc`, `mcc`, `hcc` × 100 |
| `pressure` | Sea-level pressure | hPa | `msl` ÷ 100 |
| `cape` | Thunderstorm energy | J/kg | `mucape` |
| `freezing` | Freezing level height above sea level | m | Highest 0 °C crossing between the 8 levels; **0 = "at the ground"** wherever 2 m temperature ≤ 0 °C |
| `solar` | Sunlight reaching the ground (3-hour mean) | W/m² | Change in `ssrd` ÷ seconds |
| `tcwv` | Water vapour in the whole air column | mm | `tcwv` |

**Why no 900 hPa?** ECMWF has no 900 hPa level. 925 hPa (about 800 m) is the nearest.
**Why no visibility on the map?** Not in ECMWF's free data.

### The GitHub workflow

- **File:** `.github/workflows/forecast-data.yml`
- **Schedule:** `25 */3 * * *` → at 25 minutes past every 3rd hour (UTC).
- **Skip logic:** it reads https://wapk-forecast.pages.dev/latest.json. If its `runId` equals the newest run, it stops
  in about 15 seconds without publishing.
- **Full build:** about **10 minutes**.
- **Manual run:** GitHub → repo `wapk` → **Actions** → **Forecast map data** → **Run workflow**. Tick **force** to rebuild
  even if nothing new is out.
- **Python packages (pinned):** `ecmwf-opendata==0.3.35`, `eccodes==2.50.0`, `numpy==2.5.4`.

### FORMAT_VERSION (very important)

`FORMAT_VERSION` in `build_forecast.py` (currently **6**) is part of the run ID, e.g. `2026102412-v6`.

- Run files are cached in browsers for **a whole year** ("immutable").
- So if you ever change **which fields exist, their encoding, or the steps**, you **must** increase `FORMAT_VERSION`.
  Otherwise visitors could mix old cached files with new ones and see wrong values.
- Changing it also forces the next scheduled build to republish even if ECMWF has no new run.

| Version | What changed |
|---|---|
| 2 | Temperature range widened for upper levels |
| 3 | Added dew point, humidity, totals, snow, solar, cloud layers |
| 4 | Added water vapour and precipitation type |
| 5 | Precipitation type limited to where it is actually falling |
| 6 | 7-day forecast (53 steps) |

---

## 7. The map data file format

### `latest.json` — the index

Small JSON file. The map always reads this first (cached 5 minutes). Example parts:

```json
{
  "source": "ECMWF IFS open data",
  "model": "IFS 0.25°",
  "license": "CC-BY-4.0",
  "attribution": "Contains modified Copernicus/ECMWF open data. © ECMWF, CC-BY-4.0.",
  "run": "2026-10-24T12:00:00Z",
  "runId": "2026102412-v6",
  "generatedAt": "2026-10-25T05:24:20Z",
  "grid": { "north": 55, "west": 25, "step": 0.25, "nx": 341, "ny": 221 },
  "times": [1792843200, 1792854000, "... one Unix time per step"],
  "missing": 255,
  "fields": { "temp": { "encoding": "linear", "offset": -80, "scale": 0.5118, "unit": "°C" }, "...": "..." },
  "path": "runs/2026102412-v6/{field}/{step}.bin"
}
```

### `.bin` files — the data

- Path: `runs/<runId>/<field>/<step>.bin`, e.g. `runs/2026102412-v6/t850/12.bin`.
- **Exactly 75,361 bytes** (341 × 221). **One byte per grid point.** No header.
- Order: row by row, **north to south**, each row **west to east**.
- Byte **255 = missing**. Bytes **0–254 = a code**.
- Turning a code back into a value:
  - **linear:** `value = offset + code × scale`
  - **sqrt:** `value = (code × scale)²` — used for rain, CAPE, snow, rain total, so small amounts keep detail.

| Field group | Encoding | Range | Precision (one step) |
|---|---|---|---|
| Temperatures, dew point | linear | −80 to +50 °C | ≈ 0.5 °C |
| Wind (all levels) | linear | −100 to +100 m/s | ≈ 0.8 m/s |
| Gust | linear | 0–80 m/s | ≈ 0.3 m/s |
| Humidity, clouds | linear | 0–100 % | ≈ 0.4 % |
| Pressure | linear | 940–1060 hPa | ≈ 0.5 hPa |
| Freezing level | linear | 0–7000 m | ≈ 28 m |
| Solar | linear | 0–1200 W/m² | ≈ 5 W/m² |
| Water vapour | linear | 0–80 mm | ≈ 0.3 mm |
| Precipitation type | linear (scale 1) | 0–4 | exact category |
| Rain rate | sqrt | 0–100 mm/h | fine at low end |
| CAPE | sqrt | 0–8000 J/kg | fine at low end |
| Rain total | sqrt | 0–500 mm | fine at low end |
| New snow | sqrt | 0–300 cm | fine at low end |
| Snow depth | sqrt | 0–1000 cm | fine at low end |

### Other files on the data site

| File | Why it exists |
|---|---|
| `_headers` | Lets any site read the data (CORS); caches `latest.json` 5 min and run files 1 year; labels run files `text/plain` so Cloudflare compresses them (≈ 75 KB → 20–45 KB). |
| `404.html` | Without it, Cloudflare Pages answers missing files with the home page and status 200. The map needs a real 404 to know a run was replaced. |
| `index.html` | A tiny page saying what the site is, with the ECMWF credit. |

### Size

- One run: **≈ 2,120 files, ≈ 155 MB**.
- One layer, one hour, for a visitor: **≈ 20–45 KB** download.
- The map keeps up to 80 decoded files in memory and pre-loads the next 3 steps.

---

## 8. The backend worker (lightning-weatherx-pk-api)

| Setting | Value |
|---|---|
| Name | `lightning-weatherx-pk-api` |
| Address | https://lightning-weatherx-pk-api.mashhood-droid.workers.dev |
| Source | `D:\Test Weather webapp\worker\index.js` |
| Config | `D:\Test Weather webapp\worker\wrangler.jsonc` |
| Deploy command | `npx wrangler deploy` (run inside `D:\Test Weather webapp\worker`) |
| **Do NOT use** | `npm run cf:worker:deploy` — that deploys a *different* worker (`lightning-weatherx-api`, for Lightning Weather X) |
| Cron | `*/5 * * * *` — every 5 minutes |
| Database | D1 `lightning-pk-strikes` (binding `DB`, id `6d611c66-f3a0-4046-a384-e3e86bd5fdad`) |

### Routes

| Route | Returns | Used by |
|---|---|---|
| `GET /api/strikes` | Lightning strikes in Pakistan (last 24 h) | WAPK Maps |
| `GET /api/refresh` | Forces a strike refresh | — |
| `GET /api/search` | Place search | Lightning Weather X |
| `GET /api/weather-layers` | Old EUMETSAT layer list | **Lightning Weather X — keep it** |
| `GET /api/pmd-radar` | PMD radar list (manifest), cached 2 min | WAPK Maps |
| `GET /api/fires?hours=24\|48\|72` | Fires of the last 24, 48 or 72 h (default 24) in the map area: compact rows `[lat, lon, minutesSinceEpoch, frpMW, confidence 0/1/2, satelliteIndex, night]` (cached 10 min) | WAPK Maps |
| `GET /api/pollen` | `stations[]` (Islamabad, Lahore): latest report + up to 30 days of history each (cached 15 min). Top-level `latest`/`station`/`history` repeat Islamabad for older pages. | WAPK Health |
| `GET /api/satellite` | Satellite products, their stored times (`frames`) and image addresses | WAPK Maps |
| `GET /api/satellite/<product>?t=<time>` | One stored satellite image (cached 1 day in browsers) | WAPK Maps |

### Every 5 minutes the cron does

1. **Lightning:** fetch the lightning-alerts `/buffer`, keep strikes inside Pakistan from the last 24 h, store in D1.
2. **Satellite:** fetch up to **6** images (3 at a time) from EUMETSAT: newest first, then fill missing hourly images
   of the past 24 h; delete images older than 24 h.
4. **Fires:** if the snapshot is more than **30 minutes** old, download the 4 FIRMS 7-day files (≈ 3.2 MB), keep fires inside the
   map area from the last 72 h, and replace the snapshot.
3. **Pollen:** for each station (Islamabad, Lahore) whose last read is more than **3 hours** old, read its PMD page,
   store/replace that PMD date's report, delete reports older than **120 days**. One station failing doesn't stop the other.

### D1 tables (`lightning-pk-strikes`)

| Table | Holds |
|---|---|
| `strikes` | One row per strike (id, lat, lon, timestamp, raw JSON) |
| `ingest_runs` | A log of each strike refresh |
| `satellite_frames` | Satellite images: product, time, image bytes (key = product + time) |
| `fire_snapshot` | One row (`id = 'latest'`): `fetched_at` + JSON of all fires of the last 72 h (≈ 0.5–0.8 MB; D1's row limit is 2 MB) |
| `pollen_daily` | One PMD pollen report per station and date: `station`, `report_date` (key together), `label`, `fetched_at`, `data` (JSON: sites, types, notes, thresholds) |
| `pollen_reports` | **Old, unused** (first Islamabad-only version, 1 row). Safe to delete. |
| `satellite_images` | **Old, unused** (≈ 3 MB). Replaced by `satellite_frames`. Safe to delete. |

**Earlier worker versions** are in git history (`git log -- worker/`). Commit worker changes like any other file.

---

## 9. Satellite images

- **Source:** EUMETSAT View service (`view.eumetsat.int`), **Meteosat Indian Ocean Data Coverage** (`msg_iodc`), satellite
  at 45.5°E.
- **New image every 15 minutes.** EUMETSAT publishes it about **25–35 minutes** after the scan, so what you see is usually
  **30–50 minutes old**. That delay is EUMETSAT's, not yours.
- **Why the worker stores them:** EUMETSAT draws each picture on request and takes 10–60 seconds. The worker fetches once
  and everyone gets the stored copy instantly.
- **History:** last **24 hours** are kept. Backfill of a fresh table takes about 5 hours; after that, every 15-minute image
  is kept.
- **Picture:** one image covering the whole map area, 2048 px wide, Web Mercator (lines up with the map exactly).
  JPEG (PNG for rain rate), 150–480 KB each. Areas with no data are painted black and blended away on the dark map.

| Product id | Name in the dropdown | Note |
|---|---|---|
| `ir108` | Infrared | Cloud tops, day and night |
| `vis006` | Visible | Daylight only |
| `wv062` | Water vapour | Moisture high in the atmosphere |
| `natural` | Natural colour | Daylight only |
| `airmass` | Airmass | Air masses and jet streams |
| `dust` | Dust | Dust shows pink to magenta |
| `convection` | Convection | Strong storms bright yellow; daylight only |
| `rain` | Rain rate | Satellite rain estimate (H SAF) |

**Satellite bar** (top of the map when Satellite is on): drag to any stored time; **Play** steps through the past day hour
by hour (waiting for each image to load), holds on the newest, then loops.

---

## 9b. Active fires (NASA FIRMS)

- **What:** hotspots detected by satellites' heat sensors — in Pakistan mostly **crop-residue burning** (Oct–Nov and
  Apr–May, the main cause of Punjab smog), plus forest/brush fires and industrial heat (e.g. gas flares).
- **Source:** NASA FIRMS public files (no account key needed):
  - `suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_South_Asia_7d.csv` (VIIRS S-NPP, 375 m)
  - `noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_Asia_7d.csv` (VIIRS NOAA-20)
  - `noaa-21-viirs-c2/csv/J2_VIIRS_C2_South_Asia_7d.csv` (VIIRS NOAA-21)
  - `modis-c6.1/csv/MODIS_C6_1_South_Asia_7d.csv` (MODIS Terra/Aqua, 1 km)
  all under `https://firms.modaps.eosdis.nasa.gov/data/active_fire/`.
- **Coverage:** FIRMS "South Asia" region ≈ **54–102°E, 6–40°N** (Pakistan, India, Afghanistan, eastern Iran, Nepal,
  Bangladesh…). The western and northern parts of the map (Arabia, Turkey, Central Asia) have no fire data.
- **Freshness:** each satellite passes about twice a day (≈ 1–2 AM and 1–2 PM PKT); NASA publishes within ~3 hours.
  So the newest fire is usually 3–12 hours old.
- **On the map:** **Fires** button in the rail (off by default; remembered in `wapk.firesVisible`), with a
  **Last 24 / 48 / 72 hours** dropdown under it (remembered in `wapk.firesHours`; each choice asks the worker for
  `?hours=`). Each fire is a dot: size = fire radiative power (strength, MW), colour = age (red < 6 h, orange 6–12 h,
  yellow 12–24 h, tan 1–2 days, grey 2–3 days), faint = low confidence. Under the button: count + colour key. Click a fire: time seen, day/night pass, satellite, strength,
  confidence. Typical: ~4,000–4,500 fires in the area in 24 h in late October, ~2,400 in Pakistan; ~12,000 in 72 h.
- **Why the 24 h count sometimes drops a lot:** the window counts back from *now*. Most crop fires are seen on the
  afternoon passes (~12–2 PM PKT). If NASA is late publishing today's passes, yesterday's afternoon fires pass 24 h
  before new ones arrive and only night detections are left (e.g. 28 Oct 2026: 685 instead of ~4,400). Pick 48 h or
  72 h to still see them; the count recovers within 30 min of NASA publishing.
- **Layering:** fires have their own canvas pane at z-index **410** — above Leaflet's overlay pane (400), whose full-map
  canvas would otherwise swallow fire clicks. Clicks between fires still open the forecast popup.
- **Not part of the forecast/satellite switching rule:** fires are dots, like lightning, and stay on with any layer.
- **More history or a key:** the 7d files hold up to 7 days; raising the 72 h limit (`FIRE_MAX_AGE_MS`,
  `FIRE_WINDOWS_HOURS` in the worker and radar.js) would grow the snapshot towards D1's 2 MB row limit. A free FIRMS
  MAP_KEY would allow the area API and WMS, but isn't needed now.

---

## 10. PMD radar

- **Source:** PMD Flood Forecasting Division public mirror. PMD has allowed this use (confirmed by you, 21 Oct 2026).
- **List:** `https://ffd.pmd.gov.pk/radar/manifest` — it has no CORS header, so the worker fetches it for the browser.
- **Images:** 360 × 360 PNGs from `https://ffd.pmd.gov.pk/storage/radar/…`, loaded **directly from PMD**.
- **Sites:** Islamabad and Karachi.
- **Products:** `sri` (every 10 min, 450 km), `cappi01` (every 10 min, 200 km), `rain12` (hourly).
- **Status rule:** if any product of a radar is still updating → "running, no rain showing". If every product stopped →
  "offline since <time>". Never guess "last rain" from images. **You know the real radar status — PMD outages are common.**
- PMD developer contact shown on their page: usman.ali.pmd@gmail.com.

---

## 11. Lightning strikes

- **Upstream:** `https://lightning-alerts.mashhoodiqbal493.workers.dev/buffer` (your lightning-alerts worker). Returns
  strikes as `[lat, lon, epochMs]`.
- **The PK worker** keeps only strikes inside Pakistan from the last 24 hours, stores them in D1, and serves them at
  `/api/strikes`.
- **On the map:** monitoring radius, strike markers, stats cards below the map (cached 24 h, selected window, within radius,
  nearest). Lightning can be hidden with the **Lightning** button; the choice is remembered.

---

## 12. METAR (live airport weather)

- **API:** `https://travel-weather-api.mashhood2717.workers.dev` (your own worker; source is not in this project).
- WAPK calls `/pakistan-metar` and `/worldwide-metar` and picks the nearest airport.
- **Rule:** if you are inside that airport's radius (its own radius field, else 30 km) **and** the report is under
  **90 minutes** old, the METAR **replaces** the current conditions on the Overview. Otherwise the forecast is used and the
  card names the nearest airport.
- **Known API bugs that `app.js` works around:**
  - `/worldwide-metar` has no Pakistani airports; `/nearest-airport` only answers inside the 30–40 km radius.
  - `flight_category` is always "VFR" for international stations → WAPK calculates it from ceiling and visibility.
  - Gusts are dropped → WAPK reads them from the raw METAR text.
  - "9999"/CAVOK become 9.654 km → shown as "10+ km".
  - `observed` is an ISO string for Pakistan but Unix seconds for international stations.
- **Hail from METAR:** a report containing `GR` or `GS` adds "with possible hail".

---

## 13. Thunderstorm, hail and fog rules

**Source:** your Flutter app, `D:\Last stable build codes\weather_app\lib\services\weather_controller.dart` and
`WEATHER_LOGIC.md`. Ported to `weather-logic.js` with **identical thresholds**. If you change them in the app, change them
here too.

**Data needed** (Open-Meteo): ECMWF IFS for weather code, precipitation, cloud, CAPE, temperature; `best_match` for
precipitation probability, lifted index, freezing level, 500 hPa temperature and wind, visibility; plus the grid cell's
`elevation`.

### For each hour

1. **Temperature fix:** snow above 4 °C → rain; 2–4 °C → sleet; rain at ≤ 0 °C → snow; freezing codes above 2 °C → normal.
2. **Three doors — at least one must open for a storm to be possible:**
   - **Rain door:** probability > 25 % **and** rain > 1 mm
   - **Instability door:** probability > 50 % **and** rain ≥ 0.1 mm **and** lifted index ≤ −3 **and** CAPE ≥ 2000
   - **Amount door:** rain > 3 mm
   - All shut + the model said storm → shown as rain by amount (≥ 4 heavy, ≥ 1 moderate, > 0.1 light) or sky from cloud.
   - All shut + no storm from the model → model's code unchanged.
3. **Is it really convective?** (any one)
   - Model said storm **and** CAPE ≥ 500
   - Probability > 30 % **and** ((LI ≤ −4 and CAPE ≥ 1000) or (LI ≤ −3 and CAPE ≥ 2000))
   - Rain code **and** (rain > 0.5 mm or probability > 50 %) **and** CAPE ≥ 500
4. **Tier by amount** (amount picks the row, storm picks the column):

| Rain in the hour | Storm | Not a storm |
|---|---|---|
| ≤ 1 mm | 95 Isolated thunderstorm | 61 Light rain |
| 1–3 mm | 96 Scattered thunderstorms | 63 Moderate rain |
| 3–4 mm | 97 Thunderstorms | 63 Rain |
| > 4 mm | 99 Heavy thunderstorms | 65 Heavy rain |

5. **Overcast fix:** cloud ≥ 90 % with code 1 or 2 → 3 (overcast).
6. **Fog from visibility** (only if the hour is clear/cloudy): ≤ 1000 m Mist (44), ≤ 500 m Fog (45), ≤ 200 m Dense fog (46),
   < 50 m Very dense fog (47).

### Hail (same hour)

Hail is possible when the hour is a storm (95/96/97/99) **and all three** hold:

| Test | Threshold | Why |
|---|---|---|
| Warm layer = freezing level − ground elevation | **≤ 4200 m** | Deeper warm air melts the stone |
| Temperature at 500 hPa | **≤ −4 °C** | Cold enough aloft for ice to grow |
| 500 hPa wind (shear proxy) | **≥ 17 kt** | Updraft can organise |

Fitted to three confirmed hail events in Sep 2026 (Samana/Hangu, Nowshera, Malam Jabba area) — provisional.

### Storm strength badge (from CAPE)

| CAPE (J/kg) | Badge |
|---|---|
| < 500 | none |
| 500–1000 | Light |
| 1000–2500 | Moderate |
| 2500–3500 | Strong |
| ≥ 3500 | Severe |

### For each day

- **Meaningful-rain gate:** rain only headlines the day if (≥ 3 rain hours **and** max probability ≥ 10 % **and**
  total ≥ 1 mm) **or** total > 2 mm.
- **Headline:** any storm hour wins by severity; otherwise the most frequent rain/snow/fog code; otherwise clear vs cloudy
  from **average cloud cover** (< 20 % clear, < 50 % mostly clear, < 80 % partly cloudy, else overcast).
- **24-hour re-tier** when the headline is rain or storm: ≤ 7 mm → 95/61, 7–14 → 96/63, 14–25 → 97/63, > 25 → 99/65.
  A storm day = any storm hour, **or** the model flagged storms and max probability > 25 % and total ≥ 1 mm.
- **Day vs night:** hours strictly between sunrise and sunset are "day".
- **Hail chip** if any hour of the day passed the hail test.

### Where it shows on WAPK

- Hourly strip and week list: blue **Hail** tag.
- Day details: storm badge, Day/Night conditions, "Storm energy · CAPE", "Hail: Possible in storms".
- Current conditions: "… with possible hail"; summary warns if hail is expected later today.

**One difference from the app:** the app judges *current* conditions with the day's first hour (midnight). WAPK uses the
current hour.

---

## 13b. Health section

Opened from **Health** in the sidebar (address `#healthView`). Code: `health.js`. Everything is for the chosen place.

**Layout** (compact, fits one desktop screen): a strip of four summary tiles (Air quality · Pollen · Top disease risk ·
Heat & UV today) → a tabbed panel (**Diseases · Air · Pollen · Week**, the last tab used is remembered in
`wapk.healthTab`) with the **Alerts** list beside it (on narrower screens the alerts sit above the panel). Tapping a tile
opens its tab. Alerts are one line each — tap for details and advice; more than 4 hide behind "Show N more". The
Diseases tab lists Moderate-and-up risks with coloured dots for 7 days; low risks hide behind a button. Pollen hides
undetected types in one line. The week is shown as columns (days across).

### Cards

| Card | What it shows | Source |
|---|---|---|
| **Health alerts** | Every alert for today + next 2 days, worst first. The same alert on several days is one card ("Today, Tomorrow, Friday"). | All of the below |
| **Air quality** | US AQI dial + category + advice; PM2.5, PM10, O₃, NO₂, SO₂, CO, dust (µg/m³); highest AQI each of 4 days | Open-Meteo Air Quality (CAMS) |
| **Pollen allergy** | Station switch (nearest first: Islamabad / Lahore); each pollen type with PMD's level (Absent/Low/Moderate/High/Very high), count, 14-day trend; PMD's notes; thresholds on hover; a warning when PMD hasn't published for > 3 days | PMD via `/api/pollen` |
| **Seasonal disease risks** | 8 weather-related illnesses: today's level + 7-day strip each, sorted by risk. Tap one for why (factor meters), symptoms and prevention. | Calculated from Open-Meteo weather, air quality and PMD pollen |
| **Heat, cold and UV** | 7 days: feels-like low/high, UV max, rain | Open-Meteo |

### PMD pollen — details

Two stations. The card opens on the one nearest the chosen place.

**Islamabad** — PMD Research & Development, pollen monitoring

- Page: https://weather.gov.pk/rnd/pollen-data — "Islamabad Pollen Count (Last 24 Hours)".
- The numbers are written into the page's script as `rows.push({ type: "Grasses", 'H-8': "24", 'E-8': null, …, category: "High" })`,
  the sampling sites in `const ALL_COLS = ['H-8','E-8','G-6','F-10']`, the date in "Last Updated: October 27, 2026".
  The worker's `parsePmdPollen()` reads exactly these three things. **If PMD redesigns the page, this is what breaks** —
  the worker logs "pollen refresh failed" and the Health card keeps showing the last stored report.
- PMD's own JSON endpoint (`/rnd/pollen-data/ajax-data?month=…`) returned empty rows when tested, so the page is used.
- Sampling sites are Islamabad sectors **H-8, E-8, G-6, F-10**; on 27 Oct 2026 only H-8 reported.
- Pollen types seen: Acacia, Alternaria (a mould spore), Cannabis, Dandelion, Eucalyptus, Grasses, Paper Mulberry, Pines.
  Paper mulberry is Islamabad's big spring allergy cause (Feb–April).
- **Levels are PMD's own** (each pollen type has its own thresholds) — WAPK does not recalculate them.
- History builds by one report per PMD day (trend shows "building" until there are 2).

**Lahore** — PMD Flood Forecasting Division (FFD)

- Page: https://ffd.pmd.gov.pk/pollen — "Pollen Count — Lahore City", Burkard volumetric spore trap, updated daily
  **during the pollen season** (spring and autumn; outside it the last count stays up — e.g. 7 Oct 2026 on 28 Oct).
- Plain HTML. The worker's `parseFfdPollen()` reads: "Sample: <strong>06 Oct 2026</strong> … Analysis: 07 Oct 2026"
  (the report date is the analysis date), the `pollen-table` rows (type / count / category badge), the "Notes:" line, and
  the "Category Thresholds" table.
- PMD's Lahore thresholds (grains/m³, Low / Moderate / High): Paper Mulberry, Acacia, Eucalyptus, Pines ≥ 1 / 14 / 90;
  Grass ≥ 1 / 5 / 20; Alternaria ≥ 1 / 6500 / 13000; Dandelion, Cannabis ≥ 1 / 10 / 50. Absent = 0.

**Both**

- **Pollen alerts (and the pollen part of the asthma risk) only use a station within 150 km whose latest count is at most
  3 days old.** Farther away or older, the card still shows the count with a distance or "not updated for N days" note.

### Seasonal disease risks — how each is calculated

There is **no open feed of disease cases** in Pakistan (NIH and provincial health departments publish PDFs/dashboards).
So WAPK estimates how favourable the **conditions** are for each illness, per day, from the weather (with the past 14 days),
air quality and PMD pollen. Levels: **Low · Moderate · High · Very high**. The card says clearly these are estimates.

**1. Dengue** (Aedes mosquitoes; points 0–8)

| Factor | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Daily mean temperature | < 16 °C | 16–20 °C | 20–24 °C (or 32–35 → 2, > 35 → 1) | 24–32 °C (ideal) |
| Daily mean humidity | < 50 % | 50–70 % | ≥ 70 % | |
| Rain in the previous 14 days | < 5 mm | 5–25 mm | ≥ 25 mm | |
| Season Aug–Nov | other months | Aug–Nov | | |

0–2 Low · 3–4 Moderate · 5–6 High · 7–8 Very high. Mean below 16 °C → Low.

**2. Malaria** (Anopheles mosquitoes; points 0–8)

| Factor | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Daily mean temperature | < 16 °C | 16–20 °C | 20–25 °C (or 30–33 → 2, > 33 → 1) | 25–30 °C (ideal) |
| Daily mean humidity | < 50 % | 50–60 % | ≥ 60 % | |
| Rain in the previous 14 days | < 10 mm | 10–40 mm | ≥ 40 mm | |
| Season Jul–Nov | other months | Jul–Nov | | |

0–2 Low · 3–4 Moderate · 5–6 High · 7–8 Very high. Mean below 16 °C → Low. **No rain pools (< 10 mm) → at most Moderate.**

**3. Diarrhoea, cholera & typhoid** (water-borne; points 0–7)

| Factor | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Daily maximum temperature | < 25 °C | 25–32 °C | 32–38 °C | ≥ 38 °C |
| Rain in the last 3 days (incl. today) | < 5 mm | 5–20 mm | 20–50 mm | ≥ 50 mm (flooding) |
| Season May–Sep | other months | May–Sep | | |

0–1 Low · 2–3 Moderate · 4–5 High · 6–7 Very high.

**4. Flu, colds & pneumonia** (points 0–6)

| Factor | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Daily mean temperature | ≥ 20 °C | 15–20 °C | 10–15 °C | < 10 °C |
| Day–night swing (max − min) | < 15 °C | ≥ 15 °C | | |
| Dry air (mean humidity) | ≥ 40 % | < 40 % | | |
| Season Nov–Feb | other months | Nov–Feb | | |

0–1 Low · 2–3 Moderate · 4–5 High · 6 Very high.

**5. Asthma & breathing problems** (points 0–8; no alert of its own — AQI, dust and pollen alerts cover it)

| Factor | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Day's highest US AQI | ≤ 100 | 101–150 | 151–200 | > 200 |
| Dust | < 200 µg/m³ | ≥ 200 | ≥ 500 | |
| PMD pollen (nearby, fresh, today/tomorrow only) | below High | High | Very high | |
| Cold dry air (min ≤ 5 °C and humidity < 40 %) | no | yes | | |

0–1 Low · 2 Moderate · 3–4 High · 5+ Very high.

**6. Heatstroke & dehydration** (no alert of its own — heat alerts cover it): feels-like max < 35 Low · 35–41 Moderate ·
41–54 High · ≥ 54 Very high (NOAA heat index).

**7. Pink eye & skin infections** (monsoon): mean ≥ 25 °C & humidity ≥ 60 % Moderate · ≥ 28 °C & ≥ 70 % High ·
≥ 30 °C & ≥ 80 % Very high; one level higher after ≥ 20 mm rain in 3 days.

**8. Carbon monoxide (gas heaters / angeethis)**: night low ≤ 5 °C Moderate · ≤ 0 °C High · ≤ −5 °C Very high.

**Alerts:** dengue, malaria, water-borne, flu, pink eye and carbon monoxide raise an alert at High (moderate severity) or
Very high (high severity).

### Alert rules (today + next 2 days)

| Alert | Trigger | Severity |
|---|---|---|
| Extreme heat danger | Feels-like max ≥ 54 °C | severe |
| Heatstroke danger | Feels-like max ≥ 41 °C | high |
| Heat caution | Feels-like max ≥ 35 °C | moderate |
| Severe cold | Feels-like min ≤ −10 °C | high |
| Freezing night | Min temperature ≤ 0 °C | moderate |
| Extreme UV | UV max ≥ 11 | high |
| Very high UV | UV max ≥ 8 | moderate |
| Air quality | Day's highest US AQI > 100 (101–150 moderate, 151–300 high, > 300 severe) | as listed |
| Dust storm conditions / Dusty air | Dust ≥ 500 / ≥ 200 µg/m³ | high / moderate |
| Smog / Fog | Visibility < 1 km (smog if AQI > 150 too) | high / moderate |
| Thunderstorms (with possible hail) | Day's classified code is a storm (section 13); hail or severe strength → high | moderate / high |
| Disease risks (dengue, malaria, water-borne, flu, pink eye, carbon monoxide) | High / Very high | moderate / high |
| Pollen high / very high | Any type High / Very high in the nearest PMD count (within 150 km, ≤ 3 days old) | moderate / high |

Heat bands follow the NOAA heat index; AQI bands are the US EPA's.

---

## 14. The Maps screen: how it behaves

### Layout

- **Top left:** Settings, Fullscreen.
- **Top centre:** satellite time bar (only while Satellite is on). On phones it sits under the Settings row.
- **Right side rail** (bottom strip on phones):
  - **Forecast** master button.
  - **9 categories**, each with a type dropdown under it when active:

| Category | Types |
|---|---|
| Wind | Wind speed, Gusts |
| Temperature | Temperature, Dew point, Freezing level |
| Humidity | Relative humidity, Water vapour |
| Rain | Rain rate, Rain total, Precipitation type |
| Storms | Thunderstorm potential (CAPE) |
| Snow | New snow, Snow depth |
| Clouds | Total, Low, Medium, High |
| Solar | Solar radiation |
| Pressure | Sea-level pressure (with isobars every 4 hPa) |

  - **Particles** (animated wind) + **height picker**: Surface, 925 hPa (≈ 800 m), 850 (≈ 1.5 km), 700 (≈ 3 km),
    500 (≈ 5.5 km), 250 hPa (≈ 10 km, jet stream). Wind, Temperature and Humidity follow the height.
  - **Lightning**, **Radar**, **Satellite** + satellite product dropdown.
- **Bottom:** forecast timeline (7 days, play button; plays in 3-hour jumps). Legend bottom-left (top on phones).
- **Below the map:** lightning statistics.

### Switching rule (you asked for this)

- Turning on **Satellite**, choosing a **satellite product**, or turning on **Radar** → **forecast colours switch off**.
- Choosing a **forecast category or type** → **Satellite and Radar switch off**.
- The **Forecast** master button is the **manual override**: pressing it does *not* switch anything off. To see both,
  turn on satellite/radar first, then press Forecast.

### Zoom and area

- The map cannot pan or zoom out beyond **0–55°N, 25–110°E** (the data area), so nothing blank shows.
- Click anywhere for a popup: temperature, humidity, dew point, wind (at the chosen height), gusts, rain, precipitation
  type, water vapour, clouds, pressure, CAPE, freezing level, snow depth.

### Map layer stacking (bottom to top)

Base map → forecast colours (300) → satellite (320) → PMD radar (350) → wind particles (380) → **borders (385)** →
place labels (390) → Leaflet overlays (400) → fires (410) → markers.

### Borders (like Windy)

- Drawn by `radar.js` from `borders.json`, on their own canvas pane (z-index 385) **above the forecast colours and
  wind**, so they stay readable on every layer (the base map's own borders fade under the colours).
- Style: thin light line (1.15 px) over a soft dark halo (3.4 px) in dark theme; dark navy line with a white halo in
  light theme. Coastlines come from the same country outlines.
- **Pakistan's provinces** (Punjab, Sindh, KP, Balochistan, Gilgit-Baltistan, AJK, Islamabad) are dashed and fainter,
  shown from zoom 5.
- **Data:** Natural Earth 1:10m, public domain. Countries use Natural Earth's **Pakistan point-of-view** file
  (`ne_10m_admin_0_countries_pak`), so Kashmir is drawn as Pakistan shows it. The province data predates 2018, so
  `build_borders.py` removes the old FATA–KP line (FATA merged into KP).
- Rebuild: download `ne_10m_admin_0_countries_pak.geojson` and `ne_10m_admin_1_states_provinces.geojson` from
  github.com/nvkelso/natural-earth-vector (geojson folder), run
  `python pipeline/build_borders.py <countries> <provinces> borders.json`, and bump `BORDER_FILE`'s `?v=` in `radar.js`.

---

## 15. Schedules: what runs when

| What | When | Where |
|---|---|---|
| ECMWF new run available (00Z / 12Z) | ≈ 07:40–08:00 UTC and 19:40–20:00 UTC (≈ 1 PM / 1 AM PKT) | ECMWF |
| Map data check/build | Every 3 hours at :25 UTC | GitHub Actions |
| Lightning + satellite fetch | Every 5 minutes | Cloudflare Worker cron |
| PMD pollen pages read (Islamabad, Lahore) | Every 3 hours each (first cron run after 3 h) | Cloudflare Worker cron |
| NASA FIRMS fire files | Every 30 minutes | Cloudflare Worker cron |
| PMD radar list cache | 2 minutes in the worker; browser refreshes every 5 min | Worker / browser |
| Satellite list refresh in browser | Every 5 minutes | Browser |
| Lightning auto-refresh in browser | Every 15 minutes (if on) | Browser |
| Forecast map `latest.json` re-check | Every 30 minutes while Maps is open | Browser |

---

## 16. Costs and free-tier limits

**Everything is currently free.**

| Service | Free limit | Your use |
|---|---|---|
| Cloudflare Pages (`wapk`, `wapk-forecast`) | Unlimited bandwidth & requests; 20,000 files per deploy; 25 MB per file | ≈ 2,120 files per data deploy |
| Cloudflare Workers | 100,000 requests/day | Cron 288 runs/day + visitor requests |
| Cloudflare D1 | 5 GB storage, 5 M rows read/day, 100 k rows written/day | Satellite ≈ 270 MB for 24 h; strikes small |
| GitHub Actions (private repo) | 2,000 minutes/month | ≈ 600–750 min/month (2 full builds/day × ~10 min + quick checks) |
| ECMWF open data | Free, CC-BY-4.0 (credit required — shown on the map) | 2 runs/day |
| EUMETSAT View | Free | ≈ 32–72 image requests/hour |
| Open-Meteo | Free for **non-commercial** use (10,000 calls/day) | 2 calls per page load + air quality + search; Health adds 2 (weather + air quality) |
| PMD website | Public page | One read every 3 hours by the worker |
| NASA FIRMS | Public files, free | 4 files (≈ 3.2 MB) every 30 min |
| PMD | Permission given | Direct image loads |

**Watch out:** if WAPK becomes commercial, Open-Meteo needs a paid plan (or move the forecast pages to your own ECMWF data).

---

## 17. How to deploy each part

### A. The website

```bash
# 1. Check the account
npx wrangler whoami          # must say Mashhood.droid@gmail.com's Account

# 2. Copy ONLY the fourteen site files into an empty folder (never deploy the project folder itself)
mkdir C:\temp\wapk-dist
copy index.html app.js effects.js icons.js forecast.js radar.js views.js styles.css radar.css weather-logic.js health.js borders.json pointforecast.js wapk-logo.png C:\temp\wapk-dist\

# 3. Deploy
npx wrangler pages deploy C:\temp\wapk-dist --project-name wapk --branch main
```

**To test before going live:** use `--branch health-preview` (or any name) instead of `--branch main`. You get a private
preview address like `https://health-preview.wapk.pages.dev`; the live site is untouched until you deploy `main`.

**Before deploying a change:** bump the `?v=` number of every changed JS/CSS file in `index.html`
(e.g. `forecast.js?v=20261025-36` → `-37`). Otherwise browsers keep the old file.

### B. The map data

Normally **automatic** (GitHub). Manual options:

- GitHub → Actions → Forecast map data → Run workflow (tick **force** if needed).
- Or locally (needs Python with the pinned packages):

```bash
pip install -r pipeline/requirements.txt
python pipeline/build_forecast.py --out D:\wapk-build\out
npx wrangler pages deploy D:\wapk-build\out --project-name wapk-forecast --branch main
```

Build locally with temp files on D: (C: is nearly full) — set `TEMP` and `TMP` to a D: folder first.

### C. The worker

```bash
cd "D:\Test Weather webapp\worker"
npx wrangler deploy
# then commit and push the change
```

### D. Code backup to GitHub

```bash
cd "D:\Test Weather webapp"
git -c "safe.directory=D:/Test Weather webapp" add -A
git -c "safe.directory=D:/Test Weather webapp" commit -m "Describe the change"
git -c "safe.directory=D:/Test Weather webapp" push
```

The `-c safe.directory=…` part is needed because the `.git` folder is owned by another Windows user. (The GitHub sign-in
helper is set only for this repo, not globally.)

---

## 18. Common tasks (how do I…?)

**Add a new forecast map field**
1. In `build_forecast.py`: add the ECMWF parameter to the download list, add an entry to `FIELDS` (encoding + range),
   and `write(...)` it inside the step loop.
2. **Increase `FORMAT_VERSION`.**
3. In `forecast.js`: add a layer to `LAYERS` (label, type, unit, field, colour stops) and put it in a `GROUPS` category.
4. Bump `forecast.js?v=` in `index.html`, deploy the site, then run the workflow with **force**.

**Change the map area**
Edit `REGION` in `build_forecast.py`, `SATELLITE_REGION` in the worker, and `MAP_REGION` in `radar.js` — all three must
match. Bump `FORMAT_VERSION`.

**Change thunderstorm/hail thresholds**
Edit `weather-logic.js` (and the same numbers in the Flutter app so both agree). Bump `weather-logic.js?v=`.

**Add a satellite product**
Add it to `SATELLITE_PRODUCTS` in the worker (layer name from EUMETSAT's `msg_iodc` capabilities) and to the
`radarSatelliteProduct` dropdown in `index.html`.

**See if the map data is current**
Open https://wapk-forecast.pages.dev/latest.json → look at `run` and `generatedAt`.

**See if satellite is current**
Open https://lightning-weatherx-pk-api.mashhood-droid.workers.dev/api/satellite → each product's `time` and `frames`.

**See if pollen is current**
Open https://lightning-weatherx-pk-api.mashhood-droid.workers.dev/api/pollen → `latest.date` and `latest.label`.

**See if fires are current**
Open https://lightning-weatherx-pk-api.mashhood-droid.workers.dev/api/fires → `fetchedAt`, `count`.

**See worker logs live**
`npx wrangler tail lightning-weatherx-pk-api` (inside `D:\Test Weather webapp\worker`).

---

## 19. Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| Forecast map stuck on an old run | GitHub run failing | GitHub → Actions → open the red run. Token expired? Make a new Cloudflare token and update `CLOUDFLARE_API_TOKEN`. |
| Map layer button missing | Published data doesn't have that field yet | Run the workflow with **force**. Buttons hide themselves when data lacks a field. |
| Map shows odd values after a pipeline change | Forgot to bump `FORMAT_VERSION` | Bump it, rebuild with force. |
| "Authentication error 10000" on deploy | Wrangler logged into the wrong account | `npx wrangler logout` then `npx wrangler login` with mashhood.droid. |
| Satellite blank or "preparing" | Worker hasn't stored that product yet, or EUMETSAT slow | Wait 5–10 min; check `/api/satellite`. |
| Satellite history short | Table recently emptied | Fills in about 5 hours. |
| PMD radar not showing | Usually PMD offline or simply no rain | Check `https://ffd.pmd.gov.pk/radar/manifest` → `latest_at`. Don't debug code first. |
| Pollen card shows an old date | PMD hasn't updated (Lahore pauses outside the pollen season), or PMD changed its page | Compare with the PMD page (Islamabad https://weather.gov.pk/rnd/pollen-data, Lahore https://ffd.pmd.gov.pk/pollen). If it shows a newer date, check worker logs for "pollen station failed" and update `parsePmdPollen()` / `parseFfdPollen()`. |
| Site change not visible | Browser cache | Bump `?v=` in `index.html`; Ctrl+F5. |
| Current conditions show "Forecast model estimate" | No airport within radius or METAR older than 90 min | Normal behaviour. |
| Open-Meteo errors | Rate limit or outage | Wait; site shows a retry message. |
| Git says "dubious ownership" | `.git` owned by another Windows user | Use `git -c "safe.directory=D:/Test Weather webapp" …` |
| C: drive full | Leftover temp files / browser test profiles | Build with TEMP on D:; delete old temp folders. |

---

## 20. Rules and gotchas to never forget

1. **Deploy only the fourteen site files**, never the whole project folder (`.openai/` and `test.txt` are private).
2. **Always check `npx wrangler whoami`** shows mashhood.droid before deploying.
3. **Bump `?v=`** in `index.html` for every changed JS/CSS file.
4. **Bump `FORMAT_VERSION`** for any change to map fields, encodings or steps.
5. The data site **needs `404.html`** (the pipeline writes it — don't remove that code).
6. Python's default downloader is **blocked by Cloudflare** — the pipeline sends a `User-Agent`; keep it.
7. **Worker deploy:** `npx wrangler deploy` inside the repo's `worker\` folder — not `npm run cf:worker:deploy` in
   Lightning Weather X (that deploys a different worker).
8. **`/api/weather-layers` must stay** in the worker — Lightning Weather X uses it.
9. The worker's source of truth is `worker\` in this repo; `D:\Lightning Weather x\worker-pk` is an old copy.
10. Keep storm/hail thresholds **identical** between `weather-logic.js` and the Flutter app.
11. ECMWF has **no 900 hPa** and **no free visibility or official freezing level** — that's why 925 hPa and a calculated
    freezing level are used.
12. Only **00Z/12Z** ECMWF runs reach 7 days → map updates **twice a day**.
13. **ECMWF credit (CC-BY-4.0)** must stay on the map.
14. Open-Meteo is free only for **non-commercial** use.
15. Don't change **global git settings** on your PC (repo-local only).
16. Disease risks are **weather estimates**, never present them as case data. Health text is general guidance, not medical advice.
17. Pollen levels are **PMD's categories** — don't recalculate them; keep the PMD credit on the Health page.

---

## 21. Open items

(Run the `wrangler` commands below inside `D:\Test Weather webapp\worker`.)

- **Old D1 table `satellite_images`** (≈ 3 MB) is unused and can be dropped:
  `npx wrangler d1 execute lightning-pk-strikes --remote --command "DROP TABLE IF EXISTS satellite_images"`
- **Old D1 table `pollen_reports`** (1 row) is unused since Lahore was added:
  `npx wrangler d1 execute lightning-pk-strikes --remote --command "DROP TABLE IF EXISTS pollen_reports"`
- **Lightning Weather X site fixes** in `D:\Lightning Weather x\public` were never deployed (`npm run cf:pages:deploy`).
- **METAR API bugs** (section 12) could be fixed at the API itself if its source is available.
- **Possible future:** a "Thunderstorm & hail risk" map layer from the ECMWF grid (approximate — no probability or lifted
  index in the free data).
- GitHub warns that `ubuntu-latest` moves to Ubuntu 26 — the workflow should keep working; check the first run after.

---

## 22. Glossary

| Term | Meaning |
|---|---|
| **ECMWF** | European Centre for Medium-Range Weather Forecasts — makes the IFS model |
| **IFS** | ECMWF's global weather model |
| **00Z / 12Z** | Model start times in UTC (midnight / noon UTC = 5 AM / 5 PM PKT) |
| **Step** | Hours after the model start time |
| **GRIB2** | Standard compressed file format for weather model data |
| **hPa / pressure level** | Height measured by air pressure: 925 ≈ 800 m, 850 ≈ 1.5 km, 700 ≈ 3 km, 500 ≈ 5.5 km, 250 ≈ 10 km |
| **CAPE** | Energy available for rising air (thunderstorm fuel), J/kg |
| **Lifted index (LI)** | Stability; negative = unstable, ≤ −3 quite unstable |
| **Freezing level** | Height where temperature drops to 0 °C |
| **METAR** | Standard airport weather report |
| **Cloudflare Pages** | Free static website hosting |
| **Cloudflare Worker** | Small server code running on Cloudflare |
| **D1** | Cloudflare's database |
| **Cron** | A job that runs on a schedule |
| **Wrangler** | Cloudflare's command-line tool |
| **GitHub Actions** | GitHub's free scheduled computers that run the pipeline |
| **CORS** | Browser rule that decides which sites may read data from another site |
| **Leaflet** | The JavaScript map library |
| **Web Mercator** | The map projection used by web maps |

## Map: picker, point forecast, phone layout and app embed (29 Oct 2026)

- **Picker:** a draggable pin; its bubble shows the active layer's value and the wind at that point for the map's
  time and updates while dragging. Clicking the map moves it. Tapping the bubble opens the **point forecast**:
  7 days in 3-hour columns (icon, temperature, rain, wind, gusts) from `window.Atmos.fetchForecast` (ECMWF IFS via
  Open-Meteo, with the WAPK storm/hail rules). Tapping a column moves the map's time.
- **Top bar:** logo (links back to the weather) and a location search (Open-Meteo geocoding).
- **Start location:** the first visit asks for the visitor's location; later visits use it again if allowed.
  `?lat=…&lon=…` (optionally `&name=`) opens a given place.
- **Phones (≤ 760 px):** the map fills the screen; layers open from the round Layers button.
- **Embed for the WAPK app:** `https://wapk.pages.dev/?embed=1&lat=<lat>&lon=<lon>#mapsView` shows only the map.
  The Flutter app's map tab (`lib/screens/home_screen.dart`, `_updateWindy`) loads this instead of Windy.

## Satellite: Windy-style Infrared and Visible (29 Oct 2026)

- `radar.js` redraws the worker's stored Meteosat picture pixel by pixel (`SATELLITE_STYLES`, one colour per grey level):
  - **Infrared:** EUMETSAT's grey is linear in temperature (0 ≈ +30 °C, 254 ≈ −70 °C). Above +2 °C (ground, sea) is
    see-through; +2 to −42 °C goes grey → white, faint → solid; colder tops are coloured (light blue −50, blue −58,
    purple −64, red −70, yellow −76 °C). Legend "Cloud-top temperature" shows only with Infrared.
  - **Visible:** stretched and brightened (gamma 0.6); the dark night side fades out.
  - Other products (Natural colour, Water vapour, …) are drawn as before.
- The picker shows the infrared temperature under it ("Cloud top" or "Ground, no cloud").
- Tried and reverted: full-resolution EUMETSAT tiles when zoomed in, and pane-level opacity — they washed out
  infrared and changed brightness while zooming. Meteosat IODC visible is ~3–4 km per pixel over Pakistan; true 1 km
  detail would need the HRV channel from the EUMETSAT Data Store, processed ourselves.
