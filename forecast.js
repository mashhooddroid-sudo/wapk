(function () {
  "use strict";

  // Windy-style forecast map for the Maps view. The data comes from ECMWF IFS open data, which the
  // pipeline publishes as one byte-packed file per field and 3-hourly step (see pipeline/build_forecast.py).
  // The timeline moves hour by hour by blending the two neighbouring steps.
  const API_TIMEZONE = "Asia/Karachi";
  const REFRESH_MS = 30 * 60 * 1000;
  const PLAY_STEP_MS = 450;
  // About 2.5 pixels per 0.25° cell across the region; the browser smooths it when zoomed in.
  const COLOR_WIDTH = 860;
  const FIELD_STRIDE = 4;
  const PARTICLE_MAX_AGE = 90;
  // Windy-style animation settings (Map settings → Wind animation), each a multiplier of the default look.
  const PARTICLE_STYLE_KEY = "wapk.particleStyle";
  const PARTICLE_STYLE_DEFAULT = { speed: 1, length: 1, thickness: 1, density: 1 };
  const ISOBAR_STEP_HPA = 4;
  // Decoded field-steps kept in memory (about 300 KB each).
  const CACHE_LIMIT = 80;
  // Model steps fetched ahead of the visible time (each step is 3 hours).
  const PREFETCH_STEPS = 3;
  const PREFERENCES_KEY = "wapk.forecastMap";
  const ATTRIBUTION = 'Forecast &copy; <a href="https://www.ecmwf.int/" target="_blank" rel="noopener noreferrer">ECMWF</a> open data (CC-BY-4.0)';
  const TEMP_STOPS = [[-60, "#2a0b4f"], [-40, "#542a9a"], [-20, "#6e40aa"], [-10, "#4c6edb"], [0, "#23abd8"], [10, "#1ddfa3"], [20, "#b8f735"], [28, "#f2c931"], [35, "#fd7d27"], [42, "#e0301e"], [50, "#8f0c26"]];
  const CLOUD_STOPS = [[5, "#dfe7f1", 0], [30, "#dfe7f1", 0.35], [60, "#eef2f8", 0.65], [90, "#f8fafc", 0.85], [100, "#ffffff", 0.92]];
  // White cloud vanishes on the light street map, so it uses slate grey there.
  const CLOUD_LIGHT_STOPS = [[5, "#5d6f86", 0], [30, "#5d6f86", 0.3], [60, "#4c5d73", 0.55], [90, "#3c4b5f", 0.75], [100, "#334155", 0.82]];
  const cloudLayer = (label, type, field) => ({ label, type, unit: "%", field, isCloud: true, transparentBelow: 5, opacity: 0.85, stops: CLOUD_STOPS, lightStops: CLOUD_LIGHT_STOPS });
  // Categorical layers: hard colour steps and a legend of named swatches.
  const categoryLayer = (layer) => ({
    ...layer, unit: "", nearest: true, transparentBelow: 0.5, opacity: 0.75,
    stops: layer.categories.flatMap(([value, , colour]) => [[value - 0.5, colour], [value + 0.49, colour]]),
  });
  const WIND_STOPS = [[0, "#3b5bab"], [10, "#3a8fd6"], [20, "#3fbfb0"], [30, "#7fd157"], [40, "#e9d43b"], [55, "#f39a2d"], [70, "#e4532d"], [90, "#b8216b"], [120, "#7a1f9c"], [160, "#4b1d78"], [220, "#d9d4ef"]];
  // Each layer: the stored field it reads, how to convert to display units, and its colour scale.
  // Stops are [value, colour, alpha?]; values below `transparentBelow` leave the map visible.
  const LAYERS = {
    wind: { label: "Wind speed", type: "Wind speed", unit: "km/h", byHeight: true, stops: WIND_STOPS },
    gust: { label: "Wind gusts", type: "Gusts", unit: "km/h", field: "gust", convert: (value) => value * 3.6, stops: WIND_STOPS },
    // Temperature follows the height picker: 2 m at the surface, otherwise the chosen pressure level.
    temp: {
      label: "Temperature", type: "Temperature", unit: "°C", field: (level) => (level === "10" ? "temp" : `t${level}`), byHeight: true,
      stops: TEMP_STOPS,
    },
    dew: { label: "Dew point", type: "Dew point", unit: "°C", field: "dew", stops: TEMP_STOPS },
    // Humidity follows the height picker like temperature.
    humidity: {
      label: "Humidity", type: "Relative humidity", unit: "%", field: (level) => (level === "10" ? "rh" : `r${level}`), byHeight: true,
      stops: [[0, "#a0522d"], [20, "#d9a35b"], [40, "#e8d9a0"], [60, "#8fd3a8"], [75, "#3fb7c4"], [90, "#2f6fd6"], [100, "#2a3d9a"]],
    },
    tcwv: {
      label: "Water vapour", type: "Water vapour", unit: "mm", field: "tcwv",
      note: "Water vapour is all the moisture in the air above a point, as mm of water if it all fell out.",
      stops: [[0, "#6b4a2b"], [5, "#a0754a"], [10, "#d2b27a"], [20, "#9fd49a"], [30, "#3fb7c4"], [45, "#2f6fd6"], [60, "#4b2fa8"], [75, "#c04fd0"]],
    },
    freezing: {
      label: "Freezing level", type: "Freezing level", unit: "m above sea level", field: "freezing",
      stops: [[0, "#e7f2ff"], [500, "#b9a6f2"], [1500, "#7b5fd6"], [2500, "#3d7bd9"], [3500, "#2fb3a8"], [4500, "#9ad15a"], [5500, "#f2c931"], [6500, "#f07a2d"]],
    },
    rain: {
      label: "Rain", type: "Rain rate", unit: "mm/h", field: "precip", transparentBelow: 0.1,
      stops: [[0.1, "#a6e1ff"], [0.5, "#4fb3ff"], [1, "#2f7fff"], [2, "#22c35e"], [5, "#f5d63d"], [10, "#f58b2d"], [20, "#e5322d"], [50, "#b3189b"]],
    },
    rainacc: {
      label: "Rain total", type: "Rain total", unit: "mm since the run started", field: "rainacc", transparentBelow: 0.5,
      note: "Rain total adds up everything that falls from the start of the model run to the chosen time.",
      stops: [[0.5, "#a6e1ff"], [2, "#4fb3ff"], [5, "#2f7fff"], [10, "#22c35e"], [25, "#f5d63d"], [50, "#f58b2d"], [100, "#e5322d"], [200, "#b3189b"]],
    },
    // A category per grid cell, so it is sampled from the nearest cell and step instead of blended.
    ptype: categoryLayer({
      label: "Precipitation type", type: "Precipitation type", field: "ptype",
      note: "Precipitation type shows what is falling where the model has precipitation at that moment.",
      categories: [[1, "Rain", "#3b8bff"], [2, "Rain and snow", "#a57cf0"], [3, "Snow", "#e9f2ff"], [4, "Freezing rain or ice", "#ff5fa2"]],
      symbols: { 1: [63], 2: [66], 3: [73], 4: [67] },
    }),
    snowacc: {
      label: "New snow", type: "New snow", unit: "cm since the run started", field: "snowacc", transparentBelow: 0.5,
      note: "New snow adds up the snowfall from the start of the model run, at about 1 cm of snow per mm of water.",
      stops: [[0.5, "#c9e4ff", 0.6], [2, "#8fc2ff"], [5, "#5b8cf0"], [10, "#7b5fd6"], [20, "#b04fd0"], [40, "#e04f9c"], [80, "#ff8a8a"]],
    },
    snowdepth: {
      label: "Snow depth", type: "Snow depth", unit: "cm", field: "snowdepth", transparentBelow: 1,
      note: "Snow depth is the model's snow cover; on glaciers it is capped and not a measured depth.",
      stops: [[1, "#d6ecff", 0.55], [10, "#9ccaff"], [30, "#5b8cf0"], [60, "#6c4fd0"], [120, "#a63fc0"], [250, "#e04f9c"], [500, "#fbd0e4"]],
    },
    // Thunderstorms by the WAPK app's rules: rain and instability together, not CAPE alone (see the pipeline).
    storm: categoryLayer({
      label: "Thunderstorms", type: "Thunderstorms", field: "storm",
      note: "Thunderstorms show only where the model has rain and enough instability (CAPE), using the WAPK app's rules; hail where the freezing level is low, it is cold aloft and winds aloft are strong.",
      categories: [[1, "Isolated", "#f6d04d"], [2, "Scattered", "#f39a2d"], [3, "Thunderstorms", "#e4402d"], [4, "Heavy", "#b0186b"], [5, "With hail", "#4ee6ff"]],
      symbols: { 1: [95], 2: [96], 3: [97], 4: [99], 5: [97, true] },
    }),
    cape: {
      label: "Thunderstorm potential", type: "Thunderstorm potential (CAPE)", unit: "CAPE, J/kg", short: "J/kg", field: "cape", transparentBelow: 100,
      note: "CAPE is the energy available for thunderstorms; storms also need a trigger.",
      stops: [[100, "#fde68a", 0.35], [500, "#fbbf24"], [1000, "#f97316"], [2000, "#dc2626"], [3000, "#9d174d"], [4500, "#6b21a8"]],
    },
    cloud: cloudLayer("Clouds", "Total clouds", "cloud"),
    lowcloud: cloudLayer("Low clouds", "Low clouds", "lowcloud"),
    midcloud: cloudLayer("Mid clouds", "Medium clouds", "midcloud"),
    highcloud: cloudLayer("High clouds", "High clouds", "highcloud"),
    solar: {
      label: "Solar radiation", type: "Solar radiation", unit: "W/m², 3-hour mean", field: "solar", transparentBelow: 10,
      note: "Solar radiation is the sunlight reaching the ground, averaged over the 3 hours before each step.",
      stops: [[10, "#3b2a6b", 0.3], [150, "#7a3f8f"], [300, "#c0516d"], [500, "#ec7a3d"], [700, "#f5b02e"], [900, "#fbe36a"], [1100, "#fffbe0"]],
    },
    // US AQI from the CAMS air-quality forecast (via Open-Meteo, as in the Health section). The colours are the
    // EPA bands, blended: good green, moderate yellow, then orange, red, purple and maroon.
    aqi: {
      label: "Air quality", type: "Air quality (US AQI)", unit: "US AQI", short: "AQI", field: "aqi", opacity: 0.7, ticks: [0, 50, 100, 150, 200, 300, 500],
      note: "Air quality is the US AQI from the CAMS forecast and reaches about 4–5 days ahead: 0–50 good, 51–100 moderate, 101–150 unhealthy for sensitive groups, 151–200 unhealthy, 201–300 very unhealthy, above 300 hazardous.",
      stops: [[0, "#00c853"], [25, "#00e400"], [75, "#ffff00"], [125, "#ff7e00"], [175, "#ff0000"], [250, "#8f3f97"], [400, "#7e0023"], [500, "#4a0014"]],
    },
    pressure: {
      label: "Pressure", type: "Sea-level pressure", unit: "hPa, lines every 4", field: "pressure", isobars: true,
      stops: [[990, "#5b3fa8"], [1000, "#3d7bd9"], [1008, "#4fb3c4"], [1013, "#9ad18a"], [1018, "#e8d36a"], [1024, "#f0a14a"], [1032, "#d9534f"], [1040, "#8f1d3a"]],
    },
  };
  // Rail categories, like Windy's menu. Each shows a dropdown of its types when it has more than one.
  const GROUPS = [
    { key: "wind", label: "Wind", icon: "wind", layers: ["wind", "gust"] },
    { key: "temperature", label: "Temperature", icon: "thermometer", layers: ["temp", "dew", "freezing"] },
    { key: "humidity", label: "Humidity", icon: "humidity", layers: ["humidity", "tcwv"] },
    { key: "rain", label: "Rain", icon: "rain", layers: ["rain", "rainacc", "ptype"] },
    { key: "storms", label: "Storms", icon: "bolt", layers: ["storm", "cape"] },
    { key: "snow", label: "Snow", icon: "snowflake", layers: ["snowacc", "snowdepth"] },
    { key: "clouds", label: "Clouds", icon: "cloud", layers: ["cloud", "lowcloud", "midcloud", "highcloud"] },
    { key: "solar", label: "Solar", icon: "sun", layers: ["solar"] },
    { key: "pressure", label: "Pressure", icon: "gauge", layers: ["pressure"] },
    { key: "air", label: "Air quality", icon: "leaf", layers: ["aqi"] },
  ];
  const groupOf = (layerKey) => GROUPS.find((group) => group.layers.includes(layerKey));
  const WIND_LEVELS = {
    10: { label: "Surface (10 m)", short: "surface", speed: 1 },
    // ECMWF has no 900 hPa level; 925 hPa (about 800 m) is the nearest.
    925: { label: "925 hPa · about 800 m", short: "925 hPa", speed: 0.85 },
    850: { label: "850 hPa · about 1.5 km", short: "850 hPa", speed: 0.75 },
    700: { label: "700 hPa · about 3 km", short: "700 hPa", speed: 0.6 },
    500: { label: "500 hPa · about 5.5 km", short: "500 hPa", speed: 0.45 },
    250: { label: "250 hPa · about 10 km (jet stream)", short: "250 hPa", speed: 0.3 },
  };

  window.WapkForecast = { attach };

  function attach(map, options) {
    const els = {
      toggle: document.getElementById("radarForecastToggle"),
      layerGroup: document.getElementById("radarForecastLayers"),
      level: document.getElementById("radarForecastLevel"),
      wind: document.getElementById("radarForecastWind"),
      bar: document.getElementById("radarForecastBar"),
      slider: document.getElementById("radarForecastSlider"),
      play: document.getElementById("radarForecastPlay"),
      time: document.getElementById("radarForecastTime"),
      ticks: document.getElementById("radarForecastTicks"),
      legend: document.getElementById("radarForecastLegend"),
      status: document.getElementById("radarForecastStatus"),
    };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const saved = readPreferences();
    const picker = { lat: null, lon: null, marker: null };
    const state = {
      meta: null,
      base: options.url.replace(/\/?$/, "/"),
      cache: new Map(),
      inflight: new Map(),
      enabled: saved.enabled !== false,
      // Storms used to be CAPE only; anyone who had it open gets the new thunderstorm layer once.
      layer: saved.layer === "cape" && !saved.stormLayer ? "storm" : (LAYERS[saved.layer] || saved.layer === "none") ? saved.layer : "wind",
      hour: 0,
      active: false,
      renderId: 0,
      prefetchId: 0,
      playTimer: null,
      refreshTimer: null,
      colorOverlay: null,
      theme: options.theme || "dark",
    };
    // The type last chosen in each category, so going back to a category restores it.
    state.lastType = Object.fromEntries(GROUPS.map((group) => [group.key, group.layers.includes(saved.lastType?.[group.key]) && (saved.stormLayer || group.key !== "storms") ? saved.lastType[group.key] : group.layers[0]]));
    if (LAYERS[state.layer]) state.lastType[groupOf(state.layer).key] = state.layer;
    const rail = buildRail();
    if (WIND_LEVELS[saved.level]) els.level.value = saved.level;
    if (typeof saved.particles === "boolean") els.wind.checked = saved.particles;

    map.createPane("forecastColor").style.zIndex = "300";
    map.createPane("forecastWind").style.zIndex = "380";
    map.getPane("forecastColor").style.pointerEvents = "none";
    map.getPane("forecastWind").style.pointerEvents = "none";
    // Weather symbols over category layers (storms, precipitation type), like Windy; below place names (390).
    map.createPane("forecastSymbols").style.zIndex = "387";
    map.getPane("forecastSymbols").style.pointerEvents = "none";

    const particles = createParticleLayer({ pane: "forecastWind", attribution: ATTRIBUTION });
    const symbols = createSymbolLayer({ pane: "forecastSymbols" });
    const isobars = createIsobarLayer({ pane: "forecastSymbols" });
    // The colour field is drawn into one canvas placed on the map like an image, so changing the hour
    // repaints pixels instead of encoding a new picture and swapping map layers.
    const colorCanvas = document.createElement("canvas");
    const CanvasOverlay = L.ImageOverlay.extend({
      _initImage() {
        const canvas = (this._image = this._url);
        L.DomUtil.addClass(canvas, "leaflet-image-layer");
        if (this._zoomAnimated) L.DomUtil.addClass(canvas, "leaflet-zoom-animated");
        if (this.options.className) L.DomUtil.addClass(canvas, this.options.className);
        canvas.onselectstart = L.Util.falseFn;
        canvas.onmousemove = L.Util.falseFn;
      },
    });

    els.toggle.addEventListener("click", () => {
      state.enabled = !state.enabled;
      if (!state.enabled) stopPlayback();
      savePreferences();
      render();
    });
    rail.forEach(({ group, button, select }) => {
      button.addEventListener("click", () => {
        // Choosing the active category again turns colours off and leaves just the wind.
        const active = state.enabled && groupOf(state.layer) === group;
        state.layer = active ? "none" : firstAvailable(group, state.lastType[group.key]);
        state.enabled = true;
        if (!active) options.onLayerChosen?.();
        savePreferences();
        render();
      });
      select?.addEventListener("change", () => {
        state.layer = select.value;
        state.lastType[group.key] = select.value;
        state.enabled = true;
        options.onLayerChosen?.();
        savePreferences();
        render();
      });
    });
    els.level.addEventListener("change", () => {
      savePreferences();
      render();
    });
    const particleStyle = readParticleStyle();
    const particleInputs = [...document.querySelectorAll("[data-particle]")];
    const showParticleStyle = () => particleInputs.forEach((input) => {
      input.value = particleStyle[input.dataset.particle];
      const label = document.querySelector(`[data-particle-value="${input.dataset.particle}"]`);
      if (label) label.textContent = `${Number(input.value).toFixed(1)}×`;
    });
    const applyParticleStyle = () => {
      showParticleStyle();
      particles.setStyle(particleStyle);
      if (map.hasLayer(particles)) particles.reset();
      try {
        localStorage.setItem(PARTICLE_STYLE_KEY, JSON.stringify(particleStyle));
      } catch {
        // The settings still apply for this visit when browser storage is unavailable.
      }
    };
    particleInputs.forEach((input) => input.addEventListener("input", () => {
      particleStyle[input.dataset.particle] = Number(input.value);
      applyParticleStyle();
    }));
    document.getElementById("radarParticleReset")?.addEventListener("click", () => {
      Object.assign(particleStyle, PARTICLE_STYLE_DEFAULT);
      applyParticleStyle();
    });
    showParticleStyle();
    particles.setStyle(particleStyle);

    els.wind.addEventListener("change", () => {
      savePreferences();
      render();
    });
    els.slider.addEventListener("input", () => {
      stopPlayback();
      state.hour = Number(els.slider.value);
      render();
    });
    els.play.addEventListener("click", () => (state.playTimer ? stopPlayback() : startPlayback()));
    // Clicking the map moves the picker there (Windy-style), inside the forecast area.
    map.on("click", (event) => {
      const { lat, lng } = event.latlng;
      if (state.meta && !insideGrid(lat, lng)) return;
      setPicker(lat, lng);
      options.onPickerMoved?.(lat, lng);
    });
    map.on("resize", () => state.meta && renderTicks());
    document.addEventListener("atmos:unit", () => {
      renderLegend();
    });
    syncControls();

    return { resume, pause, setTheme, setEnabled, setPicker, setTimeTo, refreshPicker: () => updatePicker(), openPicker: () => picker.lat !== null && options.onPickerOpen?.(picker.lat, picker.lon) };

    // Lets the satellite and radar controls switch the forecast colours off (or on).
    function setEnabled(enabled) {
      if (state.enabled === enabled) return;
      state.enabled = enabled;
      if (!enabled) stopPlayback();
      savePreferences();
      render();
    }

    function resume() {
      state.active = true;
      if (!state.meta || Date.now() - state.meta.loadedAt >= REFRESH_MS) loadMeta();
      else render();
      clearInterval(state.refreshTimer);
      state.refreshTimer = setInterval(loadMeta, REFRESH_MS);
    }

    function pause() {
      state.active = false;
      stopPlayback();
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
      state.prefetchId += 1;
      // Take the particles off the map so returning to the browser tab cannot restart them while Maps is hidden.
      if (map.hasLayer(particles)) map.removeLayer(particles);
    }

    function setTheme(theme) {
      state.theme = theme === "light" ? "light" : "dark";
      render();
    }

    // One rail button per category, followed by its type dropdown (shown while the category is active).
    function buildRail() {
      els.layerGroup.replaceChildren();
      return GROUPS.map((group) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "rail-item";
        button.dataset.forecastGroup = group.key;
        button.setAttribute("aria-pressed", "false");
        button.innerHTML = window.AtmosIcons?.ui(group.icon) || "";
        const text = document.createElement("span");
        text.textContent = group.label;
        button.append(text);
        els.layerGroup.append(button);
        let select = null;
        if (group.layers.length > 1) {
          const wrap = document.createElement("label");
          wrap.className = "rail-select rail-type";
          wrap.hidden = true;
          select = document.createElement("select");
          select.dataset.forecastType = group.key;
          select.setAttribute("aria-label", `${group.label} type`);
          group.layers.forEach((key) => select.append(new Option(LAYERS[key].type, key)));
          wrap.append(select);
          els.layerGroup.append(wrap);
        }
        return { group, button, select };
      });
    }

    // The preferred type of a category if the published data has it, otherwise its first type that it has.
    function firstAvailable(group, preferred) {
      if (!state.meta) return preferred;
      return [preferred, ...group.layers].find((key) => hasData(LAYERS[key])) || preferred;
    }

    function readPreferences() {
      try {
        return JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}") || {};
      } catch {
        return {};
      }
    }

    function savePreferences() {
      try {
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ enabled: state.enabled, layer: state.layer, lastType: state.lastType, level: els.level.value, particles: els.wind.checked, stormLayer: true }));
      } catch {
        // Choices still apply for this visit when browser storage is unavailable.
      }
    }

    // ── Data ─────────────────────────────────────────────────────────────────

    async function loadMeta() {
      try {
        const response = await fetch(`${state.base}latest.json`, { cache: "no-cache", signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`forecast index returned ${response.status}`);
        const meta = await response.json();
        if (!meta?.grid || !Array.isArray(meta.times) || meta.times.length < 2) throw new Error("forecast index is incomplete");
        const previousTime = state.meta ? currentTime() : null;
        // A new model run replaces every file, so drop everything decoded from the old one.
        if (state.meta?.runId !== meta.runId) {
          state.cache.clear();
          state.inflight.clear();
        }
        meta.loadedAt = Date.now();
        // Hours of each model step from the first; steps are 3-hourly, then 6-hourly later in the week.
        meta.offsets = meta.times.map((time) => (time - meta.times[0]) / 3600);
        meta.lastHour = meta.offsets[meta.offsets.length - 1];
        meta.decoders = Object.fromEntries(Object.entries(meta.fields).map(([name, spec]) => [name, decodeTable(spec, meta.missing)]));
        state.meta = meta;
        els.slider.max = String(meta.lastHour);
        // Keep the same clock time across refreshes; otherwise start at the hour closest to now.
        const target = previousTime ?? Date.now() / 1000;
        state.hour = Math.min(meta.lastHour, Math.max(0, Math.round((target - meta.times[0]) / 3600)));
        els.slider.value = String(state.hour);
        renderTicks();
        render();
      } catch (error) {
        setStatus(`The forecast could not load: ${error instanceof Error ? error.message : "unknown error"}.${state.meta ? " Showing the last loaded forecast." : ""}`);
      }
    }

    // One field at one 3-hourly step, decoded to display-ready numbers (NaN where missing).
    function fieldStep(field, step) {
      const key = `${field}:${step}`;
      if (state.cache.has(key)) {
        const values = state.cache.get(key);
        state.cache.delete(key);
        state.cache.set(key, values);
        return Promise.resolve(values);
      }
      if (state.inflight.has(key)) return state.inflight.get(key);
      const meta = state.meta;
      const url = state.base + meta.path.replace("{field}", field).replace("{step}", String(step));
      const request = fetch(url, { signal: AbortSignal.timeout(30_000) })
        .then((response) => {
          // A new run was published and this one removed: reload the index, then the caller retries.
          if (response.status === 404) {
            loadMeta();
            throw new Error("the forecast was just updated");
          }
          if (!response.ok) throw new Error(`forecast data returned ${response.status}`);
          return response.arrayBuffer();
        })
        .then((buffer) => {
          const bytes = new Uint8Array(buffer);
          // One byte per grid point; anything else (an error page, a file from another format) is not data.
          if (bytes.length !== meta.grid.nx * meta.grid.ny) {
            loadMeta();
            throw new Error("the forecast file was not valid");
          }
          const table = meta.decoders[field];
          const values = new Float32Array(bytes.length);
          for (let index = 0; index < bytes.length; index += 1) values[index] = table[bytes[index]];
          if (state.meta === meta) {
            state.cache.set(key, values);
            while (state.cache.size > CACHE_LIMIT) state.cache.delete(state.cache.keys().next().value);
          }
          return values;
        })
        .finally(() => state.inflight.delete(key));
      state.inflight.set(key, request);
      return request;
    }

    // The two steps either side of the current hour and how far between them it is.
    function bracket() {
      const { offsets } = state.meta;
      let first = 0;
      while (first < offsets.length - 2 && offsets[first + 1] <= state.hour) first += 1;
      const second = Math.min(first + 1, offsets.length - 1);
      const span = offsets[second] - offsets[first];
      return { first, second, weight: span ? Math.min(1, Math.max(0, (state.hour - offsets[first]) / span)) : 0 };
    }

    async function loadFields(fields) {
      const { first, second, weight } = bracket();
      const pairs = await Promise.all(
        fields.map(async (field) => [field, { a: await fieldStep(field, first), b: weight > 0 ? await fieldStep(field, second) : null, weight }]),
      );
      return Object.fromEntries(pairs);
    }

    // After the visible hour is drawn, quietly fetch the next few steps so playing and nudging the time
    // forward stay instant, without downloading the whole forecast for every layer (about 40 KB per step).
    async function prefetch(fields) {
      const run = ++state.prefetchId;
      const { first } = bracket();
      const last = Math.min(state.meta.times.length - 1, first + PREFETCH_STEPS);
      for (let step = Math.max(0, first - 1); step <= last; step += 1) {
        for (const field of fields) {
          if (run !== state.prefetchId || !state.active) return;
          try {
            await fieldStep(field, step);
          } catch {
            return;
          }
        }
      }
    }

    function windFields() {
      const level = els.level.value;
      return [`u${level}`, `v${level}`];
    }

    // Whether the published forecast includes a layer's field (at the chosen height).
    function hasData(layer) {
      return !layer?.field || Boolean(state.meta.fields[layerField(layer, els.level.value)]);
    }

    function neededFields() {
      const layer = hasData(LAYERS[state.layer]) ? LAYERS[state.layer] : null;
      const fields = new Set();
      if (layer) (layer.field ? [layerField(layer, els.level.value)] : windFields()).forEach((field) => fields.add(field));
      // Wind is always loaded: the picker shows it whichever layer is on.
      windFields().forEach((field) => fields.add(field));
      return [...fields];
    }

    function currentTime() {
      return state.meta.times[0] + state.hour * 3600;
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    function syncControls() {
      els.toggle.setAttribute("aria-pressed", String(state.enabled));
      els.layerGroup.classList.toggle("is-off", !state.enabled);
      const current = groupOf(state.layer);
      rail.forEach(({ group, button, select }) => {
        const active = state.enabled && group === current;
        button.setAttribute("aria-pressed", String(active));
        // Types the published run does not include yet (before a pipeline update is deployed) are hidden.
        const available = group.layers.filter((key) => !state.meta || hasData(LAYERS[key]));
        button.hidden = !available.length;
        if (!select) return;
        [...select.options].forEach((option) => (option.hidden = option.disabled = !available.includes(option.value)));
        if (group === current) select.value = state.layer;
        select.parentElement.hidden = !active || available.length < 2;
      });
      els.level.disabled = !state.enabled || (!LAYERS[state.layer]?.byHeight && !els.wind.checked);
      els.wind.disabled = !state.enabled;
      els.bar.hidden = !state.enabled || !state.meta;
    }

    async function render() {
      syncControls();
      const layer = state.meta && hasData(LAYERS[state.layer]) ? LAYERS[state.layer] : null;
      const showWind = els.wind.checked;
      const on = state.enabled && state.active && Boolean(state.meta) && (Boolean(layer) || showWind);
      if (!on) {
        clearDrawing();
        state.lastData = null;
        updatePicker();
        renderLegend();
        if (!state.enabled) setStatus("The forecast layer is off. Turn it on with Forecast in the layer list.");
        return;
      }
      const renderId = ++state.renderId;
      const fields = neededFields();
      let data;
      try {
        data = await loadFields(fields);
      } catch (error) {
        if (renderId === state.renderId) setStatus(`The forecast could not load: ${error instanceof Error ? error.message : "unknown error"}.`);
        return;
      }
      // A newer choice or hour arrived while this one was loading.
      if (renderId !== state.renderId || !state.active || !state.enabled) return;
      const level = els.level.value;
      state.lastData = data;
      updatePicker();

      if (layer) {
        const bounds = drawColorField(colorCanvas, state.meta, data, state.layer, level, state.theme);
        softenCategories();
        if (!state.colorOverlay) {
          state.colorOverlay = new CanvasOverlay(colorCanvas, bounds, {
            pane: "forecastColor",
            opacity: layer.opacity || 0.6,
            interactive: false,
            className: "forecast-color",
            attribution: ATTRIBUTION,
          }).addTo(map);
        } else {
          state.colorOverlay.setBounds(L.latLngBounds(bounds));
          state.colorOverlay.setOpacity(layer.opacity || 0.6);
        }
        softenCategories();
      } else if (state.colorOverlay) {
        map.removeLayer(state.colorOverlay);
        state.colorOverlay = null;
      }

      if (layer?.symbols) {
        const pair = data[layer.field];
        symbols.setSource(layer.symbols, (lats, lons) => applyPlan(planFor(state.meta.grid, lats, lons), pair, undefined, true));
        if (!map.hasLayer(symbols)) symbols.addTo(map);
        else symbols.redraw();
      } else if (map.hasLayer(symbols)) {
        map.removeLayer(symbols);
      }

      if (layer?.isobars) {
        const pair = smoothPair(data[layer.field], state.meta.grid);
        isobars.setSource((lats, lons) => applyPlan(planFor(state.meta.grid, lats, lons), pair), state.theme);
        if (!map.hasLayer(isobars)) isobars.addTo(map);
        else isobars.redraw();
      } else if (map.hasLayer(isobars)) {
        map.removeLayer(isobars);
      }

      if (showWind) {
        // White streaks read on colour and on the dark map; the light street map needs dark ones.
        const onColour = layer && !layer.isCloud;
        particles.setColor(onColour || state.theme === "dark" ? "rgba(255,255,255,0.85)" : "rgba(16,40,72,0.8)");
        particles.setSpeedScale(WIND_LEVELS[level].speed);
        const [uField, vField] = windFields();
        particles.setField((lats, lons) => {
          const plan = planFor(state.meta.grid, lats, lons);
          return { u: applyPlan(plan, data[uField]), v: applyPlan(plan, data[vField]) };
        });
        particles.setReducedMotion(reducedMotion.matches);
        if (!map.hasLayer(particles)) particles.addTo(map);
        else particles.reset();
      } else if (map.hasLayer(particles)) {
        map.removeLayer(particles);
      }

      renderLegend();
      renderTime();
      const run = new Date(state.meta.run);
      setStatus(`${state.meta.source}, ${state.meta.model}. Model run ${formatTime(run.getTime())}, published ${formatTime(Date.parse(state.meta.generatedAt), true)}. Steps are 3-hourly (6-hourly after day 6); hours in between are blended. Click the map for values.${layer?.note ? ` ${layer.note}` : ""}`);
      prefetch(fields);
    }

    // Category layers (storms, precipitation type) are blurred by about one and a half grid cells on screen,
    // so their areas look rounded rather than built from model grid squares. The canvas is stretched with
    // the zoom, so the blur is set from its on-screen size.
    function softenCategories() {
      const layer = LAYERS[state.layer];
      if (!state.colorOverlay || !layer?.nearest) {
        colorCanvas.style.filter = "";
        return;
      }
      const cellPixels = (parseFloat(colorCanvas.style.width) || colorCanvas.width) / state.meta.grid.nx;
      colorCanvas.style.filter = `blur(${Math.min(14, Math.max(1, cellPixels * 0.6)).toFixed(1)}px)`;
    }
    map.on("zoomend", softenCategories);

    function clearDrawing() {
      state.renderId += 1;
      if (state.colorOverlay) {
        map.removeLayer(state.colorOverlay);
        state.colorOverlay = null;
      }
      if (map.hasLayer(particles)) map.removeLayer(particles);
      if (map.hasLayer(symbols)) map.removeLayer(symbols);
      if (map.hasLayer(isobars)) map.removeLayer(isobars);
    }

    function renderLegend() {
      const layer = LAYERS[state.layer];
      if (!layer || !state.enabled || !state.meta || !hasData(layer)) {
        els.legend.hidden = true;
        return;
      }
      if (layer.categories) {
        els.legend.replaceChildren();
        const title = document.createElement("span");
        title.className = "map-legend-title";
        title.textContent = layer.label;
        const swatches = document.createElement("span");
        swatches.className = "map-legend-categories";
        layer.categories.forEach(([, name, colour]) => {
          const item = document.createElement("span");
          const dot = document.createElement("i");
          dot.style.background = colour;
          item.append(dot, name);
          swatches.append(item);
        });
        els.legend.append(title, swatches);
        els.legend.hidden = false;
        return;
      }
      const stops = state.theme === "light" && layer.lightStops ? layer.lightStops : layer.stops;
      const tempF = layer.unit === "°C" && options.getUnit?.() === "F";
      const first = stops[0][0];
      const last = stops[stops.length - 1][0];
      const position = (value) => ((value - first) / (last - first)) * 100;
      const gradient = stops.map(([value, colour, alpha = 1]) => `${rgba(colour, alpha)} ${position(value).toFixed(1)}%`).join(", ");
      // A layer can name its own labels (AQI shows its band edges); otherwise every other colour stop.
      const labels = layer.ticks ? layer.ticks.map((value) => [value]) : stops.filter((_, index) => index % 2 === 0 || index === stops.length - 1);
      const levelText = layer.byHeight ? ` · ${WIND_LEVELS[els.level.value].short}` : "";
      els.legend.replaceChildren();
      const title = document.createElement("span");
      title.className = "map-legend-title";
      title.textContent = `${layer.label}${levelText} (${tempF ? "°F" : layer.unit})`;
      const bar = document.createElement("span");
      bar.className = "map-legend-bar";
      bar.style.background = `linear-gradient(90deg, ${gradient})`;
      const ticks = document.createElement("span");
      ticks.className = "map-legend-ticks";
      labels.forEach(([value]) => {
        const tick = document.createElement("span");
        tick.style.left = `${position(value)}%`;
        tick.textContent = tempF ? String(Math.round((value * 9) / 5 + 32)) : String(value);
        ticks.append(tick);
      });
      els.legend.append(title, bar, ticks);
      els.legend.hidden = false;
    }

    // Day labels at local midnight and a small mark every model step along the timeline.
    function renderTicks() {
      const meta = state.meta;
      els.ticks.replaceChildren();
      const percent = (hour) => `${(hour / meta.lastHour) * 100}%`;
      // A week of "28 Wed" labels does not fit a phone-width bar, so narrow bars show just the weekday.
      const narrow = els.ticks.clientWidth > 0 && els.ticks.clientWidth / (meta.lastHour / 24) < 64;
      const dayFormat = new Intl.DateTimeFormat(undefined, narrow ? { weekday: "short", timeZone: API_TIMEZONE } : { weekday: "short", day: "numeric", timeZone: API_TIMEZONE });
      const hourFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: API_TIMEZONE });
      for (let hour = 0; hour <= meta.lastHour; hour += 1) {
        const time = new Date((meta.times[0] + hour * 3600) * 1000);
        const isMidnight = hourFormat.format(time) === "00";
        if (!isMidnight && !meta.offsets.includes(hour)) continue;
        const tick = document.createElement("span");
        tick.className = isMidnight ? "timeline-day" : "timeline-step";
        tick.style.left = percent(hour);
        if (isMidnight) tick.textContent = dayFormat.format(time);
        els.ticks.append(tick);
      }
      const now = (Date.now() / 1000 - meta.times[0]) / 3600;
      if (now >= 0 && now <= meta.lastHour) {
        const marker = document.createElement("span");
        marker.className = "timeline-now";
        marker.style.left = percent(now);
        marker.title = "Now";
        els.ticks.append(marker);
      }
    }

    function renderTime() {
      const ms = currentTime() * 1000;
      const offset = Math.round((ms - Date.now()) / 3_600_000);
      const relative = offset === 0 ? "now" : offset > 0 ? `+${offset} h` : `${offset} h`;
      els.time.textContent = `${new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", timeZone: API_TIMEZONE }).format(new Date(ms))} · ${relative}`;
      // Centre the bubble over the handle, but keep it inside the bar at either end.
      const fraction = state.hour / state.meta.lastHour;
      els.time.style.left = `${fraction * 100}%`;
      els.time.style.transform = `translateX(${fraction < 0.12 ? -10 : fraction > 0.88 ? -90 : -50}%)`;
      els.slider.setAttribute("aria-valuetext", formatTime(ms));
      options.onTimeChange?.(ms);
    }

    function startPlayback() {
      if (!state.meta || !state.enabled) return;
      if (state.hour >= state.meta.lastHour) state.hour = 0;
      setPlayIcon(true);
      state.playTimer = setInterval(() => {
        if (state.hour >= state.meta.lastHour) {
          stopPlayback();
          return;
        }
        // A week plays in 3-hour jumps so it takes about 25 s; shorter forecasts go hour by hour.
        state.hour = Math.min(state.meta.lastHour, state.hour + (state.meta.lastHour > 72 ? 3 : 1));
        els.slider.value = String(state.hour);
        render();
      }, PLAY_STEP_MS);
    }

    function stopPlayback() {
      clearInterval(state.playTimer);
      state.playTimer = null;
      setPlayIcon(false);
    }

    function setPlayIcon(playing) {
      els.play.setAttribute("aria-label", playing ? "Pause forecast" : "Play forecast");
      els.play.innerHTML = window.AtmosIcons?.ui(playing ? "pause" : "play") || (playing ? "Pause" : "Play");
    }

    // ── Picker (Windy-style) ────────────────────────────────────────────────
    // A draggable pin whose bubble shows the chosen layer's value and the wind at that point for the map's
    // time, updating while it is dragged. Tapping the bubble opens the point forecast.
    function insideGrid(lat, lng) {
      const { north, west, step, nx, ny } = state.meta.grid;
      return !(lat > north + step / 2 || lat < north - (ny - 1) * step - step / 2 || lng < west - step / 2 || lng > west + (nx - 1) * step + step / 2);
    }

    function setPicker(lat, lon) {
      picker.lat = lat;
      picker.lon = lon;
      if (!picker.marker) {
        picker.marker = L.marker([lat, lon], {
          draggable: true,
          keyboard: false,
          zIndexOffset: 1000,
          icon: L.divIcon({
            className: "map-picker",
            html: '<button class="picker-bubble" type="button" aria-label="Forecast for this place"><span class="picker-value">…</span><span class="picker-wind"></span><span class="picker-more" aria-hidden="true">›</span></button><span class="picker-dot"></span>',
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
        });
        picker.marker.on("drag", (event) => {
          const position = event.target.getLatLng();
          picker.lat = position.lat;
          picker.lon = position.lng;
          updatePicker();
        });
        picker.marker.on("dragend", () => options.onPickerMoved?.(picker.lat, picker.lon));
        picker.marker.on("add", () => {
          const bubble = picker.marker.getElement()?.querySelector(".picker-bubble");
          if (!bubble) return;
          L.DomEvent.disableClickPropagation(bubble);
          bubble.addEventListener("click", () => options.onPickerOpen?.(picker.lat, picker.lon));
          updatePicker();
        });
        picker.marker.addTo(map);
      } else {
        picker.marker.setLatLng([lat, lon]);
        if (!map.hasLayer(picker.marker)) picker.marker.addTo(map);
      }
      updatePicker();
    }

    function setTimeTo(ms) {
      if (!state.meta) return;
      stopPlayback();
      state.hour = Math.min(state.meta.lastHour, Math.max(0, Math.round((ms / 1000 - state.meta.times[0]) / 3600)));
      els.slider.value = String(state.hour);
      render();
    }

    // Short unit for the bubble: "mm since the run started" → "mm", "hPa, lines every 4" → "hPa".
    function shortUnit(layer) {
      return layer.short || layer.unit.split(",")[0].split(" ")[0];
    }

    function updatePicker() {
      const node = picker.marker?.getElement();
      if (!node) return;
      const valueNode = node.querySelector(".picker-value");
      const windNode = node.querySelector(".picker-wind");
      // Another layer (the infrared satellite) can supply the reading instead: { value, detail }.
      const other = options.pickerReading?.(picker.lat, picker.lon);
      if (other) {
        valueNode.textContent = other.value;
        windNode.replaceChildren(other.detail || "");
        return;
      }
      const data = state.lastData;
      if (!data || !state.meta || !insideGrid(picker.lat, picker.lon)) {
        valueNode.textContent = "Forecast";
        windNode.replaceChildren();
        return;
      }
      const level = els.level.value;
      const plan = buildPlan(state.meta.grid, new Float64Array([picker.lat]), new Float64Array([picker.lon]));
      const at = (field, nearest = false) => (data[field] ? applyPlan(plan, data[field], undefined, nearest)[0] : NaN);
      const [uField, vField] = windFields();
      const u = at(uField);
      const v = at(vField);
      const speed = Math.hypot(u, v) * 3.6;
      const layer = hasData(LAYERS[state.layer]) ? LAYERS[state.layer] : null;
      let reading = "";
      if (layer && !layer.field) {
        reading = Number.isNaN(speed) ? "—" : `${Math.round(speed)} km/h`;
      } else if (layer?.categories) {
        const category = layer.categories.find(([value]) => value === Math.round(at(layer.field, true)));
        reading = category ? category[1] : state.layer === "storm" ? "No storms" : "Dry";
      } else if (layer) {
        let value = at(layerField(layer, level));
        if (layer.convert) value = layer.convert(value);
        if (Number.isNaN(value)) reading = "—";
        else if (layer.unit === "°C") reading = options.getUnit?.() === "F" ? `${Math.round((value * 9) / 5 + 32)}°F` : `${Math.round(value)}°C`;
        else if (state.layer === "aqi") reading = `AQI ${Math.round(value)}`;
        else if (state.layer === "freezing") reading = value < 50 ? "At ground" : `${(Math.round(value / 50) * 50).toLocaleString()} m`;
        else reading = `${value < 10 && /mm|cm/.test(layer.unit) ? value.toFixed(1) : Math.round(value).toLocaleString()} ${shortUnit(layer)}`;
      }
      valueNode.textContent = reading || "Forecast";
      windNode.replaceChildren();
      // With the wind layer the speed is already the main value; otherwise wind is the second line.
      if (!Number.isNaN(speed) && (!layer || layer.field)) {
        const arrow = document.createElement("span");
        arrow.className = "picker-arrow";
        arrow.textContent = "↑";
        // The arrow points where the wind blows to.
        arrow.style.transform = `rotate(${(Math.atan2(u, v) * 180) / Math.PI}deg)`;
        windNode.append(arrow, `${Math.round(speed)} km/h`);
      }
    }

    function setStatus(message) {
      els.status.textContent = message;
    }
  }

  // ── Grid sampling ──────────────────────────────────────────────────────────

  // The stored field a colour layer reads; height-aware layers (temperature) depend on the height picker.
  function layerField(layer, level) {
    return typeof layer.field === "function" ? layer.field(level) : layer.field;
  }

  // Byte → value table for one field (see the pipeline's encoding notes).
  function decodeTable(spec, missing) {
    const table = new Float32Array(256);
    for (let code = 0; code < 256; code += 1) {
      table[code] = code === missing ? NaN : spec.encoding === "sqrt" ? (code * spec.scale) ** 2 : spec.offset + code * spec.scale;
    }
    return table;
  }

  // A plan records, for a fixed set of points, where each falls in the grid. Building it is the slow part;
  // applying it to any field and hour is a few array reads per point, which keeps stepping through hours fast.
  function buildPlan(grid, lats, lons) {
    const count = lats.length;
    const { north, west, step, nx, ny } = grid;
    const base = new Int32Array(count).fill(-1);
    const dx = new Uint8Array(count);
    const dy = new Int32Array(count);
    const tx = new Float32Array(count);
    const ty = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const fx = (lons[index] - west) / step;
      const fy = (north - lats[index]) / step;
      if (fx < -0.5 || fy < -0.5 || fx > nx - 0.5 || fy > ny - 0.5) continue;
      const x = Math.min(Math.max(fx, 0), nx - 1);
      const y = Math.min(Math.max(fy, 0), ny - 1);
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      base[index] = y0 * nx + x0;
      dx[index] = x0 + 1 < nx ? 1 : 0;
      dy[index] = y0 + 1 < ny ? nx : 0;
      tx[index] = x - x0;
      ty[index] = y - y0;
    }
    return { count, base, dx, dy, tx, ty };
  }

  // Plans are reused while the grid and the points are the same arrays.
  const plans = new WeakMap();
  function planFor(grid, lats, lons) {
    const cached = plans.get(lats);
    if (cached && cached.grid === grid && cached.lons === lons) return cached.plan;
    const plan = buildPlan(grid, lats, lons);
    plans.set(lats, { grid, lons, plan });
    return plan;
  }

  // Categories from the nearest grid cell and step; where that cell has none but a neighbour does, the
  // neighbour's (highest) category, so the soft edge drawn from presencePair has a colour.
  function applyCategoryPlan(plan, pair, out = new Float32Array(plan.count)) {
    if (!pair) return out.fill(NaN);
    const { a, b, weight } = pair;
    const source = b && weight >= 0.5 ? b : a;
    for (let index = 0; index < plan.count; index += 1) {
      const base = plan.base[index];
      if (base < 0) {
        out[index] = NaN;
        continue;
      }
      const dx = plan.dx[index];
      const dy = plan.dy[index];
      let value = source[base + (plan.tx[index] >= 0.5 ? dx : 0) + (plan.ty[index] >= 0.5 ? dy : 0)];
      if (!(value >= 0.5)) value = Math.max(source[base] || 0, source[base + dx] || 0, source[base + dy] || 0, source[base + dy + dx] || 0);
      out[index] = value;
    }
    return out;
  }

  // 1 where a category is present, 0 elsewhere; blending it gives smooth area outlines.
  const presenceArrays = new WeakMap();
  function presenceOf(values) {
    if (!values) return values;
    let presence = presenceArrays.get(values);
    if (!presence) {
      presence = new Float32Array(values.length);
      for (let index = 0; index < values.length; index += 1) presence[index] = values[index] >= 0.5 ? 1 : 0;
      presenceArrays.set(values, presence);
    }
    return presence;
  }
  function presencePair(pair) {
    return pair && { a: presenceOf(pair.a), b: presenceOf(pair.b), weight: pair.weight };
  }

  // Values of one field for every point in the plan, blended between the two steps around the current hour.
  // With `nearest`, categories are taken from the closest grid cell and model step instead of blended.
  function applyPlan(plan, pair, out = new Float32Array(plan.count), nearest = false) {
    if (!pair) return out.fill(NaN);
    const { a, b, weight } = pair;
    if (nearest) {
      const source = b && weight >= 0.5 ? b : a;
      for (let index = 0; index < plan.count; index += 1) {
        const base = plan.base[index];
        out[index] = base < 0 ? NaN : source[base + (plan.tx[index] >= 0.5 ? plan.dx[index] : 0) + (plan.ty[index] >= 0.5 ? plan.dy[index] : 0)];
      }
      return out;
    }
    for (let index = 0; index < plan.count; index += 1) {
      const base = plan.base[index];
      if (base < 0) {
        out[index] = NaN;
        continue;
      }
      const dx = plan.dx[index];
      const dy = plan.dy[index];
      const tx = plan.tx[index];
      const ty = plan.ty[index];
      const first = (a[base] * (1 - tx) + a[base + dx] * tx) * (1 - ty) + (a[base + dy] * (1 - tx) + a[base + dy + dx] * tx) * ty;
      if (!b || weight === 0) {
        out[index] = first;
        continue;
      }
      const second = (b[base] * (1 - tx) + b[base + dx] * tx) * (1 - ty) + (b[base + dy] * (1 - tx) + b[base + dy + dx] * tx) * ty;
      out[index] = first * (1 - weight) + second * weight;
    }
    return out;
  }

  // Pixel layout of the colour canvas (Web Mercator, so each row sits at its true latitude) and its plan.
  const colorGeometries = new WeakMap();
  function colorGeometry(grid) {
    if (colorGeometries.has(grid)) return colorGeometries.get(grid);
    const { north, west, step, nx, ny } = grid;
    const half = step / 2;
    const top = north + half;
    const bottom = north - (ny - 1) * step - half;
    const left = west - half;
    const right = west + (nx - 1) * step + half;
    const mercator = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const yTop = mercator(top);
    const yBottom = mercator(bottom);
    const width = COLOR_WIDTH;
    const height = Math.max(1, Math.round((width * (yTop - yBottom)) / (((right - left) * Math.PI) / 180)));
    const lats = new Float64Array(width * height);
    const lons = new Float64Array(width * height);
    // How far each pixel is from the outer edge, used to fade the field into the map over one degree.
    const edge = new Float32Array(width * height);
    const fade = 1 / step;
    for (let row = 0; row < height; row += 1) {
      const y = yTop - ((row + 0.5) / height) * (yTop - yBottom);
      const lat = ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
      const fy = (north - lat) / step;
      const edgeY = Math.min(fy + 0.5, ny - 0.5 - fy) / fade;
      for (let col = 0; col < width; col += 1) {
        const lon = left + ((col + 0.5) / width) * (right - left);
        const fx = (lon - west) / step;
        const index = row * width + col;
        lats[index] = lat;
        lons[index] = lon;
        edge[index] = Math.min(1, Math.max(0, Math.min(edgeY, (fx + 0.5) / fade, (nx - 0.5 - fx) / fade)));
      }
    }
    const geometry = { width, height, edge, plan: buildPlan(grid, lats, lons), bounds: [[bottom, left], [top, right]] };
    colorGeometries.set(grid, geometry);
    return geometry;
  }

  // Draws the field into `canvas` and returns the map bounds it covers. The canvas is reused for every hour and layer.
  function drawColorField(canvas, meta, data, layerKey, level, theme) {
    const layer = LAYERS[layerKey];
    const geometry = colorGeometry(meta.grid);
    const { width, height, plan, edge } = geometry;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    let values;
    let mask = null;
    if (!layer.field) {
      const u = applyPlan(plan, data[`u${level}`]);
      const v = applyPlan(plan, data[`v${level}`]);
      values = u;
      for (let index = 0; index < values.length; index += 1) values[index] = Math.hypot(u[index], v[index]) * 3.6;
    } else {
      values = layer.nearest ? applyCategoryPlan(plan, data[layerField(layer, level)]) : applyPlan(plan, data[layerField(layer, level)]);
      if (layer.nearest) mask = applyPlan(plan, presencePair(data[layerField(layer, level)]));
      if (layer.convert) for (let index = 0; index < values.length; index += 1) values[index] = layer.convert(values[index]);
    }

    const context = canvas.getContext("2d");
    const image = context.createImageData(width, height);
    const pixels = image.data;
    const colours = colorTable(layerKey, theme);
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (Number.isNaN(value) || value < colours.transparentBelow) continue;
      const entry = Math.min(colours.size - 1, Math.max(0, Math.round(((value - colours.first) / colours.span) * (colours.size - 1)))) * 4;
      const pixel = index * 4;
      pixels[pixel] = colours.table[entry];
      pixels[pixel + 1] = colours.table[entry + 1];
      pixels[pixel + 2] = colours.table[entry + 2];
      // Category areas get soft, rounded edges from the blended presence instead of square grid cells.
      const soft = mask ? Math.min(1, Math.max(0, (mask[index] - 0.25) / 0.3)) : 1;
      pixels[pixel + 3] = colours.table[entry + 3] * edge[index] * soft;
    }
    context.putImageData(image, 0, 0);
    return geometry.bounds;
  }

  // Precomputed colour scale (1,024 steps) per layer and theme, so a pixel's colour is one table read.
  const colorTables = new Map();
  function colorTable(layerKey, theme) {
    const key = `${layerKey}:${theme}`;
    if (colorTables.has(key)) return colorTables.get(key);
    const layer = LAYERS[layerKey];
    const stops = theme === "light" && layer.lightStops ? layer.lightStops : layer.stops;
    const lookup = colorLookup(stops);
    const size = 1024;
    const first = stops[0][0];
    const span = stops[stops.length - 1][0] - first;
    const table = new Uint8ClampedArray(size * 4);
    for (let index = 0; index < size; index += 1) {
      const colour = lookup(first + (span * index) / (size - 1));
      table.set([colour[0], colour[1], colour[2], Math.round(colour[3] * 255)], index * 4);
    }
    const result = { table, size, first, span, transparentBelow: layer.transparentBelow ?? -Infinity };
    colorTables.set(key, result);
    return result;
  }

  function formatTime(ms, timeOnly) {
    const options = timeOnly
      ? { hour: "numeric", minute: "2-digit", timeZone: API_TIMEZONE, timeZoneName: "short" }
      : { weekday: "short", day: "numeric", month: "short", hour: "numeric", timeZone: API_TIMEZONE, timeZoneName: "short" };
    return new Intl.DateTimeFormat(undefined, options).format(new Date(ms));
  }

  function colorLookup(rawStops, transparentBelow = -Infinity) {
    const stops = rawStops.map(([value, hex, alpha = 1]) => [value, [...[1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)), alpha]]);
    return (value) => {
      if (value < transparentBelow) return null;
      if (value <= stops[0][0]) return stops[0][1];
      for (let index = 1; index < stops.length; index += 1) {
        if (value <= stops[index][0]) {
          const [v0, c0] = stops[index - 1];
          const [v1, c1] = stops[index];
          const t = (value - v0) / (v1 - v0);
          return [0, 1, 2, 3].map((channel) => {
            const mixed = c0[channel] + (c1[channel] - c0[channel]) * t;
            return channel === 3 ? mixed : Math.round(mixed);
          });
        }
      }
      return stops[stops.length - 1][1];
    };
  }

  function rgba(hex, alpha) {
    const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }


  // ── Animated wind particles ────────────────────────────────────────────────

  // Leaflet loads only when Maps first opens, so the layer class is built on first use.
  // Weather symbols spread over a category layer on a screen grid, redrawn after every pan, zoom or hour.
  const SYMBOL_SPACING = 58;
  const SYMBOL_SIZE = 32;
  const symbolImages = new Map();
  let SymbolLayerClass = null;

  function createSymbolLayer(options) {
    SymbolLayerClass ||= L.Layer.extend({
      initialize(layerOptions) {
        L.setOptions(this, layerOptions);
        this._symbols = null;
        this._sample = null;
      },

      onAdd(map) {
        this._map = map;
        this._canvas = L.DomUtil.create("canvas", "forecast-symbols");
        this.getPane().appendChild(this._canvas);
        map.on("moveend resize", this.redraw, this);
        map.on("movestart", this._clear, this);
        this.redraw();
      },

      onRemove(map) {
        map.off("moveend resize", this.redraw, this);
        map.off("movestart", this._clear, this);
        this._canvas.remove();
        this._canvas = null;
      },

      // `symbols` maps a category to [weather code, hail]; `sample(lats, lons)` returns the categories.
      setSource(symbolMap, sample) {
        this._symbols = symbolMap;
        this._sample = sample;
      },

      _clear() {
        this._canvas?.getContext("2d").clearRect(0, 0, this._canvas.width, this._canvas.height);
      },

      _image(category) {
        const [code, hail] = this._symbols[category] || [];
        if (code === undefined || !window.AtmosIcons) return null;
        const key = `${code}:${hail ? 1 : 0}`;
        let image = symbolImages.get(key);
        if (!image) {
          image = new Image();
          image.onload = () => this.redraw();
          image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(window.AtmosIcons.weather(code, true, Boolean(hail)))}`;
          symbolImages.set(key, image);
        }
        return image.complete && image.naturalWidth ? image : null;
      },

      redraw() {
        if (!this._map || !this._canvas || !this._sample) return;
        const map = this._map;
        const size = map.getSize();
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        this._canvas.width = Math.round(size.x * ratio);
        this._canvas.height = Math.round(size.y * ratio);
        this._canvas.style.width = `${size.x}px`;
        this._canvas.style.height = `${size.y}px`;
        L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]));
        const context = this._canvas.getContext("2d");
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        // Rows are staggered so the symbols don't line up in columns. Grid positions follow the map, so
        // symbols stay put on the ground while panning instead of sliding with the screen.
        const origin = map.getPixelOrigin().add(map.containerPointToLayerPoint([0, 0]));
        const points = [];
        const firstRow = Math.floor(origin.y / SYMBOL_SPACING);
        for (let row = firstRow; row * SYMBOL_SPACING - origin.y < size.y + SYMBOL_SPACING; row += 1) {
          const shift = (row & 1) * (SYMBOL_SPACING / 2);
          const firstCol = Math.floor((origin.x - shift) / SYMBOL_SPACING);
          for (let col = firstCol; col * SYMBOL_SPACING + shift - origin.x < size.x + SYMBOL_SPACING; col += 1) {
            points.push([col * SYMBOL_SPACING + shift - origin.x, row * SYMBOL_SPACING - origin.y]);
          }
        }
        const lats = new Float64Array(points.length);
        const lons = new Float64Array(points.length);
        points.forEach(([x, y], index) => {
          const point = map.containerPointToLatLng([x, y]);
          lats[index] = point.lat;
          lons[index] = point.lng;
        });
        const categories = this._sample(lats, lons);
        points.forEach(([x, y], index) => {
          const category = Math.round(categories[index]);
          if (!(category >= 1)) return;
          const image = this._image(category);
          if (!image) return;
          // A faint dark disc keeps white clouds and snowflakes readable on light colours such as snow.
          context.shadowBlur = 0;
          context.fillStyle = "rgba(8, 22, 44, 0.42)";
          context.beginPath();
          context.arc(x, y + 1, SYMBOL_SIZE * 0.5, 0, Math.PI * 2);
          context.fill();
          context.shadowColor = "rgba(0, 10, 30, 0.5)";
          context.shadowBlur = 3;
          context.drawImage(image, x - SYMBOL_SIZE / 2, y - SYMBOL_SIZE / 2, SYMBOL_SIZE, SYMBOL_SIZE);
        });
      },
    });
    return new SymbolLayerClass(options);
  }

  function readParticleStyle() {
    try {
      const saved = JSON.parse(localStorage.getItem(PARTICLE_STYLE_KEY) || "{}");
      const style = { ...PARTICLE_STYLE_DEFAULT };
      Object.keys(style).forEach((key) => {
        if (Number.isFinite(saved[key]) && saved[key] > 0) style[key] = saved[key];
      });
      return style;
    } catch {
      return { ...PARTICLE_STYLE_DEFAULT };
    }
  }

  // ── Isobars, Windy-style ────────────────────────────────────────────────────
  // Pressure is sampled on a fine screen grid for the current view and contoured with marching squares, so the
  // lines are smooth at every zoom. Numbers sit along the lines, and H and L mark highs and lows that stand out
  // from their surroundings. Redrawn after every pan, zoom or hour, like the weather symbols.
  const ISOBAR_STRIDE = 6;
  const ISOBAR_SMOOTH_CELLS = 4;
  const ISOBAR_LABEL_GAP = 210;
  const PRESSURE_CENTRE_RADIUS = 150;
  let IsobarLayerClass = null;

  // Sea-level pressure is noisy over high ground (it is extrapolated down through the mountains), which would
  // give squiggles and stray H and L marks. Like Windy, the isobars use a smoothed copy: two box blurs of
  // ISOBAR_SMOOTH_CELLS grid cells (about 1°) each way, skipping cells without data. Cached per step.
  const smoothedFields = new WeakMap();
  function smoothField(values, grid) {
    if (!values) return values;
    if (smoothedFields.has(values)) return smoothedFields.get(values);
    const { nx, ny } = grid;
    let source = values;
    for (let pass = 0; pass < 2; pass += 1) {
      for (const horizontal of [true, false]) {
        const out = new Float32Array(nx * ny);
        for (let row = 0; row < ny; row += 1) {
          for (let col = 0; col < nx; col += 1) {
            let sum = 0;
            let count = 0;
            for (let offset = -ISOBAR_SMOOTH_CELLS; offset <= ISOBAR_SMOOTH_CELLS; offset += 1) {
              const c = horizontal ? col + offset : col;
              const r = horizontal ? row : row + offset;
              if (c < 0 || r < 0 || c >= nx || r >= ny) continue;
              const value = source[r * nx + c];
              if (Number.isNaN(value)) continue;
              sum += value;
              count += 1;
            }
            out[row * nx + col] = Number.isNaN(source[row * nx + col]) || !count ? NaN : sum / count;
          }
        }
        source = out;
      }
    }
    smoothedFields.set(values, source);
    return source;
  }
  function smoothPair(pair, grid) {
    return pair && { a: smoothField(pair.a, grid), b: smoothField(pair.b, grid), weight: pair.weight };
  }

  function createIsobarLayer(options) {
    IsobarLayerClass ||= L.Layer.extend({
      initialize(layerOptions) {
        L.setOptions(this, layerOptions);
        this._sample = null;
        this._theme = "dark";
      },

      onAdd(map) {
        this._map = map;
        this._canvas = L.DomUtil.create("canvas", "forecast-isobars");
        this.getPane().appendChild(this._canvas);
        map.on("moveend resize", this.redraw, this);
        map.on("movestart", this._clear, this);
        this.redraw();
      },

      onRemove(map) {
        map.off("moveend resize", this.redraw, this);
        map.off("movestart", this._clear, this);
        this._canvas.remove();
        this._canvas = null;
      },

      // `sample(lats, lons)` returns sea-level pressure in hPa for those points (NaN outside the forecast).
      setSource(sample, theme) {
        this._sample = sample;
        this._theme = theme;
      },

      _clear() {
        this._canvas?.getContext("2d").clearRect(0, 0, this._canvas.width, this._canvas.height);
      },

      redraw() {
        if (!this._map || !this._canvas || !this._sample) return;
        const map = this._map;
        const size = map.getSize();
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        this._canvas.width = Math.round(size.x * ratio);
        this._canvas.height = Math.round(size.y * ratio);
        this._canvas.style.width = `${size.x}px`;
        this._canvas.style.height = `${size.y}px`;
        L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]));
        const context = this._canvas.getContext("2d");
        context.setTransform(ratio, 0, 0, ratio, 0, 0);

        const columns = Math.ceil(size.x / ISOBAR_STRIDE) + 1;
        const rows = Math.ceil(size.y / ISOBAR_STRIDE) + 1;
        const viewKey = `${map.getBounds().toBBoxString()}|${map.getZoom()}|${columns}x${rows}`;
        if (this._viewKey !== viewKey) {
          this._viewKey = viewKey;
          this._lats = new Float64Array(columns * rows);
          this._lons = new Float64Array(columns * rows);
          for (let row = 0; row < rows; row += 1) {
            for (let col = 0; col < columns; col += 1) {
              const point = map.containerPointToLatLng([col * ISOBAR_STRIDE, row * ISOBAR_STRIDE]);
              this._lats[row * columns + col] = point.lat;
              this._lons[row * columns + col] = point.lng;
            }
          }
        }
        const values = this._sample(this._lats, this._lons);
        const light = this._theme === "light";
        const segments = this._contour(values, columns, rows);

        // Lines: thin, with every 20 hPa a little stronger, as on Windy.
        context.lineCap = "round";
        context.lineJoin = "round";
        for (const major of [false, true]) {
          context.beginPath();
          for (const [level, x1, y1, x2, y2] of segments) {
            if ((level % 20 === 0) !== major) continue;
            context.moveTo(x1, y1);
            context.lineTo(x2, y2);
          }
          context.strokeStyle = light ? `rgba(20, 34, 56, ${major ? 0.85 : 0.6})` : `rgba(255, 255, 255, ${major ? 0.9 : 0.6})`;
          context.lineWidth = major ? 1.6 : 1;
          context.stroke();
        }
        this._labels(context, segments, size, light);
        this._centres(context, values, columns, rows, size, light);
      },

      // Marching squares over the screen grid: one short segment per cell crossing per level.
      _contour(values, columns, rows) {
        const segments = [];
        const at = (col, row) => values[row * columns + col];
        for (let row = 0; row < rows - 1; row += 1) {
          for (let col = 0; col < columns - 1; col += 1) {
            const a = at(col, row);
            const b = at(col + 1, row);
            const c = at(col + 1, row + 1);
            const d = at(col, row + 1);
            if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) continue;
            const low = Math.min(a, b, c, d);
            const high = Math.max(a, b, c, d);
            const x = col * ISOBAR_STRIDE;
            const y = row * ISOBAR_STRIDE;
            for (let level = Math.ceil(low / ISOBAR_STEP_HPA) * ISOBAR_STEP_HPA; level <= high; level += ISOBAR_STEP_HPA) {
              if (level === high) continue;
              // Crossing points on the cell's four edges (top, right, bottom, left).
              const points = [];
              const edge = (v1, v2, x1, y1, x2, y2) => {
                if ((v1 < level) === (v2 < level)) return;
                const t = (level - v1) / (v2 - v1);
                points.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
              };
              const s = ISOBAR_STRIDE;
              edge(a, b, x, y, x + s, y);
              edge(b, c, x + s, y, x + s, y + s);
              edge(c, d, x + s, y + s, x, y + s);
              edge(d, a, x, y + s, x, y);
              if (points.length === 2) segments.push([level, ...points[0], ...points[1]]);
              else if (points.length === 4) {
                // Saddle: pair the crossings by the cell's middle value.
                const middleLow = (a + b + c + d) / 4 < level;
                const aLow = a < level;
                if (middleLow === aLow) {
                  segments.push([level, ...points[0], ...points[1]], [level, ...points[2], ...points[3]]);
                } else {
                  segments.push([level, ...points[0], ...points[3]], [level, ...points[1], ...points[2]]);
                }
              }
            }
          }
        }
        return segments;
      },

      // Pressure numbers along the lines, spread out so they never crowd, on a small dark tag.
      _labels(context, segments, size, light) {
        const placed = [];
        const margin = 36;
        context.font = "600 10px 'DM Sans', system-ui, sans-serif";
        context.textAlign = "center";
        context.textBaseline = "middle";
        for (let index = 0; index < segments.length; index += 7) {
          const [level, x1, y1, x2, y2] = segments[index];
          const x = (x1 + x2) / 2;
          const y = (y1 + y2) / 2;
          if (x < margin || y < margin || x > size.x - margin || y > size.y - margin) continue;
          if (placed.some(([px, py, plevel]) => Math.hypot(px - x, py - y) < (plevel === level ? ISOBAR_LABEL_GAP * 1.6 : ISOBAR_LABEL_GAP * 0.45))) continue;
          placed.push([x, y, level]);
          const text = String(level);
          const width = context.measureText(text).width + 8;
          context.fillStyle = light ? "rgba(255, 255, 255, 0.88)" : "rgba(10, 24, 46, 0.78)";
          context.beginPath();
          if (context.roundRect) context.roundRect(x - width / 2, y - 7.5, width, 15, 4);
          else context.rect(x - width / 2, y - 7.5, width, 15);
          context.fill();
          context.fillStyle = light ? "#14223a" : "#ffffff";
          context.fillText(text, x, y + 0.5);
        }
      },

      // H and L where the pressure is the highest or lowest within PRESSURE_CENTRE_RADIUS pixels and stands
      // at least 2 hPa clear of the edge of that circle, so flat areas don't get letters.
      _centres(context, values, columns, rows, size, light) {
        const reach = Math.round(PRESSURE_CENTRE_RADIUS / ISOBAR_STRIDE);
        const step = 2;
        const found = [];
        for (let row = reach; row < rows - reach; row += step) {
          for (let col = reach; col < columns - reach; col += step) {
            const here = values[row * columns + col];
            if (Number.isNaN(here)) continue;
            let isHigh = true;
            let isLow = true;
            let lowest = here;
            let highest = here;
            for (let dy = -reach; dy <= reach && (isHigh || isLow); dy += step) {
              for (let dx = -reach; dx <= reach; dx += step) {
                if (dx * dx + dy * dy > reach * reach || (!dx && !dy)) continue;
                const value = values[(row + dy) * columns + col + dx];
                if (Number.isNaN(value)) continue;
                if (value >= here) isHigh = false;
                if (value <= here) isLow = false;
                lowest = Math.min(lowest, value);
                highest = Math.max(highest, value);
              }
            }
            if (isHigh && here - lowest >= 2) found.push(["H", col, row, here]);
            else if (isLow && highest - here >= 2) found.push(["L", col, row, here]);
          }
        }
        context.textAlign = "center";
        context.textBaseline = "middle";
        for (const [letter, col, row, value] of found) {
          const x = col * ISOBAR_STRIDE;
          const y = row * ISOBAR_STRIDE;
          context.shadowColor = light ? "rgba(255, 255, 255, 0.9)" : "rgba(0, 10, 30, 0.85)";
          context.shadowBlur = 6;
          context.font = "800 22px 'Manrope', system-ui, sans-serif";
          context.fillStyle = letter === "H" ? (light ? "#1c4fb8" : "#9fd3ff") : (light ? "#b3202c" : "#ff9a9a");
          context.fillText(letter, x, y - 6);
          context.font = "650 10px 'DM Sans', system-ui, sans-serif";
          context.fillStyle = light ? "#14223a" : "#ffffff";
          context.fillText(String(Math.round(value)), x, y + 11);
          context.shadowBlur = 0;
        }
      },
    });
    return new IsobarLayerClass(options);
  }

  let ParticleLayerClass = null;

  function createParticleLayer(options) {
    ParticleLayerClass ||= particleLayerClass();
    return new ParticleLayerClass(options);
  }

  function particleLayerClass() {
    const ParticleLayer = L.Layer.extend({
      initialize(options) {
        L.setOptions(this, options);
        this._field = null;
        this._color = "rgba(255,255,255,0.85)";
        this._reducedMotion = false;
        this._speedScale = 1;
        this._style = { ...PARTICLE_STYLE_DEFAULT };
        this._frame = 0;
      },

      onAdd(map) {
        this._map = map;
        this._canvas = L.DomUtil.create("canvas", "forecast-particles");
        this.getPane().appendChild(this._canvas);
        map.on("movestart", this._onMoveStart, this);
        map.on("moveend resize", this.reset, this);
        document.addEventListener("visibilitychange", this._onVisibility);
        this.reset();
      },

      onRemove(map) {
        this.stop();
        map.off("movestart", this._onMoveStart, this);
        map.off("moveend resize", this.reset, this);
        document.removeEventListener("visibilitychange", this._onVisibility);
        this._canvas.remove();
        this._canvas = null;
      },

      // `field(lats, lons)` returns { u, v } arrays in m/s for those points, NaN where there is no data.
      setField(field) {
        this._field = field;
      },

      setColor(color) {
        this._color = color;
      },

      setReducedMotion(reduced) {
        this._reducedMotion = reduced;
      },

      // Upper-level winds are several times faster than surface wind; scale them down to stay readable.
      setSpeedScale(scale) {
        this._speedScale = scale;
      },

      // { speed, length, thickness, density } multipliers from Map settings.
      setStyle(style) {
        this._style = { ...PARTICLE_STYLE_DEFAULT, ...style };
      },

      stop() {
        if (this._frame) cancelAnimationFrame(this._frame);
        this._frame = 0;
      },

      _onMoveStart() {
        this.stop();
        this._context?.clearRect(0, 0, this._canvas.width, this._canvas.height);
      },

      _onVisibility: null,

      // Rebuilds the screen-space wind field for the current view, then restarts the animation.
      reset() {
        if (!this._map || !this._canvas || !this._field) return;
        this.stop();
        const map = this._map;
        const size = map.getSize();
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        this._canvas.width = Math.round(size.x * ratio);
        this._canvas.height = Math.round(size.y * ratio);
        this._canvas.style.width = `${size.x}px`;
        this._canvas.style.height = `${size.y}px`;
        L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]));
        this._context = this._canvas.getContext("2d");
        this._context.setTransform(ratio, 0, 0, ratio, 0, 0);
        this._width = size.x;
        this._height = size.y;

        // Screen speed grows gently with zoom so particles stay readable at every scale.
        const style = this._style;
        const speed = 0.11 * this._speedScale * style.speed * Math.pow(1.25, map.getZoom() - 5);
        // Longer trails fade more slowly, and their particles live longer so the trail has time to grow.
        this._fade = `rgba(0, 0, 0, ${(1 - 0.08 / style.length).toFixed(3)})`;
        this._maxAge = Math.round(PARTICLE_MAX_AGE * Math.max(0.7, style.length));
        this._lineWidth = 1.1 * style.thickness;
        const columns = Math.ceil(size.x / FIELD_STRIDE) + 1;
        const rows = Math.ceil(size.y / FIELD_STRIDE) + 1;
        // Sample positions depend only on the view, so changing the forecast hour reuses them.
        const viewKey = `${map.getBounds().toBBoxString()}|${map.getZoom()}|${columns}x${rows}`;
        if (this._viewKey !== viewKey) {
          this._viewKey = viewKey;
          this._lats = new Float64Array(columns * rows);
          this._lons = new Float64Array(columns * rows);
          for (let row = 0; row < rows; row += 1) {
            for (let col = 0; col < columns; col += 1) {
              const point = map.containerPointToLatLng([col * FIELD_STRIDE, row * FIELD_STRIDE]);
              this._lats[row * columns + col] = point.lat;
              this._lons[row * columns + col] = point.lng;
            }
          }
        }
        const { u, v } = this._field(this._lats, this._lons);
        const field = new Float32Array(columns * rows * 2);
        for (let index = 0; index < columns * rows; index += 1) {
          field[index * 2] = u[index] * speed;
          field[index * 2 + 1] = -v[index] * speed;
        }
        this._screen = { field, columns, rows };

        const count = Math.round(Math.min(3000 * this._style.density, ((size.x * size.y) / 200) * this._style.density));
        this._particles = Array.from({ length: count }, () => this._spawn({}, true));
        this._context.clearRect(0, 0, size.x, size.y);
        if (this._reducedMotion) this._drawStatic();
        else if (!document.hidden) this._animate();
      },

      _spawn(particle, randomAge) {
        particle.x = Math.random() * this._width;
        particle.y = Math.random() * this._height;
        particle.age = randomAge ? Math.floor(Math.random() * this._maxAge) : 0;
        return particle;
      },

      _velocity(x, y) {
        const { field, columns, rows } = this._screen;
        const col = Math.round(x / FIELD_STRIDE);
        const row = Math.round(y / FIELD_STRIDE);
        if (col < 0 || row < 0 || col >= columns || row >= rows) return null;
        const index = (row * columns + col) * 2;
        const dx = field[index];
        return Number.isNaN(dx) ? null : [dx, field[index + 1]];
      },

      _step(context) {
        context.beginPath();
        for (const particle of this._particles) {
          const velocity = particle.age < this._maxAge ? this._velocity(particle.x, particle.y) : null;
          if (!velocity) {
            this._spawn(particle, false);
            continue;
          }
          const x = particle.x + velocity[0];
          const y = particle.y + velocity[1];
          context.moveTo(particle.x, particle.y);
          context.lineTo(x, y);
          particle.x = x;
          particle.y = y;
          particle.age += 1;
        }
        context.stroke();
      },

      _animate() {
        const context = this._context;
        const tick = () => {
          // Fade the previous frame to leave short trails behind each particle.
          context.globalCompositeOperation = "destination-in";
          context.fillStyle = this._fade;
          context.fillRect(0, 0, this._width, this._height);
          context.globalCompositeOperation = "source-over";
          context.strokeStyle = this._color;
          context.lineWidth = this._lineWidth;
          this._step(context);
          this._frame = requestAnimationFrame(tick);
        };
        this._frame = requestAnimationFrame(tick);
      },

      // With reduced motion, draw short streaks once instead of animating.
      _drawStatic() {
        const context = this._context;
        context.strokeStyle = this._color;
        context.lineWidth = this._lineWidth;
        this._particles.forEach((particle) => { particle.age = 0; });
        for (let step = 0; step < 8; step += 1) this._step(context);
      },
    });

    ParticleLayer.addInitHook(function () {
      this._onVisibility = () => {
        if (document.hidden) this.stop();
        else if (this._map && !this._frame && !this._reducedMotion) this._animate();
      };
    });
    return ParticleLayer;
  }
})();
