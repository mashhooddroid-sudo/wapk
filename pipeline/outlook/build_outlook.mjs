// WAPK 7-day outlook: the forecast for about 40 places across Pakistan, classified with the site's own rules
// (weather-logic.js: storms, hail, fog, snow below 0.5 °C, sleet 0.5–3 °C, rain above 3 °C), the snowline and
// the daily numbers, then written up in English and Urdu by an AI model. The numbers in the tables come from
// the data, never from the model; the model only writes the text, from the same numbers.
//
//   node build_outlook.mjs <out-dir> [--no-ai]
//
// Writes <out-dir>/outlook.json. The text is written by Claude when ANTHROPIC_API_KEY is set, otherwise by
// Cloudflare Workers AI (free tier) with CLOUDFLARE_API_TOKEN (needs the "Workers AI" permission) and
// CLOUDFLARE_ACCOUNT_ID. OUTLOOK_AI_URL points the Workers AI calls at a local test proxy instead. Without
// any of these (or with --no-ai) the file has the tables only and the site shows them without the text.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || ".";
const noAi = process.argv.includes("--no-ai");
const MODEL = "claude-opus-5-5";
const CF_MODEL = process.env.OUTLOOK_AI_MODEL || "@cf/openai/gpt-oss-120b";
const CF_URL = process.env.OUTLOOK_AI_URL
  || (process.env.CLOUDFLARE_ACCOUNT_ID ? `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/` : null);
const writerKind = noAi ? null
  : process.env.ANTHROPIC_API_KEY ? "claude"
  : process.env.OUTLOOK_AI_URL || (CF_URL && process.env.CLOUDFLARE_API_TOKEN) ? "workers-ai"
  : null;
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

// ── The written outlook (Cloudflare Workers AI) ─────────────────────────────
// Open models do better with two plain steps: write the outlook in English from compact data, then translate
// it to Urdu. The two answers are joined into the same { en, ur } shape as Claude's.
const EN_SHAPE = '{"headline": string, "overview": string, "days": [{"date": "YYYY-MM-DD", "title": string, "text": string}], "regions": [{"id": string, "text": string}], "snow": string, "advisories": [string]}';

// The forecast as short text lines, day by day and region by region (far fewer tokens than JSON, and laid out
// the way the outlook is written), with each date's weekday given so the model never has to work it out.
const weekday = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

function compactData(data) {
  const dates = data.places[0].days.map((day) => day.date);
  const lines = [`Today is ${weekday(data.today)} (${data.today}).`];
  dates.forEach((date, dayIndex) => {
    const snow = data.snowline.find((row) => row.date === date);
    lines.push("", `=== ${weekday(date)} (${date}) === snowline: ${snow?.metres ? `${snow.metres} m (lowest ${snow.lowestMetres} m at ${snow.lowestAt})` : "none (no precipitation on high ground)"}`);
    for (const region of data.regions) {
      const entries = data.places.filter((place) => place.region === region.id).map((place) => {
        const day = place.days[dayIndex];
        const parts = [`${place.name} (${place.elevation} m): ${day.weather}${day.hail ? " WITH HAIL" : ""}, ${day.max}/${day.min}°C`];
        if (day.rainMm >= 0.5) parts.push(`rain ${day.rainMm} mm`);
        if (day.sleetMm >= 0.5) parts.push(`sleet ${day.sleetMm} mm`);
        if (day.snowCm >= 0.5) parts.push(`snow ${day.snowCm} cm`);
        if (day.stormHours) parts.push(`thunderstorm ${day.stormHours} h`);
        if (day.gustKmh >= 50) parts.push(`gusts ${day.gustKmh} km/h`);
        if (day.wet.length) parts.push(`wet in the ${day.wet.join(", ")}`);
        return parts.join(", ");
      });
      lines.push(`[${region.id}] ${region.en}: ${entries.join("; ")}`);
    }
  });
  return lines.join("\n");
}

// Weather words in Urdu, so the translation uses the usual terms.
const URDU_GLOSSARY = "rain = بارش, light rain = ہلکی بارش, heavy rain = موسلا دھار بارش, drizzle = بوندا باندی, showers = بارش کی بوچھاڑ, snow = برف باری, snowfall = برف باری, sleet = برف آمیز بارش, hail = ژالہ باری, thunderstorm = گرج چمک کے ساتھ بارش, lightning = آسمانی بجلی, fog = دھند, mist = کہر, frost = کہرا, cloudy = ابر آلود, partly cloudy = جزوی ابر آلود, clear = صاف, sunny = دھوپ, wind gusts = تیز ہوائیں, snowline = برف کی حد, landslide = لینڈ سلائیڈنگ, minimum temperature = کم سے کم درجہ حرارت, maximum temperature = زیادہ سے زیادہ درجہ حرارت";

// The model's reply text, from the shapes Workers AI models answer in.
function replyText(result) {
  if (typeof result?.response === "string") return result.response;
  if (result?.response && typeof result.response === "object") return JSON.stringify(result.response);
  const choice = result?.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice;
  const output = (result?.output || []).flatMap((item) => item.content || []).filter((part) => part.type === "output_text").map((part) => part.text).join("");
  if (output) return output;
  throw new Error("the model gave no text");
}

function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the reply had no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

async function runWorkersAi(system, user) {
  const local = Boolean(process.env.OUTLOOK_AI_URL);
  const headers = { "Content-Type": "application/json" };
  if (!local) headers.Authorization = `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`;
  const body = { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 12000, temperature: 0.3 };
  if (local) body.model = CF_MODEL;
  const response = await fetch(local ? CF_URL : `${CF_URL}${CF_MODEL}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) throw new Error(`Workers AI ${response.status}: ${payload?.errors?.map((error) => error.message).join("; ") || "no answer"}`);
  return replyText(payload.result);
}

async function workersAiJson(system, user) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return parseJson(await runWorkersAi(system, user));
    } catch (error) {
      lastError = error;
      console.error(`Workers AI attempt ${attempt} failed: ${error.message}`);
    }
  }
  throw lastError;
}

async function writeOutlookWorkersAi(data) {
  const englishOnly = SYSTEM.split("\n\n").filter((paragraph) => !paragraph.startsWith("Write every text twice")).join("\n\n");
  const english = await workersAiJson(
    `${englishOnly}\n\nThe data lists each day (with its weekday, which you must use exactly as given) and, inside it, every region in [brackets] with its places. For each day, mention every place with heavy rain, thunderstorm, hail, snow or sleet; never call a place dry when the data gives it rain that day.\n\nAnswer with JSON only, no other text, in exactly this shape (English): ${EN_SHAPE}. "regions" has one entry for each region id in [brackets], "days" one entry for each date, and each day's "title" is a short summary of that day's weather (without the date).`,
    `Forecast data:\n${compactData(data)}\n\nWrite the 7-day outlook as JSON.`,
  );
  const names = [...data.places.map((place) => `${place.name} = ${place.ur}`), ...data.regions.map((region) => `${region.en} = ${region.ur}`)].join(", ");
  const urdu = await workersAiJson(
    `You translate weather forecasts from English into natural, fluent Urdu in Urdu script (never Roman Urdu), keeping every fact and number exactly. Use these weather terms: ${URDU_GLOSSARY}. Use these Urdu place names: ${names}. Answer with JSON only: the same shape and keys as the input, with every "date" and "id" value unchanged and every other text translated.`,
    JSON.stringify(english),
  );
  const pair = (en, ur) => ({ en: String(en ?? ""), ur: String(ur ?? en ?? "") });
  return {
    headline: pair(english.headline, urdu.headline),
    overview: pair(english.overview, urdu.overview),
    days: (english.days || []).map((day, index) => ({ date: day.date, title: pair(day.title, urdu.days?.[index]?.title), text: pair(day.text, urdu.days?.[index]?.text) })),
    regions: (english.regions || []).filter((region) => data.regions.some((item) => item.id === region.id)).map((region) => ({
      id: region.id,
      text: pair(region.text, urdu.regions?.find((item) => item.id === region.id)?.text),
    })),
    snow: pair(english.snow, urdu.snow),
    advisories: (english.advisories || []).map((item, index) => pair(item, urdu.advisories?.[index])),
  };
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

const data = { regions: REGIONS, places, snowline, today: places[0].days[0].date };
if (writerKind === "claude") {
  try {
    const { outlook, model, usage } = await writeOutlook(data);
    result.text = outlook;
    result.writer = { model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  } catch (error) {
    if (error instanceof Anthropic.APIError) console.error(`Claude API error ${error.status}: ${error.message}`);
    else console.error(`The written outlook failed: ${error instanceof Error ? error.message : error}`);
  }
} else if (writerKind === "workers-ai") {
  try {
    const started = Date.now();
    result.text = await writeOutlookWorkersAi(data);
    result.writer = { model: CF_MODEL, seconds: Math.round((Date.now() - started) / 1000) };
  } catch (error) {
    console.error(`The written outlook failed: ${error instanceof Error ? error.message : error}`);
  }
} else {
  console.log("No AI writer configured (or --no-ai): writing the tables only.");
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "outlook.json"), JSON.stringify(result));
console.log(`outlook.json: ${places.length} places, ${snowline.length} snowline days, text ${result.text ? "written" : "missing"}.`);
