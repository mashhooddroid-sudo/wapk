import json, sys
pal = json.load(open(sys.argv[1]))
out_path = sys.argv[2]
master = [c for c in pal["master"] if tuple(c) != (140, 106, 177)]
hexes = lambda colours: " ".join(f"{r:02x}{g:02x}{b:02x}" for r, g, b in colours)

js = r'''(() => {
  "use strict";

  // IMD (India Meteorological Department) radar on the WAPK map. IMD publishes each radar as a finished picture
  // (rain drawn over terrain, rings, labels and side panels), so the browser keeps only the pixels in IMD's rain
  // colours and places the picture's radar circle on the map. Pictures come through the PK worker
  // (/api/imd-radar/<code>), which also reports when each one last changed; radars whose picture has not changed
  // for STALE_MS are left out (several IMD radars stop updating for days).
  //
  // Each station's geometry was measured from its own picture (map square, centre, pixels per km, printed range)
  // and checked against Natural Earth state boundaries; the radar position is the fitted site. A picture of any
  // other size means IMD changed the layout, and that radar is skipped until it is measured again.
  const STATIONS = [
    { code: "delhi", name: "Delhi (Palam)", lat: 28.5592, lon: 77.0593, size: [880, 720], panel: [0, 154, 566, 720], cx: 283, cy: 437, pxPerKm: 1.132, rangeKm: 250 },
    { code: "jpr", name: "Jaipur", lat: 26.8197, lon: 75.7913, size: [880, 720], panel: [0, 201, 519, 720], cx: 259.5, cy: 460.5, pxPerKm: 1.038, rangeKm: 250, gradient: true },
    { code: "ptl", name: "Patiala", lat: 30.3421, lon: 76.4228, size: [880, 720], panel: [0, 201, 519, 720], cx: 259.5, cy: 460.5, pxPerKm: 0.865, rangeKm: 300 },
    { code: "bhj", name: "Bhuj", lat: 23.2418, lon: 69.6458, size: [1078, 770], panel: [0, 183, 600, 770], cx: 320, cy: 469, pxPerKm: 1.15, rangeKm: 240 },
    { code: "srn", name: "Srinagar", lat: 34.0427, lon: 74.7833, size: [880, 523], panel: [18, 132, 417, 523], cx: 221, cy: 306, pxPerKm: 1.94, rangeKm: 100.5 },
    { code: "mur", name: "Murari Devi", lat: 31.5149, lon: 76.7996, size: [1250, 1020], panel: [0, 224, 796, 1020], cx: 398, cy: 622, pxPerKm: 3.98, rangeKm: 100 },
    { code: "jot", name: "Jot", lat: 32.4934, lon: 76.0335, size: [1250, 1020], panel: [0, 225, 795, 1020], cx: 397.5, cy: 622.5, pxPerKm: 3.975, rangeKm: 100 },
    { code: "kuf", name: "Kufri", lat: 31.1015, lon: 77.2493, size: [1250, 1020], panel: [0, 224, 796, 1020], cx: 398, cy: 622, pxPerKm: 3.98, rangeKm: 100 },
    { code: "sur", name: "Surkanda Devi", lat: 30.4148, lon: 78.2753, size: [1272, 1042], panel: [0, 246, 796, 1042], cx: 398, cy: 644, pxPerKm: 3.98, rangeKm: 100 },
    { code: "ldn", name: "Lansdowne", lat: 29.8455, lon: 78.671, size: [1017, 787], panel: [0, 188, 599, 787], cx: 299.5, cy: 487.5, pxPerKm: 2.995, rangeKm: 100 },
    { code: "mks", name: "Mukteshwar", lat: 29.4546, lon: 79.6445, size: [1017, 787], panel: [0, 191, 596, 787], cx: 298, cy: 489, pxPerKm: 2.98, rangeKm: 100 },
  ];
  // IMD's rain colours (20 dBZ purple … 60+ dBZ dark red), as used by all these radars; Jaipur draws a smooth scale.
  const RAIN_COLOURS = new Set("__MASTER__".split(" ").map((hex) => parseInt(hex, 16)));
  const JAIPUR_COLOURS = new Set("__JPR__".split(" ").map((hex) => parseInt(hex, 16)));
  const REFRESH_MS = 10 * 60 * 1000;
  const STALE_MS = 90 * 60 * 1000;
  // White and pale yellow also appear as snow and labels, and red as town markers: they count as rain only
  // next to other rain colours.
  const NEAR_PX = 3;

  const isPale = (rgb) => (rgb >> 16) > 230 && ((rgb >> 8) & 255) > 230 && (rgb & 255) > 110;
  const isRed = (rgb) => (rgb >> 16) > 180 && ((rgb >> 8) & 255) < 40;

  let OverlayClass = null;
  function canvasOverlay(canvas, bounds, options) {
    OverlayClass ||= L.ImageOverlay.extend({
      _initImage() {
        const image = (this._image = this._url);
        L.DomUtil.addClass(image, "leaflet-image-layer");
        if (this._zoomAnimated) L.DomUtil.addClass(image, "leaflet-zoom-animated");
        if (this.options.className) L.DomUtil.addClass(image, this.options.className);
        image.onselectstart = L.Util.falseFn;
        image.onmousemove = L.Util.falseFn;
      },
    });
    return new OverlayClass(canvas, bounds, options);
  }

  // The rain inside the radar's circle as a transparent canvas, and its map bounds.
  function extract(station, bitmap) {
    const [x0, y0, x1, y1] = station.panel;
    const radius = station.rangeKm * station.pxPerKm;
    const left = Math.max(x0, Math.floor(station.cx - radius));
    const top = Math.max(y0, Math.floor(station.cy - radius));
    const right = Math.min(x1, Math.ceil(station.cx + radius));
    const bottom = Math.min(y1, Math.ceil(station.cy + radius));
    const width = right - left;
    const height = bottom - top;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
    const picture = context.getImageData(0, 0, width, height);
    const pixels = picture.data;
    const colours = station.gradient ? JAIPUR_COLOURS : RAIN_COLOURS;
    const kind = new Uint8Array(width * height); // 0 none, 1 rain, 2 pale/red (needs rain nearby)
    for (let y = 0; y < height; y += 1) {
      const dy = top + y - station.cy;
      for (let x = 0; x < width; x += 1) {
        const dx = left + x - station.cx;
        if (dx * dx + dy * dy > radius * radius) continue;
        const index = y * width + x;
        const rgb = (pixels[index * 4] << 16) | (pixels[index * 4 + 1] << 8) | pixels[index * 4 + 2];
        if (!colours.has(rgb)) continue;
        kind[index] = isPale(rgb) || isRed(rgb) ? 2 : 1;
      }
    }
    // Rain nearby: a box dilation of the plain rain pixels, done as two running passes.
    const near = new Uint8Array(width * height);
    const rows = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      let last = -1e9;
      for (let x = 0; x < width; x += 1) {
        if (kind[y * width + x] === 1) last = x;
        if (x - last <= NEAR_PX) rows[y * width + x] = 1;
      }
      last = 1e9;
      for (let x = width - 1; x >= 0; x -= 1) {
        if (kind[y * width + x] === 1) last = x;
        if (last - x <= NEAR_PX) rows[y * width + x] = 1;
      }
    }
    for (let x = 0; x < width; x += 1) {
      let last = -1e9;
      for (let y = 0; y < height; y += 1) {
        if (rows[y * width + x]) last = y;
        if (y - last <= NEAR_PX) near[y * width + x] = 1;
      }
      last = 1e9;
      for (let y = height - 1; y >= 0; y -= 1) {
        if (rows[y * width + x]) last = y;
        if (last - y <= NEAR_PX) near[y * width + x] = 1;
      }
    }
    let rainy = 0;
    for (let index = 0; index < kind.length; index += 1) {
      const keep = kind[index] === 1 || (kind[index] === 2 && near[index]);
      if (keep) rainy += 1;
      else pixels[index * 4 + 3] = 0;
      if (keep) kind[index] = 1;
      else kind[index] = 0;
    }
    // Fill the thin gaps IMD's borders and rings leave inside rain with a neighbour's colour.
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (kind[index]) continue;
        let count = 0;
        let from = -1;
        for (const offset of [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1]) {
          if (kind[index + offset]) {
            count += 1;
            from = index + offset;
          }
        }
        if (count >= 5) {
          pixels[index * 4] = pixels[from * 4];
          pixels[index * 4 + 1] = pixels[from * 4 + 1];
          pixels[index * 4 + 2] = pixels[from * 4 + 2];
          pixels[index * 4 + 3] = 255;
        }
      }
    }
    context.putImageData(picture, 0, 0);
    // Pixels to degrees around the radar (the pictures are close to equidistant over a few hundred km).
    const kmPerLat = 110.574;
    const kmPerLon = 111.32 * Math.cos((station.lat * Math.PI) / 180);
    const bounds = [
      [station.lat - (bottom - station.cy) / station.pxPerKm / kmPerLat, station.lon - (station.cx - left) / station.pxPerKm / kmPerLon],
      [station.lat + (station.cy - top) / station.pxPerKm / kmPerLat, station.lon + (right - station.cx) / station.pxPerKm / kmPerLon],
    ];
    return { canvas, bounds, rainy };
  }

  function attach(map, options) {
    const state = { visible: false, layers: new Map(), timer: null, loading: 0, request: 0, info: new Map() };

    async function load(station, request) {
      try {
        const response = await fetch(options.apiUrl(`/api/imd-radar/${station.code}`), { signal: AbortSignal.timeout(40_000) });
        if (!response.ok) throw new Error(String(response.status));
        const changed = Number(response.headers.get("X-Image-Changed")) || Date.now();
        const bitmap = await createImageBitmap(await response.blob());
        if (request !== state.request || !state.visible) return;
        if (bitmap.width !== station.size[0] || bitmap.height !== station.size[1]) {
          state.info.set(station.code, { status: "layout" });
          remove(station.code);
          return;
        }
        if (Date.now() - changed > STALE_MS) {
          state.info.set(station.code, { status: "stale", changed });
          remove(station.code);
          return;
        }
        const { canvas, bounds } = extract(station, bitmap);
        bitmap.close?.();
        const overlay = canvasOverlay(canvas, bounds, {
          pane: options.pane,
          opacity: options.getOpacity(),
          interactive: false,
          className: "imd-radar-frame",
          attribution: 'Radar &copy; <a href="https://mausam.imd.gov.in/responsive/radar.php" target="_blank" rel="noopener noreferrer">IMD</a>',
        });
        overlay.addTo(map);
        remove(station.code);
        state.layers.set(station.code, overlay);
        state.info.set(station.code, { status: "ok", changed });
      } catch {
        if (request === state.request) state.info.set(station.code, { status: "error" });
      } finally {
        if (request === state.request) {
          state.loading -= 1;
          if (!state.loading) options.onStatus?.(summary());
        }
      }
    }

    function remove(code) {
      const layer = state.layers.get(code);
      if (layer) map.removeLayer(layer);
      state.layers.delete(code);
    }

    function refresh() {
      if (!state.visible) return;
      const request = ++state.request;
      state.loading = STATIONS.length;
      STATIONS.forEach((station) => load(station, request));
      clearTimeout(state.timer);
      state.timer = setTimeout(refresh, REFRESH_MS);
    }

    function summary() {
      const shown = STATIONS.filter((station) => state.info.get(station.code)?.status === "ok").map((station) => station.name);
      const stale = STATIONS.filter((station) => state.info.get(station.code)?.status === "stale").map((station) => station.name);
      return { shown, stale };
    }

    function setVisible(visible) {
      if (visible === state.visible) return;
      state.visible = visible;
      if (visible) refresh();
      else {
        state.request += 1;
        clearTimeout(state.timer);
        [...state.layers.keys()].forEach(remove);
      }
    }

    return {
      setVisible,
      refresh,
      setOpacity: (opacity) => state.layers.forEach((layer) => layer.setOpacity(opacity)),
      summary,
    };
  }

  window.WapkImdRadar = Object.freeze({ attach, stations: STATIONS.map(({ code, name, lat, lon }) => ({ code, name, lat, lon })) });
})();
'''
js = js.replace("__MASTER__", hexes(master)).replace("__JPR__", hexes(pal["jpr"]))
open(out_path, "w", encoding="utf-8").write(js)
print("written", len(js))
