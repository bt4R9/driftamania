// Headless sanity check: AI drives each circuit with the real physics AND the
// real track geometry (trackgeom). Passes if the AI completes 3 laps.
import { buildTrackGeometry } from '../src/trackgeom.js';
import { TRACKS } from '../src/tracks.js';
import { stepCar, makeCarState } from '../src/physics.js';
import { AiDriver } from '../src/ai.js';

for (const def of TRACKS) {
  const track = buildTrackGeometry(def, 7);
  const S = track.sampleCount;
  const t0 = track.tangents[0];
  const car = makeCarState(track.points[0].x, track.points[0].z, Math.atan2(t0.x, t0.z));
  car.y = track.heights[0];
  const driver = new AiDriver(1);
  const dt = 1 / 60;
  let time = 0, wallHits = 0, maxSpeed = 0, drifting = 0, airTime = 0, maxAlt = 0;
  while (car.progress < 3 * S && time < 2400) {
    const input = driver.control(car, track, dt);
    stepCar(car, input, dt, track);
    time += dt;
    if (car.wallHit > 3) wallHits++;
    if (car.drifting) drifting += dt;
    if (!car.grounded) { airTime += dt; maxAlt = Math.max(maxAlt, car.y - track.groundAt(car.x, car.z, car.trackIdx)); }
    maxSpeed = Math.max(maxSpeed, Math.hypot(car.vx, car.vz));
  }
  const done = car.progress >= 3 * S;
  console.log(
    `${done ? 'PASS' : 'FAIL'} ${def.name.padEnd(15)} 3 laps in ${time.toFixed(1)}s ` +
    `(${(time / 3).toFixed(1)}s/lap) maxSpeed=${maxSpeed.toFixed(1)} wallHits=${wallHits} driftTime=${drifting.toFixed(1)}s airTime=${airTime.toFixed(1)}s maxAirHeight=${maxAlt.toFixed(1)}u`,
  );
}
