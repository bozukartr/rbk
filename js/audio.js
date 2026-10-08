// Tiny synthesized sound effects (no audio files needed) + haptics.
let ctx = null, master = null;
let enabled = true;
let lastPop = 0;

export function setSound(on) { enabled = on; if (master) master.gain.value = on ? 0.5 : 0; }
export function soundOn() { return enabled; }

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = enabled ? 0.5 : 0;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function tone(freq, endFreq, dur, type = 'sine', vol = 0.3, delay = 0) {
  if (!ctx || !enabled) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

// size: object fit size (bigger objects -> deeper sound)
export function sfxEat(size) {
  if (!ctx) return;
  const now = performance.now();
  if (now - lastPop < 45) return;
  lastPop = now;
  const base = Math.max(90, 900 / (0.6 + size));
  tone(base * (0.9 + Math.random() * 0.25), base * 0.45, 0.12 + Math.min(0.25, size * 0.03), 'triangle', 0.22);
  if (size > 2.5) tone(base * 0.5, 40, 0.35, 'sine', 0.3);
}

// low thump when something big hits the bottom of the hole
let lastThud = 0;
export function sfxThud(size) {
  if (!ctx) return;
  const now = performance.now();
  if (now - lastThud < 90) return;
  lastThud = now;
  const v = Math.min(0.35, 0.1 + size * 0.04);
  tone(110 / (1 + size * 0.1), 30, 0.35 + Math.min(0.3, size * 0.04), 'sine', v);
}

// knock against the hole's wall
let lastBump = 0;
export function sfxBump(size) {
  if (!ctx) return;
  const now = performance.now();
  if (now - lastBump < 70) return;
  lastBump = now;
  tone(260 / (1 + size * 0.15), 90, 0.09, 'triangle', 0.08);
}

export function sfxLevel() {
  [523, 659, 784, 1046].forEach((f, i) => tone(f, f * 1.01, 0.16, 'square', 0.08, i * 0.07));
}

export function sfxTick(high) { tone(high ? 1200 : 800, high ? 1200 : 800, 0.06, 'square', 0.06); }

export function sfxEnd() {
  [784, 659, 523, 659, 784, 1046].forEach((f, i) => tone(f, f, 0.18, 'triangle', 0.15, i * 0.12));
}

export function sfxClick() { tone(600, 900, 0.05, 'triangle', 0.08); }

export function haptic(ms) {
  if (!enabled) return;
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* ignore */ } }
}
