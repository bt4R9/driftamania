// Track geometry & queries — DOM-free (usable from Node sims and the browser).
// Owns: spline sampling, per-point widths, elevation, free-standing ramp
// objects, the windowed probe, and the crossing mask.
import * as THREE from 'three';

export const SAMPLES = 2048;
const PROBE_WINDOW = 48;
export const DEFAULT_WIDTH = 36;

// Deterministic RNG — ramp lanes must match across all peers, so they're
// derived from a seed the host shares at race start.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function catmull1(p0, p1, p2, p3, t) {
  const v0 = (p2 - p0) * 0.5, v1 = (p3 - p1) * 0.5;
  const t2 = t * t, t3 = t2 * t;
  return (2 * p1 - 2 * p2 + v0 + v1) * t3 + (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 + v0 * t + p1;
}

// def.points: [x, z, height?, width?]; def.ramps: [{ near:[x,z], len, h,
//   w?: 'full' | number (default: a third of the local road), dir?: degrees,
//   lane?: false to pin to center }]
export function buildTrackGeometry(def, seed = 1) {
  const rng = mulberry32(seed);
  const n = def.points.length;
  const ctrl = def.points.map(([x, z, y = 0, w]) => ({ x, z, y, w: w ?? def.width ?? DEFAULT_WIDTH }));
  const curve = new THREE.CatmullRomCurve3(
    ctrl.map((p) => new THREE.Vector3(p.x, p.y, p.z)), true, 'catmullrom', 0.5,
  );

  const points = [], tangents = [], widths = [], heights = [];
  for (let i = 0; i < SAMPLES; i++) {
    const u = i / SAMPLES;
    const p = curve.getPointAt(u);
    p.y = Math.max(p.y, 0); // spline undershoot would dip below the ground plane
    points.push(p);
    tangents.push(curve.getTangentAt(u).normalize());
    heights.push(p.y);
    // Width rides the same spline parameterization as the shape.
    const t = curve.getUtoTmapping(u, 0) * n;
    const i0 = Math.floor(t) % n, f = t - Math.floor(t);
    widths.push(catmull1(
      ctrl[(i0 - 1 + n) % n].w, ctrl[i0].w, ctrl[(i0 + 1) % n].w, ctrl[(i0 + 2) % n].w, f,
    ));
  }
  const length = curve.getLength();
  const segLen = length / SAMPLES;

  const wrap = (i) => ((i % SAMPLES) + SAMPLES) % SAMPLES;
  const normalAt = (j) => {
    const t = tangents[wrap(j)];
    const txz = Math.hypot(t.x, t.z) || 1;
    return { nx: t.z / txz, nz: -t.x / txz };
  };
  // Signed curvature per sample (rad/unit; + = turning left). Used to clamp
  // lateral offsets: pushing an edge inward past the local radius makes the
  // offset curve fold over itself (bowtie artifacts on sharp inner corners).
  const curvatures = [];
  {
    const wrapA = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
    for (let i = 0; i < SAMPLES; i++) {
      const t1 = tangents[wrap(i - 1)], t2 = tangents[wrap(i + 1)];
      const dA = wrapA(Math.atan2(t2.x, t2.z) - Math.atan2(t1.x, t1.z)) / 2;
      curvatures.push(dA / segLen);
    }
  }
  // Offset limits per side: an offset at distance d folds if curvature within
  // ±d ALONG the track is tighter than d — so take the windowed minimum. This
  // makes sharp corners taper smoothly instead of notching at the apex.
  const limitL = new Float32Array(SAMPLES).fill(1e9);
  const limitR = new Float32Array(SAMPLES).fill(1e9);
  {
    const win = Math.max(4, Math.ceil(52 / segLen));
    for (let i = 0; i < SAMPLES; i++) {
      let rL = 1e9, rR = 1e9;
      for (let j = -win; j <= win; j++) {
        const k = curvatures[wrap(i + j)];
        if (k > 1e-6) rL = Math.min(rL, 0.92 / k);
        else if (k < -1e-6) rR = Math.min(rR, -0.92 / k);
      }
      limitL[i] = rL;
      limitR[i] = rR;
    }
    // Shape the limit profile: cap to the relevant range, Lipschitz-relax
    // with a gentle slope (long lead-in/lead-out), then box-blur into
    // S-curves so the taper has no kinks. The unfold pass in the mesh
    // builders remains the hard guarantee against any residual fold.
    const cap = Math.max(...widths) + 14;
    const shape = (arr) => {
      for (let i = 0; i < SAMPLES; i++) arr[i] = Math.min(arr[i], cap);
      const maxStep = segLen * 0.45;
      for (let i = 1; i <= SAMPLES * 2; i++) {
        const a = wrap(i), b = wrap(i - 1);
        arr[a] = Math.min(arr[a], arr[b] + maxStep);
      }
      for (let i = SAMPLES * 2; i >= 1; i--) {
        const a = wrap(i - 1), b = wrap(i);
        arr[a] = Math.min(arr[a], arr[b] + maxStep);
      }
      const r = Math.max(2, Math.round(10 / segLen));
      for (let pass = 0; pass < 3; pass++) {
        const snap = Float32Array.from(arr);
        for (let i = 0; i < SAMPLES; i++) {
          let acc = 0;
          for (let j = -r; j <= r; j++) acc += snap[wrap(i + j)];
          arr[i] = acc / (2 * r + 1);
        }
      }
    };
    shape(limitL);
    shape(limitR);
  }
  const clampLat = (i, lat) => {
    const j = wrap(i);
    if (lat > 0) return Math.min(lat, limitL[j]);
    if (lat < 0) return Math.max(lat, -limitR[j]);
    return lat;
  };

  const widthAt = (i) => widths[wrap(i)];
  const halfWidthAt = (i) => widths[wrap(i)] / 2;
  const heightAt = (i) => heights[wrap(i)];
  const sideOffset = (index, lateral) => {
    const i = wrap(index);
    const p = points[i];
    const { nx, nz } = normalAt(i);
    return { x: p.x + nx * lateral, z: p.z + nz * lateral };
  };

  // Nearest centerline sample. With lastIdx, searches only a window around it
  // so overlapping branches (intersections) resolve to the branch you're on.
  function probe(x, z, lastIdx = null) {
    let best = 0, bestD = Infinity;
    if (lastIdx === null) {
      for (let i = 0; i < SAMPLES; i++) {
        const p = points[i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    } else {
      for (let k = -PROBE_WINDOW; k <= PROBE_WINDOW; k++) {
        const i = wrap(lastIdx + k);
        const p = points[i];
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    const p = points[best];
    const { nx, nz } = normalAt(best);
    return {
      index: best, dist: Math.sqrt(bestD), px: p.x, pz: p.z,
      lat: (x - p.x) * nx + (z - p.z) * nz, // signed: + = left of centerline
    };
  }

  // --- Ramps: free-standing wedge objects, placed anywhere in the world ---
  const ramps = [];
  for (const r of def.ramps ?? []) {
    const pr = probe(r.near[0], r.near[1]);
    const i = pr.index;
    const tan = tangents[i];
    const txz = Math.hypot(tan.x, tan.z) || 1;
    let fx = tan.x / txz, fz = tan.z / txz; // launch direction: local track flow...
    if (r.dir != null) { // ...unless pinned explicitly (e.g. across a crossing)
      const a = (r.dir * Math.PI) / 180;
      fx = Math.sin(a); fz = Math.cos(a);
    }
    const nx = fz, nz = -fx;
    const full = r.w === 'full';
    const w = full ? widthAt(i) - 2 : (typeof r.w === 'number' ? r.w : widthAt(i) / 3);
    // lane: -1 (right) | 0 (center) | 1 (left) pins it; absent = seeded random
    const lane = full ? 0
      : typeof r.lane === 'number' ? Math.max(-1, Math.min(1, r.lane))
      : r.lane === false ? 0
      : Math.floor(rng() * 3) - 1;
    const latOff = lane * widthAt(i) / 3;
    const lipX = points[i].x + nx * latOff, lipZ = points[i].z + nz * latOff;
    ramps.push({
      lipX, lipZ, footX: lipX - fx * r.len, footZ: lipZ - fz * r.len,
      fx, fz, w, len: r.len, h: r.h, baseY: heights[i], index: i, full,
    });
  }

  // --- Decor: placeable props. Walls & blocks are PHYSICAL obstacles;
  // arches & pylons are visual only. dir defaults to local track flow.
  const DECOR_DEFAULTS = {
    wall: { len: 30, h: 3 },
    block: { len: 4.5, h: 3.4 }, // tire stack: real-world scale next to a ~4u car
    arch: { len: 0, h: 11 }, // len 0 = auto span (road width + margin)
    pylon: { len: 0, h: 8 },
    building: { len: 26, h: 0 },  // height comes from floors
    billboard: { len: 14, h: 9 }, // h = pole height
  };
  const decor = [];
  for (const d of def.decor ?? []) {
    const dd = DECOR_DEFAULTS[d.type];
    if (!dd) continue;
    const pr = probe(d.at[0], d.at[1]);
    const tan = tangents[pr.index];
    const txz = Math.hypot(tan.x, tan.z) || 1;
    let fx = tan.x / txz, fz = tan.z / txz;
    if (d.dir != null) {
      const a = (d.dir * Math.PI) / 180;
      fx = Math.sin(a); fz = Math.cos(a);
    }
    decor.push({
      type: d.type, x: d.at[0], z: d.at[1], fx, fz,
      len: d.len ?? (dd.len || widthAt(pr.index) + 10),
      h: d.h ?? dd.h,
      // building/billboard extras: footprint depth, floor count, palette
      dep: d.dep, floors: d.floors ?? 8, neon: d.neon ?? 0,
      // Trackside props (walls/blocks/…) ride the driving surface so they sit
      // on elevated road; buildings and billboards are scenery on the world
      // floor — never lifted with a nearby raised track.
      baseY: (d.type === 'building' || d.type === 'billboard')
        ? 0 : groundAt(d.at[0], d.at[1], pr.index),
      index: pr.index,
    });
  }
  // Physical colliders: capsule segments. Blocks (tire stacks) and pylons
  // are ROUND — zero-length capsules — matching what's drawn; walls stay
  // long and thin; a building is a fat capsule spanning its long axis.
  // Arches and billboards are pass-through.
  const obstacles = decor
    .filter((d) => d.type === 'wall' || d.type === 'block' || d.type === 'pylon' || d.type === 'building')
    .map((d) => {
      if (d.type === 'building') {
        const w = d.len, dep = d.dep ?? d.len;
        // capsule along the longer footprint axis (across dir = width)
        const alongWidth = w >= dep;
        const px = -d.fz, pz = d.fx;
        return {
          ...d,
          fx: alongWidth ? px : d.fx, fz: alongWidth ? pz : d.fz,
          len: Math.max(w, dep) - Math.min(w, dep),
          thick: Math.min(w, dep) / 2,
          h: (d.floors ?? 8) * 3.1,
        };
      }
      return {
        ...d,
        len: d.type === 'wall' ? d.len : 0,
        thick: d.type === 'block' ? d.len / 2 : d.type === 'pylon' ? 1.5 : 1.2,
      };
    });

  // Height contributed by ramps at a world position (null off-ramp).
  function rampHeightAt(x, z) {
    let h = null;
    for (const r of ramps) {
      const dx = x - r.footX, dz = z - r.footZ;
      const d = dx * r.fx + dz * r.fz;
      if (d < 0 || d > r.len) continue;
      const l = -dx * r.fz + dz * r.fx;
      if (Math.abs(l) > r.w / 2) continue;
      const rh = r.baseY + r.h * (d / r.len);
      h = h === null ? rh : Math.max(h, rh);
    }
    return h;
  }

  // Spline elevation at a world position, INTERPOLATED between samples —
  // nearest-sample heights turn slopes into staircases (0.5u steps at XL
  // sample spacing) that make cars stutter-launch downhill.
  function splineHeightAtPos(x, z, idx) {
    const i = wrap(idx);
    const p0 = points[i];
    const t = tangents[i];
    const txz = Math.hypot(t.x, t.z) || 1;
    const d = ((x - p0.x) * (t.x / txz) + (z - p0.z) * (t.z / txz));
    const j = wrap(d >= 0 ? i + 1 : i - 1);
    const f = Math.min(Math.abs(d) / segLen, 1);
    return heights[i] * (1 - f) + heights[j] * f;
  }

  // Driving surface height at a world position (spline elevation + ramps).
  function groundAt(x, z, idx = null) {
    const base = idx === null ? 0 : splineHeightAtPos(x, z, idx);
    const rh = rampHeightAt(x, z);
    return rh === null ? base : Math.max(base, rh);
  }

  // Same-level branch proximity (at-grade intersections): barrier walls open
  // there. Vertically separated branches (overpass) keep walls — and the
  // LOWER branch gets an `overhead` flag (a deck covers it), which the game
  // uses to show the x-ray car outline under bridges.
  const crossing = new Array(SAMPLES).fill(false);
  const overhead = new Array(SAMPLES).fill(false);
  const guard = Math.ceil((Math.max(...widths) * 1.6) / segLen);
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < SAMPLES; j++) {
      const w = Math.min(Math.abs(j - i), SAMPLES - Math.abs(j - i));
      if (w < guard) continue;
      const a = points[i], b = points[j];
      const dxz = (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
      const reach = (widths[i] + widths[j]) / 2 * 1.15;
      if (dxz < reach * reach && Math.abs(a.y - b.y) < 4) crossing[i] = true;
      const deckReach = widths[j] / 2 + 2;
      if (b.y - a.y >= 4 && dxz < deckReach * deckReach) overhead[i] = true;
      if (crossing[i] && overhead[i]) break;
    }
  }

  return {
    def, seed, curve, length, segLen,
    sampleCount: SAMPLES, points, tangents, widths, heights, ramps, crossing, overhead,
    decor, obstacles,
    probe, normalAt, sideOffset, clampLat, widthAt, halfWidthAt, heightAt, rampHeightAt, groundAt,
    maxWidth: Math.max(...widths),
  };
}
