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
    this.overhead = g.overhead;
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
        varying vec2 vP;
        varying vec3 vW;
        varying float vH;
        ${WAVE_FNS}
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vP = wp.xz;
          // Waves sampled per VERTEX: neighboring tiles share corner
          // positions, so the sheet stays CONTINUOUS — stepped per-tile lift
          // left slits between tiles and parallax-broke the net pattern.
          vec3 w = waves(wp.xz);
          vW = w;
          float open = texture2D(tMask, (wp.xz + ${GROUND / 2}.0) / ${GROUND}.0).r; // 0 near the road
          vH = min(w.x + w.y * 0.9 + w.z * 0.8, 1.45) * open; // capped: no stacked towers
          wp.y += vH * uLift;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <fog_pars_fragment>
        varying vec2 vP;
        varying vec3 vW;
        varying float vH;
        float gridLine(vec2 p, float cell, float w) {
          vec2 g = abs(fract(p / cell) - 0.5) * cell;
          float d = min(g.x, g.y);
          float aa = fwidth(d) * 1.2; // screen-space AA — fine lines shimmer without it
          return 1.0 - smoothstep(w - aa, w + aa, d);
        }
        void main() {
          vec3 col = vec3(0.028, 0.031, 0.051);
          float line = gridLine(vP, ${CELL}.0, 0.16);
          vec3 w = vW; // per-tile wave value, computed once in the vertex stage
          vec3 glow = vec3(0.13, 0.90, 1.00) * w.x * 1.1
                    + vec3(1.00, 0.18, 0.60) * w.y * 0.9
                    + vec3(1.00, 0.77, 0.30) * w.z * 0.4;
          // Raised net shines with height — kept modest so an overlapping
          // wave crest can't stack into a blown-out white patch.
          float lift = clamp(vH * 0.45, 0.0, 1.0);
          col += line * (vec3(0.055, 0.07, 0.12) + min(glow, vec3(0.85)) + vec3(0.07, 0.11, 0.18) * lift);
          col += (min(glow, vec3(0.85)) + vec3(0.05, 0.08, 0.13) * lift) * 0.05;
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
    });
    // Editor-placed buildings and billboards pin the wave net flat beneath
    // themselves — they sit on the world floor, so a wave crest would
    // otherwise swallow them.
    const bldgSpots = this.geom.decor
      .filter((d) => d.type === 'building' || d.type === 'billboard')
      .map((d) => ({ x: d.x, z: d.z, r: Math.max(d.len, d.dep ?? d.len) / 2 }));
    this.groundMat.uniforms.tMask.value = makeLiftMask(this.points, this.maxWidth, bldgSpots);
    // Chunked ground: 100 meshes instead of one 540k-vert monolith, so
    // frustum culling drops ~85% of the net outside the camera every frame.
    for (const geo of buildGroundChunks()) {
      const chunk = new THREE.Mesh(geo, this.groundMat);
      chunk.position.y = -0.06;
      group.add(chunk);
    }

    // Shadow the ground under elevated road — reads as "this is up high".
    group.add(this.roadShadow());

    // Asphalt (brightens with elevation, width varies per sample) + neon
    // barrier strips: outer edge cyan, inner magenta — orientation cue.
    group.add(this.asphalt());
    group.add(this.wall(1, 0x22e6ff));
    group.add(this.wall(-1, 0xff2d9a));

    // Centerline direction chevrons (chase-animated in tick) + supports.
    this.arrowsMesh = this.dashes();
    group.add(this.arrowsMesh);
    group.add(this.pillars());

    // Jump ramps — unmissable amber wedges.
    for (const r of this.ramps) group.add(buildRampMesh(r));

    // Placed decorations (walls, arches, pylons, blocks, buildings, signs).
    this.decorTickers = [];
    for (const d of this.geom.decor) group.add(buildDecorMesh(d, this.decorTickers));


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
    const H = 2.2; // matches physics WALL_HEIGHT — clear this and you are OFF
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

  // Neon chevrons down the centerline, pointing along the direction of
  // travel — replaces the old grey lane dashes.
  dashes() {
    const geo = new THREE.PlaneGeometry(3.4, 2.7);
    const mat = new THREE.MeshBasicMaterial({
      map: makeNeonArrowTexture(), transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const count = Math.floor(SAMPLES / 10);
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const eul = new THREE.Euler();
    for (let k = 0; k < count; k++) {
      const i = k * 10;
      const p = this.points[i];
      const t = this.tangents[i];
      eul.set(-Math.PI / 2, 0, Math.atan2(t.x, t.z) + Math.PI);
      q.setFromEuler(eul);
      m.compose(new THREE.Vector3(p.x, p.y + 0.04, p.z), q, new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(k, m);
    }
    return mesh;
  }

  // Neon support pillars under elevated sections.
  pillars() {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x1e2436 });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x22e6ff });
    // A pillar may not impale a LOWER stretch of road passing beneath
    // (bridges): skip supports whose footprint lands on another section.
    const guard = Math.ceil((this.maxWidth * 1.6) / (this.length / SAMPLES));
    const overRoad = (i, p) => {
      for (let j = 0; j < SAMPLES; j += 4) {
        const w = Math.min(Math.abs(j - i), SAMPLES - Math.abs(j - i));
        if (w < guard) continue;
        const q = this.points[j];
        if (q.y > p.y - 2) continue;
        const dx = q.x - p.x, dz = q.z - p.z;
        const reach = this.geom.widths[j] / 2 + 2.5;
        if (dx * dx + dz * dz < reach * reach) return true;
      }
      return false;
    };
    for (let i = 0; i < SAMPLES; i += 24) {
      const p = this.points[i];
      if (p.y < 3) continue;
      if (overRoad(i, p)) continue;
      // Stop BELOW the deck: a pillar reaching exactly p.y pokes its dark
      // top cap through the road wherever the surface interpolates lower.
      const h = p.y - 1.4;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, h, 8), mat);
      col.position.set(p.x, h / 2, p.z);
      group.add(col);
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, h, 6), glowMat);
      stripe.position.set(p.x + 1.2, h / 2, p.z);
      group.add(stripe);
    }
    return group;
  }

  // Advance the animated ground waves + the arrow chase; called per frame.
  tick(t) {
    if (this.groundMat) this.groundMat.uniforms.uTime.value = t;
    for (const f of this.decorTickers ?? []) f(t);
    if (this.arrowsMesh) {
      // Chase pulse: a brightness wave runs DOWN the track (back → front),
      // underlining the direction of travel like runway lights.
      const mesh = this.arrowsMesh;
      const pulses = Math.max(6, Math.round(mesh.count / 7));
      this._arrowCol ??= new THREE.Color();
      for (let k = 0; k < mesh.count; k++) {
        const u = (k * 10) / SAMPLES;
        let ph = (u * pulses - t * 1.1) % 1;
        if (ph < 0) ph += 1;
        const d = ph < 0.5 ? ph : 1 - ph;
        const b = 0.35 + 1.0 * Math.exp(-(d * d) / 0.011);
        mesh.setColorAt(k, this._arrowCol.setRGB(b, b, b));
      }
      mesh.instanceColor.needsUpdate = true;
    }
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
// Tire thickness: scale with stack height so short stacks aren't pancakes.
function clampTire(h) { return Math.min(2.6, Math.max(1.5, h / 4)); }

function buildDecorMesh(d, tickers = null) {
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
    // Tire stack — the classic circuit-side barrier (and it matches the
    // round collider). Rubber rings with a neon top ring for night visibility.
    const R = d.len / 2;
    const tireH = clampTire(d.h);
    const n = Math.max(2, Math.round(d.h / tireH));
    const tube = tireH / 2;
    const geo = new THREE.TorusGeometry(Math.max(R - tube, tube), tube, 10, 22);
    const rubber = new THREE.MeshLambertMaterial({ color: 0x232a3a });
    const rubberDark = new THREE.MeshLambertMaterial({ color: 0x171d2b });
    for (let i = 0; i < n; i++) {
      const tire = new THREE.Mesh(geo, i % 2 ? rubberDark : rubber);
      tire.rotation.x = Math.PI / 2;
      tire.position.set(d.x, d.baseY + tube + i * tireH, d.z);
      group.add(tire);
    }
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(Math.max(R - tube, tube), 0.22, 6, 22),
      new THREE.MeshBasicMaterial({ color: 0xa85cff }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(d.x, d.baseY + n * tireH - 0.1, d.z);
    group.add(ring);
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
  } else if (d.type === 'building') {
    // Neon tower: floors × window rows on the sides, dark roof with a neon
    // trim ring. Width/depth/floors/palette all come from the editor.
    const w = d.len, dep = d.dep ?? d.len;
    const floors = Math.max(1, Math.round(d.floors ?? 8));
    const h = floors * 3.1;
    const cols = Math.max(2, Math.round(w / 4.5));
    const atlas = makeLivingBuildingAtlas(d.neon ?? 0, Math.min(floors, 34), cols);
    if (tickers) tickers.push(atlas.tick);
    const bldg = new THREE.Mesh(makeBuildingGeo(), new THREE.MeshBasicMaterial({ map: atlas.tex }));
    bldg.scale.set(w, h, dep);
    bldg.position.set(d.x, d.baseY + h / 2 - 0.05, d.z);
    bldg.rotation.y = Math.atan2(d.fx, d.fz);
    group.add(bldg);
  } else if (d.type === 'billboard') {
    // Glowing road sign: pole + straight vertical panel facing along the
    // local flow (drivers see it coming).
    const rng = mulberry32(Math.abs(Math.round(d.x * 31 + d.z * 7)) + 1);
    const pw = d.len, ph = Math.max(4, d.len * 0.45);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, d.h, 8), dark);
    pole.position.set(d.x, d.baseY + d.h / 2, d.z);
    group.add(pole);
    const face = new THREE.MeshBasicMaterial({ map: makeBillboardTexture(rng, d.neon) });
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(pw, ph, 0.6),
      [dark, dark, dark, dark, face, face],
    );
    panel.position.set(d.x, d.baseY + d.h + ph / 2 - 0.6, d.z);
    panel.rotation.y = Math.atan2(d.fx, d.fz);
    group.add(panel);
  }
  return group;
}

// Unit box with per-face UVs into the building atlas: sides = windows,
// top-right of the atlas = roof trim, bottom-right = dark underside.
function makeBuildingGeo() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const uv = geo.attributes.uv;
  for (let i = 0; i < 24; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    if (i >= 8 && i < 12) uv.setXY(i, 0.765 + u * 0.225, 0.01 + v * 0.225);        // roof
    else if (i >= 12 && i < 16) uv.setXY(i, 0.765 + u * 0.225, 0.765 + v * 0.225); // underside
    else uv.setXY(i, u * 0.74, v);                                                 // window walls
  }
  geo.clearGroups();
  return geo;
}

// Chunked disconnected-quads ground: every TILE cell owns its 6 vertices
// plus an aCell attribute (cell center), built directly in world XZ so no
// rotation is needed. Chunks of 30×30 tiles are individually frustum-culled.
function buildGroundChunks() {
  const tilesPerSide = GROUND / TILE;          // 300
  const CHUNK_TILES = 30;                      // 10×10 chunks
  const chunks = [];
  for (let gz = 0; gz < tilesPerSide; gz += CHUNK_TILES) {
    for (let gx = 0; gx < tilesPerSide; gx += CHUNK_TILES) {
      const nT = CHUNK_TILES * CHUNK_TILES;
      const pos = new Float32Array(nT * 6 * 3);
      const cell = new Float32Array(nT * 6 * 2);
      let vi = 0;
      for (let tz = gz; tz < gz + CHUNK_TILES; tz++) {
        for (let tx = gx; tx < gx + CHUNK_TILES; tx++) {
          const x0 = tx * TILE - GROUND / 2, z0 = tz * TILE - GROUND / 2;
          const x1 = x0 + TILE, z1 = z0 + TILE;
          // two triangles, wound so the face normal points up
          const tri = [x0, z0, x0, z1, x1, z0, x1, z0, x0, z1, x1, z1];
          const cx = x0 + TILE / 2, cz = z0 + TILE / 2;
          for (let k = 0; k < 6; k++) {
            pos[vi * 3] = tri[k * 2];
            pos[vi * 3 + 1] = 0;
            pos[vi * 3 + 2] = tri[k * 2 + 1];
            cell[vi * 2] = cx;
            cell[vi * 2 + 1] = cz;
            vi++;
          }
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 2));
      geo.computeBoundingSphere();
      geo.boundingSphere.radius += 26; // headroom for wave lift displacement
      chunks.push(geo);
    }
  }
  return chunks;
}

// Track-proximity mask for the wave lift: white = open field (full lift),
// black band along the road so the net stays flat where people drive.
function makeLiftMask(points, maxWidth, spots = []) {
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
  // Buildings pin the net flat beneath them — waves must not lift ground
  // tiles through a tower.
  g.fillStyle = '#000';
  for (const b of spots) {
    g.beginPath();
    g.arc((b.x + off) * s, (b.z + off) * s, Math.max(2, (b.r + 12) * s), 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false; // sampled with world-derived UVs, no flip
  return tex;
}

// ---- Neon city textures (canvas-painted, one per palette variant) ----
const CITY_PALETTES = ['#5fe8ff', '#ff5fae', '#ffd27a', '#b6ff3d', '#b07aff', '#ff6a5c', '#dcefff'];

// Living building atlas: sides = windows (left 74%), roof trim bottom-right,
// dark underside top-right. Windows toggle and shimmer over time — call
// .tick(t) from the game loop.
function makeLivingBuildingAtlas(variant, rows = 11, cols = 5) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const lit = CITY_PALETTES[variant % CITY_PALETTES.length];
  const cw = 190 / cols, ch = size / rows;
  const on = [], alpha = [];
  for (let i = 0; i < rows * cols; i++) {
    on.push(Math.random() < 0.34);
    alpha.push(0.35 + Math.random() * 0.3);
  }
  // static parts: background + roof trim (bottom-right under flipY)
  g.fillStyle = '#0a0d16';
  g.fillRect(0, 0, size, size);
  g.strokeStyle = lit;
  g.globalAlpha = 0.65;
  g.lineWidth = 2;
  g.shadowColor = lit;
  g.shadowBlur = 3;
  g.strokeRect(198, 198, 52, 52);
  g.shadowBlur = 0;
  g.globalAlpha = 1;
  const paint = () => {
    g.globalAlpha = 1;
    g.shadowBlur = 0;
    g.fillStyle = '#0a0d16';
    g.fillRect(0, 0, 192, size);
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const i = r * cols + col;
        g.shadowBlur = on[i] ? 2.5 : 0;
        g.shadowColor = lit;
        g.fillStyle = on[i] ? lit : '#131a29';
        g.globalAlpha = on[i] ? alpha[i] : 1;
        g.fillRect(col * cw + cw * 0.22, r * ch + ch * 0.25, cw * 0.56, ch * 0.5);
      }
    }
    g.globalAlpha = 1;
    g.shadowBlur = 0;
  };
  paint();
  const tex = new THREE.CanvasTexture(c);
  let next = 0;
  return {
    tex,
    tick(t) {
      if (t < next) return;
      next = t + 0.35 + Math.random() * 0.6;
      // someone turns a light on, someone turns one off; lit ones shimmer
      for (let k = 0; k < 2; k++) {
        const i = Math.floor(Math.random() * on.length);
        if (Math.random() < 0.55) on[i] = !on[i];
        alpha[i] = 0.35 + Math.random() * 0.3;
      }
      paint();
      tex.needsUpdate = true;
    },
  };
}

// Glowing sign faces: big neon word, framed.
const BILLBOARD_WORDS = ['DRIFT', 'ネオン', 'TURBO', 'APEX', '夜遊び', 'VOLT', 'NITRO', 'GRIP', '88', 'ドリフト'];
function makeBillboardTexture(rng, neon = null) {
  const w = 256, h = 128;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#07090f';
  g.fillRect(0, 0, w, h);
  const color = CITY_PALETTES[(neon ?? Math.floor(rng() * CITY_PALETTES.length)) % CITY_PALETTES.length];
  const word = BILLBOARD_WORDS[Math.floor(rng() * BILLBOARD_WORDS.length)];
  g.strokeStyle = color;
  g.lineWidth = 5;
  g.shadowColor = color;
  g.shadowBlur = 12;
  g.strokeRect(8, 8, w - 16, h - 16);
  g.font = 'italic 900 52px "Avenir Next", "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowBlur = 22;
  g.fillStyle = color;
  g.fillText(word, w / 2, h / 2 + 2, w - 44);
  g.shadowBlur = 0;
  return new THREE.CanvasTexture(c);
}

// Glowing cyan chevron on transparent — additive-blended it reads as neon.
function makeNeonArrowTexture() {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const chevron = () => {
    g.beginPath();
    g.moveTo(24, 86);
    g.lineTo(s / 2, 42);
    g.lineTo(s - 24, 86);
    g.stroke();
  };
  // glow halo (double-struck), then hot core
  g.strokeStyle = 'rgba(34,230,255,0.8)';
  g.lineWidth = 13;
  g.shadowColor = 'rgba(34,230,255,0.95)';
  g.shadowBlur = 16;
  chevron();
  chevron();
  g.shadowBlur = 0;
  g.strokeStyle = '#eafcff';
  g.lineWidth = 4.5;
  chevron();
  return new THREE.CanvasTexture(c);
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
