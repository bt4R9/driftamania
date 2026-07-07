import * as THREE from 'three';
import { buildTrackGeometry, SAMPLES, DEFAULT_WIDTH, mulberry32 } from './trackgeom.js';

export { SAMPLES, mulberry32 };
export const ROAD_WIDTH = DEFAULT_WIDTH; // legacy default; tracks set width per point

const GROUND = 2400;   // ground plane extent
const CELL = 4;        // drawn net cell size
const TILE = 8;        // independently-stepping tile (2x2 cells; verts stay sane)

export class Track {
  constructor(def, seed = 1) {
    this.def = def;
    const g = buildTrackGeometry(def, seed);
    this.geom = g;
    // Re-expose the query surface (physics/game/minimap all use these).
    this.points = g.points;
    this.tangents = g.tangents;
    this.sampleCount = g.sampleCount;
    this.length = g.length;
    this.heights = g.heights;
    this.ramps = g.ramps;
    this.decor = g.decor;
    this.obstacles = g.obstacles; // physics reads these — walls/blocks collide
    this.crossing = g.crossing;
    this.maxWidth = g.maxWidth;
    this.halfWidth = g.maxWidth / 2; // fallback only; use halfWidthAt
    this.probe = g.probe;
    this.normalAt = g.normalAt;
    this.sideOffset = g.sideOffset;
    this.widthAt = g.widthAt;
    this.halfWidthAt = g.halfWidthAt;
    this.heightAt = g.heightAt;
    this.groundAt = g.groundAt;
    this.clampLat = g.clampLat;

    this.group = this.buildMeshes();
  }

  buildMeshes() {
    const group = new THREE.Group();

    // Night ground: procedural grid with morphing neon wavefronts that both
    // glow AND physically lift the net as they pass. Shared GLSL computes the
    // waves in the vertex shader (displacement) and fragment (color); a baked
    // track mask keeps the net flat under and around the road.
    const WAVE_FNS = `
      uniform float uTime;
      // A travelling front: thin bright line of fixed WORLD width, repeating
      // every 'lambda' units.
      float front(float coord, float lambda, float speed, float width) {
        float d = (fract((coord - uTime * speed) / lambda) - 0.5) * lambda;
        return exp(-d * d / (width * width));
      }
      // Morphing waves: a serpentine front whose undulation breathes, plus
      // ripples from two slowly wandering sources.
      vec3 waves(vec2 p) {
        vec2 dir1 = normalize(vec2(0.94, 0.33));
        vec2 perp1 = vec2(-dir1.y, dir1.x);
        float along1 = dot(p, perp1);
        float amp1 = 34.0 + 20.0 * sin(uTime * 0.23);
        float amp2 = 13.0 + 10.0 * sin(uTime * 0.17 + 2.0);
        float wobble = sin(along1 * 0.012 + uTime * 0.4) * amp1
                     + sin(along1 * 0.031 - uTime * 0.7) * amp2
                     + sin(along1 * 0.006 + uTime * 0.11) * 22.0;
        float w1 = front(dot(p, dir1) + wobble, 560.0, 80.0, 9.0);
        w1 *= 0.65 + 0.35 * sin(along1 * 0.008 - uTime * 0.9);
        vec2 c2 = vec2(-520.0, -340.0) + vec2(sin(uTime * 0.11), cos(uTime * 0.13)) * 150.0;
        vec2 c3 = vec2(590.0, 430.0) + vec2(cos(uTime * 0.09), sin(uTime * 0.15)) * 180.0;
        float w2 = front(length(p - c2), 660.0, 62.0, 13.0);
        w2 *= 0.7 + 0.3 * sin(length(p - c3) * 0.01 + uTime * 0.5);
        float w3 = front(length(p - c3), 800.0, 74.0, 15.0);
        w3 *= 0.7 + 0.3 * sin(along1 * 0.007 + uTime * 0.6);
        return vec3(w1, w2, w3);
      }`;
    this.groundMat = new THREE.ShaderMaterial({
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uTime: { value: 0 }, uLift: { value: 14 }, tMask: { value: null } },
      ]),
      vertexShader: `
        #include <fog_pars_vertex>
        uniform sampler2D tMask;
        uniform float uLift;
        attribute vec2 aCell; // world-space center of this quad's grid cell
        varying vec2 vP;
        varying vec2 vCell;
        varying float vH;
        ${WAVE_FNS}
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vP = wp.xz;
          vCell = aCell;
          // Waves sampled ONCE per cell: every vertex of a square gets the
          // same height, so squares step up/down as separate tiles.
          vec3 w = waves(aCell);
          float open = texture2D(tMask, (aCell + ${GROUND / 2}.0) / ${GROUND}.0).r; // 0 near the road
          vH = min(w.x + w.y * 0.9 + w.z * 0.8, 1.45) * open; // capped: no stacked towers
          wp.y += vH * uLift;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <fog_pars_fragment>
        varying vec2 vP;
        varying vec2 vCell;
        varying float vH;
        ${WAVE_FNS}
        float gridLine(vec2 p, float cell, float w) {
          vec2 g = abs(fract(p / cell) - 0.5) * cell;
          float d = min(g.x, g.y);
          float aa = fwidth(d) * 1.2; // screen-space AA — fine lines shimmer without it
          return 1.0 - smoothstep(w - aa, w + aa, d);
        }
        void main() {
          vec3 col = vec3(0.028, 0.031, 0.051);
          float line = gridLine(vP, ${CELL}.0, 0.16);
          vec3 w = waves(vCell); // per-cell: tiles light up as units
          vec3 glow = vec3(0.13, 0.90, 1.00) * w.x * 1.1
                    + vec3(1.00, 0.18, 0.60) * w.y * 0.9
                    + vec3(1.00, 0.77, 0.30) * w.z * 0.4;
          // Raised tiles shine: height brightens them so the steps read from
          // straight above, not just by parallax.
          float lift = clamp(vH * 0.55, 0.0, 1.4);
          col += line * (vec3(0.055, 0.07, 0.12) + glow + vec3(0.10, 0.16, 0.26) * lift);
          col += (glow + vec3(0.06, 0.09, 0.15) * lift) * 0.05; // tile faces glow faintly too
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
    });
    this.groundMat.uniforms.tMask.value = makeLiftMask(this.points, this.maxWidth);
    const ground = new THREE.Mesh(makeCellGridGeometry(), this.groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.06;
    group.add(ground);

    // Shadow the ground under elevated road — reads as "this is up high".
    group.add(this.roadShadow());

    // Asphalt (brightens with elevation, width varies per sample) + neon
    // barrier strips: outer edge cyan, inner magenta — orientation cue.
    group.add(this.asphalt());
    group.add(this.wall(1, 0x22e6ff));
    group.add(this.wall(-1, 0xff2d9a));

    // Dashed centerline + supports under elevated sections.
    group.add(this.dashes());
    group.add(this.pillars());

    // Jump ramps — unmissable amber wedges.
    for (const r of this.ramps) group.add(buildRampMesh(r));

    // Placed decorations (walls, arches, pylons, blocks).
    for (const d of this.geom.decor) group.add(buildDecorMesh(d));

    // Start/finish gate: checker strip + two pylons.
    const start = this.points[0];
    const tan = this.tangents[0];
    const finish = new THREE.Mesh(
      new THREE.PlaneGeometry(this.widthAt(0), 3.2),
      new THREE.MeshBasicMaterial({ map: makeCheckerTexture(), transparent: true, opacity: 0.9 }),
    );
    // Euler XYZ applies Z first, then the -90° X lay-flat: the in-plane angle
    // that puts the strip across the road is +atan2(t.x, t.z).
    finish.rotation.x = -Math.PI / 2;
    finish.rotation.z = Math.atan2(tan.x, tan.z);
    finish.position.set(start.x, start.y + 0.03, start.z);
    group.add(finish);

    const pylonGeo = new THREE.CylinderGeometry(0.5, 0.5, 7, 10);
    const pylonMat = new THREE.MeshBasicMaterial({ color: 0xfff6c8 });
    for (const side of [1, -1]) {
      const p = this.sideOffset(0, side * (this.halfWidthAt(0) + 1.6));
      const pylon = new THREE.Mesh(pylonGeo, pylonMat);
      pylon.position.set(p.x, start.y + 3.5, p.z);
      group.add(pylon);
    }
    return group;
  }

  // Edge polyline at a per-sample lateral offset, made fold-proof: offsets
  // are curvature-clamped, then any point still moving BACKWARD along the
  // track direction collapses onto its predecessor (the corner pivot) — a
  // reversing offset curve is what draws bowties on sharp inner corners.
  edgePoints(latFor) {
    const pts = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const j = i % SAMPLES;
      const p = this.points[j];
      const { nx, nz } = this.normalAt(j);
      const lat = this.clampLat(j, latFor(j));
      pts.push({ x: p.x + nx * lat, y: p.y, z: p.z + nz * lat });
    }
    for (let i = 1; i <= SAMPLES; i++) {
      const t = this.tangents[i % SAMPLES];
      const dx = pts[i].x - pts[i - 1].x, dz = pts[i].z - pts[i - 1].z;
      if (dx * t.x + dz * t.z < 0) pts[i] = { x: pts[i - 1].x, y: pts[i].y, z: pts[i - 1].z };
    }
    return pts;
  }

  // Asphalt ribbon following per-sample width, tinted brighter with elevation.
  asphalt() {
    const pos = [], cols = [], idx = [];
    const lo = new THREE.Color(0x34373f);
    const hi = new THREE.Color(0x474e5e);
    const tint = new THREE.Color();
    const L = this.edgePoints((j) => this.widthAt(j) / 2);
    const R = this.edgePoints((j) => -this.widthAt(j) / 2);
    for (let i = 0; i <= SAMPLES; i++) {
      const j = i % SAMPLES;
      pos.push(L[i].x, L[i].y + 0.01, L[i].z);
      pos.push(R[i].x, R[i].y + 0.01, R[i].z);
      tint.copy(lo).lerp(hi, Math.min(this.points[j].y / 18, 1));
      cols.push(tint.r, tint.g, tint.b, tint.r, tint.g, tint.b);
      if (i < SAMPLES) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.setIndex(idx);
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, side: THREE.DoubleSide,
    }));
  }

  // Vertical glowing barrier ribbon along one edge (side: 1 = left/outer).
  wall(side, color) {
    const pos = [], idx = [];
    const H = 1.5;
    const E = this.edgePoints((j) => side * (this.widthAt(j) / 2 + 0.4));
    for (let i = 0; i <= SAMPLES; i++) {
      const j = i % SAMPLES;
      pos.push(E[i].x, E[i].y, E[i].z);
      pos.push(E[i].x, E[i].y + H, E[i].z);
      if (i < SAMPLES && !this.crossing[j] && !this.crossing[(j + 1) % SAMPLES]) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  }

  // Soft dark ribbon projected on the ground under elevated sections —
  // per-vertex alpha fades it in as the road rises.
  roadShadow() {
    const pos = [], cols = [], idx = [];
    const L = this.edgePoints((j) => (this.widthAt(j) + 7) / 2);
    const R = this.edgePoints((j) => -(this.widthAt(j) + 7) / 2);
    for (let i = 0; i <= SAMPLES; i++) {
      const j = i % SAMPLES;
      const p = this.points[j];
      pos.push(L[i].x, 0.03, L[i].z);
      pos.push(R[i].x, 0.03, R[i].z);
      const a = Math.min(Math.max((p.y - 1) / 4, 0), 1) * 0.45;
      cols.push(0, 0, 0, a, 0, 0, 0, a);
      if (i < SAMPLES) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 4)); // rgba: vertex alpha
    geo.setIndex(idx);
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false,
    }));
  }

  dashes() {
    const geo = new THREE.PlaneGeometry(0.5, 2.4);
    const mat = new THREE.MeshBasicMaterial({ color: 0x596175 });
    const count = Math.floor(SAMPLES / 12);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    for (let k = 0; k < count; k++) {
      const i = k * 12;
      const p = this.points[i];
      const t = this.tangents[i];
      eul.set(-Math.PI / 2, 0, Math.atan2(t.x, t.z));
      q.setFromEuler(eul);
      m.compose(new THREE.Vector3(p.x, p.y + 0.02, p.z), q, new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(k, m);
    }
    return mesh;
  }

  // Neon support pillars under elevated sections.
  pillars() {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x1e2436 });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x22e6ff });
    for (let i = 0; i < SAMPLES; i += 24) {
      const p = this.points[i];
      if (p.y < 3) continue;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, p.y, 8), mat);
      col.position.set(p.x, p.y / 2, p.z);
      group.add(col);
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, p.y, 6), glowMat);
      stripe.position.set(p.x + 1.2, p.y / 2, p.z);
      group.add(stripe);
    }
    return group;
  }

  // Advance the animated ground waves; called from the game loop.
  tick(t) {
    if (this.groundMat) this.groundMat.uniforms.uTime.value = t;
  }

  // Staggered grid slot behind the start line. Returns pose + progress offset.
  spawnPose(slot) {
    const segLen = this.length / SAMPLES;
    const backSamples = Math.round((8 + Math.floor(slot / 2) * 9) / segLen);
    const index = (SAMPLES - backSamples) % SAMPLES;
    const lateral = (slot % 2 === 0 ? 1 : -1) * this.widthAt(index) / 4.5;
    const p = this.sideOffset(index, lateral);
    const t = this.tangents[index];
    return {
      x: p.x, z: p.z, y: this.points[index].y,
      heading: Math.atan2(t.x, t.z), index, progressOffset: -backSamples,
    };
  }
}

// A jump ramp: rectangular wedge in its own frame — chevron deck, dark side
// skirts, sheer lip face, glowing edge rails.
function buildRampMesh(r) {
  const group = new THREE.Group();
  const rimY = 0.06;
  const px = -r.fz, pz = r.fx; // left perp of launch dir
  const hw = r.w / 2;
  const y0 = r.baseY + rimY, y1 = r.baseY + r.h + rimY;
  const FL = [r.footX + px * hw, y0, r.footZ + pz * hw];
  const FR = [r.footX - px * hw, y0, r.footZ - pz * hw];
  const LL = [r.lipX + px * hw, y1, r.lipZ + pz * hw];
  const LR = [r.lipX - px * hw, y1, r.lipZ - pz * hw];

  const quad = (a, b, c, d, mat, uv = null) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...d], 3));
    if (uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex([0, 1, 2, 1, 3, 2]);
    group.add(new THREE.Mesh(geo, mat));
  };

  const deckMat = new THREE.MeshBasicMaterial({ map: makeChevronTexture(), side: THREE.DoubleSide });
  quad(FL, FR, LL, LR, deckMat, [0, 0, 1, 0, 0, 1, 1, 1]);

  const skirtMat = new THREE.MeshBasicMaterial({ color: 0x241505, side: THREE.DoubleSide });
  quad(FL, LL, [FL[0], r.baseY, FL[2]], [LL[0], r.baseY, LL[2]], skirtMat);
  quad(FR, LR, [FR[0], r.baseY, FR[2]], [LR[0], r.baseY, LR[2]], skirtMat);
  quad(LL, LR, [LL[0], r.baseY, LL[2]], [LR[0], r.baseY, LR[2]],
    new THREE.MeshBasicMaterial({ color: 0x33200a, side: THREE.DoubleSide }));

  const railMat = new THREE.MeshBasicMaterial({ color: 0xffc24d });
  for (const [f, l] of [[FL, LL], [FR, LR]]) {
    const rail = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
        new THREE.Vector3(f[0], f[1] + 0.25, f[2]),
        new THREE.Vector3(l[0], l[1] + 0.25, l[2]),
      ]), 1, 0.35, 6, false),
      railMat,
    );
    group.add(rail);
  }
  return group;
}

// Placed decor meshes. Walls/blocks are the physical ones (physics uses the
// matching capsule in trackgeom); arches and pylons are pure set dressing.
function buildDecorMesh(d) {
  const group = new THREE.Group();
  const px = -d.fz, pz = d.fx; // left perp of dir
  const neonCyan = new THREE.MeshBasicMaterial({ color: 0x22e6ff });
  const neonMagenta = new THREE.MeshBasicMaterial({ color: 0xff2d9a });
  const dark = new THREE.MeshBasicMaterial({ color: 0x1a1f2e });

  if (d.type === 'wall') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, d.h, d.len), dark);
    body.position.set(d.x, d.baseY + d.h / 2, d.z);
    body.rotation.y = Math.atan2(d.fx, d.fz);
    group.add(body);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.35, d.len), neonCyan);
    strip.position.set(d.x, d.baseY + d.h + 0.15, d.z);
    strip.rotation.y = Math.atan2(d.fx, d.fz);
    group.add(strip);
  } else if (d.type === 'block') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(d.len, d.h, d.len), dark);
    body.position.set(d.x, d.baseY + d.h / 2, d.z);
    body.rotation.y = Math.atan2(d.fx, d.fz);
    group.add(body);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(d.len, d.h, d.len)),
      new THREE.LineBasicMaterial({ color: 0xa85cff }),
    );
    edges.position.copy(body.position);
    edges.rotation.y = body.rotation.y;
    group.add(edges);
  } else if (d.type === 'arch') {
    // Gate ACROSS the dir: pillars either side, glowing beam over the top.
    const half = d.len / 2;
    for (const s of [1, -1]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, d.h, 8), dark);
      pillar.position.set(d.x + px * half * s, d.baseY + d.h / 2, d.z + pz * half * s);
      group.add(pillar);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, d.len + 1.6), dark);
    beam.position.set(d.x, d.baseY + d.h, d.z);
    beam.rotation.y = Math.atan2(px, pz);
    group.add(beam);
    const tube = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, d.len + 1.6), neonMagenta);
    tube.position.set(d.x, d.baseY + d.h - 0.7, d.z);
    tube.rotation.y = Math.atan2(px, pz);
    group.add(tube);
  } else if (d.type === 'pylon') {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.3, d.h, 8), dark);
    col.position.set(d.x, d.baseY + d.h / 2, d.z);
    group.add(col);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, d.h, 6), neonCyan);
    stripe.position.set(d.x + 1.15, d.baseY + d.h / 2, d.z);
    group.add(stripe);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), neonMagenta);
    tip.position.set(d.x, d.baseY + d.h + 0.6, d.z);
    group.add(tip);
  }
  return group;
}

// Disconnected-quads ground: every BLOCK×BLOCK cell owns its 6 vertices plus
// an aCell attribute (the cell's world center), so cells can sit at different
// heights — the wave steps tile by tile instead of bending a shared sheet.
function makeCellGridGeometry() {
  const n = GROUND / TILE;
  const geo = new THREE.PlaneGeometry(GROUND, GROUND, n, n).toNonIndexed();
  const pos = geo.attributes.position;
  const cell = new Float32Array(pos.count * 2);
  for (let t = 0; t < pos.count; t += 3) {
    // Triangle centroid → owning cell (corners are ambiguous, centroids aren't).
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    // Local plane (x, y) → world (x, -y) once the mesh is laid flat.
    const wx = (Math.floor(cx / TILE) + 0.5) * TILE;
    const wz = -(Math.floor(cy / TILE) + 0.5) * TILE;
    for (let k = 0; k < 3; k++) {
      cell[(t + k) * 2] = wx;
      cell[(t + k) * 2 + 1] = wz;
    }
  }
  geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 2));
  return geo;
}

// Track-proximity mask for the wave lift: white = open field (full lift),
// black band along the road so the net stays flat where people drive.
function makeLiftMask(points, maxWidth) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 256, 256);
  const s = 256 / GROUND, off = GROUND / 2;
  g.strokeStyle = '#000';
  g.lineWidth = (maxWidth + 300) * s; // net stays flat ~170u either side of the centerline
  g.lineJoin = g.lineCap = 'round';
  g.filter = 'blur(4px)'; // soft edge (ignored where unsupported — still fine)
  g.beginPath();
  points.forEach((p, i) => {
    const x = (p.x + off) * s, y = (p.z + off) * s;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  });
  g.closePath();
  g.stroke();
  g.filter = 'none';
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false; // sampled with world-derived UVs, no flip
  return tex;
}

function makeChevronTexture() {
  const w = 128, h = 128;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#e07818'; // hot amber deck
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 14;
  g.lineJoin = 'miter';
  // Upward chevron (points toward the lip / direction of travel)
  g.beginPath();
  g.moveTo(14, 88);
  g.lineTo(w / 2, 40);
  g.lineTo(w - 14, 88);
  g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 3);
  return tex; // default flipY: deck v=1 is the lip, so the apex points at it
}

function makeCheckerTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 16;
  const g = c.getContext('2d');
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 2; y++) {
      g.fillStyle = (x + y) % 2 ? '#0a0a0a' : '#e8e8e8';
      g.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  return tex;
}
