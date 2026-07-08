// Track generator: closed-curve families + feature wavelets (hairpins, esses,
// detours), validated on the REAL pipeline (trackgeom + physics + AI), ranked
// by a fun score. Prints the best defs per family as JS for src/tracks.js.
import { buildTrackGeometry, mulberry32 } from '../src/trackgeom.js';
import { stepCar, makeCarState } from '../src/physics.js';
import { AiDriver } from '../src/ai.js';
import { writeFileSync, mkdirSync } from 'node:fs';

const TAU = Math.PI * 2;

// closed uniform Catmull-Rom through anchors, densely sampled
function catmullLoop(anchors, N) {
  const K = anchors.length, pts = [];
  const c1 = (p0, p1, p2, p3, t) => {
    const v0 = (p2 - p0) * 0.5, v1 = (p3 - p1) * 0.5;
    const t2 = t * t, t3 = t2 * t;
    return (2 * p1 - 2 * p2 + v0 + v1) * t3 + (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 + v0 * t + p1;
  };
  for (let i = 0; i < N; i++) {
    const u = (i / N) * K;
    const s = Math.floor(u), f = u - s;
    const a = anchors[(s - 1 + K) % K], b = anchors[s % K], c = anchors[(s + 1) % K], d = anchors[(s + 2) % K];
    pts.push({ x: c1(a.x, b.x, c.x, d.x, f), z: c1(a.z, b.z, c.z, d.z, f) });
  }
  return pts;
}

// ---------- base curve families (dense θ → xz) ----------
function baseCurve(family, rng) {
  if (family === 'gp') {
    // anchor ring with violent radius jumps: deep inward fingers become
    // hairpins, outer bulges become sweepers — no oval monotony
    const K = 13 + Math.floor(rng() * 6);
    const anchors = [];
    let prevDeep = false;
    for (let i = 0; i < K; i++) {
      const a = (i + (rng() - 0.5) * 0.55) * TAU / K;
      const deep = !prevDeep && rng() < 0.38;
      prevDeep = deep;
      const r = deep ? 0.34 + rng() * 0.22 : 0.72 + rng() * 0.42;
      anchors.push({ x: Math.sin(a) * r, z: Math.cos(a) * r * (0.8 + rng() * 0.35) });
    }
    const loop = catmullLoop(anchors, 4096);
    return (t) => loop[Math.floor((t / TAU) * 4096) % 4096];
  }
  if (family === 'knot') {
    // trefoil backbone + third harmonic for asymmetric lobes, PLUS global
    // high-frequency wobble so the crossing diagonals snake instead of
    // running straight — every meter should be turning somewhere
    const A = 300, k2 = 1.6 + rng() * 0.9, k3 = 0.25 + rng() * 0.45;
    const w5 = 0.09 + rng() * 0.1, w7 = 0.05 + rng() * 0.07;
    const ph = rng() * TAU, ph3 = rng() * TAU, p5 = rng() * TAU, p7 = rng() * TAU;
    const sq = 0.8 + rng() * 0.35;
    return (t) => ({
      x: A * (Math.sin(t) + k2 * Math.sin(2 * t + ph) + k3 * Math.sin(3 * t + ph3)
        + w5 * Math.sin(5 * t + p5) + w7 * Math.sin(7 * t + p7)),
      z: A * (Math.cos(t) - k2 * Math.cos(2 * t + ph) + k3 * Math.cos(3 * t + ph3)
        + w5 * Math.cos(5 * t + p5) + w7 * Math.cos(7 * t + p7)) * sq,
    });
  }
  // trefoil
  const A = 300 + rng() * 60, k2 = 1.7 + rng() * 0.7, ph = rng() * TAU;
  const sq = 0.85 + rng() * 0.25;
  return (t) => ({
    x: A * (Math.sin(t) + k2 * Math.sin(2 * t + ph)),
    z: A * (Math.cos(t) - k2 * Math.cos(2 * t + ph)) * sq,
  });
}

// ---------- lateral feature wavelets ----------
function makeFeatures(rng, count, ampLo = 35, ampHi = 110) {
  const feats = [];
  for (let j = 0; j < count; j++) {
    feats.push({
      c: rng(),                        // center along the loop (0..1)
      s: 0.025 + rng() * 0.05,         // half-width in loop fraction
      A: ampLo + rng() * (ampHi - ampLo), // amplitude in world units
      m: [1, 2, 2, 3, 3, 4][Math.floor(rng() * 6)], // bias to 2-3: linked esses
      ph: rng() < 0.5 ? 0 : Math.PI,
    });
  }
  return feats;
}
function featureOffset(u, feats) {
  let off = 0;
  for (const f of feats) {
    let du = u - f.c;
    if (du > 0.5) du -= 1; if (du < -0.5) du += 1;
    const x = du / f.s;
    if (Math.abs(x) > 2.2) continue;
    off += f.A * Math.exp(-x * x * 1.6) * Math.sin(Math.PI * f.m * x * 0.5 + f.ph);
  }
  return off;
}

// ---------- dense polyline → arc-length resampled control points ----------
function densePoints(family, rng, feats, targetLen, wobble) {
  const N = 4096, pts = [];
  const base = baseCurve(family, rng);
  for (let i = 0; i < N; i++) pts.push({ ...base((i / N) * TAU) }); // copy — base may return shared objects
  // scale the base loop to the target length BEFORE features, so feature
  // amplitudes stay in absolute world units
  let len = 0;
  for (let i = 0; i < N; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    len += Math.hypot(b.x - a.x, b.z - a.z);
  }
  const sc = targetLen / len;
  for (const p of pts) { p.x *= sc; p.z *= sc; }
  // normals from finite differences, then lateral offset: localized features
  // PLUS a global wobble so no stretch of the loop is ever truly straight —
  // integer cycle count keeps the loop closed; ~420u wavelength puts the
  // wobble radius right in the drift sweet spot.
  const [wLo, wHi] = wobble ?? [0, 0];
  const wAmp = wLo + rng() * (wHi - wLo);
  const wCycles = Math.max(4, Math.round(targetLen / 420));
  const wPhase = rng() * TAU;
  const out = [];
  for (let i = 0; i < N; i++) {
    const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
    let dx = b.x - a.x, dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const u = i / N;
    const off = featureOffset(u, feats) + wAmp * Math.sin(u * TAU * wCycles + wPhase);
    out.push({ x: pts[i].x + (dz / l) * off, z: pts[i].z - (dx / l) * off });
  }
  return out;
}
function resample(pts, spacing) {
  const n = pts.length, out = [];
  let total = 0;
  const lens = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    lens.push(Math.hypot(b.x - a.x, b.z - a.z));
    total += lens[i];
  }
  const count = Math.max(24, Math.round(total / spacing));
  const step = total / count;
  let acc = 0, target = 0, k = 0;
  for (let i = 0; i < n && k < count; i++) {
    while (acc + lens[i] >= target && k < count) {
      const f = (target - acc) / (lens[i] || 1e-9);
      const a = pts[i], b = pts[(i + 1) % n];
      out.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f });
      k++;
      target = k * step;
    }
    acc += lens[i];
  }
  return out;
}

// circumradius over a window of resampled ctrl points
function ctrlRadius(pts, i, w = 2) {
  const n = pts.length;
  const a = pts[(i - w + n) % n], b = pts[i], c = pts[(i + w) % n];
  const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ca = Math.hypot(a.x - c.x, a.z - c.z);
  const area = Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2;
  if (area < 1e-6) return 1e9;
  return (ab * bc * ca) / (4 * area);
}

// Drift-first widths measured on the REAL spline (ctrl-point circumradius
// misses spline overshoot between points): corners get the full 48u drift
// zone, genuinely tight spots step down, straights pinch for contrast.
function assignWidths(pts, rng) {
  const def0 = { points: pts.map((p) => [Math.round(p.x), Math.round(p.z), 0, 48]), ramps: [] };
  const g0 = buildTrackGeometry(def0, 7);
  const S = g0.sampleCount;
  const rad = [];
  for (let i = 0; i < S; i++) rad.push(sampleRadius(g0, i));
  const win = Math.ceil(70 / g0.segLen);
  return pts.map((p) => {
    const idx = g0.probe(p.x, p.z).index;
    let r = 1e9;
    for (let j = -win; j <= win; j++) r = Math.min(r, rad[(idx + j + S) % S]);
    const w = r < 62 ? 38 : r < 240 ? 48 : rng() < 0.35 ? 34 : 38;
    return [Math.round(p.x), Math.round(p.z), 0, w];
  });
}

// ---------- elevation: rolling hills + overpasses ----------
// Harmonic height field along the loop: crests, valleys, blind corners.
// Grade-capped so cars flow instead of stutter-launching.
function assignHeights(points, rng, spacing) {
  const n = points.length;
  const totalAmp = 7 + rng() * 7;
  const harmonics = [];
  let left = totalAmp;
  for (const k of [2 + Math.floor(rng() * 2), 4 + Math.floor(rng() * 2), 6 + Math.floor(rng() * 2)]) {
    const a = left * (0.35 + rng() * 0.35);
    left -= a;
    harmonics.push({ k, a, p: rng() * TAU });
  }
  const H = [];
  for (let i = 0; i < n; i++) {
    let h = 0;
    for (const { k, a, p } of harmonics) h += a * Math.sin(TAU * k * (i / n) + p);
    H.push(h);
  }
  // Lipschitz grade cap (both directions around the loop), then floor at 0
  const maxStep = spacing * 0.085;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i <= n * 2; i++) { const a = i % n, b = (i - 1) % n; H[a] = Math.min(H[a], H[b] + maxStep); }
    for (let i = n * 2; i >= 1; i--) { const a = (i - 1) % n, b = i % n; H[a] = Math.min(H[a], H[b] + maxStep); }
  }
  const min = Math.min(...H);
  for (let i = 0; i < n; i++) points[i][2] = +(H[i] - min).toFixed(1);
}

// Lift one branch of ~half the at-grade crossings into a real overpass
// (Δy ≥ 4 keeps the walls and skips the clearance check — a bridge).
// Returns the number of bridges made.
function raiseOverpasses(def, rng) {
  const g = buildTrackGeometry(def, 7);
  const S = g.sampleCount, n = def.points.length;
  const clusters = [];
  for (let i = 0; i < S; i++) {
    if (!g.crossing[i] || g.crossing[(i - 1 + S) % S]) continue;
    let end = i;
    while (g.crossing[(end + 1) % S]) end = (end + 1) % S;
    clusters.push({ start: i, end, mid: Math.round((i + (end >= i ? end : end + S)) / 2) % S });
  }
  // Sample → ctrl index via arc-length position, NOT xz proximity: at a
  // crossing both branches share the same xz, which would map both clusters
  // to the same ctrl point.
  const ctrlOf = (si) => Math.round(si / S * n) % n;
  const paired = new Set();
  let bridges = 0;
  for (let a = 0; a < clusters.length; a++) {
    if (paired.has(a)) continue;
    // partner cluster = the one whose mid sample sits on top of ours in xz
    const pa = g.points[clusters[a].mid];
    let b = -1, bd = Infinity;
    for (let k = 0; k < clusters.length; k++) {
      if (k === a || paired.has(k)) continue;
      const pb = g.points[clusters[k].mid];
      const d = (pa.x - pb.x) ** 2 + (pa.z - pb.z) ** 2;
      if (d < bd) { bd = d; b = k; }
    }
    if (b < 0 || bd > 120 ** 2) continue;
    paired.add(a); paired.add(b);
    if (rng() < 0.45) continue; // leave this one an at-grade intersection
    const ca = ctrlOf(clusters[a].mid), cb = ctrlOf(clusters[b].mid);
    const idxDist = Math.min(Math.abs(ca - cb), n - Math.abs(ca - cb));
    if (idxDist < 5) continue; // too tangled to lift cleanly
    // lift the branch that's already higher
    const c = def.points[ca][2] >= def.points[cb][2] ? ca : cb;
    const lift = 9.5 - Math.abs(def.points[ca][2] - def.points[cb][2]);
    const weights = [0.3, 0.75, 1, 0.75, 0.3];
    for (let o = -2; o <= 2; o++) {
      const idx = (c + o + n) % n;
      def.points[idx][2] = +(def.points[idx][2] + Math.max(0, lift) * weights[o + 2]).toFixed(1);
    }
    bridges++;
  }
  return bridges;
}

// ---------- validation on the real geometry ----------
function validate(g) {
  const S = g.sampleCount;
  let minMargin = Infinity;
  for (let i = 0; i < S; i++) {
    const t1 = g.tangents[i], t2 = g.tangents[(i + 1) % S];
    const a1 = Math.atan2(t1.x, t1.z), a2 = Math.atan2(t2.x, t2.z);
    let da = Math.abs(a2 - a1); if (da > Math.PI) da = 2 * Math.PI - da;
    if (da < 1e-7) continue;
    const r = g.segLen * Math.hypot(t1.x, t1.z) / da;
    minMargin = Math.min(minMargin, r - g.halfWidthAt(i));
  }
  const guard = Math.ceil((g.maxWidth * 1.6) / g.segLen);
  let minClear = Infinity;
  for (let i = 0; i < S; i += 2) {
    if (g.crossing[i]) continue;
    for (let j = i + guard; j < S; j += 2) {
      if (g.crossing[j]) continue;
      const w = Math.min(j - i, S - (j - i));
      if (w < guard) continue;
      const a = g.points[i], b = g.points[j];
      if (Math.abs(a.y - b.y) >= 4) continue;
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      minClear = Math.min(minClear, d - (g.widths[i] + g.widths[j]) / 2);
    }
  }
  const nCross = g.crossing.reduce((acc, c, i) => acc + (c && !g.crossing[(i - 1 + S) % S] ? 1 : 0), 0);
  return { minMargin, minClear, nCross };
}

// windowed centerline radius on final geometry (for ramps + scoring)
function sampleRadius(g, i) {
  const S = g.sampleCount;
  const t1 = g.tangents[(i - 1 + S) % S], t2 = g.tangents[(i + 1) % S];
  let da = Math.abs(Math.atan2(t2.x, t2.z) - Math.atan2(t1.x, t1.z));
  if (da > Math.PI) da = 2 * Math.PI - da;
  return da < 1e-7 ? 1e9 : (2 * g.segLen) / da;
}

function placeRamps(g, rng, wantLane, wantFull) {
  const S = g.sampleCount;
  const rad = [];
  for (let i = 0; i < S; i++) rad.push(sampleRadius(g, i));
  // ramps may sit on soft sweepers — a fully straight run no longer exists
  const straightAt = (i, span) => {
    for (let j = -span; j <= span * 2; j++) if (rad[(i + j + S) % S] < 150) return false;
    return true;
  };
  const ramps = [], used = [];
  const farFromUsed = (i) => used.every((u) => {
    const d = Math.min(Math.abs(u - i), S - Math.abs(u - i));
    return d > S / 12;
  });
  // full-width launch ramps just before crossing zones
  let placedFull = 0;
  for (let i = 0; i < S && placedFull < wantFull; i++) {
    if (!(g.crossing[i] && !g.crossing[(i - 1 + S) % S])) continue;
    const at = (i - Math.ceil(55 / g.segLen) + S) % S;
    if (g.crossing[at] || !farFromUsed(at)) continue;
    if (!straightAt(at, Math.ceil(40 / g.segLen))) continue;
    const p = g.points[at];
    ramps.push({ near: [Math.round(p.x), Math.round(p.z)], len: 30, h: 6, w: 'full' });
    used.push(at); placedFull++;
  }
  // lane ramps on straights
  let placedLane = 0;
  const start = Math.floor(rng() * S);
  for (let k = 0; k < S && placedLane < wantLane; k += 7) {
    const i = (start + k) % S;
    if (g.crossing[i] || !farFromUsed(i)) continue;
    if (!straightAt(i, Math.ceil(60 / g.segLen))) continue;
    const p = g.points[i];
    ramps.push({ near: [Math.round(p.x), Math.round(p.z)], len: 34, h: 6.5 });
    used.push(i); placedLane++;
  }
  return ramps;
}

// ---------- AI screening (1 fast lap with real physics) ----------
function simLap(g) {
  const S = g.sampleCount;
  const t0 = g.tangents[0];
  const car = makeCarState(g.points[0].x, g.points[0].z, Math.atan2(t0.x, t0.z));
  car.y = g.heights[0];
  const driver = new AiDriver(1);
  const dt = 1 / 60;
  let time = 0, wallHits = 0, drifting = 0;
  while (car.progress < S && time < 400) {
    stepCar(car, driver.control(car, g, dt), dt, g);
    time += dt;
    if (car.wallHit > 3) wallHits++;
    if (car.drifting) drifting += dt;
  }
  return { done: car.progress >= S, lap: time, wallHits, driftFrac: drifting / time };
}

// ---------- fun score: DRIFT-first ----------
// Currency: long held sweepers (arc angle at drift radius), linked
// left/right transitions (pendulum flicks), a few wide horseshoes.
// Straights are dead time and get punished.
function funScore(g, sim, bridges = 0) {
  const S = g.sampleCount;
  // verticality: total climb per km (hills, crests, bridge approaches)
  let climb = 0;
  for (let i = 0; i < S; i++) climb += Math.max(0, g.heights[(i + 1) % S] - g.heights[i]);
  const climbPerKm = climb / (g.length / 1000);
  const rads = [], dAs = [];
  for (let i = 0; i < S; i++) {
    rads.push(sampleRadius(g, i));
    const t1 = g.tangents[(i - 1 + S) % S], t2 = g.tangents[(i + 1) % S];
    let da = Math.atan2(t2.x, t2.z) - Math.atan2(t1.x, t1.z);
    if (da > Math.PI) da -= TAU; if (da < -Math.PI) da += TAU;
    dAs.push(da / 2);
  }
  // corner events: contiguous runs with radius < 260, accumulating arc angle
  const events = [];
  let ev = null, gap = 0, totalTurn = 0;
  for (let i = 0; i < S; i++) {
    totalTurn += Math.abs(dAs[i]);
    if (rads[i] < 260) {
      if (!ev) { ev = { arc: 0, minR: 1e9, sign: 0, gapBefore: gap * g.segLen }; gap = 0; }
      ev.arc += Math.abs(dAs[i]);
      ev.minR = Math.min(ev.minR, rads[i]);
      ev.sign = Math.sign(dAs[i]) || ev.sign;
    } else {
      if (ev) { events.push(ev); ev = null; }
      gap++;
    }
  }
  if (ev) events.push(ev);
  // epic sweepers: >55° held at drift radius, weight by arc angle
  let sweep = 0, hairpins = 0, links = 0;
  for (let k = 0; k < events.length; k++) {
    const e = events[k];
    if (e.arc > 0.95 && e.minR > 60 && e.minR < 260) sweep += e.arc;
    if (e.arc > 2.2 && e.minR < 100) hairpins++;
    const prev = events[(k - 1 + events.length) % events.length];
    if (e.sign !== 0 && prev.sign !== 0 && e.sign !== prev.sign && e.gapBefore < 90 &&
        e.arc > 0.5 && prev.arc > 0.5) links++;
  }
  // straights are dead time — and gentle near-straights (r>300) count too
  let cur = 0, maxStraight = 0, straightPen = 0;
  for (let i = 0; i < 2 * S; i++) {
    if (rads[i % S] > 300) { cur += g.segLen; if (i < S) maxStraight = Math.max(maxStraight, cur); }
    else { if (cur > 180 && i < S) straightPen += cur - 180; cur = 0; }
  }
  const perLap = 1;
  return {
    sweep: +sweep.toFixed(1), hairpins, links, corners: events.length,
    turnPerKm: +(totalTurn / (g.length / 1000)).toFixed(1), maxStraight: Math.round(maxStraight),
    climbPerKm: +climbPerKm.toFixed(1), bridges,
    score:
      sweep * 9 * perLap +                 // held drift arcs — the main currency
      Math.min(hairpins, 5) * 14 +         // a few wide horseshoes
      links * 11 +                         // pendulum transitions
      (totalTurn / (g.length / 1000)) * 5 + // overall curviness per km
      Math.min(climbPerKm, 14) * 2.5 +     // hills: crests, valleys, blind corners
      bridges * 10 +                       // real overpasses
      sim.driftFrac * 130 -                // the AI actually drifting most of the lap
      straightPen * 0.06 -                 // dead time
      Math.max(0, sim.wallHits * (1000 / g.length) - 18) * 0.8,
  };
}

// ---------- search ----------
const FAMILIES = {
  gp:      { spacing: 150, feats: 6, amp: [35, 90], wobble: [16, 28], lenRange: [7500, 10500], lane: 3, full: 1, lapMax: 210, maxStraight: 420, minDrift: 0.45 },
  knot:    { spacing: 155, feats: 7, amp: [60, 160], wobble: [16, 26], lenRange: [9500, 12500], lane: 4, full: 2, lapMax: 280, maxStraight: 600, minDrift: 0.42 },
  trefoil: { spacing: 145, feats: 6, amp: [50, 140], wobble: [15, 26], lenRange: [6000, 8500], lane: 3, full: 2, lapMax: 180, maxStraight: 480, minDrift: 0.45 },
};

const family = process.argv[2] ?? 'gp';
const tries = +(process.argv[3] ?? 60);
const cfg = FAMILIES[family];
const results = [];

for (let seed = 1; seed <= tries; seed++) {
  const rng = mulberry32(seed * 7919 + family.length);
  const feats = makeFeatures(rng, cfg.feats, cfg.amp[0], cfg.amp[1]);
  const targetLen = cfg.lenRange[0] + rng() * (cfg.lenRange[1] - cfg.lenRange[0]) * 0.8;
  let def, bridges = 0;
  try {
    const ctrl = resample(densePoints(family, rng, feats, targetLen, cfg.wobble), cfg.spacing);
    def = { points: assignWidths(ctrl, rng), ramps: [] };
    assignHeights(def.points, rng, cfg.spacing);
    bridges = raiseOverpasses(def, rng);
  } catch { continue; }
  const reject = (why) => { console.log(`seed ${seed}: REJECT ${why}`); };
  let g;
  try { g = buildTrackGeometry(def, 7); } catch (e) { reject('geom: ' + e.message); continue; }
  if (g.length < cfg.lenRange[0] || g.length > cfg.lenRange[1]) { reject(`len=${g.length.toFixed(0)}`); continue; }
  const v = validate(g);
  if (v.minMargin < 3 || v.minClear < 4.5) { reject(`margin=${v.minMargin.toFixed(1)} clear=${v.minClear === Infinity ? '∞' : v.minClear.toFixed(1)}`); continue; }
  if (family === 'gp' && v.nCross > 4) { reject(`cross=${v.nCross}`); continue; }
  def.ramps = placeRamps(g, rng, cfg.lane, cfg.full);
  g = buildTrackGeometry(def, 7); // rebuild with ramps for the sim
  const sim = simLap(g);
  if (!sim.done || sim.lap > cfg.lapMax) { reject(`sim done=${sim.done} lap=${sim.lap.toFixed(0)}`); continue; }
  const f = funScore(g, sim, bridges);
  if (f.maxStraight > cfg.maxStraight) { reject(`maxStraight=${f.maxStraight}`); continue; }
  if (sim.driftFrac < cfg.minDrift) { reject(`driftFrac=${(sim.driftFrac * 100).toFixed(0)}%`); continue; }
  results.push({ seed, def, g, v, sim, f });
  console.log(`seed ${seed}: len=${g.length.toFixed(0)} margin=${v.minMargin.toFixed(1)} clear=${v.minClear === Infinity ? '∞' : v.minClear.toFixed(1)} cross=${v.nCross} lap=${sim.lap.toFixed(0)}s wall=${sim.wallHits} drift=${(sim.driftFrac * 100).toFixed(0)}% sweep=${f.sweep} hp=${f.hairpins} links=${f.links} turn/km=${f.turnPerKm} straight=${f.maxStraight} climb/km=${f.climbPerKm} bridges=${f.bridges} SCORE=${f.score.toFixed(1)}`);
}

results.sort((a, b) => b.f.score - a.f.score);
console.log(`\n${results.length}/${tries} candidates passed. Top 3: ${results.slice(0, 3).map((r) => `seed ${r.seed} (${r.f.score.toFixed(1)})`).join(', ')}`);

// dump top 3 defs + SVG previews
mkdirSync('track-gen-out', { recursive: true });
for (const r of results.slice(0, 3)) {
  const pts = r.def.points;
  const xs = pts.map((p) => p[0]), zs = pts.map((p) => p[1]);
  const pad = 60, minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad, minZ = Math.min(...zs) - pad, maxZ = Math.max(...zs) + pad;
  const sc = 900 / Math.max(maxX - minX, maxZ - minZ);
  const px = (x) => ((x - minX) * sc).toFixed(1), pz = (z) => ((z - minZ) * sc).toFixed(1);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${(maxX - minX) * sc}" height="${(maxZ - minZ) * sc}" style="background:#05060a">`;
  // road as per-sample strip
  const S = r.g.sampleCount;
  const maxH = Math.max(...r.g.heights, 1);
  for (let i = 0; i < S; i += 4) {
    const p = r.g.points[i];
    const hf = r.g.heights[i] / maxH; // brighter = higher (bridges, crests)
    const fill = r.g.crossing[i] ? '#1d3a4a'
      : `rgb(${Math.round(22 + hf * 60)},${Math.round(28 + hf * 75)},${Math.round(44 + hf * 100)})`;
    svg += `<circle cx="${px(p.x)}" cy="${pz(p.z)}" r="${(r.g.widths[i] / 2 * sc).toFixed(1)}" fill="${fill}"/>`;
  }
  for (let i = 0; i < S; i += 8) {
    const p = r.g.points[i];
    svg += `<circle cx="${px(p.x)}" cy="${pz(p.z)}" r="1.5" fill="#22e6ff"/>`;
  }
  for (const rp of r.def.ramps) {
    svg += `<circle cx="${px(rp.near[0])}" cy="${pz(rp.near[1])}" r="6" fill="${rp.w === 'full' ? '#ff2d9a' : '#b6ff3d'}"/>`;
  }
  const p0 = r.g.points[0];
  svg += `<circle cx="${px(p0.x)}" cy="${pz(p0.z)}" r="8" fill="none" stroke="#fff" stroke-width="2"/>`;
  svg += '</svg>';
  const base = `track-gen-out/${family}-seed${r.seed}`;
  writeFileSync(`${base}.svg`, svg);
  writeFileSync(`${base}.json`, JSON.stringify(r.def));
}
console.log('SVG + JSON dumped for top 3.');
