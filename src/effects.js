import * as THREE from 'three';

// Rubber skid marks: dark worn-tire streaks on the asphalt, in a ring
// buffer of ground quads faded slowly on the GPU by age.
export class SkidTrails {
  constructor(scene, maxQuads = 6000) {
    this.max = maxQuads;
    this.cursor = 0;
    this.time = 0;

    const positions = new Float32Array(maxQuads * 4 * 3);
    const colors = new Float32Array(maxQuads * 4 * 3);
    const birth = new Float32Array(maxQuads * 4).fill(-1e9);
    const index = [];
    for (let q = 0; q < maxQuads; q++) {
      const a = q * 4;
      index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('birth', new THREE.BufferAttribute(birth, 1));
    geo.setIndex(index);

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide, // quad winding faces down — don't cull the top view
      uniforms: { uTime: { value: 0 }, uLife: { value: 40 } },
      vertexShader: `
        attribute vec3 color;
        attribute float birth;
        uniform float uTime;
        uniform float uLife;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = clamp(1.0 - (uTime - birth) / uLife, 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.001) discard;
          // vColor.r carries mark strength; the rubber itself is near-black.
          float a = vAlpha * (0.45 + vColor.r * 0.5);
          gl_FragColor = vec4(vec3(0.018, 0.020, 0.026), a);
        }`,
    });

    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5; // above other ground-level transparents
    scene.add(this.mesh);
  }

  update(dt) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
  }

  // A connected ribbon segment from (x0,z0) to (x1,z1) — consecutive
  // segments share endpoints, so trails are smooth bands along the actual
  // travel direction instead of heading-aligned confetti.
  addSegment(x0, z0, y0, x1, z1, y1, strength) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) return;
    const q = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const geo = this.mesh.geometry;
    const pos = geo.attributes.position;
    const col = geo.attributes.color;
    const birth = geo.attributes.birth;

    const nx = -dz / len, nz = dx / len; // perpendicular
    const hw = 0.3;
    // Each end sits at ITS ground height — on slopes the ribbon follows the
    // road instead of slicing through it as a horizontal plane.
    const corners = [
      [x0 - nx * hw, y0 + 0.05, z0 - nz * hw],
      [x0 + nx * hw, y0 + 0.05, z0 + nz * hw],
      [x1 - nx * hw, y1 + 0.05, z1 - nz * hw],
      [x1 + nx * hw, y1 + 0.05, z1 + nz * hw],
    ];
    // Rubber is rubber — color hue is ignored, only strength matters.
    for (let i = 0; i < 4; i++) {
      pos.setXYZ(q * 4 + i, corners[i][0], corners[i][1], corners[i][2]);
      col.setXYZ(q * 4 + i, strength, strength, strength);
      birth.setX(q * 4 + i, this.time);
    }
    // Partial uploads: only this quad's slice goes to the GPU, not the
    // whole multi-megabyte buffer every frame.
    pos.addUpdateRange?.(q * 12, 12);
    col.addUpdateRange?.(q * 12, 12);
    birth.addUpdateRange?.(q * 4, 4);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    birth.needsUpdate = true;
  }
}

// Simple point-sprite pool: drift smoke and wall-impact sparks.
export class Particles {
  constructor(scene, max = 400) {
    this.max = max;
    this.cursor = 0;
    this.time = 0;

    const positions = new Float32Array(max * 3);
    const data = new Float32Array(max * 4); // birth, life, size, seed
    const colors = new Float32Array(max * 3);
    const velocities = new Float32Array(max * 3);
    this.velocities = velocities;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('pdata', new THREE.BufferAttribute(data, 4));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    data.fill(0);
    for (let i = 0; i < max; i++) data[i * 4] = -1e9;

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute vec4 pdata; // birth, life, size, seed
        attribute vec3 color;
        uniform float uTime;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          float age = uTime - pdata.x;
          float t = clamp(age / pdata.y, 0.0, 1.0);
          vAlpha = (1.0 - t) * 0.5;
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = min(pdata.z * (0.6 + t * 1.8) * (220.0 / -mv.z), 72.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          if (vAlpha <= 0.002) discard;
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float m = smoothstep(1.0, 0.2, d);
          gl_FragColor = vec4(vColor, vAlpha * m);
        }`,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  update(dt) {
    this.time += dt;
    this.mat.uniforms.uTime.value = this.time;
    // Drift particles with their stored velocity (cheap CPU pass).
    const pos = this.points.geometry.attributes.position;
    const data = this.points.geometry.attributes.pdata;
    for (let i = 0; i < this.max; i++) {
      if (this.time - data.getX(i) > data.getY(i)) continue;
      pos.setXYZ(
        i,
        pos.getX(i) + this.velocities[i * 3] * dt,
        pos.getY(i) + this.velocities[i * 3 + 1] * dt,
        pos.getZ(i) + this.velocities[i * 3 + 2] * dt,
      );
    }
    pos.needsUpdate = true;
  }

  spawn(x, y, z, vx, vy, vz, life, size, color) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const geo = this.points.geometry;
    geo.attributes.position.setXYZ(i, x, y, z);
    geo.attributes.pdata.setXYZW(i, this.time, life, size, Math.random());
    const c = new THREE.Color(color);
    geo.attributes.color.setXYZ(i, c.r, c.g, c.b);
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.pdata.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
}
