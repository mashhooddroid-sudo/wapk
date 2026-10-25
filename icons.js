(() => {
  "use strict";

  const paths = {
    bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
    fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
    sliders: '<path d="M4 7h4m4 0h8M4 17h8m4 0h4"/><circle cx="10" cy="7" r="2"/><circle cx="14" cy="17" r="2"/>',
    map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15m6-12v15"/>',
    cloud: '<path d="M6.5 18a4.5 4.5 0 0 1-.72-8.94A6.25 6.25 0 0 1 17.8 8.2a4.9 4.9 0 0 1 .2 9.8Z"/>',
    search: '<circle cx="10.75" cy="10.75" r="6.75"/><path d="m16 16 4.5 4.5"/>',
    location: '<path d="m21 3-6.5 18-3.75-7.75L3 9.5 21 3Z"/><path d="m10.75 13.25 4-4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42m0-14.14-1.42 1.42M6.35 17.65l-1.42 1.42"/>',
    moon: '<path d="M20.7 14.1A8.9 8.9 0 0 1 9.9 3.3a9 9 0 1 0 10.8 10.8Z"/>',
    "chevron-right": '<path d="m9 5 7 7-7 7"/>',
    "chevron-left": '<path d="m15 5-7 7 7 7"/>',
    "arrow-up-right": '<path d="M6 18 18 6M6 6h12v12"/>',
    bookmark: '<path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4Z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M20.5 10a8.5 8.5 0 0 0-14.8-3L3 10m0 0V4m0 6h6m-5.5 4a8.5 8.5 0 0 0 14.8 3l2.7-3m0 0v6m0-6h-6"/>',
    wind: '<path d="M3 8h11a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M4 16h5a2.5 2.5 0 1 1-2.5 2.5"/>',
    droplet: '<path d="M12 2.5S5 10 5 14.5a7 7 0 0 0 14 0C19 10 12 2.5 12 2.5Z"/><path d="M8.5 14.5a3.5 3.5 0 0 0 3.5 3.5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    sunrise: '<path d="M2 18h20M4 21h16M6 15a6 6 0 0 1 12 0M12 2v6m-3-3 3-3 3 3M3 10l2 2m14 0 2-2"/>',
    sunset: '<path d="M2 18h20M4 21h16M6 15a6 6 0 0 1 12 0M12 2v6m-3-3 3 3 3-3M3 10l2 2m14 0 2-2"/>',
    leaf: '<path d="M20.5 3.5s1 9-4 14a7 7 0 0 1-10-10c5-5 14-4 14-4Z"/><path d="m3 21 13-13M8 16v-5m0 5h5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="16" rx="3"/><path d="M7.5 3v4m9-4v4M3.5 10h17m-12 4h.01m3.99 0h.01m3.99 0h.01m-8 4h.01m3.99 0h.01"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    "arrow-up": '<path d="M12 20V4m-7 7 7-7 7 7"/>',
    "arrow-down": '<path d="M12 4v16m-7-7 7 7 7-7"/>',
    heart: '<path d="m12 21-8.2-8.2a5.5 5.5 0 0 1 7.8-7.8l.4.4.4-.4a5.5 5.5 0 0 1 7.8 7.8Z"/>',
    pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    thermometer: '<path d="M14 14.5V5a2 2 0 0 0-4 0v9.5a4 4 0 1 0 4 0Z"/><path d="M12 9v7"/>',
    gauge: '<path d="M4.5 18a9 9 0 1 1 15 0"/><path d="m12 13 4-4"/><circle cx="12" cy="13" r="1.2"/>',
    radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 18.4 5.6"/><circle cx="12" cy="12" r="1"/>',
    satellite: '<path d="m6 10 4-4 3 3-4 4Z"/><path d="m11 15 4-4 3 3-4 4Z"/><path d="m11.5 9.5 3 3M4 20l3-3M16 4a4 4 0 0 1 4 4"/>',
    gust: '<path d="M3 9h9a2.5 2.5 0 1 0-2.5-2.5M3 13h14a3 3 0 1 1-3 3M3 17h5"/><path d="M19 6h2M18 10h3"/>',
    rain: '<path d="M6.5 15a4.5 4.5 0 0 1-.72-8.94A6.25 6.25 0 0 1 17.8 5.2a4.9 4.9 0 0 1 .2 9.8Z"/><path d="m8 18-1 3m5-3-1 3m5-3-1 3"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    dewpoint: '<path d="M9 3.5S4.5 9 4.5 12.5a4.5 4.5 0 0 0 9 0C13.5 9 9 3.5 9 3.5Z"/><path d="M18 4v10"/><circle cx="18" cy="17" r="2.5"/>',
    humidity: '<path d="M12 3s-6 6.6-6 11a6 6 0 0 0 12 0c0-4.4-6-11-6-11Z"/><path d="m9.5 16.5 5-5"/><circle cx="9.8" cy="12" r=".9"/><circle cx="14.2" cy="16" r=".9"/>',
    raintotal: '<path d="M5 9h14l-1.5 11h-11Z"/><path d="M6 14h12"/><path d="M9 2.5v3M12 2v3M15 2.5v3"/>',
    snowdepth: '<path d="m2.5 20 6.5-11 4 6 2.5-3.5 6 8.5Z"/><path d="m7.2 12 1.8 1.4 1.7-1.2"/><path d="M17 2.5v4M15 4.5h4"/>',
    freezing: '<path d="M10 14.5V4a2 2 0 0 1 4 0v10.5a4 4 0 1 1-4 0Z"/><path d="M3 12h4M17 12h4"/>',
    cloudlow: '<path d="M7 14a3.5 3.5 0 0 1-.5-7A5 5 0 0 1 16 6.5a3.8 3.8 0 0 1 .2 7.5Z"/><path d="M3 18h18M3 21h18"/>',
    cloudmid: '<path d="M3 4h18"/><path d="M7 17a3.5 3.5 0 0 1-.5-7A5 5 0 0 1 16 9.5a3.8 3.8 0 0 1 .2 7.5Z"/><path d="M3 21h18"/>',
    cloudhigh: '<path d="M3 3h18"/><path d="M4 11c3-2 6-2 8 0s5 2 8 0M4 16c3-2 6-2 8 0s5 2 8 0"/>',
    snowflake: '<path d="M12 2v20M4.2 6.5l15.6 11M4.2 17.5l15.6-11"/><path d="m9 3.5 3 2.5 3-2.5M9 20.5l3-2.5 3 2.5M3 10l3.6.6-1 3.4M21 14l-3.6-.6 1-3.4M3 14l3.6-.6-1-3.4M21 10l-3.6.6 1 3.4"/>',
    play: '<path d="M7 5v14l12-7Z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>'
  };

  function ui(name) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="ui-icon">${paths[name] || paths.cloud}</svg>`;
  }

  const sun = (small = false) => small
    ? '<g class="icon-sun" style="transform-origin:65px 31px"><g fill="none" stroke="#E8B34F" stroke-width="3" stroke-linecap="round"><path d="M65 9v-4m0 52v-4M43 31h-4m52 0h-4M49.5 15.5l-3-3m37 37-3-3m0-31 3-3m-37 37 3-3"/></g><circle cx="65" cy="31" r="15" fill="#F7CE75"/><circle cx="61" cy="27" r="9" fill="#FFDD92" opacity=".65"/></g>'
    : '<g class="icon-sun" style="transform-origin:48px 48px"><g fill="none" stroke="#E8B34F" stroke-width="4" stroke-linecap="round"><path d="M48 13V5m0 86v-8M13 48H5m86 0h-8M23.25 23.25l-5.66-5.66m60.82 60.82-5.66-5.66m0-49.5 5.66-5.66M17.59 78.41l5.66-5.66"/></g><circle cx="48" cy="48" r="25" fill="#F7CE75"/><circle cx="42" cy="41" r="16" fill="#FFDD92" opacity=".7"/></g>';

  const moon = (small = false) => small
    ? '<g class="icon-moon"><path d="M73 16a19 19 0 1 0 12 29 21 21 0 0 1-12-29Z" fill="#C2DAF3" stroke="#94B7D9" stroke-width="1.5" stroke-linejoin="round"/><path d="m84 14 1.5 4.5L90 20l-4.5 1.5L84 26l-1.5-4.5L78 20l4.5-1.5Z" fill="#E7F5FF"/></g>'
    : '<g class="icon-moon"><path d="M58 14a34 34 0 1 0 25 47A38 38 0 0 1 58 14Z" fill="#C2DAF3" stroke="#94B7D9" stroke-width="2" stroke-linejoin="round"/><path d="m76 13 2.5 7.5L86 23l-7.5 2.5L76 33l-2.5-7.5L66 23l7.5-2.5Z" fill="#D4E9FA"/><path d="m87 40 1.5 4.5L93 46l-4.5 1.5L87 52l-1.5-4.5L81 46l4.5-1.5Z" fill="#E5F4FF"/></g>';

  const cloud = (storm = false) => `<g class="icon-cloud"><path d="M24 66a16 16 0 0 1-1.7-31.9A24 24 0 0 1 67 30a18 18 0 1 1 8 36Z" fill="${storm ? "#829BB4" : "#EEF7FF"}" stroke="${storm ? "#69839E" : "#CCDFF0"}" stroke-width="1.6"/><path d="M25 38a20.5 20.5 0 0 1 37-5" fill="none" stroke="${storm ? "#B9CDDE" : "#FFFFFF"}" stroke-width="3" stroke-linecap="round" opacity=".8"/></g>`;

  const rain = (heavy = false) => `<g class="icon-rain" fill="none" stroke="#8CAEE2" stroke-width="${heavy ? 4 : 3}" stroke-linecap="round"><path d="m30 74-4 8m22-8-4 8m22-8-4 8"/>${heavy ? '<path d="m39 85-2 4m20-4-2 4" stroke-width="3"/>' : ""}</g>`;

  const drizzle = '<g class="icon-rain" fill="#91B6E5"><circle cx="29" cy="76" r="2.4"/><circle cx="48" cy="76" r="2.4"/><circle cx="67" cy="76" r="2.4"/><circle cx="38" cy="86" r="2"/><circle cx="57" cy="86" r="2"/></g>';

  const snow = '<g class="icon-snow" fill="none" stroke="#93B9D6" stroke-width="2" stroke-linecap="round"><path d="M28 73v12m-5.2-9 10.4 6m-10.4 0 10.4-6M48 78v12m-5.2-9 10.4 6m-10.4 0 10.4-6M68 73v12m-5.2-9 10.4 6m-10.4 0 10.4-6"/></g>';

  const fog = '<g class="icon-fog" fill="none" stroke="#9FBBD1" stroke-width="3" stroke-linecap="round"><path d="M13 72h47m8 0h13M20 81h11m8 0h37M27 90h37"/></g>';

  const bolt = '<path class="icon-bolt" d="m51 55-15 23h12l-4 17 20-28H51l7-12Z" fill="#F4C66D" stroke="#E8B552" stroke-width="1.5" stroke-linejoin="round"/>';

  function weather(code, isDay = true) {
    const value = Number(code);
    const daylight = isDay !== false && isDay !== 0;
    let kind = "cloudy";
    let artwork = cloud();

    if (value === 0) {
      kind = daylight ? "clear" : "night";
      artwork = daylight ? sun() : moon();
    } else if (value === 1 || value === 2) {
      kind = "partly-cloudy";
      artwork = (daylight ? sun(true) : moon(true)) + cloud();
    } else if (value === 45 || value === 48) {
      kind = "fog";
      artwork = cloud() + fog;
    } else if ([51, 53, 55, 56, 57].includes(value)) {
      kind = "drizzle";
      artwork = cloud() + drizzle;
    } else if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) {
      kind = "rain";
      artwork = cloud() + rain([65, 67, 82].includes(value));
    } else if ([71, 73, 75, 77, 85, 86].includes(value)) {
      kind = "snow";
      artwork = cloud() + snow;
    } else if ([95, 96, 99].includes(value)) {
      kind = "thunder";
      artwork = cloud(true) + (value === 95 ? rain() : snow) + bolt;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96" aria-hidden="true" focusable="false" class="weather-icon weather-icon--${kind}">${artwork}</svg>`;
  }

  window.AtmosIcons = Object.freeze({ ui, weather });
  document.querySelectorAll("[data-icon]").forEach((element) => {
    element.innerHTML = ui(element.dataset.icon);
  });
})();
