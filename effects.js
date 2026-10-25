(() => {
  'use strict';

  const glow = document.getElementById('cursorGlow');
  const canvas = document.getElementById('cursorTrail');
  if (!glow || !canvas) return;

  const context = canvas.getContext('2d');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const surfaces = '.card, .current-card, .sidebar-note';
  const particles = [];
  const target = { x: 0, y: 0 };
  const position = { x: 0, y: 0 };
  const previousSpawn = { x: 0, y: 0, time: 0 };
  let enabled = false;
  let active = false;
  let frame = 0;
  let lastFrameTime = 0;
  let width = 0;
  let height = 0;
  let activeSurface = null;
  let surfaceRect = null;
  let surfaceDirty = false;

  // These layers are decorative and must never intercept search or other controls.
  glow.style.pointerEvents = 'none';
  canvas.style.pointerEvents = 'none';
  glow.setAttribute('aria-hidden', 'true');
  canvas.setAttribute('aria-hidden', 'true');

  function clearCanvas() {
    if (context) context.clearRect(0, 0, width, height);
  }

  function clearSurface() {
    if (activeSurface) {
      activeSurface.classList.remove('is-pointer-near');
      activeSurface.style.removeProperty('--spot-x');
      activeSurface.style.removeProperty('--spot-y');
    }
    activeSurface = null;
    surfaceRect = null;
    surfaceDirty = false;
  }

  function stop() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    lastFrameTime = 0;
    active = false;
    particles.length = 0;
    document.body.classList.remove('cursor-active');
    clearCanvas();
    clearSurface();
  }

  function requestFrame() {
    if (!frame && enabled && active && !document.hidden) {
      frame = window.requestAnimationFrame(render);
    }
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    if (context) context.setTransform(ratio, 0, 0, ratio, 0, 0);
    surfaceRect = null;
    surfaceDirty = Boolean(activeSurface);
    requestFrame();
  }

  function updateSurface() {
    if (!activeSurface || !surfaceDirty) return;
    if (!surfaceRect) surfaceRect = activeSurface.getBoundingClientRect();
    const x = target.x - surfaceRect.left;
    const y = target.y - surfaceRect.top;
    if (x < 0 || y < 0 || x > surfaceRect.width || y > surfaceRect.height) {
      clearSurface();
      return;
    }
    activeSurface.style.setProperty('--spot-x', `${x.toFixed(1)}px`);
    activeSurface.style.setProperty('--spot-y', `${y.toFixed(1)}px`);
    activeSurface.classList.add('is-pointer-near');
    surfaceDirty = false;
  }

  function drawParticles(delta) {
    if (!context) return;
    clearCanvas();
    for (let index = particles.length - 1; index >= 0; index -= 1) {
      const particle = particles[index];
      particle.age += delta;
      if (particle.age >= particle.life) {
        particles.splice(index, 1);
        continue;
      }
      particle.x += particle.vx * delta / 16;
      particle.y += particle.vy * delta / 16;
      const opacity = (1 - particle.age / particle.life) ** 2;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size * 2.6, 0, Math.PI * 2);
      context.fillStyle = `rgba(87, 177, 255, ${opacity * 0.13})`;
      context.fill();
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      context.fillStyle = `rgba(140, 226, 255, ${opacity * 0.55})`;
      context.fill();
    }
  }

  function render(time) {
    frame = 0;
    if (!enabled || !active || document.hidden) { stop(); return; }
    const delta = lastFrameTime ? Math.min(time - lastFrameTime, 40) : 16;
    lastFrameTime = time;
    const ease = 1 - Math.exp(-delta / 65);
    position.x += (target.x - position.x) * ease;
    position.y += (target.y - position.y) * ease;
    const moving = Math.abs(target.x - position.x) + Math.abs(target.y - position.y) > 0.2;
    if (!moving) { position.x = target.x; position.y = target.y; }
    glow.style.transform = `translate3d(${position.x.toFixed(2)}px, ${position.y.toFixed(2)}px, 0)`;
    updateSurface();
    drawParticles(delta);
    if (moving || particles.length) requestFrame();
    else lastFrameTime = 0;
  }

  function move(event) {
    if (!enabled || document.hidden || event.pointerType === 'touch') return;
    target.x = event.clientX;
    target.y = event.clientY;
    const time = performance.now();

    if (!active) {
      active = true;
      position.x = target.x;
      position.y = target.y;
      previousSpawn.x = target.x;
      previousSpawn.y = target.y;
      previousSpawn.time = time;
      document.body.classList.add('cursor-active');
    } else if (context && time - previousSpawn.time > 18) {
      const dx = target.x - previousSpawn.x;
      const dy = target.y - previousSpawn.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 10) {
        if (particles.length >= 20) particles.shift();
        particles.push({
          x: target.x, y: target.y,
          vx: -dx / distance * 0.8, vy: -dy / distance * 0.8,
          age: 0, life: 300 + Math.random() * 90, size: 1 + Math.random() * 0.8
        });
        previousSpawn.x = target.x;
        previousSpawn.y = target.y;
        previousSpawn.time = time;
      }
    }

    const surface = event.target instanceof Element ? event.target.closest(surfaces) : null;
    if (surface !== activeSurface) {
      clearSurface();
      activeSurface = surface;
    }
    surfaceDirty = Boolean(activeSurface);
    requestFrame();
  }

  function scroll() {
    if (!activeSurface) return;
    surfaceRect = null;
    surfaceDirty = true;
    requestFrame();
  }

  function visibility() {
    if (document.hidden) stop();
  }

  function configure() {
    const nextEnabled = finePointer.matches && !reducedMotion.matches;
    document.body.classList.toggle('cursor-effects-enabled', nextEnabled);
    if (enabled === nextEnabled) return;
    enabled = nextEnabled;
    stop();
    if (enabled) {
      resize();
      document.addEventListener('pointermove', move, { passive: true });
      document.addEventListener('pointerleave', stop, { passive: true });
      window.addEventListener('blur', stop);
      window.addEventListener('resize', resize, { passive: true });
      window.addEventListener('scroll', scroll, { passive: true, capture: true });
      document.addEventListener('visibilitychange', visibility);
    } else {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerleave', stop);
      window.removeEventListener('blur', stop);
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', scroll, true);
      document.removeEventListener('visibilitychange', visibility);
    }
  }

  reducedMotion.addEventListener('change', configure);
  finePointer.addEventListener('change', configure);
  configure();
})();
