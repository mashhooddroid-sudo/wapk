// 3D globe view for Maps (the "3D" button). The flat Leaflet map stays the main map; the globe is a MapLibre
// map in globe projection laid over it, loaded on first use. It shows the same base map, the forecast colour
// picture (forecast.js hands it over after every draw) and the wind particles, which are animated on a canvas
// above the globe from the same wind field. MapLibre's globe runs in iOS Safari and the app's web view.
(function () {
  const MAPLIBRE_VERSION = "5.24.0";
  const MAPLIBRE_JS = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js`;
  const MAPLIBRE_CSS = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;
  const BASE_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
  const LABEL_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}";
  const ATTRIBUTION = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors · Forecast &copy; <a href="https://www.ecmwf.int/">ECMWF</a> (CC-BY-4.0)';
  const FIELD_STRIDE = 8;
  const PARTICLE_MAX_AGE = 90;

  let libraryPromise = null;
  function loadLibrary() {
    if (window.maplibregl) return Promise.resolve();
    libraryPromise ||= new Promise((resolve, reject) => {
      const style = document.createElement("link");
      style.rel = "stylesheet";
      style.href = MAPLIBRE_CSS;
      document.head.append(style);
      const script = document.createElement("script");
      script.src = MAPLIBRE_JS;
      script.onload = () => resolve();
      script.onerror = () => {
        libraryPromise = null;
        reject(new Error("The 3D globe could not load."));
      };
      document.head.append(script);
    });
    return libraryPromise;
  }

  // `stage` is the Maps container; `options.onPick(lat, lon)` runs when the globe is tapped.
  function attach(stage, options = {}) {
    const state = { map: null, ready: false, visible: false, draw: null, frame: 0, particles: [], field: null };
    const container = document.createElement("div");
    container.className = "globe-map";
    container.hidden = true;
    const windCanvas = document.createElement("canvas");
    windCanvas.className = "globe-particles";
    container.append(windCanvas);
    stage.append(container);

    async function show(view) {
      state.visible = true;
      container.hidden = false;
      await loadLibrary();
      if (!state.visible) return;
      if (!state.map) create(view);
      else {
        state.map.resize();
        state.map.jumpTo(view);
      }
      applyDraw();
    }

    function hide() {
      state.visible = false;
      container.hidden = true;
      stopParticles();
      const map = state.map;
      if (!map) return null;
      const center = map.getCenter();
      return { lat: center.lat, lon: center.lng, zoom: map.getZoom() };
    }

    function create(view) {
      const map = new window.maplibregl.Map({
        container,
        attributionControl: { compact: true, customAttribution: ATTRIBUTION },
        center: view.center,
        zoom: view.zoom,
        maxZoom: 9,
        style: {
          version: 8,
          projection: { type: "globe" },
          sky: {
            "sky-color": "#06142b",
            "horizon-color": "#1f5a9e",
            "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0],
          },
          sources: {
            base: { type: "raster", tiles: [BASE_TILES], tileSize: 256, maxzoom: 16 },
            labels: { type: "raster", tiles: [LABEL_TILES], tileSize: 256, maxzoom: 16 },
          },
          layers: [
            { id: "space", type: "background", paint: { "background-color": "#030a17" } },
            { id: "base", type: "raster", source: "base" },
            { id: "labels", type: "raster", source: "labels" },
          ],
        },
      });
      map.addControl(new window.maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "bottom-right");
      // The picker and point forecast follow taps on the globe, as on the flat map.
      map.on("click", (event) => options.onPick?.(event.lngLat.lat, event.lngLat.lng));
      map.on("movestart", stopParticles);
      map.on("moveend", resetParticles);
      map.on("resize", resetParticles);
      map.on("load", () => {
        state.ready = true;
        applyDraw();
      });
      state.map = map;
    }

    // forecast.js calls this after every draw: { canvas, bounds, opacity, wind, windColor, speedScale,
    // particleStyle }, or null when the forecast is off.
    function setDraw(draw) {
      state.draw = draw;
      if (state.visible) applyDraw();
    }

    function applyDraw() {
      const map = state.map;
      if (!map || !state.ready) return;
      const draw = state.draw;
      const source = map.getSource("forecast");
      if (draw?.canvas && draw.bounds) {
        const south = draw.bounds.getSouth();
        const north = draw.bounds.getNorth();
        const west = draw.bounds.getWest();
        const east = draw.bounds.getEast();
        const coordinates = [[west, north], [east, north], [east, south], [west, south]];
        if (!source) {
          map.addSource("forecast", { type: "canvas", canvas: draw.canvas, coordinates, animate: false });
          map.addLayer({ id: "forecast", type: "raster", source: "forecast", paint: { "raster-opacity": draw.opacity, "raster-fade-duration": 0, "raster-resampling": "linear" } }, "labels");
        } else {
          source.setCoordinates(coordinates);
          map.setPaintProperty("forecast", "raster-opacity", draw.opacity);
        }
        // A canvas source re-reads its canvas only while playing; one frame picks up the new picture.
        const canvasSource = map.getSource("forecast");
        canvasSource.play();
        requestAnimationFrame(() => canvasSource.pause());
      } else if (source) {
        map.removeLayer("forecast");
        map.removeSource("forecast");
      }
      resetParticles();
    }

    // ── Wind particles on the globe ──────────────────────────────────────────
    // The wind is sampled every FIELD_STRIDE pixels over the visible globe; each sample's eastward and
    // northward wind is turned into a screen direction from where nearby points land on screen, so the
    // particles follow the curve of the globe. Like the flat map, they stop while the globe moves.
    function stopParticles() {
      if (state.frame) cancelAnimationFrame(state.frame);
      state.frame = 0;
      windCanvas.getContext("2d").clearRect(0, 0, windCanvas.width, windCanvas.height);
    }

    function resetParticles() {
      stopParticles();
      const map = state.map;
      const draw = state.draw;
      if (!map || !state.visible || !draw?.wind || document.hidden) return;
      const width = container.clientWidth;
      const height = container.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      windCanvas.width = Math.round(width * ratio);
      windCanvas.height = Math.round(height * ratio);
      windCanvas.style.width = `${width}px`;
      windCanvas.style.height = `${height}px`;
      const context = windCanvas.getContext("2d");
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      const columns = Math.ceil(width / FIELD_STRIDE) + 1;
      const rows = Math.ceil(height / FIELD_STRIDE) + 1;
      const lats = new Float64Array(columns * rows).fill(NaN);
      const lons = new Float64Array(columns * rows).fill(NaN);
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
          const x = col * FIELD_STRIDE;
          const y = row * FIELD_STRIDE;
          const point = map.unproject([x, y]);
          // Points off the edge of the globe do not come back to where they started.
          const back = map.project(point);
          if (Math.abs(back.x - x) > 1.5 || Math.abs(back.y - y) > 1.5) continue;
          lats[row * columns + col] = point.lat;
          lons[row * columns + col] = point.lng;
        }
      }
      const { u, v } = draw.wind(lats, lons);
      const style = draw.particleStyle || { speed: 1, length: 1, thickness: 1, density: 1 };
      // Same on-screen pace as the flat map at this zoom (Leaflet zoom is one more than MapLibre's).
      const leafletZoom = map.getZoom() + 1;
      const perFrame = 0.11 * draw.speedScale * style.speed * Math.pow(1.25, leafletZoom - 5);
      const metresPerPixel = 40075016 / (256 * Math.pow(2, leafletZoom));
      const field = new Float32Array(columns * rows * 2).fill(NaN);
      const step = 0.05;
      for (let index = 0; index < columns * rows; index += 1) {
        const lat = lats[index];
        const lon = lons[index];
        if (Number.isNaN(lat) || Number.isNaN(u[index])) continue;
        const here = map.project([lon, lat]);
        const east = map.project([lon + step, lat]);
        const north = map.project([lon, Math.min(89.9, lat + step)]);
        const eastMetres = step * 111320 * Math.cos((lat * Math.PI) / 180) || 1;
        const northMetres = step * 110570;
        // Screen pixels per metre east and north, times the wind in m/s, scaled to the flat map's pace.
        const scale = perFrame * metresPerPixel;
        field[index * 2] = scale * (u[index] * (east.x - here.x) / eastMetres + v[index] * (north.x - here.x) / northMetres);
        field[index * 2 + 1] = scale * (u[index] * (east.y - here.y) / eastMetres + v[index] * (north.y - here.y) / northMetres);
      }
      state.field = { field, columns, rows, width, height };
      const maxAge = Math.round(PARTICLE_MAX_AGE * Math.max(0.7, style.length));
      const count = Math.round(Math.min(3000 * style.density, ((width * height) / 200) * style.density));
      const spawn = (particle, randomAge) => {
        particle.x = Math.random() * width;
        particle.y = Math.random() * height;
        particle.age = randomAge ? Math.floor(Math.random() * maxAge) : 0;
        return particle;
      };
      state.particles = Array.from({ length: count }, () => spawn({}, true));
      const fade = `rgba(0, 0, 0, ${(1 - 0.08 / style.length).toFixed(3)})`;
      const velocity = (x, y) => {
        const col = Math.round(x / FIELD_STRIDE);
        const row = Math.round(y / FIELD_STRIDE);
        if (col < 0 || row < 0 || col >= columns || row >= rows) return null;
        const index = (row * columns + col) * 2;
        return Number.isNaN(field[index]) ? null : [field[index], field[index + 1]];
      };
      const tick = () => {
        context.globalCompositeOperation = "destination-in";
        context.fillStyle = fade;
        context.fillRect(0, 0, width, height);
        context.globalCompositeOperation = "source-over";
        context.strokeStyle = draw.windColor;
        context.lineWidth = 1.1 * style.thickness;
        context.beginPath();
        for (const particle of state.particles) {
          const move = particle.age < maxAge ? velocity(particle.x, particle.y) : null;
          if (!move) {
            spawn(particle, false);
            continue;
          }
          context.moveTo(particle.x, particle.y);
          particle.x += move[0];
          particle.y += move[1];
          context.lineTo(particle.x, particle.y);
          particle.age += 1;
        }
        context.stroke();
        state.frame = requestAnimationFrame(tick);
      };
      state.frame = requestAnimationFrame(tick);
    }

    document.addEventListener("visibilitychange", () => {
      if (!state.visible) return;
      if (document.hidden) stopParticles();
      else resetParticles();
    });

    return { show, hide, setDraw, isVisible: () => state.visible };
  }

  window.WapkGlobe = { attach };
})();
