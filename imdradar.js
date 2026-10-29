(() => {
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
  const RAIN_COLOURS = new Set("00007e 00007f 0000a0 0000c7 0019b0 0033fe 0034ff 003ac8 0047ff 0078fe 0079ff 0118e5 014bfc 0172fe 0205ca 0337f2 0377fc 0530f5 073bf7 0808c9 0b8aff 0d8bfe 19a2fe 1a007d 1aa2ff 1aa3ff 1c02b6 1c05bf 2daefb 39009f 3901a3 3a0079 3a00a0 52d0fe 53d0ff 53d1ff 64dcfc 86f0fe 86f0ff 87f1ff 88f0ff b3f1ff c15815 c70000 c7004e c80000 c80101 cb0000 d31617 dfa72e e61a08 e75818 e9df90 f00000 fcfc7a fe3e00 fe7200 fe7300 febc00 fed903 fee500 fef7c0 fefefe ff3f00 ff7300 ffbb00 ffbc00 ffbd00 ffe500 ffe600 fff5c2 fff6c1 fff7c1 fff8c1 ffffff".split(" ").map((hex) => parseInt(hex, 16)));
  const JAIPUR_COLOURS = new Set("0001c9 0005cd 0008d1 000cd4 000fd8 0013dc 0015de 0019e2 001fe9 0025f0 0029f3 002ef9 0033fd 003aff 003fff 0043ff 004aff 0051ff 0058ff 005dff 0061ff 0066ff 006aff 0071ff 0076ff 017bff 0200c6 027dff 047fff 0500c4 0682ff 0886ff 0900c2 0b8aff 0d8eff 0f92ff 1000bd 1397ff 1398ff 169cff 1800b8 189fff 1a00b6 1aa3ff 1ea7ff 1f00b2 2200b0 22aaff 26adff 2700ad 2cb1ff 2d00a9 31b6ff 3200a5 3500a4 37baff 3800a1 3a00a0 3cbeff 43c4ff 44c5ff 48c8ff 4ccbff 50ceff 55d2ff 58d4ff 5ad6ff 5ed8ff 63dbff 68deff 6de1ff 72e4ff 78e8ff 7beaff 80edff 85f0ff 8ff2ff 9bf4ff a1f4ff abf5ff b7f7ff c3f8ff c80008 c80015 c8001e c80026 c8002d c80038 c8003d c80042 c80047 c8004d c8004f cb0400 cef9ff d10a00 d3f9ff d40e00 d81200 dd1800 dffbff e52100 ebfdff ec2900 f23000 f7feff f93800 fc3c00 ff4000 ff4400 ff4700 ff4a00 ff5000 ff5800 ff5c00 ff6100 ff6a00 ff6d00 ff7200 ff7b00 ff8300 ff8800 ff8d00 ff9400 ff9e00 ffa700 ffaf00 ffb800 ffc000 ffc500 ffc900 ffce00 ffd100 ffd400 ffda00 ffdf00 ffe501 ffe814 ffea28 ffec3c ffee54 fff16f fff288 fff49b fff6a8 fff8bb fff8c5 fff9cb fffad2 fffad6 fffbda fffbe0 fffce6 fffdea fffdef fffef3 fffef7 fffffb".split(" ").map((hex) => parseInt(hex, 16)));
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
