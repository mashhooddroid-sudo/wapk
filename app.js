(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const DASH = '\u2014';
  const STORAGE = 'atmos.preferences.v1';
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const text = (id, value) => { const node = byId(id); if (node) node.textContent = value; };
  const region = (city) => [...new Set([city.admin1, city.country].filter(Boolean))].join(', ');
  const cityKey = (city) => `${city.latitude.toFixed(3)},${city.longitude.toFixed(3)}`;
  const weatherNames = {
    0: 'Clear skies', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
    44: 'Mist', 45: 'Fog', 46: 'Dense fog', 47: 'Very dense fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
    56: 'Freezing drizzle', 57: 'Heavy freezing drizzle', 61: 'Light rain', 63: 'Rain',
    65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain', 71: 'Light snow',
    73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers',
    81: 'Rain showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers',
    // Storm tiers by rain amount (see weather-logic.js); hail is a separate flag. 97 is internal.
    95: 'Isolated thunderstorm', 96: 'Scattered thunderstorms', 97: 'Thunderstorms', 99: 'Heavy thunderstorms'
  };
  const condition = (code) => weatherNames[code] || 'Conditions unavailable';
  const icon = (code, isDay = true, hail = false) => window.AtmosIcons?.weather(code, isDay, hail) || '';
  const uiIcon = (name) => window.AtmosIcons?.ui(name) || '';
  const temperature = (value) => finite(value) ? `${Math.round(state.unit === 'F' ? value * 9 / 5 + 32 : value)}\u00b0` : DASH;
  const number = (value, suffix = '', digits = 0) => finite(value) ? `${value.toLocaleString('en', { maximumFractionDigits: digits })}${suffix}` : DASH;
  // API timestamps have already been shifted to the selected city's timezone.
  // Parse as UTC solely to format these wall-clock values without the viewer's timezone.
  function localDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
    const date = new Date(`${value.length === 10 ? `${value}T12:00` : value}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  function dateFormat(value, options) {
    const date = localDate(value);
    return date ? new Intl.DateTimeFormat('en', { timeZone: 'UTC', ...options }).format(date) : DASH;
  }
  const hourLabel = (value) => dateFormat(value, { hour: 'numeric', hour12: true });
  const timeLabel = (value) => dateFormat(value, { hour: 'numeric', minute: '2-digit', hour12: true });
  const dayLabel = (value, index) => index === 0 ? 'Today' : dateFormat(value, { weekday: 'short' });
  function normalizeCity(city) {
    if (!city || typeof city.name !== 'string' || !city.name.trim() || !finite(city.latitude) || !finite(city.longitude)) return null;
    if (Math.abs(city.latitude) > 90 || Math.abs(city.longitude) > 180) return null;
    return { name: city.name.slice(0, 120), latitude: city.latitude, longitude: city.longitude,
      admin1: typeof city.admin1 === 'string' ? city.admin1.slice(0, 120) : '',
      country: typeof city.country === 'string' ? city.country.slice(0, 120) : '' };
  }
  function readPreferences() {
    try { return JSON.parse(localStorage.getItem(STORAGE) || '{}') || {}; } catch { return {}; }
  }
  const preferences = readPreferences();
  const defaultCity = { name: 'Islamabad', latitude: 33.6938, longitude: 73.0652, admin1: 'Islamabad Capital Territory', country: 'Pakistan' };
  const state = {
    place: normalizeCity(preferences.place) || defaultCity,
    saved: Array.isArray(preferences.saved) ? preferences.saved.map(normalizeCity).filter(Boolean).slice(0, 20) : [],
    unit: preferences.unit === 'F' ? 'F' : 'C', theme: preferences.theme === 'light' ? 'light' : 'dark',
    weather: null, air: null, fetchedAt: null, selectedDay: 0, metric: 'temperature',
    searchResults: [], activeResult: -1, searchId: 0, searchController: null, searchTimer: null,
    forecastId: 0, forecastController: null, airController: null, loading: false, locating: false,
    metar: null, metarStatus: 'loading', metarController: null, pakistanMetar: null
  };
  function savePreferences() {
    try { localStorage.setItem(STORAGE, JSON.stringify({ place: state.place, saved: state.saved, unit: state.unit, theme: state.theme })); } catch { /* Weather remains usable when browser storage is disabled. */ }
  }
  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function showToast(message) {
    text('toast', message);
    byId('toast')?.classList.add('show');
    clearTimeout(showToast.timer);
    // Give longer messages enough time to be read.
    showToast.timer = setTimeout(() => byId('toast')?.classList.remove('show'), Math.max(4200, message.length * 60));
  }
  async function requestJSON(url, controller, milliseconds = 15000) {
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, milliseconds);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Request returned ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error('The weather service could not process this request.');
      return payload;
    } catch (error) {
      if (timedOut) { const timeoutError = new Error('The connection timed out.'); timeoutError.name = 'TimeoutError'; throw timeoutError; }
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function closeSearch(cancel = true) {
    if (cancel) {
      clearTimeout(state.searchTimer);
      state.searchId += 1;
      state.searchController?.abort();
    }
    byId('results').hidden = true;
    byId('cityInput').setAttribute('aria-expanded', 'false');
    byId('cityInput').removeAttribute('aria-activedescendant');
    byId('cityInput').setAttribute('aria-busy', 'false');
    text('searchMessage', '');
    state.activeResult = -1;
  }
  function setActiveResult(index) {
    if (!state.searchResults.length) return;
    state.activeResult = (index + state.searchResults.length) % state.searchResults.length;
    const options = byId('results').querySelectorAll('[data-city-index]');
    options.forEach((option, optionIndex) => {
      const active = optionIndex === state.activeResult;
      option.classList.toggle('is-active', active);
      option.setAttribute('aria-selected', String(active));
      if (active) { byId('cityInput').setAttribute('aria-activedescendant', option.id); option.scrollIntoView({ block: 'nearest' }); }
    });
  }
  function renderSearchResults() {
    const fragment = document.createDocumentFragment();
    state.searchResults.forEach((city, index) => {
      const button = element('button', 'search-result');
      button.type = 'button'; button.id = `city-option-${index}`; button.dataset.cityIndex = index;
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', 'false'); button.tabIndex = -1;
      const marker = element('span', 'result-icon'); marker.innerHTML = uiIcon('pin'); marker.setAttribute('aria-hidden', 'true');
      const copy = element('span', 'result-copy');
      copy.append(element('span', 'result-name', city.name), element('span', 'result-region', region(city) || `${city.latitude.toFixed(2)}, ${city.longitude.toFixed(2)}`));
      const arrow = element('span', 'result-arrow', '\u2197'); arrow.setAttribute('aria-hidden', 'true');
      button.append(marker, copy, arrow); fragment.append(button);
    });
    byId('results').replaceChildren(fragment);
    byId('results').hidden = !state.searchResults.length;
    byId('cityInput').setAttribute('aria-expanded', String(Boolean(state.searchResults.length)));
    text('searchMessage', state.searchResults.length ? `${state.searchResults.length} places found. Choose a city.` : 'No cities found. Try a nearby city or a different spelling.');
  }
  async function searchCities(query, selectFirst = false) {
    state.searchController?.abort();
    const requestId = ++state.searchId;
    const controller = new AbortController(); state.searchController = controller;
    state.searchResults = []; state.activeResult = -1;
    byId('results').hidden = true;
    byId('cityInput').setAttribute('aria-expanded', 'false');
    byId('cityInput').setAttribute('aria-busy', 'true');
    text('searchMessage', 'Searching cities\u2026');
    try {
      const parameters = new URLSearchParams({ name: query, count: '8', language: 'en', format: 'json' });
      const payload = await requestJSON(`https://geocoding-api.open-meteo.com/v1/search?${parameters}`, controller, 12000);
      if (requestId !== state.searchId || byId('cityInput').value.trim() !== query) return;
      const seen = new Set();
      state.searchResults = (payload.results || []).map(normalizeCity).filter((city) => {
        if (!city || seen.has(cityKey(city))) return false;
        seen.add(cityKey(city)); return true;
      });
      renderSearchResults();
      if (selectFirst && state.searchResults.length) selectCity(0);
    } catch (error) {
      if (requestId !== state.searchId) return;
      text('searchMessage', error.name === 'TimeoutError' ? 'Search took too long. Press Enter to try again.' : 'City search is unavailable. Check your connection, then press Enter to retry.');
    } finally {
      if (requestId === state.searchId) byId('cityInput').setAttribute('aria-busy', 'false');
    }
  }
  function selectCity(index) {
    const selected = state.searchResults[index];
    if (!selected) return;
    closeSearch();
    byId('cityInput').value = '';
    byId('cityInput').focus({ preventScroll: true });
    loadWeather(selected);
  }

  function renderSaved() {
    byId('savedCities').replaceChildren(...state.saved.map((city) => {
      const selected = cityKey(city) === cityKey(state.place);
      const button = element('button', `saved-city${selected ? ' is-active' : ''}`);
      button.type = 'button'; button.dataset.savedKey = cityKey(city); button.setAttribute('aria-pressed', String(selected));
      const marker = element('span', 'saved-city-icon'); marker.innerHTML = uiIcon('pin'); marker.setAttribute('aria-hidden', 'true');
      const copy = element('span', 'saved-city-copy');
      copy.append(element('span', 'saved-city-name', city.name), element('span', 'saved-city-region', city.country || city.admin1 || 'Saved location'));
      button.append(marker, copy); return button;
    }));
    byId('emptySaved').hidden = Boolean(state.saved.length);
    const isSaved = state.saved.some((city) => cityKey(city) === cityKey(state.place));
    byId('saveButton').setAttribute('aria-pressed', String(isSaved));
    byId('saveButton').classList.toggle('is-active', isSaved);
    byId('saveButton').title = isSaved ? `Remove ${state.place.name} from saved places` : `Save ${state.place.name}`;
    text('saveLabel', isSaved ? 'Saved' : 'Save city');
  }
  function applySettings() {
    document.documentElement.dataset.theme = state.theme;
    byId('themeButton').setAttribute('aria-label', `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme`);
    byId('themeButton').title = `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} theme`;
    const themeIcon = byId('themeIcon');
    if (themeIcon) themeIcon.innerHTML = uiIcon(state.theme === 'dark' ? 'sun' : 'moon');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', state.theme === 'dark' ? '#050d20' : '#e6f1ff');
    document.dispatchEvent(new CustomEvent('atmos:theme', { detail: state.theme }));
    byId('unitControls').querySelectorAll('[data-unit]').forEach((button) => {
      const active = button.dataset.unit === state.unit;
      button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active));
    });
  }
  function setLoading(loading) {
    state.loading = loading;
    byId('weatherContent').setAttribute('aria-busy', String(loading));
    byId('weatherContent').classList.toggle('is-loading', loading);
    byId('refreshButton').disabled = loading;
    byId('refreshButton').classList.toggle('is-loading', loading);
    byId('retryButton').disabled = loading;
  }
  function setBanner(message) { text('statusText', message); byId('statusBanner').hidden = !message; }
  function clearForecast() {
    state.weather = null; state.air = null; state.selectedDay = 0;
    ['temperature', 'feelsLike', 'windValue', 'humidityValue', 'uvValue', 'visibilityValue', 'sunriseValue', 'sunsetValue', 'airValue', 'pressureValue', 'rainValue'].forEach((id) => text(id, DASH));
    ['windDescription', 'humidityDescription', 'uvDescription', 'visibilityDescription', 'daylightValue'].forEach((id) => text(id, 'Waiting for forecast'));
    text('highLow', `High ${DASH} / Low ${DASH}`);
    text('airDescription', 'Waiting for air quality');
    ['humidityMeter', 'uvMeter', 'airMeter'].forEach((id) => { byId(id).style.width = '0%'; });
    byId('compassNeedle').style.transform = 'rotate(0deg)';
    byId('sunProgress').style.opacity = '0';
    byId('heroArt').replaceChildren();
    byId('hourly').replaceChildren(element('p', 'empty-forecast', 'Loading hourly forecast\u2026'));
    byId('week').replaceChildren(element('p', 'empty-forecast', 'Loading the week ahead\u2026'));
    byId('dayDetails').replaceChildren(element('p', 'empty-forecast', 'Day details will appear here.'));
    byId('chart').replaceChildren();
    byId('chart').setAttribute('aria-label', 'Hourly forecast loading');
    text('chartCaption', 'Your day, hour by hour');
    state.metar = null; state.metarStatus = 'loading'; renderMetar();
    text('currentSource', ''); byId('currentSource').classList.remove('is-live');
  }
  async function loadWeather(city = state.place) {
    const selected = normalizeCity(city);
    if (!selected) return;
    state.forecastController?.abort(); state.airController?.abort();
    const requestId = ++state.forecastId;
    const controller = new AbortController(); state.forecastController = controller;
    state.place = selected;
    document.dispatchEvent(new CustomEvent('atmos:place', { detail: { ...selected } }));
    clearForecast(); setLoading(true); setBanner(''); renderSaved();
    text('placeName', selected.name); text('placeRegion', region(selected) || 'Your coordinates');
    text('dateLine', 'Finding your forecast\u2026'); text('timezoneLabel', 'Local time');
    text('condition', 'Loading your forecast\u2026'); text('heroInsight', `Getting the latest outlook for ${selected.name}.`);
    text('lastUpdated', 'Connecting to forecast data');
    loadMetar(selected, requestId);
    try {
      const payload = await fetchForecast(selected.latitude, selected.longitude, controller);
      if (requestId !== state.forecastId) return;
      state.weather = payload; state.fetchedAt = new Date();
      savePreferences(); renderWeather();
      document.dispatchEvent(new CustomEvent('atmos:weather'));
      loadAirQuality(selected, requestId);
    } catch (error) {
      if (requestId !== state.forecastId) return;
      text('condition', 'Forecast unavailable'); text('dateLine', 'Waiting for a connection');
      text('heroInsight', `We could not load the forecast for ${selected.name}. You can retry or search for another city.`);
      text('lastUpdated', 'Forecast not connected'); text('airDescription', 'Unavailable');
      ['windDescription', 'humidityDescription', 'uvDescription', 'visibilityDescription', 'daylightValue'].forEach((id) => text(id, 'Unavailable'));
      byId('hourly').replaceChildren(element('p', 'empty-forecast', 'Hourly forecast unavailable.'));
      byId('week').replaceChildren(element('p', 'empty-forecast', 'Seven-day forecast unavailable.'));
      byId('chart').setAttribute('aria-label', 'Hourly forecast unavailable');
      setBanner(error.name === 'TimeoutError' ? `The forecast for ${selected.name} took too long to load. Please try again.` : `Could not load weather for ${selected.name}. Check your internet connection and try again.`);
    } finally { if (requestId === state.forecastId) setLoading(false); }
  }

  // The forecast for any point: ECMWF IFS (as in the Weather & Prayer Alert PK app, whose storm and hail rules
  // are fitted to it), plus the fields ECMWF does not provide from Open-Meteo's default model: rain probability,
  // visibility, UV and the freezing level, 500 hPa temperature and wind and lifted index the storm and hail rules
  // need. The result carries `wapk`, the classified weather (storm tiers, hail, fog). Used by the dashboard and
  // the map's point forecast.
  async function fetchForecast(latitude, longitude, controller) {
    const place = { latitude: String(latitude), longitude: String(longitude), timezone: 'auto', forecast_days: '7' };
    const parameters = new URLSearchParams({
      ...place, models: 'ecmwf_ifs',
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure',
      hourly: 'temperature_2m,precipitation,weather_code,cloud_cover,cape,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day',
      daily: 'temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset,precipitation_sum,wind_speed_10m_max'
    });
    const auxParameters = new URLSearchParams({
      ...place,
      hourly: 'precipitation_probability,visibility,uv_index,freezing_level_height,temperature_500hPa,lifted_index,wind_speed_500hPa',
      daily: 'uv_index_max,precipitation_probability_max'
    });
    const [payload, aux] = await Promise.all([
      requestJSON(`https://api.open-meteo.com/v1/forecast?${parameters}`, controller),
      // The forecast still shows without these; storms then rely on rain amount alone.
      requestJSON(`https://api.open-meteo.com/v1/forecast?${auxParameters}`, controller).catch(() => null)
    ]);
    if (!payload.current || !Array.isArray(payload.hourly?.time) || !payload.hourly.time.length || !Array.isArray(payload.daily?.time) || !payload.daily.time.length) throw new Error('The forecast response was incomplete.');
    mergeByTime(payload.hourly, aux?.hourly); mergeByTime(payload.daily, aux?.daily);
    const next = payload.hourly.time.findIndex((time) => time > payload.current.time);
    const nowIndex = next === -1 ? payload.hourly.time.length - 1 : Math.max(0, next - 1);
    payload.wapk = window.WapkWeatherLogic?.classifyForecast(payload, nowIndex) || null;
    return payload;
  }

  // Copies another response's series onto `target`, matched by time (both use the same timezone).
  function mergeByTime(target, extra) {
    if (!target || !Array.isArray(extra?.time)) return;
    const position = new Map(extra.time.map((time, index) => [time, index]));
    Object.entries(extra).forEach(([field, values]) => {
      if (field === 'time' || !Array.isArray(values)) return;
      target[field] = target.time.map((time) => (position.has(time) ? values[position.get(time)] : null));
    });
  }
  // Classified weather code (storm tiers, hail, fog) for an hour or day, falling back to the model's own.
  function hourCode(index) { return state.weather.wapk?.hours[index]?.code ?? state.weather.hourly.weather_code?.[index]; }
  function dayInfo(index) { return state.weather.wapk?.days[index] || null; }
  function dayCode(index) { return dayInfo(index)?.code ?? state.weather.daily.weather_code?.[index]; }
  const INTENSITY = { light: 'Light', moderate: 'Moderate', strong: 'Strong', severe: 'Severe' };
  function stormBadges(info) {
    const badges = [];
    if (info?.intensity) badges.push(element('span', `storm-chip storm-chip--${info.intensity}`, INTENSITY[info.intensity]));
    if (info?.hail) badges.push(element('span', 'storm-chip storm-chip--hail', 'Hail'));
    return badges;
  }
  function currentHourIndex() {
    const times = state.weather.hourly.time;
    const currentTime = state.weather.current.time;
    const index = times.findIndex((time) => time > currentTime);
    return index === -1 ? times.length - 1 : Math.max(0, index - 1);
  }
  function hourlyValue(field, index = currentHourIndex()) { return state.weather.hourly[field]?.[index]; }
  function dailyValue(field, index = 0) { return state.weather.daily[field]?.[index]; }
  function weatherGroup(code) {
    if (code >= 95) return 'storm';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
    if (code >= 51) return 'rain';
    if ([45, 48].includes(code)) return 'fog';
    return code <= 1 ? 'clear' : 'cloud';
  }
  function makeInsight(conditions) {
    const start = currentHourIndex();
    const probabilities = (state.weather.hourly.precipitation_probability || []).slice(start, start + 6).filter(finite);
    const chance = probabilities.length ? Math.max(...probabilities) : null;
    const high = dailyValue('temperature_2m_max');
    const low = dailyValue('temperature_2m_min');
    const summary = conditions.condition === 'Clear night' ? 'Clear skies' : conditions.condition;
    if (conditions.hail) return 'Thunderstorms with possible hail around. Keep an eye on local weather advisories.';
    if (conditions.weatherCode >= 95) return 'Thunderstorms around. Keep an eye on local weather advisories.';
    if (dayInfo(0)?.hail) return `${summary} now, but thunderstorms with possible hail are expected later today.`;
    if (finite(chance) && chance >= 50) return `Rain may be part of your plans: up to ${Math.round(chance)}% chance in the next 6 hours.`;
    if (finite(high) && finite(low)) return `${summary} ${conditions.isDay ? 'today' : 'tonight'}, with a high of ${temperature(high)} and a low of ${temperature(low)}. ${chance === 0 ? 'No rain forecast in the next 6 hours.' : 'Your next 24 hours are just below.'}`;
    return `${summary}. Explore the hourly outlook for the day ahead.`;
  }
  function renderWeather() {
    if (!state.weather) return;
    const { current, timezone_abbreviation: abbreviation } = state.weather;
    const conditions = currentConditions();
    const live = conditions.source;
    text('temperature', temperature(conditions.temperature));
    text('condition', conditions.condition);
    text('feelsLike', temperature(conditions.apparent));
    text('currentSource', live
      ? `Live airport observation · ${live.metar.airport_name || live.metar.icao} (${live.metar.icao}), ${Math.round(live.distance)} km away · ${metarAge(live.observed)}`
      : 'Forecast model estimate');
    byId('currentSource').classList.toggle('is-live', Boolean(live));
    text('highLow', `H: ${temperature(dailyValue('temperature_2m_max'))}  L: ${temperature(dailyValue('temperature_2m_min'))}`);
    text('dateLine', dateFormat(current.time, { weekday: 'long', month: 'short', day: 'numeric' }));
    text('timezoneLabel', `${timeLabel(current.time)}${abbreviation ? ` ${abbreviation}` : ''}`);
    text('heroInsight', makeInsight(conditions));
    let updatedTime;
    try { updatedTime = new Intl.DateTimeFormat('en', { timeZone: state.weather.timezone || 'UTC', hour: 'numeric', minute: '2-digit' }).format(state.fetchedAt); }
    catch { updatedTime = timeLabel(current.time); }
    text('lastUpdated', `Updated ${updatedTime}${abbreviation ? ` ${abbreviation}` : ''}`);
    text('rainValue', number(hourlyValue('precipitation_probability'), '%'));
    text('pressureValue', number(conditions.pressure, ' hPa'));
    if (finite(conditions.weatherCode)) byId('heroArt').innerHTML = icon(conditions.weatherCode, conditions.isDay, conditions.hail);
    document.body.dataset.weather = weatherGroup(conditions.weatherCode);
    document.body.dataset.daylight = conditions.isDay ? 'day' : 'night';
    byId('heroArt').dataset.weather = weatherGroup(conditions.weatherCode);
    renderHourly(); renderChart(); renderWeek(); renderHighlights(conditions);
  }
  function renderHourly() {
    const start = currentHourIndex();
    const hours = state.weather.hourly;
    const fragment = document.createDocumentFragment();
    hours.time.slice(start, start + 24).forEach((time, offset) => {
      const index = start + offset;
      const row = element('div', `hour-item${offset === 0 ? ' is-current' : ''}`);
      const art = element('span', 'hour-icon');
      const code = hourCode(index);
      const info = state.weather.wapk?.hours[index];
      if (finite(code)) art.innerHTML = icon(code, Boolean(hours.is_day?.[index]), Boolean(info?.hail));
      art.setAttribute('aria-hidden', 'true');
      if (info?.hail) art.append(element('span', 'hail-dot', 'Hail'));
      row.append(element('span', 'hour-label', offset === 0 ? 'Now' : hourLabel(time)), art,
        element('strong', 'hour-temp', temperature(hours.temperature_2m?.[index])),
        element('span', 'hour-rain', number(hours.precipitation_probability?.[index], '%')));
      row.title = `${timeLabel(time)}: ${condition(code)}${info?.hail ? ', hail possible' : ''}, ${temperature(hours.temperature_2m?.[index])}, ${number(hours.precipitation_probability?.[index], '%')} chance of rain`;
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', row.title);
      fragment.append(row);
    });
    byId('hourly').replaceChildren(fragment);
  }
  function svgElement(tag, attributes, content) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function renderChart() {
    const chart = byId('chart'); chart.replaceChildren();
    byId('chartTabs').querySelectorAll('[data-metric]').forEach((button) => {
      const active = button.dataset.metric === state.metric;
      button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active));
    });
    if (!state.weather) return;
    const start = currentHourIndex();
    const rain = state.metric === 'rain';
    const values = (state.weather.hourly[rain ? 'precipitation_probability' : 'temperature_2m'] || []).slice(start, start + 24);
    const valid = values.filter(finite);
    if (!valid.length) { text('chartCaption', 'Chart data unavailable'); chart.setAttribute('aria-label', 'Hourly forecast unavailable'); return; }
    const minimum = rain ? 0 : Math.floor(Math.min(...valid)) - 2;
    const maximum = rain ? 100 : Math.ceil(Math.max(...valid)) + 2;
    const x = (index) => 35 + index / Math.max(1, values.length - 1) * 700;
    const y = (value) => 98 - (value - minimum) / (maximum - minimum) * 76;
    const accessibleLabel = rain ? `Rain probability over the next ${values.length} hours, up to ${Math.round(Math.max(...valid))} percent` : `Temperature over the next ${values.length} hours, ${temperature(Math.min(...valid))} to ${temperature(Math.max(...valid))}`;
    chart.setAttribute('aria-label', accessibleLabel);
    chart.append(svgElement('title', {}, accessibleLabel));
    [0, 0.5, 1].forEach((fraction) => {
      const position = 22 + fraction * 76;
      chart.append(svgElement('line', { x1: 35, x2: 735, y1: position, y2: position, class: 'chart-grid' }));
    });
    if (rain) {
      values.forEach((value, index) => {
        if (!finite(value)) return;
        const bar = svgElement('rect', { x: x(index) - 8, y: y(value), width: 16, height: Math.max(0, 98 - y(value)), rx: 4, class: 'chart-bar' });
        bar.append(svgElement('title', {}, `${hourLabel(state.weather.hourly.time[start + index])}: ${Math.round(value)}%`));
        chart.append(bar);
      });
    } else {
      const points = values.map((value, index) => finite(value) ? { x: x(index), y: y(value), index, value } : null).filter(Boolean);
      const path = points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
      const defs = svgElement('defs', {});
      const gradient = svgElement('linearGradient', { id: 'forecastFill', x1: 0, x2: 0, y1: 0, y2: 1 });
      gradient.append(svgElement('stop', { offset: '0%', 'stop-color': '#47b7ff', 'stop-opacity': '.24' }), svgElement('stop', { offset: '100%', 'stop-color': '#47b7ff', 'stop-opacity': '0' }));
      defs.append(gradient); chart.append(defs);
      chart.append(svgElement('path', { d: `${path} L${points[points.length - 1].x},100 L${points[0].x},100 Z`, class: 'chart-area', fill: 'url(#forecastFill)' }));
      chart.append(svgElement('path', { d: path, class: 'chart-line', fill: 'none' }));
      points.filter((point) => point.index % 4 === 0 || point.index === values.length - 1).forEach((point) => {
        const circle = svgElement('circle', { cx: point.x, cy: point.y, r: 3.5, class: 'chart-point' });
        circle.append(svgElement('title', {}, `${hourLabel(state.weather.hourly.time[start + point.index])}: ${temperature(point.value)}`)); chart.append(circle);
        chart.append(svgElement('text', { x: point.x, y: point.y - 11, 'text-anchor': 'middle', class: 'chart-label' }, temperature(point.value)));
      });
    }
    [0, 6, 12, 18, 23].filter((index) => index < values.length).forEach((index) => {
      chart.append(svgElement('text', { x: x(index), y: 123, 'text-anchor': 'middle', class: 'chart-label' }, index === 0 ? 'Now' : hourLabel(state.weather.hourly.time[start + index])));
    });
    text('chartCaption', rain ? `Up to ${Math.round(Math.max(...valid))}% chance of rain in the next 24 hours` : `${temperature(Math.min(...valid))} to ${temperature(Math.max(...valid))} over the next 24 hours`);
  }
  function renderWeek() {
    const daily = state.weather.daily;
    const allTemperatures = [...(daily.temperature_2m_min || []), ...(daily.temperature_2m_max || [])].filter(finite);
    const minimum = allTemperatures.length ? Math.min(...allTemperatures) : 0;
    const spread = allTemperatures.length ? Math.max(1, Math.max(...allTemperatures) - minimum) : 1;
    const fragment = document.createDocumentFragment();
    daily.time.slice(0, 7).forEach((time, index) => {
      const low = daily.temperature_2m_min?.[index], high = daily.temperature_2m_max?.[index];
      const row = element('button', `day-row${index === state.selectedDay ? ' is-selected' : ''}`);
      row.type = 'button'; row.dataset.day = index;
      row.setAttribute('aria-pressed', String(index === state.selectedDay)); row.setAttribute('aria-controls', 'dayDetails');
      const art = element('span', 'day-icon');
      const code = dayCode(index);
      if (finite(code)) art.innerHTML = icon(code, true, Boolean(dayInfo(index)?.hail));
      art.setAttribute('aria-hidden', 'true');
      if (dayInfo(index)?.hail) art.append(element('span', 'hail-dot', 'Hail'));
      const range = element('span', 'day-range'); range.setAttribute('aria-hidden', 'true');
      const fill = element('span', 'day-range-fill');
      if (finite(low) && finite(high)) { fill.style.left = `${clamp((low - minimum) / spread * 100, 0, 96)}%`; fill.style.width = `${Math.max(4, (high - low) / spread * 100)}%`; }
      else fill.style.width = '0%';
      range.append(fill);
      row.append(element('span', 'day-name', dayLabel(time, index)), art,
        element('span', 'day-rain', number(daily.precipitation_probability_max?.[index], '%')),
        element('span', 'day-low', temperature(low)), range, element('strong', 'day-high', temperature(high)));
      row.setAttribute('aria-label', `${dateFormat(time, { weekday: 'long' })}: ${condition(code)}${dayInfo(index)?.hail ? ', hail possible' : ''}, low ${temperature(low)}, high ${temperature(high)}. View details.`);
      fragment.append(row);
    });
    byId('week').replaceChildren(fragment);
    renderDayDetails();
  }
  function renderDayDetails() {
    if (!state.weather) return;
    const index = state.selectedDay;
    const info = dayInfo(index);
    const title = element('p', 'day-detail-title', `${dayLabel(state.weather.daily.time[index], index)} \u00b7 ${condition(dayCode(index))}`);
    title.append(...stormBadges(info));
    const grid = element('div', 'day-detail-grid');
    const entries = [
      ['Rainfall', number(dailyValue('precipitation_sum', index), ' mm', 1)],
      ['Wind max', number(dailyValue('wind_speed_10m_max', index), ' km/h')],
      ['UV max', number(dailyValue('uv_index_max', index), '', 1)],
      ['Sunset', timeLabel(dailyValue('sunset', index))]
    ];
    if (info?.dayCode !== null && info?.dayCode !== undefined) entries.push(['Day', condition(info.dayCode)]);
    if (info?.nightCode !== null && info?.nightCode !== undefined) entries.push(['Night', condition(info.nightCode)]);
    if (info?.intensity) entries.push(['Storm energy', `${INTENSITY[info.intensity]} \u00b7 CAPE ${number(Math.round(info.maxCape))}`]);
    if (info?.hail) entries.push(['Hail', 'Possible in storms']);
    entries.forEach(([label, value]) => { const stat = element('div', 'day-detail-stat'); stat.append(element('span', '', label), element('strong', '', value)); grid.append(stat); });
    byId('dayDetails').replaceChildren(title, grid);
  }
  function renderHighlights(current) {
    const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const direction = current.windVariable ? 'Variable' : finite(current.windDirection) ? compass[Math.round(current.windDirection / 45) % 8] : DASH;
    const gusts = finite(current.windGusts) ? `Gusts ${number(current.windGusts, ' km/h')}` : current.source ? 'No gusts reported' : `Gusts ${DASH}`;
    text('windValue', number(current.windSpeed, ' km/h'));
    text('windDescription', current.windSpeed === 0 ? 'Calm' : `${direction} \u00b7 ${gusts}`);
    byId('compassNeedle').style.transform = `rotate(${finite(current.windDirection) ? current.windDirection : 0}deg)`;
    const humidity = current.humidity;
    text('humidityValue', number(humidity, '%'));
    text('humidityDescription', `Dew point ${temperature(current.dewPoint)}`);
    byId('humidityMeter').style.width = `${finite(humidity) ? clamp(humidity, 0, 100) : 0}%`;
    const uv = hourlyValue('uv_index');
    const uvLevel = !finite(uv) ? 'Unavailable' : uv < 3 ? 'Low' : uv < 6 ? 'Moderate' : uv < 8 ? 'High' : uv < 11 ? 'Very high' : 'Extreme';
    text('uvValue', number(uv, '', 1)); text('uvDescription', `${uvLevel} \u00b7 Daily peak ${number(dailyValue('uv_index_max'), '', 1)}`);
    byId('uvMeter').style.width = `${finite(uv) ? clamp(uv / 12 * 100, 0, 100) : 0}%`;
    const visibility = current.visibility;
    text('visibilityValue', !finite(visibility) ? DASH : current.visibilityAtLeast ? '10+ km' : number(visibility / 1000, ' km', 1));
    text('visibilityDescription', !finite(visibility) ? 'Unavailable' : visibility >= 10000 ? 'Clear visibility across the horizon' : visibility >= 4000 ? 'Some haze on the horizon' : 'Reduced visibility');
    const sunrise = dailyValue('sunrise'), sunset = dailyValue('sunset');
    text('sunriseValue', timeLabel(sunrise)); text('sunsetValue', timeLabel(sunset));
    const start = localDate(sunrise), end = localDate(sunset), now = localDate(state.weather.current.time);
    if (start && end && now && end > start) {
      const minutes = Math.round((end - start) / 60000);
      text('daylightValue', `${Math.floor(minutes / 60)}h ${minutes % 60}m of daylight`);
      const progress = clamp((now - start) / (end - start), 0, 1);
      byId('sunProgress').setAttribute('cx', 20 + 200 * progress);
      byId('sunProgress').setAttribute('cy', 66 - 228 * progress * (1 - progress));
      byId('sunProgress').style.opacity = '1';
    } else { text('daylightValue', 'Daylight times unavailable'); byId('sunProgress').style.opacity = '0'; }
  }
  async function loadAirQuality(city, requestId) {
    const controller = new AbortController(); state.airController = controller;
    text('airDescription', 'Loading air quality\u2026');
    try {
      const params = new URLSearchParams({ latitude: city.latitude, longitude: city.longitude, timezone: 'auto', current: 'us_aqi,pm2_5', forecast_days: '1' });
      const payload = await requestJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`, controller, 12000);
      if (requestId !== state.forecastId) return;
      if (!finite(payload.current?.us_aqi)) throw new Error('Air quality unavailable');
      state.air = payload.current;
      const aqi = payload.current.us_aqi;
      const level = aqi <= 50 ? 'Good' : aqi <= 100 ? 'Moderate' : aqi <= 150 ? 'Unhealthy for sensitive groups' : aqi <= 200 ? 'Unhealthy' : aqi <= 300 ? 'Very unhealthy' : 'Hazardous';
      text('airValue', number(aqi)); text('airDescription', `${level} \u00b7 US AQI`);
      byId('airMeter').style.width = `${clamp(aqi / 300 * 100, 0, 100)}%`;
      byId('airMeter').style.background = aqi <= 50 ? '#55a782' : aqi <= 100 ? '#d7b34e' : aqi <= 150 ? '#db9952' : '#d16d81';
    } catch {
      if (requestId !== state.forecastId) return;
      text('airValue', DASH); text('airDescription', 'Air quality is temporarily unavailable'); byId('airMeter').style.width = '0%';
    }
  }

  // Airport METAR from the Travel Weather API. Its worldwide lookup excludes Pakistani airports and its
  // Pakistan lookup only answers within 30-40 km, so both cached lists are searched and the nearest station wins.
  const METAR_API = 'https://travel-weather-api.mashhood2717.workers.dev';
  const METAR_MAX_KM = 185; // The API's 100 nm worldwide search radius.
  const METAR_DEFAULT_RADIUS_KM = 30; // Pakistani reports carry their own radius; international ones do not.
  const METAR_STALE_MINUTES = 90;
  const SKY_COVER = { FEW: 'Few', SCT: 'Scattered', BKN: 'Broken', OVC: 'Overcast', VV: 'Sky obscured' };
  const WEATHER_PHENOMENA = {
    DZ: 'drizzle', RA: 'rain', SN: 'snow', SG: 'snow grains', IC: 'ice crystals', PL: 'ice pellets', GR: 'hail', GS: 'small hail',
    UP: 'precipitation', BR: 'mist', FG: 'fog', FU: 'smoke', VA: 'volcanic ash', DU: 'dust', SA: 'sand', HZ: 'haze', PY: 'spray',
    PO: 'dust whirls', SQ: 'squalls', FC: 'funnel cloud', SS: 'sandstorm', DS: 'duststorm'
  };
  const WEATHER_DESCRIPTORS = { MI: 'shallow', BC: 'patches of', PR: 'partial', DR: 'drifting', BL: 'blowing', FZ: 'freezing' };
  const FLIGHT_CATEGORIES = {
    VFR: 'Visual flight rules: ceiling above 3,000 ft and visibility over 5 miles',
    MVFR: 'Marginal VFR: ceiling 1,000–3,000 ft or visibility 3–5 miles',
    IFR: 'Instrument flight rules: ceiling 500–999 ft or visibility 1–3 miles',
    LIFR: 'Low IFR: ceiling below 500 ft or visibility under 1 mile'
  };
  function distanceKm(from, to) {
    const radians = (value) => value * Math.PI / 180;
    const dLat = radians(to.latitude - from.latitude), dLon = radians(to.longitude - from.longitude);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  async function pakistanMetars(controller) {
    // The same seven reports serve every city, so reuse them between lookups for a few minutes.
    if (state.pakistanMetar && Date.now() - state.pakistanMetar.at < 5 * 60000) return state.pakistanMetar.list;
    const payload = await requestJSON(`${METAR_API}/pakistan-metar`, controller, 12000);
    const list = Object.values(payload.airports || {}).filter((metar) => finite(metar?.lat) && finite(metar?.lon));
    state.pakistanMetar = { list, at: Date.now() };
    return list;
  }
  async function loadMetar(city, requestId) {
    state.metarController?.abort();
    const controller = new AbortController(); state.metarController = controller;
    const parameters = new URLSearchParams({ lat: String(city.latitude), lon: String(city.longitude) });
    const [pakistan, worldwide] = await Promise.allSettled([
      pakistanMetars(controller),
      requestJSON(`${METAR_API}/worldwide-metar?${parameters}`, controller, 12000)
    ]);
    if (requestId !== state.forecastId) return;
    const candidates = [];
    const addCandidate = (metar, distance) => {
      const radius = finite(metar.radius) ? metar.radius : METAR_DEFAULT_RADIUS_KM;
      if (distance <= METAR_MAX_KM) candidates.push({ metar, distance, radius, inRange: distance <= radius });
    };
    if (pakistan.status === 'fulfilled') {
      pakistan.value.forEach((metar) => addCandidate(metar, distanceKm(city, { latitude: metar.lat, longitude: metar.lon })));
    }
    const found = worldwide.status === 'fulfilled' && worldwide.value.found && worldwide.value.metar;
    if (found && finite(found.lat) && finite(found.lon)) {
      addCandidate(found, finite(worldwide.value.distance_km) ? worldwide.value.distance_km : distanceKm(city, { latitude: found.lat, longitude: found.lon }));
    }
    // An airport whose coverage includes the place beats a closer one whose coverage does not.
    candidates.sort((a, b) => (b.inRange - a.inRange) || a.distance - b.distance);
    state.metar = candidates[0] || null;
    state.metarStatus = state.metar ? 'ready' : pakistan.status === 'rejected' && worldwide.status === 'rejected' ? 'error' : 'none';
    renderMetar();
    renderWeather();
  }
  function metarObservedAt(metar) {
    // Pakistani reports use ISO strings; international reports use Unix seconds.
    const value = metar.observed;
    const time = typeof value === 'number' ? value * (value < 1e12 ? 1000 : 1) : Date.parse(value);
    return Number.isFinite(time) ? new Date(time) : null;
  }
  function flightCategory(metar) {
    // Computed from ceiling and visibility because the API labels every international report VFR.
    const ceilings = (metar.clouds || []).filter((cloud) => ['BKN', 'OVC', 'VV'].includes(cloud.cover) && finite(cloud.base)).map((cloud) => cloud.base);
    const ceiling = ceilings.length ? Math.min(...ceilings) : Infinity;
    const miles = finite(metar.visibility_km) ? metar.visibility_km / 1.609344 : Infinity;
    if (ceiling < 500 || miles < 1) return 'LIFR';
    if (ceiling < 1000 || miles < 3) return 'IFR';
    if (ceiling <= 3000 || miles <= 5) return 'MVFR';
    return 'VFR';
  }
  function describeWeatherCode(code) {
    let rest = code, intensity = '', vicinity = false, kind = '';
    if (rest[0] === '+' || rest[0] === '-') { intensity = rest[0] === '+' ? 'heavy' : 'light'; rest = rest.slice(1); }
    if (rest.startsWith('VC')) { vicinity = true; rest = rest.slice(2); }
    const prefix = rest.slice(0, 2);
    if (WEATHER_DESCRIPTORS[prefix] || prefix === 'SH' || prefix === 'TS') { kind = prefix; rest = rest.slice(2); }
    const phenomena = (rest.match(/[A-Z]{2}/g) || []).map((part) => WEATHER_PHENOMENA[part]);
    if (phenomena.some((part) => !part)) return code;
    const what = [intensity, WEATHER_DESCRIPTORS[kind], phenomena.join(' and ')].filter(Boolean).join(' ');
    let phrase = what;
    if (kind === 'SH') phrase = phenomena.length ? `${what} showers` : [intensity, 'showers'].filter(Boolean).join(' ');
    if (kind === 'TS') phrase = phenomena.length ? `thunderstorm with ${what}` : [intensity, 'thunderstorm'].filter(Boolean).join(' ');
    if (!phrase) return code;
    if (vicinity) phrase += ' nearby';
    return phrase[0].toUpperCase() + phrase.slice(1);
  }
  function metarSky(metar) {
    const clouds = (metar.clouds || []).filter((cloud) => SKY_COVER[cloud.cover]);
    if (clouds.length) return clouds.map((cloud) => `${SKY_COVER[cloud.cover]}${finite(cloud.base) ? ` at ${cloud.base.toLocaleString('en')} ft` : ''}`).join(', ');
    const raw = metar.raw_text || '';
    if (/\bCAVOK\b/.test(raw)) return 'Clear (CAVOK)';
    if (/\b(NSC|NCD)\b/.test(raw)) return 'No significant cloud';
    if (/\b(SKC|CLR)\b/.test(raw)) return 'Clear';
    return 'No cloud reported';
  }
  function metarGustKph(metar) {
    // The API omits gusts, so read them from the raw group, e.g. 24020G33KT.
    const gustGroup = (metar.raw_text || '').match(/\b(?:\d{3}|VRB)\d{2,3}G(\d{2,3})(KT|MPS|KMH)\b/);
    return gustGroup ? Math.round(Number(gustGroup[1]) * { KT: 1.852, MPS: 3.6, KMH: 1 }[gustGroup[2]]) : null;
  }
  // Present-weather groups at the airport itself; VC groups describe the surrounding area.
  function metarCodes(metar) {
    return (metar.conditions || []).flatMap((value) => String(value).split(/\s+/)).filter((code) => code && !code.replace(/^[+-]/, '').startsWith('VC'));
  }
  function metarWeatherCode(metar) {
    // Maps the report onto the WMO codes the icons and backgrounds use.
    const codes = metarCodes(metar);
    const has = (pattern) => codes.some((code) => pattern.test(code));
    const strength = (pattern, light, moderate, heavy) => {
      const code = codes.find((value) => pattern.test(value));
      return code[0] === '+' ? heavy : code[0] === '-' ? light : moderate;
    };
    if (has(/TS/)) return has(/GR|GS/) ? 96 : 95;
    if (has(/SN|SG|PL|IC/)) return has(/SH(SN|PL)/) ? 85 : strength(/SN|SG|PL|IC/, 71, 73, 75);
    if (has(/FZ(RA|DZ)/)) return 66;
    if (has(/SH/)) return strength(/SH/, 80, 81, 82);
    if (has(/RA/)) return strength(/RA/, 61, 63, 65);
    if (has(/DZ/)) return strength(/DZ/, 51, 53, 55);
    if (has(/FG/)) return has(/FZFG/) ? 48 : 45;
    const covers = (metar.clouds || []).map((cloud) => cloud.cover);
    if (covers.some((cover) => ['BKN', 'OVC', 'VV'].includes(cover))) return 3;
    if (covers.includes('SCT')) return 2;
    return covers.includes('FEW') ? 1 : 0;
  }
  function metarCondition(metar, isDay) {
    // describeWeatherCode returns codes it cannot decode unchanged; skip those.
    const described = metarCodes(metar).map((code) => [code, describeWeatherCode(code)]).find(([code, phrase]) => phrase !== code);
    if (described) return described[1];
    const covers = (metar.clouds || []).map((cloud) => cloud.cover);
    if (covers.includes('OVC') || covers.includes('VV')) return 'Overcast';
    if (covers.includes('BKN')) return 'Mostly cloudy';
    if (covers.includes('SCT')) return 'Partly cloudy';
    if (covers.includes('FEW')) return 'Mostly clear';
    return isDay ? 'Clear skies' : 'Clear night';
  }
  function apparentTemperature(temp, humidity, windKph) {
    // Australian apparent temperature, the formula behind Open-Meteo's feels-like, so both sources read alike.
    if (!finite(temp) || !finite(humidity) || !finite(windKph)) return null;
    const vapour = humidity / 100 * 6.105 * Math.exp(17.27 * temp / (237.7 + temp));
    return temp + 0.33 * vapour - 0.7 * (windKph / 3.6) - 4;
  }
  // The airport's report is used for current conditions only when the place is inside its coverage and the report is recent.
  function liveMetar() {
    const candidate = state.metar;
    if (!candidate?.inRange) return null;
    const observed = metarObservedAt(candidate.metar);
    return observed && Date.now() - observed <= METAR_STALE_MINUTES * 60000 ? { ...candidate, observed } : null;
  }
  function currentConditions() {
    const model = state.weather.current;
    const conditions = {
      source: null, temperature: model.temperature_2m, apparent: model.apparent_temperature,
      weatherCode: state.weather.wapk?.current.code ?? model.weather_code, hail: Boolean(state.weather.wapk?.current.hail),
      isDay: Boolean(model.is_day), humidity: model.relative_humidity_2m, dewPoint: hourlyValue('dew_point_2m'),
      windSpeed: model.wind_speed_10m, windDirection: model.wind_direction_10m, windVariable: false, windGusts: model.wind_gusts_10m,
      visibility: hourlyValue('visibility'), visibilityAtLeast: false, pressure: model.surface_pressure
    };
    conditions.condition = conditions.weatherCode === 0 && !conditions.isDay ? 'Clear night' : `${condition(conditions.weatherCode)}${conditions.hail ? ' with possible hail' : ''}`;
    const live = liveMetar();
    if (!live) return conditions;
    const { metar } = live;
    const use = (value, fallback) => finite(value) ? value : fallback;
    Object.assign(conditions, {
      source: live,
      temperature: use(metar.temp_c, conditions.temperature),
      humidity: use(metar.humidity, conditions.humidity),
      dewPoint: use(metar.dewpoint_c, conditions.dewPoint),
      windSpeed: use(metar.wind_kph, conditions.windSpeed),
      windDirection: finite(metar.wind_degrees) && metar.wind_kph > 0 ? metar.wind_degrees : null,
      windVariable: metar.wind_degrees === 'VRB',
      windGusts: metarGustKph(metar),
      // The API turns "9999" and CAVOK into 9.65 km; both mean 10 km or more.
      visibility: finite(metar.visibility_km) ? (metar.visibility_km >= 9.6 ? 10000 : metar.visibility_km * 1000) : conditions.visibility,
      visibilityAtLeast: finite(metar.visibility_km) && metar.visibility_km >= 9.6,
      pressure: use(metar.pressure_hpa, conditions.pressure),
      weatherCode: metarWeatherCode(metar),
      hail: metarCodes(metar).some((code) => /GR|GS/.test(code))
    });
    conditions.apparent = use(apparentTemperature(conditions.temperature, conditions.humidity, conditions.windSpeed), conditions.apparent);
    conditions.condition = metarCondition(metar, conditions.isDay);
    return conditions;
  }
  function metarWind(metar) {
    if (!finite(metar.wind_kph)) return DASH;
    if (metar.wind_kph === 0) return 'Calm';
    const gustKph = metarGustKph(metar);
    const speed = `${number(metar.wind_kph, ' km/h')}${gustKph ? `, gusts ${gustKph}` : ''}`;
    if (metar.wind_degrees === 'VRB') return `Variable, ${speed}`;
    return finite(metar.wind_degrees) ? `${metar.wind_dir || ''} ${speed} (${metar.wind_degrees}°)`.trim() : speed;
  }
  function metarAge(date) {
    const minutes = Math.max(0, Math.round((Date.now() - date) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h ${minutes % 60} min ago`;
  }
  function renderMetar() {
    const body = byId('metarBody'), badge = byId('metarCategory');
    if (!body || !badge) return;
    badge.hidden = true;
    if (state.metarStatus !== 'ready' || !state.metar) {
      const messages = {
        loading: 'Finding the nearest airport report…',
        none: `No airport reports within ${METAR_MAX_KM} km of ${state.place.name}, so current conditions come from the forecast model.`,
        error: 'Airport reports are temporarily unavailable, so current conditions come from the forecast model.'
      };
      body.replaceChildren(element('p', 'empty-state', messages[state.metarStatus] || messages.error));
      return;
    }
    const { metar, distance, radius, inRange } = state.metar;
    if (!inRange) {
      const station = element('div', 'metar-station');
      const copy = element('div', 'metar-station-copy');
      copy.append(element('strong', '', `Nearest airport: ${metar.airport_name || metar.icao}`), element('span', 'metar-when', `${Math.round(distance)} km away`));
      station.append(element('span', 'metar-icao', metar.icao || '—'), copy);
      body.replaceChildren(station, element('p', 'metar-note', `${state.place.name} is outside this airport's ${radius} km coverage area, so current conditions above come from the forecast model.`));
      return;
    }
    const category = flightCategory(metar);
    badge.hidden = false; badge.textContent = category; badge.dataset.category = category;
    badge.title = FLIGHT_CATEGORIES[category]; badge.setAttribute('aria-label', FLIGHT_CATEGORIES[category]);

    const observed = metarObservedAt(metar);
    const stale = observed && Date.now() - observed > METAR_STALE_MINUTES * 60000;
    const zulu = observed ? `${String(observed.getUTCHours()).padStart(2, '0')}${String(observed.getUTCMinutes()).padStart(2, '0')}Z` : '';
    const station = element('div', 'metar-station');
    const copy = element('div', 'metar-station-copy');
    const when = observed ? `Observed ${metarAge(observed)} (${zulu})` : 'Observation time unavailable';
    const status = element('span', `metar-when${stale ? ' is-stale' : ''}`, `${Math.round(distance)} km away · ${when}${stale ? ' · older report' : ''}`);
    copy.append(element('strong', '', metar.airport_name || metar.icao || 'Airport'), status);
    station.append(element('span', 'metar-icao', metar.icao || '—'), copy);

    const visibility = finite(metar.visibility_km) ? metar.visibility_km >= 9.6 ? '10+ km' : number(metar.visibility_km, ' km', 1) : DASH;
    const conditions = (metar.conditions || []).flatMap((value) => String(value).split(/\s+/)).filter(Boolean).map(describeWeatherCode);
    const entries = [
      ['Temperature', temperature(metar.temp_c)],
      ['Dew point', temperature(metar.dewpoint_c)],
      ['Wind', metarWind(metar)],
      ['Visibility', visibility],
      ['Pressure', number(metar.pressure_hpa, ' hPa')],
      ['Sky', metarSky(metar)],
      ['Weather', conditions.length ? conditions.join(', ') : 'Nothing significant']
    ];
    const grid = element('dl', 'metar-grid');
    entries.forEach(([label, value]) => { const item = element('div', 'metar-stat'); item.append(element('dt', '', label), element('dd', '', value)); grid.append(item); });

    const parts = [station, grid];
    parts.push(element('p', 'metar-note', stale
      ? `This report is more than ${METAR_STALE_MINUTES} minutes old, so current conditions above come from the forecast model.`
      : `${state.place.name} is within this airport's ${radius} km coverage, so current conditions above use this report.`));
    const raw = element('div', 'metar-raw');
    raw.append(element('span', '', 'Raw METAR'), element('code', '', metar.raw_text || 'Unavailable'));
    parts.push(raw);
    body.replaceChildren(...parts);
  }

  byId('cityInput').addEventListener('input', () => {
    closeSearch(); state.searchResults = [];
    const query = byId('cityInput').value.trim();
    if (query.length < 2) return;
    text('searchMessage', 'Searching cities\u2026');
    state.searchTimer = setTimeout(() => searchCities(query), 250);
  });
  byId('cityInput').addEventListener('focus', () => {
    const query = byId('cityInput').value.trim();
    if (query.length >= 2 && byId('results').hidden) {
      clearTimeout(state.searchTimer);
      searchCities(query);
    }
  });
  byId('cityInput').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeSearch(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!byId('results').hidden && state.searchResults.length) {
      const next = state.activeResult < 0 ? (event.key === 'ArrowDown' ? 0 : state.searchResults.length - 1) : state.activeResult + (event.key === 'ArrowDown' ? 1 : -1);
      setActiveResult(next);
    } else {
      const query = byId('cityInput').value.trim();
      if (query.length >= 2) { clearTimeout(state.searchTimer); searchCities(query); }
    }
  });
  byId('searchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(state.searchTimer);
    if (!byId('results').hidden && state.searchResults.length) selectCity(Math.max(0, state.activeResult));
    else {
      const query = byId('cityInput').value.trim();
      if (query.length >= 2) searchCities(query, true);
      else text('searchMessage', 'Type at least two letters to find a city.');
    }
  });
  // Keep mouse focus in the combobox until click selects the option; touch retains native scrolling.
  byId('results').addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.target.closest('[data-city-index]')) event.preventDefault();
  });
  byId('results').addEventListener('click', (event) => {
    const option = event.target.closest('[data-city-index]');
    if (option) selectCity(Number(option.dataset.cityIndex));
  });
  document.addEventListener('pointerdown', (event) => { if (!byId('searchForm').contains(event.target)) closeSearch(); });
  byId('searchForm').addEventListener('focusout', (event) => {
    if (event.relatedTarget && !byId('searchForm').contains(event.relatedTarget)) closeSearch();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault(); byId('cityInput').focus(); byId('cityInput').select();
    }
  });
  byId('savedCities').addEventListener('click', (event) => {
    const button = event.target.closest('[data-saved-key]');
    const city = button && state.saved.find((saved) => cityKey(saved) === button.dataset.savedKey);
    if (city) { closeSearch(); byId('cityInput').value = ''; loadWeather(city); }
  });
  byId('saveButton').addEventListener('click', () => {
    const index = state.saved.findIndex((city) => cityKey(city) === cityKey(state.place));
    if (index >= 0) { state.saved.splice(index, 1); showToast(`${state.place.name} removed from saved places.`); }
    else {
      if (state.saved.length >= 20) { showToast('You can save up to 20 places. Remove a saved city to make room.'); return; }
      state.saved.push({ ...state.place }); showToast(`${state.place.name} saved for another day.`);
    }
    savePreferences(); renderSaved();
  });
  byId('unitControls').addEventListener('click', (event) => {
    const button = event.target.closest('[data-unit]');
    if (!button || !['C', 'F'].includes(button.dataset.unit)) return;
    state.unit = button.dataset.unit; savePreferences(); applySettings(); renderWeather(); renderMetar();
    document.dispatchEvent(new CustomEvent('atmos:unit', { detail: state.unit }));
  });
  byId('themeButton').addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light'; savePreferences(); applySettings();
  });
  byId('chartTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-metric]');
    if (!button || !['temperature', 'rain'].includes(button.dataset.metric)) return;
    state.metric = button.dataset.metric; renderChart();
  });
  byId('week').addEventListener('click', (event) => {
    const button = event.target.closest('[data-day]');
    if (!button || !state.weather) return;
    state.selectedDay = Number(button.dataset.day);
    byId('week').querySelectorAll('[data-day]').forEach((row) => {
      const active = Number(row.dataset.day) === state.selectedDay;
      row.classList.toggle('is-selected', active); row.setAttribute('aria-pressed', String(active));
    });
    renderDayDetails();
  });
  byId('refreshButton').addEventListener('click', () => loadWeather());
  byId('retryButton').addEventListener('click', () => loadWeather());
  // Names a position (or, without one, the visitor's approximate IP location). BigDataCloud's client endpoint needs no key.
  async function lookupPlace(coords) {
    const parameters = new URLSearchParams({ localityLanguage: 'en' });
    if (coords) { parameters.set('latitude', String(coords.latitude)); parameters.set('longitude', String(coords.longitude)); }
    const payload = await requestJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?${parameters}`, new AbortController(), 8000);
    return normalizeCity({
      name: payload.city || payload.locality || payload.principalSubdivision || 'Current location',
      latitude: coords ? coords.latitude : payload.latitude, longitude: coords ? coords.longitude : payload.longitude,
      admin1: payload.principalSubdivision, country: payload.countryName
    });
  }
  byId('locationButton').addEventListener('click', () => {
    if (state.locating) return;
    state.locating = true;
    const requestedAt = state.forecastId;
    const button = byId('locationButton'); button.disabled = true; button.setAttribute('aria-busy', 'true');
    text('locationLabel', 'Locating\u2026');
    const finish = () => {
      state.locating = false;
      button.disabled = false; button.setAttribute('aria-busy', 'false'); text('locationLabel', 'Current location');
    };
    const useLocation = async (coords, approximateHint = 'Turn on location services for a precise forecast.') => {
      let place = null;
      try { place = await lookupPlace(coords); } catch { /* Fall back to coordinates below. */ }
      finish();
      if (state.forecastId !== requestedAt) return;
      if (!place && !coords) { showToast('Your location is unavailable. Try searching for your city.'); return; }
      closeSearch(); byId('cityInput').value = '';
      loadWeather(place || { name: 'Current location', latitude: coords.latitude, longitude: coords.longitude });
      if (!coords) showToast(`Showing your approximate area, ${place.name}. ${approximateHint}`);
    };
    // Location needs HTTPS or localhost; elsewhere use the approximate area instead.
    if (!window.isSecureContext || !navigator.geolocation) { useLocation(null); return; }
    let settled = false;
    const fail = async (code) => {
      if (settled) return; settled = true; clearTimeout(timeout);
      if (code !== 1) { useLocation(null); return; }
      // Browsers also report "denied" when the operating system blocks location (e.g. Windows Location off)
      // even though this site is allowed, so only treat it as the visitor's refusal if the site permission says so.
      let sitePermission = 'unknown';
      try { sitePermission = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { /* Permissions API unavailable. */ }
      if (sitePermission === 'granted') { useLocation(null, 'Your device is blocking precise location: turn on Windows Settings › Privacy & security › Location.'); return; }
      finish();
      if (state.forecastId === requestedAt) showToast('Location access was denied. Allow it in your browser settings, or search for a city.');
    };
    const timeout = setTimeout(() => fail(3), 15000);
    navigator.geolocation.getCurrentPosition((position) => {
      if (settled) return; settled = true; clearTimeout(timeout);
      useLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude });
    }, (error) => fail(error.code), { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });
  document.querySelectorAll('.nav-link[href^="#"]').forEach((link) => link.addEventListener('click', () => {
    document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('active', item === link));
  }));
  window.addEventListener('offline', () => showToast('You are offline. Reconnect to load fresh weather.'));
  // Read-only view of the dashboard for views.js and the map; changes are announced via atmos:place, atmos:theme and atmos:unit.
  window.Atmos = Object.freeze({
    get place() { return { ...state.place }; }, get theme() { return state.theme; }, get unit() { return state.unit; },
    // For the map's point forecast and picker.
    fetchForecast, condition, lookupPlace: (latitude, longitude) => lookupPlace({ latitude, longitude }),
    // Each forecast day's classified weather (storm tier, hail, storm strength), for the Health section.
    get forecastDays() {
      if (!state.weather?.daily?.time) return [];
      return state.weather.daily.time.map((date, index) => {
        const info = dayInfo(index);
        const code = dayCode(index);
        return { date, code, condition: condition(code), hail: Boolean(info?.hail), intensity: info?.intensity || null };
      });
    }
  });
  applySettings(); renderSaved();
  // A link may name a place (?lat=…&lon=…, as the WAPK app's map does). Otherwise the first visit, and every visit
  // once location is allowed, starts from the visitor's own location, as on Windy.
  const linked = new URLSearchParams(window.location.search);
  const linkedLat = Number(linked.get('lat'));
  const linkedLon = Number(linked.get('lon'));
  if (linked.has('lat') && linked.has('lon') && Math.abs(linkedLat) <= 90 && Math.abs(linkedLon) <= 180) {
    const fallback = { name: linked.get('name') || 'Your location', latitude: linkedLat, longitude: linkedLon };
    state.place = normalizeCity(fallback);
    loadWeather();
    lookupPlace({ latitude: linkedLat, longitude: linkedLon }).then((place) => {
      if (place && state.place.latitude === linkedLat && state.place.longitude === linkedLon) loadWeather({ ...place, latitude: linkedLat, longitude: linkedLon });
    }).catch(() => {});
  } else {
    loadWeather();
    const firstVisit = !normalizeCity(preferences.place);
    const locate = () => { if (!state.locating) byId('locationButton').click(); };
    if (firstVisit) locate();
    else navigator.permissions?.query({ name: 'geolocation' }).then((status) => { if (status.state === 'granted') locate(); }).catch(() => {});
  }
  setInterval(() => { if (!document.hidden && !state.loading && !state.locating) loadWeather(); }, 15 * 60 * 1000);
})();
