(() => {
  'use strict';

  // Switches between the weather overview, the map and the health section using the URL hash.
  const byId = (id) => document.getElementById(id);
  const overview = byId('overview');
  const maps = byId('mapsView');
  const health = byId('healthView');
  const HEALTH_HASH = 'healthView';
  const stage = byId('radarMapStage');
  const fullscreenButton = byId('radarFullscreenButton');
  const viewStatus = byId('radarViewStatus');
  const MAPS_HASH = 'mapsView';
  const baseTitle = document.title;
  let mapsVisible = false;
  let healthVisible = false;

  const radar = () => window.AtmosRadar;
  const currentPlace = () => window.Atmos?.place;
  const currentTheme = () => window.Atmos?.theme || document.documentElement.dataset.theme;

  function setStatus(message) {
    viewStatus.textContent = message;
    viewStatus.hidden = !message;
  }

  function markNavigation(hash) {
    const view = hash === MAPS_HASH || hash === HEALTH_HASH ? hash : null;
    const target = view || hash || 'overview';
    document.querySelectorAll('.nav-link[href^="#"]').forEach((link) => {
      const linkTarget = link.getAttribute('href').slice(1);
      const active = view ? linkTarget === view : linkTarget === target || (linkTarget === 'overview' && !['hourlySection', 'weekSection'].includes(target));
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    document.querySelectorAll('.mobile-nav a').forEach((link) => {
      const active = link.getAttribute('href').slice(1) === (view || 'overview');
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
  }

  function showMaps() {
    const wasVisible = mapsVisible;
    mapsVisible = true;
    hideHealth();
    overview.hidden = true;
    maps.hidden = false;
    document.body.classList.add('view-maps');
    document.title = `Lightning map — ${baseTitle}`;
    if (!wasVisible) {
      window.scrollTo({ top: 0, behavior: 'auto' });
      byId('mapsHeading')?.focus({ preventScroll: true });
    }
    if (!radar()) { setStatus('The lightning map could not start. Refresh the page to try again.'); return; }
    setStatus('');
    radar().show({ place: currentPlace(), theme: currentTheme() });
  }

  function showOverview(hash) {
    const wasMaps = mapsVisible || healthVisible;
    mapsVisible = false;
    hideHealth();
    exitFullscreen();
    radar()?.hide();
    maps.hidden = true;
    overview.hidden = false;
    document.body.classList.remove('view-maps');
    document.title = baseTitle;
    if (!wasMaps) return;
    // The target was hidden when the browser tried to jump to it, so scroll after revealing it.
    const target = hash && hash !== 'overview' ? byId(hash) : null;
    if (target) target.scrollIntoView({ block: 'start' });
    else window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function showHealth() {
    const wasVisible = healthVisible;
    healthVisible = true;
    mapsVisible = false;
    exitFullscreen();
    radar()?.hide();
    maps.hidden = true;
    overview.hidden = true;
    health.hidden = false;
    document.body.classList.remove('view-maps');
    document.title = `Health — ${baseTitle}`;
    if (!wasVisible) {
      window.scrollTo({ top: 0, behavior: 'auto' });
      byId('healthHeading')?.focus({ preventScroll: true });
    }
    window.WapkHealth?.show();
  }

  function hideHealth() {
    if (!healthVisible) return;
    healthVisible = false;
    health.hidden = true;
    window.WapkHealth?.hide();
  }

  function route() {
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash === MAPS_HASH) showMaps(); else if (hash === HEALTH_HASH) showHealth(); else showOverview(hash);
    markNavigation(hash);
  }

  function isFullscreen() {
    return document.fullscreenElement === stage || stage.classList.contains('is-pseudo-fullscreen');
  }

  function setPseudoFullscreen(enabled) {
    stage.classList.toggle('is-pseudo-fullscreen', enabled);
    document.body.classList.toggle('radar-pseudo-fullscreen', enabled);
    syncFullscreen();
  }

  function exitFullscreen() {
    if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
    if (stage.classList.contains('is-pseudo-fullscreen')) setPseudoFullscreen(false);
  }

  function syncFullscreen() {
    const active = isFullscreen();
    byId('radarFullscreenLabel').textContent = active ? 'Exit fullscreen' : 'Fullscreen';
    fullscreenButton.setAttribute('aria-label', active ? 'Exit fullscreen map' : 'Enter fullscreen map');
    fullscreenButton.setAttribute('aria-pressed', String(active));
  }

  fullscreenButton.addEventListener('click', () => {
    if (isFullscreen()) { exitFullscreen(); return; }
    // iPhone Safari has no element fullscreen, so fall back to filling the viewport.
    if (stage.requestFullscreen && document.fullscreenEnabled) stage.requestFullscreen().catch(() => setPseudoFullscreen(true));
    else setPseudoFullscreen(true);
  });
  document.addEventListener('fullscreenchange', syncFullscreen);

  // Map settings panel, opened from the button in the map's top-left corner.
  const panel = byId('mapPanel');
  const panelButton = byId('mapPanelButton');
  function setPanelOpen(open, returnFocus) {
    panel.hidden = !open;
    panelButton.setAttribute('aria-expanded', String(open));
    if (open) panel.querySelector('summary')?.focus();
    else if (returnFocus) panelButton.focus();
  }
  panelButton.addEventListener('click', () => setPanelOpen(panel.hidden));
  byId('mapPanelClose').addEventListener('click', () => setPanelOpen(false, true));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) setPanelOpen(false, true);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && stage.classList.contains('is-pseudo-fullscreen')) setPseudoFullscreen(false);
  });

  document.addEventListener('atmos:place', (event) => radar()?.setPlace(event.detail));
  document.addEventListener('atmos:theme', (event) => radar()?.setTheme(event.detail));
  window.addEventListener('hashchange', route);

  if (currentPlace()) radar()?.setPlace(currentPlace());
  syncFullscreen();
  route();
})();
