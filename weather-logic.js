(() => {
  'use strict';

  // Thunderstorm, hail and graupel classification, ported from the Weather & Prayer Alert PK app
  // (lib/services/weather_controller.dart, documented in its WEATHER_LOGIC.md). Thresholds are the app's,
  // fitted to Pakistan stations and three confirmed hail events in Sep 2026, so keep them in step with it.
  // Fog (classifyFog) is the site's own since Nov 2026; the app still uses visibility alone.
  //
  // Input is an Open-Meteo forecast for ECMWF IFS (models=ecmwf_ifs) with the best_match fields merged in:
  // precipitation_probability, visibility, freezing_level_height, temperature_500hPa, lifted_index and
  // wind_speed_500hPa (ECMWF does not provide them), plus the response's grid-cell `elevation`.
  //
  // Internal codes beyond WMO: 44 mist, 46 dense fog, 47 very dense fog, 97 thunderstorms (between 96 and 99).

  const CAPE_FLOOR = 500; // J/kg; below this the atmosphere cannot sustain thunder.
  const RAIN_CODES = new Set([51, 53, 55, 61, 63, 65, 80, 81, 82]);
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

  const isStormCode = (code) => code === 95 || code === 96 || code === 97 || code === 99;
  // Drizzle, rain and showers: the codes the "meaningful rain" gate acts on.
  // 68/69 are sleet (WMO "rain and snow"); 66/67 stay real freezing rain.
  const isRainCode = (code) => (code >= 51 && code <= 69) || (code >= 80 && code <= 82);
  const isPriority = (code) => (code >= 44 && code <= 48) || (code >= 51 && code <= 69) || (code >= 71 && code <= 77) || (code >= 80 && code <= 86) || (code >= 95 && code <= 99);

  // What falls by the 2 m temperature, the same rule as the map's Rain, thunder layer (precipKind in forecast.js):
  // below 0.5 °C snow, 0.5–3 °C sleet, above 3 °C rain. Freezing rain stays up to 3 °C. Sleet is 68 (light) or
  // 69 (moderate or heavy).
  const SNOW_CODES = [71, 73, 75, 77, 85, 86];
  const LIQUID_CODES = [51, 53, 55, 61, 63, 65, 80, 81, 82];
  const sleetFor = (code) => ([55, 63, 65, 73, 75, 81, 82, 86].includes(code) ? 69 : 68);
  function fixPrecipTypeForTemp(code, tempC) {
    if (tempC === null) return code;
    if ([56, 57, 66, 67].includes(code)) return tempC > 3 ? { 56: 51, 57: 55, 66: 61, 67: 65 }[code] : code;
    if (SNOW_CODES.includes(code)) {
      if (tempC < 0.5) return code;
      if (tempC <= 3) return sleetFor(code);
      return { 71: 61, 77: 61, 73: 63, 75: 65, 85: 80, 86: 82 }[code];
    }
    if (LIQUID_CODES.includes(code)) {
      if (tempC < 0.5) return { 51: 71, 53: 73, 55: 75, 61: 71, 63: 73, 65: 75, 80: 85, 81: 85, 82: 86 }[code];
      if (tempC <= 3) return sleetFor(code);
    }
    if (code === 48 && tempC > 2) return 45;
    return code;
  }

  function codeFromCloudCover(pct) {
    if (pct === null) return 3;
    if (pct < 20) return 0;
    if (pct < 50) return 1;
    if (pct < 80) return 2;
    return 3;
  }

  // Amount picks the tier; the storm flag only picks the column.
  function hourlyPrecipTier(mm, storm) {
    if (mm > 4) return storm ? 99 : 65;
    if (mm > 3) return storm ? 97 : 63;
    if (mm > 1) return storm ? 96 : 63;
    return storm ? 95 : 61;
  }

  function dailyPrecipTier(sumMm, storm) {
    if (sumMm > 25) return storm ? 99 : 65;
    if (sumMm > 14) return storm ? 97 : 63;
    if (sumMm > 7) return storm ? 96 : 63;
    return storm ? 95 : 61;
  }

  // One hour: three "doors" decide whether a storm may show at all, then instability decides storm vs rain.
  function refineThunderstorm(code, { cape, mm, cloud, pp, li }) {
    const c = cape ?? 0;
    const rain = mm ?? 0;
    const prob = pp ?? 0;
    const upstreamStorm = code === 95 || code === 96 || code === 99;
    const rainDoor = prob > 25 && rain > 1;
    const instabilityDoor = prob > 50 && rain >= 0.1 && li !== null && li <= -3 && c >= 2000;
    const amountDoor = rain > 3;
    if (!(rainDoor || instabilityDoor || amountDoor)) {
      if (upstreamStorm) {
        if (rain >= 4) return 65;
        if (rain >= 1) return 63;
        if (rain > 0.1) return 61;
        return codeFromCloudCover(cloud);
      }
      return code;
    }
    const hasPrecip = rain > 0.5 || prob > 50;
    const sharpInstability = li !== null && prob > 30 && ((li <= -4 && c >= 1000) || (li <= -3 && c >= 2000));
    const storm = (upstreamStorm && c >= CAPE_FLOOR) || sharpInstability || (RAIN_CODES.has(code) && hasPrecip && c >= CAPE_FLOOR);
    if (storm) return hourlyPrecipTier(rain, true);
    if (RAIN_CODES.has(code)) return hourlyPrecipTier(rain, false);
    return code;
  }

  // Hail reaches the ground when the warm layer it falls through is shallow enough, it is cold enough aloft
  // and the updraft can organise (500 hPa wind as a shear proxy). Freezing level is above sea level, so the
  // ground elevation is subtracted.
  function hailReachesGround(freezingLevelM, t500C, wind500Kmh, elevationM) {
    if (freezingLevelM === null || t500C === null) return false;
    const warmLayerM = freezingLevelM - (elevationM ?? 0);
    const shearKt = (wind500Kmh ?? 0) / 1.852;
    return warmLayerM <= 4200 && t500C <= -4 && shearKt >= 17;
  }

  // Cold-season graupel (soft hail) from ordinary showers on high ground: a second path to the hail flag that
  // needs no storm, CAPE or shear, ported from the app (graupelReachesGround). Galiyat and Murree were carpeted
  // in graupel on 24 Oct 2026 while ECMWF called it drizzle (max 0.7 mm/h, CAPE under 530, shear under 5 kt);
  // the warm layer was 1292 m and T500 −16.8 °C. A 2 m temperature of 3 °C or more separates graupel from plain
  // snow. Only above 1500 m: the cold profile it needs does not occur lower in Pakistan.
  function graupelReachesGround(freezingLevelM, t500C, t2mC, precipMm, elevationM) {
    const elevation = elevationM ?? 0;
    if (elevation < 1500 || freezingLevelM === null || t500C === null || t2mC === null) return false;
    if ((precipMm ?? 0) < 0.3) return false;
    return freezingLevelM - elevation <= 2000 && t500C <= -12 && t2mC >= 3;
  }

  // Fog and mist, only where the hour is otherwise clear or cloudy (rain, snow and storms always win).
  //
  // The model's own fog code and visibility are not used on their own: in Nov 2026 tests they put fog in the dry
  // Gilgit-Baltistan and Kaghan valleys (code 45 at 65 % humidity, low visibility from cloud on the slopes) and
  // never went below 4 km in Lahore, Multan or Faisalabad while the airports reported 350–800 m fog every morning.
  // Instead fog comes from the dew-point spread (temperature − dew point), light wind and night/morning hours. In
  // the plains smog lets fog form at a wider spread, so PM2.5 (CAMS) widens the thresholds: fog mornings had
  // PM2.5 130–250 in Punjab, while Peshawar at 35–65 had only haze at the same spreads.
  const SKY_FROM_FOG = new Set([44, 45, 46, 47, 48]);
  function fogFromVisibility(code, visibilityM) {
    if (visibilityM === null) return code;
    if (visibilityM < 50) return 47;
    if (visibilityM <= 200) return 46;
    if (visibilityM <= 500) return 45;
    if (visibilityM <= 1000) return 44;
    return code;
  }

  function classifyFog(code, fields, ctx) {
    // The model's fog codes become the sky they hide; this rule decides fog afresh.
    if (SKY_FROM_FOG.has(code)) code = codeFromCloudCover(fields.cloud);
    if (code > 3 || fields.temp === null || fields.dew === null) return code;
    if ((fields.mm ?? 0) >= 0.2) return code;
    const spread = Math.max(0, fields.temp - fields.dew);
    const wind = fields.wind ?? 0;
    const hour = fields.time ? Number(fields.time.slice(11, 13)) : 6;
    const month = fields.time ? Number(fields.time.slice(5, 7)) : 12;
    const nightOrMorning = hour >= 20 || hour <= 10;
    const elevation = ctx.elevation ?? 0;
    const coastal = elevation < 1000 && (ctx.latitude ?? 90) < 27;
    const dryNorth = elevation >= 1000 && (ctx.latitude ?? 0) >= 34.5;
    let fog = code;

    if (elevation >= 1000) {
      // Mountains. The northern valleys (Gilgit-Baltistan, Chitral, upper Swat and Kaghan) are very dry: only
      // a saturated, calm hour gives mist, and fog needs a spread of 0.2 °C or less.
      if (dryNorth) {
        if (wind <= 6 && nightOrMorning && spread <= 0.2) fog = 45;
        else if (wind <= 6 && nightOrMorning && spread <= 0.5) fog = 44;
      } else if (spread <= 0.5 && wind <= 15) {
        fog = 45; // hill fog (cloud on the hills, e.g. Murree and the Galiyat), any hour
      } else if (spread <= 1 && wind <= 15) {
        fog = 44;
      }
    } else {
      // Plains: radiation fog in the cold season, wider with smog.
      const pm = fields.pm25 ?? ctx.pm25Fallback ?? 0;
      let off = Math.min(2.5, Math.max(0, (pm - 40) / 50));
      // Lower Sindh and the coast (south of 27°N): humid sea air keeps the spread small without fog (Karachi
      // had haze and mist at 1.5–2.5 km while the spread was near 1 °C), so smog adds little and fog needs calm.
      if (coastal) off *= 0.3;
      // Fog season is November to February; October and March only with a near-saturated hour.
      const season = month >= 11 || month <= 2 ? 1 : month === 10 || month === 3 ? 0.5 : 0.25;
      const mist = (2 + off) * season;
      const fogAt = (1 + off) * season;
      const dense = (0.5 + off * 0.4) * season;
      const lingering = !nightOrMorning && spread <= 0.5 && wind <= 6 && season === 1; // all-day winter fog
      if (nightOrMorning || lingering) {
        if (!coastal && spread <= 0.3 && wind <= 3 && (month === 12 || month === 1) && pm >= 100) fog = 47;
        else if (!coastal && spread <= dense && wind <= 6) fog = 46;
        else if (coastal && spread <= 0.3 && wind <= 5) fog = 45;
        else if (coastal) { if (spread <= 1.5 && wind <= 12) fog = 44; }
        else if (spread <= fogAt && wind <= 10) fog = 45;
        else if (spread <= mist && wind <= 15) fog = 44;
      }
    }

    // The model's visibility only adds weight in a nearly saturated hour (not in the dry north or on the coast).
    if (!dryNorth && !coastal && spread <= 1 && fields.vis !== null && fields.vis <= 1000) {
      const byVis = fogFromVisibility(code, fields.vis);
      if ((SEVERITY[byVis] ?? 0) > (SEVERITY[fog] ?? 0)) fog = byVis;
    }
    if (fog >= 45 && fog <= 47 && fields.temp < 0) fog = 48;
    return fog;
  }

  function capeIntensity(code, cape) {
    if (!isStormCode(code) || cape === null || cape < 500) return null;
    if (cape < 1000) return 'light';
    if (cape < 2500) return 'moderate';
    if (cape < 3500) return 'strong';
    return 'severe';
  }

  const SEVERITY = { 99: 100, 97: 98, 96: 96, 95: 94, 75: 90, 77: 88, 86: 85, 67: 82, 69: 81, 65: 80, 82: 78, 73: 70, 85: 68, 68: 66, 66: 65, 63: 62, 81: 60, 71: 55, 61: 50, 80: 48, 47: 52, 46: 49, 48: 45, 45: 42, 44: 25, 57: 38, 56: 36, 55: 34, 53: 32, 51: 30, 3: 20, 2: 15, 1: 10 };
  function mostSevere(codes) {
    return codes.reduce((best, code) => ((SEVERITY[code] ?? 0) > (SEVERITY[best] ?? 0) ? code : best), codes[0]);
  }
  // Ties go to the code seen first, as in the app.
  function mostFrequent(codes) {
    if (!codes.length) return 0;
    const counts = new Map();
    codes.forEach((code) => counts.set(code, (counts.get(code) || 0) + 1));
    let best = codes[0];
    let bestCount = 0;
    counts.forEach((count, code) => {
      if (count > bestCount) {
        bestCount = count;
        best = code;
      }
    });
    return best;
  }

  // Any storm hour headlines by severity; other weather by how often it occurs; dry hours never outvote it.
  function dominantCode(codes) {
    if (!codes.length) return 0;
    const priority = codes.filter(isPriority);
    if (priority.length) {
      const storms = priority.filter((code) => code >= 95);
      return storms.length ? mostSevere(storms) : mostFrequent(priority);
    }
    const clear = codes.filter((code) => code === 0 || code === 1);
    const cloudy = codes.filter((code) => code === 2 || code === 3);
    if (clear.length > cloudy.length) return mostFrequent(clear);
    if (cloudy.length > clear.length) return mostFrequent(cloudy);
    return clear.length ? mostFrequent(clear) : mostFrequent(codes);
  }

  function applyRainGate(dominant, codes, meaningfulRain) {
    if (!isRainCode(dominant) || meaningfulRain) return dominant;
    const nonRain = codes.filter((code) => !isRainCode(code));
    return nonRain.length ? dominantCode(nonRain) : 3;
  }

  // A clear/cloudy headline comes from the mean cloud cover rather than the most frequent code.
  function skyFromCloud(code, clouds) {
    if (code > 3 || !clouds.length) return code;
    return codeFromCloudCover(Math.round(clouds.reduce((sum, value) => sum + value, 0) / clouds.length));
  }

  // Fields of one hour, read from the merged hourly arrays.
  function hourFields(hourly, index) {
    const at = (name) => num(hourly[name]?.[index]);
    return {
      time: typeof hourly.time?.[index] === 'string' ? hourly.time[index] : null,
      code: at('weather_code') ?? 0,
      temp: at('temperature_2m'),
      dew: at('dew_point_2m'),
      wind: at('wind_speed_10m'),
      pm25: at('pm2_5'),
      cape: at('cape'),
      mm: at('precipitation'),
      cloud: at('cloud_cover') === null ? null : Math.round(at('cloud_cover')),
      pp: at('precipitation_probability') === null ? 0 : Math.round(at('precipitation_probability')),
      li: at('lifted_index'),
      freeze: at('freezing_level_height'),
      t500: at('temperature_500hPa'),
      wind500: at('wind_speed_500hPa'),
      vis: at('visibility'),
    };
  }

  // What an hour shows on its own (hourly strip and current conditions).
  function classifyHour(fields, ctx, codeOverride) {
    let code = fixPrecipTypeForTemp(codeOverride ?? fields.code, fields.temp);
    code = refineThunderstorm(code, fields);
    const stormHail = isStormCode(code) && hailReachesGround(fields.freeze, fields.t500, fields.wind500, ctx.elevation);
    // graupel: true when the hail flag comes only from the graupel path (showers, not a storm).
    const graupel = !stormHail && graupelReachesGround(fields.freeze, fields.t500, fields.temp, fields.mm, ctx.elevation);
    const hail = stormHail || graupel;
    if ((fields.cloud ?? 0) >= 90 && (code === 1 || code === 2)) code = 3;
    code = classifyFog(code, fields, ctx);
    return { code, hail, graupel, intensity: capeIntensity(code, fields.cape) };
  }

  const isFogCode = (code) => code >= 45 && code <= 48;
  // Fog headlines a day (or a day/night half) only when it lasts: 3+ fog hours, or 4+ hours of mist or fog.
  function fogHeadline(code, codes, minFog) {
    if (code > 3) return code;
    const fogs = codes.filter(isFogCode);
    if (fogs.length >= minFog) return mostFrequent(fogs);
    if (codes.filter((value) => value === 44 || isFogCode(value)).length >= minFog + 1) return 44;
    return code;
  }

  // One calendar day: day and night headlines, the day's overall headline (re-tiered from the 24-hour
  // total when it is rain or a storm), thunderstorm intensity from the day's CAPE, and the hail flag.
  function classifyDay(hourly, date, sunrise, sunset, ctx) {
    const dayCodes = [];
    const nightCodes = [];
    const dayFog = [];
    const nightFog = [];
    const dayCloud = [];
    const nightCloud = [];
    let maxCape = null;
    let rainSlots = 0;
    let precipSum = 0;
    let maxProb = 0;
    let upstreamStorm = false;
    let anyStormHour = false;
    let hail = false;
    let graupelHail = false;
    hourly.time.forEach((time, index) => {
      if (typeof time !== 'string' || time.slice(0, 10) !== date) return;
      const fields = hourFields(hourly, index);
      let code = fixPrecipTypeForTemp(fields.code, fields.temp);
      if (code === 95 || code === 96 || code === 99) upstreamStorm = true;
      code = refineThunderstorm(code, fields);
      // Fog and mist hours count as their sky for the headline; fogHeadline adds them back when they last.
      const withFog = classifyFog(code, fields, ctx);
      code = withFog === 44 || isFogCode(withFog) ? codeFromCloudCover(fields.cloud) : withFog;
      if (isStormCode(code)) {
        anyStormHour = true;
        if (hailReachesGround(fields.freeze, fields.t500, fields.wind500, ctx.elevation)) hail = true;
      }
      if (graupelReachesGround(fields.freeze, fields.t500, fields.temp, fields.mm, ctx.elevation)) graupelHail = true;
      if (fields.cape !== null && (maxCape === null || fields.cape > maxCape)) maxCape = fields.cape;
      precipSum += fields.mm ?? 0;
      maxProb = Math.max(maxProb, fields.pp);
      if (isRainCode(code)) rainSlots += 1;
      // Local wall-clock strings of the same form compare correctly as text.
      if (sunrise && sunset && time > sunrise && time < sunset) {
        dayCodes.push(code);
        dayFog.push(withFog);
        if (fields.cloud !== null) dayCloud.push(fields.cloud);
      } else {
        nightCodes.push(code);
        nightFog.push(withFog);
        if (fields.cloud !== null) nightCloud.push(fields.cloud);
      }
    });
    const all = [...dayCodes, ...nightCodes];
    if (!all.length) return null;
    const meaningfulRain = (rainSlots >= 3 && maxProb >= 10 && precipSum >= 1) || precipSum > 2;
    const headline = (codes, clouds) => skyFromCloud(applyRainGate(dominantCode(codes), codes, meaningfulRain), clouds);
    let code = headline(all, dayCloud.length ? dayCloud : nightCloud);
    const precipHeadline = (code >= 51 && code <= 65) || (code >= 80 && code <= 82) || isStormCode(code);
    if (precipHeadline) {
      // A storm day if any hour classified as one, or the model flagged storms and the day's rain backs it.
      const stormDay = anyStormHour || (upstreamStorm && maxProb > 25 && precipSum >= 1);
      code = dailyPrecipTier(precipSum, stormDay);
    }
    // Snow, sleet or freezing rain for 3 hours or more is the day's headline over plain rain (not over a storm),
    // so a day that starts with sleet and turns to rain still shows it.
    const wintry = all.filter((value) => [56, 57, 66, 67, 68, 69, 71, 73, 75, 77, 85, 86].includes(value));
    if (wintry.length >= 3 && !isStormCode(code)) code = dominantCode(wintry);
    code = fogHeadline(code, [...dayFog, ...nightFog], 3);
    return {
      code,
      dayCode: dayCodes.length ? fogHeadline(headline(dayCodes, dayCloud), dayFog, 2) : null,
      nightCode: nightCodes.length ? fogHeadline(headline(nightCodes, nightCloud), nightFog, 2) : null,
      intensity: capeIntensity(code, maxCape),
      maxCape,
      hail: hail || graupelHail,
      graupel: graupelHail && !hail,
    };
  }

  // Adds `wapk` classifications to an Open-Meteo payload: per hour, per day and for the current hour.
  function classifyForecast(payload, currentIndex) {
    const hourly = payload.hourly;
    const daily = payload.daily;
    // PM2.5 (CAMS, about 5 days) widens the plains' fog thresholds; later days use the typical morning value.
    const mornings = (hourly.pm2_5 || []).filter((value, index) => num(value) !== null && /T0[5-9]/.test(hourly.time[index] || '')).sort((a, b) => a - b);
    const ctx = {
      elevation: num(payload.elevation),
      latitude: num(payload.latitude),
      pm25Fallback: mornings.length ? mornings[Math.floor(mornings.length / 2)] : null,
    };
    const hours = hourly.time.map((_, index) => classifyHour(hourFields(hourly, index), ctx));
    const days = daily.time.map((date, index) => classifyDay(hourly, date, daily.sunrise?.[index], daily.sunset?.[index], ctx));
    // The current hour uses the model's current code with that hour's environment, as the app does.
    const now = hourFields(hourly, currentIndex);
    if (num(payload.current?.precipitation) !== null) now.mm = payload.current.precipitation;
    if (num(payload.current?.cloud_cover) !== null) now.cloud = Math.round(payload.current.cloud_cover);
    if (num(payload.current?.temperature_2m) !== null) now.temp = payload.current.temperature_2m;
    const current = classifyHour(now, ctx, num(payload.current?.weather_code) ?? now.code);
    return { hours, days, current };
  }

  window.WapkWeatherLogic = Object.freeze({ classifyForecast, hailReachesGround, isStormCode });
})();
