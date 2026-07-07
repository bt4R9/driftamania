import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { Track, mulberry32 } from './track.js';
import { trackById } from './tracks.js';
import { stepCar, collideCars, makeCarState, wrapAngle, clamp } from './physics.js';
import { buildCarMesh, carShapeTexture } from './carmesh.js';
import { SkidTrails, Particles } from './effects.js';
import { AiDriver } from './ai.js';
import { readControls } from './input.js';
import { AudioEngine } from './audio.js';

export const LAPS = 3;
const SEND_INTERVAL = 0.05; // 20 Hz state broadcast

const DRIFT_GRACE = 0.4;    // s to chain drifts after a slide ends
const LAP_BONUS = 300;      // score for each completed lap
// Finish-position bonus: racing well IS score — P1 earns far more, so the
// winner is decided by total score (position + style combined).
const FINISH_BONUS = [4000, 2800, 2000, 1500, 1200, 1000, 850, 700];
const CRASH_HIT = 6;        // wall-impact speed that counts as a crash
const JUMP_MIN_DIST = 8;    // shorter hops score nothing

// Boost pickups: spawned on a deterministic schedule from the race seed
// (identical for every peer), fixed lifetime so clients can't drift apart.
// Disabled for now (felt odd) — flip the flag to bring them back.
const PICKUPS_ENABLED = false;
const PICKUP_KICK = 16;
const PICKUP_RADIUS = 3.8;
const PICKUP_LIFE = 18;

export class Game {
  // callbacks: { onHud(data), onLocalFinish(entry), onEntryFinish(entry), onLap() }
  constructor(container, callbacks) {
    this.cb = callbacks;
    this.net = null; // attached by main.js in multiplayer

    this.renderer = new THREE.WebGLRenderer({ antialias: false }); // composer never samples the MSAA buffer — pure waste
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); // DPR 2 + full-res bloom murders iGPUs
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x05060a, 180, 420);
    this.scene.background = new THREE.Color(0x05060a);
    this.camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 1, 800);

    this.scene.add(new THREE.AmbientLight(0x8899cc, 0.42));
    const key = new THREE.DirectionalLight(0xcdd8ff, 1.15);
    key.position.set(70, 75, 35); // angled: side faces get a real gradient
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xff5c9e, 0.4);
    rim.position.set(-60, 30, -55); // low magenta rim from behind-left
    this.scene.add(rim);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.9, 0.5, 0.55)); // half-res bloom
    this.composer.addPass(new OutputPass());

    this.skids = new SkidTrails(this.scene);
    this.particles = new Particles(this.scene);
    this.audio = new AudioEngine();

    this.track = null;
    this.trackGroup = null;

    // Cars
    this.local = null;             // { state, mesh, entry, ... }
    this.ais = [];                 // { state, mesh, driver, entry, ... }
    this.remotes = new Map();      // peerId -> { render, target, mesh, entry, targetAt }

    // Race state
    this.phase = 'idle';           // idle | countdown | racing
    this.countdown = 0;
    this.raceClock = 0;
    this.grid = [];
    this.camAngle = 0;
    this.camHeight = 70;
    this.camY = 0;
    this.camTilt = 0;
    this.shake = 0;
    this.idleAngle = 0;
    this.sendAcc = 0;
    this.wrongWayAcc = 0;
    this.resetCooldown = 0;

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      this.composer.setSize(innerWidth, innerHeight);
    });

    this.timer = new THREE.Timer();

    // Diagnostics overlay: open the game with ?perf=1 to watch fps, frame
    // time, JS heap and GPU object counts live.
    if (new URLSearchParams(location.search).has('perf')) {
      this.perfEl = document.createElement('div');
      this.perfEl.style.cssText = 'position:fixed;left:10px;top:120px;z-index:99;font:11px monospace;'
        + 'color:#b6ff3d;background:rgba(0,0,0,.6);padding:6px 8px;border-radius:6px;white-space:pre';
      document.body.appendChild(this.perfEl);
      this.perfAcc = { t: 0, frames: 0, worst: 0 };
    }

    this.renderer.setAnimationLoop(() => this.frame());
  }

  // Accepts a built-in track id OR a full custom track definition object.
  loadTrack(trackOrDef, seed = 1) {
    const isId = typeof trackOrDef === 'string';
    const def = isId ? trackById(trackOrDef) : trackOrDef;
    const key = `${isId ? trackOrDef : 'custom:' + (def.name ?? '?') + ':' + JSON.stringify(def.points).length}:${seed}`;
    if (this.trackKey === key) return;
    this.trackKey = key;
    if (this.trackGroup) {
      this.scene.remove(this.trackGroup);
      // Dispose GPU resources — without this every race/rematch leaks the
      // whole previous track (ground mesh alone is ~540k verts).
      this.trackGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m) continue;
          if (m.map) m.map.dispose();
          if (m.uniforms?.tMask?.value) m.uniforms.tMask.value.dispose();
          m.dispose();
        }
      });
    }
    this.track = new Track(def, seed);
    this.trackGroup = this.track.group;
    this.scene.add(this.trackGroup);
  }

  clearCars() {
    for (const c of [this.local, ...this.ais, ...this.remotes.values()]) {
      if (c?.mesh) { this.scene.remove(c.mesh.group); c.mesh.dispose(); }
      if (c?.shadow) {
        this.scene.remove(c.shadow);
        c.shadow.geometry.dispose();
        c.shadow.material.dispose();
      }
      c?.voice?.dispose();
    }
    this.local = null;
    this.ais = [];
    this.remotes.clear();
  }

  // grid: [{ key: 'self' | 'ai:i' | peerId, name, color, skill? }]
  startRace(trackOrDef, grid, seed = 1) {
    this.loadTrack(trackOrDef, seed);
    this.clearCars();
    this.grid = grid;

    grid.forEach((entry, slot) => {
      const pose = this.track.spawnPose(slot);
      const state = makeCarState(pose.x, pose.z, pose.heading);
      state.trackIdx = pose.index;
      state.progress = pose.progressOffset;
      state.y = pose.y;
      const mesh = buildCarMesh(entry.color, entry.model);
      this.scene.add(mesh.group);
      const car = {
        entry, state, mesh,
        lap: 0, lapStart: 0, bestLap: null, finished: false, finishTime: null,
        score: 0, chain: 0, chainTimer: 0, airStart: null, airOk: true,
      };
      if (entry.key === 'self') this.local = car;
      else if (entry.key.startsWith('ai:')) { car.driver = new AiDriver(entry.skill ?? 1); this.ais.push(car); }
      else {
        car.render = { ...state };
        car.target = null;
        this.remotes.set(entry.key, car);
      }
      this.placeMesh(car, state);
    });

    this.finishCount = 0;
    this.phase = 'countdown';
    this.countdown = 3.0;
    this.countdownEnd = performance.now() + 3000;
    this.audio.countTick(); // "3" — later ticks fire from the loop
    this.raceClock = 0;
    this.camAngle = this.local ? this.local.state.heading : 0;

    this.clearPickups();
    this.pickupRng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
    this.pickupSeq = 0;
    this.nextPickupT = 5 + this.pickupRng() * 5;
  }

  toIdle() {
    this.phase = 'idle';
    this.clearCars();
    this.clearPickups();
  }

  clearPickups() {
    if (this.pickups) {
      for (const p of this.pickups.values()) this.removePickupMesh(p);
    }
    this.pickups = new Map();
  }

  removePickupMesh(p) {
    this.scene.remove(p.mesh);
    p.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }

  updatePickups(dt) {
    if (!PICKUPS_ENABLED) return;
    // Deterministic spawns: same rng draws in the same order on every client.
    while (this.raceClock >= this.nextPickupT) {
      const r1 = this.pickupRng(), r2 = this.pickupRng(), r3 = this.pickupRng();
      this.nextPickupT += 6 + r3 * 6;
      const S = this.track.sampleCount;
      const idx = Math.floor(r1 * S) % S;
      const lat = (r2 * 2 - 1) * (this.track.halfWidthAt(idx) - 4);
      const off = this.track.sideOffset(idx, lat);
      const y = this.track.groundAt(off.x, off.z, idx);
      const mesh = buildPickupMesh();
      mesh.position.set(off.x, y + 1.4, off.z);
      this.scene.add(mesh);
      this.pickups.set(this.pickupSeq++, { x: off.x, z: off.z, y, mesh, born: this.raceClock });
    }

    for (const [id, p] of this.pickups) {
      if (this.raceClock - p.born > PICKUP_LIFE) {
        this.removePickupMesh(p);
        this.pickups.delete(id);
        continue;
      }
      p.mesh.rotation.y += 2.2 * dt;
      p.mesh.position.y = p.y + 1.4 + Math.sin(this.raceClock * 2.4 + id) * 0.35;

      for (const car of [this.local, ...this.ais]) {
        if (!car || car.finished) continue;
        const s = car.state;
        if (Math.hypot(s.x - p.x, s.z - p.z) < PICKUP_RADIUS && Math.abs(s.y - p.y) < 4) {
          const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
          s.vx += fx * PICKUP_KICK;
          s.vz += fz * PICKUP_KICK;
          if (car === this.local) {
            this.boostFlash = 1.2;
            this.audio.boost();
            this.net?.sendPickup({ id });
          }
          this.removePickupMesh(p);
          this.pickups.delete(id);
          break;
        }
      }
    }
  }

  // A peer collected this pickup — just remove it.
  remotePickup(id) {
    const p = this.pickups?.get(id);
    if (p) {
      this.removePickupMesh(p);
      this.pickups.delete(id);
    }
  }

  // ---- Per-frame ----
  frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 1 / 30);
    const t0 = this.perfEl ? performance.now() : 0;
    if (this.track) this.update(dt);
    this.composer.render();
    if (this.perfEl) {
      const ms = performance.now() - t0;
      const p = this.perfAcc;
      p.t += dt; p.frames++; p.worst = Math.max(p.worst, ms);
      if (p.t >= 0.5) {
        const mem = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + 'MB heap' : '';
        const inf = this.renderer.info;
        this.perfEl.textContent =
          `${(p.frames / p.t).toFixed(0)} fps  worst ${p.worst.toFixed(1)}ms\n`
          + `${inf.memory.geometries} geoms  ${inf.memory.textures} textures\n`
          + `${(inf.render.triangles / 1000).toFixed(0)}k tris  ${mem}`;
        p.t = 0; p.frames = 0; p.worst = 0;
      }
    }
  }

  update(dt) {
    this.skids.update(dt);
    this.particles.update(dt);
    this.waveTime = (this.waveTime ?? 0) + dt;
    this.track.tick(this.waveTime);

    if (this.phase === 'idle') {
      this.audio.update(dt, { active: false });
      this.idleAngle += dt * 0.08;
      const r = 130;
      this.camera.position.set(Math.cos(this.idleAngle) * r, 95, Math.sin(this.idleAngle) * r);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(0, 0, 0);
      return;
    }

    if (this.phase === 'countdown') {
      // Wall clock, not frame delta: background tabs get no rAF ticks, and a
      // dt-driven countdown would freeze there while everyone else races.
      const before = Math.ceil(this.countdown);
      this.countdown = (this.countdownEnd - performance.now()) / 1000;
      const after = Math.ceil(this.countdown);
      if (after !== before && after >= 1) this.audio.countTick();
      if (this.countdown <= 0) {
        this.phase = 'racing';
        this.audio.go();
      }
    } else if (this.phase === 'racing') {
      this.raceClock += dt;
    }
    const locked = this.phase === 'countdown';

    // --- Local car ---
    if (this.local) {
      const raw = readControls();
      const input = locked
        ? { throttle: 0, steer: 0, handbrake: true }
        : { throttle: raw.throttle, steer: raw.steer, handbrake: raw.handbrake };
      const prevProgress = this.local.state.progress;
      stepCar(this.local.state, input, dt, this.track);
      this.trackLaps(this.local);
      this.carEffects(this.local, input, dt);

      const s = this.local.state;
      // During countdown the car is locked but the ENGINE isn't: raw throttle
      // free-revs at the line (grounded:false = unloaded-rev behavior).
      this.audio.update(dt, {
        active: true,
        speed: Math.hypot(s.vx, s.vz),
        throttle: locked ? raw.throttle : input.throttle,
        slip: s.slip,
        drifting: s.drifting,
        grounded: locked ? false : s.grounded,
      });
      this.audio.updateListener(
        s.x, s.y + 2, s.z,
        Math.sin(this.camAngle), Math.cos(this.camAngle),
      );
      if (s.wallHit > 2) {
        this.audio.impact(s.wallHit, 'wall');
        this.shake = Math.max(this.shake, Math.min(1, s.wallHit / 22));
      }
      if (s.tumble > 0 && !this.wasTumbling) this.shake = 1;
      this.wasTumbling = s.tumble > 0;
      if (s.landed > 5) {
        this.audio.impact(s.landed * 0.8, 'land');
        this.shake = Math.max(this.shake, Math.min(0.5, s.landed / 40));
      }

      // Wrong-way detection + insistent warning beep
      const d = this.local.state.progress - prevProgress;
      this.wrongWayAcc = d < -0.01 ? this.wrongWayAcc + dt : 0;
      if (this.wrongWayAcc > 1.2) {
        this.wwBeep = (this.wwBeep ?? 0) - dt;
        if (this.wwBeep <= 0) {
          this.audio.beep(210, 0.16, 0.22, 'square');
          this.wwBeep = 0.65;
        }
      } else {
        this.wwBeep = 0;
      }

      // Manual reset onto the centerline
      this.resetCooldown -= dt;
      if (raw.reset && this.resetCooldown <= 0 && !locked) {
        this.resetCooldown = 1;
        const s = this.local.state;
        const p = this.track.points[s.trackIdx];
        const t = this.track.tangents[s.trackIdx];
        s.x = p.x; s.z = p.z;
        s.y = this.track.groundAt(p.x, p.z, s.trackIdx); s.vy = 0; s.grounded = true;
        s.heading = Math.atan2(t.x, t.z);
        s.vx = s.vz = 0;
      }
    }

    if (this.local) this.updateScore(this.local, dt);

    // --- AI cars ---
    const aiCtx = {
      others: [
        this.local?.state,
        ...this.ais.map((a) => a.state),
        ...[...this.remotes.values()].filter((r) => r.target).map((r) => r.render),
      ].filter(Boolean),
      playerProgress: this.local?.state.progress,
    };
    for (const ai of this.ais) {
      const input = locked
        ? { throttle: 0, steer: 0, handbrake: true }
        : ai.driver.control(ai.state, this.track, dt, {
          others: aiCtx.others.filter((s) => s !== ai.state),
          playerProgress: aiCtx.playerProgress,
        });
      stepCar(ai.state, input, dt, this.track);
      this.trackLaps(ai);
      this.carEffects(ai, input, dt);
      this.updateScore(ai, dt);
      if (!ai.voice) ai.voice = this.audio.carVoice();
      ai.voice?.update(ai.state.x, ai.state.y, ai.state.z, Math.hypot(ai.state.vx, ai.state.vz));
    }

    this.jumpFlash = Math.max(0, (this.jumpFlash ?? 0) - dt);
    this.lostFlash = Math.max(0, (this.lostFlash ?? 0) - dt);
    this.boostFlash = Math.max(0, (this.boostFlash ?? 0) - dt);
    if (this.phase === 'racing') this.updatePickups(dt);

    // --- Remote cars: extrapolate + smooth toward last received state ---
    const now = performance.now();
    for (const rc of this.remotes.values()) {
      if (!rc.target) continue;
      const t = rc.target;
      const age = Math.min((now - rc.targetAt) / 1000, 0.4);
      const tx = t.x + t.vx * age, tz = t.z + t.vz * age;
      const k = 1 - Math.exp(-12 * dt);
      rc.render.x += (tx - rc.render.x) * k;
      rc.render.z += (tz - rc.render.z) * k;
      const oldY = rc.render.y;
      rc.render.y += ((t.y ?? 0) - rc.render.y) * k;
      rc.render.vy = (rc.render.y - oldY) / dt; // estimated, for airborne pitch
      rc.render.heading += wrapAngle(t.h - rc.render.heading) * k;
      rc.render.rollAngle = (rc.render.rollAngle ?? 0) + ((t.rl ?? 0) - (rc.render.rollAngle ?? 0)) * k;
      rc.render.vx = t.vx; rc.render.vz = t.vz;
      if (t.dr) {
        this.driftMarks(rc, rc.render.x, rc.render.z, rc.render.heading, 0.8, rc.render.y);
      } else {
        rc.skidLast = null;
      }
      rc.mesh.setBrake(!!t.br);
      if (!rc.voice) rc.voice = this.audio.carVoice();
      rc.voice?.update(rc.render.x, rc.render.y, rc.render.z, Math.hypot(t.vx, t.vz));
    }

    // --- Contact ---
    const dynamic = [this.local, ...this.ais].filter(Boolean);
    for (let i = 0; i < dynamic.length; i++) {
      for (let j = i + 1; j < dynamic.length; j++) {
        const hit = collideCars(dynamic[i].state, dynamic[j].state, true);
        if (hit) this.carContactFx(dynamic[i].state, dynamic[j].state, hit,
          dynamic[i] === this.local || dynamic[j] === this.local);
      }
    }
    if (this.local) {
      for (const rc of this.remotes.values()) {
        if (!rc.target) continue;
        const hit = collideCars(this.local.state, rc.render, false);
        if (hit) this.carContactFx(this.local.state, rc.render, hit, true);
      }
    }

    // --- Meshes ---
    for (const c of dynamic) this.placeMesh(c, c.state);
    for (const rc of this.remotes.values()) this.placeMesh(rc, rc.render);

    // --- Network send ---
    if (this.net && this.local) {
      this.sendAcc += dt;
      if (this.sendAcc >= SEND_INTERVAL) {
        this.sendAcc = 0;
        const s = this.local.state;
        this.net.sendState({
          x: round2(s.x), z: round2(s.z), y: round2(s.y), h: round2(s.heading),
          rl: round2(s.rollAngle),
          vx: round2(s.vx), vz: round2(s.vz),
          dr: s.drifting ? 1 : 0, br: brakeOn(s, readControls()) ? 1 : 0,
          prog: Math.round(s.progress), fin: this.local.finished ? 1 : 0,
        });
      }
    }

    this.updateCamera(dt);
    this.emitHud();
    this.drawMinimap();
  }


  // Style points. Jumps: distance pays, clipping a wall mid-air voids the jump.
  // Drift: time × speed × angle accumulates into a chain; it banks after a
  // grace window (so linked corners keep one chain) and a crash wipes it.
  updateScore(car, dt) {
    if (this.phase !== 'racing' || car.finished) return;
    const s = car.state;
    const isLocal = car === this.local;
    const speed = Math.hypot(s.vx, s.vz);

    if (!s.grounded) {
      if (!car.airStart) { car.airStart = { x: s.x, z: s.z }; car.airOk = true; }
      if (s.wallHit > 2) car.airOk = false;
    } else if (car.airStart) {
      const d = Math.hypot(s.x - car.airStart.x, s.z - car.airStart.z);
      if (car.airOk && d > JUMP_MIN_DIST) {
        const pts = Math.round(d * 3);
        car.score += pts;
        if (isLocal) {
          this.jumpFlash = 1.6;
          this.jumpPts = pts;
          this.audio.beep(990, 0.12, 0.14, 'triangle');
        }
      }
      car.airStart = null;
    }

    if (s.drifting) {
      car.chain += dt * speed * (0.4 + clamp(Math.abs(s.slip) / 12, 0, 1) * 0.8) * 1.5;
      car.chainTimer = DRIFT_GRACE;
    } else if (car.chainTimer > 0) {
      car.chainTimer -= dt;
      if (car.chainTimer <= 0 && car.chain > 0) {
        car.score += Math.round(car.chain);
        car.chain = 0;
        if (isLocal) this.audio.beep(740, 0.09, 0.12, 'sine');
      }
    }

    if ((s.wallHit > CRASH_HIT || s.tumble > 0) && car.chain > 0) {
      car.chain = 0;
      car.chainTimer = 0;
      if (isLocal) {
        this.lostFlash = 1.5;
        this.audio.beep(130, 0.3, 0.22, 'sawtooth');
      }
    }
  }

  trackLaps(car) {
    if (car.finished) return;
    const lapNow = Math.floor(car.state.progress / this.track.sampleCount);
    if (lapNow > car.lap) {
      car.lap = lapNow;
      const lapTime = this.raceClock - car.lapStart;
      car.lapStart = this.raceClock;
      if (car.lap > 0 && (car.bestLap === null || lapTime < car.bestLap)) car.bestLap = lapTime;
      car.score += LAP_BONUS; // completing a lap pays
      if (car === this.local) {
        this.cb.onLap?.(car.lap, lapTime);
        if (car.lap < LAPS) this.audio.lap();
        else this.audio.finish();
      }
      if (car.lap >= LAPS) {
        car.finished = true;
        car.finishTime = this.raceClock;
        car.score += Math.round(car.chain); // bank any live chain at the line
        car.chain = 0;
        // position bonus: order across local, AI and remote finishers
        this.finishCount = (this.finishCount ?? 0) + 1;
        car.score += FINISH_BONUS[Math.min(this.finishCount - 1, FINISH_BONUS.length - 1)];
        const entry = {
          key: car.entry.key, name: car.entry.name, color: car.entry.color,
          time: car.finishTime, bestLap: car.bestLap, score: Math.round(car.score),
        };
        if (car === this.local) this.cb.onLocalFinish?.(entry);
        else this.cb.onEntryFinish?.(entry);
      }
    }
  }

  carEffects(car, input, dt) {
    const s = car.state;
    car.mesh.setBrake(brakeOn(s, input));
    if (s.drifting) {
      this.driftMarks(car, s.x, s.z, s.heading, clamp(Math.abs(s.slip) / 14, 0.4, 1), s.y);
      if (Math.random() < dt * 40) {
        const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
        this.particles.spawn(
          s.x - fx * 1.4, s.y + 0.5, s.z - fz * 1.4,
          -s.vx * 0.12 + (Math.random() - 0.5) * 3, 2.5, -s.vz * 0.12 + (Math.random() - 0.5) * 3,
          0.9, 26, 0x8899aa,
        );
      }
    } else {
      car.skidLast = null;
    }
    if (s.wallHit > 5) {
      for (let i = 0; i < 6; i++) {
        this.particles.spawn(
          s.x, s.y + 0.7, s.z,
          (Math.random() - 0.5) * 14, Math.random() * 6, (Math.random() - 0.5) * 14,
          0.45, 10, 0xffc266,
        );
      }
    }
    if (s.landed > 4) car.squash = 1;
    if (s.wallHit > 8) car.squash = Math.max(car.squash ?? 0, 0.55); // body jolt
    if (s.landed > 5) {
      for (let i = 0; i < 8; i++) {
        this.particles.spawn(
          s.x + (Math.random() - 0.5) * 2, s.y + 0.2, s.z + (Math.random() - 0.5) * 2,
          (Math.random() - 0.5) * 10, 1 + Math.random() * 3, (Math.random() - 0.5) * 10,
          0.6, 18, 0x8899aa,
        );
      }
    }
  }

  // Sparks + sound + shake where two cars trade paint.
  carContactFx(a, b, hit, involvesLocal) {
    if (hit < 2) return;
    const mx = (a.x + b.x) / 2, my = ((a.y ?? 0) + (b.y ?? 0)) / 2, mz = (a.z + b.z) / 2;
    const n = Math.min(Math.round(hit), 10);
    for (let i = 0; i < n; i++) {
      this.particles.spawn(
        mx, my + 0.8, mz,
        (Math.random() - 0.5) * 16, 1 + Math.random() * 5, (Math.random() - 0.5) * 16,
        0.4, 9, Math.random() < 0.5 ? 0xffc266 : 0xdfe8ff,
      );
    }
    if (involvesLocal) {
      this.audio.impact(hit * 1.6, 'car');
      this.shake = Math.max(this.shake, Math.min(0.8, hit / 18));
    }
  }

  // Continuous per-wheel rubber ribbons: each rear wheel remembers its last
  // mark point (car.skidLast) and connects a segment to the current one.
  driftMarks(car, x, z, heading, strength, y = 0) {
    const fx = Math.sin(heading), fz = Math.cos(heading);
    const rx = fz, rz = -fx;
    const now = [];
    for (const side of [-1, 1]) {
      now.push([x + rx * 0.88 * side - fx * 1.28, z + rz * 0.88 * side - fz * 1.28, y]);
    }
    if (car.skidLast) {
      for (let i = 0; i < 2; i++) {
        const [px, pz, py] = car.skidLast[i];
        const [cx, cz, cy] = now[i];
        if (Math.hypot(cx - px, cz - pz) < 4) { // gap = new stroke (teleport etc.)
          this.skids.addSegment(px, pz, py, cx, cz, cy, strength);
        }
      }
    }
    car.skidLast = now;
  }

  placeMesh(car, s) {
    const g = car.mesh.group;
    const b = car.mesh.body;
    g.position.set(s.x, s.y ?? 0, s.z);
    g.rotation.y = s.heading;

    // Airborne attitude on the BODY — ground light effects stay flat.
    const groundHere = this.track.groundAt(s.x, s.z, s.trackIdx ?? 0);
    const airborne = s.grounded === undefined ? (s.y ?? 0) - groundHere > 0.4 : !s.grounded;
    const targetPitch = airborne ? clamp(-(s.vy ?? 0) * 0.022, -0.3, 0.38) : 0;
    const targetRoll = airborne ? (s.steer ?? 0) * 0.18 : 0;
    car.pitch = (car.pitch ?? 0) + (targetPitch - (car.pitch ?? 0)) * 0.15;
    car.roll = (car.roll ?? 0) + (targetRoll - (car.roll ?? 0)) * 0.15;
    b.rotation.x = car.pitch;
    const bodyRoll = s.rollAngle ?? 0; // tumble rollover + settle-back
    b.rotation.z = car.roll + bodyRoll;
    // Lift so the rolled body rests ON the road: |sin| covers the side,
    // (1-cos) covers inversion (roof height).
    b.position.y = bodyRoll
      ? Math.max(Math.abs(Math.sin(bodyRoll)) * 0.95, (1 - Math.cos(bodyRoll)) * 0.78)
      : 0;
    car.mesh.setGroundFx(clamp(Math.cos(bodyRoll), 0, 1));

    // Tilt ground-projected lights to the local grade.
    const fwdX = Math.sin(s.heading), fwdZ = Math.cos(s.heading);
    const hAhead = this.track.groundAt(s.x + fwdX * 8, s.z + fwdZ * 8, s.trackIdx ?? 0);
    car.mesh.groundFx.rotation.x = -Math.atan2(hAhead - groundHere, 8);

    // Landing squash: set by carEffects, decays here.
    car.squash = Math.max(0, (car.squash ?? 0) - 0.07);
    b.scale.set(1 + car.squash * 0.12, 1 - car.squash * 0.3, 1 + car.squash * 0.08);

    // Car-shaped shadow pinned to the road surface below — the height cue.
    if (!car.shadow) {
      const geo = new THREE.PlaneGeometry(3.1, 5.2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x000000, map: carShapeTexture(),
        transparent: true, opacity: 0.4, depthWrite: false,
      });
      car.shadow = new THREE.Mesh(geo, mat);
      car.shadow.rotation.x = -Math.PI / 2;
      this.scene.add(car.shadow);
    }
    car.shadow.rotation.z = s.heading; // long axis follows the car
    const alt = Math.max(0, (s.y ?? 0) - groundHere);
    car.shadow.position.set(s.x, groundHere + 0.07, s.z);
    car.shadow.scale.setScalar(Math.max(0.45, 1 - alt * 0.03));
    car.shadow.material.opacity = 0.4 * Math.max(0.25, 1 - alt * 0.05);
  }

  updateCamera(dt) {
    const focus = this.local ?? this.ais[0];
    if (!focus) return;
    const s = this.local ? this.local.state : this.ais[0].state;
    const speed = Math.hypot(s.vx, s.vz);

    // Rotating top-down: camera "up" tracks the car heading — but NOT while
    // the car is tumbling/wrecked (chasing a spinning heading whips the whole
    // world around; hold rotation and let the car pirouette on screen).
    const headRate = (s.tumble > 0 || s.wrecked > 0) ? 0 : 3.2;
    this.camAngle += wrapAngle(s.heading - this.camAngle) * Math.min(1, headRate * dt);
    const targetH = 52 + speed * 0.9;
    this.camHeight += (targetH - this.camHeight) * Math.min(1, 2 * dt);
    this.camY += ((s.y ?? 0) - this.camY) * Math.min(1, 4 * dt); // soft vertical follow

    // Speed tilt: ~45° off vertical at top speed for forward visibility.
    const tiltTarget = 0.785 * clamp(speed / 85, 0, 1);
    this.camTilt += (tiltTarget - this.camTilt) * Math.min(1, 2 * dt);

    // Look-ahead uses SMOOTHED velocity: raw velocity changes in a single
    // frame during a crash impulse, which used to teleport the aim point
    // (and the camera with it) — the visible "twitch" on every contact.
    const lk = Math.min(1, 4 * dt);
    this.lookVx = (this.lookVx ?? s.vx) + (s.vx - (this.lookVx ?? s.vx)) * lk;
    this.lookVz = (this.lookVz ?? s.vz) + (s.vz - (this.lookVz ?? s.vz)) * lk;
    const lookX = s.x + this.lookVx * 0.45;
    const lookZ = s.z + this.lookVz * 0.45;
    const bx = Math.sin(this.camAngle), bz = Math.cos(this.camAngle);
    const back = Math.sin(this.camTilt) * this.camHeight;
    this.camera.position.set(
      lookX - bx * back,
      this.camY + Math.cos(this.camTilt) * this.camHeight,
      lookZ - bz * back,
    );
    // Impact shake: decaying random jitter on the camera.
    this.shake = Math.max(0, this.shake - this.shake * 5 * dt - 0.3 * dt);
    if (this.shake > 0.01) {
      const a = this.shake * 4.5;
      this.camera.position.x += (Math.random() - 0.5) * a;
      this.camera.position.z += (Math.random() - 0.5) * a;
      this.camera.position.y += (Math.random() - 0.5) * a * 0.5;
    }
    this.camera.up.set(bx, 0, bz);
    this.camera.lookAt(lookX, this.camY, lookZ);
  }

  // Full-track minimap: static north-up view of the whole circuit (drawn
  // once per track into a cached layer), live car positions on top.
  buildMinimapBase() {
    const cv = document.createElement('canvas');
    cv.width = this.minimap.width;
    cv.height = this.minimap.height;
    const ctx = cv.getContext('2d');
    const track = this.track;
    const S = track.sampleCount;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of track.points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const pad = 18 + track.maxWidth / 2;
    const s = Math.min(
      (cv.width - 2 * pad) / Math.max(1, maxX - minX),
      (cv.height - 2 * pad) / Math.max(1, maxZ - minZ),
    );
    const ox = cv.width / 2 - ((minX + maxX) / 2) * s;
    const oz = cv.height / 2 - ((minZ + maxZ) / 2) * s;
    this.mmap = { s, ox, oz };
    const pt = (x, z) => [ox + x * s, oz + z * s];

    // road band as a filled polygon (both clamped edges)
    ctx.beginPath();
    for (let i = 0; i <= S; i += 4) {
      const j = i % S;
      const e = track.sideOffset(j, track.clampLat(j, track.halfWidthAt(j)));
      const [mx, my] = pt(e.x, e.z);
      i === 0 ? ctx.moveTo(mx, my) : ctx.lineTo(mx, my);
    }
    for (let i = S; i >= 0; i -= 4) {
      const j = i % S;
      const e = track.sideOffset(j, track.clampLat(j, -track.halfWidthAt(j)));
      const [mx, my] = pt(e.x, e.z);
      ctx.lineTo(mx, my);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(96,106,138,0.55)';
    ctx.fill();

    // ramps (amber rectangles in their own frames)
    for (const r of track.ramps) {
      const px = -r.fz, pz = r.fx, hw = r.w / 2;
      const corners = [
        [r.footX + px * hw, r.footZ + pz * hw], [r.footX - px * hw, r.footZ - pz * hw],
        [r.lipX - px * hw, r.lipZ - pz * hw], [r.lipX + px * hw, r.lipZ + pz * hw],
      ];
      ctx.beginPath();
      corners.forEach(([wx, wz], i) => {
        const [mx, my] = pt(wx, wz);
        i === 0 ? ctx.moveTo(mx, my) : ctx.lineTo(mx, my);
      });
      ctx.closePath();
      ctx.fillStyle = '#ffb14d';
      ctx.fill();
    }

    // start/finish tick
    const n = track.normalAt(0);
    const p0 = track.points[0];
    const hw0 = track.halfWidthAt(0);
    const [ax, ay] = pt(p0.x + n.nx * hw0, p0.z + n.nz * hw0);
    const [bx, by] = pt(p0.x - n.nx * hw0, p0.z - n.nz * hw0);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.lineWidth = 3; ctx.strokeStyle = '#e8e8e8'; ctx.stroke();

    this.minimapBase = cv;
    this.minimapBaseKey = this.trackKey;
  }

  drawMinimap() {
    if (!this.local) return;
    if (!this.minimap) this.minimap = document.getElementById('minimap');
    const cv = this.minimap;
    if (!cv) return;
    if (this.minimapBaseKey !== this.trackKey) this.buildMinimapBase();
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(this.minimapBase, 0, 0);

    const { s, ox, oz } = this.mmap;
    const dot = (x, z, color, radius) => {
      ctx.beginPath();
      ctx.arc(ox + x * s, oz + z * s, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    for (const ai of this.ais) dot(ai.state.x, ai.state.z, hexColor(ai.entry.color), 5);
    for (const rc of this.remotes.values()) {
      if (rc.target) dot(rc.render.x, rc.render.z, hexColor(rc.entry.color), 5);
    }
    // local car: heading arrow with an outline
    const l = this.local.state;
    const mx = ox + l.x * s, my = oz + l.z * s;
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(Math.atan2(Math.sin(l.heading), Math.cos(l.heading)) * -1 + Math.PI); // heading → canvas angle
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 6);
    ctx.lineTo(-5.5, 6);
    ctx.closePath();
    ctx.fillStyle = hexColor(this.local.entry.color);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.restore();
  }

  standings() {
    const S = this.track.sampleCount;
    const rows = [];
    if (this.local) rows.push(row(this.local, this.local.state.progress));
    for (const ai of this.ais) rows.push(row(ai, ai.state.progress));
    for (const rc of this.remotes.values()) {
      rows.push(row(rc, rc.target ? rc.target.prog : -S));
    }
    rows.sort((a, b) => {
      if (a.finished && b.finished) return a.time - b.time;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      return b.progress - a.progress;
    });
    return rows;

    function row(car, progress) {
      return {
        key: car.entry.key, name: car.entry.name, color: car.entry.color,
        isSelf: car.entry.key === 'self',
        lap: Math.min(Math.floor(Math.max(progress, 0) / S) + 1, LAPS),
        progress,
        finished: car.finished || !!car.target?.fin,
        time: car.finishTime ?? Infinity,
      };
    }
  }

  emitHud() {
    if (!this.local) return;
    const s = this.local.state;
    const standings = this.standings();
    this.cb.onHud?.({
      phase: this.phase,
      countdown: this.countdown,
      speed: Math.hypot(s.vx, s.vz),
      drifting: s.drifting,
      wrongWay: this.wrongWayAcc > 1.2,
      lap: Math.min(this.local.lap + 1, LAPS),
      laps: LAPS,
      lapTime: this.raceClock - this.local.lapStart,
      bestLap: this.local.bestLap,
      finished: this.local.finished,
      position: standings.findIndex((r) => r.isSelf) + 1,
      standings,
      tumbling: this.local.state.tumble > 0,
      wrecked: this.local.state.wrecked > 0,
      score: Math.round(this.local.score),
      chain: Math.round(this.local.chain),
      chainT: clamp((this.local.chainTimer ?? 0) / DRIFT_GRACE, 0, 1),
      jumpFlash: this.jumpFlash ?? 0,
      jumpPts: this.jumpPts ?? 0,
      lostFlash: this.lostFlash ?? 0,
      boostFlash: this.boostFlash ?? 0,
    });
  }

  // ---- Remote state intake (called from main.js) ----
  remoteState(id, state) {
    const rc = this.remotes.get(id);
    if (!rc) return;
    if (!rc.target) { // first packet: snap
      rc.render.x = state.x; rc.render.z = state.z; rc.render.heading = state.h;
      rc.render.y = state.y ?? 0;
    }
    rc.target = state;
    rc.targetAt = performance.now();
    // Track index from their progress — used for the shadow's ground height.
    const S = this.track.sampleCount;
    rc.render.trackIdx = ((Math.round(state.prog) % S) + S) % S;
  }

  markRemoteFinished(id, fin) {
    const rc = this.remotes.get(id);
    if (rc && !rc.finished) {
      rc.finished = true;
      rc.finishTime = fin.time;
      this.finishCount = (this.finishCount ?? 0) + 1; // they took a podium slot
    }
  }
}

function brakeOn(s, input) {
  const vF = s.vx * Math.sin(s.heading) + s.vz * Math.cos(s.heading);
  return input.handbrake || (input.throttle < -0.1 && vF > 0.5);
}

function round2(v) { return Math.round(v * 100) / 100; }

function hexColor(c) { return `#${c.toString(16).padStart(6, '0')}`; }

// Spinning golden octahedron with an additive ground glow.
function buildPickupMesh() {
  const group = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.15),
    new THREE.MeshBasicMaterial({ color: 0xffe14d }),
  );
  group.add(core);
  const rim = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.5),
    new THREE.MeshBasicMaterial({ color: 0xffb14d, wireframe: true, transparent: true, opacity: 0.6 }),
  );
  group.add(rim);
  const glowCv = document.createElement('canvas');
  glowCv.width = glowCv.height = 64;
  const g = glowCv.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,225,77,0.9)');
  grad.addColorStop(1, 'rgba(255,225,77,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(7, 7),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(glowCv), transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = -1.2;
  group.add(glow);
  return group;
}
