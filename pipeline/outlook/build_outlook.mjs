// WAPK 7-day outlook: the forecast for about 40 places across Pakistan, classified with the site's own rules
// (weather-logic.js: storms, hail, fog, snow below 0.5 °C, sleet 0.5–3 °C, rain above 3 °C), the snowline and
// the daily numbers, then written up in English and Urdu by Claude. The numbers in the tables come from the
// data, never from the model; the model only writes the text, from the same numbers.
//
//   node build_outlook.mjs <out-dir> [--no-ai]
//
// Writes <out-dir>/outlook.json. Needs ANTHROPIC_API_KEY for the written text; without it (or with --no-ai)
// the file has the tables only and the site shows them without the text.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || ".";
const useAi = !process.argv.includes("--no-ai") && Boolean(process.env.ANTHROPIC_API_KEY);
const MODEL = "claude-opus-5-5";
const TIMEZONE = "Asia/Karachi";
const DAYS = 7;

// Snow below 0.5 °C, sleet 0.5–3 °C (the map's and overview's rule); temperature falls about 6.5 °C per km.
const SNOW_BELOW = 0.5;
const SLEET_BELOW = 3;
const LAPSE_PER_M = 6.5 / 1000;

const REGIONS = [
  { id: "gb", en: "Gilgit-Baltistan", ur: "گلگت بلتستان" },
  { id: "kp_north", en: "Upper Khyber Pakhtunkhwa (Chitral, Swat, Dir)", ur: "بالائی خیبر پختونخوا (چترال، سوات، دیر)" },
  { id: "hazara_ajk", en: "Hazara, Kaghan and Azad Kashmir", ur: "ہزارہ، کاغان اور آزاد کشمیر" },
  { id: "galiyat", en: "Murree and Galiyat", ur: "مری اور گلیات" },
  { id: "potohar", en: "Islamabad, Rawalpindi and Potohar", ur: "اسلام آباد، راولپنڈی اور پوٹھوہار" },
  { id: "kp_south", en: "Peshawar, Kohat, Bannu and DI Khan", ur: "پشاور، کوہاٹ، بنوں اور ڈی آئی خان" },
  { id: "punjab", en: "Punjab plains", ur: "پنجاب کے میدانی علاقے" },
  { id: "sindh", en: "Sindh", ur: "سندھ" },
  { id: "balochistan", en: "Balochistan", ur: "بلوچستان" },
];

// [name, Urdu name, latitude, longitude, region]
const PLACES = [
  ["Gilgit", "گلگت", 35.92, 74.31, "gb"], ["Skardu", "سکردو", 35.3, 75.63, "gb"], ["Hunza", "ہنزہ", 36.32, 74.66, "gb"], ["Astore", "استور", 35.37, 74.86, "gb"],
  ["Chitral", "چترال", 35.85, 71.79, "kp_north"], ["Dir", "دیر", 35.2, 71.88, "kp_north"], ["Kalam", "کالام", 35.49, 72.58, "kp_north"], ["Malam Jabba", "مالم جبہ", 34.8, 72.57, "kp_north"], ["Saidu Sharif", "سیدو شریف", 34.75, 72.36, "kp_north"],
  ["Naran", "ناران", 34.91, 73.65, "hazara_ajk"], ["Balakot", "بالاکوٹ", 34.55, 73.35, "hazara_ajk"], ["Muzaffarabad", "مظفرآباد", 34.37, 73.47, "hazara_ajk"], ["Neelum (Kel)", "نیلم (کیل)", 34.83, 74.35, "hazara_ajk"], ["Rawalakot", "راولاکوٹ", 33.86, 73.76, "hazara_ajk"],
  ["Murree", "مری", 33.91, 73.39, "galiyat"], ["Nathia Gali", "نتھیا گلی", 34.07, 73.38, "galiyat"],
  ["Islamabad", "اسلام آباد", 33.68, 73.05, "potohar"], ["Rawalpindi", "راولپنڈی", 33.6, 73.07, "potohar"], ["Jhelum", "جہلم", 32.94, 73.73, "potohar"], ["Chakwal", "چکوال", 32.93, 72.86, "potohar"],
  ["Peshawar", "پشاور", 34.01, 71.58, "kp_south"], ["Kohat", "کوہاٹ", 33.58, 71.44, "kp_south"], ["Bannu", "بنوں", 32.99, 70.6, "kp_south"], ["DI Khan", "ڈی آئی خان", 31.83, 70.9, "kp_south"],
  ["Sialkot", "سیالکوٹ", 32.49, 74.53, "punjab"], ["Lahore", "لاہور", 31.55, 74.34, "punjab"], ["Sargodha", "سرگودھا", 32.08, 72.67, "punjab"], ["Faisalabad", "فیصل آباد", 31.42, 73.08, "punjab"], ["Multan", "ملتان", 30.2, 71.47, "punjab"], ["DG Khan", "ڈی جی خان", 30.05, 70.63, "punjab"], ["Bahawalpur", "بہاولپور", 29.4, 71.68, "punjab"],
  ["Sukkur", "سکھر", 27.7, 68.86, "sindh"], ["Larkana", "لاڑکانہ", 27.56, 68.21, "sindh"], ["Nawabshah", "نوابشاہ", 26.24, 68.41, "sindh"], ["Hyderabad", "حیدرآباد", 25.4, 68.37, "sindh"], ["Karachi", "کراچی", 24.86, 67.01, "sindh"],
  ["Quetta", "کوئٹہ", 30.18, 66.98, "balochistan"], ["Ziarat", "زیارت", 30.38, 67.73, "balochistan"], ["Zhob", "ژوب", 31.34, 69.45, "balochistan"], ["Kalat", "قلات", 29.03, 66.59, "balochistan"], ["Sibi", "سبی", 29.54, 67.88, "balochistan"], ["Khuzdar", "خضدار", 27.8, 66.61, "balochistan"], ["Turbat", "تربت", 26.0, 63.04, "balochistan"], ["Gwadar", "گوادر", 25.12, 62.32, "balochistan"],
].map(([name, ur, lat, lon, region]) => ({ name, ur, lat, lon, region }));

// The site's weather rules, loaded as the browser loads them.
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(here, "../../weather-logic.js"), "utf8"), sandbox);
const logic = sandbox.window.WapkWeatherLogic;
const NAMES = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 44: "Mist", 45: "Fog", 46: "Dense fog", 47: "Very dense fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Heavy freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Heavy freezing rain", 68: "Sleet", 69: "Heavy sleet", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Light showers", 81: "Rain showers", 82: "Heavy showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Isolated thunderstorm", 96: "Scattered thunderstorms", 97: "Thunderstorms", 99: "Heavy thunderstorms",
};

async function getJson(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "WAPK-Weather-Alert-PK/1.0 (+https://wapk.pages.dev)" }, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    }
  }
}

// The same two Open-Meteo requests as the site's overview (app.js fetchForecast), for every place at once.
async function fetchForecasts() {
  const place = { latitude: PLACES.map((p) => p.lat).join(","), longitude: PLACES.map((p) => p.lon).join(","), timezone: TIMEZONE, forecast_days: String(DAYS) };
  const main = new URLSearchParams({
    ...place, models: "ecmwf_ifs",
    current: "temperature_2m,weather_code",
    hourly: "temperature_2m,precipitation,weather_code,cloud_cover,cape,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day",
    daily: "temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset,precipitation_sum,wind_speed_10m_max",
  });
  const aux = new URLSearchParams({
    ...place,
    hourly: "precipitation_probability,visibility,uv_index,freezing_level_height,temperature_500hPa,lifted_index,wind_speed_500hPa",
    daily: "uv_index_max,precipitation_probability_max",
  });
  const [payloads, extras] = await Promise.all([getJson(`https://api.open-meteo.com/v1/forecast?${main}`), getJson(`https://api.open-meteo.com/v1/forecast?${aux}`)]);
  return payloads.map((payload, index) => {
    for (const key of ["hourly", "daily"]) {
      const extra = extras[index]?.[key];
      if (!extra) continue;
      const position = new Map(extra.time.map((time, i) => [time, i]));
      for (const [field, values] of Object.entries(extra)) {
        if (field !== "time") payload[key][field] = payload[key].time.map((time) => (position.has(time) ? values[position.get(time)] : null));
      }
    }
    return payload;
  });
}

const round = (value, digits = 0) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
const PARTS = [["night", 0, 6], ["morning", 6, 12], ["afternoon", 12, 18], ["evening", 18, 24]];

// One place's days: the site's headline, min/max, rain, snow and sleet by the temperature rule, gusts, storms
// and hail, and which parts of the day are wet.
function summarise(place, payload) {
  const wapk = logic.classifyForecast(payload, 0);
  const { hourly, daily } = payload;
  return daily.time.slice(0, DAYS).map((date, dayIndex) => {
    const day = wapk.days[dayIndex] || {};
    let rain = 0, sleet = 0, snow = 0, gust = 0, stormHours = 0;
    const wetParts = new Set();
    hourly.time.forEach((time, i) => {
      if (time.slice(0, 10) !== date) return;
      const mm = hourly.precipitation[i] || 0;
      const temp = hourly.temperature_2m[i];
      gust = Math.max(gust, hourly.wind_gusts_10m[i] || 0);
      const code = wapk.hours[i]?.code;
      if (code >= 95) stormHours += 1;
      if (mm < 0.1) return;
      if (temp < SNOW_BELOW) snow += mm; else if (temp <= SLEET_BELOW) sleet += mm; else rain += mm;
      const hour = Number(time.slice(11, 13));
      if (mm >= 0.3) wetParts.add(PARTS.find(([, from, to]) => hour >= from && hour < to)[0]);
    });
    return {
      date,
      weather: NAMES[day.code] || "—",
      code: day.code ?? null,
      hail: Boolean(day.hail),
      max: round(daily.temperature_2m_max[dayIndex]),
      min: round(daily.temperature_2m_min[dayIndex]),
      rainMm: round(rain, 1),
      sleetMm: round(sleet, 1),
      // About 1 cm of fresh snow per mm of water.
      snowCm: round(snow, 1),
      gustKmh: round(gust),
      stormHours,
      wet: PARTS.map(([part]) => part).filter((part) => wetParts.has(part)),
    };
  });
}

// The snowline each day: from every high place's wet hours, the height where the air would be 0.5 °C
// (temperature there + lapse rate). The lower quarter of those estimates is the snowline; the lowest is shown
// too. Days without precipitation on the high ground have none.
function snowlines(payloads) {
  const byDate = new Map();
  PLACES.forEach((place, index) => {
    const payload = payloads[index];
    const elevation = payload.elevation;
    if (!(elevation >= 1200)) return;
    payload.hourly.time.forEach((time, i) => {
      const mm = payload.hourly.precipitation[i] || 0;
      const temp = payload.hourly.temperature_2m[i];
      if (mm < 0.2 || !Number.isFinite(temp)) return;
      const level = elevation + (temp - SNOW_BELOW) / LAPSE_PER_M;
      const date = time.slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({ level, place: place.name });
    });
  });
  return [...byDate.keys()].sort().slice(0, DAYS).map((date) => {
    const levels = byDate.get(date).map((entry) => entry.level).sort((a, b) => a - b);
    // A few wet hours at one place are not enough to place a snowline.
    if (levels.length < 6) return { date, metres: null, lowestMetres: null, lowestAt: null, samples: levels.length };
    const quarter = levels[Math.floor(levels.length * 0.25)];
    const lowest = byDate.get(date).reduce((a, b) => (b.level < a.level ? b : a));
    return { date, metres: Math.round(quarter / 100) * 100, lowestMetres: Math.round(lowest.level / 100) * 100, lowestAt: lowest.place, samples: levels.length };
  });
}

// ── The written outlook (Claude) ────────────────────────────────────────────
const TEXT = { type: "object", properties: { en: { type: "string" }, ur: { type: "string" } }, required: ["en", "ur"], additionalProperties: false };
const OUTLOOK_SCHEMA = {
  type: "object",
  properties: {
    headline: TEXT,
    overview: TEXT,
    days: {
      type: "array",
      items: { type: "object", properties: { date: { type: "string" }, title: TEXT, text: TEXT }, required: ["date", "title", "text"], additionalProperties: false },
    },
    regions: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string", enum: REGIONS.map((region) => region.id) }, text: TEXT }, required: ["id", "text"], additionalProperties: false },
    },
    snow: TEXT,
    advisories: { type: "array", items: TEXT },
  },
  required: ["headline", "overview", "days", "regions", "snow", "advisories"],
  additionalProperties: false,
};

const SYSTEM = `You are the duty forecaster for WAPK (Weather Alert PK), writing the public 7-day weather outlook for Pakistan.

You receive the forecast as data: for each place and day, the headline weather from WAPK's own rules, min/max temperature (°C), rain, sleet and snow amounts, the strongest gust, hours of thunderstorm, a hail flag and which parts of the day are wet; plus the daily snowline. Write only what the data supports. Never invent numbers, places or events, and quote figures as they are given (round sensibly, e.g. "about 20 mm", "10–12 °C").

WAPK's rules, which the data already follows: snow falls below 0.5 °C, sleet (rain and snow mixed) between 0.5 and 3 °C, rain above 3 °C. A thunderstorm appears only where WAPK's storm rule fires (stormHours > 0 or a thunderstorm headline); do not add thunderstorms the data does not show. Hail is possible only where the hail flag is true.

Style: clear, calm and practical, for the general public and travellers. Use local time words (night, morning, afternoon, evening) and weekday names. Mention mountain passes, hill stations and road conditions where snow or heavy rain makes them relevant. Keep each day to 2–4 sentences, each region to 2–4 sentences. If a period is dry and settled, say so briefly.

Write every text twice: "en" in English and "ur" in natural, fluent Urdu (Urdu script, not Roman Urdu), with the same content. Use the Urdu place names given in the data.

Return days in date order (one per date in the data), one entry per region id, the snowline summary in "snow" (where and when the snowline drops, how low, which places may get snow or sleet and how much), and 0–5 short advisories (only for real hazards: heavy rain, storms, hail, snow on roads and passes, fog, frost, strong winds, heat).`;

async function writeOutlook(data) {
  const client = new Anthropic();
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: OUTLOOK_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: `Forecast data (JSON):\n${JSON.stringify(data)}\n\nWrite the 7-day outlook.` }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error(`the model declined (${message.stop_details?.category ?? "no category"})`);
  if (message.stop_reason === "max_tokens") throw new Error("the outlook was cut off at max_tokens");
  const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  return { outlook: JSON.parse(text), model: message.model, usage: message.usage };
}

// ── Main ────────────────────────────────────────────────────────────────────
const payloads = await fetchForecasts();
const places = PLACES.map((place, index) => ({ ...place, elevation: round(payloads[index].elevation), days: summarise(place, payloads[index]) }));
const snowline = snowlines(payloads);
const result = {
  generatedAt: new Date().toISOString(),
  source: "ECMWF IFS (Open-Meteo), classified with WAPK's weather rules",
  timezone: TIMEZONE,
  regions: REGIONS,
  places,
  snowline,
  text: null,
};

if (useAi) {
  try {
    const { outlook, model, usage } = await writeOutlook({ regions: REGIONS, places, snowline, today: places[0].days[0].date });
    result.text = outlook;
    result.writer = { model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  } catch (error) {
    if (error instanceof Anthropic.APIError) console.error(`Claude API error ${error.status}: ${error.message}`);
    else console.error(`The written outlook failed: ${error instanceof Error ? error.message : error}`);
  }
} else {
  console.log("No ANTHROPIC_API_KEY (or --no-ai): writing the tables only.");
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "outlook.json"), JSON.stringify(result));
console.log(`outlook.json: ${places.length} places, ${snowline.length} snowline days, text ${result.text ? "written" : "missing"}.`);
