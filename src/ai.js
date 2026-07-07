import { clamp, wrapAngle, MAX_SPEED } from './physics.js';

export const AI_NAMES = ['VECTOR', 'NEON-9', 'GHOST', 'TURBO-K', 'MIRAGE', 'VOLT'];

// Racing-line follower with racecraft: cuts apexes, dodges placed obstacles,
// offsets around cars ahead, and rubber-bands against the player's progress.
export class AiDriver {
  constructor(skill = 1) {
    this.skill = skill;
    this.reverseTimer = 0;
    this.dodgeSide = Math.random() < 0.5 ? 1 : -1; // preferred overtake side
    this.flick = 0;   // handbrake-flick timer (deliberate drift entry)
    this.flickCd = 0;
  }

  // ctx: { others: [car states], playerProgress: number }
  control(car, track, dt, ctx = {}) {
    const S = track.sampleCount;
    const speed = Math.hypot(car.vx, car.vz);

    // Unstick: after a hard wall hit at low speed, back out briefly.
    if (car.wallHit > 4 && speed < 6) this.reverseTimer = 0.7;
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      return { throttle: -1, steer: -car.steer, handbrake: false };
    }

    // Lookahead in WORLD UNITS (sample spacing varies per track).
    const segLen = (track.length ?? S) / S;
    const lookU = clamp(14 + speed * 1.5 * this.skill, 18, 170);
    const look = Math.max(4, Math.round(lookU / segLen));
    const li = (car.trackIdx + look) % S;

    // Signed corner ahead (direction matters for the apex line).
    const t0 = track.tangents[car.trackIdx];
    const t1 = track.tangents[(car.trackIdx + Math.round(look * 1.25)) % S];
    const turn = wrapAngle(Math.atan2(t1.x, t1.z) - Math.atan2(t0.x, t0.z));

    // Racing line: bias the aim point toward the INSIDE of the corner.
    const halfW = track.halfWidthAt ? track.halfWidthAt(li) : (track.halfWidth ?? 14);
    let targetLat = clamp(turn * 2.2, -1, 1) * Math.max(0, halfW - 8);

    const fwdX = Math.sin(car.heading), fwdZ = Math.cos(car.heading);
    let brakeForObstacle = false;

    // Placed walls/blocks: dodge what's in the forward corridor, brake if close.
    if (track.obstacles) {
      for (const o of track.obstacles) {
        const dx = o.x - car.x, dz = o.z - car.z;
        const along = dx * fwdX + dz * fwdZ;
        if (along < 4 || along > 30 + speed * 1.3) continue;
        if ((car.y ?? 0) > o.baseY + o.h - 0.4) continue; // will fly over it
        const latO = dx * fwdZ - dz * fwdX;
        const clearance = o.thick + o.len * 0.35 + 4.5;
        if (Math.abs(latO) < clearance) {
          targetLat += (clearance - Math.abs(latO) + 2.5) * (latO >= 0 ? -1 : 1);
          if (along < 20 && speed > 32) brakeForObstacle = true;
        }
      }
    }

    // Keep the aim point on the drivable corridor.
    const maxLat = Math.max(2, halfW - 4);
    targetLat = clamp(targetLat, -maxLat, maxLat);
    if (track.clampLat) targetLat = track.clampLat(li, targetLat);
    const tp = track.sideOffset ? track.sideOffset(li, targetLat) : track.points[li];
    let tx = tp.x, tz = tp.z;

    // Racecraft: a car sitting in our path → offset to a side and send it.
    if (ctx.others) {
      for (const o of ctx.others) {
        const dx = o.x - car.x, dz = o.z - car.z;
        if (Math.abs((o.y ?? 0) - (car.y ?? 0)) > 3) continue;
        const along = dx * fwdX + dz * fwdZ;
        const latO = dx * fwdZ - dz * fwdX;
        if (along > 2 && along < 18 && Math.abs(latO) < 3.4) {
          const side = latO > 0.5 ? -1 : latO < -0.5 ? 1 : this.dodgeSide;
          tx += side * 4.5 * fwdZ;
          tz += side * 4.5 * -fwdX;
        }
      }
    }

    const desired = Math.atan2(tx - car.x, tz - car.z);
    const err = wrapAngle(desired - car.heading);
    // PD control: the damping term counters yaw momentum (else it oscillates).
    const steer = clamp(err * 2.2 - car.yawVel * 0.55, -1, 1);

    // Speed from real physics, not vibes: at radius r the steering model's
    // steady state allows v/r = 2.93/(1+0.016v)  →  solve for v. Scan several
    // horizons ahead; brake only when required decel actually demands it.
    const cornerV = (r) => (Math.sqrt(1 + 0.1875 * r) - 1) / 0.032;
    const meas = Math.max(3, Math.round(26 / segLen)); // curvature window
    let targetSpeed = MAX_SPEED * this.skill;
    for (const mult of [0.3, 0.6, 1.0, 1.5, 2.1, 2.8]) {
      const h = Math.round(look * mult);
      const ta = track.tangents[(car.trackIdx + h) % S];
      const tb = track.tangents[(car.trackIdx + h + meas) % S];
      let da = Math.abs(wrapAngle(Math.atan2(tb.x, tb.z) - Math.atan2(ta.x, ta.z)));
      if (da < 1e-4) continue;
      const r = (meas * segLen) / da;
      const vc = cornerV(r) * 0.99 * this.skill;
      // allowed speed NOW so that braking at ~40 u/s² reaches vc in time
      const dist = Math.max(0, h * segLen - 14);
      targetSpeed = Math.min(targetSpeed, Math.sqrt(vc * vc + 2 * 46 * dist));
    }
    // Rubber-band vs the player: hunt when behind, breathe when ahead.
    // The catch-up isn't just a higher target — trailing AI gets real engine
    // boost (throttle > 1), because a target above top speed does nothing.
    let boost = 0;
    if (ctx.playerProgress != null) {
      const gap = (ctx.playerProgress - car.progress) / S; // + = player ahead
      targetSpeed *= clamp(1 + gap * 1.0, 0.97, 1.35);
      boost = clamp(gap * 2.0, 0, 0.6);
    }

    let throttle;
    if (speed > targetSpeed + 1.5) throttle = -1;      // brake hard
    else if (speed > targetSpeed) throttle = 0;        // lift (rotates the car)
    else throttle = this.skill + boost;

    // Deliberate drift entry: flick the handbrake into a proper corner at
    // speed, then powerslide through on throttle — the player's technique
    // (speed retention makes committed slides FAST, not just flashy).
    this.flickCd -= dt;
    const slip = Math.abs(car.slip);
    if (this.flick > 0) {
      this.flick -= dt;
      return { throttle: 0.4, steer: clamp(turn * 3, -1, 1), handbrake: true };
    }
    if (
      Math.abs(turn) > 0.5 && Math.abs(turn) < 1.4
      && halfW > 19 && speed > 50 && slip < 4 && car.grounded
      && this.flickCd <= 0 && !brakeForObstacle
    ) {
      this.flick = 0.2;
      this.flickCd = 2.4;
    }
    // Mid-slide: stay on the gas to hold the drift (unless it's getting away).
    if (slip > 5 && slip < 13 && throttle >= 0 && speed < targetSpeed + 10) {
      throttle = Math.max(throttle, 0.9);
    }

    // Stability: in a DEEP slide, back off so the tyres can hook back up.
    if (slip > 13 && throttle > 0) throttle = speed > 30 ? -0.25 : 0;
    if (brakeForObstacle) throttle = Math.min(throttle, -0.5);

    const handbrake = Math.abs(turn) > 1.55 && speed > 26 && Math.abs(err) > 0.45;
    return { throttle: clamp(throttle, -1, 1.4), steer, handbrake };
  }
}
