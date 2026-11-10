(() => {
  'use strict';

  // Thunderstorm, hail and fog classification, ported from the Weather & Prayer Alert PK app
  // (lib/services/weather_controller.dart, documented in its WEATHER_LOGIC.md). Thresholds are the app's,
  // fitted to Pakistan stations and three confirmed hail events in Sep 2026, so keep them in step with it.
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

  // Fog from visibility, only where the hour is otherwise clear or cloudy.
  function fogFromVisibility(code, visibilityM) {
    if (visibilityM === null || code > 3) return code;
    if (visibilityM < 50) return 47;
    if (visibilityM <= 200) return 46;
    if (visibilityM <= 500) return 45;
    if (visibilityM <= 1000) return 44;
    return code;
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
      code: at('weather_code') ?? 0,
      temp: at('temperature_2m'),
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
  function classifyHour(fields, elevation, codeOverride) {
    let code = fixPrecipTypeForTemp(codeOverride ?? fields.code, fields.temp);
    code = refineThunderstorm(code, fields);
    const hail = isStormCode(code) && hailReachesGround(fields.freeze, fields.t500, fields.wind500, elevation);
    if ((fields.cloud ?? 0) >= 90 && (code === 1 || code === 2)) code = 3;
    code = fogFromVisibility(code, fields.vis);
    return { code, hail, intensity: capeIntensity(code, fields.cape) };
  }

  // One calendar day: day and night headlines, the day's overall headline (re-tiered from the 24-hour
  // total when it is rain or a storm), thunderstorm intensity from the day's CAPE, and the hail flag.
  function classifyDay(hourly, date, sunrise, sunset, elevation) {
    const dayCodes = [];
    const nightCodes = [];
    const dayCloud = [];
    const nightCloud = [];
    let maxCape = null;
    let rainSlots = 0;
    let precipSum = 0;
    let maxProb = 0;
    let upstreamStorm = false;
    let anyStormHour = false;
    let hail = false;
    hourly.time.forEach((time, index) => {
      if (typeof time !== 'string' || time.slice(0, 10) !== date) return;
      const fields = hourFields(hourly, index);
      let code = fixPrecipTypeForTemp(fields.code, fields.temp);
      if (code === 95 || code === 96 || code === 99) upstreamStorm = true;
      code = refineThunderstorm(code, fields);
      code = fogFromVisibility(code, fields.vis);
      if (isStormCode(code)) {
        anyStormHour = true;
        if (hailReachesGround(fields.freeze, fields.t500, fields.wind500, elevation)) hail = true;
      }
      if (fields.cape !== null && (maxCape === null || fields.cape > maxCape)) maxCape = fields.cape;
      precipSum += fields.mm ?? 0;
      maxProb = Math.max(maxProb, fields.pp);
      if (isRainCode(code)) rainSlots += 1;
      // Local wall-clock strings of the same form compare correctly as text.
      if (sunrise && sunset && time > sunrise && time < sunset) {
        dayCodes.push(code);
        if (fields.cloud !== null) dayCloud.push(fields.cloud);
      } else {
        nightCodes.push(code);
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
    return {
      code,
      dayCode: dayCodes.length ? headline(dayCodes, dayCloud) : null,
      nightCode: nightCodes.length ? headline(nightCodes, nightCloud) : null,
      intensity: capeIntensity(code, maxCape),
      maxCape,
      hail,
    };
  }

  // Adds `wapk` classifications to an Open-Meteo payload: per hour, per day and for the current hour.
  function classifyForecast(payload, currentIndex) {
    const hourly = payload.hourly;
    const daily = payload.daily;
    const elevation = num(payload.elevation);
    const hours = hourly.time.map((_, index) => classifyHour(hourFields(hourly, index), elevation));
    const days = daily.time.map((date, index) => classifyDay(hourly, date, daily.sunrise?.[index], daily.sunset?.[index], elevation));
    // The current hour uses the model's current code with that hour's environment, as the app does.
    const now = hourFields(hourly, currentIndex);
    if (num(payload.current?.precipitation) !== null) now.mm = payload.current.precipitation;
    if (num(payload.current?.cloud_cover) !== null) now.cloud = Math.round(payload.current.cloud_cover);
    if (num(payload.current?.temperature_2m) !== null) now.temp = payload.current.temperature_2m;
    const current = classifyHour(now, elevation, num(payload.current?.weather_code) ?? now.code);
    return { hours, days, current };
  }

  window.WapkWeatherLogic = Object.freeze({ classifyForecast, hailReachesGround, isStormCode });
})();
