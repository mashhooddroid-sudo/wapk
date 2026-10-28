const UPSTREAM_STRIKES_ENDPOINT =
  "https://lightningbackend-production.up.railway.app/strikes";
const EUMETSAT_WMS_CAPABILITIES =
  "https://view.eumetsat.int/geoserver/ows?service=WMS&version=1.3.0&request=GetCapabilities";
const EUMETSAT_WMS_ENDPOINT = "https://view.eumetsat.int/geoserver/ows";
const EUMETSAT_PRECIP_LAYER = "msg_iodc:h63";
const EUMETSAT_PRECIP_STYLE = "msg_h60b_h63";
const EUMETSAT_CLOUD_LAYER = "msg_iodc:ir108";
const EUMETSAT_CLOUD_STYLE = "raster";

// Meteosat images for the WAPK map's satellite layer (EUMETSAT's Indian Ocean service, satellite at 45.5°E).
// EUMETSAT draws each picture on request, often taking 10–60 s, so the cron stores a whole-region image
// per product whenever a new 15-minute image appears, keeps the last 24 hours of them for the map's
// satellite timeline, and visitors are served the stored copies.
// The Lightning Weather X sites keep using /api/weather-layers.
const SATELLITE_CAPABILITIES = "https://view.eumetsat.int/geoserver/msg_iodc/ows?service=WMS&version=1.3.0&request=GetCapabilities";
const SATELLITE_WMS = "https://view.eumetsat.int/geoserver/ows";
const SATELLITE_REGION = { north: 55, south: 0, west: 25, east: 110 }; // Same area as the forecast map.
const SATELLITE_WIDTH = 2048;
// New images come first; spare fetches fill in the past 24 hours (hourly images) a few at a time.
const SATELLITE_FETCHES_PER_RUN = 6;
const SATELLITE_PARALLEL_FETCHES = 3;
const SATELLITE_HISTORY_MS = 24 * 60 * 60 * 1000;
const SATELLITE_STEP_MS = 15 * 60 * 1000;
const SATELLITE_TIMES_CACHE_MS = 4 * 60 * 1000;
const SATELLITE_MAX_BYTES = 1_900_000; // D1 rows hold at most 2 MB.
const SATELLITE_PRODUCTS = {
  ir108: { label: "Infrared", layer: "msg_iodc:ir108", format: "image/jpeg", note: "Cloud tops, day and night" },
  vis006: { label: "Visible", layer: "msg_iodc:vis006", format: "image/jpeg", note: "Daylight only" },
  wv062: { label: "Water vapour", layer: "msg_iodc:wv062", format: "image/jpeg", note: "Moisture high in the atmosphere" },
  natural: { label: "Natural colour", layer: "msg_iodc:rgb_natural", format: "image/jpeg", note: "Daylight only" },
  airmass: { label: "Airmass", layer: "msg_iodc:rgb_airmass", format: "image/jpeg", note: "Air masses and jet streams" },
  dust: { label: "Dust", layer: "msg_iodc:rgb_dust", format: "image/jpeg", note: "Dust shows pink to magenta" },
  convection: { label: "Convection", layer: "msg_iodc:rgb_convection", format: "image/jpeg", note: "Strong storms show bright yellow; daylight only" },
  rain: { label: "Rain rate", layer: "msg_iodc:h63", style: "msg_h60b_h63", format: "image/png", note: "Satellite rain estimate (H SAF)" },
};
let satelliteTimesCache = null;
const API_TIMEZONE_OFFSET = "+05:00";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CHECKPOINT_MS = 15 * 60 * 1000;
const CHECKPOINTS_PER_HOUR = 4;
const DEFAULT_REFRESH_INTERVAL_SECONDS = 15 * 60;
const DEFAULT_RETURN_LIMIT = 5_000;
const DEFAULT_AGGREGATE_LIMIT = 20_000;

// PK-only variant: store strikes inside Pakistan's bounding box only. Keeps the
// D1 well under the free write limit and the map relevant. (Rectangle, so it
// includes a sliver of the NW-India border — fine for a map.)
const PK_BBOX = { latMin: 23.0, latMax: 37.5, lonMin: 60.5, lonMax: 78.0 };

// PMD Flood Forecasting Division radar mirror. Its manifest has no CORS header, so the
// browser reads it through this worker; the frame images load straight from PMD.
const PMD_RADAR_MANIFEST = "https://ffd.pmd.gov.pk/radar/manifest";
const PMD_RADAR_IMAGE_PREFIX = "https://ffd.pmd.gov.pk/storage/radar/";
const PMD_RADAR_CACHE_MS = 2 * 60 * 1000;
// PMD's daily pollen counts for WAPK's Health section. Both pages are server-rendered, so the cron reads them every
// few hours and keeps one record per station and PMD date:
//   • Islamabad — PMD R&D pollen monitoring (weather.gov.pk), samplers in sectors H-8, E-8, G-6, F-10.
//   • Lahore — PMD Flood Forecasting Division (ffd.pmd.gov.pk), Burkard trap; updated during the pollen season.
// Active fires from NASA FIRMS (VIIRS on Suomi-NPP, NOAA-20, NOAA-21 and MODIS on Terra/Aqua), using the public
// "South Asia, last 7 days" CSV files, which need no account key. The cron keeps one merged, compact snapshot of the
// last 72 hours; /api/fires?hours=24|48|72 serves a window of it.
const FIRE_FEEDS = [
  { sat: "VIIRS S-NPP", url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_South_Asia_7d.csv" },
  { sat: "VIIRS NOAA-20", url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_Asia_7d.csv" },
  { sat: "VIIRS NOAA-21", url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-21-viirs-c2/csv/J2_VIIRS_C2_South_Asia_7d.csv" },
  { sat: "MODIS", url: "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_South_Asia_7d.csv" },
];
const FIRE_REFRESH_MS = 30 * 60 * 1000;
const FIRE_WINDOWS_HOURS = [24, 48, 72];
const FIRE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

const POLLEN_STATIONS = {
  islamabad: {
    name: "Islamabad", latitude: 33.6844, longitude: 73.0479,
    source: "PMD Research & Development, pollen monitoring", url: "https://weather.gov.pk/rnd/pollen-data",
    parse: (html) => parsePmdPollen(html),
  },
  lahore: {
    name: "Lahore", latitude: 31.5204, longitude: 74.3587,
    source: "PMD Flood Forecasting Division, Lahore", url: "https://ffd.pmd.gov.pk/pollen",
    parse: (html) => parseFfdPollen(html),
  },
};
const POLLEN_REFRESH_MS = 3 * 60 * 60 * 1000;
const POLLEN_HISTORY_DAYS = 120;
const POLLEN_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// Per-isolate copy of the last good manifest (the Cache API is not available on workers.dev).
let pmdRadarCache = null;

function inPakistan(lat, lon) {
  return (
    lat >= PK_BBOX.latMin &&
    lat <= PK_BBOX.latMax &&
    lon >= PK_BBOX.lonMin &&
    lon <= PK_BBOX.lonMax
  );
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/strikes") {
        return await handleStrikes(request, env, ctx);
      }

      if (url.pathname === "/api/refresh") {
        return await handleRefresh(request, env);
      }

      if (url.pathname === "/api/search") {
        return await handleSearch(url);
      }

      if (url.pathname === "/api/weather-layers") {
        return await handleWeatherLayers(env);
      }

      if (url.pathname === "/api/pmd-radar") {
        return await handlePmdRadar();
      }

      if (url.pathname === "/api/fires") {
        return await handleFires(env, url);
      }

      if (url.pathname === "/api/pollen") {
        return await handlePollen(env);
      }

      if (url.pathname === "/api/satellite") {
        return await handleSatelliteList(url, env);
      }

      if (url.pathname.startsWith("/api/satellite/")) {
        return await handleSatelliteImage(url.pathname.slice("/api/satellite/".length), url.searchParams.get("t"), env);
      }

      return jsonResponse({ success: false, error: "Not found" }, 404);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "request failed",
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return jsonResponse({ success: false, error: "Internal server error" }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      refreshFromUpstream(env, {
        force: true,
        reason: `cron:${controller.cron || "manual"}`,
      }),
    );
    ctx.waitUntil(refreshSatelliteIfDue(env));
    ctx.waitUntil(refreshPollenIfDue(env));
    ctx.waitUntil(refreshFiresIfDue(env));
  },
};

async function handleStrikes(request, env, ctx) {
  assertDb(env);
  const url = new URL(request.url);
  const refreshRequested = url.searchParams.get("refresh") === "1";

  if (refreshRequested || (await shouldRefresh(env))) {
    const refreshPromise = refreshFromUpstream(env, {
      force: refreshRequested,
      reason: refreshRequested ? "manual-query" : "stale-request",
    });

    if (refreshRequested) {
      await refreshPromise;
    } else {
      ctx.waitUntil(refreshPromise);
    }
  }

  const hours = clampNumber(Number(url.searchParams.get("hours") || 24), 1, 24, 24);
  const maxLimit = getAggregateLimit(env);
  const limit = clampNumber(
    Number(url.searchParams.get("limit") || DEFAULT_RETURN_LIMIT),
    1,
    maxLimit,
    DEFAULT_RETURN_LIMIT,
  );
  const cutoff = Date.now() - hours * HOUR_MS;
  const latestEndMs = await getLatestTimelineEndMs(env, cutoff);
  const timelineStartMs = latestEndMs - hours * HOUR_MS;

  const [dataResult, countResult, timeline] = await Promise.all([
    env.DB.prepare(
      `SELECT id, lat, lon, timestamp, timestamp_ms AS timestampMs
       FROM strikes
       WHERE timestamp_ms >= ?
       ORDER BY timestamp_ms DESC
       LIMIT ?`,
    )
      .bind(cutoff, limit)
      .all(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM strikes WHERE timestamp_ms >= ?")
      .bind(cutoff)
      .first(),
    buildTimelineFromDb(env, timelineStartMs, latestEndMs),
  ]);

  const data = (dataResult.results || []).map((row) => ({
    id: String(row.id),
    lat: Number(row.lat),
    lon: Number(row.lon),
    timestamp: String(row.timestamp),
    timestampMs: Number(row.timestampMs),
  }));

  return jsonResponse(
    {
      success: true,
      source: "cloudflare-d1",
      generatedAt: new Date().toISOString(),
      hours,
      checkpointMinutes: 15,
      count: data.length,
      returned: data.length,
      totalCached: Number(countResult?.count || 0),
      timeline,
      data,
      nearest: null,
    },
    200,
    { "Cache-Control": "public, max-age=20" },
  );
}

async function handleRefresh(request, env) {
  if (request.method !== "POST") {
    return jsonResponse(
      { success: false, error: "Use POST to refresh the strike database." },
      405,
      { Allow: "POST" },
    );
  }

  const result = await refreshFromUpstream(env, { force: true, reason: "manual-post" });
  return jsonResponse(
    {
      success: true,
      refreshed: true,
      storedCount: result.storedCount,
      upstreamCount: result.upstreamCount,
      purgedCount: result.purgedCount,
      latestTimestamp: result.latestTimestamp
        ? new Date(result.latestTimestamp).toISOString()
        : null,
    },
    200,
    { "Cache-Control": "no-store" },
  );
}

async function refreshFromUpstream(env, options = {}) {
  assertDb(env);
  const endpoint = env.STRIKES_ENDPOINT || UPSTREAM_STRIKES_ENDPOINT;
  const response = await fetch(endpoint, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Upstream strike feed returned ${response.status}`);
  }

  const payload = await response.json();
  let raw = Array.isArray(payload) ? payload : payload.data || payload.strikes || [];
  // The lightning-alerts /buffer returns strikes as [lat, lon, epochMs] arrays —
  // convert to the {lat, lon, timestamp} objects normalizeStrike expects.
  raw = raw.map((s) =>
    Array.isArray(s)
      ? { lat: s[0], lon: s[1], timestamp: new Date(s[2]).toISOString() }
      : s,
  );
  const cutoff = Date.now() - DAY_MS;
  const strikes = raw
    .map((item, index) => normalizeStrike(item, index, payload?.date || null))
    .filter(
      (strike) =>
        strike && strike.timestampMs >= cutoff && inPakistan(strike.lat, strike.lon),
    );

  let storedCount = 0;
  for (let index = 0; index < strikes.length; index += 40) {
    const batch = strikes.slice(index, index + 40).map((strike) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO strikes
          (id, lat, lon, timestamp, timestamp_ms, source_date, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        strike.id,
        strike.lat,
        strike.lon,
        strike.timestamp,
        strike.timestampMs,
        strike.sourceDate,
        strike.rawJson,
      ),
    );
    const results = await env.DB.batch(batch);
    storedCount += results.filter((result) => result.success).length;
  }

  const purge = await env.DB.prepare("DELETE FROM strikes WHERE timestamp_ms < ?")
    .bind(cutoff)
    .run();
  const latestTimestamp = strikes
    .map((strike) => strike.timestampMs)
    .sort((a, b) => b - a)[0];

  await env.DB.prepare(
    `INSERT INTO ingest_runs
      (reason, upstream_count, stored_count, latest_timestamp_ms)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(
      options.reason || "unknown",
      raw.length,
      storedCount,
      latestTimestamp || null,
    )
    .run();

  return {
    upstreamCount: raw.length,
    storedCount,
    purgedCount: purge.meta?.changes || 0,
    latestTimestamp: latestTimestamp || null,
  };
}

async function shouldRefresh(env) {
  const latestRun = await env.DB.prepare(
    "SELECT ran_at AS ranAt FROM ingest_runs ORDER BY ran_at DESC LIMIT 1",
  ).first();

  if (!latestRun?.ranAt) {
    return true;
  }

  const latestRunMs = Date.parse(`${latestRun.ranAt}Z`);
  if (Number.isNaN(latestRunMs)) {
    return true;
  }

  return Date.now() - latestRunMs > getRefreshIntervalSeconds(env) * 1000;
}

async function buildTimelineFromDb(env, startMs, endMs) {
  const checkpointCount = Math.ceil((endMs - startMs) / CHECKPOINT_MS);
  const buckets = [];
  const bucketByStart = new Map();

  for (let index = checkpointCount - 1; index >= 0; index -= 1) {
    const bucketEnd = endMs - index * CHECKPOINT_MS;
    const bucketStart = bucketEnd - CHECKPOINT_MS;
    const bucket = {
      start: new Date(bucketStart).toISOString(),
      end: new Date(bucketEnd).toISOString(),
      count: 0,
    };
    buckets.push(bucket);
    bucketByStart.set(bucketStart, bucket);
  }

  const result = await env.DB.prepare(
    `SELECT CAST((timestamp_ms / ?) AS INTEGER) * ? AS startMs,
            COUNT(*) AS count
     FROM strikes
     WHERE timestamp_ms >= ? AND timestamp_ms <= ?
     GROUP BY startMs`,
  )
    .bind(CHECKPOINT_MS, CHECKPOINT_MS, startMs, endMs)
    .all();

  for (const row of result.results || []) {
    const bucket = bucketByStart.get(Number(row.startMs));
    if (bucket) {
      bucket.count = Number(row.count || 0);
    }
  }

  return buckets.slice(-(24 * CHECKPOINTS_PER_HOUR));
}

async function getLatestTimelineEndMs(env, fallbackCutoff) {
  const latest = await env.DB.prepare(
    "SELECT timestamp_ms AS timestampMs FROM strikes WHERE timestamp_ms >= ? ORDER BY timestamp_ms DESC LIMIT 1",
  )
    .bind(fallbackCutoff)
    .first();
  const anchorMs = Number(latest?.timestampMs) || Date.now();
  return Math.floor(anchorMs / CHECKPOINT_MS) * CHECKPOINT_MS + CHECKPOINT_MS;
}

async function handleWeatherLayers(env) {
  const [precipitation, clouds] = await Promise.allSettled([
    fetchEumetsatPrecipitationMetadata(env),
    fetchEumetsatCloudMetadata(env),
  ]);

  return jsonResponse(
    {
      success: true,
      generatedAt: new Date().toISOString(),
      radar: precipitation.status === "fulfilled" ? precipitation.value : null,
      clouds: clouds.status === "fulfilled" ? clouds.value : null,
      errors: {
        radar: precipitation.status === "rejected" ? String(precipitation.reason) : null,
        clouds: clouds.status === "rejected" ? String(clouds.reason) : null,
      },
    },
    200,
    { "Cache-Control": "no-store" },
  );
}

async function fetchEumetsatPrecipitationMetadata(env) {
  return fetchEumetsatLayerMetadata(env, {
    provider: "EUMETSAT precipitation",
    layer: EUMETSAT_PRECIP_LAYER,
    style: EUMETSAT_PRECIP_STYLE,
  });
}

async function fetchEumetsatCloudMetadata(env) {
  return fetchEumetsatLayerMetadata(env, {
    provider: "EUMETSAT",
    layer: EUMETSAT_CLOUD_LAYER,
    style: EUMETSAT_CLOUD_STYLE,
  });
}

async function fetchEumetsatLayerMetadata(env, layerConfig) {
  const capabilitiesEndpoint =
    env.EUMETSAT_WMS_CAPABILITIES || EUMETSAT_WMS_CAPABILITIES;
  const response = await fetch(`${capabilitiesEndpoint}&_=${Date.now()}`, {
    headers: { Accept: "text/xml, application/xml" },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!response.ok) {
    throw new Error(`EUMETSAT capabilities returned ${response.status}`);
  }

  const xml = await response.text();
  const time = extractWmsLayerDefaultTime(xml, layerConfig.layer);
  if (!time) {
    throw new Error(`No default time found for ${layerConfig.layer}.`);
  }

  return {
    provider: layerConfig.provider,
    kind: "wms",
    endpoint: env.EUMETSAT_WMS_ENDPOINT || EUMETSAT_WMS_ENDPOINT,
    layer: layerConfig.layer,
    style: layerConfig.style,
    time,
    cacheBust: time.replace(/\D/g, ""),
  };
}

function extractWmsLayerDefaultTime(xml, layerName) {
  const escapedLayer = escapeRegExp(layerName);
  const layerPattern = new RegExp(
    `<Layer[^>]*>[\\s\\S]*?<Name>${escapedLayer}<\\/Name>[\\s\\S]*?<\\/Layer>`,
    "i",
  );
  const layerBlock = xml.match(layerPattern)?.[0] || "";
  return (
    layerBlock.match(/<Dimension[^>]*name=["']time["'][^>]*default=["']([^"']+)["']/i)?.[1] ||
    layerBlock.match(/<Dimension[^>]*default=["']([^"']+)["'][^>]*name=["']time["']/i)?.[1] ||
    null
  );
}

async function handleSearch(url) {
  const query = (url.searchParams.get("q") || "").trim();
  if (query.length < 2) {
    return jsonResponse({ success: false, error: "Search query is too short." }, 400);
  }

  const searchUrl = new URL("https://nominatim.openstreetmap.org/search");
  searchUrl.searchParams.set("format", "json");
  searchUrl.searchParams.set("limit", "5");
  searchUrl.searchParams.set("q", query);

  const response = await fetch(searchUrl, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "en",
      "User-Agent": "LightningWeatherX/1.0 contact=local",
    },
  });

  return new Response(response.body, {
    status: response.status,
    headers: {
      ...corsHeaders,
      "Content-Type": response.headers.get("Content-Type") || "application/json",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

async function handleSatelliteList(url, env) {
  assertDb(env);
  await ensureSatelliteTable(env);
  const stored = await env.DB.prepare("SELECT product, time FROM satellite_frames ORDER BY time").all();
  const frames = {};
  for (const row of stored.results || []) (frames[row.product] ||= []).push(row.time);
  const times = Object.fromEntries(Object.entries(frames).map(([id, list]) => [id, list[list.length - 1]]));
  const { north, south, west, east } = SATELLITE_REGION;
  return jsonResponse(
    {
      success: true,
      source: "EUMETSAT Meteosat, Indian Ocean service",
      bounds: [[south, west], [north, east]],
      products: Object.entries(SATELLITE_PRODUCTS).map(([id, product]) => ({
        id,
        label: product.label,
        note: product.note,
        time: times[id] || null,
        // The image time is in the address, so a browser can keep each picture until a newer one appears.
        url: `${url.origin}/api/satellite/${id}${times[id] ? `?t=${encodeURIComponent(times[id])}` : ""}`,
        // Every stored image time (oldest first, up to 24 hours); each is served at `${frameUrl}<time>`.
        frames: frames[id] || [],
        frameUrl: `${url.origin}/api/satellite/${id}?t=`,
      })),
    },
    200,
    { "Cache-Control": "public, max-age=60" },
  );
}

async function handleSatelliteImage(id, time, env) {
  assertDb(env);
  if (!SATELLITE_PRODUCTS[id]) {
    return jsonResponse({ success: false, error: "Unknown satellite product" }, 404);
  }
  await ensureSatelliteTable(env);
  const read = (exact) =>
    exact
      ? env.DB.prepare("SELECT time, content_type AS contentType, data FROM satellite_frames WHERE product = ? AND time = ?").bind(id, exact).first()
      : env.DB.prepare("SELECT time, content_type AS contentType, data FROM satellite_frames WHERE product = ? ORDER BY time DESC LIMIT 1").bind(id).first();
  let row = await read(time);
  if (!row && time) {
    // An image older than the 24 hours kept, or a time that was never stored.
    if (await read()) return jsonResponse({ success: false, error: "No satellite image is stored for that time." }, 404);
  }
  if (!row) {
    // Not stored yet (first use, before the cron reaches it): fetch it now. This one request is slow.
    try {
      await storeSatelliteImage(env, id, (await latestSatelliteTimes())[id]);
    } catch (error) {
      console.error(JSON.stringify({ message: "satellite fetch failed", product: id, error: String(error) }));
      return jsonResponse({ success: false, error: "This satellite image is not available yet." }, 503);
    }
    row = await read(null);
  }
  // D1 returns BLOB columns as an ArrayBuffer or a plain array of bytes depending on the runtime.
  return new Response(new Uint8Array(row.data), {
    headers: {
      ...corsHeaders,
      "Content-Type": row.contentType,
      "Cache-Control": "public, max-age=86400",
      "X-Satellite-Time": row.time,
    },
  });
}

// Runs from the 5-minute cron: stores the products that have a newer image, a few per run.
async function refreshSatelliteIfDue(env) {
  try {
    assertDb(env);
    await ensureSatelliteTable(env);
    const latest = await latestSatelliteTimes();
    const cutoff = isoMinute(Date.now() - SATELLITE_HISTORY_MS);
    await env.DB.prepare("DELETE FROM satellite_frames WHERE time < ?").bind(cutoff).run();
    const stored = await env.DB.prepare("SELECT product, time, fetched_at AS fetchedAt FROM satellite_frames").all();
    const have = new Set((stored.results || []).map((row) => `${row.product} ${row.time}`));
    const lastFetched = {};
    for (const row of stored.results || []) lastFetched[row.product] = Math.max(lastFetched[row.product] || 0, row.fetchedAt);
    // Newest images first (never-stored and longest-waiting products first)...
    const jobs = Object.keys(SATELLITE_PRODUCTS)
      .filter((id) => latest[id] && !have.has(`${id} ${latest[id]}`))
      .sort((a, b) => (lastFetched[a] ?? 0) - (lastFetched[b] ?? 0))
      .map((id) => [id, latest[id]]);
    // ...then missing hourly images of the past day, newest hours first, round-robin across products.
    const newest = Math.max(...Object.values(latest).filter(Boolean).map((time) => Date.parse(time)));
    if (Number.isFinite(newest)) {
      for (let at = Math.floor(newest / HOUR_MS) * HOUR_MS; at > Date.now() - SATELLITE_HISTORY_MS + SATELLITE_STEP_MS; at -= HOUR_MS) {
        for (const id of Object.keys(SATELLITE_PRODUCTS)) {
          const time = isoMinute(at);
          if (latest[id] && Date.parse(latest[id]) >= at && !have.has(`${id} ${time}`) && !jobs.some(([j, t]) => j === id && t === time)) jobs.push([id, time]);
        }
      }
    }
    const due = jobs.slice(0, SATELLITE_FETCHES_PER_RUN);
    for (let index = 0; index < due.length; index += SATELLITE_PARALLEL_FETCHES) {
      await Promise.all(
        due.slice(index, index + SATELLITE_PARALLEL_FETCHES).map(async ([id, time]) => {
          try {
            await storeSatelliteImage(env, id, time);
          } catch (error) {
            console.error(JSON.stringify({ message: "satellite fetch failed", product: id, time, error: String(error) }));
          }
        }),
      );
    }
  } catch (error) {
    console.error(JSON.stringify({ message: "satellite refresh failed", error: String(error) }));
  }
}

// Latest image time of every product, from EUMETSAT's Indian-Ocean-only capabilities (about 55 KB).
// "2026-10-25T05:00:00Z": the form EUMETSAT lists, so stored times sort and compare as text.
function isoMinute(ms) {
  return new Date(Math.floor(ms / 60000) * 60000).toISOString().replace(".000Z", "Z");
}

async function latestSatelliteTimes() {
  if (satelliteTimesCache && Date.now() - satelliteTimesCache.at < SATELLITE_TIMES_CACHE_MS) {
    return satelliteTimesCache.times;
  }
  const response = await fetch(SATELLITE_CAPABILITIES, {
    headers: { Accept: "text/xml, application/xml" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`EUMETSAT capabilities returned ${response.status}`);
  }
  const xml = await response.text();
  const times = Object.fromEntries(
    Object.entries(SATELLITE_PRODUCTS).map(([id, product]) => [
      id,
      // The namespaced service lists layers without their "msg_iodc:" prefix.
      normaliseSatelliteTime(extractWmsLayerDefaultTime(xml, product.layer) || extractWmsLayerDefaultTime(xml, product.layer.split(":")[1])),
    ]),
  );
  satelliteTimesCache = { at: Date.now(), times };
  return times;
}

function normaliseSatelliteTime(time) {
  const ms = Date.parse(time || "");
  return Number.isFinite(ms) ? isoMinute(ms) : null;
}

async function storeSatelliteImage(env, id, time) {
  if (!time) {
    throw new Error("No image time is listed for this product.");
  }
  const product = SATELLITE_PRODUCTS[id];
  // Requested in Web Mercator (EPSG:3857), the map's own projection, so the picture lines up exactly.
  const mercatorX = (lon) => (6378137 * lon * Math.PI) / 180;
  const mercatorY = (lat) => 6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const { north, south, west, east } = SATELLITE_REGION;
  const height = Math.round((SATELLITE_WIDTH * (mercatorY(north) - mercatorY(south))) / (mercatorX(east) - mercatorX(west)));
  const params = new URLSearchParams({
    service: "WMS",
    version: "1.1.1",
    request: "GetMap",
    layers: product.layer,
    styles: product.style || "",
    srs: "EPSG:3857",
    bbox: [mercatorX(west), mercatorY(south), mercatorX(east), mercatorY(north)].map((value) => value.toFixed(0)).join(","),
    width: String(SATELLITE_WIDTH),
    height: String(height),
    format: product.format,
    transparent: product.format === "image/png" ? "true" : "false",
    // JPEG cannot be transparent, so areas without data (the night side, space) are painted black,
    // which the map blends away. GeoServer's default would be white.
    bgcolor: "0x000000",
    time,
  });
  const response = await fetch(`${SATELLITE_WMS}?${params}`, { signal: AbortSignal.timeout(120_000) });
  const contentType = response.headers.get("Content-Type") || "";
  // GeoServer reports errors as XML with status 200, so check that a picture actually came back.
  if (!response.ok || !contentType.startsWith("image/")) {
    throw new Error(`EUMETSAT returned ${response.status} ${contentType}`);
  }
  const data = await response.arrayBuffer();
  if (data.byteLength > SATELLITE_MAX_BYTES) {
    throw new Error(`Image too large to store (${data.byteLength} bytes)`);
  }
  await env.DB.prepare(
    `INSERT INTO satellite_frames (product, time, fetched_at, content_type, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(product, time) DO UPDATE SET fetched_at = excluded.fetched_at,
       content_type = excluded.content_type, data = excluded.data`,
  )
    .bind(id, time, Date.now(), contentType.split(";")[0], data)
    .run();
}

async function ensureSatelliteTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS satellite_frames (product TEXT NOT NULL, time TEXT NOT NULL, fetched_at INTEGER NOT NULL, content_type TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY (product, time))",
  ).run();
}

// Every pollen station's latest report plus a short history (newest last). The top-level `latest`, `station` and
// `history` repeat Islamabad's for pages built before Lahore was added.
async function handlePollen(env) {
  assertDb(env);
  await ensurePollenTable(env);
  let rows = (await env.DB.prepare("SELECT station, report_date AS date, label, fetched_at AS fetchedAt, data FROM pollen_daily ORDER BY report_date DESC LIMIT 120").all()).results || [];
  if (!rows.length) {
    // First use before the cron has run: read PMD now.
    await refreshPollen(env, true);
    rows = (await env.DB.prepare("SELECT station, report_date AS date, label, fetched_at AS fetchedAt, data FROM pollen_daily ORDER BY report_date DESC LIMIT 120").all()).results || [];
    if (!rows.length) return jsonResponse({ success: false, error: "Pollen data is not available yet." }, 503);
  }
  const stations = Object.entries(POLLEN_STATIONS).map(([id, station]) => {
    const reports = rows
      .filter((row) => row.station === id)
      .slice(0, 30)
      .map((row) => ({ date: row.date, label: row.label, fetchedAt: row.fetchedAt, ...JSON.parse(row.data) }))
      .reverse();
    return {
      id,
      name: station.name,
      latitude: station.latitude,
      longitude: station.longitude,
      source: station.source,
      sourceUrl: station.url,
      latest: reports[reports.length - 1] || null,
      // Compact history for trends: each day's types with their category and highest count.
      history: reports.map((report) => ({
        date: report.date,
        types: report.types.map((item) => ({ type: item.type, category: item.category, count: maxPollenCount(item.counts) })),
      })),
    };
  });
  const islamabad = stations.find((station) => station.id === "islamabad");
  return jsonResponse(
    {
      success: true,
      source: "Pakistan Meteorological Department",
      stations,
      station: { name: islamabad.name, latitude: islamabad.latitude, longitude: islamabad.longitude },
      sourceUrl: islamabad.sourceUrl,
      latest: islamabad.latest,
      history: islamabad.history,
    },
    200,
    { "Cache-Control": "public, max-age=900" },
  );
}

function maxPollenCount(counts) {
  const values = Object.values(counts || {}).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

async function refreshPollenIfDue(env) {
  try {
    assertDb(env);
    await ensurePollenTable(env);
    await refreshPollen(env, false);
  } catch (error) {
    console.error(JSON.stringify({ message: "pollen refresh failed", error: String(error) }));
  }
}

// Reads each station whose last read is older than POLLEN_REFRESH_MS (or all, when forced). A station that fails
// is logged and skipped, so one page changing does not stop the other.
async function refreshPollen(env, force) {
  const last = (await env.DB.prepare("SELECT station, MAX(fetched_at) AS at FROM pollen_daily GROUP BY station").all()).results || [];
  const lastAt = Object.fromEntries(last.map((row) => [row.station, row.at]));
  for (const [id, station] of Object.entries(POLLEN_STATIONS)) {
    if (!force && lastAt[id] && Date.now() - lastAt[id] < POLLEN_REFRESH_MS) continue;
    try {
      const response = await fetch(station.url, {
        headers: { Accept: "text/html", "User-Agent": "WAPK-Weather-Alert-PK/1.0 (+https://wapk.pages.dev)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`${station.url} returned ${response.status}`);
      const report = station.parse(await response.text());
      const { date, label, ...data } = report;
      await env.DB.prepare(
        `INSERT INTO pollen_daily (station, report_date, label, fetched_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(station, report_date) DO UPDATE SET label = excluded.label, fetched_at = excluded.fetched_at, data = excluded.data`,
      )
        .bind(id, date, label, Date.now(), JSON.stringify(data))
        .run();
    } catch (error) {
      console.error(JSON.stringify({ message: "pollen station failed", station: id, error: String(error) }));
    }
  }
  const cutoff = new Date(Date.now() - POLLEN_HISTORY_DAYS * DAY_MS).toISOString().slice(0, 10);
  await env.DB.prepare("DELETE FROM pollen_daily WHERE report_date < ?").bind(cutoff).run();
}

// Reads the rows the page renders from: `rows.push({ type: "Grasses", 'H-8': "24", ..., category: "High" })`,
// the sampling sites from `const ALL_COLS = [...]`, and the date from "Last Updated: October 27, 2026".
function parsePmdPollen(html) {
  const updated = html.match(/Last Updated:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (!updated) throw new Error("PMD pollen page has no 'Last Updated' date");
  const month = POLLEN_MONTHS.indexOf(updated[1].toLowerCase());
  if (month < 0) throw new Error(`Unknown month ${updated[1]}`);
  const date = `${updated[3]}-${String(month + 1).padStart(2, "0")}-${updated[2].padStart(2, "0")}`;
  const sites = [...(html.match(/const ALL_COLS\s*=\s*\[([^\]]*)\]/)?.[1] || "").matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const types = [];
  for (const block of html.matchAll(/rows\.push\(\{([\s\S]*?)\}\);/g)) {
    const body = block[1];
    const type = body.match(/type:\s*"([^"]*)"/)?.[1]?.trim();
    if (!type) continue;
    const category = body.match(/category:\s*"([^"]*)"/)?.[1]?.trim() || "";
    const counts = {};
    for (const [, site, value] of body.matchAll(/'([^']+)':\s*(null|"[^"]*")/g)) {
      const count = value === "null" ? null : Number.parseInt(value.slice(1, -1), 10);
      counts[site] = Number.isFinite(count) ? count : null;
    }
    types.push({ type, category, counts });
  }
  if (!types.length) throw new Error("PMD pollen page has no rows");
  return { date, label: `${updated[1]} ${updated[2]}, ${updated[3]}`, sites, types };
}

const POLLEN_SHORT_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function pollenText(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&middot;/g, " ").replace(/\s+/g, " ").trim();
}

// "06 Oct 2026" → "2026-10-06"
function pollenIsoDate(value) {
  const match = value?.match(/(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/);
  if (!match) return null;
  const month = POLLEN_SHORT_MONTHS.indexOf(match[2].toLowerCase());
  return month < 0 ? null : `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

// FFD Lahore page: "Sample: <strong>06 Oct 2026</strong> … Analysis: 07 Oct 2026", a `pollen-table` whose rows are
// type / count / category badge, a "Notes:" line, and a "Category Thresholds" table (Low / Mod / High).
function parseFfdPollen(html) {
  const sample = html.match(/Sample:\s*<strong>\s*([^<]+?)\s*<\/strong>/)?.[1];
  const analysis = html.match(/Analysis:\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/)?.[1];
  const date = pollenIsoDate(analysis) || pollenIsoDate(sample);
  if (!date) throw new Error("FFD pollen page has no sample or analysis date");
  const table = html.match(/<table[^>]*pollen-table[\s\S]*?<\/table>/)?.[0];
  if (!table) throw new Error("FFD pollen page has no pollen table");
  const body = table.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "";
  const types = [];
  for (const [, row] of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]);
    if (cells.length < 3) continue;
    const type = pollenText(cells[0]);
    const count = Number.parseFloat(pollenText(cells[1]));
    if (type) types.push({ type, category: pollenText(cells[2]), counts: { Lahore: Number.isFinite(count) ? count : null } });
  }
  if (!types.length) throw new Error("FFD pollen page has no rows");
  const notes = html.match(/<strong>Notes:<\/strong>\s*([\s\S]*?)<\/div>/)?.[1];
  const thresholds = {};
  const thresholdRows = html.slice(html.indexOf("Category Thresholds")).match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "";
  for (const [, row] of thresholdRows.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => pollenText(cell[1]));
    const numbers = cells.slice(1, 4).map((cell) => Number.parseFloat(cell.replace(/[^\d.]/g, "")));
    if (cells[0] && numbers.every(Number.isFinite)) thresholds[cells[0]] = { low: numbers[0], moderate: numbers[1], high: numbers[2] };
  }
  const label = [analysis ? `Analysed ${analysis}` : "", sample ? `sample ${sample}` : ""].filter(Boolean).join(" · ");
  return { date, label, sites: ["Lahore"], types, notes: notes ? pollenText(notes) : null, thresholds };
}

async function ensurePollenTable(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS pollen_daily (station TEXT NOT NULL, report_date TEXT NOT NULL, label TEXT NOT NULL, fetched_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (station, report_date))",
  ).run();
}

// Fires of the last 24, 48 or 72 hours (?hours=, default 24) inside the map area, as compact rows (see `fields`).
async function handleFires(env, url) {
  const hours = FIRE_WINDOWS_HOURS.includes(Number(url.searchParams.get("hours"))) ? Number(url.searchParams.get("hours")) : 24;
  assertDb(env);
  await ensureFireTable(env);
  let row = await env.DB.prepare("SELECT fetched_at AS fetchedAt, data FROM fire_snapshot WHERE id = 'latest'").first();
  if (!row) {
    try {
      await refreshFires(env);
    } catch (error) {
      console.error(JSON.stringify({ message: "fire fetch failed", error: String(error) }));
      return jsonResponse({ success: false, error: "Fire data is not available yet." }, 503);
    }
    row = await env.DB.prepare("SELECT fetched_at AS fetchedAt, data FROM fire_snapshot WHERE id = 'latest'").first();
  }
  const snapshot = JSON.parse(row.data);
  // Only the asked window, counted back from now (so fires age out between snapshots too).
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const fires = snapshot.fires.filter((fire) => fire[2] * 60000 >= cutoff);
  return jsonResponse(
    {
      success: true,
      source: "NASA FIRMS (VIIRS and MODIS active fires)",
      sourceUrl: "https://firms.modaps.eosdis.nasa.gov/",
      fetchedAt: row.fetchedAt,
      hours,
      satellites: snapshot.satellites,
      fields: ["latitude", "longitude", "minutesSinceEpoch", "frpMW", "confidence 0 low · 1 nominal · 2 high", "satellite index", "night 1 / day 0"],
      count: fires.length,
      fires,
    },
    200,
    { "Cache-Control": "public, max-age=600" },
  );
}

async function refreshFiresIfDue(env) {
  try {
    assertDb(env);
    await ensureFireTable(env);
    const row = await env.DB.prepare("SELECT fetched_at AS fetchedAt FROM fire_snapshot WHERE id = 'latest'").first();
    if (row && Date.now() - row.fetchedAt < FIRE_REFRESH_MS) return;
    await refreshFires(env);
  } catch (error) {
    console.error(JSON.stringify({ message: "fire refresh failed", error: String(error) }));
  }
}

// Downloads every feed (a failing one is skipped), keeps fires inside the map area from the last 72 hours, and stores
// them as [lat, lon, minutesSinceEpoch, frp, confidence, satelliteIndex, night].
async function refreshFires(env) {
  const { north, south, west, east } = SATELLITE_REGION;
  const cutoff = Date.now() - FIRE_MAX_AGE_MS;
  const fires = [];
  let loaded = 0;
  const results = await Promise.allSettled(
    FIRE_FEEDS.map(async (feed) => {
      const response = await fetch(feed.url, { headers: { "User-Agent": "WAPK-Weather-Alert-PK/1.0 (+https://wapk.pages.dev)" }, signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(`${feed.sat} returned ${response.status}`);
      return response.text();
    }),
  );
  results.forEach((result, satIndex) => {
    if (result.status !== "fulfilled") {
      console.error(JSON.stringify({ message: "fire feed failed", satellite: FIRE_FEEDS[satIndex].sat, error: String(result.reason) }));
      return;
    }
    const lines = result.value.trim().split("\n");
    const header = lines.shift()?.split(",") || [];
    const column = (name) => header.indexOf(name);
    const [lat, lon, date, time, conf, frp, dn] = ["latitude", "longitude", "acq_date", "acq_time", "confidence", "frp", "daynight"].map(column);
    if (lat < 0 || lon < 0 || date < 0 || time < 0) return;
    loaded += 1;
    const oldestDate = new Date(cutoff).toISOString().slice(0, 10);
    for (const line of lines) {
      const cells = line.split(",");
      if (cells[date] < oldestDate) continue;
      const latitude = Number(cells[lat]);
      const longitude = Number(cells[lon]);
      if (!(latitude >= south && latitude <= north && longitude >= west && longitude <= east)) continue;
      const hhmm = cells[time].padStart(4, "0");
      const at = Date.parse(`${cells[date]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
      if (!Number.isFinite(at) || at < cutoff) continue;
      // VIIRS reports low / nominal / high; MODIS reports 0–100 (under 30 low, 80+ high).
      const raw = cells[conf];
      const confidence = /^\d+$/.test(raw) ? (Number(raw) < 30 ? 0 : Number(raw) >= 80 ? 2 : 1) : raw === "l" || raw === "low" ? 0 : raw === "h" || raw === "high" ? 2 : 1;
      fires.push([Math.round(latitude * 1e4) / 1e4, Math.round(longitude * 1e4) / 1e4, Math.round(at / 60000), Math.round(Number(cells[frp]) * 10) / 10 || 0, confidence, satIndex, cells[dn] === "N" ? 1 : 0]);
    }
  });
  if (!loaded) throw new Error("No fire feed could be read");
  await env.DB.prepare(
    `INSERT INTO fire_snapshot (id, fetched_at, data) VALUES ('latest', ?, ?)
     ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data`,
  )
    .bind(Date.now(), JSON.stringify({ satellites: FIRE_FEEDS.map((feed) => feed.sat), fires }))
    .run();
}

async function ensureFireTable(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS fire_snapshot (id TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, data TEXT NOT NULL)").run();
}

async function handlePmdRadar() {
  if (!pmdRadarCache || Date.now() - pmdRadarCache.at >= PMD_RADAR_CACHE_MS) {
    try {
      pmdRadarCache = { body: await fetchPmdRadar(), at: Date.now() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ message: "pmd radar refresh failed", error: message }));
      // Keep serving the last good manifest while PMD is briefly unreachable.
      if (!pmdRadarCache) {
        return jsonResponse({ success: false, error: "PMD radar is unavailable." }, 502);
      }
    }
  }

  return jsonResponse(pmdRadarCache.body, 200, { "Cache-Control": "public, max-age=120" });
}

async function fetchPmdRadar() {
  const response = await fetch(PMD_RADAR_MANIFEST, {
    headers: {
      Accept: "application/json",
      "User-Agent": "LightningWeatherX/1.0 (radar via PMD FFD)",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`PMD manifest returned ${response.status}`);
  }

  const manifest = await response.json();
  if (!manifest?.ok || !Array.isArray(manifest.sites)) {
    throw new Error("PMD manifest was empty.");
  }

  // Only pass on image URLs from PMD's radar storage, so the map never loads anything else.
  const pmdImage = (value) =>
    typeof value === "string" && value.startsWith(PMD_RADAR_IMAGE_PREFIX) && value.endsWith(".png") ? value : null;
  const latLng = (value) =>
    Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) ? value : null;

  return {
    success: true,
    source: "PMD Flood Forecasting Division",
    sourceUrl: "https://ffd.pmd.gov.pk/radar",
    fetchedAt: manifest.fetched_at || null,
    mirrorStale: Boolean(manifest.stale),
    sites: manifest.sites.map((site) => ({
      id: String(site.id || ""),
      name: String(site.name || site.id || "Radar"),
      center: latLng(site.center),
      bounds: Object.fromEntries(
        Object.entries(site.bounds || {}).filter(([, box]) => Array.isArray(box) && box.length === 2 && box.every(latLng)),
      ),
      maintenance: Boolean(site.is_maintenance),
      upstreamOk: site.upstream_ok !== false,
      products: (site.products || []).map((product) => ({
        code: String(product.code || ""),
        label: String(product.label || product.code || ""),
        units: String(product.units || ""),
        radiusKm: Number(product.radius_km),
        cadenceMinutes: Number(product.cadence_minutes) || 10,
        legend: pmdImage(product.legend),
        latestAt: product.latest_at || null,
        frames: (product.frames || [])
          .map((frame) => ({ url: pmdImage(frame?.url), time: frame?.t || null }))
          .filter((frame) => frame.url && frame.time && !Number.isNaN(Date.parse(frame.time))),
      })),
    })),
  };
}

function normalizeStrike(raw, index, sourceDate) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const lat = Number(raw.lat ?? raw.latitude);
  const lon = Number(raw.lon ?? raw.lng ?? raw.long ?? raw.longitude);
  const timestamp = String(raw.timestamp ?? raw.time ?? raw.createdAt ?? "").trim();
  const date = parseApiTimestamp(timestamp);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !timestamp || Number.isNaN(date.getTime())) {
    return null;
  }

  const timestampMs = date.getTime();
  return {
    id: String(raw.id ?? `${timestampMs}:${lat.toFixed(4)}:${lon.toFixed(4)}:${index}`),
    lat,
    lon,
    timestamp,
    timestampMs,
    sourceDate,
    rawJson: JSON.stringify(raw),
  };
}

function parseApiTimestamp(timestamp) {
  const normalized = timestamp.replace(" ", "T");
  const hasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  return new Date(hasOffset ? normalized : `${normalized}${API_TIMEZONE_OFFSET}`);
}

function assertDb(env) {
  if (!env.DB) {
    throw new Error("DB binding is missing.");
  }
}

function getRefreshIntervalSeconds(env) {
  return clampNumber(
    Number(env.REFRESH_INTERVAL_SECONDS || DEFAULT_REFRESH_INTERVAL_SECONDS),
    10,
    3600,
    DEFAULT_REFRESH_INTERVAL_SECONDS,
  );
}

function getAggregateLimit(env) {
  return clampNumber(
    Number(env.AGGREGATE_LIMIT || DEFAULT_AGGREGATE_LIMIT),
    100,
    50_000,
    DEFAULT_AGGREGATE_LIMIT,
  );
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function jsonResponse(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders,
      ...headers,
    },
  });
}
