// Arcade momentum-drift car physics on the XZ plane. No DOM/three deps.
//
// Model: velocity is decomposed each step into components along/across the
// car's heading. Lateral velocity decays at a "grip" rate; heading rotates
// from steering. Because velocity is NOT rotated with the car, turning the
// nose creates lateral slip that grip then pulls back in line — cut the grip
// (handbrake, trail-braking, lift-off) and the car slides.

export const CAR_RADIUS = 1.7;
export const MAX_SPEED = 100; // ~320 km/h on the HUD

const ACCEL = 30;
const BRAKE = 70;
const REVERSE_ACCEL = 15;
const MAX_REVERSE = 11;
const DRAG = 0.00135;
const ROLL = 0.6;

const GRIP = 7;            // 1/s lateral decay, full grip
const GRIP_HANDBRAKE = 1.2;
const GRIP_POWERSLIDE = 1.1;   // sliding + on throttle: rear stays loose
const GRIP_SLIDE_NEUTRAL = 1.6; // sliding, no pedal: slide bleeds off slowly
const GRIP_TRAILBRAKE = 2.6;
const GRIP_LIFTOFF = 5.0;
const GRIP_DROP = 8;           // 1/s — losing grip is fast...
const GRIP_REGAIN = 1.6;       // ...but hooking back up takes real time (inertia)
const SLIDE_ENTER = 3.5;       // |vL| to consider the rear loose...
const SLIDE_EXIT = 1.2;        // ...and to consider it hooked up again

// Yaw is a rotational-inertia model: steering and alignment apply TORQUE to an
// angular velocity that persists. Gripped, damping is high so it feels direct.
// Sliding, damping drops — the flick builds rotation you must CATCH with
// counter-steer, and holding full lock past the balance point spins you out.
const YAW_TORQUE = 22;        // steering torque, gripped
const YAW_TORQUE_SLIDE = 0.4; // fraction of steering torque left at full slip
const YAW_DAMP_GRIP = 7.5;
const YAW_DAMP_SLIDE = 1.8;
const YAW_DAMP_AIR = 1.2;
const ALIGN_TORQUE = 12;      // weathervane toward velocity, scaled by grip
const AIR_TORQUE = 2.6;
const DRIFT_SLIP_THRESHOLD = 4.0;

// Hidden counter-steer assist (what every fun arcade drifter ships): damps
// slip-angle GROWTH so the flick settles into a stable hang instead of
// running away — never resists recovery, and fades out at deep angles so
// greedy full-lock still spins.
const SLIP_STAB = 3;
const SLIP_STAB_FULL = 0.9;   // rad — full assist below this slip angle...
const SLIP_STAB_GONE = 1.35;  // rad — ...none beyond this (spin territory)

// OutRun-style speed retention: on throttle, lateral momentum the tyres
// scrub off partially converts to forward speed — drifting carries pace.
const DRIFT_THRUST = 0.35;

// Tumble: the arcade rollover. Violent events flip the car — it barrel-rolls,
// bounces, and is uncontrollable until it settles back on its wheels.
const TUMBLE_WALL_HIT = 19;   // wall impact speed that flips
const TUMBLE_CAR_HIT = 22;    // car-to-car closing speed that flips
const TUMBLE_LANDING = 30;    // fall speed that flips on its own...
const TUMBLE_SIDE_LANDING = 15; // ...or this, if landing sideways (slip > 12)

export const GRAV = 30;    // arcade gravity — snappy jump arcs at racing speed
const LAUNCH_MARGIN = 11;  // ground must fall away this much faster than gravity to launch

export function makeCarState(x = 0, z = 0, heading = 0) {
  return {
    x, z, heading,
    vx: 0, vz: 0,
    yawVel: 0,         // angular velocity — drift momentum lives here
    prevSlip: 0,       // last slip angle, for the counter-steer assist
    y: 0, vy: 0,       // elevation + vertical speed
    grounded: true,
    landed: 0,         // landing impact speed this step, 0 if none
    tumble: 0,         // seconds of rollover remaining (0 = fine)
    tumbleSpin: 0,     // roll rate while tumbling
    rollAngle: 0,      // accumulated body roll (visual + settle-back)
    wrecked: 0,        // resting on side/roof — respawn countdown
    restRoll: 0,       // pose to settle into while wrecked
    steer: 0,          // smoothed steering [-1, 1]
    grip: GRIP,        // smoothed grip (regimes blend, no snap)
    sliding: false,    // rear-loose flag with hysteresis
    trackIdx: 0,       // nearest centerline sample (windowed)
    lat: 0,            // signed lateral offset from centerline (+ = left)
    progress: 0,       // accumulated samples travelled (laps = progress / SAMPLES)
    drifting: false,
    slip: 0,
    wallHit: 0,        // impact speed this step, 0 if none
  };
}

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function startTumble(car, intensity, spinSign) {
  if (car.tumble > 0) return;
  const k = clamp(intensity, 0, 1);
  car.tumble = 0.9 + k * 0.9;
  car.tumbleSpin = (spinSign >= 0 ? 1 : -1) * (6 + k * 8);
  if (car.grounded) {
    car.grounded = false;
    car.vy = Math.max(car.vy, 5 + k * 8); // pop off the ground
  }
}

const DEAD_INPUT = { throttle: 0, steer: 0, handbrake: false };

// input: {throttle: -1..1, steer: -1..1, handbrake: bool}
// track: needs probe(x, z, lastIdx) and halfWidth — see track.js
export function stepCar(car, input, dt, track) {
  // Tumbling: no control, the body rolls, ground scrubs speed hard.
  if (car.tumble > 0) {
    car.tumble -= dt;
    input = DEAD_INPUT;
    car.rollAngle += car.tumbleSpin * dt;
    car.tumbleSpin *= Math.exp(-1.4 * dt);
    // Bottom-heavy: as the spin bleeds off, the shell pendulums toward
    // wheels-down — most tumbles end on the wheels, as real cars tend to.
    car.tumbleSpin -= Math.sin(wrapAngle(car.rollAngle)) * 9.5 * dt;
    if (car.grounded) {
      const f = Math.exp(-1.9 * dt);
      car.vx *= f; car.vz *= f;
    }
    if (car.tumble <= 0) {
      if (!car.grounded || Math.abs(car.tumbleSpin) > 3.4) {
        car.tumble = 0.05; // verdict waits for touchdown AND for the spin to die
      } else {
        // The flip's CONSEQUENCE depends on how you land: on the wheels =
        // drive on; on the side or roof = wrecked, respawn in a moment.
        const r = wrapAngle(car.rollAngle);
        if (Math.abs(r) > 1.2) { // generous: the suspension catches steep landings
          car.wrecked = 2.0;
          car.rollAngle = r;
          car.restRoll = Math.abs(r) > 2.4 ? Math.PI * Math.sign(r) : (Math.PI / 2) * Math.sign(r);
        }
      }
    }
  } else if (car.wrecked > 0) {
    car.wrecked -= dt;
    input = DEAD_INPUT;
    const f = Math.exp(-4 * dt);
    car.vx *= f; car.vz *= f;
    car.yawVel *= f;
    car.rollAngle += (car.restRoll - car.rollAngle) * Math.min(1, 10 * dt);
    if (car.wrecked <= 0) {
      // Respawn on the centerline, pointing down the track.
      const p = track.points?.[car.trackIdx];
      const t = track.tangents?.[car.trackIdx];
      if (p && t) {
        car.x = p.x; car.z = p.z;
        car.y = track.groundAt ? track.groundAt(p.x, p.z, car.trackIdx) : 0;
        car.heading = Math.atan2(t.x, t.z);
      }
      car.vx = car.vz = car.vy = 0;
      car.yawVel = 0;
      car.rollAngle = 0;
      car.tumbleSpin = 0;
      car.grounded = true;
      car.sliding = false;
      car.grip = GRIP;
    }
  } else if (car.rollAngle !== 0) {
    // Landed on the wheels: settle upright via the nearest full rotation.
    car.rollAngle = wrapAngle(car.rollAngle) * Math.exp(-7 * dt);
    if (Math.abs(car.rollAngle) < 0.02) car.rollAngle = 0;
  }
  // Smoothed steering so digital keys can hold partial angles mid-corner.
  const steerTarget = clamp(input.steer, -1, 1);
  const steerRate = Math.abs(steerTarget) > Math.abs(car.steer) ? 5 : 8.5;
  car.steer += clamp(steerTarget - car.steer, -steerRate * dt, steerRate * dt);

  const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
  const rx = fz, rz = -fx; // lateral axis
  let vF = car.vx * fx + car.vz * fz;
  let vL = car.vx * rx + car.vz * rz;

  // --- Longitudinal (wheels only work on the ground) ---
  let aF = 0;
  if (car.grounded) {
    if (input.throttle > 0) {
      aF += (vF < -0.5 ? BRAKE : ACCEL * (1 - 0.6 * clamp(vF / MAX_SPEED, 0, 1))) * input.throttle;
    } else if (input.throttle < 0) {
      aF += (vF > 0.5 ? BRAKE : (vF > -MAX_REVERSE ? REVERSE_ACCEL : 0)) * input.throttle;
    }
    aF -= ROLL * Math.sign(vF) * clamp(Math.abs(vF), 0, 1);
    if (input.handbrake) aF -= vF * 0.8;
    // Gravity along the road grade (sampled numerically along the heading so
    // spline hills AND free-standing ramps both drag/push correctly).
    if (track.groundAt) {
      const h1 = track.groundAt(car.x - fx * 2.5, car.z - fz * 2.5, car.trackIdx);
      const h2 = track.groundAt(car.x + fx * 2.5, car.z + fz * 2.5, car.trackIdx);
      aF -= GRAV * clamp((h2 - h1) / 5, -0.5, 0.5);
    }
  }
  aF -= DRAG * vF * Math.abs(vF) * (car.grounded ? 1 : 0.3);
  vF += aF * dt;

  // --- Lateral grip: this is where drift lives ---
  // Two regimes: gripped (slides are initiated by handbrake / trail-braking /
  // lift-off) and sliding (once loose, throttle KEEPS it loose — hold long
  // drifts with gas + counter-steer; regain grip by lifting and straightening).
  // The sliding flag has hysteresis and the grip value blends between regimes,
  // so drifts end by fading out, not by snapping.
  if (car.sliding) { if (Math.abs(vL) < SLIDE_EXIT) car.sliding = false; }
  else if (Math.abs(vL) > SLIDE_ENTER) car.sliding = true;

  let gripTarget = GRIP;
  if (input.handbrake) {
    gripTarget = GRIP_HANDBRAKE;
  } else if (car.sliding) {
    if (input.throttle > 0.2) gripTarget = GRIP_POWERSLIDE;
    else if (input.throttle < -0.1) gripTarget = GRIP_TRAILBRAKE;
    else gripTarget = GRIP_SLIDE_NEUTRAL;
  } else if (input.throttle < -0.1 && vF > 6) {
    gripTarget = GRIP_TRAILBRAKE; // brake into corner to rotate
  } else if (Math.abs(input.throttle) < 0.1 && Math.abs(vL) > 2) {
    gripTarget = GRIP_LIFTOFF; // lift-off rotation
  }
  const blend = gripTarget > car.grip ? GRIP_REGAIN : GRIP_DROP;
  car.grip += (gripTarget - car.grip) * Math.min(1, blend * dt);
  if (car.grounded) {
    const vLBefore = vL;
    vL *= Math.exp(-car.grip * dt);
    // Speed retention: scrubbed lateral speed feeds forward drive on throttle.
    if (car.sliding && input.throttle > 0.2 && vF > 0) {
      vF += (Math.abs(vLBefore) - Math.abs(vL)) * DRIFT_THRUST;
    }
  }

  // --- Yaw: steering + self-aligning torque ---
  // The aligning term weathervanes the heading toward the velocity vector.
  // It's what lets the car HANG at a drift angle: steering rotates the nose
  // out, alignment pulls it back, and the balance point is a held slide.
  const speed = Math.hypot(car.vx, car.vz);
  const reverse = vF < -0.5 ? -1 : 1;
  const speedFactor = clamp(Math.abs(vF) / 6, 0, 1) / (1 + Math.abs(vF) * 0.016);
  const slipNorm = clamp(Math.abs(vL) / 12, 0, 1);
  const slipAngle = vF > 2 ? wrapAngle(Math.atan2(car.vx, car.vz) - car.heading) : 0;

  let torque, damp;
  if (car.grounded) {
    // Steering torque fades as slip grows (saturated fronts) — mid-drift the
    // arc is momentum's; alignment torque pulls the nose toward the velocity.
    const steerT = car.steer * YAW_TORQUE * speedFactor * reverse
      * (1 - (1 - YAW_TORQUE_SLIDE) * slipNorm);
    const alignT = slipAngle * ALIGN_TORQUE * (car.grip / GRIP);
    torque = steerT + alignT;
    damp = YAW_DAMP_GRIP + (YAW_DAMP_SLIDE - YAW_DAMP_GRIP) * slipNorm;

    // Counter-steer assist: oppose slip growth only (recovery stays free),
    // fading to nothing at deep angles so over-rotation still spins.
    const slipRate = clamp((slipAngle - car.prevSlip) / dt, -3, 3);
    const growing = slipRate * Math.sign(slipAngle || 1) > 0;
    if (!input.handbrake && growing) {
      const fade = clamp((SLIP_STAB_GONE - Math.abs(slipAngle)) / (SLIP_STAB_GONE - SLIP_STAB_FULL), 0, 1);
      torque += slipRate * SLIP_STAB * slipNorm * fade;
    }
  } else {
    torque = car.steer * AIR_TORQUE;
    damp = YAW_DAMP_AIR;
  }
  car.yawVel += (torque - damp * car.yawVel) * dt;
  car.heading = wrapAngle(car.heading + car.yawVel * dt);
  car.prevSlip = slipAngle;

  // Recompose velocity on the OLD axes: heading change creates slip, grip resolves it.
  car.vx = fx * vF + rx * vL;
  car.vz = fz * vF + rz * vL;

  car.x += car.vx * dt;
  car.z += car.vz * dt;

  // --- Walls: the track is fully barriered ---
  car.wallHit = 0;
  const pr = track.probe(car.x, car.z, car.trackIdx);
  const halfW = track.halfWidthAt ? track.halfWidthAt(pr.index) : track.halfWidth;
  let limit = halfW - CAR_RADIUS * 0.62;
  // Sharp corners: the drivable corridor pinches with the rendered edges
  // (clampLat), so physics and visuals agree about where the wall is.
  if (track.clampLat) {
    limit = Math.abs(track.clampLat(pr.index, (pr.lat >= 0 ? 1 : -1) * limit));
  }
  if (pr.dist > limit) {
    const inv = 1 / (pr.dist || 1e-6);
    const nx = (car.x - pr.px) * inv, nz = (car.z - pr.pz) * inv; // outward normal
    car.x = pr.px + nx * limit;
    car.z = pr.pz + nz * limit;
    const vN = car.vx * nx + car.vz * nz;
    if (vN > 0) {
      car.vx -= nx * vN * 1.35; // bounce (restitution 0.35)
      car.vz -= nz * vN * 1.35;
      car.vx *= 0.93; // scrape
      car.vz *= 0.93;
      car.wallHit = vN;
      // Glancing hits twist the car: torque scales with how off-axis the
      // contact is (zero for a square head-on, max for a shallow scrape),
      // rotating the nose away from the wall.
      const offAxis = fz * nx - fx * nz;
      car.yawVel += clamp(-offAxis * Math.min(vN, 16) * 0.09, -1.4, 1.4);
      // Truly violent wall hits flip the car over.
      if (vN > TUMBLE_WALL_HIT) {
        startTumble(car, (vN - TUMBLE_WALL_HIT) / 15, offAxis >= 0 ? 1 : -1);
      }
    }
  }

  // --- Placed obstacles (walls/blocks): capsule segments. Low walls can be
  // JUMPED — they only collide while the car is below their top. ---
  if (track.obstacles?.length) {
    for (const o of track.obstacles) {
      const dx0 = car.x - o.x, dz0 = car.z - o.z;
      const reach = o.len / 2 + o.thick + 4;
      if (dx0 * dx0 + dz0 * dz0 > reach * reach) continue;
      if (car.y > o.baseY + o.h - 0.4) continue; // sailing over it
      const t = clamp(dx0 * o.fx + dz0 * o.fz, -o.len / 2, o.len / 2);
      const cx = o.x + o.fx * t, cz = o.z + o.fz * t;
      let ox = car.x - cx, oz = car.z - cz;
      const d = Math.hypot(ox, oz);
      const minD = CAR_RADIUS + o.thick;
      if (d >= minD || d < 1e-6) continue;
      ox /= d; oz /= d;
      car.x = cx + ox * minD;
      car.z = cz + oz * minD;
      const vN = car.vx * ox + car.vz * oz;
      if (vN < 0) {
        car.vx -= ox * vN * 1.35;
        car.vz -= oz * vN * 1.35;
        car.vx *= 0.93; car.vz *= 0.93;
        car.wallHit = Math.max(car.wallHit, -vN);
        const offAxis = fz * ox - fx * oz;
        car.yawVel += clamp(-offAxis * Math.min(-vN, 16) * 0.09, -1.4, 1.4);
      }
    }
  }

  // --- Progress (windowed index can only move gradually; walls prevent cuts) ---
  const S = track.sampleCount;
  let delta = pr.index - car.trackIdx;
  if (delta > S / 2) delta -= S;
  if (delta < -S / 2) delta += S;
  car.trackIdx = pr.index;
  car.progress += delta;
  car.lat = pr.lat ?? 0;

  // --- Vertical: follow the road, launch off crests, land ---
  const groundY = track.groundAt ? track.groundAt(car.x, car.z, pr.index) : 0;
  car.landed = 0;
  if (car.grounded) {
    const reqVy = (groundY - car.y) / dt;
    if (reqVy < car.vy - GRAV * dt - LAUNCH_MARGIN) {
      // Ground falls away faster than gravity could follow: airborne.
      // car.vy keeps the terrain-following rate from the climb — the launch arc.
      car.grounded = false;
      car.vy -= GRAV * dt;
      car.y += car.vy * dt;
    } else {
      // Terrain-following rate feeds future launches — cap it so stepping
      // onto a ledge/ramp-side doesn't read as a rocket-grade climb.
      car.vy = clamp(reqVy, -60, 26);
      car.y = groundY;
    }
  } else {
    car.vy -= GRAV * dt;
    car.y += car.vy * dt;
    if (car.y <= groundY) {
      car.landed = Math.max(0, -car.vy);
      car.y = groundY;
      if (car.tumble > 0.25 && car.landed > 8) {
        car.vy = car.landed * 0.45; // tumbling cars BOUNCE
      } else {
        car.vy = 0;
        car.grounded = true;
        // Brutal or sideways landings roll the car.
        if (car.landed > TUMBLE_LANDING
          || (car.landed > TUMBLE_SIDE_LANDING && Math.abs(vL) > 12)) {
          startTumble(car, car.landed / 40, vL >= 0 ? 1 : -1);
        }
      }
    }
  }

  car.slip = vL;
  car.drifting = car.grounded && Math.abs(vL) > DRIFT_SLIP_THRESHOLD && speed > 9;
  return car;
}

// Circle-vs-circle contact. `b` may be remote (authoritative elsewhere): then
// only `a` is corrected, but the impulse still uses b's velocity so ramming works.
// Returns the closing speed (0 if no impulse) so callers can drive sound/FX.
export function collideCars(a, b, moveBoth) {
  // Vertically separated cars pass freely — you can JUMP OVER someone.
  if (Math.abs((a.y ?? 0) - (b.y ?? 0)) > 2.6) return 0;
  const dx = b.x - a.x, dz = b.z - a.z;
  const d = Math.hypot(dx, dz);
  const minD = CAR_RADIUS * 2 * 0.95;
  if (d >= minD || d < 1e-6) return 0;

  const nx = dx / d, nz = dz / d;
  const overlap = minD - d;
  if (moveBoth) {
    a.x -= nx * overlap / 2; a.z -= nz * overlap / 2;
    b.x += nx * overlap / 2; b.z += nz * overlap / 2;
  } else {
    a.x -= nx * overlap; a.z -= nz * overlap;
  }

  const relN = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
  if (relN <= 0) return 0; // already separating
  // Soft nudges stay soft; hard hits get bouncy.
  const e = clamp(relN / 25, 0.25, 0.65);
  const j = (1 + e) * relN / 2;
  a.vx -= nx * j; a.vz -= nz * j;
  if (moveBoth) { b.vx += nx * j; b.vz += nz * j; }

  // Sideswipes trade rotation AND rub off tangential speed — bumps read as
  // physical shoves, not velocity edits.
  const relT = (a.vx - b.vx) * -nz + (a.vz - b.vz) * nx;
  const spin = clamp(relT * 0.05, -0.9, 0.9);
  a.yawVel = (a.yawVel ?? 0) + spin;
  a.vx -= -nz * relT * 0.07; a.vz -= nx * relT * 0.07;
  if (moveBoth) {
    b.yawVel = (b.yawVel ?? 0) - spin;
    b.vx += -nz * relT * 0.07; b.vz += nx * relT * 0.07;
  }

  // Massive impacts flip whoever got hit hardest across their beam.
  if (relN > TUMBLE_CAR_HIT) {
    const k = (relN - TUMBLE_CAR_HIT) / 15;
    const sideA = Math.sin(a.heading) * nz - Math.cos(a.heading) * nx;
    startTumble(a, k, sideA >= 0 ? 1 : -1);
    if (moveBoth) startTumble(b, k, sideA >= 0 ? -1 : 1);
  }
  return relN;
}
