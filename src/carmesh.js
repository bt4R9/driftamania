import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const CAR_COLORS = [0x22e6ff, 0xff2d9a, 0xb6ff3d, 0xffb14d, 0xa85cff, 0xff4d4d, 0x4dff9e, 0xfff64d];
export const CAR_MODELS = ['skyline', 'zcar', 'carrera', 'muscle', 'wedge'];

// Builds a car facing +Z. `model` picks a body kit with a recognizable
// silhouette. Returns { group, setBrake, dispose }.
export function buildCarMesh(color, model = 'skyline') {
  // Two-level rig: `group` gets position + heading yaw ONLY (ground-projected
  // light effects live here, always flat on the road); `body` takes pitch,
  // roll, tumble and squash — so flipping the car doesn't flip its underglow.
  const group = new THREE.Group();
  const body = new THREE.Group();
  body.rotation.order = 'XYZ';
  group.add(body);
  const c = new THREE.Color(color);

  // Body paint IS the driver color (deepened so neon accents still pop) —
  // cars read as colored at a glance, not black-with-trim.
  const bodyCol = c.clone();
  {
    const hsl = { h: 0, s: 0, l: 0 };
    bodyCol.getHSL(hsl);
    bodyCol.setHSL(hsl.h, Math.min(0.75, hsl.s * 0.8), 0.3);
  }
  const bodyMat = new THREE.MeshLambertMaterial({ color: bodyCol });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x151a26 });
  const accentMat = new THREE.MeshBasicMaterial({ color: c });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x12202f });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0x550a0a });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x6b7794, transparent: true, opacity: 0.55 });

  // Streamlined panels: every box is corner-rounded so the body reads as
  // sheet metal, not stacked bricks. edge=true adds a soft cel outline (only
  // where the rounded shell still has a hard crease). ry angles a box in
  // plan view (swept headlights, canted tails).
  const box = (w, h, d, x, y, z, mat, rx = 0, edge = false, ry = 0) => {
    const r = Math.min(0.26, Math.min(w, h, d) * 0.42);
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), mat);
    m.position.set(x, y, z);
    if (rx) m.rotation.x = rx;
    if (ry) m.rotation.y = ry;
    body.add(m);
    if (edge) {
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 38), edgeMat);
      l.position.copy(m.position);
      l.rotation.copy(m.rotation);
      body.add(l);
    }
    return m;
  };
  const chromeMat = new THREE.MeshLambertMaterial({ color: 0x8d99b5 });
  const mirrors = (x, y, z) => {
    box(0.28, 0.07, 0.16, -x, y, z, bodyMat);
    box(0.28, 0.07, 0.16, x, y, z, bodyMat);
  };

  // ---- body kits: the recognizable part ----
  if (model === 'skyline') {
    // R34 Skyline GT-R: boxy JDM coupe — squared lines, hood vents, thick
    // C-pillar sails, strut wing with endplates, quad round tails, diffuser.
    box(1.92, 0.6, 3.85, 0, 0.58, 0, bodyMat, 0, true);
    box(1.75, 0.34, 0.85, 0, 0.46, 1.95, bodyMat);          // bumper
    box(1.84, 0.1, 0.34, 0, 0.26, 2.06, darkMat);           // splitter lip
    box(1.5, 0.5, 1.8, 0, 1.06, -0.3, glassMat, 0, true);   // cabin
    box(1.42, 0.12, 1.55, 0, 1.36, -0.3, bodyMat, 0, true); // roof
    box(0.26, 0.06, 3.6, 0, 0.9, 0.1, accentMat);           // center stripe
    box(1.3, 0.1, 0.5, 0, 0.94, 1.4, bodyMat);              // hood bulge
    box(0.44, 0.05, 0.3, -0.5, 0.95, 1.06, darkMat);        // hood vents
    box(0.44, 0.05, 0.3, 0.5, 0.95, 1.06, darkMat);
    box(0.16, 0.42, 1.0, -0.68, 0.98, -1.1, bodyMat);       // C-pillar sails
    box(0.16, 0.42, 1.0, 0.68, 0.98, -1.1, bodyMat);
    mirrors(1.06, 1.08, 0.62);
    // strut wing + endplates
    box(0.12, 0.34, 0.14, -0.6, 1.06, -1.78, bodyMat);
    box(0.12, 0.34, 0.14, 0.6, 1.06, -1.78, bodyMat);
    box(1.9, 0.07, 0.5, 0, 1.26, -1.85, accentMat);
    box(0.06, 0.18, 0.52, -0.95, 1.3, -1.85, darkMat);
    box(0.06, 0.18, 0.52, 0.95, 1.3, -1.85, darkMat);
    box(1.5, 0.12, 0.32, 0, 0.24, -1.96, darkMat);          // rear diffuser
    box(0.46, 0.16, 0.1, -0.62, 0.62, 1.96, headMat);       // square xenons
    box(0.46, 0.16, 0.1, 0.62, 0.62, 1.96, headMat);
    // quad round taillights — THE GT-R cue
    for (const sx of [-1, 1]) {
      for (const off of [0.34, 0.64]) {
        const tl = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 10), brakeMat);
        tl.rotation.x = Math.PI / 2;
        tl.position.set(sx * off, 0.64, -1.94);
        body.add(tl);
      }
    }
  } else if (model === 'zcar') {
    // Nissan 350Z: long power-bulge hood, cabin set way back, rounded hatch,
    // teardrop headlights swept up the fenders, canted tails, side gills.
    box(1.88, 0.56, 3.65, 0, 0.55, 0, bodyMat, 0, true);
    box(1.62, 0.3, 0.6, 0, 0.44, 1.9, bodyMat);             // rounded nose
    box(1.7, 0.09, 0.3, 0, 0.28, 2.0, darkMat);             // chin
    box(1.0, 0.1, 1.5, 0, 0.87, 1.0, bodyMat, 0, true);     // hood power bulge
    box(1.38, 0.46, 1.25, 0, 0.98, -0.55, glassMat, 0, true); // rear-set cabin
    box(1.24, 0.1, 0.8, 0, 1.24, -0.5, bodyMat, 0, true);   // rounded roof
    box(1.3, 0.08, 1.0, 0, 0.94, -1.3, glassMat, -0.3);     // hatch glass
    box(1.55, 0.07, 0.35, 0, 0.9, -1.7, bodyMat);           // hatch deck
    box(1.1, 0.05, 0.22, 0, 0.95, -1.72, accentMat);        // lip spoiler
    // teardrop headlights swept back along the fenders
    box(0.58, 0.1, 0.16, -0.6, 0.7, 1.74, headMat, 0, false, 0.42);
    box(0.58, 0.1, 0.16, 0.6, 0.7, 1.74, headMat, 0, false, -0.42);
    // canted boomerang tails
    box(0.52, 0.1, 0.12, -0.6, 0.72, -1.8, brakeMat, 0, false, -0.32);
    box(0.52, 0.1, 0.12, 0.6, 0.72, -1.8, brakeMat, 0, false, 0.32);
    box(0.06, 0.16, 0.34, -0.96, 0.68, 0.6, accentMat);     // door gills
    box(0.06, 0.16, 0.34, 0.96, 0.68, 0.6, accentMat);
    mirrors(1.02, 1.02, 0.2);
  } else if (model === 'carrera') {
    // Porsche 911: round fender lamps, sloped frunk, wide hips, engine-deck
    // cooling slats, whale tail with a dark rubber rim.
    box(1.8, 0.55, 3.75, 0, 0.52, 0.05, bodyMat, 0, true);
    box(0.28, 0.5, 1.6, -0.88, 0.55, -0.95, bodyMat);       // hips
    box(0.28, 0.5, 1.6, 0.88, 0.55, -0.95, bodyMat);
    box(1.42, 0.5, 1.55, 0, 1.0, 0.25, glassMat, 0, true);  // cabin
    box(1.28, 0.1, 0.95, 0, 1.27, 0.3, bodyMat, 0, true);   // round roof
    box(1.45, 0.09, 1.5, 0, 0.99, -0.85, glassMat, -0.28);  // fastback slope
    box(1.5, 0.07, 0.9, 0, 0.79, 1.4, bodyMat, -0.09);      // sloped frunk
    box(0.24, 0.05, 2.6, 0, 0.86, 0.5, accentMat);          // stripe
    // engine-deck cooling slats
    for (let k = 0; k < 4; k++) box(1.05, 0.04, 0.09, 0, 0.93, -1.06 - k * 0.17, darkMat);
    // whale tail: body-color blade in a dark rubber surround
    box(1.72, 0.05, 0.62, 0, 0.99, -1.68, darkMat);
    box(1.56, 0.07, 0.5, 0, 1.03, -1.66, accentMat);
    // round headlights standing on the fenders
    for (const sx of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.2, 10), headMat);
      lamp.position.set(sx * 0.66, 0.78, 1.72);
      body.add(lamp);
    }
    mirrors(1.0, 1.04, 0.78);
    box(1.5, 0.12, 0.07, 0, 0.62, -1.9, brakeMat);          // full-width light bar
  } else if (model === 'muscle') {
    // Muscle coupe: long hood + scoop, chrome bumpers, quad round lamps in a
    // dark grille, cabin far back, fastback to a kamm tail.
    box(2.0, 0.62, 4.0, 0, 0.58, 0, bodyMat, 0, true);
    box(1.5, 0.5, 1.45, 0, 1.06, -0.8, glassMat, 0, true);  // cabin (rear)
    box(1.42, 0.11, 1.1, 0, 1.36, -0.85, bodyMat, 0, true); // roof
    box(1.46, 0.09, 1.15, 0, 1.05, -1.62, glassMat, -0.32); // fastback
    box(1.55, 0.26, 0.1, 0, 0.5, 2.0, darkMat);             // grille
    box(1.95, 0.09, 0.14, 0, 0.36, 2.03, chromeMat);        // chrome bumper
    box(1.95, 0.09, 0.14, 0, 0.4, -2.02, chromeMat);        // rear chrome
    box(0.62, 0.16, 0.75, 0, 0.99, 0.85, darkMat);          // hood scoop
    for (const sx of [-1, 1]) {
      box(0.22, 0.05, 2.0, sx * 0.32, 0.92, 0.95, accentMat); // twin hood stripes
      // quad round lamps set into the grille
      for (const off of [0.5, 0.76]) {
        const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.09, 10), headMat);
        lamp.rotation.x = Math.PI / 2;
        lamp.position.set(sx * off, 0.58, 2.0);
        body.add(lamp);
      }
    }
    mirrors(1.06, 1.06, -0.2);
    box(1.7, 0.14, 0.07, 0, 0.66, -1.99, brakeMat);         // full-width tail bar
    box(1.9, 0.1, 0.35, 0, 0.92, -1.85, bodyMat);           // tail lip
  } else {
    // 'wedge': low doorstop supercar — pointy nose, cab forward, louvered
    // engine cover, flush pop-up lamp covers, huge wing on endplates.
    box(1.9, 0.42, 3.9, 0, 0.42, 0, bodyMat, 0, true);
    box(1.8, 0.1, 1.9, 0, 0.62, 1.15, bodyMat, -0.1);       // wedge nose plate
    box(1.35, 0.42, 1.35, 0, 0.83, 0.3, glassMat);          // cab forward
    box(1.2, 0.09, 0.8, 0, 1.06, 0.3, bodyMat);             // tiny roof
    box(1.85, 0.34, 1.35, 0, 0.6, -1.15, bodyMat, 0, true); // flat rear deck
    // louvered engine cover
    for (let k = 0; k < 5; k++) box(1.35, 0.04, 0.1, 0, 0.79, -0.72 - k * 0.2, darkMat);
    for (const sx of [-1, 1]) {
      box(0.14, 0.28, 0.14, sx * 0.7, 0.9, -1.6, bodyMat);  // wing struts
      box(0.3, 0.18, 0.7, sx * 0.86, 0.55, 0.2, darkMat);   // side intakes
      box(0.5, 0.05, 0.32, sx * 0.55, 0.68, 1.62, headMat); // flush lamp covers
    }
    box(2.05, 0.06, 0.55, 0, 1.08, -1.68, accentMat);       // the big flat wing
    box(0.06, 0.16, 0.58, -1.02, 1.1, -1.68, darkMat);      // wing endplates
    box(0.06, 0.16, 0.58, 1.02, 1.1, -1.68, darkMat);
    box(0.22, 0.05, 1.6, 0, 0.68, 1.0, accentMat);          // nose stripe
    mirrors(0.98, 0.94, 0.55);
    box(1.5, 0.12, 0.07, 0, 0.52, -1.86, brakeMat);         // light bar
  }

  // ---- shared: skirts, underbody, wheels, glow, beams, lamps ----
  for (const side of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 3.1), accentMat);
    skirt.position.set(side * 0.98, model === 'wedge' ? 0.26 : 0.34, 0);
    body.add(skirt);
  }

  // Fender flares: width bumps over each wheel — depth cue from any angle.
  const flareMat = new THREE.MeshLambertMaterial({ color: bodyCol.clone().multiplyScalar(1.35) });
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const flare = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.4, 1.35), flareMat);
    flare.position.set(sx * 1.0, model === 'wedge' ? 0.44 : 0.55, sz * 1.28);
    body.add(flare);
  }

  // Underbody — the star of a rollover: floor pan, axles, exhaust, belly neon.
  const pan = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.1, 3.5), new THREE.MeshLambertMaterial({ color: 0x222a3c }));
  pan.position.y = 0.2;
  body.add(pan);
  const axleGeo = new THREE.CylinderGeometry(0.11, 0.11, 2.0, 8);
  const axleMat = new THREE.MeshLambertMaterial({ color: 0x445071 });
  for (const z of [1.28, -1.28]) {
    const axle = new THREE.Mesh(axleGeo, axleMat);
    axle.rotation.z = Math.PI / 2;
    axle.position.set(0, 0.44, z);
    body.add(axle);
  }
  const exhaust = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.16, 0.5), axleMat);
  exhaust.position.set(0.45, 0.3, -1.8);
  body.add(exhaust);
  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 2.8), accentMat);
  belly.position.y = 0.13;
  body.add(belly);

  // Cylindrical wheels — read as wheels from any orientation.
  const wheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.5, 14);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x0a0b10 });
  const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.52, 10);
  const hubMat = new THREE.MeshLambertMaterial({ color: 0x59647e });
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    for (const [geo, mat] of [[wheelGeo, wheelMat], [hubGeo, hubMat]]) {
      const w = new THREE.Mesh(geo, mat);
      w.rotation.z = Math.PI / 2;
      w.position.set(sx * 0.92, 0.46, sz * 1.28);
      body.add(w);
    }
  }

  // X-ray ghost: a crisp car-colored outline drawn ONLY where the car is
  // hidden behind geometry (under a bridge deck) — inverted depth test shows
  // exactly the occluded fragments and nothing else.
  const xrayMat = new THREE.LineBasicMaterial({
    color: c, transparent: true, opacity: 0.9, depthWrite: false, depthFunc: THREE.GreaterDepth,
  });
  const xrayGhosts = [];
  for (const [w, h, dpt, y, z] of [[2.0, 1.15, 4.15, 0.62, 0], [1.5, 0.55, 1.7, 1.12, -0.25]]) {
    const ghost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, dpt)), xrayMat);
    ghost.position.set(0, y, z);
    ghost.renderOrder = 10; // after the road, so the depth buffer is settled
    ghost.visible = false;  // only enabled while the game says 'under a deck'
    body.add(ghost);
    xrayGhosts.push(ghost);
  }

  const groundFxMats = [];
  const groundFx = new THREE.Group();
  group.add(groundFx);

  // Underglow — soft car-shaped pool in the car color
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 6.0),
    new THREE.MeshBasicMaterial({
      map: carShapeTexture(), color: c, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.06;
  groundFx.add(glow);
  groundFxMats.push([glow.material, 0.55]);

  // Headlights on the road: ONE two-lobe beam RIBBON (lobes merge with
  // distance like real low beams). A single non-stacking layer so the near
  // field can't blow out — and a segmented ribbon whose row heights the game
  // updates from groundAt() every frame, so the light hugs crests and dips
  // instead of a flat plane knifing through them.
  // Short and tight (top-down-racer style): a long throw reads as a fog
  // sheet from the tilted camera, so keep the cone punchy and brief.
  const BEAM_ROWS = 8, BEAM_W = 7, BEAM_Z0 = 1.7, BEAM_Z1 = 10.5;
  {
    const pos = [], uv = [], col = [], idx = [];
    for (let r = 0; r <= BEAM_ROWS; r++) {
      const z = BEAM_Z0 + (BEAM_Z1 - BEAM_Z0) * (r / BEAM_ROWS);
      pos.push(-BEAM_W / 2, 0.09, z, BEAM_W / 2, 0.09, z);
      uv.push(0, 1 - r / BEAM_ROWS, 1, 1 - r / BEAM_ROWS);
      col.push(1, 1, 1, 1, 1, 1, 1, 1); // per-row alpha: crest line-of-sight fade
      if (r < BEAM_ROWS) {
        const a = r * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    geo.setIndex(idx);
    const beam = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: beamTexture(), transparent: true, opacity: 0.42, side: THREE.DoubleSide,
      vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    beam.frustumCulled = false; // vertices move every frame
    group.add(beam); // NOT groundFx: the ribbon self-conforms, no tilt wanted
    groundFxMats.push([beam.material, 0.42]);
    var beamRig = { mesh: beam, rows: BEAM_ROWS, z0: BEAM_Z0, z1: BEAM_Z1 };
  }
  // Lamp flares: two additive sprites at the lamps — the thing that actually
  // reads as "headlights ON" from the top-down camera.
  for (const side of [-1, 1]) {
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: 0xffe9b8, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    flare.scale.set(1.7, 1.7, 1);
    flare.position.set(side * 0.62, 0.72, 1.92);
    body.add(flare); // on the body: follows pitch/tumble with the lamps
  }

  // small warm spill right at the bumper, clear of the body
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 4.2),
    new THREE.MeshBasicMaterial({
      map: glowTexture(), color: 0xfff0c4, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, 0.04, 3.6);
  groundFx.add(pool);
  groundFxMats.push([pool.material, 0.22]);

  return {
    group,
    body,
    groundFx,
    beam: beamRig,
    setBrake(on) { brakeMat.color.setHex(on ? 0xff2020 : 0x550a0a); },
    // outline shown only under bridges — unclipped GreaterDepth leaks lines
    setXray(on) { for (const g of xrayGhosts) g.visible = on; },
    // vis 0..1: ground light effects fade as the body rolls off its wheels.
    setGroundFx(vis) {
      for (const [mat, base] of groundFxMats) mat.opacity = base * vis;
    },
    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    },
  };
}

// Soft rounded-rectangle in the car's footprint proportions, feathered —
// shared by the underglow (tinted neon) and the drop shadow (tinted black).
export function carShapeTexture() {
  const w = 128, h = 208;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.filter = 'blur(12px)';
  g.fillStyle = '#fff';
  g.beginPath();
  if (g.roundRect) g.roundRect(30, 26, w - 60, h - 52, 26);
  else g.rect(30, 26, w - 60, h - 52);
  g.fill();
  g.filter = 'none';
  return new THREE.CanvasTexture(cv);
}

function glowTexture() {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}

// Per-pixel painted headlight carpet: TWO lobes (one per lamp) that widen and
// merge with distance. Canvas top row = the car end. No hot core at the lamp
// — the near field stays translucent so the light reads as a beam on the
// road, not a white blob over the car.
function beamTexture() {
  const w = 160, h = 256;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  const img = g.createImageData(w, h);
  const px = img.data;
  const LAMP = 0.10; // lamp x offset as a fraction of plane width
  for (let y = 0; y < h; y++) {
    const d = y / (h - 1); // 0 = lamp, 1 = far end
    const halfW = (0.075 + 0.11 * d) * w;      // lobes stay narrow to the tip
    const spread = (LAMP + 0.04 * d) * w;      // slight outward toe
    // ramp in fast, fall off hard — two crisp streaks, not a fog sheet
    const axial = Math.min(1, d / 0.08) * Math.pow(1 - d, 2.0);
    for (let x = 0; x < w; x++) {
      const dx = x - w / 2;
      const t1 = (dx - spread) / halfW, t2 = (dx + spread) / halfW;
      // max, NOT sum: the gap between the lobes never fills into a sheet
      const lateral = Math.max(Math.exp(-t1 * t1 * 3.0), Math.exp(-t2 * t2 * 3.0));
      const a = Math.min(0.85, axial * lateral);
      const off = Math.min(Math.abs(dx) / (spread + halfW), 1);
      const warm = Math.min(1, off * 0.6 + d * 0.6);
      const i = (y * w + x) * 4;
      // warm white core → amber edges/far — matches the game's neon language
      // instead of washing out to grey on the bright road
      px[i] = 255;
      px[i + 1] = 238 - 52 * warm;
      px[i + 2] = 196 - 86 * warm;
      px[i + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(cv);
}
