// Procedural low-poly asset library. Every asset is one merged BufferGeometry
// (position / normal / color, plus uv for textured walls) so each type renders
// as a single InstancedMesh draw call.
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

// ---- builder ---------------------------------------------------------------
class Builder {
  constructor() { this.parts = [[], []]; }
  // geo: geometry centred at origin. opts: pos [x,y,z], rot [x,y,z], scl [x,y,z], color hex, mat 0|1
  add(geo, color, pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1], mat = 0) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    _e.set(rot[0], rot[1], rot[2]);
    _q.setFromEuler(_e);
    _m.compose(_v.set(pos[0], pos[1], pos[2]), _q, _s.set(scl[0], scl[1], scl[2]));
    g.applyMatrix4(_m);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    _c.set(color);
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    this.parts[mat].push(g);
    return this;
  }
  box(w, h, d, color, x = 0, y = 0, z = 0, ry = 0, mat = 0) {
    return this.add(BOX, color, [x, y + h / 2, z], [0, ry, 0], [w, h, d], mat);
  }
  build() {
    const groups = [];
    const merged = [];
    let start = 0;
    for (let mi = 0; mi < 2; mi++) {
      if (!this.parts[mi].length) continue;
      const g = mergeList(this.parts[mi]);
      const count = g.attributes.position.count;
      groups.push({ start, count, materialIndex: mi });
      start += count;
      merged.push(g);
    }
    const out = merged.length === 1 ? merged[0] : mergeList(merged);
    if (groups.length > 1) groups.forEach(gr => out.addGroup(gr.start, gr.count, gr.materialIndex));
    out.userData.multiMat = groups.length > 1 || (groups[0] && groups[0].materialIndex === 1);
    out.userData.onlyMat = groups.length === 1 ? groups[0].materialIndex : -1;
    out.computeBoundingSphere();
    out.computeBoundingBox();
    return out;
  }
}

function mergeList(list) {
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of list) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    if (!g.attributes.normal) g.computeVertexNormals();
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    uv.set(g.attributes.uv.array, o * 2);
    o += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

// ---- primitives (unit sized) ----------------------------------------------
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL6 = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);
const CYL8 = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const CYL12 = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const CONE6 = new THREE.ConeGeometry(0.5, 1, 6);
const CONE8 = new THREE.ConeGeometry(0.5, 1, 8);
const ICO = new THREE.IcosahedronGeometry(0.5, 0);
const ICO1 = new THREE.IcosahedronGeometry(0.5, 1);
const SPH = new THREE.SphereGeometry(0.5, 8, 6);
const WHEEL = new THREE.CylinderGeometry(0.5, 0.5, 1, 8).rotateZ(Math.PI / 2);
// Triangular prism for pitched roofs (ridge along X)
const PRISM = (() => {
  const s = new THREE.Shape();
  s.moveTo(-0.5, 0); s.lineTo(0.5, 0); s.lineTo(0, 1); s.lineTo(-0.5, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  g.rotateY(Math.PI / 2);
  return g;
})();

// Box whose side faces carry repeating window UVs (material 1) + roof (material 0).
function wallBox(b, w, h, d, wallColor, roofColor, x = 0, z = 0, floorH = 3, bayW = 2.6, y0 = 0) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const uv = g.attributes.uv;
  const nor = g.attributes.normal;
  // Split into wall faces and top/bottom faces
  const pos = g.attributes.position;
  const wallPos = [], wallNor = [], wallUv = [], roofPos = [], roofNor = [];
  for (let i = 0; i < pos.count; i++) {
    const ny = nor.getY(i);
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    if (Math.abs(ny) > 0.5) {
      roofPos.push(px, py, pz); roofNor.push(nor.getX(i), ny, nor.getZ(i));
    } else {
      wallPos.push(px, py, pz); wallNor.push(nor.getX(i), ny, nor.getZ(i));
      const along = Math.abs(nor.getX(i)) > 0.5 ? d : w;
      wallUv.push(uv.getX(i) * Math.max(1, Math.round(along / bayW)), uv.getY(i) * Math.max(1, Math.round(h / floorH)));
    }
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
  wg.setAttribute('normal', new THREE.Float32BufferAttribute(wallNor, 3));
  wg.setAttribute('uv', new THREE.Float32BufferAttribute(wallUv, 2));
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(roofPos, 3));
  rg.setAttribute('normal', new THREE.Float32BufferAttribute(roofNor, 3));
  b.add(wg, wallColor, [x, y0 + h / 2, z], [0, 0, 0], [1, 1, 1], 1);
  b.add(rg, roofColor, [x, y0 + h / 2, z], [0, 0, 0], [1, 1, 1], 0);
}

// ---- asset definitions -----------------------------------------------------
// w,d: footprint, h: height, value: points, shadow: 'c' circle | 's' square,
// tint: allow per-instance colour tint, colors: palette used when tinting.
export const ASSETS = {};

function def(name, props, make) {
  const b = new Builder();
  make(b);
  const geo = b.build();
  ASSETS[name] = Object.assign({ name, geo, tint: false, shadow: 'c', moving: false }, props);
}

const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
const SHIRT = [0xe63946, 0x457b9d, 0x2a9d8f, 0xf4a261, 0x9b5de5, 0xffd166, 0x06d6a0, 0xef476f];
const PANTS = [0x1d3557, 0x333333, 0x6b4f3a, 0x264653];

export function buildAssets() {
  // People (several variants)
  for (let i = 0; i < 6; i++) {
    def('person' + i, { w: 0.6, d: 0.6, h: 1.8, value: 1, moving: true }, b => {
      const skin = SKIN[i % SKIN.length], shirt = SHIRT[(i * 3) % SHIRT.length], pants = PANTS[i % PANTS.length];
      b.box(0.18, 0.8, 0.22, pants, -0.12, 0, 0);
      b.box(0.18, 0.8, 0.22, pants, 0.12, 0, 0);
      b.box(0.55, 0.65, 0.3, shirt, 0, 0.8, 0);
      b.box(0.14, 0.55, 0.16, shirt, -0.36, 0.88, 0);
      b.box(0.14, 0.55, 0.16, shirt, 0.36, 0.88, 0);
      b.add(BOX, skin, [0, 1.62, 0], [0, 0, 0], [0.34, 0.34, 0.32]);
      if (i % 2) b.box(0.38, 0.12, 0.36, 0x2b2118, 0, 1.76, 0); // hair
      else b.add(CYL8, SHIRT[(i + 4) % SHIRT.length], [0, 1.82, 0], [0, 0, 0], [0.42, 0.1, 0.42]); // cap
    });
  }

  // Street furniture
  def('cone', { w: 0.5, d: 0.5, h: 0.75, value: 1 }, b => {
    b.box(0.55, 0.06, 0.55, 0xff6d00);
    b.add(CONE8, 0xff7b00, [0, 0.4, 0], [0, 0, 0], [0.42, 0.7, 0.42]);
    b.add(CYL8, 0xffffff, [0, 0.42, 0], [0, 0, 0], [0.3, 0.1, 0.3]);
  });
  def('hydrant', { w: 0.5, d: 0.5, h: 0.9, value: 1 }, b => {
    b.add(CYL8, 0xd62828, [0, 0.35, 0], [0, 0, 0], [0.34, 0.7, 0.34]);
    b.add(SPH, 0xd62828, [0, 0.72, 0], [0, 0, 0], [0.34, 0.3, 0.34]);
    b.add(CYL6, 0xf1f1f1, [0, 0.5, 0], [0, 0, Math.PI / 2], [0.14, 0.55, 0.14]);
    b.add(CYL8, 0x9d0208, [0, 0.04, 0], [0, 0, 0], [0.48, 0.08, 0.48]);
  });
  def('trash', { w: 0.6, d: 0.6, h: 1, value: 1 }, b => {
    b.add(CYL8, 0x2d6a4f, [0, 0.45, 0], [0, 0, 0], [0.55, 0.9, 0.55]);
    b.add(CYL8, 0x1b4332, [0, 0.93, 0], [0, 0, 0], [0.62, 0.08, 0.62]);
  });
  def('mailbox', { w: 0.5, d: 0.6, h: 1.2, value: 1 }, b => {
    b.box(0.08, 0.8, 0.08, 0x5c4033);
    b.box(0.4, 0.35, 0.55, 0x1d4ed8, 0, 0.8, 0);
    b.box(0.04, 0.2, 0.06, 0xe63946, 0.22, 1.0, 0.15);
  });
  def('newsbox', { w: 0.6, d: 0.5, h: 1.1, value: 1 }, b => {
    b.box(0.55, 0.9, 0.45, 0xffb703);
    b.box(0.45, 0.35, 0.02, 0x9ecae1, 0, 0.45, 0.23);
    b.box(0.08, 0.2, 0.08, 0x333333, -0.2, 0, -0.1);
  });
  def('bench', { w: 1.8, d: 0.7, h: 0.9, value: 3, shadow: 's' }, b => {
    b.box(1.7, 0.08, 0.5, 0x9c6644, 0, 0.42, 0);
    b.box(1.7, 0.35, 0.06, 0x9c6644, 0, 0.55, -0.24);
    for (const x of [-0.75, 0.75]) { b.box(0.08, 0.42, 0.5, 0x333333, x, 0, 0); b.box(0.08, 0.5, 0.06, 0x333333, x, 0.42, -0.24); }
  });
  def('lamp', { w: 0.5, d: 0.5, h: 4.5, value: 3 }, b => {
    b.add(CYL6, 0x2b2d42, [0, 0.15, 0], [0, 0, 0], [0.35, 0.3, 0.35]);
    b.add(CYL6, 0x3a3d5c, [0, 2.2, 0], [0, 0, 0], [0.14, 4.2, 0.14]);
    b.box(0.9, 0.08, 0.1, 0x3a3d5c, 0.4, 4.2, 0);
    b.box(0.45, 0.16, 0.3, 0x2b2d42, 0.8, 4.05, 0);
    b.box(0.35, 0.05, 0.22, 0xfff3b0, 0.8, 4.0, 0);
  });
  def('trafficlight', { w: 0.5, d: 0.5, h: 3.8, value: 3 }, b => {
    b.add(CYL6, 0x444444, [0, 1.6, 0], [0, 0, 0], [0.14, 3.2, 0.14]);
    b.box(0.4, 1.1, 0.35, 0x222222, 0, 2.8, 0);
    b.add(SPH, 0xff2d2d, [0, 3.65, 0.18], [0, 0, 0], [0.22, 0.22, 0.1]);
    b.add(SPH, 0xffd000, [0, 3.35, 0.18], [0, 0, 0], [0.22, 0.22, 0.1]);
    b.add(SPH, 0x22dd55, [0, 3.05, 0.18], [0, 0, 0], [0.22, 0.22, 0.1]);
  });
  def('sign', { w: 0.6, d: 0.3, h: 2.6, value: 2 }, b => {
    b.add(CYL6, 0x9a9a9a, [0, 1.1, 0], [0, 0, 0], [0.08, 2.2, 0.08]);
    b.add(CYL8, 0xd62828, [0, 2.2, 0.06], [Math.PI / 2, 0, 0], [0.7, 0.06, 0.7]);
    b.box(0.5, 0.12, 0.02, 0xffffff, 0, 2.14, 0.1);
  });
  def('barrier', { w: 1.6, d: 0.5, h: 1, value: 2, shadow: 's' }, b => {
    for (const x of [-0.65, 0.65]) b.box(0.1, 0.9, 0.4, 0x666666, x, 0, 0);
    b.box(1.6, 0.25, 0.08, 0xffffff, 0, 0.6, 0);
    for (let i = 0; i < 4; i++) b.box(0.18, 0.26, 0.09, 0xe63946, -0.6 + i * 0.4, 0.6, 0);
  });
  def('bikerack', { w: 1.8, d: 0.5, h: 1, value: 3, shadow: 's' }, b => {
    for (let i = 0; i < 2; i++) {
      const x = -0.45 + i * 0.9;
      b.add(WHEEL, 0x222222, [x - 0.0, 0.33, -0.4], [0, Math.PI / 2, 0], [0.06, 0.62, 0.62]);
      b.add(WHEEL, 0x222222, [x - 0.0, 0.33, 0.4], [0, Math.PI / 2, 0], [0.06, 0.62, 0.62]);
      b.box(0.06, 0.06, 0.8, SHIRT[i * 2], x, 0.6, 0);
      b.box(0.06, 0.4, 0.06, SHIRT[i * 2], x, 0.35, 0.15);
      b.box(0.3, 0.05, 0.12, 0x222222, x, 0.75, 0.15);
    }
  });
  def('phonebooth', { w: 1, d: 1, h: 2.5, value: 6, shadow: 's' }, b => {
    b.box(1, 2.4, 1, 0xc1121f);
    b.box(0.8, 1.4, 0.02, 0xbde0fe, 0, 0.7, 0.51);
    b.box(1.05, 0.15, 1.05, 0x8b0000, 0, 2.4, 0);
  });
  def('vending', { w: 1, d: 0.8, h: 2, value: 5, shadow: 's' }, b => {
    b.box(1, 1.9, 0.8, 0x1d4ed8);
    b.box(0.6, 1.1, 0.02, 0xcfe8ff, -0.12, 0.6, 0.41);
    b.box(0.2, 0.5, 0.02, 0x222222, 0.35, 0.9, 0.41);
  });
  def('atm', { w: 0.8, d: 0.7, h: 1.8, value: 5, shadow: 's' }, b => {
    b.box(0.8, 1.7, 0.7, 0x6c757d);
    b.box(0.6, 0.35, 0.02, 0x00b4d8, 0, 1.15, 0.36);
    b.box(0.5, 0.06, 0.15, 0x333333, 0, 0.85, 0.38);
  });
  def('busstop', { w: 3, d: 1.4, h: 2.6, value: 10, shadow: 's' }, b => {
    b.box(3, 0.1, 1.4, 0x495057, 0, 2.45, 0);
    for (const x of [-1.4, 1.4]) b.box(0.08, 2.45, 0.08, 0x495057, x, 0, 0.55);
    b.box(2.9, 2.0, 0.05, 0xa8dadc, 0, 0.35, -0.6);
    b.box(2.2, 0.08, 0.4, 0x9c6644, 0, 0.5, -0.35);
    b.box(0.9, 1.6, 0.06, 0xffd166, 1.0, 0.6, -0.56);
  });
  def('dumpster', { w: 2.2, d: 1.4, h: 1.5, value: 10, shadow: 's', tint: true, colors: [0x2d6a4f, 0x1d4ed8, 0x495057] }, b => {
    b.box(2.1, 1.25, 1.3, 0xffffff);
    b.box(2.2, 0.1, 1.4, 0x222222, 0, 1.25, 0);
    for (const x of [-0.8, 0.8]) for (const z of [-0.5, 0.5]) b.add(CYL6, 0x111111, [x, 0.1, z], [0, 0, 0], [0.18, 0.2, 0.18]);
  });
  def('crate', { w: 0.9, d: 0.9, h: 0.9, value: 2, shadow: 's' }, b => {
    b.box(0.9, 0.9, 0.9, 0xc08552);
    b.box(0.95, 0.12, 0.95, 0x8c5a33, 0, 0.1, 0);
    b.box(0.95, 0.12, 0.95, 0x8c5a33, 0, 0.7, 0);
  });
  def('barrel', { w: 0.7, d: 0.7, h: 1, value: 2, tint: true, colors: [0x1d4ed8, 0xd62828, 0x2a9d8f, 0xffb703] }, b => {
    b.add(CYL12, 0xffffff, [0, 0.5, 0], [0, 0, 0], [0.65, 1, 0.65]);
    b.add(CYL12, 0x888888, [0, 0.3, 0], [0, 0, 0], [0.68, 0.06, 0.68]);
    b.add(CYL12, 0x888888, [0, 0.72, 0], [0, 0, 0], [0.68, 0.06, 0.68]);
  });
  def('cafetable', { w: 2, d: 2, h: 2.4, value: 6 }, b => {
    b.add(CYL12, 0xffffff, [0, 0.72, 0], [0, 0, 0], [0.9, 0.06, 0.9]);
    b.add(CYL6, 0x555555, [0, 0.36, 0], [0, 0, 0], [0.08, 0.72, 0.08]);
    b.add(CYL6, 0x888888, [0, 1.5, 0], [0, 0, 0], [0.05, 1.6, 0.05]);
    b.add(CONE8, 0xe63946, [0, 2.2, 0], [0, 0, 0], [2.2, 0.5, 2.2]);
    for (const a of [0, Math.PI]) {
      const x = Math.cos(a) * 0.75, z = Math.sin(a) * 0.75;
      b.box(0.4, 0.05, 0.4, 0x9c6644, x, 0.42, z);
      b.box(0.05, 0.42, 0.05, 0x333333, x, 0, z);
    }
  });
  def('picnic', { w: 2, d: 1.8, h: 0.8, value: 5, shadow: 's' }, b => {
    b.box(1.8, 0.08, 0.8, 0xa47148, 0, 0.72, 0);
    b.box(1.8, 0.06, 0.3, 0xa47148, 0, 0.42, 0.65);
    b.box(1.8, 0.06, 0.3, 0xa47148, 0, 0.42, -0.65);
    for (const x of [-0.7, 0.7]) b.box(0.08, 0.72, 1.5, 0x7f5539, x, 0, 0);
  });
  def('flowerpot', { w: 0.8, d: 0.8, h: 1, value: 2 }, b => {
    b.add(CYL8, 0xbc6c25, [0, 0.25, 0], [0, 0, 0], [0.75, 0.5, 0.75]);
    b.add(ICO, 0x52b788, [0, 0.65, 0], [0, 0, 0], [0.7, 0.5, 0.7]);
    b.add(ICO, 0xff4d6d, [0.15, 0.85, 0.1], [0, 0, 0], [0.2, 0.2, 0.2]);
    b.add(ICO, 0xffd60a, [-0.18, 0.8, -0.05], [0, 0, 0], [0.2, 0.2, 0.2]);
  });
  def('fence', { w: 3, d: 0.3, h: 1, value: 3, shadow: 's' }, b => {
    b.box(3, 0.1, 0.08, 0xf8f9fa, 0, 0.75, 0);
    b.box(3, 0.1, 0.08, 0xf8f9fa, 0, 0.35, 0);
    for (let i = 0; i < 7; i++) b.box(0.14, 1, 0.1, 0xffffff, -1.4 + i * 0.466, 0, 0);
  });
  def('rock', { w: 1.2, d: 1.2, h: 0.8, value: 3 }, b => {
    b.add(ICO, 0x8d99ae, [0, 0.35, 0], [0.3, 0.5, 0], [1.2, 0.8, 1.0]);
    b.add(ICO, 0x6c757d, [0.4, 0.2, 0.2], [0, 1, 0.4], [0.5, 0.4, 0.5]);
  });
  def('haybale', { w: 1.4, d: 1.2, h: 1.2, value: 4 }, b => {
    b.add(CYL12, 0xe9c46a, [0, 0.6, 0], [0, 0, Math.PI / 2], [1.2, 1.4, 1.2]);
    b.add(CYL12, 0xd4a373, [0, 0.6, 0], [0, 0, Math.PI / 2], [1.22, 0.1, 1.22]);
  });

  // Vegetation
  def('bush', { w: 1.2, d: 1.2, h: 1, value: 2, tint: true, colors: [0xffffff, 0xd8f3dc, 0xc7f9cc, 0xb7e4c7] }, b => {
    b.add(ICO1, 0x52b788, [0, 0.45, 0], [0, 0, 0], [1.2, 0.9, 1.1]);
    b.add(ICO, 0x40916c, [0.35, 0.35, 0.2], [0, 0.4, 0], [0.7, 0.6, 0.7]);
  });
  def('flowerbush', { w: 1.2, d: 1.2, h: 1, value: 2 }, b => {
    b.add(ICO1, 0x2d6a4f, [0, 0.45, 0], [0, 0, 0], [1.2, 0.9, 1.1]);
    const fl = [0xff4d6d, 0xffd60a, 0xffffff, 0xc77dff];
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05;
      b.add(ICO, fl[i % 4], [Math.cos(a) * 0.45, 0.6 + (i % 2) * 0.25, Math.sin(a) * 0.4], [0, 0, 0], [0.18, 0.18, 0.18]);
    }
  });
  def('tree', { w: 2.2, d: 2.2, h: 4.5, value: 6, tint: true, colors: [0xffffff, 0xe9f5db, 0xd8f3dc, 0xfff3b0] }, b => {
    b.add(CYL6, 0x7f5539, [0, 1, 0], [0, 0, 0], [0.4, 2, 0.4]);
    b.add(ICO1, 0x40916c, [0, 2.9, 0], [0, 0, 0], [2.4, 2.3, 2.4]);
    b.add(ICO, 0x52b788, [0.5, 3.6, 0.3], [0, 0, 0], [1.4, 1.3, 1.4]);
  });
  def('pine', { w: 2, d: 2, h: 5.5, value: 7, tint: true, colors: [0xffffff, 0xe0f2e9, 0xd0efe0] }, b => {
    b.add(CYL6, 0x6f4e37, [0, 0.6, 0], [0, 0, 0], [0.35, 1.2, 0.35]);
    b.add(CONE8, 0x2d6a4f, [0, 2.0, 0], [0, 0, 0], [2.2, 2.2, 2.2]);
    b.add(CONE8, 0x40916c, [0, 3.2, 0], [0, 0.3, 0], [1.7, 1.9, 1.7]);
    b.add(CONE8, 0x52b788, [0, 4.4, 0], [0, 0.6, 0], [1.1, 1.6, 1.1]);
  });
  def('palm', { w: 2.4, d: 2.4, h: 5.5, value: 7 }, b => {
    for (let i = 0; i < 6; i++) b.add(CYL6, i % 2 ? 0x9c6644 : 0x7f5539, [i * 0.06, 0.45 + i * 0.75, 0], [0, 0, -0.04], [0.32 - i * 0.02, 0.78, 0.32 - i * 0.02]);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.add(BOX, 0x2a9d8f, [0.36 + Math.cos(a) * 0.9, 4.75, Math.sin(a) * 0.9], [0, -a, -0.35], [1.9, 0.06, 0.5]);
    }
    b.add(ICO, 0x6b4226, [0.36, 4.7, 0], [0, 0, 0], [0.5, 0.4, 0.5]);
  });
  def('birch', { w: 1.8, d: 1.8, h: 5, value: 6 }, b => {
    b.add(CYL6, 0xf1f1f1, [0, 1.6, 0], [0, 0, 0], [0.3, 3.2, 0.3]);
    for (let i = 0; i < 4; i++) b.box(0.32, 0.08, 0.32, 0x333333, 0, 0.5 + i * 0.7, 0);
    b.add(ICO1, 0xa7c957, [0, 3.7, 0], [0, 0, 0], [1.8, 2.4, 1.8]);
  });
  def('appletree', { w: 2.4, d: 2.4, h: 4.2, value: 7 }, b => {
    b.add(CYL6, 0x7f5539, [0, 0.9, 0], [0, 0, 0], [0.42, 1.8, 0.42]);
    b.add(ICO1, 0x38b000, [0, 2.8, 0], [0, 0, 0], [2.6, 2.2, 2.6]);
    for (let i = 0; i < 7; i++) {
      const a = i * 0.9;
      b.add(ICO, 0xe63946, [Math.cos(a) * 1.15, 2.4 + (i % 3) * 0.45, Math.sin(a) * 1.15], [0, 0, 0], [0.25, 0.25, 0.25]);
    }
  });

  // Park & landmark pieces
  def('fountain', { w: 4, d: 4, h: 2.4, value: 30 }, b => {
    b.add(CYL12, 0xadb5bd, [0, 0.3, 0], [0, 0, 0], [4, 0.6, 4]);
    b.add(CYL12, 0x48cae4, [0, 0.5, 0], [0, 0, 0], [3.5, 0.25, 3.5]);
    b.add(CYL8, 0xadb5bd, [0, 1.1, 0], [0, 0, 0], [0.4, 1.4, 0.4]);
    b.add(CYL12, 0xadb5bd, [0, 1.8, 0], [0, 0, 0], [1.6, 0.2, 1.6]);
    b.add(CYL12, 0x90e0ef, [0, 1.92, 0], [0, 0, 0], [1.4, 0.1, 1.4]);
    b.add(CONE8, 0xcaf0f8, [0, 2.3, 0], [0, 0, 0], [0.3, 0.8, 0.3]);
  });
  def('statue', { w: 2, d: 2, h: 4, value: 25, shadow: 's' }, b => {
    b.box(2, 1.2, 2, 0xced4da);
    b.box(2.2, 0.2, 2.2, 0xadb5bd, 0, 1.2, 0);
    b.box(0.5, 1.0, 0.4, 0x6c9a8b, 0, 1.4, 0);
    b.box(0.7, 0.9, 0.45, 0x6c9a8b, 0, 2.3, 0);
    b.add(ICO, 0x6c9a8b, [0, 3.45, 0], [0, 0, 0], [0.5, 0.55, 0.5]);
    b.box(0.18, 0.9, 0.18, 0x6c9a8b, 0.45, 2.9, 0, 0);
  });
  def('swing', { w: 3.4, d: 1.8, h: 2.6, value: 12, shadow: 's' }, b => {
    for (const x of [-1.6, 1.6]) {
      b.add(CYL6, 0xe63946, [x, 1.25, 0.5], [0.35, 0, 0], [0.12, 2.7, 0.12]);
      b.add(CYL6, 0xe63946, [x, 1.25, -0.5], [-0.35, 0, 0], [0.12, 2.7, 0.12]);
    }
    b.add(CYL6, 0xffd166, [0, 2.5, 0], [0, 0, Math.PI / 2], [0.14, 3.3, 0.14]);
    for (const x of [-0.7, 0.7]) {
      b.box(0.03, 1.8, 0.03, 0x555555, x - 0.2, 0.7, 0);
      b.box(0.03, 1.8, 0.03, 0x555555, x + 0.2, 0.7, 0);
      b.box(0.5, 0.06, 0.25, 0x264653, x, 0.65, 0);
    }
  });
  def('slide', { w: 3.4, d: 1.2, h: 2.4, value: 12, shadow: 's' }, b => {
    for (const x of [-1.4, -0.6]) for (const z of [-0.45, 0.45]) b.box(0.1, 1.8, 0.1, 0x457b9d, x, 0, z);
    b.box(0.9, 0.1, 1, 0x457b9d, -1, 1.8, 0);
    b.add(BOX, 0xffd166, [0.55, 1.0, 0], [0, 0, -0.62], [2.6, 0.1, 0.9]);
    b.box(0.08, 2.4, 0.9, 0xe63946, -1.45, 0, 0);
  });
  def('sandbox', { w: 3, d: 3, h: 0.5, value: 6, shadow: 's' }, b => {
    b.box(3, 0.35, 3, 0xbc8a5f);
    b.box(2.6, 0.38, 2.6, 0xf2cc8f);
    b.add(CONE8, 0xe63946, [0.5, 0.55, 0.4], [0, 0, 0], [0.4, 0.4, 0.4]);
  });
  def('kiosk', { w: 3, d: 2.4, h: 3, value: 25, shadow: 's', tint: true, colors: [0xffffff, 0xffd6a5, 0xcaffbf, 0xa0c4ff] }, b => {
    b.box(3, 2.2, 2.4, 0xf8f9fa);
    b.box(2.4, 0.9, 0.05, 0x8ecae6, 0, 1, 1.21);
    b.add(BOX, 0xe63946, [0, 2.45, 0.6], [0.35, 0, 0], [3.3, 0.1, 1.5]);
    b.box(3.2, 0.25, 2.6, 0xd62828, 0, 2.2, 0);
    b.box(1.6, 0.5, 0.1, 0xffd166, 0, 2.55, -0.3);
  });
  def('watertower', { w: 4, d: 4, h: 9, value: 60 }, b => {
    for (const [x, z] of [[-1.3, -1.3], [1.3, -1.3], [-1.3, 1.3], [1.3, 1.3]]) b.box(0.25, 5.5, 0.25, 0x6c757d, x, 0, z);
    b.add(CYL12, 0x8d99ae, [0, 6.8, 0], [0, 0, 0], [3.8, 2.8, 3.8]);
    b.add(CONE8, 0x6c757d, [0, 8.6, 0], [0, 0, 0], [4.0, 0.9, 4.0]);
    b.add(CYL12, 0x495057, [0, 5.5, 0], [0, 0, 0], [3.9, 0.15, 3.9]);
  });

  // Vehicles (tinted body: white parts take the instance colour)
  const CAR_COLORS = [0xe63946, 0x1d4ed8, 0xf8f9fa, 0x222222, 0x2a9d8f, 0xffb703, 0x9b5de5, 0x6c757d, 0xf77f00];
  const wheels = (b, xs, z, r = 0.35) => { for (const x of xs) for (const s of [-1, 1]) b.add(WHEEL, 0x1a1a1a, [x, r, s * z], [0, 0, 0], [0.25, r * 2, r * 2]); };
  def('car', { w: 4, d: 1.9, h: 1.5, value: 12, shadow: 's', tint: true, colors: CAR_COLORS, moving: true }, b => {
    b.box(4, 0.6, 1.8, 0xffffff, 0, 0.3, 0);
    b.box(2.1, 0.6, 1.6, 0xffffff, -0.2, 0.9, 0);
    b.box(2.0, 0.5, 1.65, 0x1b263b, -0.2, 0.95, 0);
    b.box(0.05, 0.2, 0.5, 0xfff3b0, 2.0, 0.6, 0.55); b.box(0.05, 0.2, 0.5, 0xfff3b0, 2.0, 0.6, -0.55);
    b.box(0.05, 0.15, 0.4, 0xff0000, -2.0, 0.6, 0.6); b.box(0.05, 0.15, 0.4, 0xff0000, -2.0, 0.6, -0.6);
    wheels(b, [-1.3, 1.3], 0.82);
  });
  def('sportscar', { w: 4.2, d: 1.9, h: 1.2, value: 14, shadow: 's', tint: true, colors: [0xe63946, 0xffd60a, 0xf77f00, 0x00b4d8, 0x111111], moving: true }, b => {
    b.box(4.2, 0.5, 1.85, 0xffffff, 0, 0.25, 0);
    b.add(BOX, 0x1b263b, [-0.3, 0.92, 0], [0, 0, 0.12], [1.8, 0.45, 1.55]);
    b.box(0.5, 0.08, 1.8, 0x222222, -2.0, 1.0, 0);
    b.box(0.1, 0.3, 0.1, 0x222222, -1.95, 0.75, 0.6); b.box(0.1, 0.3, 0.1, 0x222222, -1.95, 0.75, -0.6);
    b.box(0.05, 0.12, 0.5, 0xfff3b0, 2.1, 0.5, 0.55); b.box(0.05, 0.12, 0.5, 0xfff3b0, 2.1, 0.5, -0.55);
    wheels(b, [-1.35, 1.35], 0.82, 0.36);
  });
  def('taxi', { w: 4, d: 1.9, h: 1.8, value: 13, shadow: 's', moving: true }, b => {
    b.box(4, 0.6, 1.8, 0xffc300, 0, 0.3, 0);
    b.box(2.1, 0.6, 1.6, 0xffc300, -0.2, 0.9, 0);
    b.box(2.0, 0.5, 1.65, 0x1b263b, -0.2, 0.95, 0);
    b.box(4.02, 0.12, 1.82, 0x111111, 0, 0.55, 0);
    b.box(0.7, 0.25, 0.35, 0xffffff, -0.2, 1.5, 0);
    wheels(b, [-1.3, 1.3], 0.82);
  });
  def('police', { w: 4.2, d: 1.9, h: 1.8, value: 15, shadow: 's', moving: true }, b => {
    b.box(4.2, 0.6, 1.8, 0xf8f9fa, 0, 0.3, 0);
    b.box(1.4, 0.62, 1.82, 0x1d3557, 0, 0.3, 0);
    b.box(2.1, 0.6, 1.6, 0xf8f9fa, -0.2, 0.9, 0);
    b.box(2.0, 0.5, 1.65, 0x1b263b, -0.2, 0.95, 0);
    b.box(0.3, 0.2, 0.5, 0xff1f1f, -0.2, 1.5, 0.3);
    b.box(0.3, 0.2, 0.5, 0x1f6bff, -0.2, 1.5, -0.3);
    wheels(b, [-1.35, 1.35], 0.82);
  });
  def('van', { w: 4.8, d: 2.1, h: 2.4, value: 18, shadow: 's', tint: true, colors: [0xf8f9fa, 0x8ecae6, 0xffb703, 0x6c757d, 0x2a9d8f], moving: true }, b => {
    b.box(4.8, 1.9, 2.0, 0xffffff, 0, 0.35, 0);
    b.box(0.05, 0.7, 1.8, 0x1b263b, 2.4, 1.3, 0);
    b.box(1.0, 0.6, 2.02, 0x1b263b, 1.7, 1.4, 0);
    wheels(b, [-1.6, 1.5], 0.9, 0.4);
  });
  def('ambulance', { w: 5, d: 2.2, h: 2.6, value: 20, shadow: 's', moving: true }, b => {
    b.box(3.4, 2.2, 2.1, 0xf8f9fa, -0.8, 0.35, 0);
    b.box(1.6, 1.4, 2.0, 0xf8f9fa, 1.7, 0.35, 0);
    b.box(0.05, 0.6, 1.8, 0x1b263b, 2.5, 1.1, 0);
    b.box(3.42, 0.3, 2.12, 0xe63946, -0.8, 1.2, 0);
    b.box(0.6, 0.6, 0.02, 0xe63946, -0.8, 1.7, 1.06);
    b.box(0.4, 0.2, 1.4, 0xff1f1f, 1.7, 1.75, 0);
    wheels(b, [-1.7, 1.6], 0.95, 0.42);
  });
  def('truck', { w: 7, d: 2.4, h: 3.4, value: 35, shadow: 's', tint: true, colors: [0xf8f9fa, 0xe63946, 0x1d4ed8, 0x2a9d8f], moving: true }, b => {
    b.box(4.8, 2.8, 2.4, 0xffffff, -1.0, 0.55, 0);
    b.box(1.9, 2.0, 2.3, 0x457b9d, 2.4, 0.5, 0);
    b.box(0.05, 0.8, 2.0, 0x1b263b, 3.36, 1.6, 0);
    b.box(7, 0.3, 2.0, 0x333333, 0, 0.35, 0);
    wheels(b, [-2.7, -1.6, 2.4], 1.05, 0.48);
  });
  def('bus', { w: 9, d: 2.6, h: 3.2, value: 45, shadow: 's', tint: true, colors: [0xffb703, 0xe63946, 0x2a9d8f, 0x1d4ed8], moving: true }, b => {
    b.box(9, 2.7, 2.5, 0xffffff, 0, 0.4, 0);
    b.box(8.6, 0.8, 2.52, 0x1b263b, -0.1, 1.75, 0);
    b.box(0.05, 1.3, 2.2, 0x1b263b, 4.5, 1.4, 0);
    b.box(9.02, 0.15, 2.52, 0x111111, 0, 1.35, 0);
    b.box(1.5, 0.3, 0.8, 0x6c757d, 0, 3.1, 0);
    wheels(b, [-3, 3], 1.1, 0.5);
  });
  def('tractor', { w: 3.6, d: 2.2, h: 2.8, value: 18, shadow: 's' }, b => {
    b.box(2.2, 1.0, 1.2, 0x2a9d8f, 0.6, 0.8, 0);
    b.box(1.3, 1.5, 1.4, 0x2a9d8f, -0.7, 0.9, 0);
    b.box(1.2, 0.9, 1.3, 0xbde0fe, -0.7, 1.6, 0);
    b.box(1.5, 0.1, 1.6, 0x264653, -0.7, 2.5, 0);
    b.add(CYL6, 0x333333, [1.2, 2.2, 0.3], [0, 0, 0], [0.12, 0.9, 0.12]);
    for (const s of [-1, 1]) {
      b.add(WHEEL, 0x1a1a1a, [-0.9, 0.8, s * 1.0], [0, 0, 0], [0.45, 1.6, 1.6]);
      b.add(WHEEL, 0x1a1a1a, [1.2, 0.45, s * 0.85], [0, 0, 0], [0.3, 0.9, 0.9]);
    }
  });

  // Buildings
  def('house', { w: 6, d: 6, h: 6, value: 60, shadow: 's', tint: true, colors: [0xffffff, 0xffe8d6, 0xd8e2dc, 0xfff1c1, 0xcde7ff] }, b => {
    b.box(5.4, 3.2, 5.4, 0xffffff);
    b.add(PRISM, 0xb23a48, [0, 3.2, 0], [0, 0, 0], [6.0, 2.6, 6.0]);
    b.box(1.1, 2, 0.1, 0x7f5539, 0, 0, 2.72);
    for (const x of [-1.8, 1.8]) { b.box(1.0, 1.0, 0.1, 0x9ecae1, x, 1.5, 2.72); b.box(1.0, 1.0, 0.1, 0x9ecae1, x, 1.5, -2.72); }
    for (const z of [-1.4, 1.4]) { b.box(0.1, 1.0, 1.0, 0x9ecae1, 2.72, 1.5, z); b.box(0.1, 1.0, 1.0, 0x9ecae1, -2.72, 1.5, z); }
    b.box(0.7, 2.0, 0.7, 0x6d6875, 1.6, 3.8, -1.2);
  });
  def('cottage', { w: 5.5, d: 5, h: 5.5, value: 55, shadow: 's', tint: true, colors: [0xffffff, 0xfde2e4, 0xe2ece9, 0xfff1c1] }, b => {
    b.box(5, 2.8, 4.6, 0xffffff);
    b.add(PRISM, 0x3d5a80, [0, 2.8, 0], [0, Math.PI / 2, 0], [5.4, 2.4, 5.6]);
    b.box(1.0, 1.9, 0.1, 0x9c6644, -1.2, 0, 2.32);
    b.box(1.2, 1.0, 0.1, 0x9ecae1, 1.1, 1.3, 2.32);
    b.box(1.2, 1.0, 0.1, 0x9ecae1, -1.1, 1.3, -2.32);
    b.box(1.6, 0.15, 1.0, 0x6d6875, -1.2, 2.0, 2.8);
  });
  def('shed', { w: 3, d: 3, h: 3, value: 20, shadow: 's' }, b => {
    b.box(2.8, 2.1, 2.8, 0xbc6c25);
    b.add(PRISM, 0x6d4c41, [0, 2.1, 0], [0, 0, 0], [3.2, 1, 3.1]);
    b.box(1.0, 1.7, 0.08, 0x7f4f24, 0, 0, 1.42);
  });
  def('garage', { w: 5, d: 6, h: 3.4, value: 35, shadow: 's' }, b => {
    b.box(5, 3, 6, 0xd6ccc2);
    b.box(5.2, 0.4, 6.2, 0x6d6875, 0, 3, 0);
    b.box(3.6, 2.4, 0.1, 0xadb5bd, 0, 0, 3.02);
    for (let i = 0; i < 5; i++) b.box(3.6, 0.04, 0.12, 0x8d99ae, 0, 0.4 + i * 0.45, 3.04);
  });
  def('shop', { w: 8, d: 7, h: 6, value: 80, shadow: 's', tint: true, colors: [0xffffff, 0xffd6a5, 0xcaffbf, 0xbdb2ff, 0xffc6ff, 0x9bf6ff] }, b => {
    b.box(8, 5, 7, 0xffffff);
    b.box(8.2, 0.5, 7.2, 0x6d6875, 0, 5, 0);
    b.box(6.6, 2.4, 0.1, 0x8ecae6, 0, 0.3, 3.52);
    b.box(1.4, 2.4, 0.12, 0x495057, 2.5, 0, 3.53);
    b.add(BOX, 0xe63946, [0, 3.0, 4.1], [0.45, 0, 0], [8.0, 0.12, 1.5]);
    for (let i = 0; i < 4; i++) b.add(BOX, 0xffffff, [-3 + i * 2, 3.01, 4.1], [0.45, 0, 0], [0.9, 0.13, 1.5]);
    b.box(4.4, 0.9, 0.2, 0x264653, 0, 3.8, 3.55);
    b.box(1.6, 1.0, 1.4, 0xadb5bd, -2.4, 5.5, -1.5);
  });
  def('cafe', { w: 7, d: 7, h: 5.5, value: 75, shadow: 's' }, b => {
    b.box(7, 4.4, 7, 0xf2e8cf);
    b.box(7.2, 0.4, 7.2, 0x6a4c93, 0, 4.4, 0);
    b.box(5.6, 2.2, 0.1, 0x8ecae6, 0, 0.4, 3.52);
    b.add(BOX, 0x2a9d8f, [0, 2.9, 4.0], [0.4, 0, 0], [7.0, 0.12, 1.4]);
    b.add(CYL12, 0x7f5539, [0, 4.8, 0], [0, 0, 0], [1.4, 0.8, 1.4]);
    b.add(CYL12, 0xffffff, [0, 5.25, 0], [0, 0, 0], [1.2, 0.1, 1.2]);
  });
  def('gasstation', { w: 10, d: 7, h: 5, value: 90, shadow: 's' }, b => {
    b.box(10, 0.3, 7, 0xe63946, 0, 4.3, 0);
    b.box(10.1, 0.35, 7.1, 0xffffff, 0, 4.0, 0);
    for (const [x, z] of [[-4, -2.6], [4, -2.6], [-4, 2.6], [4, 2.6]]) b.box(0.4, 4, 0.4, 0xf8f9fa, x, 0, z);
    for (const x of [-2, 2]) { b.box(0.8, 1.6, 0.6, 0xe63946, x, 0, 0); b.box(0.6, 0.4, 0.02, 0x111111, x, 1.0, 0.31); }
    b.box(1.8, 0.8, 0.3, 0xffd166, 0, 4.7, 3.4);
  });
  def('office', { w: 9, d: 9, h: 14, value: 160, shadow: 's', tint: true, colors: [0xffffff, 0xe0e7ff, 0xffe5d9, 0xd8f3dc] }, b => {
    wallBox(b, 9, 13, 9, 0xffffff, 0x6c757d, 0, 0, 3.25, 2.25);
    b.box(9.3, 0.5, 9.3, 0x495057, 0, 13, 0);
    b.box(2.5, 1.5, 2.5, 0xadb5bd, 1.5, 13.5, 1.5);
    b.box(0.2, 3, 0.2, 0xd62828, -2.5, 13.5, -2.5);
  });
  def('apartment', { w: 10, d: 7, h: 12, value: 140, shadow: 's', tint: true, colors: [0xffffff, 0xffcad4, 0xffe5b4, 0xcdeac0, 0xd0e1ff] }, b => {
    wallBox(b, 10, 11, 7, 0xffffff, 0x8d99ae, 0, 0, 2.75, 2.5);
    b.box(10.4, 0.4, 7.4, 0x6d6875, 0, 11, 0);
    for (let f = 1; f < 4; f++) b.box(9.6, 0.15, 0.7, 0xdee2e6, 0, f * 2.75, 3.85);
    b.box(1.5, 2.3, 0.15, 0x6f4518, 0, 0, 3.55);
    b.box(1.5, 1.4, 1.5, 0x495057, -3, 11.4, -1.5);
  });
  def('tower', { w: 12, d: 12, h: 30, value: 320, shadow: 's', tint: true, colors: [0xffffff, 0xd7e3fc, 0xe2eafc, 0xc1d3fe] }, b => {
    wallBox(b, 12, 22, 12, 0xffffff, 0x495057, 0, 0, 3.0, 2.4);
    wallBox(b, 8.5, 6, 8.5, 0xffffff, 0x495057, 0, 0, 3.0, 2.4, 22);
    b.box(9, 0.4, 9, 0x343a40, 0, 22, 0);
    b.box(4, 1.2, 4, 0x6c757d, 0, 28, 0);
    b.add(CYL6, 0xadb5bd, [0, 31, 0], [0, 0, 0], [0.2, 4, 0.2]);
    b.add(SPH, 0xff2d2d, [0, 33, 0], [0, 0, 0], [0.4, 0.4, 0.4]);
  });
  def('skyscraper', { w: 11, d: 11, h: 40, value: 400, shadow: 's' }, b => {
    wallBox(b, 11, 34, 11, 0x9ad1ff, 0x343a40, 0, 0, 2.8, 2.2);
    b.box(11.4, 0.6, 11.4, 0x343a40, 0, 34, 0);
    wallBox(b, 7, 5, 7, 0x9ad1ff, 0x343a40, 0, 0, 2.8, 2.2, 34.6);
    b.add(CONE6, 0x6c757d, [0, 42, 0], [0, 0, 0], [3, 5, 3]);
  });
  def('church', { w: 8, d: 12, h: 16, value: 220, shadow: 's' }, b => {
    b.box(7, 6, 10, 0xf1e3d3, 0, 0, 1);
    b.add(PRISM, 0x7c2d12, [0, 6, 1], [0, Math.PI / 2, 0], [10.4, 3.5, 7.6]);
    b.box(3.6, 11, 3.6, 0xf1e3d3, 0, 0, -4.2);
    b.add(CONE8, 0x7c2d12, [0, 13.5, -4.2], [0, Math.PI / 8, 0], [4.6, 5, 4.6]);
    b.box(1.3, 2.6, 0.1, 0x6f4518, 0, 0, 6.02);
    b.add(CYL12, 0xffd166, [0, 8.8, -2.38], [Math.PI / 2, 0, 0], [1.6, 0.1, 1.6]);
    for (const z of [-1, 2, 5]) { b.box(0.1, 2.2, 1, 0x9ecae1, 3.52, 2, z); b.box(0.1, 2.2, 1, 0x9ecae1, -3.52, 2, z); }
  });
  def('barn', { w: 8, d: 10, h: 8, value: 120, shadow: 's' }, b => {
    b.box(8, 5, 10, 0xae2012);
    b.add(PRISM, 0x5c4033, [0, 5, 0], [0, Math.PI / 2, 0], [10.4, 3, 8.6]);
    b.box(3, 3.6, 0.1, 0xf8f9fa, 0, 0, 5.02);
    b.add(BOX, 0xae2012, [0, 1.8, 5.06], [0, 0, 0.88], [4.4, 0.25, 0.05]);
    b.add(BOX, 0xae2012, [0, 1.8, 5.06], [0, 0, -0.88], [4.4, 0.25, 0.05]);
  });
}

// ---- shared textures ---------------------------------------------------------
export function makeWindowTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#e6e6e6'; g.fillRect(0, 56, 64, 8);
  const grd = g.createLinearGradient(0, 10, 0, 48);
  grd.addColorStop(0, '#3a5a80'); grd.addColorStop(1, '#22344d');
  g.fillStyle = grd; g.fillRect(10, 12, 44, 36);
  g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(12, 14, 14, 32);
  g.fillStyle = '#d0d0d0'; g.fillRect(31, 12, 2, 36);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function makeShadowTexture(square) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (square) {
    g.filter = 'blur(5px)';
    g.fillStyle = 'rgba(0,0,0,1)';
    g.fillRect(9, 9, 46, 46);
  } else {
    const grd = g.createRadialGradient(32, 32, 4, 32, 32, 31);
    grd.addColorStop(0, 'rgba(0,0,0,1)');
    grd.addColorStop(0.6, 'rgba(0,0,0,0.6)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  }
  const t = new THREE.CanvasTexture(c);
  return t;
}
