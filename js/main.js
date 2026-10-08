import * as THREE from 'three';
import { buildAssets, ASSETS, makeWindowTexture, makeShadowTexture } from './assets.js';
import { generateCity, HALF, SIZE } from './world.js';
import * as SFX from './audio.js';
import { input, initInput, pollKeys, resetInput, lockBrowserGestures } from './input.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ROUND_TIME = 120;
const BOT_COUNT = 7;
const START_MASS = 0;
const CELL = 8;
const GRID_N = Math.ceil(SIZE / CELL) + 2;
const SKINS = ['#00e5ff', '#ff3d7f', '#ffd600', '#76ff03', '#b388ff', '#ff9100', '#ffffff', '#1de9b6', '#ff1744', '#2979ff'];
const BOT_NAMES = ['Girdap', 'Vakum', 'Kara Delik', 'Hortum', 'Mıknatıs', 'Tsunami', 'Kaos', 'Obur', 'Nebula', 'Tayfun', 'Pacman', 'Kasırga', 'Gölge', 'Kuyu', 'Anafor'];
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

function radiusFor(mass) { return 1.25 + 0.12 * Math.sqrt(mass); }
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

// Stencil: holes write 1, ground & flat decals skip pixels where stencil == 1.
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
// Instance pools (swap-remove keeps draw counts tight as objects get eaten)
// ---------------------------------------------------------------------------
const _mat4 = new THREE.Matrix4();
const _col = new THREE.Color();
const frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
let visFrame = 0;

// Instances live in a CPU-side master list; every frame only the ones inside the
// camera frustum are packed into the GPU buffer, so the vertex load scales with
// what is on screen rather than with the whole city.
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
  // shadows: reuse the visibility the object pass computed this frame
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
      if (cs) { cd[c * 3] = cs[k * 3]; cd[c * 3 + 1] = cs[k * 3 + 1]; cd[c * 3 + 2] = cs[k * 3 + 2]; }
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
    pools[type] = new Pool(a.geo, mat, n, 'slot', a.tint);
    worldGroup.add(pools[type].mesh);
  }
  let nc = 0, ns = 0;
  for (const o of objects) (ASSETS[o.type].shadow === 's' ? ns++ : nc++);
  shadowPools.c = new Pool(SHADOW_GEO, shadowMats[0], nc, 'sslot');
  shadowPools.s = new Pool(SHADOW_GEO, shadowMats[1], ns, 'sslot');
  for (const p of Object.values(shadowPools)) { p.mesh.renderOrder = 1; worldGroup.add(p.mesh); }

  grid = Array.from({ length: GRID_N * GRID_N }, () => []);
  movers = [];
  totalValue = 0;
  for (const o of objects) {
    o.alive = true; o.falling = false; o.y = 0; o.vis = 0;
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
  const s = Math.min(d, m.speed * (m.panic > 0 ? 2.6 : 1) * dt);
  o.x += dx / d * s; o.z += dz / d * s;
  o.rot = Math.atan2(dx, dz);
  o.y = Math.abs(Math.sin(performance.now() * 0.012 + o.x)) * 0.08;
  if (m.panic > 0) m.panic -= dt;
}

// ---------------------------------------------------------------------------
// Holes
// ---------------------------------------------------------------------------
const STENCIL_GEO = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
const RIM_GEO = new THREE.RingGeometry(1, 1.08, 64).rotateX(-Math.PI / 2);
const GLOW_GEO = new THREE.RingGeometry(1.06, 1.32, 64).rotateX(-Math.PI / 2);
const WALL_GEO = (() => {
  const g = new THREE.CylinderGeometry(1, 1, 1, 40, 4, true).translate(0, -0.5, 0);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x2a2f45), bot = new THREE.Color(0x000000);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.pow(Math.min(1, -pos.getY(i) * 2.2), 0.6);
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
  constructor(name, color, isPlayer) {
    this.name = name;
    this.color = color;
    this.isPlayer = isPlayer;
    this.group = new THREE.Group();
    const st = new THREE.Mesh(STENCIL_GEO, matStencil); st.renderOrder = -10;
    this.rimMat = new THREE.MeshBasicMaterial({ color, fog: false });
    this.glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false, fog: false });
    const rim = new THREE.Mesh(RIM_GEO, this.rimMat); rim.position.y = 0.09;
    const glow = new THREE.Mesh(GLOW_GEO, this.glowMat); glow.position.y = 0.085; glow.renderOrder = 2;
    this.inner = new THREE.Group();
    this.inner.add(new THREE.Mesh(WALL_GEO, matWall));
    const bottom = new THREE.Mesh(BOTTOM_GEO, matBottom); bottom.position.y = -1;
    this.inner.add(bottom);
    this.flat = new THREE.Group();
    this.flat.add(st, rim, glow);
    this.group.add(this.flat, this.inner);
    scene.add(this.group);
    this.label = document.createElement('div');
    this.label.className = 'hole-label' + (isPlayer ? ' me' : '');
    this.label.innerHTML = `<span class="crown">👑</span><span class="nm"></span>`;
    this.label.querySelector('.nm').textContent = name;
    this.label.style.setProperty('--c', color);
    $('labels').appendChild(this.label);
    this.skill = isPlayer ? 1 : 0.74 + Math.random() * 0.2;
    this.reset(0, 0);
    this.score = 0;
  }
  reset(x, z) {
    this.x = x; this.z = z; this.vx = 0; this.vz = 0;
    this.mass = START_MASS; this.r = radiusFor(this.mass);
    this.alive = true; this.respawn = 0; this.invuln = 2.5;
    this.ai = { t: 0, tx: x, tz: z, target: null, wobble: Math.random() * 10 };
    this.level = levelFor(this.mass);
    this.kills = 0;
    this.group.visible = true;
  }
  get depth() { return 3 + this.r * 3.5; }
  sync(dt) {
    const target = radiusFor(this.mass);
    this.r += (target - this.r) * Math.min(1, dt * 4);
    this.group.position.set(this.x, 0, this.z);
    this.flat.scale.set(this.r, 1, this.r);
    this.inner.scale.set(this.r, this.depth, this.r);
    if (this.invuln > 0) {
      this.invuln -= dt;
      this.rimMat.opacity = 1;
      this.flat.children[1].visible = Math.floor(this.invuln * 8) % 2 === 0 || this.invuln <= 0;
    } else this.flat.children[1].visible = true;
  }
  dispose() {
    scene.remove(this.group);
    this.label.remove();
    this.rimMat.dispose(); this.glowMat.dispose();
  }
}

let holes = [];
let player = null;
const falling = [];

function startFall(o, h) {
  o.falling = true;
  o.eater = h;
  o.fx = o.x - h.x; o.fz = o.z - h.z;
  o.vy = 0; o.tilt = 0; o.ft = 0;
  const d = Math.hypot(o.fx, o.fz) || 1;
  o.ax = -o.fz / d; o.az = o.fx / d; // tilt axis = up x dirToCentre
  o.ax = (-o.fz / d); o.az = (o.fx / d);
  o.tiltSpeed = 2.5 + Math.random() * 2;
  o.spin = (Math.random() - 0.5) * 3;
  if (o.mover) { const i = movers.indexOf(o); if (i >= 0) { movers[i] = movers[movers.length - 1]; movers.pop(); } }
  else { const c = grid[o.cell]; const i = c.indexOf(o); if (i >= 0) { c[i] = c[c.length - 1]; c.pop(); } }
  shadowPools[ASSETS[o.type].shadow].remove(o.sslot);
  falling.push(o);
  h.mass += o.value;
  h.score += o.value;
  if (h.isPlayer) {
    eatenValue += o.value;
    SFX.sfxEat(o.fit);
    if (o.fit > 2) SFX.haptic(Math.min(40, 8 + o.fit * 4));
    popupAccum += o.value;
  }
}

function updateFalling(dt) {
  for (let i = falling.length - 1; i >= 0; i--) {
    const o = falling[i];
    const h = o.eater;
    o.ft += dt;
    // drift toward the hole centre so things drop cleanly inside the rim
    const pull = Math.min(1, dt * 2.5);
    const maxOff = Math.max(0, h.r - o.bound * 0.5);
    const d = Math.hypot(o.fx, o.fz);
    if (d > maxOff) { o.fx *= 1 - pull; o.fz *= 1 - pull; } else { o.fx *= 1 - pull * 0.3; o.fz *= 1 - pull * 0.3; }
    o.vy -= 32 * dt;
    o.y += o.vy * dt;
    o.tilt = Math.min(1.5, o.tilt + o.tiltSpeed * dt);
    o.rot += o.spin * dt;
    const done = o.y < -h.depth - o.h || o.ft > 3 || !h.alive;
    if (done) {
      pools[o.type].remove(o.slot);
      o.alive = false; o.falling = false;
      falling[i] = falling[falling.length - 1]; falling.pop();
      continue;
    }
    _ax.set(o.ax, 0, o.az);
    _q.setFromAxisAngle(_ax, -o.tilt);
    _q2.setFromAxisAngle(_up, o.rot);
    _q.multiply(_q2);
    _p.set(h.x + o.fx, o.y, h.z + o.fz);
    _s.set(o.scale, o.scale, o.scale);
    pools[o.type].set(o.slot, _mat4.compose(_p, _q, _s));
  }
}

function eatCheck(h) {
  const r = h.r, lim = r * 0.95;
  const c0x = Math.floor((h.x - r + HALF) / CELL) + 1, c1x = Math.floor((h.x + r + HALF) / CELL) + 1;
  const c0z = Math.floor((h.z - r + HALF) / CELL) + 1, c1z = Math.floor((h.z + r + HALF) / CELL) + 1;
  for (let cz = Math.max(0, c0z); cz <= Math.min(GRID_N - 1, c1z); cz++) {
    for (let cx = Math.max(0, c0x); cx <= Math.min(GRID_N - 1, c1x); cx++) {
      const cell = grid[cz * GRID_N + cx];
      for (let k = cell.length - 1; k >= 0; k--) {
        const o = cell[k];
        if (o.fit >= lim) continue;
        const dx = o.x - h.x, dz = o.z - h.z, rr = r - o.fit * 0.35;
        if (dx * dx + dz * dz < rr * rr) startFall(o, h);
      }
    }
  }
  for (let k = movers.length - 1; k >= 0; k--) {
    const o = movers[k];
    if (o.fit >= lim) continue;
    const dx = o.x - h.x, dz = o.z - h.z, rr = r - o.fit * 0.35;
    const d2 = dx * dx + dz * dz;
    if (d2 < rr * rr) startFall(o, h);
    else if (o.mover.kind === 'wander' && d2 < (r + 5) * (r + 5)) o.mover.panic = 1.5, o.mover.tx = o.x + dx * 3, o.mover.tz = o.z + dz * 3, o.mover.wait = 0;
  }
}

// ---------------------------------------------------------------------------
// Bot AI
// ---------------------------------------------------------------------------
function botThink(h) {
  const ai = h.ai;
  ai.t = 0.35 + Math.random() * 0.35;
  let fx = 0, fz = 0, threat = false;
  let preyHole = null, preyD = 1e9;
  for (const o of holes) {
    if (o === h || !o.alive) continue;
    const d = Math.hypot(o.x - h.x, o.z - h.z);
    if (o.r > h.r * 1.12 && d < o.r + 16 && h.invuln <= 0) {
      fx += (h.x - o.x) / (d + 0.1); fz += (h.z - o.z) / (d + 0.1); threat = true;
    } else if (h.r > o.r * 1.2 && o.invuln <= 0 && d < 28 && d < preyD) { preyHole = o; preyD = d; }
  }
  if (threat) {
    const l = Math.hypot(fx, fz) || 1;
    ai.tx = h.x + fx / l * 20; ai.tz = h.z + fz / l * 20; ai.target = null;
    return;
  }
  if (preyHole && Math.random() < 0.8) { ai.target = preyHole; return; }
  ai.target = null;
  // pick the most rewarding reachable prop nearby
  const lim = h.r * 0.93;
  const R = 26;
  let best = null, bestS = 0;
  const c0x = Math.floor((h.x - R + HALF) / CELL) + 1, c1x = Math.floor((h.x + R + HALF) / CELL) + 1;
  const c0z = Math.floor((h.z - R + HALF) / CELL) + 1, c1z = Math.floor((h.z + R + HALF) / CELL) + 1;
  for (let cz = Math.max(0, c0z); cz <= Math.min(GRID_N - 1, c1z); cz += 1) {
    for (let cx = Math.max(0, c0x); cx <= Math.min(GRID_N - 1, c1x); cx += 1) {
      const cell = grid[cz * GRID_N + cx];
      if (!cell.length) continue;
      // score the whole cell: sum of edible value, aim at its richest item
      let sum = 0, item = null, iv = 0;
      for (const o of cell) if (o.fit < lim) { sum += o.value; if (o.value > iv) { iv = o.value; item = o; } }
      if (!item) continue;
      const d = Math.hypot(item.x - h.x, item.z - h.z);
      const s = sum / (d + 6) * (0.75 + Math.random() * 0.5);
      if (s > bestS) { bestS = s; best = item; }
    }
  }
  if (best && Math.random() < h.skill + 0.05) { ai.tx = best.x; ai.tz = best.z; }
  else if (Math.random() < 0.5 || Math.hypot(ai.tx - h.x, ai.tz - h.z) < 3) {
    ai.tx = (Math.random() - 0.5) * SIZE * 0.85; ai.tz = (Math.random() - 0.5) * SIZE * 0.85;
  }
}

function holeSpeed(h) { return 7.2 + h.r * 0.95; }

function moveHole(h, dx, dz, mag, dt) {
  const sp = holeSpeed(h) * mag;
  const k = Math.min(1, dt * 9);
  h.vx += (dx * sp - h.vx) * k;
  h.vz += (dz * sp - h.vz) * k;
  h.x += h.vx * dt; h.z += h.vz * dt;
  const lim = HALF - 1.5;
  h.x = Math.max(-lim, Math.min(lim, h.x));
  h.z = Math.max(-lim, Math.min(lim, h.z));
}

function updateBot(h, dt) {
  const ai = h.ai;
  ai.t -= dt;
  if (ai.t <= 0) botThink(h);
  if (ai.target) {
    if (!ai.target.alive || ai.target.r * 1.2 > h.r) ai.target = null;
    else { ai.tx = ai.target.x; ai.tz = ai.target.z; }
  }
  let dx = ai.tx - h.x, dz = ai.tz - h.z;
  const d = Math.hypot(dx, dz);
  ai.wobble += dt;
  if (d > 0.3) {
    dx /= d; dz /= d;
    const w = Math.sin(ai.wobble * 1.7) * 0.25;
    const cx = dx * Math.cos(w) - dz * Math.sin(w), cz = dx * Math.sin(w) + dz * Math.cos(w);
    moveHole(h, cx, cz, Math.min(1, d / 2) * h.skill, dt);
  } else moveHole(h, 0, 0, 0, dt);
}

function holeVsHole() {
  for (const a of holes) {
    if (!a.alive) continue;
    for (const b of holes) {
      if (a === b || !b.alive || b.invuln > 0 || a.r < b.r * 1.15) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < a.r - b.r * 0.4) eatHole(a, b);
    }
  }
}

function eatHole(a, b) {
  b.alive = false;
  b.respawn = 3;
  b.group.visible = false;
  const gain = Math.round(b.mass * 0.5) + 30;
  a.mass += gain;
  a.score += Math.round(b.score * 0.25) + 50;
  a.kills++;
  b.mass = Math.round(b.mass * 0.4);
  feed(`<b style="color:${a.color}">${esc(a.name)}</b> ➜ <b style="color:${b.color}">${esc(b.name)}</b>'ı yuttu!`);
  if (a.isPlayer) { SFX.sfxGulpHole(); SFX.haptic(60); popupAccum += Math.round(b.score * 0.25) + 50; }
  if (b.isPlayer) { SFX.sfxGulpHole(); SFX.haptic([80, 60, 80]); showEaten(a.name); }
}

function respawnHole(h) {
  let best = null, bestD = -1;
  for (let i = 0; i < 12; i++) {
    const x = (Math.random() - 0.5) * SIZE * 0.85, z = (Math.random() - 0.5) * SIZE * 0.85;
    let md = 1e9;
    for (const o of holes) if (o !== h && o.alive) md = Math.min(md, Math.hypot(o.x - x, o.z - z) - o.r);
    if (md > bestD) { bestD = md; best = [x, z]; }
  }
  const m = h.mass;
  h.reset(best[0], best[1]);
  h.mass = m;
  h.r = radiusFor(m);
  h.level = levelFor(m);
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = 'menu';
let mode = 'arena';
let timeLeft = ROUND_TIME;
let eatenValue = 0;
let popupAccum = 0, popupTimer = 0;
let hudTimer = 0;
let lastTick = -1;

const screens = ['menu', 'hud', 'pause', 'over', 'countdown', 'eaten'];
function show(...ids) { for (const s of screens) $(s).classList.toggle('hidden', !ids.includes(s)); }

let skin = store.get('skin', 0);
let playerName = store.get('name', '');
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
  $('name').value = playerName;
  $('best-arena').textContent = store.get('best_arena', 0);
  $('best-solo').textContent = store.get('best_solo', 0);
  $('btn-sound').textContent = SFX.soundOn() ? '🔊' : '🔇';
  $('btn-quality').textContent = '⚙️ ' + QUALITY[quality].name;
}

function feed(html) {
  const el = document.createElement('div');
  el.className = 'feed-item';
  el.innerHTML = html;
  $('feed').prepend(el);
  setTimeout(() => el.remove(), 3200);
  while ($('feed').children.length > 3) $('feed').lastChild.remove();
}

function showEaten(by) {
  $('eaten-by').textContent = by;
  $('eaten').classList.remove('hidden');
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
  return [(_proj.x * 0.5 + 0.5) * innerWidth, (-_proj.y * 0.5 + 0.5) * innerHeight, _proj.z < 1];
}

function updateLabels() {
  let leader = null;
  for (const h of holes) if (h.alive && (!leader || h.score > leader.score)) leader = h;
  for (const h of holes) {
    if (!h.alive || state === 'menu') { h.label.style.display = 'none'; continue; }
    const [x, y, vis] = toScreen(h.x, 0, h.z + h.r * 1.05);
    if (!vis || x < -100 || x > innerWidth + 100 || y < -50 || y > innerHeight + 50) { h.label.style.display = 'none'; continue; }
    h.label.style.display = 'block';
    h.label.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, 0)`;
    h.label.classList.toggle('lead', h === leader && mode === 'arena');
  }
}

function updateHud() {
  const t = Math.max(0, Math.ceil(timeLeft));
  $('timer').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  $('timer').classList.toggle('warn', t <= 10);
  $('score').textContent = player.score;
  const lv = levelFor(player.mass);
  const a = levelMass(lv), b = levelMass(lv + 1);
  $('level').textContent = 'Lv ' + lv;
  $('lvbar').style.width = ((player.mass - a) / (b - a) * 100).toFixed(1) + '%';
  if (mode === 'arena') {
    const sorted = holes.slice().sort((p, q) => q.score - p.score);
    const rank = sorted.indexOf(player) + 1;
    const rows = sorted.slice(0, 5).map((h, i) =>
      `<li class="${h.isPlayer ? 'me' : ''}"><span class="rk">${i + 1}</span><i style="background:${h.color}"></i><span class="nm">${esc(h.name)}</span><span class="sc">${h.score}</span></li>`);
    if (rank > 5) rows.push(`<li class="me"><span class="rk">${rank}</span><i style="background:${player.color}"></i><span class="nm">${esc(player.name)}</span><span class="sc">${player.score}</span></li>`);
    $('board').innerHTML = rows.join('');
  } else {
    const pct = eatenValue / totalValue * 100;
    $('board').innerHTML = `<li class="me solo"><span class="nm">Şehir yutuldu</span><span class="sc">%${pct.toFixed(1)}</span></li>`;
  }
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------
let countdown = 0;

function startGame(m) {
  mode = m;
  playerName = ($('name').value || '').trim().slice(0, 14) || 'Sen';
  store.set('name', playerName === 'Sen' ? '' : playerName);
  SFX.unlockAudio();
  try { if (matchMedia('(pointer: coarse)').matches && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {}); } catch (e) { /* ignore */ }

  for (const h of holes) h.dispose();
  holes = [];
  falling.length = 0;
  buildWorld((Math.random() * 1e9) | 0);

  const myColor = SKINS[skin];
  player = new Hole(playerName, myColor, true);
  holes.push(player);
  if (mode === 'arena') {
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    const colors = SKINS.filter(c => c !== myColor).sort(() => Math.random() - 0.5);
    for (let i = 0; i < BOT_COUNT; i++) holes.push(new Hole(names[i], colors[i % colors.length], false));
  }
  // spread spawns around a ring
  const n = holes.length;
  const off = Math.random() * Math.PI * 2;
  holes.forEach((h, i) => {
    const a = off + (i / n) * Math.PI * 2;
    const rad = i === 0 && n === 1 ? 0 : SIZE * 0.3;
    h.reset(Math.cos(a) * rad, Math.sin(a) * rad);
    h.score = 0;
  });
  eatenValue = 0; popupAccum = 0;
  timeLeft = ROUND_TIME;
  lastTick = -1;
  countdown = 3.2;
  state = 'countdown';
  resetInput();
  $('feed').innerHTML = '';
  show('hud', 'countdown');
  $('hud').classList.toggle('solo', mode === 'solo');
  snapCamera();
  updateHud();
}

function endGame() {
  state = 'over';
  SFX.sfxEnd();
  const sorted = holes.slice().sort((p, q) => q.score - p.score);
  const rank = sorted.indexOf(player) + 1;
  const key = mode === 'arena' ? 'best_arena' : 'best_solo';
  const best = store.get(key, 0);
  const isBest = player.score > best;
  if (isBest) store.set(key, player.score);
  $('over-title').textContent = mode === 'arena' ? (rank === 1 ? '🏆 Birinci oldun!' : `${rank}. oldun`) : 'Süre doldu!';
  $('over-score').textContent = player.score;
  $('over-best').textContent = isBest ? '🎉 Yeni rekor!' : `Rekor: ${best}`;
  if (mode === 'arena') {
    $('over-list').innerHTML = sorted.map((h, i) =>
      `<li class="${h.isPlayer ? 'me' : ''}"><span class="rk">${i + 1}</span><i style="background:${h.color}"></i><span class="nm">${esc(h.name)}</span><span class="sc">${h.score}</span></li>`).join('');
  } else {
    const pct = eatenValue / totalValue * 100;
    const stars = pct >= 20 ? 3 : pct >= 12 ? 2 : pct >= 5 ? 1 : 0;
    $('over-list').innerHTML = `<li class="me solo"><span class="nm">Şehrin <b>%${pct.toFixed(1)}</b>'i yutuldu</span></li><li class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</li>`;
  }
  show('over');
  for (const h of holes) h.label.style.display = 'none';
}

function toMenu() {
  state = 'menu';
  for (const h of holes) h.dispose();
  holes = []; player = null; falling.length = 0;
  buildMenu();
  show('menu');
}

function pauseGame() {
  if (state !== 'play' && state !== 'countdown') return;
  state = 'paused';
  resetInput();
  show('hud', 'pause');
}

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
  if (state === 'menu') {
    const t = performance.now() * 0.00005;
    camera.position.set(Math.cos(t) * 95, 75, Math.sin(t) * 95);
    camLook.set(0, 0, 0);
    camera.lookAt(camLook);
    scene.fog.near = 140; scene.fog.far = 420;
    return;
  }
  const d = camDist();
  const k = 1 - Math.exp(-dt * 6);
  camLook.x += (player.x - camLook.x) * k;
  camLook.z += (player.z - camLook.z) * k;
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
const fpsEl = $('fps');
const showFps = /fps/.test(location.search);
if (showFps) fpsEl.classList.remove('hidden');

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  if (dt <= 0) return;
  if (simulating) return;

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
  updateLabels();
  cullAndUpload();
  renderer.render(scene, camera);
}

function update(dt) {
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
    for (const h of holes) h.sync(dt);
  } else if (state === 'play') {
    timeLeft -= dt;
    const secs = Math.ceil(timeLeft);
    if (secs <= 10 && secs !== lastTick && secs > 0) { lastTick = secs; SFX.sfxTick(secs <= 3); }
    pollKeys();
    if (player.alive) {
      const mag = Math.hypot(input.x, input.y);
      moveHole(player, mag ? input.x / mag : 0, mag ? input.y / mag : 0, mag, dt);
    }
    for (const h of holes) {
      if (!h.alive) {
        h.respawn -= dt;
        if (h.respawn <= 0) { respawnHole(h); if (h.isPlayer) $('eaten').classList.add('hidden'); }
        continue;
      }
      if (!h.isPlayer) updateBot(h, dt);
      eatCheck(h);
      h.sync(dt);
      const lv = levelFor(h.mass);
      if (lv > h.level) {
        h.level = lv;
        if (h.isPlayer) { SFX.sfxLevel(); banner('SEVİYE ' + lv + '!'); SFX.haptic(25); }
      }
    }
    if (holes.length > 1) holeVsHole();
    popupTimer -= dt;
    if (popupAccum > 0 && popupTimer <= 0) {
      const [x, y] = toScreen(player.x, 0, player.z - player.r * 0.3);
      popup('+' + popupAccum, x + (Math.random() - 0.5) * 40, y - 30, popupAccum >= 40);
      popupAccum = 0; popupTimer = 0.18;
    }
    hudTimer -= dt;
    if (hudTimer <= 0) { updateHud(); hudTimer = 0.25; }
    if (timeLeft <= 0) { updateHud(); endGame(); }
  }

  if (state !== 'paused') updateFalling(dt);
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

tap($('btn-arena'), () => startGame('arena'));
tap($('btn-solo'), () => startGame('solo'));
tap($('btn-pause'), pauseGame);
tap($('btn-resume'), () => { state = countdown > 0 ? 'countdown' : 'play'; show('hud'); if (state === 'countdown') $('countdown').classList.remove('hidden'); });
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
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

buildWorld((Math.random() * 1e9) | 0);
buildMenu();
resize();
show('menu');
requestAnimationFrame(t => { last = t; frame(t); });
$('loading').classList.add('hidden');

// Test hook (?debug): fast-forward the simulation without rendering.
if (/debug/.test(location.search)) {
  window.__od = {
    startGame, get holes() { return holes; }, get state() { return state; }, input,
    breakdown() { const r = {}; for (const [k, p] of Object.entries(pools)) r[k] = [p.mesh.count, p.n, p.mesh.count * p.mesh.geometry.attributes.position.count]; return r; },
    stats() { let v = 0, all = 0; for (const p of Object.values(pools)) { v += p.mesh.count * p.mesh.geometry.attributes.position.count; all += p.n * p.mesh.geometry.attributes.position.count; } return { objects: objects.length, movers: movers.length, visibleVerts: v, allVerts: all, draws: Object.keys(pools).length }; },
    sim(seconds, step = 1 / 60) {
      simulating = true;
      const t0 = performance.now();
      for (let t = 0; t < seconds && state !== 'over'; t += step) update(step);
      simulating = false;
      return performance.now() - t0;
    },
  };
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
