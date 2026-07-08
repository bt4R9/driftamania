// Scripted drift: cruise at speed, handbrake-flick into a corner, then hold
// with throttle + steering. Reports slip angle over time — a good drift holds
// 15-40° for multiple seconds and recovers without spinning.
import { stepCar, makeCarState, wrapAngle } from '../src/physics.js';

const track = { // open plane: no walls
  halfWidth: 1e9, sampleCount: 4096,
  probe: () => ({ index: 0, dist: 0, px: 0, pz: 0 }),
};

const car = makeCarState(0, 0, 0);
car.vx = 0; car.vz = 55; // cruising at ~187 km/h
const dt = 1 / 60;

function scenario(name, inputAt, dur) {
  const car = makeCarState(0, 0, 0);
  car.vx = 0; car.vz = 55;
  const dt = 1 / 60;
  let maxSlip = 0, driftTime = 0, endSlip = 0, minSpeed = 1e9;
  for (let t = 0; t < dur; t += dt) {
    stepCar(car, inputAt(t), dt, track);
    const slipDeg = Math.abs(wrapAngle(Math.atan2(car.vx, car.vz) - car.heading)) * 180 / Math.PI;
    maxSlip = Math.max(maxSlip, slipDeg);
    if (car.drifting) driftTime += dt;
    minSpeed = Math.min(minSpeed, Math.hypot(car.vx, car.vz));
    endSlip = slipDeg;
  }
  console.log(`${name.padEnd(28)} maxSlip=${maxSlip.toFixed(0)}° endSlip=${endSlip.toFixed(0)}° driftTime=${driftTime.toFixed(1)}s minSpeed=${minSpeed.toFixed(0)}`);
  return { maxSlip, endSlip, driftTime };
}

// 1. Flick, then managed hold at 55% steer, then release — should hold ~25-40° and recover.
scenario('flick + managed hold', (t) => {
  if (t < 0.5) return { throttle: 1, steer: 0, handbrake: false };
  if (t < 1.0) return { throttle: 0, steer: 1, handbrake: true };
  if (t < 4.5) return { throttle: 1, steer: 0.55, handbrake: false };
  return { throttle: 1, steer: 0, handbrake: false };
}, 7);

// 2. Flick, then GREEDY full lock held — should overrotate/spin (maxSlip > 70°).
scenario('flick + full lock (greedy)', (t) => {
  if (t < 0.5) return { throttle: 1, steer: 0, handbrake: false };
  if (t < 1.0) return { throttle: 0, steer: 1, handbrake: true };
  return { throttle: 1, steer: 1, handbrake: false };
}, 6);

// 3. Flick, then hold, then counter-steer catch — should straighten cleanly.
scenario('flick + counter-steer catch', (t) => {
  if (t < 0.5) return { throttle: 1, steer: 0, handbrake: false };
  if (t < 1.0) return { throttle: 0, steer: 1, handbrake: true };
  if (t < 2.5) return { throttle: 1, steer: 0.5, handbrake: false };
  if (t < 3.2) return { throttle: 1, steer: -0.6, handbrake: false };
  return { throttle: 1, steer: 0, handbrake: false };
}, 6);

// 5+6. Mid-drift pedal feel: brake / handbrake DURING an established slide
// must deepen the angle (weight transfer / locked rears), not straighten the
// car while hard-stopping it. Compare slip just before the input vs after.
// A 0.8s stab mid-drift, then a counter-steer catch: the stab must deepen the
// angle by a clear margin, the catch must still bring it back (no auto-spin).
function midDriftScenario(name, midInput) {
  const car = makeCarState(0, 0, 0);
  car.vx = 0; car.vz = 55;
  const dt = 1 / 60;
  let slipBefore = 0, maxAfter = 0, speedBefore = 0, speedAfter = 1e9, endSlip = 0;
  for (let t = 0; t < 6.0; t += dt) {
    const input = t < 0.5 ? { throttle: 1, steer: 0, handbrake: false }
      : t < 1.0 ? { throttle: 0, steer: 1, handbrake: true }
      : t < 2.5 ? { throttle: 1, steer: 0.55, handbrake: false }
      : t < 3.3 ? midInput
      : t < 4.2 ? { throttle: 1, steer: -0.7, handbrake: false } // the catch
      : { throttle: 1, steer: 0, handbrake: false };
    stepCar(car, input, dt, track);
    const slipDeg = Math.abs(wrapAngle(Math.atan2(car.vx, car.vz) - car.heading)) * 180 / Math.PI;
    if (t < 2.5) { slipBefore = slipDeg; speedBefore = Math.hypot(car.vx, car.vz); }
    else if (t < 3.3) { maxAfter = Math.max(maxAfter, slipDeg); speedAfter = Math.min(speedAfter, Math.hypot(car.vx, car.vz)); }
    endSlip = slipDeg;
  }
  const deepened = maxAfter > slipBefore + 6;
  const caught = endSlip < 12;
  console.log(`${name.padEnd(28)} slip ${slipBefore.toFixed(0)}°→${maxAfter.toFixed(0)}° speed ${speedBefore.toFixed(0)}→${speedAfter.toFixed(0)} end=${endSlip.toFixed(0)}° `
    + `${deepened ? 'DEEPENS ✓' : 'FLATTENS ✗'} ${caught ? 'CATCHABLE ✓' : 'SPINS ✗'}`);
}
midDriftScenario('brake stab mid-drift', { throttle: -1, steer: 0.55, handbrake: false });
midDriftScenario('handbrake stab mid-drift', { throttle: 0, steer: 0.55, handbrake: true });

// 4. Recovery inertia: mid-drift, straighten the wheel at t=2.5 — how long
// until the car actually hooks up (slip < 5°)? Want ~1.4-2.2s — heavy, not instant.
{
  const car = makeCarState(0, 0, 0);
  car.vx = 0; car.vz = 55;
  const dt = 1 / 60;
  let hookupAt = null;
  for (let t = 0; t < 7; t += dt) {
    const input = t < 0.5 ? { throttle: 1, steer: 0, handbrake: false }
      : t < 1.0 ? { throttle: 0, steer: 1, handbrake: true }
      : t < 2.5 ? { throttle: 1, steer: 0.55, handbrake: false }
      : { throttle: 1, steer: 0, handbrake: false };
    stepCar(car, input, dt, track);
    const slipDeg = Math.abs(wrapAngle(Math.atan2(car.vx, car.vz) - car.heading)) * 180 / Math.PI;
    if (t > 2.5 && hookupAt === null && slipDeg < 5) hookupAt = t - 2.5;
  }
  console.log(`recovery after straightening   hookup in ${hookupAt === null ? '>4.5' : hookupAt.toFixed(2)}s (want 1.4-2.2 — exiting a drift should take commitment)`);
}
