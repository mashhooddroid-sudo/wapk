(() => {
  'use strict';

  // Health section: air quality, PMD pollen, dengue (mosquito) conditions and weather health threats for the
  // chosen place. Sources:
  //   • Air quality — Open-Meteo Air Quality (CAMS): US AQI and pollutants, 4-day forecast.
  //   • Pollen — PMD's daily Islamabad pollen count, read by the PK worker (/api/pollen).
  //   • Weather — Open-Meteo forecast with the past 14 days, for dengue conditions, heat, cold and UV.
  //   • Thunderstorms and hail — the classification app.js already made (weather-logic.js).
  // There is no open feed of dengue cases in Pakistan, so dengue risk here is a weather-based estimate of how
  // favourable conditions are for Aedes mosquitoes, not a count of cases.
  const WORKER = 'https://lightning-weatherx-pk-api.mashhood-droid.workers.dev';
  const REFRESH_MS = 30 * 60 * 1000;
  const POLLEN_NEAR_KM = 150; // Pollen alerts are raised only this close to PMD's Islamabad sampler.
  const ALERT_DAYS = 3;

  const byId = (id) => document.getElementById(id);
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const ui = (name) => window.AtmosIcons?.ui(name) || '';
  const state = { key: null, loadedAt: 0, data: null, request: 0, visible: false };

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = content;
    return node;
  }

  function place() { return window.Atmos?.place || null; }
  function placeKey(city) { return city ? `${Number(city.latitude).toFixed(3)},${Number(city.longitude).toFixed(3)}` : null; }
  function degrees(value) {
    if (!finite(value)) return '—';
    return window.Atmos?.unit === 'F' ? `${Math.round(value * 9 / 5 + 32)}°` : `${Math.round(value)}°`;
  }
  function dayName(date, index) {
    if (index === 0) return 'Today';
    if (index === 1) return 'Tomorrow';
    return new Intl.DateTimeFormat('en', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00Z`));
  }
  function shortDay(date, index) {
    if (index === 0) return 'Today';
    return new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00Z`));
  }
  function distanceKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.latitude - a.latitude) * rad;
    const dLon = (b.longitude - a.longitude) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }
  async function getJSON(url, timeout = 15000) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json();
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  async function load(force = false) {
    const city = place();
    if (!city) return;
    const key = placeKey(city);
    if (!force && key === state.key && Date.now() - state.loadedAt < REFRESH_MS && state.data) { render(); return; }
    const request = ++state.request;
    state.key = key;
    byId('healthPlace').textContent = city.name || 'Your location';
    setBusy(true);
    const coords = { latitude: String(city.latitude), longitude: String(city.longitude), timezone: 'auto' };
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
      ...coords, past_days: '14', forecast_days: '7',
      daily: 'temperature_2m_max,temperature_2m_min,temperature_2m_mean,apparent_temperature_max,apparent_temperature_min,relative_humidity_2m_mean,precipitation_sum,uv_index_max',
      hourly: 'visibility'
    })}`;
    const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?${new URLSearchParams({
      ...coords, forecast_days: '4',
      current: 'us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,dust',
      hourly: 'us_aqi,dust'
    })}`;
    const [weather, air, pollen] = await Promise.allSettled([getJSON(weatherUrl), getJSON(airUrl), getJSON(`${WORKER}/api/pollen`, 20000)]);
    if (request !== state.request) return;
    state.data = {
      city,
      weather: weather.status === 'fulfilled' ? weather.value : null,
      air: air.status === 'fulfilled' ? air.value : null,
      pollen: pollen.status === 'fulfilled' && pollen.value?.success ? pollen.value : null
    };
    state.loadedAt = Date.now();
    setBusy(false);
    render();
  }

  function setBusy(busy) { byId('healthView').setAttribute('aria-busy', String(busy)); }

  // ── Risk rules ────────────────────────────────────────────────────────────

  const AQI_LEVELS = [
    [50, 'Good', 'good', 'Air quality is fine for everyone.'],
    [100, 'Moderate', 'moderate', 'Unusually sensitive people should limit long or heavy exertion outdoors.'],
    [150, 'Unhealthy for sensitive groups', 'sensitive', 'Children, older adults and people with asthma or heart disease should reduce outdoor exertion.'],
    [200, 'Unhealthy', 'unhealthy', 'Everyone should reduce outdoor exertion; sensitive groups should avoid it. Consider a mask outdoors.'],
    [300, 'Very unhealthy', 'very-unhealthy', 'Avoid outdoor activity. Keep windows closed and use an air purifier if you have one.'],
    [Infinity, 'Hazardous', 'hazardous', 'Stay indoors. Everyone may have serious health effects.']
  ];
  const aqiLevel = (aqi) => AQI_LEVELS.find(([limit]) => aqi <= limit);

  // Dengue (Aedes mosquito) conditions for one day. Points, 0–8:
  //   temperature (daily mean): under 16 °C 0 · 16–20 1 · 20–24 2 · 24–32 3 (best for Aedes) · 32–35 2 · over 35 1
  //   humidity (daily mean):    under 50 % 0 · 50–70 1 · 70+ 2
  //   rain in the previous 14 days (breeding water): under 5 mm 0 · 5–25 1 · 25+ 2
  //   season: August–November, Pakistan's dengue season, +1
  // 0–2 Low · 3–4 Moderate · 5–6 High · 7–8 Very high. Below 16 °C mosquitoes barely bite, so it stays Low.
  function dengueRisk(meanT, humidity, rain14, month) {
    if (!finite(meanT)) return null;
    const temp = meanT < 16 ? 0 : meanT < 20 ? 1 : meanT < 24 ? 2 : meanT <= 32 ? 3 : meanT <= 35 ? 2 : 1;
    const wet = !finite(humidity) ? 0 : humidity >= 70 ? 2 : humidity >= 50 ? 1 : 0;
    const water = !finite(rain14) ? 0 : rain14 >= 25 ? 2 : rain14 >= 5 ? 1 : 0;
    const season = month >= 8 && month <= 11 ? 1 : 0;
    const score = meanT < 16 ? Math.min(2, temp + wet + water + season) : temp + wet + water + season;
    const level = score <= 2 ? 'Low' : score <= 4 ? 'Moderate' : score <= 6 ? 'High' : 'Very high';
    return { score, level, temp, wet, water, season };
  }

  function dailySeries() {
    const daily = state.data?.weather?.daily;
    if (!daily?.time) return [];
    // past_days puts 14 days before today; today is the first date not before the place's local date.
    const today = state.data.weather.current_weather?.time?.slice(0, 10) || localToday(state.data.weather.utc_offset_seconds);
    const start = Math.max(0, daily.time.indexOf(today));
    return daily.time.slice(start).map((date, offset) => {
      const index = start + offset;
      const rain14 = daily.precipitation_sum.slice(Math.max(0, index - 14), index).reduce((sum, value) => sum + (finite(value) ? value : 0), 0);
      return {
        date,
        max: daily.temperature_2m_max?.[index], min: daily.temperature_2m_min?.[index], mean: daily.temperature_2m_mean?.[index],
        feelsMax: daily.apparent_temperature_max?.[index], feelsMin: daily.apparent_temperature_min?.[index],
        humidity: daily.relative_humidity_2m_mean?.[index], rain: daily.precipitation_sum?.[index], rain14,
        uv: daily.uv_index_max?.[index],
        dengue: dengueRisk(daily.temperature_2m_mean?.[index], daily.relative_humidity_2m_mean?.[index], rain14, Number(date.slice(5, 7)))
      };
    });
  }

  function localToday(offsetSeconds) {
    return new Date(Date.now() + (offsetSeconds || 0) * 1000).toISOString().slice(0, 10);
  }

  // Highest hourly value per local date of an hourly series.
  function dailyMax(hourly, field, reduce = Math.max) {
    const out = new Map();
    (hourly?.time || []).forEach((time, index) => {
      const value = hourly[field]?.[index];
      if (!finite(value)) return;
      const date = time.slice(0, 10);
      out.set(date, out.has(date) ? reduce(out.get(date), value) : value);
    });
    return out;
  }

  const SHORT_LEVEL = { Low: 'Low', Moderate: 'Mod', High: 'High', 'Very high': 'V.high' };
  const POLLEN_ORDER = { absent: 0, low: 1, moderate: 2, high: 3, 'very high': 4 };
  const pollenRank = (category) => POLLEN_ORDER[String(category || '').toLowerCase()] ?? 0;
  const pollenClass = (category) => ['absent', 'low', 'moderate', 'high', 'very-high'][pollenRank(category)];

  // Every alert for today and the next two days, most serious first.
  function buildAlerts(days) {
    const alerts = [];
    const add = (severity, icon, title, when, detail, advice) => alerts.push({ severity, icon, title, when, detail, advice });
    const rank = { severe: 3, high: 2, moderate: 1 };
    const aqiByDay = dailyMax(state.data?.air?.hourly, 'us_aqi');
    const dustByDay = dailyMax(state.data?.air?.hourly, 'dust');
    const visibilityByDay = dailyMax(state.data?.weather?.hourly, 'visibility', Math.min);
    const storms = window.Atmos?.forecastDays || [];

    days.slice(0, ALERT_DAYS).forEach((day, index) => {
      const when = dayName(day.date, index);
      // Heat: feels-like maximum, NOAA heat index bands.
      if (finite(day.feelsMax)) {
        if (day.feelsMax >= 54) add('severe', 'thermometer', 'Extreme heat danger', when, `Feels like ${degrees(day.feelsMax)}. Heatstroke is likely with exposure.`, 'Stay indoors in the hottest hours, drink water often, check on elderly people and children.');
        else if (day.feelsMax >= 41) add('high', 'thermometer', 'Heatstroke danger', when, `Feels like ${degrees(day.feelsMax)}. Heat cramps and heat exhaustion are likely; heatstroke possible.`, 'Avoid the sun 11 AM–4 PM, drink plenty of water, wear light clothing.');
        else if (day.feelsMax >= 35) add('moderate', 'thermometer', 'Heat caution', when, `Feels like ${degrees(day.feelsMax)}. Heat exhaustion is possible with long exposure.`, 'Take breaks in the shade and keep drinking water.');
      }
      // Cold.
      if (finite(day.feelsMin) && day.feelsMin <= -10) add('high', 'snowflake', 'Severe cold', when, `Feels like ${degrees(day.feelsMin)} at night. Risk of frostbite and hypothermia.`, 'Dress in layers, cover hands and face, keep heaters ventilated (carbon monoxide).');
      else if (finite(day.min) && day.min <= 0) add('moderate', 'snowflake', 'Freezing night', when, `Low of ${degrees(day.min)}. Frost and icy roads possible.`, 'Keep warm at night; take care on roads in the morning. Ventilate gas heaters.');
      // UV.
      if (finite(day.uv) && day.uv >= 11) add('high', 'sun', 'Extreme UV', when, `UV index up to ${Math.round(day.uv)}. Unprotected skin burns in minutes.`, 'Avoid midday sun, wear a hat and sunglasses, use SPF 30+ sunscreen.');
      else if (finite(day.uv) && day.uv >= 8) add('moderate', 'sun', 'Very high UV', when, `UV index up to ${Math.round(day.uv)}.`, 'Seek shade at midday and protect skin and eyes.');
      // Air quality (daily maximum of the hourly forecast).
      const aqi = aqiByDay.get(day.date);
      if (finite(aqi) && aqi > 100) {
        const [, label] = aqiLevel(aqi);
        const severity = aqi > 300 ? 'severe' : aqi > 150 ? 'high' : 'moderate';
        add(severity, 'leaf', `Air quality: ${label}`, when, `US AQI up to ${Math.round(aqi)}.`, aqiLevel(aqi)[3]);
      }
      // Dust.
      const dust = dustByDay.get(day.date);
      if (finite(dust) && dust >= 500) add('high', 'wind', 'Dust storm conditions', when, `Dust up to ${Math.round(dust)} µg/m³.`, 'Stay indoors, keep windows shut, wear a mask outdoors. People with asthma should keep inhalers at hand.');
      else if (finite(dust) && dust >= 200) add('moderate', 'wind', 'Dusty air', when, `Dust up to ${Math.round(dust)} µg/m³.`, 'People with asthma or allergies should limit time outdoors.');
      // Fog and smog.
      const visibility = visibilityByDay.get(day.date);
      if (finite(visibility) && visibility < 1000) {
        const smog = finite(aqi) && aqi > 150;
        add(smog ? 'high' : 'moderate', 'eye', smog ? 'Smog' : 'Fog', when, `Visibility down to ${visibility < 1000 ? `${Math.round(visibility / 10) * 10} m` : ''}${smog ? ` with US AQI ${Math.round(aqi)}` : ''}.`, smog ? 'Avoid outdoor exercise, wear a mask, drive slowly with low beams.' : 'Drive slowly with low beams and keep distance.');
      }
      // Thunderstorms and hail (app.js classification).
      const storm = storms.find((item) => item.date === day.date);
      if (storm && storm.code >= 95) {
        const severity = storm.hail || storm.intensity === 'severe' ? 'high' : 'moderate';
        add(severity, 'bolt', storm.hail ? 'Thunderstorms with possible hail' : 'Thunderstorms', when, `${storm.condition}${storm.intensity ? ` · ${storm.intensity} storm energy` : ''}.`, 'Stay indoors during storms, avoid open ground, trees and poles. Lightning can strike 15 km from a storm.');
      }
      // Dengue conditions.
      if (day.dengue && (day.dengue.level === 'High' || day.dengue.level === 'Very high')) {
        add(day.dengue.level === 'Very high' ? 'high' : 'moderate', 'mosquito', `Dengue mosquito risk: ${day.dengue.level}`, when, 'Warm, humid weather after rain favours Aedes mosquitoes, which bite mostly at dawn and dusk.', 'Remove standing water, use repellent and full sleeves, sleep under a net. See a doctor for fever with body aches.');
      }
    });

    // Pollen (latest PMD count), only near Islamabad.
    const pollen = state.data?.pollen;
    if (pollen?.latest && distanceKm(state.data.city, pollen.station) <= POLLEN_NEAR_KM) {
      const top = Math.max(...pollen.latest.types.map((item) => pollenRank(item.category)));
      if (top >= 3) {
        const names = pollen.latest.types.filter((item) => pollenRank(item.category) === top).map((item) => item.type).join(', ');
        add(top === 4 ? 'high' : 'moderate', 'flower', `Pollen ${top === 4 ? 'very high' : 'high'}`, `PMD, ${pollen.latest.label}`, `${names} pollen ${top === 4 ? 'very high' : 'high'} in Islamabad.`, 'Allergy sufferers: keep windows closed, wear a mask and sunglasses outdoors, shower after coming in.');
      }
    }
    // The same alert on several days becomes one card ("Today, Tomorrow, Friday") at its worst severity,
    // keeping the first day's details.
    const merged = [];
    alerts.forEach((alert) => {
      const same = merged.find((item) => item.title === alert.title);
      if (!same) { merged.push({ ...alert }); return; }
      same.when = `${same.when}, ${alert.when}`;
      if (rank[alert.severity] > rank[same.severity]) same.severity = alert.severity;
    });
    return merged.sort((a, b) => rank[b.severity] - rank[a.severity]);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function render() {
    if (!state.data) return;
    const days = dailySeries();
    renderAlerts(buildAlerts(days));
    renderAir();
    renderPollen();
    renderDengue(days);
    renderWeatherRisks(days);
    const updated = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(state.loadedAt));
    byId('healthUpdated').textContent = `Updated ${updated}`;
  }

  function renderAlerts(alerts) {
    const list = byId('healthAlerts');
    list.replaceChildren();
    byId('healthAlertCount').textContent = alerts.length ? `${alerts.length} active` : 'All clear';
    byId('healthAlertCount').className = `health-count ${alerts.length ? `is-${alerts[0].severity}` : 'is-clear'}`;
    if (!alerts.length) {
      list.append(element('p', 'health-clear', 'No health alerts for the next three days.'));
      return;
    }
    alerts.forEach((alert) => {
      const item = element('article', `health-alert is-${alert.severity}`);
      const art = element('span', 'health-alert-icon');
      art.innerHTML = ui(alert.icon);
      const body = element('div', 'health-alert-body');
      const top = element('div', 'health-alert-top');
      top.append(element('strong', '', alert.title), element('span', 'health-when', alert.when));
      body.append(top, element('p', '', alert.detail), element('p', 'health-advice', alert.advice));
      item.append(art, body);
      list.append(item);
    });
  }

  function renderAir() {
    const body = byId('healthAir');
    body.replaceChildren();
    const air = state.data.air;
    const current = air?.current;
    if (!finite(current?.us_aqi)) { body.append(element('p', 'empty-state', 'Air quality is temporarily unavailable.')); return; }
    const [, label, key, advice] = aqiLevel(current.us_aqi);
    const head = element('div', 'aqi-head');
    const dial = element('div', `aqi-dial is-${key}`);
    dial.append(element('strong', '', String(Math.round(current.us_aqi))), element('span', '', 'US AQI'));
    const text = element('div', 'aqi-text');
    text.append(element('p', 'aqi-label', label), element('p', 'health-advice', advice));
    head.append(dial, text);
    const pollutants = element('div', 'aqi-pollutants');
    [['PM2.5', 'pm2_5'], ['PM10', 'pm10'], ['O₃', 'ozone'], ['NO₂', 'nitrogen_dioxide'], ['SO₂', 'sulphur_dioxide'], ['CO', 'carbon_monoxide'], ['Dust', 'dust']].forEach(([name, field]) => {
      const value = current[field];
      const tile = element('div', 'aqi-pollutant');
      tile.append(element('span', '', name), element('strong', '', finite(value) ? String(Math.round(value)) : '—'), element('small', '', 'µg/m³'));
      pollutants.append(tile);
    });
    const outlook = element('div', 'aqi-outlook');
    [...dailyMax(air.hourly, 'us_aqi')].slice(0, 4).forEach(([date, value], index) => {
      const [, dayLabel, dayKey] = aqiLevel(value);
      const col = element('div', 'aqi-day');
      const bar = element('span', `aqi-bar is-${dayKey}`);
      bar.style.height = `${Math.max(8, Math.min(100, value / 3))}%`;
      bar.title = `${dayLabel}, up to ${Math.round(value)}`;
      col.append(element('strong', '', String(Math.round(value))), bar, element('span', '', shortDay(date, index)));
      outlook.append(col);
    });
    body.append(head, pollutants, element('p', 'health-subhead', 'Highest AQI each day'), outlook);
  }

  function renderPollen() {
    const body = byId('healthPollen');
    body.replaceChildren();
    const pollen = state.data.pollen;
    if (!pollen?.latest) { body.append(element('p', 'empty-state', 'PMD pollen data is temporarily unavailable.')); return; }
    const latest = pollen.latest;
    const distance = distanceKm(state.data.city, pollen.station);
    const top = latest.types.reduce((best, item) => (pollenRank(item.category) > pollenRank(best) ? item.category : best), 'Absent');
    const head = element('div', 'pollen-head');
    head.append(element('span', `pollen-chip is-${pollenClass(top)}`, `Overall ${top.toLowerCase()}`), element('span', 'health-when', `PMD count for ${latest.label}`));
    body.append(head);
    if (distance > POLLEN_NEAR_KM) body.append(element('p', 'health-note', `Measured in Islamabad, ${Math.round(distance)} km from ${state.data.city.name}. Your local levels may differ.`));
    // Sampling sites that reported anything that day.
    const sites = latest.sites.filter((site) => latest.types.some((item) => finite(item.counts[site])));
    const list = element('div', 'pollen-list');
    [...latest.types].sort((a, b) => pollenRank(b.category) - pollenRank(a.category) || maxCount(b) - maxCount(a)).forEach((item) => {
      const row = element('div', 'pollen-row');
      const trend = pollenTrend(item.type);
      row.append(element('span', 'pollen-name', item.type), element('span', `pollen-chip is-${pollenClass(item.category)}`, item.category || '—'),
        element('span', 'pollen-count', sites.map((site) => (finite(item.counts[site]) ? item.counts[site] : '—')).join(' / ')), trend);
      list.append(row);
    });
    const header = element('div', 'pollen-row pollen-row-head');
    header.append(element('span', '', 'Pollen'), element('span', '', 'Level'), element('span', '', 'Count'), element('span', '', 'Trend'));
    body.append(header, list);
    body.append(element('p', 'health-note', `Grains per m³ of air over 24 hours at PMD's Islamabad sampler${sites.length === 1 ? ` in sector ${sites[0]}` : sites.length ? `s in sectors ${sites.join(' / ')}` : 's'}. Updated daily by PMD.`));
  }

  function maxCount(item) {
    const values = Object.values(item.counts || {}).filter(finite);
    return values.length ? Math.max(...values) : 0;
  }

  // Tiny bar trend of the last 14 reports for one pollen type.
  function pollenTrend(type) {
    const history = (state.data.pollen.history || []).slice(-14);
    const wrap = element('span', 'pollen-trend');
    if (history.length < 2) { wrap.textContent = 'building'; wrap.classList.add('is-empty'); return wrap; }
    const counts = history.map((report) => report.types.find((item) => item.type === type)?.count ?? 0);
    const peak = Math.max(1, ...counts);
    counts.forEach((count, index) => {
      const bar = element('i');
      bar.style.height = `${Math.max(8, (count / peak) * 100)}%`;
      bar.title = `${history[index].date}: ${count}`;
      wrap.append(bar);
    });
    return wrap;
  }

  function renderDengue(days) {
    const body = byId('healthDengue');
    body.replaceChildren();
    const today = days[0]?.dengue;
    if (!today) { body.append(element('p', 'empty-state', 'Weather data is temporarily unavailable.')); return; }
    const head = element('div', 'dengue-head');
    head.append(element('span', `risk-chip is-${today.level.toLowerCase().replace(' ', '-')}`, today.level), element('span', 'health-when', 'Today'));
    const factors = element('ul', 'dengue-factors');
    const d0 = days[0];
    [
      ['Temperature', `${degrees(d0.mean)} average`, today.temp, 3, today.temp >= 3 ? 'ideal for Aedes' : today.temp === 0 ? 'too cold for mosquitoes' : 'mosquitoes less active'],
      ['Humidity', finite(d0.humidity) ? `${Math.round(d0.humidity)}%` : '—', today.wet, 2, today.wet === 2 ? 'humid' : today.wet === 1 ? 'moderate' : 'dry'],
      ['Rain, last 14 days', `${Math.round(d0.rain14)} mm`, today.water, 2, today.water === 2 ? 'plenty of breeding water' : today.water === 1 ? 'some standing water' : 'little rain (water tanks and coolers still breed mosquitoes)'],
      ['Season', today.season ? 'Dengue season' : 'Off season', today.season, 1, today.season ? 'August–November peak' : 'cases are fewer']
    ].forEach(([name, value, points, max, note]) => {
      const item = element('li');
      const meter = element('span', 'factor-meter');
      const fill = element('i');
      fill.style.width = `${(points / max) * 100}%`;
      meter.append(fill);
      item.append(element('span', 'factor-name', name), element('strong', '', value), meter, element('small', '', note));
      factors.append(item);
    });
    const week = element('div', 'risk-week');
    days.slice(0, 7).forEach((day, index) => {
      const cell = element('div', 'risk-day');
      const level = day.dengue?.level;
      const dot = element('span', `risk-dot is-${(level || 'low').toLowerCase().replace(' ', '-')}`, level ? SHORT_LEVEL[level] : '—');
      dot.title = level ? `${level} risk` : 'Unavailable';
      cell.append(element('span', '', shortDay(day.date, index)), dot);
      week.append(cell);
    });
    body.append(head, factors, week, element('p', 'health-note', 'Estimated from the weather: how favourable conditions are for the mosquitoes that spread dengue. It is not a count of cases — follow your district health department for outbreak alerts.'),
      element('p', 'health-advice', 'Empty or cover water containers, coolers and plant pots weekly; use repellent and full sleeves at dawn and dusk; see a doctor for high fever with body aches, and avoid painkillers other than paracetamol.'));
  }

  function renderWeatherRisks(days) {
    const body = byId('healthWeather');
    body.replaceChildren();
    if (!days.length) { body.append(element('p', 'empty-state', 'Weather data is temporarily unavailable.')); return; }
    const table = element('div', 'risk-table');
    const head = element('div', 'risk-row risk-row-head');
    ['Day', 'Feels like', 'UV max', 'Rain'].forEach((label) => head.append(element('span', '', label)));
    table.append(head);
    days.slice(0, 7).forEach((day, index) => {
      const row = element('div', 'risk-row');
      const heat = !finite(day.feelsMax) ? '' : day.feelsMax >= 41 ? 'is-high' : day.feelsMax >= 35 ? 'is-moderate' : day.feelsMin <= -10 || day.min <= 0 ? 'is-cold' : '';
      const uv = !finite(day.uv) ? '' : day.uv >= 11 ? 'is-high' : day.uv >= 8 ? 'is-moderate' : '';
      row.append(element('span', 'risk-dayname', shortDay(day.date, index)),
        element('span', `risk-value ${heat}`, `${degrees(day.feelsMin)} / ${degrees(day.feelsMax)}`),
        element('span', `risk-value ${uv}`, finite(day.uv) ? String(Math.round(day.uv)) : '—'),
        element('span', 'risk-value', finite(day.rain) ? `${day.rain.toFixed(day.rain < 10 ? 1 : 0)} mm` : '—'));
      table.append(row);
    });
    body.append(table, element('p', 'health-note', 'Feels like combines temperature, humidity and wind. Heat caution from 35°, danger from 41°. UV 8+ very high, 11+ extreme.'));
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function show() { state.visible = true; load(false); }
  function hide() { state.visible = false; }
  document.addEventListener('atmos:place', () => { state.key = null; if (state.visible) load(true); });
  // Storm classification arrives with the main forecast; redraw alerts when it does.
  document.addEventListener('atmos:weather', () => { if (state.visible && state.data) render(); });
  document.addEventListener('atmos:unit', () => { if (state.visible && state.data) render(); });
  byId('healthRefresh')?.addEventListener('click', () => load(true));

  window.WapkHealth = Object.freeze({ show, hide });
})();
