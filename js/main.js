import * as THREE from 'three';
import { buildAssets, ASSETS, makeWindowTexture, makeShadowTexture } from './assets.js';
import { generateCity, roadCenter, N_BLOCKS, HALF, SIZE } from './world.js';
import * as SFX from './audio.js';
import { input, initInput, pollKeys, resetInput, lockBrowserGestures } from './input.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ROUND_TIME = 120;
const CITY_GOAL = 0.8; // endless: share of the city's value to clear before moving on
const STAR_PCT = [8, 18, 30]; // timed: % of the city for 1 / 2 / 3 stars
const GRAVITY = 30;
const CELL = 8;
const GRID_N = Math.ceil(SIZE / CELL) + 2;
const SKINS = ['#00e5ff', '#ff3d7f', '#ffd600', '#76ff03', '#b388ff', '#ff9100', '#ffffff', '#1de9b6', '#ff1744', '#2979ff'];
const QUALITY = [
  { name: 'Düşük', pr: 1, aa: false },
  { name: 'Orta', pr: 1.5, aa: true },
  { name: 'Yüksek', pr: 2, aa: true },
];

const store = {
  get(k, d) { try { const v = localStorage.getItem('od_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('od_' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};

const $ = id => document.getElementById(id);
const tap = (el, fn) => {
  el.addEventListener('pointerup', e => { e.preventDefault(); SFX.unlockAudio(); SFX.sfxClick(); fn(e); });
};

function radiusFor(mass) { return 1.3 + 0.095 * Math.sqrt(mass); }
function levelFor(mass) { return Math.floor(Math.sqrt(mass / 6)) + 1; }
function levelMass(lv) { return (lv - 1) * (lv - 1) * 6; }

// ---------------------------------------------------------------------------
// Renderer / scene
// ---------------------------------------------------------------------------
let quality = store.get('quality', 1);
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: QUALITY[quality].aa, powerPreference: 'high-performance', stencil: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
let maxPR = Math.min(window.devicePixelRatio || 1, QUALITY[quality].pr);
let curPR = maxPR;
renderer.setPixelRatio(curPR);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0xa8dcff);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 120, 360);

const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 900);
camera.position.set(0, 80, 80);

scene.add(new THREE.HemisphereLight(0xffffff, 0x7a9a6a, 2.2));
const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
sun.position.set(-0.5, 1, 0.35);
scene.add(sun);

buildAssets();
const winTex = makeWindowTexture();
const matColor = new THREE.MeshLambertMaterial({ vertexColors: true });
const matWin = new THREE.MeshLambertMaterial({ vertexColors: true, map: winTex });

// Stencil: the hole writes 1, ground & flat decals skip pixels where stencil == 1.
const stencilSkip = { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp };
const groundTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 1400; i++) {
    const v = 225 + Math.random() * 30 | 0;
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(Math.random() * 128 | 0, Math.random() * 128 | 0, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
})();
const matGround = new THREE.MeshLambertMaterial({ vertexColors: true, map: groundTex, ...stencilSkip });
const shadowMats = ['c', 's'].map(k => new THREE.MeshBasicMaterial({
  map: makeShadowTexture(k === 's'), color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false, ...stencilSkip,
}));
const SHADOW_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

// ---------------------------------------------------------------------------
// Instance pools
// ---------------------------------------------------------------------------
const _mat4 = new THREE.Matrix4();
const _col = new THREE.Color();
const frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
let visFrame = 0;

// Instances live in a CPU-side master list; every frame only the ones inside the
// camera frustum are packed into the GPU buffer, so the vertex load scales with
// what is on screen rather than with the whole city. Falling objects are shaded
// darker the deeper they sink, via the per-instance colour.
class Pool {
  constructor(geo, material, cap, key, tinted) {
    cap = Math.max(1, cap);
    this.mesh = new THREE.InstancedMesh(geo, material, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (tinted) { this.mesh.setColorAt(0, _col.set(0xffffff)); this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage); }
    this.mats = new Float32Array(cap * 16);
    this.cols = tinted ? new Float32Array(cap * 3) : null;
    this.owners = [];
    this.n = 0;
    this.key = key;
  }
  add(owner, m, color) {
    const i = this.n++;
    this.owners[i] = owner;
    owner[this.key] = i;
    m.toArray(this.mats, i * 16);
    if (this.cols) (color || _col.set(0xffffff)).toArray(this.cols, i * 3);
  }
  set(i, m) { m.toArray(this.mats, i * 16); }
  remove(i) {
    const last = --this.n;
    const gone = this.owners[i];
    if (i !== last) {
      const mv = this.owners[last];
      this.mats.copyWithin(i * 16, last * 16, last * 16 + 16);
      if (this.cols) this.cols.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.owners[i] = mv; mv[this.key] = i;
    }
    this.owners[last] = null;
    if (gone) gone[this.key] = -1;
  }
  // useVis: shadows reuse the visibility the object pass computed this frame
  compact(useVis) {
    const src = this.mats, dst = this.mesh.instanceMatrix.array, cs = this.cols;
    const cd = cs ? this.mesh.instanceColor.array : null;
    const P = frustum.planes;
    let c = 0;
    for (let k = 0; k < this.n; k++) {
      const o = this.owners[k];
      let vis;
      if (useVis) vis = o.vis === visFrame;
      else if (o.falling) vis = true;
      else {
        vis = true;
        const cy = o.h * 0.5, r = o.cullR;
        for (let p = 0; p < 6; p++) {
          const pl = P[p], nn = pl.normal;
          if (nn.x * o.x + nn.y * cy + nn.z * o.z + pl.constant < -r) { vis = false; break; }
        }
        if (vis) o.vis = visFrame;
      }
      if (!vis) continue;
      const si = k * 16, di = c * 16;
      for (let q = 0; q < 16; q++) dst[di + q] = src[si + q];
      if (cs) {
        const sh = o.falling ? o.shade : 1;
        cd[c * 3] = cs[k * 3] * sh; cd[c * 3 + 1] = cs[k * 3 + 1] * sh; cd[c * 3 + 2] = cs[k * 3 + 2] * sh;
      }
      c++;
    }
    this.mesh.count = c;
    const im = this.mesh.instanceMatrix;
    im.clearUpdateRanges(); im.addUpdateRange(0, Math.max(16, c * 16)); im.needsUpdate = true;
    if (cs) { const ic = this.mesh.instanceColor; ic.clearUpdateRanges(); ic.addUpdateRange(0, Math.max(3, c * 3)); ic.needsUpdate = true; }
  }
}

function cullAndUpload() {
  camera.updateMatrixWorld();
  _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(_pv);
  visFrame++;
  for (const p in pools) pools[p].compact(false);
  shadowPools.c.compact(true);
  shadowPools.s.compact(true);
}

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------
let worldGroup = null;
let pools = {};
let shadowPools = {};
let objects = [];
let movers = [];
let grid = [];
let groundMesh = null;
let totalValue = 1;
const wobbling = new Set();

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _ax = new THREE.Vector3();
const _q2 = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);

function objMatrix(o, m) {
  _q.setFromAxisAngle(_up, o.rot);
  _p.set(o.x, o.y || 0, o.z);
  _s.set(o.scale, o.scale, o.scale);
  return m.compose(_p, _q, _s);
}
function shadowMatrix(o, m) {
  const a = ASSETS[o.type];
  const sq = a.shadow === 's';
  const off = Math.min(1.5, o.h * 0.06);
  _q.setFromAxisAngle(_up, sq ? o.rot : 0);
  _p.set(o.x + off, 0.075, o.z + off * 0.6);
  const k = sq ? 1.25 : 1.15;
  _s.set(a.w * o.scale * k, 1, (sq ? a.d : a.w) * o.scale * k);
  return m.compose(_p, _q, _s);
}

function cellOf(x, z) {
  const cx = Math.max(0, Math.min(GRID_N - 1, Math.floor((x + HALF) / CELL) + 1));
  const cz = Math.max(0, Math.min(GRID_N - 1, Math.floor((z + HALF) / CELL) + 1));
  return cz * GRID_N + cx;
}

function buildWorld(seed) {
  if (worldGroup) {
    scene.remove(worldGroup);
    for (const p of Object.values(pools)) p.mesh.dispose();
    for (const p of Object.values(shadowPools)) p.mesh.dispose();
    groundMesh.geometry.dispose();
  }
  worldGroup = new THREE.Group();
  scene.add(worldGroup);
  const city = generateCity(seed);
  objects = city.objects;
  groundMesh = new THREE.Mesh(city.ground, matGround);
  groundMesh.renderOrder = -5;
  worldGroup.add(groundMesh);

  const counts = {};
  for (const o of objects) counts[o.type] = (counts[o.type] || 0) + 1;
  pools = {}; shadowPools = {};
  for (const [type, n] of Object.entries(counts)) {
    const a = ASSETS[type];
    let mat = matColor;
    if (a.geo.userData.multiMat) mat = a.geo.userData.onlyMat === 1 ? matWin : [matColor, matWin];
    pools[type] = new Pool(a.geo, mat, n, 'slot', true);
    worldGroup.add(pools[type].mesh);
  }
  let nc = 0, ns = 0;
  for (const o of objects) (ASSETS[o.type].shadow === 's' ? ns++ : nc++);
  shadowPools.c = new Pool(SHADOW_GEO, shadowMats[0], nc, 'sslot');
  shadowPools.s = new Pool(SHADOW_GEO, shadowMats[1], ns, 'sslot');
  for (const p of Object.values(shadowPools)) { p.mesh.renderOrder = 1; worldGroup.add(p.mesh); }

  grid = Array.from({ length: GRID_N * GRID_N }, () => []);
  movers = [];
  falling.length = 0;
  wobbling.clear();
  totalValue = 0;
  for (const o of objects) {
    o.alive = true; o.falling = false; o.y = 0; o.vis = 0; o.wob = 0; o.shade = 1;
    o.cullR = Math.max(o.bound, o.h * 0.5) + 0.6;
    if (o.mover) { stepMover(o, 0); movers.push(o); } else { o.cell = cellOf(o.x, o.z); grid[o.cell].push(o); }
    pools[o.type].add(o, objMatrix(o, _mat4), o.tint !== null ? _col.set(o.tint) : null);
    shadowPools[ASSETS[o.type].shadow].add(o, shadowMatrix(o, _mat4));
    totalValue += o.value;
  }
}

function stepMover(o, dt) {
  const m = o.mover;
  if (m.kind === 'car') {
    const L = m.lane, lim = HALF + 70;
    m.t += m.speed * L.dir * dt;
    if (m.t > lim) m.t = -lim; else if (m.t < -lim) m.t = lim;
    if (L.axis === 'x') { o.x = m.t; o.z = L.c; o.rot = L.dir > 0 ? 0 : Math.PI; }
    else { o.z = m.t; o.x = L.c; o.rot = L.dir > 0 ? -Math.PI / 2 : Math.PI / 2; }
    return;
  }
  if (m.kind === 'loop') {
    const b = m.box, w = b.x1 - b.x0, h = b.z1 - b.z0;
    m.t = ((m.t + m.speed * dt) % m.per + m.per) % m.per;
    let t = m.t, dx, dz;
    if (t < w) { o.x = b.x0 + t; o.z = b.z0; dx = 1; dz = 0; }
    else if ((t -= w) < h) { o.x = b.x1; o.z = b.z0 + t; dx = 0; dz = 1; }
    else if ((t -= h) < w) { o.x = b.x1 - t; o.z = b.z1; dx = -1; dz = 0; }
    else { t -= w; o.x = b.x0; o.z = b.z1 - t; dx = 0; dz = -1; }
    if (m.speed < 0) { dx = -dx; dz = -dz; }
    o.rot = Math.atan2(dx, dz);
    o.y = Math.abs(Math.sin(m.t * 6)) * 0.08;
    return;
  }
  // wander
  if (m.wait > 0) { m.wait -= dt; o.y = 0; return; }
  const dx = m.tx - o.x, dz = m.tz - o.z, d = Math.hypot(dx, dz);
  if (d < 0.2) {
    const b = m.box;
    m.tx = b.x0 + 1 + Math.random() * (b.x1 - b.x0 - 2);
    m.tz = b.z0 + 1 + Math.random() * (b.z1 - b.z0 - 2);
    m.wait = Math.random() * 3;
    return;
  }
  const s = Math.min(d, m.speed * (m.panic > 0 ? 1.8 : 1) * dt);
  o.x += dx / d * s; o.z += dz / d * s;
  o.rot = Math.atan2(dx, dz);
  o.y = Math.abs(Math.sin(performance.now() * 0.012 + o.x)) * 0.08;
  if (m.panic > 0) m.panic -= dt;
}

// ---------------------------------------------------------------------------
// The hole
// ---------------------------------------------------------------------------
const STENCIL_GEO = new THREE.CircleGeometry(1, 56).rotateX(-Math.PI / 2);
const RIM_GEO = new THREE.RingGeometry(1, 1.08, 64).rotateX(-Math.PI / 2);
const GLOW_GEO = new THREE.RingGeometry(1.06, 1.32, 64).rotateX(-Math.PI / 2);
const WALL_GEO = (() => {
  const g = new THREE.CylinderGeometry(1, 1, 1, 48, 8, true).translate(0, -0.5, 0);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x343a58), bot = new THREE.Color(0x000000);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.pow(Math.min(1, -pos.getY(i) * 1.5), 0.7);
    _col.copy(top).lerp(bot, t);
    col[i * 3] = _col.r; col[i * 3 + 1] = _col.g; col[i * 3 + 2] = _col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
})();
const BOTTOM_GEO = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
const matStencil = new THREE.MeshBasicMaterial({
  colorWrite: false, depthWrite: false, stencilWrite: true, stencilRef: 1,
  stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
});
const matWall = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false });
const matBottom = new THREE.MeshBasicMaterial({ color: 0x000000, fog: false });

class Hole {
  constructor(color) {
    this.group = new THREE.Group();
    const st = new THREE.Mesh(STENCIL_GEO, matStencil); st.renderOrder = -10;
    this.rimMat = new THREE.MeshBasicMaterial({ color, fog: false });
    this.glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false, fog: false });
    const rim = new THREE.Mesh(RIM_GEO, this.rimMat); rim.position.y = 0.09;
    this.glow = new THREE.Mesh(GLOW_GEO, this.glowMat); this.glow.position.y = 0.085; this.glow.renderOrder = 2;
    this.inner = new THREE.Group();
    this.inner.add(new THREE.Mesh(WALL_GEO, matWall));
    const bottom = new THREE.Mesh(BOTTOM_GEO, matBottom); bottom.position.y = -1;
    this.inner.add(bottom);
    this.flat = new THREE.Group();
    this.flat.add(st, rim, this.glow);
    this.group.add(this.flat, this.inner);
    scene.add(this.group);
    this.reset(0, 0);
  }
  reset(x, z) {
    this.x = x; this.z = z; this.vx = 0; this.vz = 0;
    this.mass = 0; this.r = radiusFor(0);
    this.level = 1; this.pulse = 0;
  }
  get depth() { return 6 + this.r * 4.5; }
  sync(dt) {
    const target = radiusFor(this.mass);
    this.r += (target - this.r) * Math.min(1, dt * 4);
    this.group.position.set(this.x, 0, this.z);
    this.flat.scale.set(this.r, 1, this.r);
    this.inner.scale.set(this.r, this.depth, this.r);
    // rim glow swells briefly whenever something drops in
    this.pulse = Math.max(0, this.pulse - dt * 3);
    const g = 1 + this.pulse * 0.25;
    this.glow.scale.set(g, 1, g);
    this.glowMat.opacity = 0.28 + this.pulse * 0.35;
  }
  dispose() {
    scene.remove(this.group);
    this.rimMat.dispose(); this.glowMat.dispose();
  }
}

let player = null;
const falling = [];

// Falling objects are simulated in world space: they tip over the rim toward the
// centre, tumble, bounce off the hole's wall (which drags them along when the
// hole moves) and darken as they sink before being removed near the bottom.
function startFall(o, h) {
  o.falling = true;
  const dx = o.x - h.x, dz = o.z - h.z;
  const d = Math.hypot(dx, dz) || 0.001;
  const nx = -dx / d, nz = -dz / d; // toward the centre
  const edge = Math.min(1, d / h.r);
  o.vx = h.vx * 0.6 + nx * (0.8 + edge * 1.6);
  o.vz = h.vz * 0.6 + nz * (0.8 + edge * 1.6);
  o.vy = 0;
  if (!o.q) o.q = new THREE.Quaternion();
  o.q.setFromAxisAngle(_up, o.rot);
  // tip toward the centre (axis = up × n), faster for things caught at the edge
  const tip = (1.2 + edge * 2.4 + Math.random() * 0.8) * (1.4 / (1 + o.h * 0.08));
  o.wx = nz * tip + (Math.random() - 0.5) * 0.8;
  o.wy = (Math.random() - 0.5) * 2;
  o.wz = -nx * tip + (Math.random() - 0.5) * 0.8;
  o.ft = 0; o.shade = 1; o.hitWall = 0;
  if (o.wob) { o.wob = 0; wobbling.delete(o); }
  if (o.mover) { const i = movers.indexOf(o); if (i >= 0) { movers[i] = movers[movers.length - 1]; movers.pop(); } }
  else { const c = grid[o.cell]; const i = c.indexOf(o); if (i >= 0) { c[i] = c[c.length - 1]; c.pop(); } }
  shadowPools[ASSETS[o.type].shadow].remove(o.sslot);
  falling.push(o);
  h.mass += o.value;
  score += o.value;
  eatenValue += o.value;
  h.pulse = Math.min(1, h.pulse + 0.15 + o.fit * 0.08);
  SFX.sfxEat(o.fit);
  if (o.fit > 2) SFX.haptic(Math.min(40, 8 + o.fit * 4));
  popupAccum += o.value;
}

function updateFalling(dt) {
  const h = player;
  const depth = h.depth;
  for (let i = falling.length - 1; i >= 0; i--) {
    const o = falling[i];
    o.ft += dt;
    // gravity ramps in over the first moments so objects visibly tip before dropping
    const g = GRAVITY * Math.min(1, 0.35 + o.ft * 2.2);
    o.vy -= g * dt;
    const drag = 1 - Math.min(1, dt * 1.2);
    o.vx *= drag; o.vz *= drag;
    o.x += o.vx * dt; o.y += o.vy * dt; o.z += o.vz * dt;

    // soft wall: keep the body inside the hole's cylinder, bounce off it
    const dx = o.x - h.x, dz = o.z - h.z;
    const d = Math.hypot(dx, dz) || 0.001;
    const maxD = Math.max(0, h.r - o.bound * 0.5 - 0.1);
    if (d > maxD) {
      const ex = d - maxD;
      const k = Math.min(1, dt * 10 + (o.y < -0.5 ? 0.25 : 0));
      o.x -= dx / d * ex * k; o.z -= dz / d * ex * k;
      const rvx = o.vx - h.vx, rvz = o.vz - h.vz;
      const radial = (rvx * dx + rvz * dz) / d;
      if (radial > 0) {
        o.vx -= 1.5 * radial * dx / d; o.vz -= 1.5 * radial * dz / d;
        // a knock against the wall adds tumble
        o.wx += dz / d * radial * 0.6; o.wz -= dx / d * radial * 0.6;
        if (o.y < -1 && radial > 2 && o.hitWall <= 0) { o.hitWall = 0.3; SFX.sfxBump(o.fit); }
      }
    }
    if (o.hitWall > 0) o.hitWall -= dt;

    // rotation
    const wl = Math.hypot(o.wx, o.wy, o.wz);
    if (wl > 7) { const k = 7 / wl; o.wx *= k; o.wy *= k; o.wz *= k; }
    if (wl > 1e-4) {
      _ax.set(o.wx / wl, o.wy / wl, o.wz / wl);
      _q2.setFromAxisAngle(_ax, wl * dt);
      o.q.premultiply(_q2);
    }

    o.shade = Math.max(0.03, Math.min(1, 1 + (o.y + o.h * 0.25) / (depth * 0.6)));
    if (o.y < -depth * 0.95 - o.h * 0.5 || o.ft > 5) {
      if (o.fit > 1.5) SFX.sfxThud(o.fit);
      pools[o.type].remove(o.slot);
      o.alive = false; o.falling = false;
      falling[i] = falling[falling.length - 1]; falling.pop();
      continue;
    }
    _p.set(o.x, o.y, o.z);
    _s.set(o.scale, o.scale, o.scale);
    pools[o.type].set(o.slot, _mat4.compose(_p, o.q, _s));
  }
}

// Too-big objects shake at the rim so the player sees they don't fit yet.
function wobble(o, h) {
  if (!o.wob) wobbling.add(o);
  o.wob = 0.25;
  o.wobX = h.x; o.wobZ = h.z;
}
function updateWobble(dt, t) {
  for (const o of wobbling) {
    o.wob -= dt;
    if (o.wob <= 0 || !o.alive || o.falling) {
      o.wob = 0; wobbling.delete(o);
      if (o.alive && !o.falling) pools[o.type].set(o.slot, objMatrix(o, _mat4));
      continue;
    }
    const dx = o.wobX - o.x, dz = o.wobZ - o.z, d = Math.hypot(dx, dz) || 1;
    const amp = (0.035 + Math.sin(t * 28 + o.x) * 0.025) * Math.min(1, o.wob * 6);
    _ax.set(dz / d, 0, -dx / d);
    _q.setFromAxisAngle(_ax, amp);
    _q2.setFromAxisAngle(_up, o.rot);
    _q.multiply(_q2);
    _p.set(o.x, 0, o.z);
    _s.set(o.scale, o.scale, o.scale);
    pools[o.type].set(o.slot, _mat4.compose(_p, _q, _s));
  }
}

function eatCheck(h) {
  const r = h.r, lim = r * 0.97;
  const reach = r + 4;
  const c0x = Math.floor((h.x - reach + HALF) / CELL) + 1, c1x = Math.floor((h.x + reach + HALF) / CELL) + 1;
  const c0z = Math.floor((h.z - reach + HALF) / CELL) + 1, c1z = Math.floor((h.z + reach + HALF) / CELL) + 1;
  for (let cz = Math.max(0, c0z); cz <= Math.min(GRID_N - 1, c1z); cz++) {
    for (let cx = Math.max(0, c0x); cx <= Math.min(GRID_N - 1, c1x); cx++) {
      const cell = grid[cz * GRID_N + cx];
      for (let k = cell.length - 1; k >= 0; k--) {
        const o = cell[k];
        const dx = o.x - h.x, dz = o.z - h.z, d2 = dx * dx + dz * dz;
        if (o.fit < lim) {
          const rr = r - o.fit * 0.2;
          if (d2 < rr * rr) startFall(o, h);
        } else {
          const near = r + o.bound * 0.35;
          if (d2 < near * near) wobble(o, h);
        }
      }
    }
  }
  for (let k = movers.length - 1; k >= 0; k--) {
    const o = movers[k];
    const dx = o.x - h.x, dz = o.z - h.z;
    if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
    const d2 = dx * dx + dz * dz;
    if (o.fit < lim) {
      const rr = r - o.fit * 0.2;
      if (d2 < rr * rr) { startFall(o, h); continue; }
    }
    if (o.mover.kind === 'wander' && o.fit < lim && d2 < (r + 3) * (r + 3) && !(o.mover.panic > 0)) {
      o.mover.panic = 1.2; o.mover.tx = o.x + dx * 2; o.mover.tz = o.z + dz * 2; o.mover.wait = 0;
    }
  }
}

function holeSpeed(h) { return 8.5 + h.r * 1.15; }

function moveHole(h, dx, dz, mag, dt) {
  const sp = holeSpeed(h) * mag;
  // snappy acceleration, slightly softer stop so it never feels like hitting a wall
  const k = Math.min(1, dt * (mag > 0.05 ? 12 : 8));
  h.vx += (dx * sp - h.vx) * k;
  h.vz += (dz * sp - h.vz) * k;
  h.x += h.vx * dt; h.z += h.vz * dt;
  const lim = HALF - 1.5;
  if (h.x < -lim || h.x > lim) { h.x = Math.max(-lim, Math.min(lim, h.x)); h.vx = 0; }
  if (h.z < -lim || h.z > lim) { h.z = Math.max(-lim, Math.min(lim, h.z)); h.vz = 0; }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
let state = 'menu';
let mode = 'timed';
let timeLeft = ROUND_TIME;
let elapsed = 0;
let score = 0;
let eatenValue = 0;
let cityNum = 1;
let citiesDone = 0;
let transition = 0;
let popupAccum = 0, popupTimer = 0;
let hudTimer = 0;
let lastTick = -1;

const screens = ['menu', 'hud', 'pause', 'over', 'countdown'];
function show(...ids) { for (const s of screens) $(s).classList.toggle('hidden', !ids.includes(s)); }

let skin = store.get('skin', 0);
SFX.setSound(store.get('sound', true));

function buildMenu() {
  const wrap = $('skins');
  wrap.innerHTML = '';
  SKINS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'skin' + (i === skin ? ' sel' : '');
    b.style.setProperty('--c', c);
    tap(b, () => { skin = i; store.set('skin', i); wrap.querySelectorAll('.skin').forEach((el, k) => el.classList.toggle('sel', k === i)); });
    wrap.appendChild(b);
  });
  $('best-timed').textContent = store.get('best_timed', 0);
  $('best-endless').textContent = store.get('best_endless', 0);
  $('btn-sound').textContent = SFX.soundOn() ? '🔊' : '🔇';
  $('btn-quality').textContent = '⚙️ ' + QUALITY[quality].name;
}

const popups = [];
function popup(text, x, y, big) {
  let el = popups.find(p => !p.busy);
  if (!el) {
    if (popups.length > 14) return;
    const d = document.createElement('div'); d.className = 'popup'; $('labels').appendChild(d);
    el = { el: d, busy: false }; popups.push(el);
    d.addEventListener('animationend', () => { el.busy = false; d.style.display = 'none'; });
  }
  el.busy = true;
  el.el.textContent = text;
  el.el.className = 'popup' + (big ? ' big' : '');
  el.el.style.display = 'block';
  el.el.style.left = x + 'px'; el.el.style.top = y + 'px';
  void el.el.offsetWidth;
  el.el.classList.add('go');
}

function banner(text) {
  const b = $('banner');
  b.textContent = text;
  b.classList.remove('go'); void b.offsetWidth; b.classList.add('go');
}

const _proj = new THREE.Vector3();
function toScreen(x, y, z) {
  _proj.set(x, y, z).project(camera);
  return [(_proj.x * 0.5 + 0.5) * innerWidth, (-_proj.y * 0.5 + 0.5) * innerHeight];
}

const fmtTime = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const cityPct = () => eatenValue / totalValue * 100;
function starsFor(pct) { return STAR_PCT.filter(p => pct >= p).length; }

function updateHud() {
  if (mode === 'timed') {
    const t = Math.max(0, Math.ceil(timeLeft));
    $('timer').textContent = fmtTime(t);
    $('timer').classList.toggle('warn', t <= 10);
  } else {
    $('timer').textContent = '🏙️ ' + cityNum;
    $('timer').classList.remove('warn');
  }
  $('score').textContent = score;
  const lv = levelFor(player.mass);
  const a = levelMass(lv), b = levelMass(lv + 1);
  $('level').textContent = 'Lv ' + lv;
  $('lvbar').style.width = ((player.mass - a) / (b - a) * 100).toFixed(1) + '%';

  const pct = cityPct();
  if (mode === 'timed') {
    const s = starsFor(pct);
    $('prog-label').textContent = `Şehir %${pct.toFixed(1)}`;
    $('prog-stars').textContent = '★'.repeat(s) + '☆'.repeat(3 - s);
    $('prog-bar').style.width = Math.min(100, pct / STAR_PCT[2] * 100).toFixed(1) + '%';
  } else {
    const goal = CITY_GOAL * 100;
    $('prog-label').textContent = `Şehir %${pct.toFixed(0)} / %${goal}`;
    $('prog-stars').textContent = fmtTime(elapsed);
    $('prog-bar').style.width = Math.min(100, pct / goal * 100).toFixed(1) + '%';
  }
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------
let countdown = 0;

function newCity(keepScore) {
  buildWorld((Math.random() * 1e9) | 0);
  if (!player) player = new Hole(SKINS[skin]);
  // spawn on a road intersection near the middle so the hole never starts under a building
  const pickRoad = () => roadCenter(2 + ((Math.random() * (N_BLOCKS - 3)) | 0));
  player.reset(pickRoad(), pickRoad());
  eatenValue = 0;
  if (!keepScore) score = 0;
  snapCamera();
}

function startGame(m) {
  mode = m;
  SFX.unlockAudio();
  try { if (matchMedia('(pointer: coarse)').matches && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch (e) { /* ignore */ }

  if (player) { player.dispose(); player = null; }
  cityNum = 1; citiesDone = 0; elapsed = 0;
  newCity(false);
  popupAccum = 0;
  timeLeft = ROUND_TIME;
  lastTick = -1;
  transition = 0;
  countdown = 3.2;
  state = 'countdown';
  resetInput();
  show('hud', 'countdown');
  $('hud').classList.toggle('endless', mode === 'endless');
  updateHud();
}

function cityComplete() {
  citiesDone++;
  state = 'transition';
  transition = 2.2;
  SFX.sfxEnd();
  SFX.haptic([40, 40, 80]);
  banner('ŞEHİR TAMAMLANDI!');
  resetInput();
}

function endGame() {
  state = 'over';
  SFX.sfxEnd();
  const key = mode === 'timed' ? 'best_timed' : 'best_endless';
  const best = store.get(key, 0);
  const isBest = score > best;
  if (isBest) store.set(key, score);
  const pct = cityPct();
  $('over-score').textContent = score;
  $('over-best').textContent = isBest ? '🎉 Yeni rekor!' : `Rekor: ${best}`;
  if (mode === 'timed') {
    const s = starsFor(pct);
    $('over-title').textContent = s === 3 ? 'Muhteşem!' : s === 2 ? 'Harika!' : s === 1 ? 'Güzel!' : 'Süre doldu!';
    $('over-list').innerHTML = `<li class="stars">${'★'.repeat(s)}${'☆'.repeat(3 - s)}</li>
      <li class="solo"><span class="nm">Şehrin <b>%${pct.toFixed(1)}</b>'i yutuldu</span></li>
      <li class="solo"><span class="nm">Seviye <b>${levelFor(player.mass)}</b></span></li>`;
  } else {
    $('over-title').textContent = 'Oyun bitti';
    $('over-list').innerHTML = `<li class="solo"><span class="nm">Tamamlanan şehir: <b>${citiesDone}</b></span></li>
      <li class="solo"><span class="nm">Son şehir: <b>%${pct.toFixed(0)}</b> yutuldu</span></li>
      <li class="solo"><span class="nm">Süre: <b>${fmtTime(elapsed)}</b></span></li>`;
  }
  show('over');
}

function toMenu() {
  if (mode === 'endless' && player && score > store.get('best_endless', 0)) store.set('best_endless', score);
  state = 'menu';
  if (player) { player.dispose(); player = null; }
  falling.length = 0;
  buildMenu();
  show('menu');
}

function pauseGame() {
  if (state !== 'play' && state !== 'countdown') return;
  pausedFrom = state;
  state = 'paused';
  resetInput();
  $('btn-finish').classList.toggle('hidden', mode !== 'endless');
  show('hud', 'pause');
}
let pausedFrom = 'play';

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
const camLook = new THREE.Vector3();
const camGoal = new THREE.Vector3();
function camDist() {
  const asp = innerWidth / innerHeight;
  const portrait = asp < 1 ? 1 + (1 - asp) * 0.55 : 1;
  return (19 + player.r * 5.4) * portrait;
}
function snapCamera() {
  const d = camDist();
  camLook.set(player.x, 0, player.z);
  camera.position.set(player.x, d * 0.95, player.z + d * 0.6);
  camera.lookAt(camLook);
}
function updateCamera(dt) {
  if (!player) {
    const t = performance.now() * 0.00005;
    camera.position.set(Math.cos(t) * 95, 75, Math.sin(t) * 95);
    camLook.set(0, 0, 0);
    camera.lookAt(camLook);
    scene.fog.near = 140; scene.fog.far = 420;
    return;
  }
  const d = camDist();
  const k = 1 - Math.exp(-dt * 5);
  // look a little ahead of the hole so you can see where you're heading
  const lead = 0.22;
  camLook.x += (player.x + player.vx * lead - camLook.x) * k;
  camLook.z += (player.z + player.vz * lead - camLook.z) * k;
  camGoal.set(camLook.x, d * 0.95, camLook.z + d * 0.6);
  camera.position.lerp(camGoal, k);
  camera.lookAt(camLook.x, 0, camLook.z);
  scene.fog.near = d * 2.2;
  scene.fog.far = d * 6.5;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = performance.now();
let fpsAcc = 0, fpsFrames = 0, slowTime = 0;
let simulating = false;
let clock = 0;
const fpsEl = $('fps');
const showFps = /fps/.test(location.search);
if (showFps) fpsEl.classList.remove('hidden');

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  if (dt <= 0 || simulating) return;

  // adaptive resolution: drop pixel ratio if the device can't hold ~50 fps
  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 1) {
    const fps = fpsFrames / fpsAcc;
    if (showFps) fpsEl.textContent = fps.toFixed(0) + ' fps @' + curPR.toFixed(2);
    if (fps < 48 && state === 'play') slowTime++; else slowTime = 0;
    if (slowTime >= 2 && curPR > 1) { curPR = Math.max(1, curPR - 0.25); renderer.setPixelRatio(curPR); resize(); slowTime = 0; }
    fpsAcc = 0; fpsFrames = 0;
  }

  update(dt);
  updateCamera(dt);
  cullAndUpload();
  renderer.render(scene, camera);
}

function update(dt) {
  clock += dt;
  if (state !== 'paused' && state !== 'over') {
    for (const o of movers) {
      stepMover(o, dt);
      pools[o.type].set(o.slot, objMatrix(o, _mat4));
      shadowPools[ASSETS[o.type].shadow].set(o.sslot, shadowMatrix(o, _mat4));
    }
  }

  if (state === 'countdown') {
    const before = Math.ceil(countdown);
    countdown -= dt;
    const n = Math.ceil(countdown);
    $('countdown').textContent = n > 0 ? n : 'BAŞLA!';
    if (n !== before && n > 0) SFX.sfxTick(false);
    if (countdown <= -0.4) { state = 'play'; show('hud'); SFX.sfxTick(true); }
    player.sync(dt);
  } else if (state === 'play') {
    if (mode === 'timed') {
      timeLeft -= dt;
      const secs = Math.ceil(timeLeft);
      if (secs <= 10 && secs !== lastTick && secs > 0) { lastTick = secs; SFX.sfxTick(secs <= 3); }
    } else elapsed += dt;
    pollKeys();
    const mag = Math.hypot(input.x, input.y);
    moveHole(player, mag ? input.x / mag : 0, mag ? input.y / mag : 0, Math.min(1, mag), dt);
    eatCheck(player);
    player.sync(dt);
    const lv = levelFor(player.mass);
    if (lv > player.level) {
      player.level = lv;
      SFX.sfxLevel(); banner('SEVİYE ' + lv + '!'); SFX.haptic(25);
    }
    popupTimer -= dt;
    if (popupAccum > 0 && popupTimer <= 0) {
      const [x, y] = toScreen(player.x, 0, player.z - player.r * 0.3);
      popup('+' + popupAccum, x + (Math.random() - 0.5) * 40, y - 30, popupAccum >= 40);
      popupAccum = 0; popupTimer = 0.18;
    }
    hudTimer -= dt;
    if (hudTimer <= 0) { updateHud(); hudTimer = 0.25; }
    if (mode === 'timed' && timeLeft <= 0) { updateHud(); endGame(); }
    else if (mode === 'endless' && eatenValue >= totalValue * CITY_GOAL) { updateHud(); cityComplete(); }
  } else if (state === 'transition') {
    moveHole(player, 0, 0, 0, dt);
    player.sync(dt);
    transition -= dt;
    if (transition <= 0) {
      cityNum++;
      newCity(true);
      countdown = 3.2;
      state = 'countdown';
      show('hud', 'countdown');
      updateHud();
    }
  }

  if (player && state !== 'paused') { updateFalling(dt); updateWobble(dt, clock); }
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w / h < 1 ? 58 : 50;
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
lockBrowserGestures();
initInput($('touch'), $('joy-base'), $('joy-knob'));
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 200));
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });

tap($('btn-timed'), () => startGame('timed'));
tap($('btn-endless'), () => startGame('endless'));
tap($('btn-pause'), pauseGame);
tap($('btn-resume'), () => { state = pausedFrom; show('hud'); if (state === 'countdown') $('countdown').classList.remove('hidden'); });
tap($('btn-restart'), () => startGame(mode));
tap($('btn-finish'), endGame);
tap($('btn-quit'), toMenu);
tap($('btn-again'), () => startGame(mode));
tap($('btn-home'), toMenu);
tap($('btn-sound'), () => { SFX.setSound(!SFX.soundOn()); store.set('sound', SFX.soundOn()); $('btn-sound').textContent = SFX.soundOn() ? '🔊' : '🔇'; });
tap($('btn-quality'), () => {
  const prevAA = QUALITY[quality].aa;
  quality = (quality + 1) % QUALITY.length;
  store.set('quality', quality);
  if (QUALITY[quality].aa !== prevAA) { location.reload(); return; } // antialias is fixed at context creation
  maxPR = Math.min(window.devicePixelRatio || 1, QUALITY[quality].pr);
  curPR = maxPR;
  renderer.setPixelRatio(curPR);
  resize();
  $('btn-quality').textContent = '⚙️ ' + QUALITY[quality].name;
});

buildWorld((Math.random() * 1e9) | 0);
buildMenu();
resize();
show('menu');
requestAnimationFrame(t => { last = t; frame(t); });
$('loading').classList.add('hidden');

// Test hook (?debug): fast-forward the simulation without rendering, with a
// simple autopilot standing in for a player.
if (/debug/.test(location.search)) {
  const autopilot = () => {
    const h = player, lim = h.r * 0.95, R = 24;
    let best = null, bestS = 0;
    for (let cz = 0; cz < GRID_N; cz++) for (let cx = 0; cx < GRID_N; cx++) {
      const cell = grid[cz * GRID_N + cx];
      let sum = 0, item = null;
      for (const o of cell) if (o.fit < lim) { sum += o.value; item = o; }
      if (!item) continue;
      const d = Math.hypot(item.x - h.x, item.z - h.z);
      if (d > R * 3) continue;
      const s = sum / (d + 6);
      if (s > bestS) { bestS = s; best = item; }
    }
    if (!best) { input.x = -h.x / HALF; input.y = -h.z / HALF; return; }
    const dx = best.x - h.x, dz = best.z - h.z, d = Math.hypot(dx, dz) || 1;
    input.x = dx / d; input.y = dz / d;
  };
  window.__od = {
    startGame, input, get state() { return state; }, get player() { return player; }, get falling() { return falling; },
    get pct() { return cityPct(); }, get score() { return score; }, get city() { return cityNum; },
    sim(seconds, auto = false, step = 1 / 60) {
      simulating = true;
      const t0 = performance.now();
      let think = 0;
      for (let t = 0; t < seconds && state !== 'over'; t += step) {
        if (auto && state === 'play' && (think -= step) <= 0) { autopilot(); input.active = true; think = 0.3; }
        update(step);
      }
      if (auto) { input.active = false; input.x = input.y = 0; }
      simulating = false;
      return performance.now() - t0;
    },
  };
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
