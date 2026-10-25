(function () {
  "use strict";

  // Adapted from the user's Lightning Weather X Pakistan frontend.
  const DIRECT_STRIKES_ENDPOINT = "https://lightningbackend-production.up.railway.app/strikes";
  const API_TIMEZONE = "Asia/Karachi";
  const API_TIMEZONE_OFFSET = "+05:00";
  const DEFAULT_CENTER = [30.4, 69.3];
  const DEFAULT_ZOOM = 5;
  const AUTO_REFRESH_MS = 15 * 60 * 1000;
  // Radar, satellite and the forecast all cover this area, so the map does not zoom out or pan beyond it.
  const MAP_REGION = [[0, 25], [55, 110]];
  const WEATHER_REFRESH_MS = 5 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const CHECKPOINT_MS = 15 * 60 * 1000;
  const CHECKPOINT_COUNT = 96;
  const TIMELINE_PLAYBACK_MS = 850;
  const MAP_MARKER_LIMIT = 1_500;
  const PMD_RADAR_REFRESH_MS = 5 * 60 * 1000;
  const STRIKES_VISIBLE_KEY = "wapk.lightningVisible";
  // A frame older than three update cycles (at least 30 minutes) means that radar is offline.
  const PMD_STALE_CYCLES = 3;
  const PMD_PRODUCT_NAMES = { sri: "surface rain rate", cappi01: "1 km rain rate", rain12: "12-hour rainfall" };
  const API_BASE_URL = "https://lightning-weatherx-pk-api.mashhood-droid.workers.dev";
  // ECMWF forecast map data, published every 6 hours by pipeline/build_forecast.py.
  const FORECAST_DATA_URL = "https://wapk-forecast.pages.dev/";
  const LEAFLET_BASE = "https://unpkg.com/leaflet@1.9.4/dist/";

  const els = {
    alertCard: document.getElementById("radarAlertCard"),
    alertList: document.getElementById("radarAlertList"),
    alertText: document.getElementById("radarAlertText"),
    alertTitle: document.getElementById("radarAlertTitle"),
    autoRefreshToggle: document.getElementById("radarAutoRefreshToggle"),
    clearAlertsButton: document.getElementById("radarClearAlertsButton"),
    connectionStatus: document.getElementById("radarConnectionStatus"),
    feedDate: document.getElementById("radarFeedDate"),
    feedList: document.getElementById("radarFeedList"),
    lastUpdated: document.getElementById("radarLastUpdated"),
    latestTimelineButton: document.getElementById("radarLatestTimelineButton"),
    liveDot: document.querySelector("#mapsView .live-dot"),
    locateButton: document.getElementById("radarLocateButton"),
    mapHeadline: document.getElementById("radarMapHeadline"),
    mapSubline: document.getElementById("radarMapSubline"),
    mapTheme: document.getElementById("radarMapTheme"),
    nearbyStrikes: document.getElementById("radarNearbyStrikes"),
    nearestStrike: document.getElementById("radarNearestStrike"),
    newestStrike: document.getElementById("radarNewestStrike"),
    notificationButton: document.getElementById("radarNotificationButton"),
    pmdLegend: document.getElementById("radarPmdLegend"),
    pmdProduct: document.getElementById("radarPmdProduct"),
    pmdStatus: document.getElementById("radarPmdStatus"),
    pmdToggle: document.getElementById("radarPmdToggle"),
    radiusInput: document.getElementById("radarRadiusInput"),
    radiusValue: document.getElementById("radarRadiusValue"),
    satelliteProduct: document.getElementById("radarSatelliteProduct"),
    satelliteToggle: document.getElementById("radarSatelliteToggle"),
    refreshButton: document.getElementById("radarRefreshButton"),
    searchForm: document.getElementById("radarSearchForm"),
    searchInput: document.getElementById("radarSearchInput"),
    searchResults: document.getElementById("radarSearchResults"),
    soundToggle: document.getElementById("radarSoundToggle"),
    strikesToggle: document.getElementById("radarStrikesToggle"),
    targetSummary: document.getElementById("radarTargetSummary"),
    timeFilter: document.getElementById("radarTimeFilter"),
    timelineBars: document.getElementById("radarTimelineBars"),
    timelineLabel: document.getElementById("radarTimelineLabel"),
    timelinePlayButton: document.getElementById("radarTimelinePlayButton"),
    timelineRangeButtons: document.querySelectorAll("#mapsView [data-timeline-hours]"),
    timelineRangeLabel: document.getElementById("radarTimelineRangeLabel"),
    timelineSlider: document.getElementById("radarTimelineSlider"),
    timelineWindow: document.getElementById("radarTimelineWindow"),
    toastStack: document.getElementById("radarToastStack"),
    totalStrikes: document.getElementById("radarTotalStrikes"),
    visibleStrikes: document.getElementById("radarVisibleStrikes"),
    weatherLayerStatus: document.getElementById("radarWeatherLayerStatus"),
    weatherOpacityInput: document.getElementById("radarWeatherOpacityInput"),
  };
  // icons.js has already rendered the button's icon; keep that markup to restore after "Locating…".
  const LOCATE_BUTTON_HTML = els.locateButton.innerHTML;

  const state = {
    visible: false,
    initialized: false,
    initPromise: null,
    theme: "dark",
    placeKey: "",
    pendingPlace: null,
    fetchControllers: new Map(),
    locationRequest: 0,
    searchRequest: 0,
    notificationsEnabled: false,
    feedHealthy: false,
    alertedStrikeIds: new Set(),
    audioContext: null,
    autoRefreshTimer: null,
    currentTileLayer: null,
    feedMeta: null,
    firstFit: false,
    lastFetchAt: null,
    map: null,
    nearbyStrikes: [],
    forecast: null,
    pmdFetchAt: 0,
    pmdLayer: null,
    pmdRadar: null,
    pmdRequest: 0,
    radiusCircle: null,
    radiusKm: 25,
    satelliteFetchAt: 0,
    satelliteMeta: null,
    satelliteOverlay: null,
    satellitePending: null,
    satelliteRequest: 0,
    searchMarker: null,
    strikeLayer: null,
    strikes: [],
    strikesVisible: true,
    target: null,
    targetLayer: null,
    timeline: [],
    timelineIndex: CHECKPOINT_COUNT - 1,
    timelineLive: true,
    timelinePlaybackTimer: null,
    timelinePlaying: false,
    timelineRangeHours: 24,
    userWatchId: null,
    visibleStrikes: [],
    weatherRefreshTimer: null,
  };

  const tileLayers = {
    standard: {
      url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    },
    hot: {
      url: "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
      options: {
        maxZoom: 19,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, Tiles courtesy of HOT',
      },
    },
    // CARTO's dark basemap now returns "API KEY REQUIRED" tiles, so use Esri's keyless dark canvas plus its label layer.
    dark: {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      labelsUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      options: {
        maxZoom: 19,
        maxNativeZoom: 16,
        attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
      },
    },
  };

  window.AtmosRadar = { show, hide, setPlace, setTheme };

  function isActive() {
    return state.visible && !document.hidden;
  }

  async function show({ place, theme } = {}) {
    state.visible = true;
    setTheme(theme || document.documentElement.dataset.theme);
    if (place) setPlace(place);
    if (!state.initialized) {
      setConnection("loading", "Loading interactive radar…");
      try {
        state.initPromise ||= loadLeaflet();
        await state.initPromise;
        if (!state.visible) return false;
        if (!state.initialized) {
          initMap();
          bindEvents();
          state.initialized = true;
          updateNotificationButton();
          renderDashboard();
        }
      } catch (error) {
        state.initPromise = null;
        if (state.map && !state.initialized) {
          state.map.remove();
          state.map = null;
        }
        setConnection("error", "Map could not load — reopen Maps to retry");
        els.mapHeadline.textContent = "Map unavailable";
        els.mapSubline.textContent = "Check your connection, then return to weather and open Maps again.";
        return false;
      }
    }
    applyPendingPlace();
    state.map.invalidateSize({ pan: false });
    window.requestAnimationFrame(() => {
      if (state.visible && state.map) state.map.invalidateSize({ pan: false });
    });
    resume();
    return true;
  }

  function hide() {
    state.visible = false;
    pause();
  }

  function pause() {
    stopTimelinePlayback();
    state.forecast?.pause();
    clearInterval(state.autoRefreshTimer);
    clearInterval(state.weatherRefreshTimer);
    state.autoRefreshTimer = null;
    state.weatherRefreshTimer = null;
    state.fetchControllers.forEach((controller) => controller.abort());
    state.fetchControllers.clear();
    state.searchRequest += 1;
    state.locationRequest += 1;
    resetLocateButton();
    if (state.userWatchId !== null) navigator.geolocation.clearWatch(state.userWatchId);
    state.userWatchId = null;
    if (state.audioContext?.state === "running") state.audioContext.suspend().catch(() => {});
    state.map?.stop();
  }

  function resume() {
    if (!isActive() || !state.initialized) return;
    if (!state.lastFetchAt || Date.now() - state.lastFetchAt.getTime() >= AUTO_REFRESH_MS || !state.feedHealthy) fetchStrikes(true);
    if (Date.now() - state.satelliteFetchAt >= WEATHER_REFRESH_MS) fetchSatellite(true);
    if (Date.now() - state.pmdFetchAt >= PMD_RADAR_REFRESH_MS) fetchPmdRadar(true);
    else renderPmdRadar();
    scheduleAutoRefresh();
    scheduleWeatherRefresh();
    state.forecast?.resume();
  }

  function loadLeaflet() {
    return new Promise((resolve, reject) => {
      let scriptReady = Boolean(window.L);
      let cssReady = Boolean(document.getElementById("radarLeafletCss")?.sheet);
      let script;
      let css;
      const timer = window.setTimeout(() => fail(), 20_000);
      const done = () => {
        if (!scriptReady || !cssReady) return;
        clearTimeout(timer);
        resolve();
      };
      const fail = () => {
        clearTimeout(timer);
        if (!scriptReady) script?.remove();
        if (!cssReady) css?.remove();
        reject(new Error("Map library unavailable"));
      };
      if (!cssReady) {
        document.getElementById("radarLeafletCss")?.remove();
        css = document.createElement("link");
        css.id = "radarLeafletCss";
        css.rel = "stylesheet";
        css.href = `${LEAFLET_BASE}leaflet.css`;
        css.integrity = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=";
        css.crossOrigin = "anonymous";
        css.onload = () => { cssReady = true; done(); };
        css.onerror = fail;
        document.head.appendChild(css);
      }
      if (!scriptReady) {
        script = document.createElement("script");
        script.src = `${LEAFLET_BASE}leaflet.js`;
        script.integrity = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
        script.crossOrigin = "anonymous";
        script.onload = () => { scriptReady = Boolean(window.L); scriptReady ? done() : fail(); };
        script.onerror = fail;
        document.head.appendChild(script);
      }
      done();
    });
  }

  function validCoordinates(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  }

  function setPlace(place) {
    const lat = Number(place?.latitude);
    const lon = Number(place?.longitude);
    if (place?.latitude == null || place?.longitude == null || !validCoordinates(lat, lon)) return;
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (key === state.placeKey) return;
    state.placeKey = key;
    state.pendingPlace = { lat, lon, label: [...new Set([place.name, place.admin1, place.country].filter(Boolean))].join(", "), type: "dashboard" };
    applyPendingPlace();
  }

  function applyPendingPlace() {
    if (!state.initialized || !state.visible || !state.pendingPlace) return;
    setTarget(state.pendingPlace, false);
    state.map.setView([state.pendingPlace.lat, state.pendingPlace.lon], 8, { animate: false });
    state.pendingPlace = null;
  }

  function setTheme(theme) {
    state.theme = theme === "light" ? "light" : "dark";
    if (state.initialized && els.mapTheme.value === "auto") setTileLayer("auto");
    state.forecast?.setTheme(state.theme);
    if (state.initialized) renderSatellite();
  }

  function initMap() {
    state.map = L.map("radarMap", {
      zoomControl: false,
      preferCanvas: true,
      maxBounds: L.latLngBounds(MAP_REGION),
      maxBoundsViscosity: 1,
      // Quarter-level zoom steps let the widest view match the region exactly; the buttons still move one level.
      zoomSnap: 0.25,
    }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    limitZoomToRegion();

    L.control.zoom({ position: "bottomright" }).addTo(state.map);
    // Satellite images sit above the base map and forecast colours, below PMD radar and wind.
    state.map.createPane("satellite").style.zIndex = "320";
    state.map.getPane("satellite").style.pointerEvents = "none";
    // PMD radar sits above the base map and satellite tiles but below the radius circle and strikes.
    state.map.createPane("pmdRadar");
    state.map.getPane("pmdRadar").style.zIndex = "350";
    state.map.getPane("pmdRadar").style.pointerEvents = "none";
    state.pmdLayer = L.layerGroup().addTo(state.map);
    state.strikeLayer = L.layerGroup();
    setStrikesVisible(readStrikesPreference(), false);
    // Place names stay readable above the forecast colours and wind.
    state.map.createPane("mapLabels").style.zIndex = "390";
    state.map.getPane("mapLabels").style.pointerEvents = "none";
    state.forecast = window.WapkForecast?.attach(state.map, {
      url: FORECAST_DATA_URL,
      theme: state.theme,
      getUnit: () => window.Atmos?.unit,
    }) || null;
    state.targetLayer = L.layerGroup().addTo(state.map);
    setTileLayer(els.mapTheme.value || "auto");
    observeMapSize();
  }

  function bindEvents() {
    els.refreshButton.addEventListener("click", () => {
      userGesture();
      fetchStrikes(false);
      fetchSatellite(false);
      fetchPmdRadar(false);
    });

    els.pmdToggle.addEventListener("change", () => {
      if (els.pmdToggle.checked && Date.now() - state.pmdFetchAt >= PMD_RADAR_REFRESH_MS) fetchPmdRadar(false);
      else renderPmdRadar();
    });

    els.pmdProduct.addEventListener("change", renderPmdRadar);

    els.strikesToggle.addEventListener("click", () => setStrikesVisible(!state.strikesVisible, true));

    els.locateButton.addEventListener("click", () => {
      userGesture();
      requestCurrentLocation();
    });

    els.notificationButton.addEventListener("click", () => {
      userGesture();
      enableNotifications();
    });

    els.radiusInput.addEventListener("input", () => {
      state.radiusKm = Number(els.radiusInput.value);
      els.radiusValue.textContent = state.radiusKm;
      renderTarget();
      evaluateAlerts();
      renderStrikes();
      renderDashboard();
    });

    els.timeFilter.addEventListener("change", () => {
      updateVisibleStrikes();
      evaluateAlerts();
      renderStrikes();
      renderDashboard();
    });

    els.timelineSlider.addEventListener("input", () => {
      stopTimelinePlayback();
      selectTimelineIndex(Number(els.timelineSlider.value));
    });

    els.latestTimelineButton.addEventListener("click", () => {
      stopTimelinePlayback();
      moveTimelineToLatest();
    });

    els.timelinePlayButton.addEventListener("click", () => {
      toggleTimelinePlayback();
    });

    els.timelineRangeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        stopTimelinePlayback();
        setTimelineRange(Number(button.dataset.timelineHours));
      });
    });

    els.mapTheme.addEventListener("change", () => {
      setTileLayer(els.mapTheme.value);
    });

    els.satelliteToggle.addEventListener("change", () => {
      if (els.satelliteToggle.checked && !state.satelliteMeta) fetchSatellite(false);
      else renderSatellite();
    });

    els.satelliteProduct.addEventListener("change", () => {
      // Picking a product also switches the satellite layer on.
      els.satelliteToggle.checked = true;
      renderSatellite();
    });

    els.weatherOpacityInput.addEventListener("input", () => {
      updateWeatherOpacity();
    });

    els.autoRefreshToggle.addEventListener("change", scheduleAutoRefresh);

    els.soundToggle.addEventListener("change", () => {
      showToast(els.soundToggle.checked ? "Sound alarm enabled." : "Sound alarm muted.");
    });

    els.clearAlertsButton.addEventListener("click", () => {
      state.nearbyStrikes.forEach((strike) => state.alertedStrikeIds.add(strike.id));
      showToast("Current nearby strikes acknowledged.", "success");
      renderDashboard();
    });

    els.searchForm.addEventListener("submit", (event) => {
      event.preventDefault();
      userGesture();
      performSearch(els.searchInput.value.trim());
    });

    window.addEventListener("online", () => {
      if (isActive()) { fetchStrikes(false); fetchSatellite(true); }
    });

    window.addEventListener("offline", () => {
      if (state.initialized) { state.feedHealthy = false; setConnection("error", "Offline — displayed data may be outdated"); }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) pause();
      else resume();
    });
  }

  function setTileLayer(name) {
    if (name === "auto") name = state.theme === "dark" ? "dark" : "standard";
    const selected = tileLayers[name] || tileLayers.standard;
    if (state.currentTileLayer) {
      state.map.removeLayer(state.currentTileLayer);
    }
    const base = L.tileLayer(selected.url, selected.options);
    state.currentTileLayer = selected.labelsUrl
      ? L.layerGroup([base, L.tileLayer(selected.labelsUrl, { ...selected.options, attribution: "", pane: "mapLabels" })])
      : base;
    state.currentTileLayer.addTo(state.map);
  }

  // List of stored Meteosat images (one whole-region picture per product), refreshed every few minutes.
  async function fetchSatellite(silent) {
    if (!silent) setWeatherStatus("Checking for the latest satellite images…");
    try {
      const response = await fetchWithTimeout(apiUrl("/api/satellite"), 20_000);
      if (!response.ok) throw new Error(`satellite list returned ${response.status}`);
      const payload = await response.json();
      if (!payload?.success || !Array.isArray(payload.products)) throw new Error("satellite list is unavailable");
      state.satelliteMeta = payload;
      state.satelliteFetchAt = Date.now();
      renderSatellite();
    } catch (error) {
      const message = error instanceof Error ? error.message : "satellite refresh failed";
      setWeatherStatus(`Satellite images could not refresh: ${message}.`);
      if (!silent && els.satelliteToggle.checked) showToast(`Satellite images could not refresh: ${message}`, "danger");
    }
  }

  async function fetchPmdRadar(silent) {
    if (!els.pmdToggle.checked) {
      renderPmdRadar();
      return;
    }
    const request = ++state.pmdRequest;
    if (!silent) setPmdStatus("Loading PMD radar…");

    try {
      const response = await fetchWithTimeout(apiUrl("/api/pmd-radar"), 20_000);
      if (!response.ok) throw new Error(`Radar returned ${response.status}`);
      const payload = await response.json();
      if (request !== state.pmdRequest) return;
      if (!payload?.success || !Array.isArray(payload.sites)) throw new Error("radar data is unavailable");
      state.pmdRadar = payload;
      state.pmdFetchAt = Date.now();
      renderPmdRadar();
    } catch (error) {
      if (request !== state.pmdRequest) return;
      const message = error instanceof Error ? error.message : "radar refresh failed";
      // Keep showing the last good frames; only the status explains the failed refresh.
      if (state.pmdRadar) renderPmdRadar();
      setPmdStatus(`PMD radar could not refresh: ${message}.${state.pmdRadar ? " Showing the last loaded images." : ""}`);
      if (!silent) showToast(`PMD radar could not refresh: ${message}`, "danger");
    }
  }

  function renderPmdRadar() {
    state.pmdLayer.clearLayers();
    els.pmdLegend.hidden = true;
    els.pmdProduct.disabled = !els.pmdToggle.checked;
    if (!els.pmdToggle.checked) {
      setPmdStatus("Radar from PMD Islamabad and Karachi.");
      return;
    }
    if (!state.pmdRadar) return;

    const code = els.pmdProduct.value;
    // Each entry is status text, plus the radar's bounds when it is drawn so the visitor can jump to it.
    const lines = [];
    let legend = null;
    state.pmdRadar.sites.forEach((site) => {
      const product = site.products.find((item) => item.code === code);
      const frame = product?.frames[product.frames.length - 1];
      if (!product || !frame) {
        lines.push({ text: `${site.name}: no images for this product` });
        return;
      }
      legend ||= product;
      const frameMs = Date.parse(frame.time);
      const maxAgeMs = pmdMaxAgeMs(product);
      const bounds = site.bounds[String(product.radiusKm)];
      // An old frame drawn as if current would show rain that has long gone, so stale products are listed, not drawn.
      if (Date.now() - frameMs > maxAgeMs) {
        // PMD's flags cannot tell a dry radar from a dead one. A running radar keeps at least one product
        // updating (12-hour rainfall arrives hourly), so a site where every product has stopped is offline.
        const running = site.products.some(isPmdFrameCurrent);
        if (site.maintenance || !site.upstreamOk) {
          const reason = site.maintenance ? "under maintenance" : "PMD radar server unreachable";
          lines.push({ text: `${site.name}: ${reason}, no new ${pmdProductName(product)} image since ${formatRadarDateTime(frameMs)} (${formatAge(frameMs)})` });
        } else if (!running) {
          const lastMs = Math.max(...site.products.map((item) => Date.parse(item.frames[item.frames.length - 1]?.time)).filter(Number.isFinite));
          lines.push({ text: `${site.name}: radar offline since ${formatRadarDateTime(lastMs)} (${formatAge(lastMs)})` });
        } else {
          // Running but no current image for this product: there is no rain for it to show.
          if (site.center && Number.isFinite(product.radiusKm)) {
            L.circle(site.center, {
              pane: "pmdRadar",
              radius: product.radiusKm * 1000,
              color: "#7fb6e6",
              weight: 1,
              dashArray: "4 6",
              fill: false,
              interactive: false,
            }).addTo(state.pmdLayer);
          }
          lines.push({ text: `${site.name}: radar running, no rain showing`, bounds, name: site.name, quiet: true });
        }
        // PMD's products update independently, so point to one from this radar that is still current.
        const current = site.products.find((item) => item.code !== code && isPmdFrameCurrent(item));
        if (current) lines.push({ text: `${site.name} ${pmdProductName(current)} is up to date. Show it`, product: current.code });
        return;
      }
      if (!bounds) {
        lines.push({ text: `${site.name}: map position unavailable` });
        return;
      }
      L.imageOverlay(frame.url, bounds, {
        pane: "pmdRadar",
        className: "pmd-radar-frame",
        opacity: getWeatherOpacity(),
        interactive: false,
        attribution: 'Radar &copy; <a href="https://ffd.pmd.gov.pk/radar" target="_blank" rel="noopener noreferrer">PMD FFD</a>',
      }).addTo(state.pmdLayer);
      lines.push({ text: `${site.name}: live, ${formatRadarTime(frameMs)} (${formatAge(frameMs)})`, bounds, name: site.name });
    });

    if (legend?.legend) {
      els.pmdLegend.src = legend.legend;
      els.pmdLegend.alt = `Colour scale for ${legend.label}, in ${legend.units}`;
      els.pmdLegend.hidden = false;
    }
    if (!lines.length) {
      setPmdStatus("No PMD radar sites are listed.");
      return;
    }
    // The map opens on the dashboard city, which may be far from the working radar, so offer a jump to it.
    els.pmdStatus.replaceChildren(...lines.map((line) => {
      if (line.product) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "radar-pmd-switch";
        button.textContent = line.text;
        button.addEventListener("click", () => {
          els.pmdProduct.value = line.product;
          renderPmdRadar();
        });
        return button;
      }
      if (!line.bounds) return Object.assign(document.createElement("span"), { textContent: line.text });
      const button = document.createElement("button");
      button.type = "button";
      button.className = `radar-pmd-site${line.quiet ? " is-quiet" : ""}`;
      button.textContent = line.text;
      button.title = `Show the ${line.name} radar area`;
      button.addEventListener("click", () => state.map.flyToBounds(line.bounds, { padding: [16, 16], duration: 0.7 }));
      return button;
    }));
  }

  function pmdProductName(product) {
    return PMD_PRODUCT_NAMES[product.code] || product.label.toLowerCase();
  }

  function pmdMaxAgeMs(product) {
    return Math.max(30, product.cadenceMinutes * PMD_STALE_CYCLES) * 60_000;
  }

  function isPmdFrameCurrent(product) {
    const frame = product.frames[product.frames.length - 1];
    return Boolean(frame) && Date.now() - Date.parse(frame.time) <= pmdMaxAgeMs(product);
  }

  function setPmdStatus(message) {
    els.pmdStatus.textContent = message;
  }

  function formatRadarDateTime(timestampMs) {
    // Include the day once the time is no longer from today's last few hours.
    const options = { hour: "2-digit", minute: "2-digit", timeZone: API_TIMEZONE };
    if (Date.now() - timestampMs > 12 * 60 * 60 * 1000) Object.assign(options, { day: "numeric", month: "short" });
    return new Intl.DateTimeFormat(undefined, options).format(new Date(timestampMs));
  }

  function formatRadarTime(timestampMs) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: API_TIMEZONE,
      timeZoneName: "short",
    }).format(new Date(timestampMs));
  }

  function renderSatellite() {
    const pane = state.map.getPane("satellite");
    // A picture still loading for an earlier choice is no longer wanted.
    if (state.satellitePending) state.map.removeLayer(state.satellitePending);
    state.satellitePending = null;
    if (!els.satelliteToggle.checked) {
      if (state.satelliteOverlay) state.map.removeLayer(state.satelliteOverlay);
      state.satelliteOverlay = null;
      state.satelliteRequest += 1;
      setWeatherStatus("Satellite images are off. Turn on Satellite in the layer list.");
      return;
    }
    if (!state.satelliteMeta) return;
    const product = state.satelliteMeta.products.find((item) => item.id === els.satelliteProduct.value) || state.satelliteMeta.products[0];
    // Areas without imagery come back black (night side, space). In dark theme the images are screen-blended,
    // so black disappears into the map and the dark map barely changes the image's own colours.
    pane.style.mixBlendMode = state.theme === "dark" ? "screen" : "normal";
    if (state.satelliteOverlay?._url === product.url) {
      describeSatellite(product);
      return;
    }
    const request = ++state.satelliteRequest;
    // Products not stored yet are fetched by the worker on first use, which can take up to a minute.
    setWeatherStatus(product.time ? `Loading ${product.label.toLowerCase()} image…` : `Preparing the ${product.label.toLowerCase()} image. The first copy can take up to a minute…`);
    const overlay = L.imageOverlay(product.url, state.satelliteMeta.bounds, {
      pane: "satellite",
      opacity: getWeatherOpacity(),
      interactive: false,
      className: "satellite-image",
      attribution: 'Satellite &copy; <a href="https://www.eumetsat.int/" target="_blank" rel="noopener noreferrer">EUMETSAT</a>',
    });
    overlay.once("load", () => {
      if (request !== state.satelliteRequest) return;
      // Swap only once the new picture has arrived, so the map never flashes empty.
      if (state.satelliteOverlay && state.satelliteOverlay !== overlay) state.map.removeLayer(state.satelliteOverlay);
      state.satelliteOverlay = overlay;
      state.satellitePending = null;
      overlay.setOpacity(getWeatherOpacity());
      describeSatellite(product);
    });
    overlay.once("error", () => {
      if (request !== state.satelliteRequest) return;
      state.map.removeLayer(overlay);
      state.satellitePending = null;
      setWeatherStatus(`The ${product.label.toLowerCase()} image is not available right now.`);
    });
    // While a previous picture is showing, the new one loads invisibly and appears on "load" above.
    state.satellitePending = overlay;
    overlay.addTo(state.map);
    if (state.satelliteOverlay) overlay.setOpacity(0);
  }

  function describeSatellite(product) {
    const time = Date.parse(product.time);
    setWeatherStatus(Number.isFinite(time)
      ? `${product.label}: ${formatRadarTime(time)} (${formatAge(time)}). ${product.note}. Meteosat, every 15 minutes.`
      : `${product.label}. ${product.note}.`);
  }

  // The widest zoom is the one where the region just fills the map, so nothing outside the data shows.
  function limitZoomToRegion() {
    const zoom = state.map.getBoundsZoom(L.latLngBounds(MAP_REGION), true);
    state.map.setMinZoom(Math.max(2, zoom));
  }

  function updateWeatherOpacity() {
    const opacity = getWeatherOpacity();
    state.pmdLayer?.eachLayer((layer) => layer.setOpacity(opacity));
    state.satelliteOverlay?.setOpacity(opacity);
  }

  function getWeatherOpacity() {
    return Number(els.weatherOpacityInput.value) / 100;
  }

  function scheduleWeatherRefresh() {
    if (state.weatherRefreshTimer) {
      window.clearInterval(state.weatherRefreshTimer);
    }

    state.weatherRefreshTimer = window.setInterval(() => {
      fetchSatellite(true);
      fetchPmdRadar(true);
    }, WEATHER_REFRESH_MS);
  }

  function setWeatherStatus(message) {
    els.weatherLayerStatus.textContent = message;
  }

  function observeMapSize() {
    const container = document.getElementById("radarMap");
    // While Maps is hidden the container measures 0×0; resizing Leaflet to that and back shifts the view.
    const resize = () => {
      if (!container.offsetWidth || !container.offsetHeight) return;
      state.map.invalidateSize();
      // A smaller map needs a smaller minimum zoom to still fit the whole region.
      limitZoomToRegion();
    };
    window.setTimeout(resize, 250);
    window.addEventListener("resize", () => {
      window.setTimeout(resize, 100);
    });

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(() => {
        window.requestAnimationFrame(resize);
      });
      observer.observe(container);
    }
  }

  async function fetchStrikes(silent) {
    if (!silent) {
      setConnection("loading", "Refreshing strike feed");
    }

    const endpoints = getStrikeEndpoints();
    let lastError = null;

    for (const endpoint of endpoints) {
      try {
        const response = await fetchWithTimeout(endpoint, 16_000);
        if (!response.ok) {
          throw new Error(`Feed returned ${response.status}`);
        }

        const payload = await response.json();
        applyStrikePayload(payload);
        state.feedHealthy = true;
        setConnection("ok", "Live strike feed connected");
        return;
      } catch (error) {
        lastError = error;
      }
    }

    const message = lastError instanceof Error ? lastError.message : "Unknown feed error";
    state.feedHealthy = false;
    setConnection("error", "Strike feed unavailable");
    els.mapHeadline.textContent = "Unable to refresh strikes";
    els.mapSubline.textContent = message;
    showToast(`Could not refresh strikes: ${message}`, "danger");
  }

  function getStrikeEndpoints() {
    const cloudflareEndpoint = apiUrl("/api/strikes?hours=24&limit=5000");
    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      return [cloudflareEndpoint, DIRECT_STRIKES_ENDPOINT];
    }
    return [DIRECT_STRIKES_ENDPOINT];
  }

  async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timer);
    }
  }

  function applyStrikePayload(payload) {
    const raw = Array.isArray(payload) ? payload : payload.data || payload.strikes || [];
    const normalized = raw
      .map(normalizeStrike)
      .filter(Boolean)
      .sort((a, b) => b.timestampMs - a.timestampMs);

    state.feedMeta = payload && typeof payload === "object" ? payload : {};
    state.strikes = normalized;
    state.timeline = Array.isArray(state.feedMeta.timeline)
      ? normalizeTimeline(state.feedMeta.timeline)
      : buildTimeline(normalized, CHECKPOINT_COUNT);
    syncTimelineSelection();
    state.lastFetchAt = new Date();

    updateVisibleStrikes();
    evaluateAlerts();
    renderStrikes();
    renderDashboard();

    if (state.firstFit && normalized.length) {
      fitMapToStrikes(normalized);
      state.firstFit = false;
    }
  }

  function normalizeStrike(raw, index) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const lat = Number(raw.lat ?? raw.latitude);
    const lon = Number(raw.lon ?? raw.lng ?? raw.long ?? raw.longitude);
    const timestamp = String(raw.timestamp ?? raw.time ?? raw.createdAt ?? "").trim();
    const parsed = parseApiTimestamp(timestamp);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !timestamp || Number.isNaN(parsed.getTime())) {
      return null;
    }

    const timestampMs = parsed.getTime();
    return {
      id: String(raw.id ?? `${timestampMs}:${lat.toFixed(4)}:${lon.toFixed(4)}:${index}`),
      lat,
      lon,
      timestamp,
      timestampMs,
    };
  }

  function parseApiTimestamp(timestamp) {
    const normalized = timestamp.replace(" ", "T");
    const hasOffset = /(?:z|[+-]\d{2}:?\d{2})$/i.test(normalized);
    return new Date(hasOffset ? normalized : `${normalized}${API_TIMEZONE_OFFSET}`);
  }

  function updateVisibleStrikes() {
    const filter = els.timeFilter.value;
    const checkpoint = getSelectedCheckpoint();
    const endMs = checkpoint ? Date.parse(checkpoint.end) : Date.now();
    const startMs =
      filter === "all" ? endMs - DAY_MS : endMs - Number(filter) * 60_000;

    state.visibleStrikes = state.strikes.filter(
      (strike) => strike.timestampMs >= startMs && strike.timestampMs <= endMs,
    );
  }

  function syncTimelineSelection() {
    const buckets = getTimelineBuckets();
    const { startIndex, endIndex } = getTimelineBounds(buckets);

    if (state.timelineLive || state.timelineIndex > endIndex) {
      state.timelineIndex = endIndex;
      state.timelineLive = true;
      return;
    }

    if (state.timelineIndex < startIndex) {
      state.timelineIndex = startIndex;
      state.timelineLive = false;
    }
  }

  function moveTimelineToLatest() {
    const { endIndex } = getTimelineBounds();
    state.timelineIndex = endIndex;
    state.timelineLive = true;
    updateVisibleStrikes();
    evaluateAlerts();
    renderStrikes();
    renderDashboard();
  }

  function getSelectedCheckpoint() {
    const buckets = getTimelineBuckets();

    if (!buckets.length) {
      const endMs = getTimelineEndMs(state.strikes);
      return {
        start: new Date(endMs - CHECKPOINT_MS).toISOString(),
        end: new Date(endMs).toISOString(),
        count: 0,
      };
    }

    const index = Math.min(Math.max(state.timelineIndex, 0), buckets.length - 1);
    return buckets[index];
  }

  function isLatestCheckpoint() {
    const { endIndex } = getTimelineBounds();
    return state.timelineLive || state.timelineIndex >= endIndex;
  }

  function renderStrikes() {
    state.strikeLayer.clearLayers();

    const nearbyIds = new Set(state.nearbyStrikes.map((strike) => strike.id));
    const markers = state.visibleStrikes.slice(0, MAP_MARKER_LIMIT);

    markers.forEach((strike) => {
      const marker = L.marker([strike.lat, strike.lon], {
        icon: L.divIcon({
          className: "",
          html: strikeMarkerHtml(ageClass(strike), nearbyIds.has(strike.id)),
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        }),
      });

      marker.bindPopup(strikePopupHtml(strike));
      marker.addTo(state.strikeLayer);
    });

    if (state.visibleStrikes.length > MAP_MARKER_LIMIT) {
      els.mapSubline.textContent = `Showing newest ${MAP_MARKER_LIMIT.toLocaleString()} of ${state.visibleStrikes.length.toLocaleString()} visible strikes.`;
    }
  }

  // Hiding strikes only removes the markers from the map; counts, nearby alerts and the feed keep working.
  function setStrikesVisible(visible, remember) {
    state.strikesVisible = visible;
    if (visible) state.strikeLayer.addTo(state.map);
    else state.map.removeLayer(state.strikeLayer);
    els.strikesToggle.setAttribute("aria-pressed", String(visible));
    els.strikesToggle.title = visible ? "Hide lightning strikes" : "Show lightning strikes";
    els.strikesToggle.classList.toggle("is-off", !visible);
    document.querySelector("#mapsView .radar-legend")?.classList.toggle("strikes-hidden", !visible);
    if (!remember) return;
    try {
      localStorage.setItem(STRIKES_VISIBLE_KEY, visible ? "1" : "0");
    } catch {
      // The choice still applies for this visit when browser storage is unavailable.
    }
  }

  function readStrikesPreference() {
    try {
      return localStorage.getItem(STRIKES_VISIBLE_KEY) !== "0";
    } catch {
      return true;
    }
  }

  function strikeMarkerHtml(age, nearby) {
    return `<span class="strike-marker ${age} ${nearby ? "nearby" : ""}">
      <span class="strike-ring"></span>
      <span class="strike-core"></span>
      <span class="strike-bolt"></span>
    </span>`;
  }

  function ageClass(strike) {
    const minutes = Math.max(0, (Date.now() - strike.timestampMs) / 60_000);
    if (minutes <= 5) return "age-fresh";
    if (minutes <= 15) return "age-recent";
    return "age-older";
  }

  function strikePopupHtml(strike) {
    const distance = state.target
      ? `${haversineKm(state.target.lat, state.target.lon, strike.lat, strike.lon).toFixed(1)} km from ${escapeHtml(state.target.label)}`
      : "Choose a target to calculate distance";

    return `<div class="popup-title">Lightning strike</div>
      <div class="popup-meta">
        ${formatStrikeTime(strike.timestampMs)}<br>
        ${escapeHtml(distance)}<br>
        ${strike.lat.toFixed(3)}, ${strike.lon.toFixed(3)}
      </div>`;
  }

  function fitMapToStrikes(strikes) {
    const points = strikes.slice(0, 300).map((strike) => [strike.lat, strike.lon]);
    const bounds = L.latLngBounds(points);
    if (bounds.isValid()) {
      state.map.fitBounds(bounds, { padding: [32, 32], maxZoom: 9 });
    }
  }

  function requestCurrentLocation() {
    if (!navigator.geolocation) {
      showToast("Geolocation is not supported by this browser.", "danger");
      return;
    }

    const requestId = ++state.locationRequest;
    els.locateButton.disabled = true;
    els.locateButton.textContent = "Locating…";

    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (requestId !== state.locationRequest) return;
        resetLocateButton();

        const coords = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          label: "Current location",
          type: "user",
        };
        setTarget(coords, true);
        startLocationWatch();
      },
      (error) => {
        if (requestId !== state.locationRequest) return;
        resetLocateButton();
        showToast(`Location unavailable: ${error.message}`, "danger");
      },
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 12_000 },
    );
  }

  function resetLocateButton() {
    els.locateButton.disabled = false;
    els.locateButton.innerHTML = LOCATE_BUTTON_HTML;
  }

  function startLocationWatch() {
    if (state.userWatchId !== null || !navigator.geolocation) {
      return;
    }

    state.userWatchId = navigator.geolocation.watchPosition(
      (position) => {
        if (!state.target || state.target.type !== "user") {
          return;
        }
        state.target = {
          ...state.target,
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };
        renderTarget();
        evaluateAlerts();
        renderStrikes();
        renderDashboard();
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 90_000, timeout: 20_000 },
    );
  }

  function setTarget(target, flyTo) {
    state.target = target;
    renderTarget();
    evaluateAlerts();
    renderStrikes();
    renderDashboard();

    if (flyTo) {
      state.map.flyTo([target.lat, target.lon], 9, { duration: 0.7 });
    }
  }

  function renderTarget() {
    state.targetLayer.clearLayers();

    if (!state.target) {
      els.targetSummary.textContent = "Choose a location to enable radius alerts.";
      return;
    }

    const iconClass = state.target.type === "user" ? "user-marker" : "search-marker";
    const marker = L.marker([state.target.lat, state.target.lon], {
      icon: L.divIcon({
        className: "",
        html: `<span class="${iconClass}"></span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    }).bindPopup(`<strong>${escapeHtml(state.target.label)}</strong><br>${state.radiusKm} km alert radius`);

    const circle = L.circle([state.target.lat, state.target.lon], {
      radius: state.radiusKm * 1000,
      color: "#0a8aa3",
      weight: 2,
      fillColor: "#0a8aa3",
      fillOpacity: 0.12,
    });

    marker.addTo(state.targetLayer);
    circle.addTo(state.targetLayer);

    els.targetSummary.textContent = `${state.target.label}: monitoring strikes within ${state.radiusKm} km.`;
  }

  function evaluateAlerts() {
    if (!state.target) {
      state.nearbyStrikes = [];
      return;
    }

    const nearby = state.visibleStrikes
      .map((strike) => ({
        ...strike,
        distanceKm: haversineKm(state.target.lat, state.target.lon, strike.lat, strike.lon),
      }))
      .filter((strike) => strike.distanceKm <= state.radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm || b.timestampMs - a.timestampMs);

    const isLive = isLatestCheckpoint();
    const newNearby = isLive
      ? nearby.filter((strike) => !state.alertedStrikeIds.has(strike.id))
      : [];
    state.nearbyStrikes = nearby;
    newNearby.forEach((strike) => state.alertedStrikeIds.add(strike.id));

    if (newNearby.length) {
      const nearest = newNearby[0];
      const message = `${newNearby.length} strike${newNearby.length === 1 ? "" : "s"} within ${state.radiusKm} km. Nearest: ${nearest.distanceKm.toFixed(1)} km.`;
      showToast(message, "danger");
      notifyNearby(newNearby);
      if (els.soundToggle.checked) {
        playAlarm().catch(() => {});
      }
    }
  }

  function renderDashboard() {
    const nearby = state.nearbyStrikes;
    const newest = state.strikes[0];
    const latestFetch = state.lastFetchAt ? formatLocalTime(state.lastFetchAt) : "waiting";
    const feedDate = state.feedMeta?.date || state.feedMeta?.feedDate || "--";
    const total = Number(state.feedMeta?.totalCached ?? state.feedMeta?.count ?? state.strikes.length);
    const checkpoint = getSelectedCheckpoint();
    const checkpointLabel = formatCheckpointEnd(checkpoint);
    const windowLabel = selectedWindowLabel();
    const timelineMode = isLatestCheckpoint() ? "latest checkpoint" : "historical checkpoint";

    els.lastUpdated.textContent = `Last update: ${latestFetch}`;
    els.feedDate.textContent = `Feed date: ${feedDate}`;
    els.totalStrikes.textContent = total.toLocaleString();
    els.visibleStrikes.textContent = state.visibleStrikes.length.toLocaleString();
    els.nearbyStrikes.textContent = nearby.length.toLocaleString();
    els.nearestStrike.textContent = nearby[0] ? `${nearby[0].distanceKm.toFixed(1)} km` : "--";
    els.newestStrike.textContent = newest
      ? `Newest strike: ${formatStrikeTime(newest.timestampMs)}`
      : "Newest strike: --";

    if (!state.target) {
      els.alertCard.className = "alert-card";
      els.alertTitle.textContent = "No target selected";
      els.alertText.textContent = "Use your location or search a place to monitor nearby strikes.";
      els.mapHeadline.textContent = isLatestCheckpoint()
        ? "Live lightning map"
        : "Historical lightning map";
      els.mapSubline.textContent = `${state.visibleStrikes.length.toLocaleString()} strikes visible for ${windowLabel.toLowerCase()} ending ${checkpointLabel}.`;
    } else if (nearby.length) {
      els.alertCard.className = "alert-card danger";
      els.alertTitle.textContent = `${nearby.length} nearby`;
      els.alertText.textContent = `${nearby.length} strike${nearby.length === 1 ? "" : "s"} inside ${state.radiusKm} km of ${state.target.label} for the selected ${timelineMode}.`;
      els.mapHeadline.textContent = isLatestCheckpoint()
        ? "Lightning alert active"
        : "Historical nearby strikes";
      els.mapSubline.textContent = `Nearest strike is ${nearby[0].distanceKm.toFixed(1)} km away. ${windowLabel} ending ${checkpointLabel}.`;
    } else {
      els.alertCard.className = "alert-card safe";
      els.alertTitle.textContent = "No nearby strikes";
      els.alertText.textContent = `No strikes found inside ${state.radiusKm} km of ${state.target.label} for the selected ${timelineMode}.`;
      els.mapHeadline.textContent = isLatestCheckpoint()
        ? "Monitoring radius"
        : "Viewing historical checkpoint";
      els.mapSubline.textContent = `${windowLabel} ending ${checkpointLabel}.`;
    }

    renderAlertList(nearby);
    renderFeedList();
    renderTimeline(state.timeline);
  }

  function renderAlertList(nearby) {
    els.alertList.innerHTML = "";

    if (!nearby.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = state.target
        ? "No cached strikes are currently inside the alert radius."
        : "Nearby strike alerts will appear here.";
      els.alertList.appendChild(empty);
      return;
    }

    nearby.slice(0, 10).forEach((strike) => {
      const item = document.createElement("article");
      item.className = "alert-item";
      item.innerHTML = `<div class="item-row">
        <strong>${strike.distanceKm.toFixed(1)} km away</strong>
        <span>${formatAge(strike.timestampMs)}</span>
      </div>
      <small>${formatStrikeTime(strike.timestampMs)} at ${strike.lat.toFixed(3)}, ${strike.lon.toFixed(3)}</small>`;
      els.alertList.appendChild(item);
    });
  }

  function renderFeedList() {
    els.feedList.innerHTML = "";

    if (!state.strikes.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Waiting for strike data.";
      els.feedList.appendChild(empty);
      return;
    }

    state.strikes.slice(0, 10).forEach((strike) => {
      const item = document.createElement("article");
      item.className = "feed-item";
      const distance = state.target
        ? `${haversineKm(state.target.lat, state.target.lon, strike.lat, strike.lon).toFixed(1)} km`
        : "distance off";
      item.innerHTML = `<div class="item-row">
        <strong>${formatAge(strike.timestampMs)}</strong>
        <span>${distance}</span>
      </div>
      <small>${formatStrikeTime(strike.timestampMs)} at ${strike.lat.toFixed(3)}, ${strike.lon.toFixed(3)}</small>`;
      els.feedList.appendChild(item);
    });
  }

  function normalizeTimeline(timeline) {
    return timeline
      .map((bucket) => ({
        start: bucket.start || bucket.hourStart || bucket.hour,
        end: bucket.end || bucket.hourEnd || bucket.endTime,
        count: Number(bucket.count || 0),
      }))
      .map((bucket) => {
        if (!bucket.end && bucket.start) {
          bucket.end = new Date(Date.parse(bucket.start) + CHECKPOINT_MS).toISOString();
        }
        return bucket;
      })
      .filter((bucket) => bucket.start && bucket.end && Number.isFinite(bucket.count));
  }

  function buildTimeline(strikes, checkpointCount) {
    const latestEndMs = getTimelineEndMs(strikes);
    const buckets = [];
    const bucketByStart = new Map();

    for (let index = checkpointCount - 1; index >= 0; index -= 1) {
      const endMs = latestEndMs - index * CHECKPOINT_MS;
      const startMs = endMs - CHECKPOINT_MS;
      const bucket = {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        count: 0,
      };
      buckets.push(bucket);
      bucketByStart.set(startMs, bucket);
    }

    strikes.forEach((strike) => {
      const startMs = Math.floor(strike.timestampMs / CHECKPOINT_MS) * CHECKPOINT_MS;
      const bucket = bucketByStart.get(startMs);
      if (bucket) {
        bucket.count += 1;
      }
    });

    return buckets;
  }

  function getTimelineEndMs(strikes) {
    const latestStrikeMs = strikes
      .map((strike) => strike.timestampMs)
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    const anchorMs = latestStrikeMs || Date.now();
    return Math.floor(anchorMs / CHECKPOINT_MS) * CHECKPOINT_MS + CHECKPOINT_MS;
  }

  function getTimelineBuckets() {
    return state.timeline.length
      ? state.timeline.slice(-CHECKPOINT_COUNT)
      : buildTimeline([], CHECKPOINT_COUNT);
  }

  function getTimelineRangeCheckpointCount() {
    const checkpoints = Math.round((state.timelineRangeHours * 60 * 60 * 1000) / CHECKPOINT_MS);
    return Math.min(CHECKPOINT_COUNT, Math.max(1, checkpoints));
  }

  function getTimelineBounds(buckets = getTimelineBuckets()) {
    const endIndex = Math.max(0, buckets.length - 1);
    const visibleCount = Math.min(buckets.length || 1, getTimelineRangeCheckpointCount());
    const startIndex = Math.max(0, endIndex - visibleCount + 1);
    return { startIndex, endIndex, visibleCount };
  }

  function selectTimelineIndex(index) {
    const { startIndex, endIndex } = getTimelineBounds();
    state.timelineIndex = Math.min(endIndex, Math.max(startIndex, index));
    state.timelineLive = state.timelineIndex >= endIndex;
    updateVisibleStrikes();
    evaluateAlerts();
    renderStrikes();
    renderDashboard();
  }

  function setTimelineRange(hours) {
    if (![1, 6, 12, 24].includes(hours)) return;

    state.timelineRangeHours = hours;
    const { startIndex, endIndex } = getTimelineBounds();
    if (state.timelineIndex < startIndex || state.timelineIndex > endIndex) {
      state.timelineIndex = endIndex;
      state.timelineLive = true;
    }

    updateVisibleStrikes();
    evaluateAlerts();
    renderStrikes();
    renderDashboard();
  }

  function toggleTimelinePlayback() {
    if (state.timelinePlaying) {
      stopTimelinePlayback();
      return;
    }

    startTimelinePlayback();
  }

  function startTimelinePlayback() {
    const { startIndex, endIndex } = getTimelineBounds();
    if (startIndex === endIndex) {
      selectTimelineIndex(endIndex);
      return;
    }

    if (state.timelineIndex >= endIndex || state.timelineIndex < startIndex) {
      state.timelineIndex = startIndex;
      state.timelineLive = false;
      updateVisibleStrikes();
      evaluateAlerts();
      renderStrikes();
      renderDashboard();
    }

    state.timelinePlaying = true;
    updateTimelinePlaybackButton();
    state.timelinePlaybackTimer = window.setInterval(advanceTimelinePlayback, TIMELINE_PLAYBACK_MS);
  }

  function advanceTimelinePlayback() {
    const { endIndex } = getTimelineBounds();
    if (state.timelineIndex >= endIndex) {
      stopTimelinePlayback();
      state.timelineLive = true;
      renderDashboard();
      return;
    }

    state.timelineIndex += 1;
    state.timelineLive = state.timelineIndex >= endIndex;
    updateVisibleStrikes();
    evaluateAlerts();
    renderStrikes();
    renderDashboard();

    if (state.timelineIndex >= endIndex) {
      stopTimelinePlayback();
    }
  }

  function stopTimelinePlayback() {
    if (state.timelinePlaybackTimer) {
      window.clearInterval(state.timelinePlaybackTimer);
      state.timelinePlaybackTimer = null;
    }

    if (state.timelinePlaying) {
      state.timelinePlaying = false;
      updateTimelinePlaybackButton();
    }
  }

  function renderTimeline(timeline) {
    const buckets = timeline.length ? timeline.slice(-CHECKPOINT_COUNT) : buildTimeline([], CHECKPOINT_COUNT);
    const { startIndex, endIndex } = getTimelineBounds(buckets);
    const visibleBuckets = buckets.slice(startIndex, endIndex + 1);
    const max = Math.max(1, ...visibleBuckets.map((bucket) => bucket.count));
    els.timelineBars.innerHTML = "";
    syncTimelineSelection();
    renderTimelineControls(buckets);
    els.timelineBars.style.setProperty("--timeline-bars", String(Math.max(1, visibleBuckets.length)));

    visibleBuckets.forEach((bucket, index) => {
      const timelineIndex = startIndex + index;
      const bar = document.createElement("button");
      const percent = Math.max(6, Math.round((bucket.count / max) * 100));
      bar.className = `timeline-bar ${bucket.count ? "" : "quiet"} ${
        timelineIndex === state.timelineIndex ? "active" : ""
      }`;
      bar.type = "button";
      bar.style.height = `${percent}%`;
      bar.dataset.count = bucket.count.toLocaleString();
      bar.title = `${formatCheckpointRange(bucket)}: ${bucket.count.toLocaleString()} strikes`;
      bar.addEventListener("click", () => {
        stopTimelinePlayback();
        selectTimelineIndex(timelineIndex);
      });
      els.timelineBars.appendChild(bar);
    });
  }

  function renderTimelineControls(buckets) {
    const checkpoint = getSelectedCheckpoint();
    const { startIndex, endIndex } = getTimelineBounds(buckets);
    const selectedIndex = Math.min(Math.max(state.timelineIndex, startIndex), endIndex);
    els.timelineSlider.min = String(startIndex);
    els.timelineSlider.max = String(endIndex);
    els.timelineSlider.value = String(selectedIndex);
    els.timelineLabel.textContent = isLatestCheckpoint() ? "Latest" : formatCheckpointEnd(checkpoint);
    els.timelineWindow.textContent = `${selectedWindowLabel()} ending ${formatCheckpointEnd(checkpoint)}`;
    els.timelineRangeLabel.textContent = `Playing last ${state.timelineRangeHours}h | 15 min steps`;
    updateTimelineRangeButtons();
    updateTimelinePlaybackButton();
  }

  function updateTimelineRangeButtons() {
    els.timelineRangeButtons.forEach((button) => {
      const isActive = Number(button.dataset.timelineHours) === state.timelineRangeHours;
      button.classList.toggle("active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
  }

  function updateTimelinePlaybackButton() {
    els.timelinePlayButton.textContent = state.timelinePlaying ? "Pause" : "Play";
    els.timelinePlayButton.classList.toggle("active", state.timelinePlaying);
    els.timelinePlayButton.setAttribute(
      "aria-label",
      state.timelinePlaying ? "Pause timeline" : "Play timeline",
    );
  }

  async function performSearch(query) {
    els.searchResults.innerHTML = "";

    if (!query) {
      showToast("Enter a place name or coordinates to search.");
      return;
    }

    const coordinates = parseCoordinates(query);
    if (coordinates) {
      setTarget({ ...coordinates, label: `${coordinates.lat.toFixed(3)}, ${coordinates.lon.toFixed(3)}`, type: "search" }, true);
      return;
    }

    setConnection("loading", "Searching location");

    try {
      const results = await searchPlaces(query);
      renderSearchResults(results);
      if (results[0]) {
        setTarget(
          {
            lat: Number(results[0].lat),
            lon: Number(results[0].lon),
            label: shortPlaceName(results[0].display_name),
            type: "search",
          },
          true,
        );
      } else {
        showToast("No matching places found.", "danger");
      }
      restoreFeedConnection();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Search failed";
      setConnection("error", "Location search failed");
      showToast(message, "danger");
    }
  }

  async function searchPlaces(query) {
    const sameOrigin = window.location.protocol === "http:" || window.location.protocol === "https:";
    const endpoints = sameOrigin
      ? [apiUrl(`/api/search?q=${encodeURIComponent(query)}`), nominatimUrl(query)]
      : [nominatimUrl(query)];
    let lastError = null;

    for (const endpoint of endpoints) {
      try {
        const response = await fetchWithTimeout(endpoint, 12_000);
        if (!response.ok) {
          throw new Error(`Search returned ${response.status}`);
        }
        const payload = await response.json();
        return Array.isArray(payload) ? payload : payload.results || [];
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Search is unavailable.");
  }

  function nominatimUrl(query) {
    return `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
  }

  function apiUrl(path) {
    return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
  }

  function renderSearchResults(results) {
    els.searchResults.innerHTML = "";
    results.slice(0, 5).forEach((result) => {
      const button = document.createElement("button");
      button.className = "search-result-button";
      button.type = "button";
      button.innerHTML = `<strong>${escapeHtml(shortPlaceName(result.display_name))}</strong>
        <span>${Number(result.lat).toFixed(3)}, ${Number(result.lon).toFixed(3)}</span>`;
      button.addEventListener("click", () => {
        userGesture();
        setTarget(
          {
            lat: Number(result.lat),
            lon: Number(result.lon),
            label: shortPlaceName(result.display_name),
            type: "search",
          },
          true,
        );
      });
      els.searchResults.appendChild(button);
    });
  }

  function parseCoordinates(query) {
    const match = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match) return null;

    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      showToast("Coordinates are outside valid latitude/longitude ranges.", "danger");
      return null;
    }
    return { lat, lon };
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      showToast("Browser notifications are not supported here.", "danger");
      return;
    }

    const permission = await Notification.requestPermission();
    updateNotificationButton();

    if (permission === "granted") {
      showToast("Browser lightning alerts enabled.", "success");
    } else {
      showToast("Notifications were not enabled.");
    }
  }

  function updateNotificationButton() {
    if (!("Notification" in window)) {
      els.notificationButton.textContent = "Alerts unavailable";
      els.notificationButton.disabled = true;
      return;
    }

    els.notificationButton.textContent =
      Notification.permission === "granted" ? "Alerts enabled" : "Enable alerts";
  }

  function notifyNearby(strikes) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    const nearest = strikes[0];
    try {
      new Notification("Lightning alert", {
        body: `${strikes.length} new strike${strikes.length === 1 ? "" : "s"} within ${state.radiusKm} km. Nearest: ${nearest.distanceKm.toFixed(1)} km.`,
        tag: "lightning-weather-x-alert",
        renotify: true,
      });
    } catch {
      // Android Chrome only allows notifications from a service worker; the in-page toast still shows.
    }
  }

  async function playAlarm() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    state.audioContext = state.audioContext || new AudioContext();
    if (state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }

    const ctx = state.audioContext;
    const now = ctx.currentTime;
    [0, 0.28, 0.56].forEach((offset, index) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sawtooth";
      oscillator.frequency.setValueAtTime(index % 2 === 0 ? 740 : 520, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.16, now + offset + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2);
      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.22);
    });
  }

  function userGesture() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext || state.audioContext) return;

    state.audioContext = new AudioContext();
    if (state.audioContext.state === "suspended") {
      state.audioContext.resume().catch(() => {});
    }
  }

  function scheduleAutoRefresh() {
    if (state.autoRefreshTimer) {
      window.clearInterval(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }

    if (els.autoRefreshToggle.checked) {
      state.autoRefreshTimer = window.setInterval(() => fetchStrikes(true), AUTO_REFRESH_MS);
    }
  }

  function restoreFeedConnection() {
    if (state.feedHealthy) setConnection("ok", "Live strike feed connected");
    else setConnection("error", "Strike feed unavailable");
  }

  function setConnection(status, message) {
    els.connectionStatus.textContent = message;
    els.liveDot.classList.toggle("warning", status === "loading");
    els.liveDot.classList.toggle("error", status === "error");
  }

  function showToast(message, tone) {
    const toast = document.createElement("div");
    toast.className = `radar-toast ${tone || ""}`;
    toast.textContent = message;
    els.toastStack.appendChild(toast);
    window.setTimeout(() => {
      toast.remove();
    }, 5200);
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const radius = 6371;
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function toRadians(value) {
    return (value * Math.PI) / 180;
  }

  function formatStrikeTime(timestampMs) {
    if (!Number.isFinite(timestampMs)) return "--";
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: API_TIMEZONE,
      timeZoneName: "short",
    }).format(new Date(timestampMs));
  }

  function formatUnixTime(seconds) {
    const timestampMs = Number(seconds) * 1000;
    if (!Number.isFinite(timestampMs)) return "unknown";
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(timestampMs));
  }

  function formatCheckpointEnd(checkpoint) {
    if (!checkpoint?.end) return "latest checkpoint";
    const date = new Date(checkpoint.end);
    if (Number.isNaN(date.getTime())) return "Unknown hour";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: API_TIMEZONE,
    }).format(date);
  }

  function formatCheckpointRange(checkpoint) {
    if (!checkpoint?.start || !checkpoint?.end) return "Unknown checkpoint";
    const start = new Date(checkpoint.start);
    const end = new Date(checkpoint.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return "Unknown checkpoint";
    }

    const formatter = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: API_TIMEZONE,
    });
    return `${formatter.format(start)} - ${formatter.format(end)}`;
  }

  function selectedWindowLabel() {
    const filter = els.timeFilter.value;
    if (filter === "all") return "Previous 24 hours";
    const minutes = Number(filter);
    if (minutes < 60) return `Previous ${minutes} minutes`;
    const hours = minutes / 60;
    return `Previous ${hours} hour${hours === 1 ? "" : "s"}`;
  }

  function formatLocalTime(date) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }

  function formatAge(timestampMs) {
    const diff = Math.max(0, Date.now() - timestampMs);
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    return `${Math.floor(hours / 24)} day ago`;
  }

  function shortPlaceName(name) {
    return String(name || "Selected place")
      .split(",")
      .slice(0, 3)
      .map((part) => part.trim())
      .filter(Boolean)
      .join(", ");
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();

