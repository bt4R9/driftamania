import * as THREE from 'three';

export const CAR_COLORS = [0x22e6ff, 0xff2d9a, 0xb6ff3d, 0xffb14d, 0xa85cff, 0xff4d4d, 0x4dff9e, 0xfff64d];
export const CAR_MODELS = ['skyline', 'carrera', 'muscle', 'wedge'];

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

  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2a3346 });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x151a26 });
  const accentMat = new THREE.MeshBasicMaterial({ color: c });
  const glassMat = new THREE.MeshLambertMaterial({ color: 0x12202f });
  const headMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
  const brakeMat = new THREE.MeshBasicMaterial({ color: 0x550a0a });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x6b7794, transparent: true, opacity: 0.55 });

  // edge=true draws a cel-style outline — the main thing that makes stacked
  // boxes read as a 3D body from straight above.
  const box = (w, h, d, x, y, z, mat, rx = 0, edge = false) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    if (rx) m.rotation.x = rx;
    body.add(m);
    if (edge) {
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), edgeMat);
      l.position.copy(m.position);
      l.rotation.copy(m.rotation);
      body.add(l);
    }
    return m;
  };

  // ---- body kits: the recognizable part ----
  if (model === 'skyline') {
    // Boxy JDM coupe: squared lines, strut-mounted wing, quad round tails.
    box(1.92, 0.6, 3.85, 0, 0.58, 0, bodyMat, 0, true);
    box(1.75, 0.34, 0.85, 0, 0.46, 1.95, bodyMat);          // bumper
    box(1.5, 0.5, 1.8, 0, 1.06, -0.3, glassMat, 0, true);            // cabin
    box(1.42, 0.12, 1.55, 0, 1.36, -0.3, bodyMat, 0, true);          // roof
    box(0.26, 0.06, 3.6, 0, 0.9, 0.1, accentMat);           // center stripe
    box(1.3, 0.1, 0.5, 0, 0.94, 1.4, bodyMat);              // hood bulge
    // the wing
    box(0.12, 0.34, 0.14, -0.6, 1.06, -1.78, bodyMat);
    box(0.12, 0.34, 0.14, 0.6, 1.06, -1.78, bodyMat);
    box(1.9, 0.07, 0.5, 0, 1.26, -1.85, accentMat);
    // quad round taillights
    for (const sx of [-1, 1]) {
      for (const off of [0.34, 0.64]) {
        const tl = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 10), brakeMat);
        tl.rotation.x = Math.PI / 2;
        tl.position.set(sx * off, 0.64, -1.94);
        body.add(tl);
      }
    }
  } else if (model === 'carrera') {
    // Rear-engine fastback: round lamps on the fenders, wide hips, ducktail.
    box(1.8, 0.55, 3.75, 0, 0.52, 0.05, bodyMat, 0, true);
    box(0.28, 0.5, 1.6, -0.88, 0.55, -0.95, bodyMat);       // hips
    box(0.28, 0.5, 1.6, 0.88, 0.55, -0.95, bodyMat);
    box(1.42, 0.5, 1.55, 0, 1.0, 0.25, glassMat, 0, true);           // cabin
    box(1.28, 0.1, 0.95, 0, 1.27, 0.3, bodyMat, 0, true);            // roof
    box(1.45, 0.09, 1.5, 0, 0.99, -0.85, glassMat, -0.28);  // fastback slope
    box(1.3, 0.06, 0.32, 0, 0.88, -1.82, accentMat);        // ducktail
    box(0.24, 0.05, 2.6, 0, 0.86, 0.5, accentMat);          // stripe
    // round headlights standing on the fenders
    for (const sx of [-1, 1]) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.2, 10), headMat);
      lamp.position.set(sx * 0.66, 0.78, 1.72);
      body.add(lamp);
    }
    box(1.5, 0.12, 0.07, 0, 0.62, -1.9, brakeMat);          // light bar
  } else if (model === 'muscle') {
    // Long hood, cabin set far back, fastback to a kamm tail, hood stripes.
    box(2.0, 0.62, 4.0, 0, 0.58, 0, bodyMat, 0, true);
    box(1.5, 0.5, 1.45, 0, 1.06, -0.8, glassMat, 0, true);           // cabin (rear)
    box(1.42, 0.11, 1.1, 0, 1.36, -0.85, bodyMat, 0, true);          // roof
    box(1.46, 0.09, 1.15, 0, 1.05, -1.62, glassMat, -0.32); // fastback
    box(1.55, 0.26, 0.1, 0, 0.5, 2.0, darkMat);             // grille
    for (const sx of [-1, 1]) {
      box(0.22, 0.05, 2.0, sx * 0.32, 0.92, 0.95, accentMat); // twin hood stripes
    }
    box(1.7, 0.14, 0.07, 0, 0.66, -1.99, brakeMat);         // full-width tail bar
    box(1.9, 0.1, 0.35, 0, 0.92, -1.85, bodyMat);           // tail lip
  } else {
    // 'wedge': low doorstop supercar — pointy nose, cab forward, huge wing.
    box(1.9, 0.42, 3.9, 0, 0.42, 0, bodyMat, 0, true);
    box(1.8, 0.1, 1.9, 0, 0.62, 1.15, bodyMat, -0.1);       // wedge nose plate
    box(1.35, 0.42, 1.35, 0, 0.83, 0.3, glassMat);          // cab forward
    box(1.2, 0.09, 0.8, 0, 1.06, 0.3, bodyMat);             // tiny roof
    box(1.85, 0.34, 1.35, 0, 0.6, -1.15, bodyMat, 0, true);          // flat rear deck
    for (const sx of [-1, 1]) {
      box(0.14, 0.28, 0.14, sx * 0.7, 0.9, -1.6, bodyMat);  // wing struts
      box(0.3, 0.18, 0.7, sx * 0.86, 0.55, 0.2, darkMat);   // side intakes
    }
    box(2.05, 0.06, 0.55, 0, 1.08, -1.68, accentMat);       // the big flat wing
    box(0.22, 0.05, 1.6, 0, 0.68, 1.0, accentMat);          // nose stripe
    box(1.5, 0.12, 0.07, 0, 0.52, -1.86, brakeMat);         // light bar
  }

  // ---- shared: skirts, underbody, wheels, glow, beams, lamps ----
  for (const side of [-1, 1]) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 3.1), accentMat);
    skirt.position.set(side * 0.98, model === 'wedge' ? 0.26 : 0.34, 0);
    body.add(skirt);
  }

  // Fender flares: width bumps over each wheel — depth cue from any angle.
  const flareMat = new THREE.MeshLambertMaterial({ color: 0x39445c });
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

  // Twin headlight beams projected on the ground + a pool at the bumper.
  const beamTex = beamTexture();
  for (const side of [-1, 1]) {
    const beam = new THREE.Mesh(
      new THREE.PlaneGeometry(6, 15),
      new THREE.MeshBasicMaterial({
        map: beamTex, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    beam.rotation.x = -Math.PI / 2;
    beam.rotation.z = -side * 0.05; // slight outward toe
    beam.position.set(side * 0.62, 0.05, 9.0);
    groundFx.add(beam);
    groundFxMats.push([beam.material, 0.55]);
  }
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 7),
    new THREE.MeshBasicMaterial({
      map: glowTexture(), color: 0xfff0c4, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, 0.04, 4.2);
  groundFx.add(pool);
  groundFxMats.push([pool.material, 0.5]);

  // Front lamp dots (carrera already has its round fender lamps)
  if (model !== 'carrera') {
    for (const side of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.1), headMat);
      h.position.set(side * 0.62, 0.6, 1.96);
      body.add(h);
    }
  }
  // Brake boxes for kits without a dedicated tail bar
  if (model === 'skyline') {
    // quad tails already use brakeMat
  } else if (model === 'muscle' || model === 'carrera' || model === 'wedge') {
    // light bars above already use brakeMat
  }

  return {
    group,
    body,
    groundFx,
    setBrake(on) { brakeMat.color.setHex(on ? 0xff2020 : 0x550a0a); },
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

// Per-pixel painted headlight beam. Canvas top row = the car end (narrow,
// hot); it widens and cools toward the far end, with Gaussian side falloff.
function beamTexture() {
  const w = 128, h = 256;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  const img = g.createImageData(w, h);
  const px = img.data;
  for (let y = 0; y < h; y++) {
    const d = y / (h - 1); // 0 = lamp, 1 = far end
    const halfW = (0.10 + 0.36 * d) * w;
    const axial = Math.pow(1 - d, 1.6)
      + 0.6 * Math.exp(-(d * d) / (0.06 * 0.06));
    for (let x = 0; x < w; x++) {
      const t = (x - w / 2) / halfW;
      const lateral = Math.exp(-t * t * 2.4);
      const a = Math.min(1, axial * lateral);
      const cool = Math.min(1, Math.abs(t) * 0.7 + d * 0.6);
      const i = (y * w + x) * 4;
      px[i] = 255 - 70 * cool;
      px[i + 1] = 243 - 45 * cool;
      px[i + 2] = 205 + 50 * cool;
      px[i + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(cv);
}
