(() => {
  "use strict";

  // Windy-style point forecast: a panel along the bottom of the map with the next 7 days in 3-hour columns
  // (weather icon, temperature, rain, wind) for the picker's place, plus the map's location search.
  // Forecast data comes from app.js (window.Atmos.fetchForecast: ECMWF IFS with WAPK's storm and hail rules).

  const STEP_HOURS = 3;
  const SEARCH_DELAY_MS = 300;

  const element = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const icon = (code, isDay, hail) => window.AtmosIcons?.weather(code, isDay, hail) || "";
  const uiIcon = (name) => window.AtmosIcons?.ui(name) || "";
  const finite = (value) => typeof value === "number" && Number.isFinite(value);

  // Which hour of a 3-hour block stands for it: storms first, then freezing rain, snow, rain, drizzle, fog,
  // then the cloudiest sky.
  function rank(code) {
    if (code >= 95) return 100 + code;
    if ([56, 57, 66, 67].includes(code)) return 90;
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 80 + (code % 10);
    if ((code >= 61 && code <= 65) || (code >= 80 && code <= 82)) return 70 + (code % 10);
    if (code >= 51 && code <= 55) return 60 + (code % 10);
    if (code >= 44 && code <= 48) return 50;
    return finite(code) ? code : -1;
  }

  function attach(stage, options = {}) {
    const panel = element("section", "map-detail");
    panel.hidden = true;
    panel.setAttribute("aria-label", "Forecast for the chosen place");
    const head = element("header", "detail-head");
    const titles = element("div", "detail-titles");
    const name = element("strong", "detail-name", "—");
    const meta = element("span", "detail-meta", "");
    titles.append(name, meta);
    const close = element("button", "map-chip map-chip-icon detail-close");
    close.type = "button";
    close.setAttribute("aria-label", "Close the forecast");
    close.innerHTML = uiIcon("close");
    head.append(titles, close);
    const body = element("div", "detail-scroll");
    const note = element("p", "detail-note", "ECMWF IFS · storm and hail rules from Weather Alert PK · tap a column to show it on the map");
    panel.append(head, body, note);
    stage.append(panel);

    const state = { request: 0, controller: null, columns: [], cells: [], point: null, mapTime: null };

    close.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !panel.hidden) setOpen(false);
    });
    document.addEventListener("atmos:unit", () => state.payload && renderTable(state.payload));

    function setOpen(open) {
      panel.hidden = !open;
      stage.classList.toggle("has-detail", open);
      if (!open) {
        state.controller?.abort();
        options.onClose?.();
      }
    }

    // Opens the panel for a point; `label` names it when known (a search result), otherwise it is looked up.
    async function open(lat, lon, label) {
      const request = ++state.request;
      state.controller?.abort();
      const controller = new AbortController();
      state.controller = controller;
      state.point = { lat, lon };
      setOpen(true);
      name.textContent = label || "Finding the place…";
      meta.textContent = coordinates(lat, lon);
      body.replaceChildren(element("p", "detail-status", "Loading the forecast…"));
      if (!label) {
        window.Atmos?.lookupPlace?.(lat, lon).then((place) => {
          if (request === state.request && place) name.textContent = [place.name, place.country].filter(Boolean).join(", ");
        }).catch(() => {
          if (request === state.request) name.textContent = "Chosen place";
        });
      }
      try {
        if (!window.Atmos?.fetchForecast) throw new Error("forecast unavailable");
        const payload = await window.Atmos.fetchForecast(lat, lon, controller);
        if (request !== state.request) return;
        state.payload = payload;
        if (finite(payload.elevation)) meta.textContent = `${coordinates(lat, lon)} · ${Math.round(payload.elevation)} m`;
        renderTable(payload);
      } catch (error) {
        if (request !== state.request || error?.name === "AbortError") return;
        body.replaceChildren(element("p", "detail-status", "The forecast for this place could not load. Check your connection and try again."));
      }
    }

    function coordinates(lat, lon) {
      return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`;
    }

    function temperature(celsius) {
      if (!finite(celsius)) return "—";
      return window.Atmos?.unit === "F" ? `${Math.round((celsius * 9) / 5 + 32)}°` : `${Math.round(celsius)}°`;
    }

    // Three-hour columns from the current block to the end of the forecast.
    function buildColumns(payload) {
      const hourly = payload.hourly;
      const offset = (payload.utc_offset_seconds || 0) * 1000;
      const hours = payload.wapk?.hours || [];
      const now = Date.now();
      const columns = [];
      for (let index = 0; index < hourly.time.length; index += 1) {
        const at = Date.parse(`${hourly.time[index]}Z`) - offset;
        const localHour = Number(hourly.time[index].slice(11, 13));
        if (localHour % STEP_HOURS || at + STEP_HOURS * 3_600_000 <= now) continue;
        const span = [index, index + 1, index + 2].filter((hour) => hour < hourly.time.length);
        const codes = span.map((hour) => hours[hour]?.code ?? hourly.weather_code?.[hour]);
        const pick = span[codes.reduce((best, code, position) => (rank(code) > rank(codes[best]) ? position : best), 0)];
        const rain = span.reduce((sum, hour) => sum + (hourly.precipitation?.[hour] || 0), 0);
        columns.push({
          at,
          date: hourly.time[index].slice(0, 10),
          hour: localHour,
          code: hours[pick]?.code ?? hourly.weather_code?.[pick],
          hail: span.some((hour) => hours[hour]?.hail),
          isDay: Boolean(hourly.is_day?.[index + 1] ?? hourly.is_day?.[index]),
          temp: hourly.temperature_2m?.[index],
          rain,
          wind: hourly.wind_speed_10m?.[index],
          gust: Math.max(...span.map((hour) => hourly.wind_gusts_10m?.[hour] || 0)),
          direction: hourly.wind_direction_10m?.[index],
        });
      }
      return columns;
    }

    function renderTable(payload) {
      const columns = buildColumns(payload);
      state.columns = columns;
      if (!columns.length) {
        body.replaceChildren(element("p", "detail-status", "No forecast is available for this place."));
        return;
      }
      const table = element("table", "detail-table");
      const rows = {
        day: element("tr", "detail-days"),
        hour: element("tr", "detail-hours"),
        icon: element("tr", "detail-icons"),
        temp: element("tr", "detail-temps"),
        rain: element("tr", "detail-rain"),
        wind: element("tr", "detail-wind"),
        gust: element("tr", "detail-gust"),
      };
      const labels = { day: "", hour: "Time", icon: "", temp: "Temp", rain: "Rain mm", wind: "Wind km/h", gust: "Gusts" };
      Object.entries(rows).forEach(([key, row]) => {
        const th = element("th", "detail-label", labels[key]);
        th.scope = "row";
        row.append(th);
      });
      const days = payload.daily?.time || [];
      const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric" });
      // Day headers span their columns and carry that day's icon and high/low.
      let start = 0;
      while (start < columns.length) {
        const date = columns[start].date;
        let end = start;
        while (end + 1 < columns.length && columns[end + 1].date === date) end += 1;
        const dayIndex = days.indexOf(date);
        const cell = element("th", "detail-day");
        cell.colSpan = end - start + 1;
        cell.scope = "colgroup";
        const label = element("span", "detail-day-name", dayFormat.format(new Date(`${date}T12:00:00`)));
        cell.append(label);
        if (dayIndex >= 0 && end > start) {
          const high = payload.daily.temperature_2m_max?.[dayIndex];
          const low = payload.daily.temperature_2m_min?.[dayIndex];
          cell.append(element("span", "detail-day-range", `${temperature(high)} / ${temperature(low)}`));
        }
        rows.day.append(cell);
        start = end + 1;
      }
      state.cells = columns.map((column, index) => {
        const cells = [];
        const add = (row, content, className = "") => {
          const cell = element("td", className);
          if (content instanceof Node) cell.append(content);
          else cell.textContent = content;
          cell.dataset.column = String(index);
          rows[row].append(cell);
          cells.push(cell);
          return cell;
        };
        add("hour", `${String(column.hour).padStart(2, "0")}`, "detail-hour");
        const art = element("span", "detail-icon");
        art.innerHTML = icon(column.code, column.isDay, column.hail);
        art.title = window.Atmos?.condition?.(column.code) || "";
        add("icon", art);
        const temp = add("temp", temperature(column.temp), "detail-temp");
        temp.style.setProperty("--heat", String(Math.max(0, Math.min(1, ((column.temp ?? 15) + 5) / 50))));
        const rain = add("rain", column.rain >= 0.1 ? (column.rain < 10 ? column.rain.toFixed(1) : String(Math.round(column.rain))) : "", "detail-rain-cell");
        if (column.rain >= 0.1) rain.style.setProperty("--rain", String(Math.min(1, Math.sqrt(column.rain / 15))));
        const wind = element("span", "detail-wind-value");
        if (finite(column.direction)) {
          // The arrow points where the wind blows to.
          const arrow = element("span", "detail-arrow", "↑");
          arrow.style.transform = `rotate(${(column.direction + 180) % 360}deg)`;
          wind.append(arrow);
        }
        wind.append(finite(column.wind) ? String(Math.round(column.wind)) : "—");
        add("wind", wind);
        add("gust", column.gust ? String(Math.round(column.gust)) : "—", "detail-gust-cell");
        return cells;
      });
      Object.values(rows).forEach((row) => table.append(row));
      table.addEventListener("click", (event) => {
        const cell = event.target.closest("[data-column]");
        if (!cell) return;
        const column = state.columns[Number(cell.dataset.column)];
        if (column) options.onTimeSelect?.(column.at + 1.5 * 3_600_000);
      });
      body.replaceChildren(table);
      highlight(true);
    }

    // Marks the column holding the map's time and keeps it in view.
    function setTime(ms) {
      state.mapTime = ms;
      highlight(false);
    }

    function highlight(scroll) {
      if (!state.columns.length || !state.mapTime) return;
      const index = state.columns.findIndex((column) => state.mapTime >= column.at && state.mapTime < column.at + STEP_HOURS * 3_600_000);
      state.cells.forEach((cells, column) => cells.forEach((cell) => cell.classList.toggle("is-current", column === index)));
      if (index >= 0 && (scroll || panel.contains(document.activeElement) === false)) {
        const cell = state.cells[index][0];
        const left = cell.offsetLeft - body.clientWidth / 2 + cell.offsetWidth / 2;
        if (left < body.scrollLeft || left > body.scrollLeft + body.clientWidth - cell.offsetWidth * 2 || scroll) body.scrollTo({ left: Math.max(0, left), behavior: scroll ? "auto" : "smooth" });
      }
    }

    return { open, close: () => setOpen(false), setTime, isOpen: () => !panel.hidden };
  }

  // Location search for the map's top bar (Open-Meteo geocoding, as on the weather page).
  function attachSearch(form, input, results, onChoose) {
    let timer = null;
    let controller = null;
    let found = [];
    let active = -1;

    const hide = () => {
      results.hidden = true;
      input.setAttribute("aria-expanded", "false");
      active = -1;
    };

    function render() {
      results.replaceChildren();
      found.forEach((place, index) => {
        const option = element("button", `map-search-option${index === active ? " is-active" : ""}`);
        option.type = "button";
        option.setAttribute("role", "option");
        option.append(element("strong", "", place.name), element("span", "", [place.admin1, place.country].filter(Boolean).join(", ")));
        option.addEventListener("click", () => choose(index));
        results.append(option);
      });
      if (!found.length) results.append(element("p", "map-search-empty", "No places found"));
      results.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    async function search(query, chooseFirst) {
      controller?.abort();
      controller = new AbortController();
      const current = controller;
      try {
        const parameters = new URLSearchParams({ name: query, count: "7", language: "en", format: "json" });
        const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${parameters}`, { signal: current.signal });
        const payload = await response.json();
        if (current !== controller || input.value.trim() !== query) return;
        found = (payload.results || []).filter((place) => finite(place.latitude) && finite(place.longitude));
        active = found.length ? 0 : -1;
        if (chooseFirst && found.length) choose(0);
        else render();
      } catch (error) {
        if (error?.name !== "AbortError") {
          found = [];
          render();
        }
      }
    }

    function choose(index) {
      const place = found[index];
      if (!place) return;
      hide();
      input.value = place.name;
      input.blur();
      onChoose(place.latitude, place.longitude, [place.name, place.country].filter(Boolean).join(", "));
    }

    input.addEventListener("input", () => {
      clearTimeout(timer);
      const query = input.value.trim();
      if (query.length < 2) {
        hide();
        return;
      }
      timer = setTimeout(() => search(query, false), SEARCH_DELAY_MS);
    });
    input.addEventListener("keydown", (event) => {
      if (results.hidden || !found.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        active = (active + (event.key === "ArrowDown" ? 1 : found.length - 1)) % found.length;
        render();
      } else if (event.key === "Escape") {
        hide();
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (!query) return;
      if (!results.hidden && active >= 0 && found[active]) choose(active);
      else search(query, true);
    });
    document.addEventListener("click", (event) => {
      if (!form.contains(event.target)) hide();
    });
  }

  window.WapkPointForecast = Object.freeze({ attach, attachSearch });
})();
