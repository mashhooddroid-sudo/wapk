(() => {
  'use strict';

  // The Outlook tab: WAPK's written 7-day forecast for Pakistan (pipeline/outlook/build_outlook.mjs), in English
  // or Urdu, with the snowline and every place's daily weather and min/max as tables from the same data.
  const DATA_URL = (location.hostname.startsWith('health-preview') || new URLSearchParams(location.search).get('data') === 'preview'
    ? 'https://preview.wapk-forecast.pages.dev/'
    : 'https://wapk-forecast.pages.dev/') + 'outlook.json';
  const REFRESH_MS = 30 * 60 * 1000;
  const LANG_KEY = 'wapk.outlook.lang';
  const URDU_FONT = 'https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;600&display=swap';

  const byId = (id) => document.getElementById(id);
  const root = byId('outlookBody');
  const updated = byId('outlookUpdated');
  const state = { data: null, loadedAt: 0, loading: null, lang: 'en' };
  try { if (localStorage.getItem(LANG_KEY) === 'ur') state.lang = 'ur'; } catch { /* storage unavailable */ }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  const t = (pair) => (pair ? pair[state.lang] || pair.en || '' : '');
  const ur = () => state.lang === 'ur';
  const LABELS = {
    en: { overview: 'Overview', advisories: 'Advisories', days: 'Day by day', snow: 'Snowline', regions: 'Regions', places: 'Places', snowline: 'Snowline', lowest: 'Lowest', date: 'Day', none: 'No snow expected', pending: 'The written outlook is being prepared. The tables below are from the latest forecast.', failed: 'The outlook could not load. Check your connection and try again.', written: 'Written by AI from WAPK forecast data', source: 'ECMWF IFS, WAPK weather rules', rain: 'rain', snowCm: 'snow' },
    ur: { overview: 'خلاصہ', advisories: 'انتباہ', days: 'روزانہ موسم', snow: 'برف باری کی حد', regions: 'علاقے', places: 'شہر', snowline: 'برف کی حد', lowest: 'کم ترین', date: 'دن', none: 'برف باری متوقع نہیں', pending: 'تحریری پیش گوئی تیار کی جا رہی ہے۔ نیچے دی گئی جدولیں تازہ ترین پیش گوئی سے ہیں۔', failed: 'پیش گوئی لوڈ نہیں ہو سکی۔ کنکشن چیک کر کے دوبارہ کوشش کریں۔', written: 'WAPK کے موسمی ڈیٹا سے AI کی تحریر', source: 'ECMWF IFS، WAPK موسمی قواعد', rain: 'بارش', snowCm: 'برف' },
  };
  const L = (key) => LABELS[state.lang][key];

  function dayName(date, style = 'short') {
    const at = new Date(`${date}T12:00:00+05:00`);
    return new Intl.DateTimeFormat(ur() ? 'ur-PK' : 'en-GB', { weekday: style, day: 'numeric', month: style === 'long' ? 'long' : 'short', timeZone: 'Asia/Karachi' }).format(at);
  }

  async function load(force) {
    if (!force && state.data && Date.now() - state.loadedAt < REFRESH_MS) return state.data;
    state.loading ||= fetch(DATA_URL, { cache: 'no-cache', signal: AbortSignal.timeout(20_000) })
      .then((response) => {
        if (!response.ok) throw new Error(`outlook returned ${response.status}`);
        return response.json();
      })
      .then((data) => {
        state.data = data;
        state.loadedAt = Date.now();
        return data;
      })
      .finally(() => { state.loading = null; });
    return state.loading;
  }

  function useUrduFont() {
    if (document.querySelector(`link[href="${URDU_FONT}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = URDU_FONT;
    document.head.append(link);
  }

  function setLang(lang) {
    state.lang = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* storage unavailable */ }
    render();
  }

  function section(title, className) {
    const card = el('section', `card outlook-card ${className || ''}`);
    card.append(el('h2', 'outlook-card-title', title));
    return card;
  }

  function render() {
    const data = state.data;
    if (!data) return;
    const text = data.text;
    if (ur()) useUrduFont();
    root.replaceChildren();
    root.dir = ur() ? 'rtl' : 'ltr';
    root.lang = ur() ? 'ur' : 'en';
    root.classList.toggle('is-urdu', ur());
    document.querySelectorAll('[data-outlook-lang]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.outlookLang === state.lang)));
    updated.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(data.generatedAt));

    if (text) {
      const lead = el('section', 'card outlook-lead');
      lead.append(el('p', 'outlook-headline', t(text.headline)), el('p', 'outlook-overview', t(text.overview)));
      root.append(lead);
      if (text.advisories?.length) {
        const card = section(L('advisories'), 'outlook-advisories');
        const list = el('ul', 'outlook-advisory-list');
        text.advisories.forEach((item) => list.append(el('li', null, t(item))));
        card.append(list);
        root.append(card);
      }
    } else {
      root.append(el('p', 'outlook-note', L('pending')));
    }

    const grid = el('div', 'outlook-grid');
    root.append(grid);
    if (text?.days?.length) {
      const card = section(L('days'), 'outlook-days');
      text.days.forEach((day) => {
        const item = el('article', 'outlook-day');
        item.append(el('h3', null, `${dayName(day.date, 'long')} · ${t(day.title)}`), el('p', null, t(day.text)));
        card.append(item);
      });
      grid.append(card);
    }

    // Snowline: the text, then the numbers from the data.
    const snowCard = section(L('snow'), 'outlook-snow');
    if (text?.snow) snowCard.append(el('p', null, t(text.snow)));
    const table = el('table', 'outlook-table');
    const head = el('tr');
    [L('date'), L('snowline'), L('lowest')].forEach((label) => head.append(el('th', null, label)));
    const thead = el('thead');
    thead.append(head);
    table.append(thead);
    const body = el('tbody');
    (data.snowline || []).forEach((row) => {
      const tr = el('tr');
      const place = data.places.find((item) => item.name === row.lowestAt);
      tr.append(
        el('td', null, dayName(row.date)),
        el('td', 'num', row.metres ? `${row.metres.toLocaleString()} m` : L('none')),
        el('td', null, row.lowestMetres ? `${row.lowestMetres.toLocaleString()} m · ${ur() ? place?.ur || row.lowestAt : row.lowestAt}` : '—'),
      );
      body.append(tr);
    });
    table.append(body);
    snowCard.append(table);
    grid.append(snowCard);

    // Each region: its text and its places' days (weather icon, max/min, rain or snow).
    const regionsCard = section(L('regions'), 'outlook-regions');
    const days = data.places[0]?.days.map((day) => day.date) || [];
    data.regions.forEach((region) => {
      const block = el('details', 'outlook-region');
      block.open = true;
      block.append(el('summary', null, ur() ? region.ur : region.en));
      const regionText = text?.regions?.find((item) => item.id === region.id);
      if (regionText) block.append(el('p', null, t(regionText.text)));
      const scroller = el('div', 'outlook-scroll');
      const placeTable = el('table', 'outlook-table outlook-places');
      const row = el('tr');
      row.append(el('th', null, L('places')));
      days.forEach((date) => row.append(el('th', null, dayName(date))));
      const placeHead = el('thead');
      placeHead.append(row);
      placeTable.append(placeHead);
      const tbody = el('tbody');
      data.places.filter((place) => place.region === region.id).forEach((place) => {
        const tr = el('tr');
        const name = el('th', null, ur() ? place.ur : place.name);
        name.scope = 'row';
        name.append(el('span', 'outlook-elev', `${place.elevation?.toLocaleString() ?? '—'} m`));
        tr.append(name);
        place.days.forEach((day) => {
          const cell = el('td', 'outlook-cell');
          cell.title = `${day.weather}${day.hail ? ', hail possible' : ''}`;
          const icon = el('span', 'outlook-icon');
          icon.innerHTML = window.AtmosIcons?.weather(day.code ?? 3, true, day.hail) || '';
          const temps = el('span', 'outlook-temps');
          temps.append(el('b', null, `${day.max ?? '–'}°`), el('span', null, `${day.min ?? '–'}°`));
          cell.append(icon, temps);
          const wet = (day.rainMm || 0) + (day.sleetMm || 0);
          if (day.snowCm >= 0.5) cell.append(el('span', 'outlook-snowcm', `${Math.round(day.snowCm)} cm ${L('snowCm')}`));
          else if (wet >= 0.5) cell.append(el('span', 'outlook-mm', `${Math.round(wet)} mm`));
          tr.append(cell);
        });
        tbody.append(tr);
      });
      placeTable.append(tbody);
      scroller.append(placeTable);
      block.append(scroller);
      regionsCard.append(block);
    });
    root.append(regionsCard);

    const footer = el('p', 'outlook-source', `${text ? `${L('written')} · ` : ''}${L('source')}`);
    root.append(footer);
  }

  async function show() {
    if (!state.data) root.replaceChildren(el('p', 'empty-state', 'Loading the outlook…'));
    try {
      await load(false);
      render();
    } catch {
      if (!state.data) root.replaceChildren(el('p', 'outlook-note', L('failed')));
    }
  }

  document.querySelectorAll('[data-outlook-lang]').forEach((button) => button.addEventListener('click', () => setLang(button.dataset.outlookLang)));
  byId('outlookRefresh')?.addEventListener('click', async () => {
    try {
      await load(true);
      render();
    } catch { /* keeps the last outlook */ }
  });

  window.WapkOutlook = { show, hide() {} };
})();
