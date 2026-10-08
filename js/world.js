// City generator: lays out roads, blocks and props, and builds the ground mesh.
import * as THREE from 'three';
import { ASSETS } from './assets.js';

export const N_BLOCKS = 7;
export const BLOCK = 36;
export const ROAD = 8;
export const WALK = 2.6; // sidewalk width inside each block
export const SIZE = N_BLOCKS * BLOCK + (N_BLOCKS + 1) * ROAD;
export const HALF = SIZE / 2;

export function roadCenter(i) { return -HALF + ROAD / 2 + i * (BLOCK + ROAD); }
export function blockMin(j) { return -HALF + ROAD + j * (BLOCK + ROAD); }

// Small seeded RNG so a round's city is reproducible from its seed.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const COL = {
  grass: 0x7ccf5a, grassDark: 0x68b84a, park: 0x86d65e, asphalt: 0x4a4e57, sidewalk: 0xc9ccd3,
  curb: 0xa9adb6, line: 0xf5f5f5, yellow: 0xffd23f, path: 0xe9d8a6, plaza: 0xd9cfc1,
  parking: 0x5b606b, dirt: 0xb08458, field: 0x9cc95b, fieldDark: 0x86b04a, outer: 0x5fae45, water: 0x4cc9f0,
};

// ---- ground geometry -------------------------------------------------------
class Ground {
  constructor() { this.pos = []; this.col = []; this.uv = []; }
  quad(x0, z0, x1, z1, color, y = 0) {
    const c = new THREE.Color(color);
    const p = [[x0, z0], [x0, z1], [x1, z1], [x0, z0], [x1, z1], [x1, z0]];
    for (const [x, z] of p) {
      this.pos.push(x, y, z);
      this.col.push(c.r, c.g, c.b);
      this.uv.push(x / 6, z / 6);
    }
  }
  // rotated rectangle centred at (cx,cz)
  rect(cx, cz, w, d, rot, color, y) {
    const c = new THREE.Color(color);
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const pt = (lx, lz) => [cx + lx * cs + lz * sn, cz - lx * sn + lz * cs];
    const a = pt(-w / 2, -d / 2), b = pt(-w / 2, d / 2), e = pt(w / 2, d / 2), f = pt(w / 2, -d / 2);
    for (const [x, z] of [a, b, e, a, e, f]) {
      this.pos.push(x, y, z); this.col.push(c.r, c.g, c.b); this.uv.push(x / 6, z / 6);
    }
  }
  disc(cx, cz, r, color, y, seg = 20) {
    const c = new THREE.Color(color);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const pts = [[cx, cz], [cx + Math.cos(a1) * r, cz + Math.sin(a1) * r], [cx + Math.cos(a0) * r, cz + Math.sin(a0) * r]];
      for (const [x, z] of pts) { this.pos.push(x, y, z); this.col.push(c.r, c.g, c.b); this.uv.push(x / 6, z / 6); }
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    const n = new Float32Array(this.pos.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    g.computeBoundingSphere();
    return g;
  }
}

// ---- generator -------------------------------------------------------------
export function generateCity(seed) {
  const R = rng(seed);
  const rand = (a, b) => a + R() * (b - a);
  const pick = arr => arr[(R() * arr.length) | 0];
  const objects = [];
  const walkers = []; // sidewalk loops / park wander boxes for people
  const lanes = [];
  const G = new Ground();

  // Outer land + playable base
  const M = 220;
  G.quad(-HALF - M, -HALF - M, HALF + M, HALF + M, COL.outer, -0.02);
  G.quad(-HALF, -HALF, HALF, HALF, COL.asphalt, 0);

  const place = (type, x, z, rot = 0, opt = {}) => {
    const a = ASSETS[type];
    if (!a) throw new Error('unknown asset ' + type);
    const s = opt.scale || 1;
    const o = {
      type, x, z, rot, scale: s,
      fit: ((a.w + a.d) / 4) * s + a.h * s * 0.025,
      bound: Math.hypot(a.w, a.d) * 0.5 * s,
      h: a.h * s,
      value: Math.max(1, Math.round(a.value * s * s)),
      tint: a.tint ? (opt.color ?? pick(a.colors)) : null,
      mover: opt.mover || null,
    };
    objects.push(o);
    return o;
  };

  // Free-space checker for scattered props inside one block
  let occ = [];
  const free = (x, z, r) => {
    for (const o of occ) if ((o.x - x) ** 2 + (o.z - z) ** 2 < (o.r + r) ** 2) return false;
    return true;
  };
  const claim = (x, z, r) => occ.push({ x, z, r });
  const scatter = (types, count, x0, z0, x1, z1, rPad = 0.3) => {
    let placed = 0;
    for (let t = 0; t < count * 8 && placed < count; t++) {
      const type = pick(types);
      const a = ASSETS[type];
      const r = Math.max(a.w, a.d) * 0.5 + rPad;
      const x = rand(x0 + r, x1 - r), z = rand(z0 + r, z1 - r);
      if (!free(x, z, r)) continue;
      claim(x, z, r);
      place(type, x, z, R() * Math.PI * 2);
      placed++;
    }
  };

  // Block type map: dense downtown in the middle, softer at the edges
  const mid = (N_BLOCKS - 1) / 2;
  const types = [];
  for (let j = 0; j < N_BLOCKS; j++) {
    types[j] = [];
    for (let i = 0; i < N_BLOCKS; i++) {
      const dc = Math.max(Math.abs(i - mid), Math.abs(j - mid));
      let pool;
      if (dc === 0) pool = ['plaza'];
      else if (dc === 1) pool = ['downtown', 'downtown', 'commercial', 'park', 'parking'];
      else if (dc === 2) pool = ['commercial', 'residential', 'residential', 'park', 'parking', 'downtown'];
      else pool = ['residential', 'residential', 'farm', 'park', 'residential', 'commercial'];
      types[j][i] = pick(pool);
    }
  }

  // Roads: markings, crosswalks and car lanes
  for (let i = 0; i <= N_BLOCKS; i++) {
    const c = roadCenter(i);
    for (let k = 0; k < N_BLOCKS; k++) {
      const s0 = blockMin(k), s1 = s0 + BLOCK;
      // dashed centre lines between intersections
      for (let t = s0 + 3; t < s1 - 3; t += 4) {
        G.quad(t, c - 0.12, t + 2, c + 0.12, COL.line, 0.02);
        G.quad(c - 0.12, t, c + 0.12, t + 2, COL.line, 0.02);
      }
      // crosswalk stripes at both ends of each segment
      for (const e of [s0 + 0.6, s1 - 2.6]) {
        for (let q = -3; q <= 3; q += 1.2) {
          G.quad(e, c + q - 0.35, e + 2, c + q + 0.35, COL.line, 0.025);
          G.quad(c + q - 0.35, e, c + q + 0.35, e + 2, COL.line, 0.025);
        }
      }
    }
    // roads keep going into the countryside so traffic can drive off-map
    G.quad(HALF, c - ROAD / 2, HALF + M, c + ROAD / 2, COL.asphalt, 0.01);
    G.quad(-HALF - M, c - ROAD / 2, -HALF, c + ROAD / 2, COL.asphalt, 0.01);
    G.quad(c - ROAD / 2, HALF, c + ROAD / 2, HALF + M, COL.asphalt, 0.01);
    G.quad(c - ROAD / 2, -HALF - M, c + ROAD / 2, -HALF, COL.asphalt, 0.01);
    lanes.push({ axis: 'x', c: c + 2, dir: 1 }, { axis: 'x', c: c - 2, dir: -1 });
    lanes.push({ axis: 'z', c: c - 2, dir: 1 }, { axis: 'z', c: c + 2, dir: -1 });
  }

  // Blocks
  for (let j = 0; j < N_BLOCKS; j++) {
    for (let i = 0; i < N_BLOCKS; i++) {
      const x0 = blockMin(i), z0 = blockMin(j), x1 = x0 + BLOCK, z1 = z0 + BLOCK;
      const type = types[j][i];
      occ = [];
      // sidewalk + curb
      G.quad(x0, z0, x1, z1, COL.curb, 0.03);
      G.quad(x0 + 0.3, z0 + 0.3, x1 - 0.3, z1 - 0.3, COL.sidewalk, 0.04);
      const ix0 = x0 + WALK, iz0 = z0 + WALK, ix1 = x1 - WALK, iz1 = z1 - WALK;

      // sidewalk props along the four edges
      const edge = (fx, fz, nx, nz, len) => {
        const n = 4;
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5 + rand(-0.2, 0.2)) / n * len;
          const px = fx + nx * t, pz = fz + nz * t;
          const rot = Math.atan2(nx, nz) + Math.PI / 2;
          const roll = R();
          const tp = roll < 0.35 ? 'lamp' : roll < 0.5 ? 'trash' : roll < 0.6 ? 'hydrant' : roll < 0.68 ? 'bench' : roll < 0.74 ? 'newsbox'
            : roll < 0.8 ? 'mailbox' : roll < 0.85 ? 'flowerpot' : roll < 0.89 ? 'bikerack' : roll < 0.92 ? 'busstop' : roll < 0.95 ? 'phonebooth' : 'sign';
          place(tp, px, pz, rot);
        }
      };
      edge(x0 + 1.1, z0 + 1.1, 1, 0, BLOCK - 2.2);
      edge(x0 + 1.1, z1 - 1.1, 1, 0, BLOCK - 2.2);
      edge(x0 + 1.1, z0 + 1.1, 0, 1, BLOCK - 2.2);
      edge(x1 - 1.1, z0 + 1.1, 0, 1, BLOCK - 2.2);
      if (R() < 0.5) place('trafficlight', x0 + 0.8, z0 + 0.8, Math.PI * 0.25);
      if (R() < 0.5) place('trafficlight', x1 - 0.8, z1 - 0.8, Math.PI * 1.25);
      if (R() < 0.3) { place('cone', x0 + 1, z1 - 1.6); place('cone', x0 + 1, z1 - 2.6); }

      // sidewalk loop walkers
      walkers.push({ kind: 'loop', x0: x0 + 1.3, z0: z0 + 1.3, x1: x1 - 1.3, z1: z1 - 1.3, count: type === 'farm' ? 1 : 4 });

      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      if (type === 'park' || type === 'plaza') {
        G.quad(ix0, iz0, ix1, iz1, type === 'park' ? COL.park : COL.plaza, 0.05);
        if (type === 'park') {
          G.quad(cx - 1.4, iz0, cx + 1.4, iz1, COL.path, 0.06);
          G.quad(ix0, cz - 1.4, ix1, cz + 1.4, COL.path, 0.06);
          G.disc(cx, cz, 5.2, COL.path, 0.065);
          if (R() < 0.5) {
            place('fountain', cx, cz);
          } else place('statue', cx, cz);
          claim(cx, cz, 5.5);
          for (let q = 0; q < 4; q++) claim(cx, iz0 + q * 9, 1.6), claim(ix0 + q * 9, cz, 1.6);
          claim(cx, iz1 - 1, 1.6); claim(ix1 - 1, cz, 1.6);
          // playground corner
          const px = ix0 + 7, pz = iz0 + 7;
          G.quad(px - 5.5, pz - 5.5, px + 5.5, pz + 5.5, COL.dirt, 0.06);
          place('swing', px - 1.5, pz - 2.5); place('slide', px + 0.5, pz + 2.6); place('sandbox', px + 3, pz - 2.4);
          claim(px, pz, 7);
          // pond corner
          if (R() < 0.6) { G.disc(ix1 - 7, iz1 - 7, 4.5, COL.water, 0.07, 16); claim(ix1 - 7, iz1 - 7, 5); scatter(['rock'], 3, ix1 - 13, iz1 - 13, ix1, iz1); }
          scatter(['tree', 'tree', 'pine', 'birch', 'appletree', 'palm'], 16, ix0, iz0, ix1, iz1, 0.4);
          scatter(['bush', 'flowerbush', 'rock'], 12, ix0, iz0, ix1, iz1);
          scatter(['bench', 'picnic', 'trash', 'lamp', 'flowerpot'], 8, ix0, iz0, ix1, iz1);
          walkers.push({ kind: 'wander', x0: ix0, z0: iz0, x1: ix1, z1: iz1, count: 7 });
        } else {
          G.disc(cx, cz, 9, COL.sidewalk, 0.06, 24);
          if (R() < 0.6) { place('church', cx, cz - 2); claim(cx, cz - 2, 7.5); } else { place('watertower', cx, cz); claim(cx, cz, 4); place('fountain', cx + 9, cz + 9); claim(cx + 9, cz + 9, 3); }
          for (const [qx, qz] of [[ix0 + 3, iz0 + 3], [ix1 - 3, iz0 + 3], [ix0 + 3, iz1 - 3], [ix1 - 3, iz1 - 3]]) { place('palm', qx, qz); claim(qx, qz, 1.6); }
          scatter(['cafetable', 'kiosk', 'flowerpot', 'bench', 'statue', 'vending', 'atm'], 14, ix0, iz0, ix1, iz1, 0.6);
          scatter(['tree', 'bush', 'flowerbush'], 8, ix0, iz0, ix1, iz1);
          walkers.push({ kind: 'wander', x0: ix0, z0: iz0, x1: ix1, z1: iz1, count: 10 });
        }
      } else if (type === 'residential') {
        G.quad(ix0, iz0, ix1, iz1, COL.grass, 0.05);
        const lw = (ix1 - ix0) / 2;
        for (let a = 0; a < 2; a++) for (let b2 = 0; b2 < 2; b2++) {
          const lx0 = ix0 + a * lw, lz0 = iz0 + b2 * lw, lcx = lx0 + lw / 2, lcz = lz0 + lw / 2;
          const facing = b2 === 0 ? Math.PI : 0; // houses face the nearest street
          const fz = b2 === 0 ? -1 : 1;
          const ht = pick(['house', 'house', 'cottage']);
          place(ht, lcx, lcz - fz * 0.5, facing);
          claim(lcx, lcz - fz * 0.5, 4.6);
          // driveway + car
          const dx = lcx + (a === 0 ? -5 : 5);
          G.quad(dx - 1.4, b2 === 0 ? lz0 : lcz, dx + 1.4, b2 === 0 ? lcz : lz0 + lw, COL.sidewalk, 0.06);
          if (R() < 0.7) { place(pick(['car', 'car', 'van', 'sportscar']), dx, lcz + fz * 4, Math.PI / 2); claim(dx, lcz + fz * 4, 2.3); }
          if (R() < 0.5) { place(pick(['shed', 'garage']), lcx + (a === 0 ? 4.5 : -4.5), lcz - fz * 5.5, facing); claim(lcx + (a === 0 ? 4.5 : -4.5), lcz - fz * 5.5, 3.2); }
          place('mailbox', lcx + 2, lz0 + (b2 === 0 ? 0.6 : lw - 0.6), facing);
          // fence along the back
          for (let f = 0; f < 5; f++) place('fence', lx0 + 1.6 + f * 3, b2 === 0 ? lz0 + lw - 0.25 : lz0 + 0.25, 0);
          scatter(['tree', 'bush', 'flowerbush', 'pine', 'appletree', 'birch'], 6, lx0 + 0.5, lz0 + 0.5, lx0 + lw - 0.5, lz0 + lw - 0.8);
          scatter(['barrel', 'crate', 'flowerpot', 'picnic', 'trash'], 2, lx0 + 0.5, lz0 + 0.5, lx0 + lw - 0.5, lz0 + lw - 0.8);
        }
        walkers.push({ kind: 'wander', x0: ix0, z0: iz0, x1: ix1, z1: iz1, count: 2 });
      } else if (type === 'commercial') {
        G.quad(ix0, iz0, ix1, iz1, COL.plaza, 0.05);
        // shops facing the four streets
        const slots = [[cx - 7.5, iz0 + 4.2, Math.PI], [cx + 7.5, iz0 + 4.2, Math.PI], [cx - 7.5, iz1 - 4.2, 0], [cx + 7.5, iz1 - 4.2, 0]];
        for (const [sx, sz, rot] of slots) {
          const t = pick(['shop', 'shop', 'cafe', 'shop', 'gasstation']);
          place(t, sx, sz, rot);
          claim(sx, sz, 5.1);
          if (t === 'cafe' || R() < 0.4) {
            const fz = rot === 0 ? 1 : -1;
            place('cafetable', sx - 2.2, sz + fz * 5.4); place('cafetable', sx + 2.2, sz + fz * 5.4);
          }
        }
        G.quad(ix0 + 2, cz - 4, ix1 - 2, cz + 4, COL.parking, 0.06);
        for (let q = 0; q < 6; q++) {
          const px = ix0 + 4 + q * 4.6;
          G.quad(px - 0.08, cz - 3.8, px + 0.08, cz + 3.8, COL.line, 0.07);
          if (R() < 0.7) place(pick(['car', 'car', 'taxi', 'van', 'sportscar']), px + 2.3, cz + rand(-0.4, 0.4), Math.PI / 2 + (R() < 0.5 ? Math.PI : 0));
        }
        for (let q = 0; q < 8; q++) claim(ix0 + 2 + q * 4, cz, 4.2);
        scatter(['dumpster', 'crate', 'barrel', 'vending', 'atm', 'kiosk', 'flowerpot', 'trash'], 8, ix0, iz0, ix1, iz1, 0.5);
        walkers.push({ kind: 'wander', x0: ix0, z0: iz0, x1: ix1, z1: iz1, count: 6 });
      } else if (type === 'downtown') {
        G.quad(ix0, iz0, ix1, iz1, COL.plaza, 0.05);
        const q = (ix1 - ix0) / 4;
        const opts = ['office', 'apartment', 'tower', 'skyscraper', 'office', 'apartment'];
        for (const [sx, sz] of [[ix0 + q, iz0 + q], [ix1 - q, iz0 + q], [ix0 + q, iz1 - q], [ix1 - q, iz1 - q]]) {
          const t = pick(opts);
          place(t, sx, sz, (R() * 4 | 0) * Math.PI / 2);
          claim(sx, sz, Math.hypot(ASSETS[t].w, ASSETS[t].d) / 2 - 0.4);
        }
        scatter(['tree', 'flowerpot', 'bench', 'vending', 'atm', 'lamp', 'cafetable', 'statue', 'bush'], 12, ix0, iz0, ix1, iz1, 0.4);
        walkers.push({ kind: 'wander', x0: ix0, z0: iz0, x1: ix1, z1: iz1, count: 8 });
      } else if (type === 'parking') {
        G.quad(ix0, iz0, ix1, iz1, COL.parking, 0.05);
        for (let row = 0; row < 4; row++) {
          const rz = iz0 + 3.4 + row * 7.8;
          for (let k = 0; k < 13; k++) {
            const px = ix0 + 1.2 + k * 2.4;
            G.quad(px - 0.06, rz - 2.4, px + 0.06, rz + 2.4, COL.line, 0.06);
            if (k < 12 && R() < 0.72) {
              const t = pick(['car', 'car', 'car', 'taxi', 'van', 'sportscar', 'police', 'ambulance']);
              place(t, px + 1.2, rz, Math.PI / 2 + (row % 2 ? Math.PI : 0));
            }
          }
        }
        place('kiosk', ix1 - 2, iz0 + 1.6, 0);
        for (let k = 0; k < 6; k++) place(pick(['cone', 'cone', 'barrier']), ix0 + 2 + k * 5, cz + rand(-0.3, 0.3), 0);
        place('atm', ix0 + 1, iz1 - 1, 0); place('vending', ix0 + 2.2, iz1 - 1, 0);
        walkers.push({ kind: 'wander', x0: ix0, z0: iz0, x1: ix1, z1: iz1, count: 3 });
      } else if (type === 'farm') {
        G.quad(ix0, iz0, ix1, iz1, COL.field, 0.05);
        for (let r2 = 0; r2 < 8; r2++) G.quad(ix0 + 16, iz0 + 1 + r2 * 3.8, ix1 - 1, iz0 + 2.6 + r2 * 3.8, COL.fieldDark, 0.06);
        place('barn', ix0 + 6, iz0 + 7, 0); claim(ix0 + 6, iz0 + 7, 6.5);
        place('watertower', ix0 + 5, iz1 - 6); claim(ix0 + 5, iz1 - 6, 3);
        place('tractor', ix0 + 12, iz1 - 4, R() * 6); claim(ix0 + 12, iz1 - 4, 2.2);
        for (let k = 0; k < 9; k++) place('fence', ix0 + 1.7 + k * 3.2, iz0 + 0.3, 0);
        scatter(['haybale'], 8, ix0 + 15, iz0, ix1, iz1);
        scatter(['appletree', 'appletree', 'tree', 'bush', 'rock', 'crate', 'barrel'], 10, ix0, iz0, ix1, iz1);
      }
    }
  }

  // Moving people
  const peopleTypes = ['person0', 'person1', 'person2', 'person3', 'person4', 'person5'];
  for (const w of walkers) {
    for (let k = 0; k < w.count; k++) {
      if (w.kind === 'loop') {
        const per = 2 * (w.x1 - w.x0 + w.z1 - w.z0);
        place(pick(peopleTypes), 0, 0, 0, { mover: { kind: 'loop', box: w, per, t: R() * per, speed: rand(0.9, 1.6) * (R() < 0.5 ? 1 : -1) } });
      } else {
        const x = rand(w.x0 + 1, w.x1 - 1), z = rand(w.z0 + 1, w.z1 - 1);
        place(pick(peopleTypes), x, z, 0, { mover: { kind: 'wander', box: w, tx: x, tz: z, wait: R() * 3, speed: rand(0.8, 1.4) } });
      }
    }
  }

  // Moving traffic
  const carTypes = ['car', 'car', 'car', 'taxi', 'van', 'sportscar', 'bus', 'truck', 'police', 'ambulance'];
  for (const ln of lanes) {
    const n = 2 + (R() * 2 | 0);
    for (let k = 0; k < n; k++) {
      const t = -HALF + ((k + R() * 0.5) / n) * SIZE;
      place(pick(carTypes), 0, 0, 0, { mover: { kind: 'car', lane: ln, t, speed: 6.5 } });
    }
  }

  return { objects, ground: G.build() };
}
