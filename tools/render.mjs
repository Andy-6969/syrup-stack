// Offline renderer for entry.png: a stack of pancakes with maple syrup, butter and berries,
// ray-marched from signed distance fields. Node 22+, standard library only, deterministic.
//
//   node tools/render.mjs                 -> entry.png (1024 x 1024, 24 samples per pixel)
//   W=256 SPP=4 OUT=preview.png node tools/render.mjs
//
// Every random choice comes from fixed seeds, so the same command always writes the same bytes.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { writeFileSync, unlinkSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const W = Number(process.env.W || 1024);
const H = W;
const SPP = Number(process.env.SPP || 24);
const GRAIN = Number(process.env.GRAIN ?? 0.022);

// ---------------------------------------------------------------- small math
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x, y, z) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const a = hash3(ix, iy, iz), b = hash3(ix + 1, iy, iz), c = hash3(ix, iy + 1, iz), d = hash3(ix + 1, iy + 1, iz);
  const e = hash3(ix, iy, iz + 1), f = hash3(ix + 1, iy, iz + 1), g = hash3(ix, iy + 1, iz + 1), h = hash3(ix + 1, iy + 1, iz + 1);
  return mix(mix(mix(a, b, ux), mix(c, d, ux), uy), mix(mix(e, f, ux), mix(g, h, ux), uy), uz);
}

function fbm(x, y, z, oct) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, z * f); n += a; f *= 2.07; a *= 0.5; }
  return s / n;
}

function smin(a, b, k) { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return mix(b, a, h) - k * h * (1 - h); }

// ---------------------------------------------------------------- the scene
const rnd = mulberry32(20261114);

const NP = 6;          // pancakes in the stack
const PH = 0.215;      // pancake thickness
const PE = 0.08;       // edge rounding
const pans = [];
{
  let yc = PH / 2 - 0.004;
  for (let i = 0; i < NP; i++) {
    const co = [];
    for (let k = 0; k < 8; k++) co.push((rnd() - 0.5) * 2);
    pans.push({ cx: (rnd() - 0.5) * 0.09, cz: (rnd() - 0.5) * 0.09, y: yc, r: 1.0 - 0.012 * i + (rnd() - 0.5) * 0.05, co, tone: rnd(), tx: (rnd() - 0.5) * 0.05, tz: (rnd() - 0.5) * 0.05 });
    yc += PH * 0.92;
  }
  pans[NP - 1].tx = 0; pans[NP - 1].tz = 0;
}
const TOP = pans[NP - 1];
const YTOP = TOP.y + PH / 2;             // top face of the stack at its centre
const SYR_T = 0.03;                       // syrup thickness on the top

// drips of syrup down the side: angle (atan2(z, x)), length down the side, half width
const drips = [
  [0.50, 0.55, 0.070], [1.02, 1.32, 0.085], [1.42, 0.30, 0.050], [1.86, 0.88, 0.075],
  [2.36, 0.46, 0.062], [2.80, 1.18, 0.080], [-0.35, 0.62, 0.070], [3.55, 0.95, 0.070],
].map(([a, d, w]) => ({ a, d, w, tip: w * 0.95 }));

// puddles of syrup on the plate below the longest drips
const puddles = [1.0].map((a) => ({ x: Math.cos(a) * 1.07, z: Math.sin(a) * 1.07, a }));

// butter pat on the top
const BUT = { x: 0.08, y: YTOP + SYR_T + 0.075, z: 0.16, yaw: 0.45, hx: 0.21, hy: 0.08, hz: 0.165 };

// berries: [x, y, z, radius]
const blue = [];
const rasp = [];
{
  const topRing = [[-0.46, 0.3], [0.55, 0.45], [-0.12, 0.62], [0.38, -0.36], [-0.5, -0.25]];
  for (const [x, z] of topRing) { const r = 0.072 + rnd() * 0.012; blue.push([x, YTOP + SYR_T + r * 0.82, z, r, rnd() * 6.28, rnd()]); }
  const plate = [[1.32, 0.55], [1.18, 0.85], [-1.28, 0.62], [-1.05, 0.98], [0.42, 1.38], [-0.3, 1.42]];
  for (const [x, z] of plate) { const r = 0.075 + rnd() * 0.012; blue.push([x, r * 0.9, z, r, rnd() * 6.28, rnd()]); }
  rasp.push([0.6, YTOP + SYR_T + 0.1, 0.08, 0.105], [-0.48, YTOP + SYR_T + 0.1, -0.02, 0.1], [1.42, 0.11, 0.18, 0.11], [0.08, 0.11, 1.45, 0.105]);
}
// drupelets of a raspberry, laid out on a golden-angle spiral of a squashed sphere (local unit coordinates)
const drup = [];
for (let i = 0; i < 46; i++) {
  const t = (i + 0.5) / 46, yy = 1 - 2 * t * 0.92, rr = Math.sqrt(1 - yy * yy), ph = i * 2.39996;
  drup.push([Math.cos(ph) * rr, yy * 1.1, Math.sin(ph) * rr]);
}

// mint leaves near the butter: anchor, yaw, length, width, tilt
const mint = [
  { x: -0.18, y: YTOP + SYR_T + 0.05, z: 0.36, yaw: 2.3, L: 0.2, Wd: 0.1, tilt: 0.35 },
  { x: -0.18, y: YTOP + SYR_T + 0.06, z: 0.36, yaw: 3.4, L: 0.17, Wd: 0.085, tilt: 0.5 },
  { x: -0.18, y: YTOP + SYR_T + 0.07, z: 0.36, yaw: 1.3, L: 0.15, Wd: 0.075, tilt: 0.6 },
];

// ---------------------------------------------------------------- distance functions
let HARM = new Float64Array(8);
function harmonics(th) {
  const c1 = Math.cos(th), s1 = Math.sin(th);
  const c2 = c1 * c1 - s1 * s1, s2 = 2 * s1 * c1;
  const c3 = c2 * c1 - s2 * s1, s3 = s2 * c1 + c2 * s1;
  const c5 = c3 * c2 - s3 * s2, s5 = s3 * c2 + c3 * s2;
  const c7 = c5 * c2 - s5 * s2, s7 = s5 * c2 + c5 * s2;
  HARM[0] = c2; HARM[1] = s2; HARM[2] = c3; HARM[3] = s3; HARM[4] = c5; HARM[5] = s5; HARM[6] = c7; HARM[7] = s7;
}
function panR(P) {
  const c = P.co, h = HARM;
  return P.r * (1 + 0.02 * (c[0] * h[0] + c[1] * h[1]) + 0.014 * (c[2] * h[2] + c[3] * h[3]) + 0.007 * (c[4] * h[4] + c[5] * h[5]) + 0.004 * (c[6] * h[6] + c[7] * h[7]));
}
function sdPancake(x, y, z, P) {
  const dx = x - P.cx, dz = z - P.cz;
  const rho = Math.sqrt(dx * dx + dz * dz);
  const R = panR(P);
  const hh = PH * 0.5 * (1 - 0.12 * Math.min(rho * rho / (R * R), 1.2));
  const qx = rho - (R - PE), qy = Math.abs(y - P.y - P.tx * dx - P.tz * dz) - (hh - PE);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - PE;
}
function sdStack(x, y, z) {
  let d = 1e9;
  for (let i = 0; i < NP; i++) { const di = sdPancake(x, y, z, pans[i]); if (di < d) d = di; }
  // hand-poured batter is never a perfect disc: a soft lumpy displacement
  if (d < 0.08) d += smooth(0.08, 0.03, d) * (0.007 * (vnoise(x * 5 + 3, y * 5, z * 5) - 0.5) + 0.003 * (vnoise(x * 13, y * 13, z * 13 + 5) - 0.5));
  return d;
}
function wrapPi(a) { a %= 2 * Math.PI; if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a; }

// syrup thickness at a point near the stack (0 where there is no syrup)
function syrupThickness(x, y, z, th) {
  const dx = x - TOP.cx, dz = z - TOP.cz;
  const rho = Math.sqrt(dx * dx + dz * dz);
  const R = panR(TOP);
  const s = rho + Math.max(0, YTOP - 0.03 - y);
  let dc = 1e9, bulb = 0;
  let pool = R * (0.84 + 0.04 * Math.sin(2 * th + 0.7) + 0.035 * Math.sin(3 * th + 2.1) + 0.02 * Math.sin(7 * th + 0.3));
  for (const D of drips) {
    const arc0 = wrapPi(th - D.a) * R;
    pool += 0.16 * Math.exp(-(arc0 * arc0) / (0.2 * 0.2));
    if (rho > 0.7 * R) {
      const depth = s - R * 0.93;
      // the stream wanders a little and pinches and swells as it runs down
      const arc = arc0 - 0.022 * Math.sin(depth * 6.5 + D.a * 5) - 0.012 * Math.sin(depth * 13 + D.a * 3);
      const end = D.d - D.tip;
      const cy = clamp(depth, -0.15, end);
      const w = D.w * (1 - 0.45 * clamp(depth / D.d, 0, 1)) * (1 + 0.14 * Math.sin(depth * 9 + D.a * 7)) + 0.05 * Math.exp(-Math.max(depth, 0) * 9);
      const dd = Math.hypot(arc, depth - cy) - w;
      if (dd < dc) dc = dd;
      const by = depth - end;
      bulb += 0.026 * Math.exp(-(by * by + arc * arc) / (D.tip * D.tip)) * clamp(-dd / 0.02, 0, 1);
    }
  }
  if (y > TOP.y) dc = Math.min(dc, s - pool);
  // syrup thins out towards its edges instead of ending in a rounded tube
  const t = clamp(-dc / 0.06, 0, 1);
  return SYR_T * t ** 0.75 + bulb * 0.7;
}

function sdRoundBoxLocal(qx, qy, qz, hx, hy, hz, r) {
  const ax = Math.abs(qx) - hx + r, ay = Math.abs(qy) - hy + r, az = Math.abs(qz) - hz + r;
  return len3(Math.max(ax, 0), Math.max(ay, 0), Math.max(az, 0)) + Math.min(Math.max(ax, Math.max(ay, az)), 0) - r;
}
function sdButter(x, y, z) {
  const dx = x - BUT.x, dy = y - BUT.y, dz = z - BUT.z;
  const c = Math.cos(BUT.yaw), s = Math.sin(BUT.yaw);
  const qx = c * dx + s * dz, qz = -s * dx + c * dz;
  // melting: the lower part spreads a little
  const sag = 1 + 0.1 * clamp(-(dy) / BUT.hy, 0, 1.4);
  const box = sdRoundBoxLocal(qx / sag, dy, qz / sag, BUT.hx, BUT.hy, BUT.hz, 0.035) * 0.9;
  // a melted foot under the pat
  const fy = y - (YTOP + SYR_T + 0.002);
  const foot = (Math.hypot(qx / 1.45, qz / 1.5) - 0.22) * 0.7;
  const footD = Math.max(foot, Math.abs(fy) - 0.012);
  return smin(box, footD, 0.04);
}
function sdBlue(x, y, z, b) {
  const dx = x - b[0], dy = (y - b[1]) / 0.9, dz = z - b[2];
  return (len3(dx, dy, dz) - b[3]) * 0.9;
}
function sdRasp(x, y, z, b) {
  const r = b[3];
  const dx = x - b[0], dy = y - b[1], dz = z - b[2];
  const bound = len3(dx, dy / 1.1, dz) - r * 1.25;
  if (bound > 0.03) return bound;
  let d = len3(dx, dy / 1.1, dz) - r * 0.82;
  const s = r * 0.86, dr = r * 0.3;
  for (let i = 0; i < drup.length; i++) {
    const p = drup[i];
    const e = len3(dx - p[0] * s, dy - p[1] * s, dz - p[2] * s) - dr;
    d = smin(d, e, 0.012);
  }
  return d;
}
function leafLocal(x, y, z, L) {
  const dx = x - L.x, dy = y - L.y, dz = z - L.z;
  const c = Math.cos(L.yaw), s = Math.sin(L.yaw);
  let u = c * dx + s * dz, v = -s * dx + c * dz, w = dy;
  const ct = Math.cos(L.tilt), st = Math.sin(L.tilt);
  const u2 = ct * u + st * w, w2 = -st * u + ct * w;
  return [u2, v, w2];
}
function sdLeaf(x, y, z, L) {
  const [u, v, w] = leafLocal(x, y, z, L);
  const uu = u - L.L;                 // leaf runs from the anchor along +u
  const ex = uu / L.L, ev = v / (L.Wd * (1 - 0.35 * ex));
  const d2 = (Math.sqrt(ex * ex + ev * ev) - 1) * Math.min(L.L, L.Wd) * 0.8;
  const bend = w - (0.28 * Math.abs(v) + 0.25 * (uu * uu) / L.L - 0.02);
  return Math.max(d2, Math.abs(bend) - 0.006) * 0.7;
}
function plateProfile(rho) { return rho < 1.25 ? 0 : 0.12 * ((rho - 1.25) / 0.5) ** 2; }
function sdPlate(x, y, z) {
  const rho = Math.sqrt(x * x + z * z);
  if (rho < 1.75) {
    const f = plateProfile(rho);
    const slope = rho < 1.25 ? 0 : 0.48 * (rho - 1.25) / 0.5;
    return (Math.abs(y + 0.025 - f) - 0.025) / Math.sqrt(1 + slope * slope);
  }
  return Math.hypot(rho - 1.75, y + 0.025 - 0.12) - 0.025;
}
function sdPuddle(x, y, z, P) {
  const dx = x - P.x, dz = z - P.z;
  const c = Math.cos(P.a), s = Math.sin(P.a);
  const r = c * dx + s * dz, t = -s * dx + c * dz;
  const ang = Math.atan2(t, r);
  const k = 1 + 0.16 * Math.sin(3 * ang + P.a) + 0.08 * Math.sin(5 * ang + 2 * P.a);
  return (len3(r / (0.12 * k), (y - 0.0) / 0.014, t / (0.2 * k)) - 1) * 0.013;
}

// a thin stream of syrup poured from above, landing beside the butter
const POUR = { x: -0.3, z: 0.22, y0: YTOP + SYR_T - 0.01 };
function sdPour(x, y, z) {
  if (y < POUR.y0 - 0.05) return 1e9;
  const h = y - POUR.y0;
  const cx = POUR.x + 0.025 * Math.sin(h * 2.3 + 0.4) + 0.01 * Math.sin(h * 5.1), cz = POUR.z + 0.015 * Math.sin(h * 1.7 + 1.1);
  const r = 0.017 + 0.022 * Math.exp(-Math.max(h, 0) * 7) + 0.004 * Math.sin(h * 11);
  const stream = Math.hypot(x - cx, z - cz) - r;
  // the coil where it lands
  const coil = Math.max(Math.hypot(x - POUR.x, z - POUR.z) - 0.085, Math.abs(y - POUR.y0 - 0.018) - 0.022);
  return smin(stream * 0.8, coil, 0.04);
}

const STACK_BOUND_R = 1.3, STACK_BOUND_TOP = YTOP + 0.38;

// the scene's distance (everything but the table, which is an analytic plane)
function map(x, y, z) {
  let d = sdPlate(x, y, z);
  const rho = Math.sqrt(x * x + z * z);
  const bound = Math.max(rho - STACK_BOUND_R, y - STACK_BOUND_TOP, -y - 0.05);
  if (bound < 0.05) {
    harmonics(Math.atan2(z, x));
    const st = sdStack(x, y, z);
    let ds = st;
    if (st < 0.25) ds = st - syrupThickness(x, y, z, Math.atan2(z - TOP.cz, x - TOP.cx));
    d = Math.min(d, ds);
    if (y > YTOP - 0.1) {
      d = Math.min(d, sdButter(x, y, z));
      for (const L of mint) d = Math.min(d, sdLeaf(x, y, z, L));
    }
  } else d = Math.min(d, bound);
  const pb = Math.max(Math.hypot(x - POUR.x, z - POUR.z) - 0.14, POUR.y0 - 0.06 - y);
  d = Math.min(d, pb > 0.04 ? pb : sdPour(x, y, z));
  for (const b of blue) d = Math.min(d, sdBlue(x, y, z, b));
  for (const b of rasp) d = Math.min(d, sdRasp(x, y, z, b));
  for (const P of puddles) d = Math.min(d, sdPuddle(x, y, z, P));
  return d;
}

// which material the surface at p belongs to
const M_PANCAKE = 1, M_SYRUP = 2, M_BUTTER = 3, M_BLUE = 4, M_RASP = 5, M_MINT = 6, M_PLATE = 7, M_STREAM = 8;
function material(x, y, z) {
  let best = sdPlate(x, y, z), id = M_PLATE, extra = 0, which = 0;
  harmonics(Math.atan2(z, x));
  const st = sdStack(x, y, z);
  const th = syrupThickness(x, y, z, Math.atan2(z - TOP.cz, x - TOP.cx));
  const ds = st - th;
  if (ds < best) { best = ds; id = th > 0.004 && st > th * 0.35 ? M_SYRUP : M_PANCAKE; extra = th; }
  const db = sdButter(x, y, z); if (db < best) { best = db; id = M_BUTTER; }
  for (let i = 0; i < mint.length; i++) { const dl = sdLeaf(x, y, z, mint[i]); if (dl < best) { best = dl; id = M_MINT; which = i; } }
  for (let i = 0; i < blue.length; i++) { const d = sdBlue(x, y, z, blue[i]); if (d < best) { best = d; id = M_BLUE; which = i; } }
  for (let i = 0; i < rasp.length; i++) { const d = sdRasp(x, y, z, rasp[i]); if (d < best) { best = d; id = M_RASP; which = i; } }
  for (const P of puddles) { const d = sdPuddle(x, y, z, P); if (d < best) { best = d; id = M_SYRUP; extra = 0.05; } }
  const dp = sdPour(x, y, z); if (dp < best) { best = dp; id = M_STREAM; extra = 0.05; }
  return { id, extra, which, stackDist: st };
}

function normalAt(x, y, z) {
  const e = 0.0007;
  const a = map(x + e, y - e, z - e), b = map(x - e, y - e, z + e), c = map(x - e, y + e, z - e), d = map(x + e, y + e, z + e);
  const nx = a - b - c + d, ny = -a - b + c + d, nz = -a + b - c + d;
  const l = len3(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

// ---------------------------------------------------------------- lights and environment
const norm = (v) => { const l = len3(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const KEY = norm([-0.8, 0.58, -0.38]);
const KEYC = [3.9, 3.15, 2.3];
const FILL = norm([0.75, 0.35, 0.6]);
const FILLC = [0.3, 0.32, 0.38];
const RIM = norm([0.45, 0.42, -0.8]);
const RIMC = [1.7, 1.38, 1.0];
const BACK = norm([-0.1, 0.75, -1]);

function env(dx, dy, dz) {
  // a dark studio: a big warm softbox on the key side, a long strip behind, a weak card on the fill side
  let r = 0.012, g = 0.01, b = 0.009;
  const k = dx * KEY[0] + dy * KEY[1] + dz * KEY[2];
  const kb = smooth(0.86, 0.95, k) * 6;
  r += kb * 1.0; g += kb * 0.84; b += kb * 0.64;
  const bk = dx * BACK[0] + dy * BACK[1] + dz * BACK[2];
  const bb = smooth(0.93, 0.975, bk) * 2.4;
  r += bb * 1.0; g += bb * 0.8; b += bb * 0.58;
  const f = dx * FILL[0] + dy * FILL[1] + dz * FILL[2];
  const fb = smooth(0.92, 0.97, f) * 1.0;
  r += fb * 0.8; g += fb * 0.85; b += fb * 0.95;
  const up = smooth(0.3, 1.0, dy) * 0.07;
  r += up * 0.9; g += up * 0.8; b += up * 0.7;
  return [r, g, b];
}

let JIT = 0.5; // a per-sample random number: it jitters the shadow march so its steps never band
function softShadow(x, y, z, lx, ly, lz, k) {
  let res = 1, t = 0.015 + 0.015 * JIT;
  for (let i = 0; i < 80 && t < 5; i++) {
    const h = map(x + lx * t, y + ly * t, z + lz * t);
    if (h < 0.0002) return 0;
    res = Math.min(res, (k * h) / t);
    t += clamp(h, 0.006, 0.2) * (0.75 + 0.5 * JIT);
  }
  // the table is a plane below everything, so it never shadows the scene
  return clamp(res, 0, 1);
}

function ambientOcc(x, y, z, nx, ny, nz) {
  let occ = 0, sc = 1;
  for (let i = 1; i <= 5; i++) {
    const h = 0.015 + 0.06 * i;
    const d = map(x + nx * h, y + ny * h, z + nz * h);
    occ += (h - d) * sc;
    sc *= 0.72;
  }
  // the table plane occludes from below
  return clamp(1 - 1.6 * occ, 0, 1);
}

function ggx(nx, ny, nz, vx, vy, vz, lx, ly, lz, rough, f0) {
  let hx = vx + lx, hy = vy + ly, hz = vz + lz;
  const hl = len3(hx, hy, hz); hx /= hl; hy /= hl; hz /= hl;
  const ndh = Math.max(0, nx * hx + ny * hy + nz * hz);
  const ndl = Math.max(0, nx * lx + ny * ly + nz * lz);
  const ndv = Math.max(1e-4, nx * vx + ny * vy + nz * vz);
  const vdh = Math.max(0, vx * hx + vy * hy + vz * hz);
  const a = rough * rough, a2 = a * a;
  const dd = ndh * ndh * (a2 - 1) + 1;
  const D = a2 / (Math.PI * dd * dd);
  const kk = (rough + 1) ** 2 / 8;
  const G = (ndl / (ndl * (1 - kk) + kk)) * (ndv / (ndv * (1 - kk) + kk));
  const F = f0 + (1 - f0) * (1 - vdh) ** 5;
  return (D * G * F) / (4 * ndv) ;
}

// ---------------------------------------------------------------- surface colours
function pancakeAlbedo(x, y, z, ny, P) {
  // golden-brown faces, browning that wraps round the rounded edges
  const ay = Math.abs(ny);
  const face = smooth(0.12, 0.6, ay);
  const n1 = fbm(x * 3.1 + 7, y * 3.1, z * 3.1, 4);
  const n2 = vnoise(x * 16, y * 16 + 3, z * 16);
  const br = clamp(0.45 + (n1 - 0.5) * 1.5 + (n2 - 0.5) * 0.35 + (P ? (P.tone - 0.5) * 0.18 : 0), 0, 1);
  const fr = mix(0.42, 0.8, br), fg = mix(0.18, 0.44, br), fb = mix(0.04, 0.13, br);
  // the side: golden crumb
  const sv = vnoise(x * 18, y * 18, z * 18);
  const sr = mix(0.85, 0.9, sv), sg = mix(0.57, 0.63, sv), sb = mix(0.25, 0.3, sv);
  // open air pockets of the crumb: dark little holes
  const pore = crumbHoles(x, y, z);
  const pr = sr * (1 - 0.3 * pore), pg = sg * (1 - 0.38 * pore), pb = sb * (1 - 0.45 * pore);
  // a caramelised, uneven crust where the face turns into the side
  const lace = fbm(x * 7 + 2, y * 7, z * 7, 4);
  const f2 = clamp(face + smooth(0.08, 0.5, ay) * smooth(0.5, 0.75, lace) * 0.8, 0, 1);
  const m = 1 - pore * face * 0.5;
  return [mix(pr, fr, f2) * m, mix(pg, fg, f2) * m, mix(pb, fb, f2) * m];
}

// cellular noise: distance to the nearest of one random point per cell
function worley(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let best = 9;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const cx = ix + a, cy = iy + b, cz = iz + c;
    const px = cx + hash3(cx, cy, cz), py = cy + hash3(cx + 31, cy, cz), pz = cz + hash3(cx, cy + 57, cz);
    const d = (px - x) ** 2 + (py - y) ** 2 + (pz - z) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
function crumbHoles(x, y, z) {
  // two sizes of bubbles, only some cells open into a hole
  const a = 1 - smooth(0.2, 0.3, worley(x * 30, y * 30, z * 30));
  const b = 1 - smooth(0.12, 0.2, worley(x * 75 + 9, y * 75, z * 75));
  return clamp(a * smooth(0.5, 0.65, vnoise(x * 9, y * 9, z * 9)) * 0.8 + b * 0.3, 0, 1);
}
function pancakeHeight(x, y, z) {
  return 0.003 * fbm(x * 9, y * 9, z * 9, 3) - 0.0018 * crumbHoles(x, y, z) + 0.0004 * vnoise(x * 60, y * 60, z * 60);
}

function syrupRipple(x, y, z) {
  return 0.006 * fbm(x * 3.5 + 11, y * 3.5, z * 3.5, 3);
}

function bump(n, x, y, z, fn, k) {
  const e = 0.0015;
  const h0 = fn(x, y, z);
  const gx = (fn(x + e, y, z) - h0) / e, gy = (fn(x, y + e, z) - h0) / e, gz = (fn(x, y, z + e) - h0) / e;
  const dot = gx * n[0] + gy * n[1] + gz * n[2];
  const bx = n[0] - k * (gx - dot * n[0]), by = n[1] - k * (gy - dot * n[1]), bz = n[2] - k * (gz - dot * n[2]);
  const l = len3(bx, by, bz);
  return [bx / l, by / l, bz / l];
}

function woodAlbedo(x, z) {
  const plank = Math.floor(z / 0.95 + 100);
  const off = hash3(plank, 7, 1) * 10;
  const warp = fbm(x * 0.35 + off, z * 1.5, plank, 4);
  const g = Math.sin((z * 9 + warp * 6 + x * 0.15) * 3.1 + off) * 0.5 + 0.5;
  const fine = vnoise(x * 2.5 + off, z * 60, plank);
  const t = clamp(0.35 * g + 0.45 * fine + 0.2 * warp, 0, 1);
  const base = 0.7 + 0.4 * hash3(plank, 3, 9);
  const seam = Math.abs(((z / 0.95 + 100) % 1) - 0.5) > 0.494 ? 0.4 : 1;
  const k = base * seam;
  return [mix(0.1, 0.24, t) * k, mix(0.05, 0.12, t) * k, mix(0.025, 0.055, t) * k];
}

// ---------------------------------------------------------------- shading
const TABLE_Y = -0.05;

function shade(px, py, pz, dx, dy, dz, hitTable) {
  const vx = -dx, vy = -dy, vz = -dz;
  let n, alb, rough, f0, wrap = 0, spec = 1, emitR = 0, emitG = 0, emitB = 0, trans = null, sss = 0;
  let occ;
  if (hitTable) {
    n = [0, 1, 0];
    alb = woodAlbedo(px, pz);
    rough = 0.42; f0 = 0.035;
    occ = ambientOcc(px, py, pz, 0, 1, 0);
  } else {
    n = normalAt(px, py, pz);
    const m = material(px, py, pz);
    switch (m.id) {
      case M_PANCAKE: {
        let P = null, bd = 1e9;
        for (const q of pans) { const d = Math.abs(sdPancake(px, py, pz, q)); if (d < bd) { bd = d; P = q; } }
        alb = pancakeAlbedo(px, py, pz, n[1], P);
        n = bump(n, px, py, pz, pancakeHeight, 1.0);
        rough = 0.62; f0 = 0.03; wrap = 0.35; sss = 0.25;
        break;
      }
      case M_SYRUP: {
        // what lies under the syrup, seen through it
        const under = m.extra > 0.04 && m.stackDist > 0.03 ? [0.08, 0.07, 0.065] : pancakeAlbedo(px, py, pz, n[1], TOP);
        const path = 2.2 * m.extra;
        const tr = Math.exp(-6.5 * path), tg = Math.exp(-17 * path), tb = Math.exp(-46 * path);
        alb = [under[0] * tr * 1.05 + 0.035, under[1] * tg + 0.01, under[2] * tb];
        n = bump(n, px, py, pz, syrupRipple, 1.0);
        rough = 0.06; f0 = 0.045; spec = 1.3; wrap = 0.2; sss = 0.5;
        break;
      }
      case M_STREAM: {
        // a pouring ribbon of maple syrup, glowing where the light comes through it
        alb = [0.62, 0.27, 0.04];
        rough = 0.05; f0 = 0.045; spec = 1.6; wrap = 0.4; sss = 2.2;
        break;
      }
      case M_BUTTER: {
        const t = vnoise(px * 30, py * 30, pz * 30);
        alb = [0.96, mix(0.8, 0.84, t), mix(0.38, 0.44, t)];
        rough = 0.24; f0 = 0.035; wrap = 0.6; sss = 0.5;
        break;
      }
      case M_BLUE: {
        const b = blue[m.which];
        const cx = px - b[0], cy = py - b[1], cz = pz - b[2];
        const cl = len3(cx, cy, cz);
        // crown: a small dark star at a tilted pole
        const pa = b[4], pt = 0.6 + b[5] * 0.7;
        const ax = Math.sin(pt) * Math.cos(pa), ay = Math.cos(pt), az = Math.sin(pt) * Math.sin(pa);
        const cd = (cx * ax + cy * ay + cz * az) / cl;
        const crown = smooth(0.9, 0.96, cd);
        const bloom = fbm(px * 25, py * 25, pz * 25, 3);
        const dust = clamp(0.3 + (bloom - 0.5) * 1.4 + 0.25, 0, 1);
        alb = [mix(0.045, 0.2, dust) * (1 - 0.6 * crown), mix(0.05, 0.22, dust) * (1 - 0.6 * crown), mix(0.13, 0.36, dust) * (1 - 0.5 * crown)];
        rough = mix(0.32, 0.55, dust); f0 = 0.04;
        break;
      }
      case M_RASP: {
        const v = vnoise(px * 40, py * 40, pz * 40);
        alb = [mix(0.6, 0.8, v), mix(0.035, 0.07, v), mix(0.08, 0.12, v)];
        rough = 0.2; f0 = 0.04; wrap = 0.6; sss = 1.5;
        break;
      }
      case M_MINT: {
        const L = mint[m.which];
        const [u, v] = leafLocal(px, py, pz, L);
        const rib = 1 - smooth(0.004, 0.012, Math.abs(v));
        const veins = 1 - smooth(0.0, 0.18, Math.abs(Math.sin((u - Math.abs(v) * 1.5) * 42)));
        const k = clamp(0.25 * rib + 0.15 * veins, 0, 1);
        alb = [mix(0.11, 0.3, k), mix(0.36, 0.6, k), mix(0.06, 0.16, k)];
        rough = 0.35; f0 = 0.04; wrap = 0.5; sss = 0.6;
        break;
      }
      default: {
        // dark stoneware plate with fine speckles
        const sp = smooth(0.86, 0.92, vnoise(px * 90, py * 90, pz * 90));
        const t = fbm(px * 4, py * 4, pz * 4, 3);
        const g = mix(0.045, 0.07, t);
        alb = [mix(g, 0.2, sp * 0.3), mix(g, 0.19, sp * 0.3), mix(g * 1.05, 0.17, sp * 0.3)];
        rough = 0.45; f0 = 0.03;
      }
    }
    // a light dusting of icing sugar over the stack and the plate (it melts away on the wet syrup)
    if (n[1] > 0.3) {
      const r2 = Math.hypot(px, pz);
      const wet = m.id === M_SYRUP || m.id === M_STREAM ? 0.1 : m.id === M_PLATE ? 0.55 : 1;
      const dens = smooth(2.0, 0.5, r2) * smooth(0.3, 0.75, n[1]) * wet;
      const gs = 0.6 * vnoise(px * 150, py * 150, pz * 150) + 0.4 * vnoise(px * 31 + 4, py * 31, pz * 31);
      const sug = smooth(0.6, 0.7, gs) * dens;
      if (sug > 0) { alb = [mix(alb[0], 0.94, sug), mix(alb[1], 0.93, sug), mix(alb[2], 0.9, sug)]; rough = mix(rough, 0.9, sug); }
    }
    occ = ambientOcc(px, py, pz, n[0], n[1], n[2]);
  }
  LAST_ALB = alb; LAST_N = n;
  const [nx, ny, nz] = n;
  let r = 0, g = 0, b = 0;
  const lights = [[KEY, KEYC, 9], [FILL, FILLC, 5], [RIM, RIMC, 7]];
  for (const [L, C, k] of lights) {
    const ndl = nx * L[0] + ny * L[1] + nz * L[2];
    const diff = Math.max(0, (ndl + wrap) / (1 + wrap));
    if (diff <= 0 && sss <= 0) continue;
    const sh = diff > 0 ? softShadow(px + nx * 0.004, py + ny * 0.004, pz + nz * 0.004, L[0], L[1], L[2], k) : 0;
    const sp = ndl > 0 ? ggx(nx, ny, nz, vx, vy, vz, L[0], L[1], L[2], Math.max(rough, 0.16), f0) * spec * ndl : 0;
    r += C[0] * sh * (alb[0] * diff * (1 - f0) + sp);
    g += C[1] * sh * (alb[1] * diff * (1 - f0) + sp);
    b += C[2] * sh * (alb[2] * diff * (1 - f0) + sp);
    // light scattering through thin, translucent food when lit from behind
    if (sss > 0) {
      const back = Math.max(0, -(vx * L[0] + vy * L[1] + vz * L[2]));
      const t = sss * 0.35 * back ** 3 * (0.4 + 0.6 * sh);
      r += C[0] * t * alb[0] * 1.2; g += C[1] * t * alb[1] * 0.8; b += C[2] * t * alb[2] * 0.6;
    }
  }
  // soft light from the room
  const amb = (0.55 + 0.45 * ny) * occ;
  r += alb[0] * amb * 0.045; g += alb[1] * amb * 0.038; b += alb[2] * amb * 0.033;
  // reflection of the studio
  const ndv = Math.max(0, nx * vx + ny * vy + nz * vz);
  const rd = 2 * ndv;
  const rx = rd * nx - vx, ry = rd * ny - vy, rz = rd * nz - vz;
  const F = f0 + (1 - f0) * (1 - ndv) ** 5;
  const e = env(rx, ry, rz);
  const gloss = (1 - rough) ** 2 * spec;
  r += e[0] * F * gloss * occ; g += e[1] * F * gloss * occ; b += e[2] * F * gloss * occ;
  return [r + emitR, g + emitG, b + emitB];
}

// background behind the table: dark, warm, with out-of-focus lights
const bokeh = [];
{
  const br = mulberry32(77);
  for (let i = 0; i < 16; i++) bokeh.push([(br() - 0.5) * 1.6, 0.1 + br() * 0.45, 0.025 + br() * 0.05, 0.25 + br() * 0.6, br()]);
}
function background(dx, dy, dz) {
  const u = Math.atan2(dx, -dz), v = dy;
  const glow = smooth(0.7, -0.1, v) * smooth(1.2, 0, Math.abs(u + 0.25));
  let r = 0.006 + 0.022 * glow, g = 0.0045 + 0.013 * glow, b = 0.0035 + 0.007 * glow;
  for (const [bu, bv, rad, inten, hue] of bokeh) {
    const d = Math.hypot(u - bu, v - bv);
    const disc = smooth(rad, rad * 0.86, d) * (0.7 + 0.3 * smooth(rad * 0.5, rad * 0.95, d));
    const k = disc * inten * 0.7;
    r += k * 1.0; g += k * mix(0.5, 0.72, hue); b += k * mix(0.18, 0.36, hue);
  }
  return [r, g, b];
}

// ---------------------------------------------------------------- camera and tracing
const CAM_T = [0, 0.76, 0.05];
const CAM_DIST = 5.7, CAM_EL = 0.34, CAM_AZ = 0.18;
const CAM_E = [CAM_T[0] + CAM_DIST * Math.cos(CAM_EL) * Math.sin(CAM_AZ), CAM_T[1] + CAM_DIST * Math.sin(CAM_EL), CAM_T[2] + CAM_DIST * Math.cos(CAM_EL) * Math.cos(CAM_AZ)];
const FOV = 0.5;
const FOCUS = len3(CAM_E[0] - 0.1, CAM_E[1] - 1.1, CAM_E[2] - 0.6);
const APERTURE = 0.055;

function traceScene(ox, oy, oz, dx, dy, dz) {
  // bounding box of everything but the table
  const bx0 = -1.9, bx1 = 1.9, by0 = -0.06, by1 = 4.5, bz0 = -1.9, bz1 = 1.9;
  let t0 = -1e9, t1 = 1e9;
  for (const [o, d, lo, hi] of [[ox, dx, bx0, bx1], [oy, dy, by0, by1], [oz, dz, bz0, bz1]]) {
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return -1; continue; }
    let a = (lo - o) / d, b = (hi - o) / d;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a; if (b < t1) t1 = b;
  }
  if (t1 < Math.max(t0, 0)) return -1;
  let t = Math.max(t0, 0);
  for (let i = 0; i < 300 && t < t1; i++) {
    const h = map(ox + dx * t, oy + dy * t, oz + dz * t);
    if (h < 0.0003 * t) {
      // settle onto the surface, so textures do not band with the step count
      for (let k = 0; k < 6; k++) {
        const e = map(ox + dx * t, oy + dy * t, oz + dz * t);
        t += e * 0.9;
        if (Math.abs(e) < 2e-6) break;
      }
      return t;
    }
    t += h * 0.8;
  }
  return -1;
}

let LAST_ALB = [0, 0, 0], LAST_N = [0, 1, 0], BR1 = 0.5, BR2 = 0.5;

// one bounce of diffuse light: warm light from the pancakes spills onto their neighbours and the plate
function bounce(px, py, pz, c) {
  const alb = LAST_ALB, n = LAST_N;
  // cosine-weighted direction around the normal
  const a = 2 * Math.PI * BR1, r = Math.sqrt(BR2);
  const tx = Math.abs(n[0]) < 0.9 ? 1 : 0, ty = tx ? 0 : 1;
  let ux = ty * n[2], uy = -tx * n[2], uz = tx * n[1] - ty * n[0];
  const ul = len3(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
  const vx = n[1] * uz - n[2] * uy, vy = n[2] * ux - n[0] * uz, vz = n[0] * uy - n[1] * ux;
  const k = Math.sqrt(Math.max(0, 1 - BR2));
  const dx = ux * r * Math.cos(a) + vx * r * Math.sin(a) + n[0] * k, dy = uy * r * Math.cos(a) + vy * r * Math.sin(a) + n[1] * k, dz = uz * r * Math.cos(a) + vz * r * Math.sin(a) + n[2] * k;
  const li = radiance(px + n[0] * 0.006, py + n[1] * 0.006, pz + n[2] * 0.006, dx, dy, dz, 1);
  return [c[0] + alb[0] * li[0] * 0.8, c[1] + alb[1] * li[1] * 0.8, c[2] + alb[2] * li[2] * 0.8];
}

function radiance(ox, oy, oz, dx, dy, dz, depth = 0) {
  const ts = traceScene(ox, oy, oz, dx, dy, dz);
  const tt = dy < 0 ? (TABLE_Y - oy) / dy : -1;
  if (ts > 0 && (tt < 0 || ts < tt)) {
    const px = ox + dx * ts, py = oy + dy * ts, pz = oz + dz * ts;
    const c = shade(px, py, pz, dx, dy, dz, false);
    return depth === 0 ? bounce(px, py, pz, c) : c;
  }
  if (depth > 0) return tt > 0 ? [0.01, 0.006, 0.004] : background(dx, dy, dz);
  if (tt > 0) {
    const px = ox + dx * tt, pz = oz + dz * tt;
    const c = shade(px, TABLE_Y, pz, dx, dy, dz, true);
    // the far table falls off into darkness
    const fall = Math.exp(-Math.max(0, Math.hypot(px * 0.8, pz) - 1.9) * 1.1);
    const bg = background(dx, dy, dz);
    return [mix(bg[0], c[0], fall), mix(bg[1], c[1], fall), mix(bg[2], c[2], fall)];
  }
  return background(dx, dy, dz);
}

function renderRows(rows) {
  // camera basis
  let fx = CAM_T[0] - CAM_E[0], fy = CAM_T[1] - CAM_E[1], fz = CAM_T[2] - CAM_E[2];
  const fl = len3(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
  let rx = fz, ry = 0, rz = -fx; const rl = len3(rx, ry, rz); rx /= rl; rz /= rl;
  rx = -rx; rz = -rz;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const tanH = Math.tan(FOV / 2);
  const out = new Float32Array(rows.length * W * 3);
  const sq = Math.max(1, Math.round(Math.sqrt(SPP)));
  for (let ri = 0; ri < rows.length; ri++) {
    const py = rows[ri];
    for (let px = 0; px < W; px++) {
      let R = 0, G = 0, B = 0;
      for (let s = 0; s < SPP; s++) {
        const j1 = hash3(px, py, s * 3 + 1), j2 = hash3(px, py, s * 3 + 2), j3 = hash3(px, py, s * 3 + 3), j4 = hash3(py, px, s * 7 + 5);
        JIT = hash3(px + 7919, py, s * 5 + 11);
        BR1 = hash3(px, py + 4099, s * 5 + 13); BR2 = hash3(px + 151, py + 7, s * 5 + 17);
        const sx = ((s % sq) + j1) / sq, sy = ((Math.floor(s / sq) % sq) + j2) / sq;
        const u = ((px + sx) / W * 2 - 1) * tanH, v = (1 - (py + sy) / H * 2) * tanH;
        let dx = fx + rx * u + ux * v, dy = fy + ry * u + uy * v, dz = fz + rz * u + uz * v;
        const dl = len3(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
        // thin lens
        const fpx = CAM_E[0] + dx * FOCUS / (dx * fx + dy * fy + dz * fz), fpy = CAM_E[1] + dy * FOCUS / (dx * fx + dy * fy + dz * fz), fpz = CAM_E[2] + dz * FOCUS / (dx * fx + dy * fy + dz * fz);
        const lr = APERTURE * Math.sqrt(j3), la = j4 * 2 * Math.PI;
        const ox = CAM_E[0] + (rx * Math.cos(la) + ux * Math.sin(la)) * lr, oy = CAM_E[1] + (ry * Math.cos(la) + uy * Math.sin(la)) * lr, oz = CAM_E[2] + (rz * Math.cos(la) + uz * Math.sin(la)) * lr;
        let ex = fpx - ox, ey = fpy - oy, ez = fpz - oz; const el = len3(ex, ey, ez); ex /= el; ey /= el; ez /= el;
        const c = radiance(ox, oy, oz, ex, ey, ez);
        R += c[0]; G += c[1]; B += c[2];
      }
      const o = (ri * W + px) * 3;
      out[o] = R / SPP; out[o + 1] = G / SPP; out[o + 2] = B / SPP;
    }
  }
  return out;
}

// ---------------------------------------------------------------- post and PNG
function postProcess(hdr) {
  // bloom: blur the bright part and add a little of it back
  const bright = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) bright[i] = Math.max(0, hdr[i] - 1.3);
  const rad = Math.round(W / 40);
  const tmp = new Float32Array(W * H * 3);
  const blur = (src, dst, horiz) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let k = -rad; k <= rad; k++) {
        const xx = horiz ? clamp(x + k, 0, W - 1) : x, yy = horiz ? y : clamp(y + k, 0, H - 1);
        const w = Math.exp(-(k * k) / (rad * rad * 0.5));
        const o = (yy * W + xx) * 3; r += src[o] * w; g += src[o + 1] * w; b += src[o + 2] * w; n += w;
      }
      const o = (y * W + x) * 3; dst[o] = r / n; dst[o + 1] = g / n; dst[o + 2] = b / n;
    }
  };
  blur(bright, tmp, true); blur(tmp, bright, false);
  const px = new Uint8Array(W * H * 3);
  const aces = (x) => clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1);
  const srgb = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    const ddx = (x + 0.5) / W - 0.5, ddy = (y + 0.5) / H - 0.48;
    const vig = 1 - 0.55 * Math.min(1, (ddx * ddx + ddy * ddy) * 2.2) ** 1.5;
    const ex = 1.2;
    // fine film grain, the same in every channel, strongest in the mid-tones
    const grain = (hash3(x, y, 99) + hash3(x, y, 101) - 1) * GRAIN;
    for (let c = 0; c < 3; c++) {
      let v = (hdr[o + c] + bright[o + c] * 0.35) * vig * ex;
      v = srgb(aces(v));
      v += grain * (0.35 + v * (1 - v) * 2.6);
      px[o + c] = clamp(Math.round(v * 255), 0, 255);
    }
  }
  return px;
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(px) {
  // per-row adaptive filter (the one with the smallest sum of absolute values)
  const stride = W * 3, raw = Buffer.alloc((stride + 1) * H);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < H; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f]; let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0, b = up ? up[i] : 0, cc = up && i >= 3 ? up[i - 3] : 0;
        let p;
        if (f === 0) p = 0; else if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
        else { const q = a + b - cc, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - cc); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
        const v = (row[i] - p) & 255; c[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best; cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- driver
if (isMainThread) {
  const n = Math.min(availableParallelism(), Number(process.env.THREADS || 64));
  const t0 = Date.now();
  const hdr = new Float32Array(W * H * 3);
  let done = 0;
  await Promise.all(Array.from({ length: n }, (_, k) => new Promise((resolve, reject) => {
    const rows = []; for (let y = k; y < H; y += n) rows.push(y);
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { rows }, env: process.env });
    w.on('message', (buf) => {
      for (let i = 0; i < rows.length; i++) hdr.set(buf.subarray(i * W * 3, (i + 1) * W * 3), rows[i] * W * 3);
      done++; resolve();
    });
    w.on('error', reject);
  })));
  const png = encodePNG(postProcess(hdr));
  const out = process.env.OUT || fileURLToPath(new URL('../entry.png', import.meta.url));
  if (process.env.JPEG === '0') writeFileSync(out, png);
  else {
    // film grain does not compress as PNG under the 1 MiB cap: store the picture as a high-quality JPEG
    // (4:4:4, no chroma subsampling). The gate tells PNG from JPEG by the first bytes; the name stays entry.png.
    const tmp = `${out}.tmp.png`;
    writeFileSync(tmp, png);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', tmp, '-c:v', 'mjpeg', '-q:v', process.env.JPEGQ || '2', '-pix_fmt', 'yuvj444p', '-f', 'image2', out]);
    unlinkSync(tmp);
  }
  console.log(`${out}: ${W}x${H}, ${SPP} spp, ${statSync(out).size} bytes, ${((Date.now() - t0) / 1000).toFixed(1)} s on ${n} threads`);
} else {
  parentPort.postMessage(renderRows(workerData.rows));
}
