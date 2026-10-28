(() => {
  'use strict';

  // Health section: alerts, air quality, PMD pollen, seasonal disease risks and heat/cold/UV for the chosen place.
  // Sources:
  //   • Air quality — Open-Meteo Air Quality (CAMS): US AQI and pollutants, 4-day forecast.
  //   • Pollen — PMD daily counts for Islamabad (R&D) and Lahore (Flood Forecasting Division), read by the PK worker.
  //   • Weather — Open-Meteo forecast with the past 14 days.
  //   • Thunderstorms and hail — the classification app.js already made (weather-logic.js).
  // There is no open feed of disease cases in Pakistan, so disease risks are weather-based estimates of how
  // favourable conditions are (mosquitoes, contaminated water, cold, heat, humidity, polluted air) — not case counts.
  const WORKER = 'https://lightning-weatherx-pk-api.mashhood-droid.workers.dev';
  const REFRESH_MS = 30 * 60 * 1000;
  const POLLEN_NEAR_KM = 150; // Pollen counts feed alerts and the asthma risk only this close to a PMD sampler.
  const POLLEN_FRESH_DAYS = 3; // ...and only while the latest count is this recent.
  const ALERT_DAYS = 3;
  const LEVELS = ['Low', 'Moderate', 'High', 'Very high'];
  const SHORT_LEVEL = { Low: 'Low', Moderate: 'Mod', High: 'High', 'Very high': 'V.high' };

  const byId = (id) => document.getElementById(id);
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const ui = (name) => window.AtmosIcons?.ui(name) || '';
  const levelClass = (level) => (level || 'low').toLowerCase().replace(' ', '-');
  const state = { key: null, loadedAt: 0, data: null, request: 0, visible: false, pollenStation: null, tab: savedTab() };
  function savedTab() { try { return localStorage.getItem('wapk.healthTab') || 'diseases'; } catch { return 'diseases'; } }

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
  function daysBetween(fromDate, toDate) { return Math.round((Date.parse(`${toDate}T00:00Z`) - Date.parse(`${fromDate}T00:00Z`)) / 86400000); }
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
    if (key !== state.key) state.pollenStation = null;
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

  // ── Daily inputs ──────────────────────────────────────────────────────────

  const AQI_LEVELS = [
    [50, 'Good', 'good', 'Air quality is fine for everyone.'],
    [100, 'Moderate', 'moderate', 'Unusually sensitive people should limit long or heavy exertion outdoors.'],
    [150, 'Unhealthy for sensitive groups', 'sensitive', 'Children, older adults and people with asthma or heart disease should reduce outdoor exertion.'],
    [200, 'Unhealthy', 'unhealthy', 'Everyone should reduce outdoor exertion; sensitive groups should avoid it. Consider a mask outdoors.'],
    [300, 'Very unhealthy', 'very-unhealthy', 'Avoid outdoor activity. Keep windows closed and use an air purifier if you have one.'],
    [Infinity, 'Hazardous', 'hazardous', 'Stay indoors. Everyone may have serious health effects.']
  ];
  const aqiLevel = (aqi) => AQI_LEVELS.find(([limit]) => aqi <= limit);

  function localToday(offsetSeconds) {
    return new Date(Date.now() + (offsetSeconds || 0) * 1000).toISOString().slice(0, 10);
  }

  // Highest (or lowest) hourly value per local date of an hourly series.
  function dailyExtreme(hourly, field, reduce = Math.max) {
    const out = new Map();
    (hourly?.time || []).forEach((time, index) => {
      const value = hourly[field]?.[index];
      if (!finite(value)) return;
      const date = time.slice(0, 10);
      out.set(date, out.has(date) ? reduce(out.get(date), value) : value);
    });
    return out;
  }

  // Today and the next six days, each with everything the risk rules need.
  function dailySeries() {
    const weather = state.data?.weather;
    const daily = weather?.daily;
    if (!daily?.time) return [];
    const today = localToday(weather.utc_offset_seconds);
    const start = Math.max(0, daily.time.indexOf(today));
    const rainSum = (from, to) => daily.precipitation_sum.slice(Math.max(0, from), to).reduce((sum, value) => sum + (finite(value) ? value : 0), 0);
    const aqiByDay = dailyExtreme(state.data.air?.hourly, 'us_aqi');
    const dustByDay = dailyExtreme(state.data.air?.hourly, 'dust');
    const visibilityByDay = dailyExtreme(weather.hourly, 'visibility', Math.min);
    const pollen = nearPollen();
    return daily.time.slice(start).map((date, offset) => {
      const index = start + offset;
      return {
        date, offset, month: Number(date.slice(5, 7)),
        max: daily.temperature_2m_max?.[index], min: daily.temperature_2m_min?.[index], mean: daily.temperature_2m_mean?.[index],
        feelsMax: daily.apparent_temperature_max?.[index], feelsMin: daily.apparent_temperature_min?.[index],
        humidity: daily.relative_humidity_2m_mean?.[index], rain: daily.precipitation_sum?.[index],
        rain3: rainSum(index - 2, index + 1), rain14: rainSum(index - 14, index),
        uv: daily.uv_index_max?.[index],
        aqi: aqiByDay.get(date) ?? null, dust: dustByDay.get(date) ?? null, visibility: visibilityByDay.get(date) ?? null,
        // A pollen count describes the day it was sampled; it is carried to today and tomorrow only.
        pollen: offset <= 1 ? pollen : null
      };
    });
  }

  // ── Pollen stations ───────────────────────────────────────────────────────

  const POLLEN_ORDER = { absent: 0, low: 1, moderate: 2, high: 3, 'very high': 4 };
  const pollenRank = (category) => POLLEN_ORDER[String(category || '').toLowerCase()] ?? 0;
  const pollenClass = (category) => ['absent', 'low', 'moderate', 'high', 'very-high'][pollenRank(category)];
  const POLLEN_WORDS = ['absent', 'low', 'moderate', 'high', 'very high'];

  // Stations with a report, nearest first. Older payloads have a single Islamabad report at the top level.
  function pollenStations() {
    const payload = state.data?.pollen;
    if (!payload) return [];
    const stations = payload.stations || (payload.latest ? [{ id: 'islamabad', name: 'Islamabad', ...payload.station, source: payload.source, sourceUrl: payload.sourceUrl, latest: payload.latest, history: payload.history }] : []);
    return stations.filter((station) => station.latest)
      .map((station) => ({ ...station, distance: distanceKm(state.data.city, station) }))
      .sort((a, b) => a.distance - b.distance);
  }

  // The nearest station's latest count if it is close and recent enough to describe local air.
  function nearPollen() {
    const station = pollenStations()[0];
    if (!station || station.distance > POLLEN_NEAR_KM) return null;
    const age = daysBetween(station.latest.date, localToday(state.data.weather?.utc_offset_seconds));
    if (age > POLLEN_FRESH_DAYS) return null;
    const top = station.latest.types.reduce((best, item) => Math.max(best, pollenRank(item.category)), 0);
    const names = station.latest.types.filter((item) => pollenRank(item.category) === top && top > 0).map((item) => item.type);
    return { station, top, names };
  }

  // ── Seasonal disease risks ────────────────────────────────────────────────
  //
  // Each disease scores a day from the weather and returns a level plus the factors behind it, so the card can show
  // exactly why. Thresholds are rules of thumb from public-health guidance for South Asia; they estimate how
  // favourable conditions are, not how many people are ill.

  const band = (points, cuts) => LEVELS[cuts.filter((cut) => points >= cut).length];
  const factor = (name, value, points, max, note) => ({ name, value, points, max, note });
  const tempText = (value) => (finite(value) ? `${degrees(value)} average` : '—');

  const DISEASES = [
    {
      id: 'dengue', name: 'Dengue', icon: 'mosquito', alert: true,
      about: 'Spread by Aedes mosquitoes that breed in clean standing water (tanks, coolers, pots, tyres) and bite at dawn and dusk.',
      symptoms: 'Sudden high fever, severe headache, pain behind the eyes, body and joint aches, rash. Warning signs: bleeding gums, vomiting, belly pain.',
      prevention: 'Empty or cover water containers, coolers and plant pots every week; use repellent and full sleeves at dawn and dusk; sleep under a net. Take only paracetamol for fever and see a doctor.',
      // Points 0–8: temperature (ideal 24–32 °C) 0–3, humidity 0–2, rain in the previous 14 days 0–2, season Aug–Nov +1.
      assess(day) {
        if (!finite(day.mean)) return null;
        const t = day.mean < 16 ? 0 : day.mean < 20 ? 1 : day.mean < 24 ? 2 : day.mean <= 32 ? 3 : day.mean <= 35 ? 2 : 1;
        const h = !finite(day.humidity) ? 0 : day.humidity >= 70 ? 2 : day.humidity >= 50 ? 1 : 0;
        const r = day.rain14 >= 25 ? 2 : day.rain14 >= 5 ? 1 : 0;
        const s = day.month >= 8 && day.month <= 11 ? 1 : 0;
        const points = t + h + r + s;
        return {
          level: day.mean < 16 ? 'Low' : band(points, [3, 5, 7]),
          factors: [
            factor('Temperature', tempText(day.mean), t, 3, t === 3 ? 'ideal for Aedes mosquitoes' : t === 0 ? 'too cold for mosquitoes' : 'mosquitoes less active'),
            factor('Humidity', finite(day.humidity) ? `${Math.round(day.humidity)}%` : '—', h, 2, h === 2 ? 'humid' : h ? 'moderate' : 'dry'),
            factor('Rain, last 14 days', `${Math.round(day.rain14)} mm`, r, 2, r === 2 ? 'plenty of breeding water' : r ? 'some standing water' : 'little rain (tanks and coolers still breed mosquitoes)'),
            factor('Season', s ? 'Dengue season' : 'Off season', s, 1, 'August–November peak in Pakistan')
          ]
        };
      }
    },
    {
      id: 'malaria', name: 'Malaria', icon: 'mosquito', alert: true,
      about: 'Spread by Anopheles mosquitoes that breed in rain pools, ponds, rice fields and irrigation water; they bite at night. Highest in Sindh, Balochistan and southern KP.',
      symptoms: 'Fever with shivering and sweating that comes and goes, headache, vomiting, body aches. It can become severe within a day.',
      prevention: 'Sleep under a treated bed net, use repellent in the evening, drain standing water near homes, and get a malaria test for any fever after heavy rain.',
      // Points 0–8: temperature (ideal 25–30 °C) 0–3, humidity 0–2, rain in the previous 14 days 0–2, season Jul–Nov +1.
      assess(day) {
        if (!finite(day.mean)) return null;
        const t = day.mean < 16 ? 0 : day.mean < 20 ? 1 : day.mean < 25 ? 2 : day.mean <= 30 ? 3 : day.mean <= 33 ? 2 : 1;
        const h = !finite(day.humidity) ? 0 : day.humidity >= 60 ? 2 : day.humidity >= 50 ? 1 : 0;
        const r = day.rain14 >= 40 ? 2 : day.rain14 >= 10 ? 1 : 0;
        const s = day.month >= 7 && day.month <= 11 ? 1 : 0;
        const points = t + h + r + s;
        // Anopheles needs rain pools, so without recent rain the risk stays at Moderate at most.
        const level = day.mean < 16 ? 'Low' : band(points, [3, 5, 7]);
        return {
          level: r === 0 && LEVELS.indexOf(level) > 1 ? 'Moderate' : level,
          factors: [
            factor('Temperature', tempText(day.mean), t, 3, t === 3 ? 'ideal for the malaria parasite' : t === 0 ? 'too cold' : 'slower parasite growth'),
            factor('Humidity', finite(day.humidity) ? `${Math.round(day.humidity)}%` : '—', h, 2, h === 2 ? 'mosquitoes live longer' : h ? 'moderate' : 'dry'),
            factor('Rain, last 14 days', `${Math.round(day.rain14)} mm`, r, 2, r === 2 ? 'rain pools for breeding' : r ? 'some pools' : 'little rain'),
            factor('Season', s ? 'Malaria season' : 'Off season', s, 1, 'July–November peak after the monsoon')
          ]
        };
      }
    },
    {
      id: 'waterborne', name: 'Diarrhoea, cholera & typhoid', icon: 'droplet', alert: true,
      about: 'Caused by germs in contaminated water and food. Heat makes germs multiply in food; heavy rain and flooding mix sewage into drinking water.',
      symptoms: 'Watery diarrhoea, vomiting, stomach cramps, fever (typhoid: fever rising over days, headache, weakness). Dehydration is the main danger, especially for children.',
      prevention: 'Drink boiled or treated water, eat freshly cooked food, wash hands with soap, avoid cut fruit and street drinks. Use ORS early for diarrhoea; get typhoid vaccination.',
      // Points 0–7: heat (daily max) 0–3, rain in the last 3 days 0–3, season May–Sep +1.
      assess(day) {
        if (!finite(day.max)) return null;
        const t = day.max < 25 ? 0 : day.max < 32 ? 1 : day.max < 38 ? 2 : 3;
        const r = day.rain3 >= 50 ? 3 : day.rain3 >= 20 ? 2 : day.rain3 >= 5 ? 1 : 0;
        const s = day.month >= 5 && day.month <= 9 ? 1 : 0;
        return {
          level: band(t + r + s, [2, 4, 6]),
          factors: [
            factor('Heat', `${degrees(day.max)} high`, t, 3, t >= 2 ? 'germs multiply fast in food and water' : t ? 'warm' : 'cool'),
            factor('Rain, last 3 days', `${Math.round(day.rain3)} mm`, r, 3, r === 3 ? 'flooding risk, sewage in water' : r === 2 ? 'heavy rain' : r ? 'some rain' : 'dry'),
            factor('Season', s ? 'Summer & monsoon' : 'Off season', s, 1, 'May–September peak')
          ]
        };
      }
    },
    {
      id: 'flu', name: 'Flu, colds & pneumonia', icon: 'thermometer', alert: true,
      about: 'Respiratory viruses spread most in cold weather when people crowd indoors; sharp day–night temperature swings and dry air weaken the nose and throat.',
      symptoms: 'Fever, cough, sore throat, runny nose, body aches. Pneumonia: fast or difficult breathing, chest pain — urgent for babies and the elderly.',
      prevention: 'Get the yearly flu vaccine, dress in layers for cold mornings, wash hands, cover coughs, keep rooms aired. Seek care quickly for breathing trouble.',
      // Points 0–6: cold (daily mean) 0–3, day–night swing ≥ 15 °C +1, dry air < 40 % +1, season Nov–Feb +1.
      assess(day) {
        if (!finite(day.mean)) return null;
        const t = day.mean >= 20 ? 0 : day.mean >= 15 ? 1 : day.mean >= 10 ? 2 : 3;
        const swing = finite(day.max) && finite(day.min) ? day.max - day.min : null;
        const w = finite(swing) && swing >= 15 ? 1 : 0;
        const d = finite(day.humidity) && day.humidity < 40 ? 1 : 0;
        const s = day.month >= 11 || day.month <= 2 ? 1 : 0;
        return {
          level: band(t + w + d + s, [2, 4, 6]),
          factors: [
            factor('Cold', tempText(day.mean), t, 3, t >= 2 ? 'cold — people crowd indoors' : t ? 'cool' : 'warm'),
            factor('Day–night swing', finite(swing) ? `${Math.round(swing)}°` : '—', w, 1, w ? 'large swing stresses the body' : 'small swing'),
            factor('Dry air', finite(day.humidity) ? `${Math.round(day.humidity)}%` : '—', d, 1, d ? 'dry air helps viruses spread' : 'not dry'),
            factor('Season', s ? 'Flu season' : 'Off season', s, 1, 'November–February peak')
          ]
        };
      }
    },
    {
      id: 'asthma', name: 'Asthma & breathing problems', icon: 'leaf', alert: false,
      about: 'Smog, dust, pollen and cold dry air irritate the airways and trigger asthma, bronchitis and COPD attacks.',
      symptoms: 'Wheezing, tight chest, cough, shortness of breath, itchy or burning eyes and throat.',
      prevention: 'Keep reliever inhalers with you, avoid outdoor exercise on bad-air days, wear an N95 mask in smog or dust, keep windows closed, and follow your asthma plan.',
      // Points 0–8: AQI 0–3, dust 0–2, pollen (nearby PMD count) 0–2, cold dry air +1.
      assess(day) {
        const a = !finite(day.aqi) ? 0 : day.aqi > 200 ? 3 : day.aqi > 150 ? 2 : day.aqi > 100 ? 1 : 0;
        const u = !finite(day.dust) ? 0 : day.dust >= 500 ? 2 : day.dust >= 200 ? 1 : 0;
        const p = !day.pollen ? 0 : day.pollen.top >= 4 ? 2 : day.pollen.top === 3 ? 1 : 0;
        const c = finite(day.min) && day.min <= 5 && finite(day.humidity) && day.humidity < 40 ? 1 : 0;
        if (!finite(day.aqi) && !finite(day.min)) return null;
        return {
          level: band(a + u + p + c, [2, 3, 5]),
          factors: [
            factor('Air quality', finite(day.aqi) ? `AQI ${Math.round(day.aqi)}` : 'no forecast', a, 3, a >= 2 ? 'unhealthy air' : a ? 'poor for sensitive people' : 'acceptable'),
            factor('Dust', finite(day.dust) ? `${Math.round(day.dust)} µg/m³` : 'no forecast', u, 2, u === 2 ? 'dust storm' : u ? 'dusty' : 'low'),
            factor('Pollen', day.pollen ? `${POLLEN_WORDS[day.pollen.top]} (${day.pollen.station.name})` : 'no nearby count', p, 2, day.pollen?.names.length ? day.pollen.names.join(', ') : 'PMD measures Islamabad and Lahore'),
            factor('Cold, dry air', finite(day.min) ? `${degrees(day.min)} low` : '—', c, 1, c ? 'cold dry air tightens airways' : 'no')
          ]
        };
      }
    },
    {
      id: 'heat', name: 'Heatstroke & dehydration', icon: 'sun', alert: false,
      about: 'When heat and humidity stop the body cooling itself. Most at risk: outdoor workers, the elderly, young children and people without cooling.',
      symptoms: 'Heavy sweating, dizziness, cramps, nausea (heat exhaustion). Heatstroke: hot dry skin, confusion, fainting — a medical emergency, call 1122.',
      prevention: 'Drink water often (before you feel thirsty), avoid the sun 11 AM–4 PM, wear light loose clothes, rest in shade, never leave anyone in a parked car.',
      // Feels-like maximum, NOAA heat-index bands: 35 caution, 41 danger, 54 extreme danger.
      assess(day) {
        if (!finite(day.feelsMax)) return null;
        const f = day.feelsMax;
        const points = f >= 54 ? 3 : f >= 41 ? 2 : f >= 35 ? 1 : 0;
        return {
          level: LEVELS[points],
          factors: [factor('Feels like', `${degrees(f)} high`, points, 3, points === 3 ? 'extreme danger' : points === 2 ? 'danger — heatstroke possible' : points ? 'caution' : 'comfortable')]
        };
      }
    },
    {
      id: 'eyeskin', name: 'Pink eye & skin infections', icon: 'eye', alert: true,
      about: 'Hot, humid monsoon weather spreads conjunctivitis (pink eye) and fungal and bacterial skin infections; flood water adds more germs.',
      symptoms: 'Red, itchy, watery or sticky eyes; itchy rashes, ringworm, boils, prickly heat.',
      prevention: 'Wash hands often, do not touch or rub eyes, do not share towels or eye drops, keep skin dry, wear loose cotton clothes, avoid wading in flood water.',
      // Hot and humid combined, raised one level after heavy rain.
      assess(day) {
        if (!finite(day.mean) || !finite(day.humidity)) return null;
        let points = day.mean >= 30 && day.humidity >= 80 ? 3 : day.mean >= 28 && day.humidity >= 70 ? 2 : day.mean >= 25 && day.humidity >= 60 ? 1 : 0;
        const wet = day.rain3 >= 20 && points >= 1 && points < 3 ? 1 : 0;
        points += wet;
        return {
          level: LEVELS[points],
          factors: [
            factor('Heat', tempText(day.mean), day.mean >= 30 ? 3 : day.mean >= 28 ? 2 : day.mean >= 25 ? 1 : 0, 3, day.mean >= 28 ? 'hot' : day.mean >= 25 ? 'warm' : 'not hot'),
            factor('Humidity', `${Math.round(day.humidity)}%`, day.humidity >= 70 ? 2 : day.humidity >= 60 ? 1 : 0, 2, day.humidity >= 70 ? 'very humid' : day.humidity >= 60 ? 'humid' : 'not humid'),
            factor('Rain, last 3 days', `${Math.round(day.rain3)} mm`, wet, 1, wet ? 'wet conditions spread germs' : 'no heavy rain')
          ]
        };
      }
    },
    {
      id: 'co', name: 'Carbon monoxide (gas heaters)', icon: 'snowflake', alert: true,
      about: 'Every winter in Pakistan people die from gas heaters and angeethis (charcoal stoves) burning in closed rooms. Carbon monoxide has no smell.',
      symptoms: 'Headache, dizziness, sleepiness, nausea, confusion — often several people in the same room at once.',
      prevention: 'Never sleep with a gas heater or angeethi burning; keep a window slightly open; switch heaters off before bed; fit a CO alarm if you can.',
      // Night low: ≤ 10 °C heaters start, ≤ 5 common, ≤ 0 widespread, ≤ −5 all night.
      assess(day) {
        if (!finite(day.min)) return null;
        const points = day.min <= -5 ? 3 : day.min <= 0 ? 2 : day.min <= 5 ? 1 : 0;
        return {
          level: LEVELS[points],
          factors: [factor('Night low', `${degrees(day.min)}`, points, 3, points >= 2 ? 'heaters used all night' : points ? 'heaters in use' : day.min <= 10 ? 'some heater use' : 'heaters not needed')]
        };
      }
    }
  ];

  function assessAll(days) {
    return DISEASES.map((disease) => ({ disease, days: days.slice(0, 7).map((day) => disease.assess(day)) }));
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  // Every alert for today and the next two days, most serious first; repeats across days become one card.
  function buildAlerts(days, risks) {
    const alerts = [];
    const add = (severity, icon, title, when, detail, advice) => alerts.push({ severity, icon, title, when, detail, advice });
    const rank = { severe: 3, high: 2, moderate: 1 };
    const storms = window.Atmos?.forecastDays || [];

    days.slice(0, ALERT_DAYS).forEach((day, index) => {
      const when = dayName(day.date, index);
      if (finite(day.feelsMax)) {
        if (day.feelsMax >= 54) add('severe', 'thermometer', 'Extreme heat danger', when, `Feels like ${degrees(day.feelsMax)}. Heatstroke is likely with exposure.`, 'Stay indoors in the hottest hours, drink water often, check on elderly people and children.');
        else if (day.feelsMax >= 41) add('high', 'thermometer', 'Heatstroke danger', when, `Feels like ${degrees(day.feelsMax)}. Heat exhaustion likely; heatstroke possible.`, 'Avoid the sun 11 AM–4 PM, drink plenty of water, wear light clothing.');
        else if (day.feelsMax >= 35) add('moderate', 'thermometer', 'Heat caution', when, `Feels like ${degrees(day.feelsMax)}. Heat exhaustion is possible with long exposure.`, 'Take breaks in the shade and keep drinking water.');
      }
      if (finite(day.feelsMin) && day.feelsMin <= -10) add('high', 'snowflake', 'Severe cold', when, `Feels like ${degrees(day.feelsMin)} at night. Risk of frostbite and hypothermia.`, 'Dress in layers, cover hands and face.');
      else if (finite(day.min) && day.min <= 0) add('moderate', 'snowflake', 'Freezing night', when, `Low of ${degrees(day.min)}. Frost and icy roads possible.`, 'Keep warm at night and take care on roads in the morning.');
      if (finite(day.uv) && day.uv >= 11) add('high', 'sun', 'Extreme UV', when, `UV index up to ${Math.round(day.uv)}. Unprotected skin burns in minutes.`, 'Avoid midday sun, wear a hat and sunglasses, use SPF 30+ sunscreen.');
      else if (finite(day.uv) && day.uv >= 8) add('moderate', 'sun', 'Very high UV', when, `UV index up to ${Math.round(day.uv)}.`, 'Seek shade at midday and protect skin and eyes.');
      if (finite(day.aqi) && day.aqi > 100) {
        const [, label, , advice] = aqiLevel(day.aqi);
        add(day.aqi > 300 ? 'severe' : day.aqi > 150 ? 'high' : 'moderate', 'leaf', `Air quality: ${label}`, when, `US AQI up to ${Math.round(day.aqi)}.`, advice);
      }
      if (finite(day.dust) && day.dust >= 500) add('high', 'wind', 'Dust storm conditions', when, `Dust up to ${Math.round(day.dust)} µg/m³.`, 'Stay indoors, keep windows shut, wear a mask outdoors. People with asthma should keep inhalers at hand.');
      else if (finite(day.dust) && day.dust >= 200) add('moderate', 'wind', 'Dusty air', when, `Dust up to ${Math.round(day.dust)} µg/m³.`, 'People with asthma or allergies should limit time outdoors.');
      if (finite(day.visibility) && day.visibility < 1000) {
        const smog = finite(day.aqi) && day.aqi > 150;
        add(smog ? 'high' : 'moderate', 'eye', smog ? 'Smog' : 'Fog', when, `Visibility down to about ${Math.round(day.visibility / 10) * 10} m${smog ? ` with US AQI ${Math.round(day.aqi)}` : ''}.`, smog ? 'Avoid outdoor exercise, wear a mask, drive slowly with low beams.' : 'Drive slowly with low beams and keep your distance.');
      }
      const storm = storms.find((item) => item.date === day.date);
      if (storm && storm.code >= 95) {
        add(storm.hail || storm.intensity === 'severe' ? 'high' : 'moderate', 'bolt', storm.hail ? 'Thunderstorms with possible hail' : 'Thunderstorms', when, `${storm.condition}${storm.intensity ? ` · ${storm.intensity} storm energy` : ''}.`, 'Stay indoors during storms, avoid open ground, trees and poles. Lightning can strike 15 km from a storm.');
      }
      // Disease risks at High or Very high (heat and breathing are already covered by the alerts above).
      risks.forEach(({ disease, days: levels }) => {
        const result = levels[index];
        if (!disease.alert || !result || (result.level !== 'High' && result.level !== 'Very high')) return;
        add(result.level === 'Very high' ? 'high' : 'moderate', disease.icon, `${disease.name}: ${result.level.toLowerCase()} risk`, when, disease.about, disease.prevention);
      });
    });

    const pollen = nearPollen();
    if (pollen && pollen.top >= 3) {
      const word = pollen.top === 4 ? 'very high' : 'high';
      add(pollen.top === 4 ? 'high' : 'moderate', 'flower', `Pollen ${word}`, `PMD ${pollen.station.name}, ${pollen.station.latest.label}`, `${pollen.names.join(', ')} pollen ${word} in ${pollen.station.name}.`, 'Allergy sufferers: keep windows closed, wear a mask and sunglasses outdoors, shower after coming in.');
    }

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
  //
  // Compact layout: a summary strip of four tiles (each opens its tab), a tabbed detail panel (Diseases · Air ·
  // Pollen · Week) and a one-line-per-alert list beside it. Details (advice, factors, symptoms) open on tap.

  const TABS = ['diseases', 'air', 'pollen', 'week'];
  const TAB_KEY = 'wapk.healthTab';
  const ALERTS_SHOWN = 4;

  function render() {
    if (!state.data) return;
    const days = dailySeries();
    const risks = assessAll(days);
    renderSummary(days, risks);
    renderAlerts(buildAlerts(days, risks));
    renderAir();
    renderPollen();
    renderDiseases(days, risks);
    renderWeatherRisks(days);
    selectTab(state.tab, false);
    const updated = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(state.loadedAt));
    byId('healthUpdated').textContent = `Updated ${updated}`;
  }

  function selectTab(tab, focus) {
    state.tab = TABS.includes(tab) ? tab : 'diseases';
    try { localStorage.setItem(TAB_KEY, state.tab); } catch { /* the choice still applies for this visit */ }
    document.querySelectorAll('[data-health-tab]').forEach((button) => {
      const active = button.dataset.healthTab === state.tab;
      if (button.getAttribute('role') !== 'tab') { button.classList.toggle('is-active', active); return; }
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    });
    TABS.forEach((name) => { byId(`healthPanel-${name}`).hidden = name !== state.tab; });
  }

  // Four tiles: air quality, pollen, the highest disease risk, and heat & UV — today at a glance.
  function renderSummary(days, risks) {
    const strip = byId('healthSummary');
    strip.replaceChildren();
    const tile = (tab, tone, label, value, sub, icon) => {
      const button = element('button', `health-tile is-${tone}`);
      button.type = 'button';
      button.dataset.healthTab = tab;
      const art = element('span', 'health-tile-icon');
      art.innerHTML = ui(icon);
      const text = element('span', 'health-tile-text');
      text.append(element('span', 'health-tile-label', label), element('strong', 'health-tile-value', value), element('span', 'health-tile-sub', sub));
      button.append(art, text);
      button.addEventListener('click', () => {
        selectTab(tab, false);
        byId('healthPanel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      strip.append(button);
    };

    const aqi = state.data.air?.current?.us_aqi;
    if (finite(aqi)) {
      const [, label, key] = aqiLevel(aqi);
      tile('air', `aqi-${key}`, 'Air quality', `AQI ${Math.round(aqi)}`, label, 'leaf');
    } else tile('air', 'none', 'Air quality', '—', 'Unavailable', 'leaf');

    const station = pollenStations()[0];
    if (station) {
      const top = station.latest.types.reduce((best, item) => Math.max(best, pollenRank(item.category)), 0);
      const age = daysBetween(station.latest.date, localToday(state.data.weather?.utc_offset_seconds));
      const word = POLLEN_WORDS[top];
      tile('pollen', `pollen-${pollenClass(word)}`, `Pollen · ${station.name}`, word.charAt(0).toUpperCase() + word.slice(1),
        age > POLLEN_FRESH_DAYS ? `Last count ${shortDate(station.latest.date)}` : station.distance > POLLEN_NEAR_KM ? `${Math.round(station.distance)} km away` : 'PMD count', 'flower');
    } else tile('pollen', 'none', 'Pollen', '—', 'Unavailable', 'flower');

    const ranked = risks.filter((entry) => entry.days[0]).sort((a, b) => LEVELS.indexOf(b.days[0].level) - LEVELS.indexOf(a.days[0].level));
    const worst = ranked[0];
    if (worst && worst.days[0].level !== 'Low') {
      const more = ranked.filter((entry) => entry.days[0].level !== 'Low').length - 1;
      tile('diseases', `risk-${levelClass(worst.days[0].level)}`, 'Top disease risk', worst.disease.name, `${worst.days[0].level}${more > 0 ? ` · +${more} more` : ''}`, worst.disease.icon);
    } else tile('diseases', 'risk-low', 'Disease risks', 'All low', 'Seasonal illnesses', 'heart');

    const today = days[0];
    if (today) {
      const tone = today.feelsMax >= 41 || today.uv >= 11 ? 'risk-high' : today.feelsMax >= 35 || today.uv >= 8 ? 'risk-moderate' : today.min <= 0 ? 'cold' : 'risk-low';
      tile('week', tone, 'Heat & UV today', `${degrees(today.feelsMax)} feels like`, `UV ${finite(today.uv) ? Math.round(today.uv) : '—'} · low ${degrees(today.min)}`, 'thermometer');
    }
  }

  function shortDate(date) {
    return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00Z`));
  }

  // One line per alert; tapping shows the details and advice. The first few are listed, the rest behind a button.
  function renderAlerts(alerts) {
    const list = byId('healthAlerts');
    list.replaceChildren();
    const count = byId('healthAlertCount');
    count.textContent = alerts.length ? String(alerts.length) : 'All clear';
    count.className = `health-count ${alerts.length ? `is-${alerts[0].severity}` : 'is-clear'}`;
    if (!alerts.length) {
      list.append(element('p', 'health-clear', 'No health alerts for the next three days.'));
      return;
    }
    const items = alerts.map((alert) => {
      const item = element('details', `health-alert is-${alert.severity}`);
      const summary = element('summary');
      const art = element('span', 'health-alert-icon');
      art.innerHTML = ui(alert.icon);
      const text = element('span', 'health-alert-text');
      text.append(element('strong', '', alert.title), element('span', 'health-when', alert.when));
      summary.append(art, text);
      const body = element('div', 'health-alert-body');
      body.append(element('p', '', alert.detail), element('p', 'health-advice', alert.advice));
      item.append(summary, body);
      return item;
    });
    items.forEach((item, index) => { item.hidden = index >= ALERTS_SHOWN; list.append(item); });
    if (items.length > ALERTS_SHOWN) {
      const more = element('button', 'health-more', `Show ${items.length - ALERTS_SHOWN} more`);
      more.type = 'button';
      more.addEventListener('click', () => { items.forEach((item) => { item.hidden = false; }); more.remove(); });
      list.append(more);
    }
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
      const cell = element('div', 'aqi-pollutant');
      cell.append(element('span', '', name), element('strong', '', finite(value) ? String(Math.round(value)) : '—'));
      pollutants.append(cell);
    });
    const outlook = element('div', 'aqi-outlook');
    [...dailyExtreme(air.hourly, 'us_aqi')].slice(0, 4).forEach(([date, value], index) => {
      const [, dayLabel, dayKey] = aqiLevel(value);
      const chip = element('span', `aqi-chip is-${dayKey}`);
      chip.title = `${dayLabel}, highest ${Math.round(value)}`;
      chip.append(element('span', '', shortDay(date, index)), element('strong', '', String(Math.round(value))));
      outlook.append(chip);
    });
    body.append(head, element('p', 'health-subhead', 'Pollutants now · µg/m³'), pollutants, element('p', 'health-subhead', 'Highest AQI each day'), outlook);
  }

  function renderPollen() {
    const body = byId('healthPollen');
    body.replaceChildren();
    const stations = pollenStations();
    if (!stations.length) { body.append(element('p', 'empty-state', 'PMD pollen data is temporarily unavailable.')); return; }
    const station = stations.find((item) => item.id === state.pollenStation) || stations[0];
    const latest = station.latest;
    const age = daysBetween(latest.date, localToday(state.data.weather?.utc_offset_seconds));
    const top = latest.types.reduce((best, item) => (pollenRank(item.category) > pollenRank(best) ? item.category : best), 'Absent');

    const bar = element('div', 'pollen-bar');
    const tabs = element('div', 'pollen-tabs');
    tabs.setAttribute('role', 'group');
    tabs.setAttribute('aria-label', 'Pollen station');
    stations.forEach((item) => {
      const button = element('button', 'pollen-tab', item.name);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(item.id === station.id));
      button.addEventListener('click', () => { state.pollenStation = item.id; renderPollen(); });
      tabs.append(button);
    });
    bar.append(tabs, element('span', `pollen-chip is-${pollenClass(top)}`, `Overall ${top.toLowerCase()}`));
    body.append(bar, element('p', 'health-when pollen-date', latest.label));
    const notes = [];
    if (age > POLLEN_FRESH_DAYS) notes.push(element('p', 'health-note is-warning', `No newer ${station.name} count for ${age} days${station.id === 'lahore' ? ' — Lahore is counted during the pollen season.' : '.'}`));
    if (station.distance > POLLEN_NEAR_KM) notes.push(element('p', 'health-note', `${Math.round(station.distance)} km from ${state.data.city.name}; local levels may differ.`));
    body.append(...notes);

    const sites = latest.sites.filter((site) => latest.types.some((item) => finite(item.counts[site])));
    const present = latest.types.filter((item) => pollenRank(item.category) > 0).sort((a, b) => pollenRank(b.category) - pollenRank(a.category) || maxCount(b) - maxCount(a));
    const absent = latest.types.filter((item) => pollenRank(item.category) === 0).map((item) => item.type);
    const list = element('div', 'pollen-list');
    present.forEach((item) => {
      const row = element('div', 'pollen-row');
      const threshold = latest.thresholds?.[item.type];
      if (threshold) row.title = `${item.type}: low from ${threshold.low}, moderate from ${threshold.moderate}, high from ${threshold.high} grains/m³`;
      row.append(element('span', 'pollen-name', item.type), element('span', `pollen-chip is-${pollenClass(item.category)}`, item.category),
        element('span', 'pollen-count', sites.map((site) => (finite(item.counts[site]) ? formatCount(item.counts[site]) : '—')).join(' / ')), pollenTrend(station, item.type));
      list.append(row);
    });
    if (!present.length) list.append(element('p', 'health-clear', 'No pollen detected in the latest count.'));
    body.append(list);
    if (absent.length) body.append(element('p', 'health-note', `Not detected: ${absent.join(', ')}.`));
    if (latest.notes) body.append(element('p', 'health-note', `PMD: ${latest.notes}`));
    const where = station.id === 'islamabad'
      ? `Islamabad sampler${sites.length === 1 ? ` (sector ${sites[0]})` : 's'}`
      : `${station.name} sampler (Flood Forecasting Division)`;
    const source = element('p', 'health-note');
    source.append(`Grains/m³ over 24 h at PMD's ${where}; levels are PMD's. `);
    const link = element('a', '', 'Source');
    link.href = station.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    source.append(link);
    body.append(source);
  }

  function formatCount(value) { return Number.isInteger(value) ? String(value) : value.toFixed(1); }

  function maxCount(item) {
    const values = Object.values(item.counts || {}).filter(finite);
    return values.length ? Math.max(...values) : 0;
  }

  // Tiny bar trend of the last 14 reports for one pollen type.
  function pollenTrend(station, type) {
    const history = (station.history || []).slice(-14);
    const wrap = element('span', 'pollen-trend');
    if (history.length < 2) { wrap.title = 'The trend appears once PMD has published a second day.'; return wrap; }
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

  // Risks at Moderate or above are listed; low ones sit behind a button. Each row opens for the reasons.
  function renderDiseases(days, risks) {
    const body = byId('healthDiseases');
    body.replaceChildren();
    if (!days.length) { body.append(element('p', 'empty-state', 'Weather data is temporarily unavailable.')); return; }
    const rank = (entry) => LEVELS.indexOf(entry.days[0]?.level ?? 'Low');
    const sorted = [...risks].sort((a, b) => rank(b) - rank(a));
    const header = element('div', 'disease-row disease-row-head');
    const dayLabels = element('span', 'disease-week');
    days.slice(0, 7).forEach((day, index) => dayLabels.append(element('span', '', index === 0 ? 'Now' : shortDay(day.date, index).slice(0, 2))));
    header.append(element('span', '', 'Illness'), element('span', '', 'Today'), dayLabels);
    // Phones hide the header row, so the dots get a one-line caption instead.
    body.append(header, element('p', 'disease-caption', 'Dots: today, then the next 6 days'));
    const rows = sorted.map(({ disease, days: levels }) => {
      const today = levels[0];
      const item = element('details', 'disease');
      const summary = element('summary', 'disease-row');
      const name = element('span', 'disease-name');
      const art = element('span', 'disease-icon');
      art.innerHTML = ui(disease.icon);
      name.append(art, element('span', '', disease.name));
      const week = element('span', 'disease-week');
      levels.forEach((result, index) => {
        const dot = element('i', `risk-dot is-${levelClass(result?.level)}`);
        dot.title = `${index === 0 ? 'Today' : shortDay(days[index].date, index)}: ${result ? `${result.level} risk` : 'unavailable'}`;
        week.append(dot);
      });
      summary.append(name, element('span', `risk-chip is-${levelClass(today?.level)}`, today?.level || '—'), week);
      const detail = element('div', 'disease-detail');
      detail.append(element('p', 'disease-about', disease.about));
      if (today?.factors?.length) {
        const factors = element('ul', 'factor-list');
        today.factors.forEach((f) => {
          const li = element('li');
          const meter = element('span', 'factor-meter');
          const fill = element('i');
          fill.style.width = `${f.max ? (f.points / f.max) * 100 : 0}%`;
          meter.append(fill);
          li.append(element('span', 'factor-name', f.name), element('strong', '', f.value), meter, element('small', '', f.note));
          factors.append(li);
        });
        detail.append(factors);
      }
      const info = element('div', 'disease-info');
      const block = (title, text) => { const div = element('div'); div.append(element('p', 'health-subhead', title), element('p', '', text)); return div; };
      info.append(block('Symptoms', disease.symptoms), block('Prevention', disease.prevention));
      detail.append(info);
      item.append(summary, detail);
      return { item, low: (today?.level ?? 'Low') === 'Low' };
    });
    const elevated = rows.filter((row) => !row.low);
    if (!elevated.length) body.append(element('p', 'health-clear', 'All seasonal illness risks are low today.'));
    rows.forEach((row) => { row.item.hidden = row.low && elevated.length > 0; body.append(row.item); });
    const lows = rows.filter((row) => row.low);
    if (elevated.length && lows.length) {
      const more = element('button', 'health-more', `Show ${lows.length} low-risk illness${lows.length === 1 ? '' : 'es'}`);
      more.type = 'button';
      more.addEventListener('click', () => { lows.forEach((row) => { row.item.hidden = false; }); more.remove(); });
      body.append(more);
    }
    body.append(element('p', 'health-note', 'Weather-based estimates of how favourable conditions are — not case counts. Tap an illness for the reasons, symptoms and prevention.'));
  }

  // The week across: one column per day.
  function renderWeatherRisks(days) {
    const body = byId('healthWeather');
    body.replaceChildren();
    if (!days.length) { body.append(element('p', 'empty-state', 'Weather data is temporarily unavailable.')); return; }
    const grid = element('div', 'week-grid');
    const labels = element('div', 'week-col week-labels-col');
    ['', 'Feels like high', 'Feels like low', 'UV max', 'Rain'].forEach((label) => labels.append(element('span', '', label)));
    grid.append(labels);
    days.slice(0, 7).forEach((day, index) => {
      const col = element('div', `week-col${index === 0 ? ' is-today' : ''}`);
      const heat = !finite(day.feelsMax) ? '' : day.feelsMax >= 41 ? 'is-high' : day.feelsMax >= 35 ? 'is-moderate' : '';
      const cold = finite(day.feelsMin) && (day.feelsMin <= -10 || day.min <= 0) ? 'is-cold' : '';
      const uv = !finite(day.uv) ? '' : day.uv >= 11 ? 'is-high' : day.uv >= 8 ? 'is-moderate' : '';
      col.append(element('strong', 'week-day', shortDay(day.date, index)),
        element('span', `risk-value ${heat}`, degrees(day.feelsMax)),
        element('span', `risk-value ${cold}`, degrees(day.feelsMin)),
        element('span', `risk-value ${uv}`, finite(day.uv) ? String(Math.round(day.uv)) : '—'),
        element('span', 'risk-value', finite(day.rain) ? `${day.rain.toFixed(day.rain < 10 ? 1 : 0)}` : '—'));
      grid.append(col);
    });
    body.append(grid, element('p', 'health-note', 'Rain in mm. Feels like combines temperature, humidity and wind: caution from 35°, danger from 41°. UV 8+ very high, 11+ extreme.'));
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function show() { state.visible = true; load(false); }
  function hide() { state.visible = false; }
  document.addEventListener('atmos:place', () => { state.key = null; if (state.visible) load(true); });
  // Storm classification arrives with the main forecast; redraw alerts when it does.
  document.addEventListener('atmos:weather', () => { if (state.visible && state.data) render(); });
  document.addEventListener('atmos:unit', () => { if (state.visible && state.data) render(); });
  byId('healthRefresh')?.addEventListener('click', () => load(true));
  // Tab bar: click, and arrow keys between tabs.
  document.querySelectorAll('.health-tabs [data-health-tab]').forEach((button, index, all) => {
    button.addEventListener('click', () => selectTab(button.dataset.healthTab, false));
    button.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      selectTab(all[(index + step + all.length) % all.length].dataset.healthTab, true);
    });
  });

  window.WapkHealth = Object.freeze({ show, hide });
})();
