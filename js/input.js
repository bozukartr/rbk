// Floating virtual joystick (touch / mouse) + keyboard fallback.
// Exposes input.x / input.y in [-1, 1] (screen space, y down) and input.active.
export const input = { x: 0, y: 0, active: false };

const RADIUS = 56;
let pointerId = null, ox = 0, oy = 0;
let base, knob, zone;
const keys = new Set();

export function initInput(zoneEl, baseEl, knobEl) {
  zone = zoneEl; base = baseEl; knob = knobEl;

  zone.addEventListener('pointerdown', e => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    try { zone.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    ox = e.clientX; oy = e.clientY;
    base.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
    knob.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
    base.classList.add('on'); knob.classList.add('on');
    input.active = true; input.x = 0; input.y = 0;
    e.preventDefault();
  }, { passive: false });

  zone.addEventListener('pointermove', e => {
    if (e.pointerId !== pointerId) return;
    let dx = e.clientX - ox, dy = e.clientY - oy;
    const len = Math.hypot(dx, dy);
    // drag the joystick origin along when the finger travels past the rim
    if (len > RADIUS) {
      const k = (len - RADIUS) / len;
      ox += dx * k; oy += dy * k;
      dx = e.clientX - ox; dy = e.clientY - oy;
      base.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
    }
    const l2 = Math.hypot(dx, dy);
    // full speed after a short drag; ease-in curve keeps small corrections precise
    const dead = 4;
    const lin = l2 < dead ? 0 : Math.min(1, (l2 - dead) / (RADIUS * 0.5 - dead));
    const mag = lin * (0.35 + 0.65 * lin);
    input.x = l2 ? (dx / l2) * mag : 0;
    input.y = l2 ? (dy / l2) * mag : 0;
    knob.style.transform = `translate3d(${ox + dx}px, ${oy + dy}px, 0)`;
    e.preventDefault();
  }, { passive: false });

  const end = e => {
    if (e.pointerId !== pointerId) return;
    pointerId = null;
    input.active = false; input.x = 0; input.y = 0;
    base.classList.remove('on'); knob.classList.remove('on');
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
  zone.addEventListener('lostpointercapture', end);

  addEventListener('keydown', e => { keys.add(e.code); });
  addEventListener('keyup', e => { keys.delete(e.code); });
  addEventListener('blur', () => keys.clear());
}

export function resetInput() {
  pointerId = null;
  input.active = false; input.x = 0; input.y = 0;
  base && base.classList.remove('on'); knob && knob.classList.remove('on');
}

// Merge keyboard into the joystick vector each frame.
export function pollKeys() {
  if (input.active) return;
  let x = 0, y = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) y -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) y += 1;
  const l = Math.hypot(x, y);
  input.x = l ? x / l : 0; input.y = l ? y / l : 0;
}

// Block browser gestures that break the "native app" feel:
// pinch / double-tap zoom, long-press callouts, pull-to-refresh, context menu.
export function lockBrowserGestures() {
  const prevent = e => e.preventDefault();
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, prevent, { passive: false }));
  document.addEventListener('dblclick', prevent, { passive: false });
  document.addEventListener('contextmenu', prevent);
  document.addEventListener('selectstart', e => { if (!isField(e.target)) e.preventDefault(); });
  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1 || !isScrollable(e.target)) e.preventDefault();
  }, { passive: false });
  let lastEnd = 0;
  document.addEventListener('touchend', e => {
    const now = e.timeStamp;
    if (now - lastEnd < 350 && !isField(e.target)) e.preventDefault();
    lastEnd = now;
  }, { passive: false });
  addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
}

function isField(el) { return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'); }
function isScrollable(el) { return el && el.closest && el.closest('.scroll'); }
